// M22 W1 (#20, #21, #24, A P2-8, candidate 4, #48): a task's nextStep (answer / form / approve /
// sign_in / connect / review / reply / retry), its failure and POST /retry, POST /reopen and
// resolvedAt, the 7-day list with older pages and search, resources derived from the task's
// records, the source app of a task started from Up next, and POST /api/up-next.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AddSuggestionResponse, SaveForLaterResponse, TaskDetail, TaskList, UpNext } from "../../src/contract/tasks.ts";
import { LlmError } from "../../src/llm/index.ts";
import { updatePayload } from "../../src/tasks/thread.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, startApp, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

const db = () => t.fixture.db;
const row = (id: string) => db().task.findUniqueOrThrow({ where: { id } });
const detail = async (id: string) => TaskDetail.parse(await (await t.fixture.app.request(`/api/tasks/${id}`, { headers: t.alex.headers })).json());
const newTask = (title: string) => t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title, prompt: title });
const settle = async () => { await t.fixture.runs.idle(); await t.tasks.service.idle(); };
const post = (path: string, body?: unknown) => t.fixture.app.request(path, json(t.alex, "POST", body ?? {}));
const reply = async (id: string, words: string, clientId: string) => readSse(await post(`/api/tasks/${id}/messages`, { text: words, clientId }));
const http502 = () => new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 });

describe("nextStep", () => {
  test("ask_user: Answer with the question and its bubble; it stays while waiting; the user's answer clears it", async () => {
    t.llm.script("task", [call("ask_user", { question: "Which hotel should I book?" })]);
    const task = await newTask("Book Lisbon");
    await settle();
    const bubble = await db().message.findFirstOrThrow({ where: { taskId: task.id, role: "assistant", text: "Which hotel should I book?" } });
    const d = await detail(task.id);
    expect(d.status).toBe("needs_input");
    expect(d.nextStep).toEqual({ kind: "answer", text: { key: "task.next.answer", params: { question: { type: "text", value: "Which hotel should I book?" } } }, messageId: bubble.id });
    // another change of the row (a rename) keeps it
    await t.fixture.app.request(`/api/tasks/${task.id}`, json(t.alex, "PATCH", { title: "Book the Lisbon trip" }));
    expect((await detail(task.id)).nextStep?.kind).toBe("answer");
    // the task event carries it
    const event = await db().event.findFirstOrThrow({ where: { userId: t.alex.userId, type: "task", payload: { contains: task.id } }, orderBy: { id: "desc" } });
    expect(JSON.parse(event.payload).task.nextStep).toMatchObject({ kind: "answer" });
    t.llm.script("task", [text("Booked the Tivoli.")]);
    await reply(task.id, "The Tivoli", "m22-a1");
    await settle();
    expect(await detail(task.id)).toMatchObject({ status: "resolved", nextStep: null });
  });

  test("a turn that ends on a question: Answer with its last sentence", async () => {
    t.llm.script("task", [text("I found two venues. Which one do you prefer, LX Factory or Village Underground?")]);
    const task = await newTask("Venue");
    await settle();
    expect((await detail(task.id)).nextStep).toMatchObject({ kind: "answer", text: { params: { question: { value: "Which one do you prefer, LX Factory or Village Underground?" } } } });
  });

  test("a pending approval: Approve with its summary and card; decided, the task moves on (ready_for_review: Review)", async () => {
    t.llm.script("task", async () => {
      const task = await db().task.findFirstOrThrow({ where: { userId: t.alex.userId, title: "Reply to Priya" } });
      const card = await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: task.id, role: "assistant", kind: "text", text: "(card)", payload: "{}" } });
      await db().approval.create({ data: {
        userId: t.alex.userId, taskId: task.id, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", messageId: card.id,
        preview: JSON.stringify({ kind: "email", app: "Gmail", to: ["priya@example.com"], cc: [], subject: "Send the reply to Priya", body: "Hi", attachments: [] }),
      } });
      return [text("Drafted it; it's waiting for your OK.")];
    });
    const task = await newTask("Reply to Priya");
    await settle();
    const approval = await db().approval.findFirstOrThrow({ where: { taskId: task.id } });
    expect(await detail(task.id)).toMatchObject({
      status: "needs_input",
      nextStep: { kind: "approve", text: { key: "task.next.approve", params: { summary: { type: "text", value: "Send the reply to Priya" } } }, messageId: approval.messageId },
    });
    await db().approval.update({ where: { id: approval.id }, data: { status: "approved" } });
    t.llm.script("task", [text("Sent."), call("finish_task", {})]);
    await t.tasks.service.resumeAfterApproval(task.id, { approvalId: approval.id, status: "approved", ok: true, summary: "Sent" });
    await settle();
    expect(await detail(task.id)).toMatchObject({ status: "ready_for_review", nextStep: { kind: "review", text: { key: "task.next.review" }, messageId: null } });
  });

  test("an open form: Fill in with its title; Skip clears it", async () => {
    t.llm.script("task", [call("ask_form", { title: "Trip dates", fields: [{ type: "text", label: "When?" }] })]);
    const task = await newTask("Trip form");
    await settle();
    const form = await db().message.findFirstOrThrow({ where: { taskId: task.id, kind: "form" } });
    expect((await detail(task.id)).nextStep).toEqual({ kind: "form", text: { key: "task.next.form", params: { title: { type: "text", value: "Trip dates" } } }, messageId: form.id });
    expect((await post(`/api/messages/${form.id}/action`, { action: "dismiss" })).status).toBe(200);
    expect((await detail(task.id)).nextStep).toBeNull();
  });

  test("a pending sign-in card: Sign in to the site; once it settles outside a turn, nextStep follows; a connection request: Connect", async () => {
    const task = await db().task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "United", prompt: "p", status: "needs_input" } });
    const payload = { requestId: "req_1", domain: "united.com", state: "pending", step: "credentials", reason: null, outcome: null };
    const card = await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: task.id, role: "assistant", kind: "sign_in", text: "", payload: JSON.stringify(payload) } });
    await t.tasks.service.refresh(task.id);
    expect((await detail(task.id)).nextStep).toEqual({ kind: "sign_in", text: { key: "task.next.sign_in", params: { site: { type: "text", value: "united.com" } } }, messageId: card.id });
    await updatePayload(db(), t.fixture.events, t.alex.userId, card.id, "sign_in", { ...payload, state: "expired" });
    await settle();
    expect((await detail(task.id)).nextStep).toBeNull();

    const ask = await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: task.id, role: "assistant", kind: "connection_request", text: "", payload: JSON.stringify({ type: "app", name: "Notion", state: "open" }) } });
    await t.tasks.service.refresh(task.id);
    expect((await detail(task.id)).nextStep).toEqual({ kind: "connect", text: { key: "task.next.connect", params: { app: { type: "text", value: "Notion" } } }, messageId: ask.id });
  });
});

describe("failure and Try again", () => {
  test("a failed turn: failure (retryable) and nextStep retry; POST /retry resubmits through its card, clears it, and the run ends well", async () => {
    t.llm.script("task", http502());
    const task = await newTask("Flaky deck");
    await settle();
    const failed = await detail(task.id);
    expect(failed).toMatchObject({ status: "needs_input", nextStep: { kind: "retry", text: { key: "task.next.retry" }, messageId: null } });
    expect(failed.failure).toMatchObject({ reason: { key: "system.model_error" }, retryable: true });
    expect(failed.latestUpdate?.text.key).toBe("system.model_error");
    const card = await db().message.findFirstOrThrow({ where: { taskId: task.id, kind: "model_error" } });

    const gate = deferred();
    t.llm.script("task", async () => { await gate.promise; return [text("Here's the deck summary.")]; });
    const retried = await post(`/api/tasks/${task.id}/retry`);
    expect(retried.status).toBe(200);
    expect(TaskDetail.parse(await retried.json())).toMatchObject({ status: "working", failure: null, nextStep: null });
    expect(JSON.parse((await db().message.findUniqueOrThrow({ where: { id: card.id } })).payload).state).toBe("retrying");
    // while that turn runs: 409 task_running
    const again = await post(`/api/tasks/${task.id}/retry`);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("task_running");
    gate.resolve();
    await settle();
    expect(await detail(task.id)).toMatchObject({ status: "resolved", failure: null, nextStep: null });
    // nothing failed: 409 not_retryable
    const none = await post(`/api/tasks/${task.id}/retry`);
    expect(none.status).toBe(409);
    expect((await errorOf(none)).code).toBe("not_retryable");
  });

  test("a failure running it again can't fix (a refused key): retryable false, 409 not_retryable; a new message clears it", async () => {
    t.llm.script("task", new LlmError({ kind: "http", status: 401, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 1 }));
    const task = await newTask("Auth fails");
    await settle();
    expect((await detail(task.id)).failure).toMatchObject({ reason: { key: "system.model_auth" }, retryable: false });
    const response = await post(`/api/tasks/${task.id}/retry`);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("not_retryable");
    t.llm.script("task", [text("Should I use the other account?")]);
    await reply(task.id, "Try with the other key", "m22-f2");
    await settle();
    expect(await detail(task.id)).toMatchObject({ failure: null, nextStep: { kind: "answer" } });
  });
});

describe("reopen and resolvedAt", () => {
  test("resolvedAt is set on resolve and cleared when it leaves; Reopen waits for the user (reply) and runs nothing; 409 not_resolved otherwise", async () => {
    t.llm.script("task", [text("Should I add the receipts too?")]);
    const task = await newTask("Expense report");
    await settle();
    expect((await post(`/api/tasks/${task.id}/reopen`)).status).toBe(409);
    const done = TaskDetail.parse(await (await t.fixture.app.request(`/api/tasks/${task.id}`, json(t.alex, "PATCH", { status: "resolved" }))).json());
    expect(done.status).toBe("resolved");
    expect(done.resolvedAt).not.toBeNull();
    expect(done.nextStep).toBeNull();
    const turns = await db().run.count({ where: { taskId: task.id } });
    const reopened = await post(`/api/tasks/${task.id}/reopen`);
    expect(reopened.status).toBe(200);
    expect(TaskDetail.parse(await reopened.json())).toMatchObject({
      status: "needs_input", resolvedAt: null, nextStep: { kind: "reply", text: { key: "task.next.reply" }, messageId: null },
      latestUpdate: { text: { key: "task.reopened" } },
    });
    await settle();
    expect(await db().run.count({ where: { taskId: task.id } })).toBe(turns);
    const twice = await post(`/api/tasks/${task.id}/reopen`);
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).code).toBe("not_resolved");
    // the user writes: it runs, and settles done again with a fresh resolvedAt
    t.llm.script("task", [text("Added them.")]);
    await reply(task.id, "Yes, add the receipts", "m22-r1");
    await settle();
    expect((await row(task.id)).status).toBe("resolved");
    expect((await row(task.id)).resolvedAt).not.toBeNull();
  });
});

describe("GET /api/tasks (7-day window, older pages, search)", () => {
  test("unfinished + resolved within 7 days, olderResolved; older pages by cursor; q searches any age; bad params are 400", async () => {
    const channel = await db().channel.create({ data: { userId: t.alex.userId, name: "List", purpose: "" } });
    const now = t.tasks.service.now().getTime();
    const day = 86_400_000;
    const make = (title: string, status: string, resolvedDaysAgo: number | null, extra: Record<string, unknown> = {}) => db().task.create({ data: {
      userId: t.alex.userId, channelId: channel.id, title, prompt: `${title} prompt`, status,
      resolvedAt: resolvedDaysAgo === null ? null : new Date(now - resolvedDaysAgo * day), ...extra,
    } });
    const open = await make("Open passport form", "needs_input", null);
    const fresh = await make("Fresh done", "resolved", 2);
    const old1 = await make("Old passport renewal", "resolved", 8);
    const old2 = await make("Old two", "resolved", 9);
    const old3 = await make("Old three", "resolved", 30);
    await make("Archived passport", "resolved", 40, { archivedAt: new Date() });
    const list = (query: string) => t.fixture.app.request(`/api/tasks?channelId=${channel.id}${query}`, { headers: t.alex.headers });

    const main = TaskList.parse(await (await list("")).json());
    expect(main.tasks.map((x) => x.id).sort()).toEqual([open.id, fresh.id].sort());
    expect(main).toMatchObject({ olderResolved: 3, nextCursor: null });

    const first = TaskList.parse(await (await list("&resolved=older&limit=2")).json());
    expect(first.tasks.map((x) => x.id)).toEqual([old1.id, old2.id]);
    expect(first.olderResolved).toBe(0);
    expect(first.nextCursor).toBe(`${new Date(now - 9 * day).toISOString()}|${old2.id}`);
    const second = TaskList.parse(await (await list(`&resolved=older&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.tasks.map((x) => x.id)).toEqual([old3.id]);

    expect(TaskList.parse(await (await list("&q=%20")).json())).toMatchObject({ olderResolved: 3 });
    const found = TaskList.parse(await (await list("&q=PASSPORT")).json());
    expect(found.tasks.map((x) => x.id).sort()).toEqual([open.id, old1.id].sort());
    const byPrompt = TaskList.parse(await (await list("&q=two%20prompt")).json());
    expect(byPrompt.tasks.map((x) => x.id)).toEqual([old2.id]);

    for (const bad of ["&resolved=newer", "&resolved=older&limit=0", "&resolved=older&limit=101", "&resolved=older&cursor=nope", "&cursor=2026-01-01T00:00:00.000Z|x", "&q=a&resolved=older"]) {
      const response = await list(bad);
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
  });
});

describe("resources from the task's records", () => {
  test("a file Claude sent and the link a write tool returned become resources once (deduped by link, a read tool's link isn't)", async () => {
    t.llm.script("task", async () => {
      const task = await db().task.findFirstOrThrow({ where: { userId: t.alex.userId, title: "Plan the offsite" } });
      const run = await db().run.findFirstOrThrow({ where: { taskId: task.id, status: "running" } });
      const file = await db().channelFile.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, name: "agenda.pdf", mime: "application/pdf", size: 10, path: "x/agenda.pdf", source: "assistant" } });
      const shaped = { id: file.id, channelId: t.alex.mainChannelId, messageId: null, name: "agenda.pdf", mime: "application/pdf", size: 10, source: "assistant", url: `/api/files/${file.id}/content`, createdAt: file.createdAt.toISOString() };
      await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: task.id, role: "assistant", kind: "file", text: "", payload: JSON.stringify({ file: shaped, caption: "" }) } });
      const step = (index: number, tool: string, output: unknown) => db().runStep.create({ data: { id: crypto.randomUUID(), runId: run.id, index, kind: "tool", tool, app: "Google Calendar", title: "{}", status: "ok", output: JSON.stringify(output), finishedAt: new Date() } });
      await step(80, "GOOGLECALENDAR_CREATE_EVENT", { data: { summary: "Offsite", htmlLink: "https://calendar.google.com/event?eid=abc" } });
      await step(81, "GOOGLECALENDAR_FIND_EVENT", { data: { summary: "Other", htmlLink: "https://calendar.google.com/event?eid=read" } });
      await step(82, "GOOGLEDOCS_CREATE_DOCUMENT", { data: { title: "Agenda doc", url: "https://docs.google.com/document/d/1" } });
      return [call("add_resource", { title: "Offsite event", type: "event", link: "https://calendar.google.com/event?eid=abc" })];
    }, [text("Planned.")]);
    const task = await newTask("Plan the offsite");
    await settle();
    const resources = (await detail(task.id)).resources;
    expect(resources.map((r) => [r.title, r.type, r.link])).toEqual([
      ["Offsite event", "event", "https://calendar.google.com/event?eid=abc"],
      ["agenda.pdf", "file", expect.stringMatching(/^duet:\/\/files\//)],
      ["Agenda doc", "doc", "https://docs.google.com/document/d/1"],
    ]);
    // another turn adds nothing twice
    t.llm.script("task", [text("All set.")]);
    await reply(task.id, "Thanks", "m22-res");
    await settle();
    expect((await detail(task.id)).resources).toHaveLength(3);
  });
});

describe("source app and Save for Up next", () => {
  test("Add on an Up next item from Gmail: the task's app is Gmail; a saved request: You asked (source user, no app)", async () => {
    const gmail = await db().suggestion.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Reply to Dana", body: "She asked twice", prompt: "Reply to Dana", app: "Gmail", origin: "scan" } });
    t.llm.script("task", [text("Replied.")], [text("Found three.")]);
    const added = AddSuggestionResponse.parse(await (await post(`/api/up-next/${gmail.id}/add`)).json());
    expect(added.task).toMatchObject({ source: "proactive", app: "Gmail" });

    const saved = await post("/api/up-next", { prompt: "Find a dentist near the office\nwho takes my insurance", channelId: t.alex.mainChannelId });
    expect(saved.status).toBe(201);
    const { suggestion } = SaveForLaterResponse.parse(await saved.json());
    expect(suggestion).toMatchObject({ title: "Find a dentist near the office", body: "Find a dentist near the office\nwho takes my insurance", app: null, origin: "chat", fromUser: true });
    const upNext = UpNext.parse(await (await t.fixture.app.request("/api/up-next", { headers: t.alex.headers })).json());
    expect(upNext.suggestions.find((s) => s.id === suggestion.id)).toMatchObject({ fromUser: true });
    const started = AddSuggestionResponse.parse(await (await post(`/api/up-next/${suggestion.id}/add`)).json());
    expect(started.task).toMatchObject({ source: "user", app: null, title: "Find a dentist near the office" });
    await settle();

    expect((await post("/api/up-next", { prompt: "   ", channelId: t.alex.mainChannelId })).status).toBe(400);
    const sam = await signUp(t.fixture, "sam_m22");
    expect((await post("/api/up-next", { prompt: "x", channelId: sam.mainChannelId })).status).toBe(404);
  });
});
