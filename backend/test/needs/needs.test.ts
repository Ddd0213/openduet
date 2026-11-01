// M22 W2 (#22, show_tasks): GET /api/needs-you counts each thing waiting on the user once (a task
// with a nextStep; its own form / approval stays inside it; cards outside any task in the chat and
// channels), newest first; show_tasks posts a card built from the same data (its "Needs you"
// number is the badge's) and gives the model the counts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CardMessage, type Message } from "../../src/contract/messages.ts";
import { NeedsYou } from "../../src/contract/tasks.ts";
import { createNeeds } from "../../src/needs/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, messagesOf, rig, RoleScriptedLlm, text } from "../tasks/harness.ts";

let fixture: TestApp;
let llm: RoleScriptedLlm;
let tasks: ReturnType<typeof rig>["tasks"];
let alex: SignedIn;
let sam: SignedIn;
let channelId: string;

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const answer = (question: string, messageId: string | null = null) =>
  JSON.stringify({ kind: "answer", text: { key: "task.next.answer", params: { question: { type: "text", value: question } } }, messageId });

beforeAll(async () => {
  llm = new RoleScriptedLlm();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const built = rig(core, llm);
      const needs = createNeeds({ db: core.db });
      built.providers.push(...needs.providers);
      tasks = built.tasks;
      return { agent: built.agent, runs: built.runs, routes: [...built.tasks.routes, ...needs.routes] };
    },
  });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
  channelId = (await fixture.db.channel.create({ data: { userId: alex.userId, isMain: false, name: "Trips" } })).id;
});
afterAll(() => fixture.cleanup());

const db = () => fixture.db;
const get = async (user: SignedIn = alex) => {
  const response = await fixture.app.request("/api/needs-you", { headers: user.headers });
  expect(response.status).toBe(200);
  return NeedsYou.parse(await response.json());
};
const task = (data: Record<string, unknown>) =>
  db().task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Task", status: "working", ...data } as never });
const card = (data: Record<string, unknown>) =>
  db().message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "assistant", ...data } as never });
const email = (to: string, subject: string) => JSON.stringify({ kind: "email", app: "Gmail", to: [to], cc: [], subject, body: "Hi", attachments: [] });

/** Seeds what Alex has waiting (and what must not count). Returns the ids the tests check. */
async function seed() {
  // A task asking a question (nextStep answer).
  const asking = await task({ title: "Book the Lisbon trip", status: "needs_input", nextStep: answer("Which hotel should I book?"), updatedAt: ago(10) });
  // A task with an open form in its own thread: TaskService derives nextStep form; the form card itself must not count again.
  const formTask = await task({ title: "Plan the offsite", status: "working", updatedAt: ago(30) });
  const taskForm = await card({ taskId: formTask.id, kind: "form", payload: JSON.stringify({ title: "Offsite dates", description: null, icon: "question", fields: [{ id: "f1", type: "text", label: "When?", required: false, placeholder: null, multiline: false }], submitLabel: null, state: "open", answers: null }), createdAt: ago(29) });
  await tasks.service.refresh(formTask.id);
  // An approval inside that task: counted once, as the task.
  const taskApprovalCard = await card({ taskId: formTask.id, kind: "approval", payload: "{}", createdAt: ago(28) });
  await db().approval.create({ data: { userId: alex.userId, taskId: formTask.id, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", preview: email("dana@example.com", "Offsite"), messageId: taskApprovalCard.id } });
  // A chat approval outside any task (pending): counts.
  const chatApprovalCard = await card({ kind: "approval", payload: "{}", createdAt: ago(5) });
  await db().approval.create({ data: { userId: alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", preview: email("priya@example.com", "Send the reply to Priya"), messageId: chatApprovalCard.id } });
  // Decided / expired chat approvals: don't count.
  const declined = await card({ kind: "approval", payload: "{}", createdAt: ago(4) });
  await db().approval.create({ data: { userId: alex.userId, kind: "action", toolSlug: "X", status: "declined", messageId: declined.id } });
  const expired = await card({ kind: "approval", payload: "{}", createdAt: ago(3) });
  await db().approval.create({ data: { userId: alex.userId, kind: "payment", toolSlug: "PAY", messageId: expired.id, expiresAt: ago(1) } });
  // A pending sign-in in a channel, an open connection request in the main thread: count.
  const signIn = await card({ channelId, kind: "sign_in", payload: JSON.stringify({ requestId: "r1", domain: "united.com", state: "pending", step: "credentials", reason: null, outcome: null }), createdAt: ago(20) });
  const connect = await card({ kind: "connection_request", payload: JSON.stringify({ type: "app", name: "Notion", purpose: "To read your notes", url: null, domain: null, toolkit: "notion", headerName: null, valuePrefix: null, fields: [], state: "open", connectorId: null }), createdAt: ago(40) });
  // Closed cards outside a task, an archived task with a nextStep, a voice call's form: don't count.
  await card({ kind: "form", payload: JSON.stringify({ title: "Old", state: "submitted" }), createdAt: ago(2) });
  await card({ kind: "sign_in", payload: JSON.stringify({ domain: "x.com", state: "expired" }), createdAt: ago(2) });
  await card({ kind: "form", callId: "call_1", payload: JSON.stringify({ title: "On the call", state: "open" }), createdAt: ago(2) });
  await task({ title: "Archived one", status: "needs_input", nextStep: answer("Still?"), archivedAt: ago(60) });
  // Working, Done (recent / old), and Up next items for the board.
  const working = await task({ title: "Summarise the board deck", status: "working", updatedAt: ago(15) });
  const done = await task({ title: "Weekly sleep plan", status: "resolved", resolvedAt: ago(60 * 24) });
  await task({ title: "Done long ago", status: "resolved", resolvedAt: ago(60 * 24 * 10) });
  const suggestion = await db().suggestion.create({ data: { userId: alex.userId, title: "Draft the offsite agenda", app: "Google Calendar", origin: "scan" } });
  await db().suggestion.create({ data: { userId: alex.userId, title: "Hidden one", status: "hidden" } });
  return { asking, formTask, taskForm, chatApprovalCard, signIn, connect, working, done, suggestion };
}

let seeded: Awaited<ReturnType<typeof seed>>;

describe("GET /api/needs-you", () => {
  test("a task with nextStep, a form and an approval inside a task (once, as the task), a chat approval, a sign-in and a connection request", async () => {
    seeded = await seed();
    const needs = await get();
    expect(needs.count).toBe(needs.items.length);
    // Newest first: approval (5 min), asking task (10), sign-in (20), the form's task (its own updatedAt), connection (40).
    const keys = needs.items.map((item) => (item.kind === "task" ? `task:${item.task.id}` : `${item.kind}:${item.messageId}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`task:${seeded.asking.id}`);
    expect(keys).toContain(`task:${seeded.formTask.id}`);
    expect(keys).toContain(`approval:${seeded.chatApprovalCard.id}`);
    expect(keys).toContain(`sign_in:${seeded.signIn.id}`);
    expect(keys).toContain(`connection:${seeded.connect.id}`);
    expect(needs.count).toBe(5);
    // The form and approval of the task's own thread aren't items of their own.
    expect(keys.some((k) => k.endsWith(seeded.taskForm.id))).toBe(false);
    const formTask = needs.items.find((i) => i.kind === "task" && i.task.id === seeded.formTask.id);
    expect(formTask?.kind === "task" && formTask.task.nextStep?.kind).toBe("form");

    const approval = needs.items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({
      channelId: alex.mainChannelId, title: "Send the reply to Priya",
      detail: { key: "task.next.approve", params: { summary: { type: "text", value: "Send the reply to Priya" } } },
      route: `duet://channels/${alex.mainChannelId}?message=${seeded.chatApprovalCard.id}`,
    });
    expect(needs.items.find((i) => i.kind === "sign_in")).toMatchObject({ channelId, title: "united.com", detail: { key: "task.next.sign_in" } });
    expect(needs.items.find((i) => i.kind === "connection")).toMatchObject({ title: "Notion", detail: { key: "task.next.connect" } });
    const ats = needs.items.map((i) => Date.parse(i.kind === "task" ? i.task.updatedAt : i.at));
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
  });

  test("someone else's things never show; an empty list is count 0", async () => {
    expect(await get(sam)).toEqual({ count: 0, items: [] });
    const anonymous = await fixture.app.request("/api/needs-you");
    expect(anonymous.status).toBe(401);
  });

  test("answering the chat approval takes it off", async () => {
    await db().approval.updateMany({ where: { messageId: seeded.chatApprovalCard.id }, data: { status: "approved" } });
    const needs = await get();
    expect(needs.count).toBe(4);
    expect(needs.items.some((i) => i.kind === "approval")).toBe(false);
  });
});

type Card = Extract<Message, { kind: "card" }>;
type Group = Extract<Card["payload"]["blocks"][number], { type: "group" }>;
let turn = 0;

/** One chat turn whose model calls show_tasks (with `input`) and then says one line; returns the posted card. */
async function showTasks(input: Record<string, unknown> = {}, opts: { channel?: string; locale?: string } = {}) {
  llm.script("chat", [call("show_tasks", input)], [text("Two things need you first.")]);
  const path = `/api/channels/${opts.channel ?? alex.mainChannelId}/messages`;
  const init = json(alex, "POST", { text: "How are my tasks going?", clientId: `show-${++turn}` });
  if (opts.locale) init.headers = { ...(init.headers as Record<string, string>), "X-Locale": opts.locale };
  const frames = await readSse(await fixture.app.request(path, init));
  const card = messagesOf(frames).findLast((m): m is Card => m.kind === "card");
  if (!card) throw new Error("no card posted");
  const sent = llm.sent("chat").at(-1)!;
  const result = sent.messages.flatMap((m) => m.content).findLast((b) => b.type === "tool_result");
  const resultText = result?.type === "tool_result" && result.content[0]?.type === "text" ? result.content[0].text : "{}";
  return { card, result: JSON.parse(resultText) as Record<string, unknown>, isError: result?.type === "tool_result" && !!result.isError };
}
const groups = (card: Card) => card.payload.blocks.filter((b): b is Group => b.type === "group");

describe("show_tasks", () => {
  test("is offered in chat; the card's groups come from real data and Needs you equals GET /api/needs-you", async () => {
    const { card, result, isError } = await showTasks();
    expect(isError).toBe(false);
    // Offered in this chat turn's tool list.
    expect(llm.sent("chat").at(-2)!.tools?.some((t) => t.name === "show_tasks")).toBe(true);
    expect(CardMessage.safeParse(card).success).toBe(true);
    expect(card.payload).toMatchObject({ title: "Your tasks", icon: "checklist", tint: "grey", actions: [] });

    const needs = await get();
    const [needsYou, working, suggested, done] = groups(card);
    expect(groups(card).map((g) => g.title)).toEqual(["Needs you", "Working", "Suggested", "Done (last 7 days)"]);
    expect(needsYou!.count).toBe(needs.count);
    expect(needsYou!.rows.map((r) => r.route)).toEqual(needs.items.slice(0, 5).map((i) => (i.kind === "task" ? `duet://tasks/${i.task.id}` : i.route)));
    expect(needsYou!.rows.find((r) => r.route === `duet://tasks/${seeded.asking.id}`)).toEqual({ title: "Book the Lisbon trip", detail: "Answer: Which hotel should I book?", route: `duet://tasks/${seeded.asking.id}` });
    expect(needsYou!.rows.find((r) => r.title === "united.com")?.detail).toBe("Sign in to united.com");
    expect(needsYou!.empty).toBeNull();

    // Working: the working task without a card of its own (the form's task is under Needs you).
    expect(working).toMatchObject({ count: 1, empty: null, rows: [{ title: "Summarise the board deck", route: `duet://tasks/${seeded.working.id}` }] });
    expect(suggested).toMatchObject({ count: 1, rows: [{ title: "Draft the offsite agenda", detail: "From Google Calendar", route: `duet://suggestions/${seeded.suggestion.id}` }] });
    // Done: resolved in the last 7 days only.
    expect(done).toMatchObject({ count: 1, rows: [{ title: "Weekly sleep plan", detail: null, route: `duet://tasks/${seeded.done.id}` }] });

    // The model gets the counts (the card's numbers) and a note not to write its own.
    expect(result).toMatchObject({ shown: true, messageId: card.id, scope: "all", counts: { needsYou: needs.count, working: 1, suggested: 1, done: 1 } });
    expect(String(result.note)).toContain("don't repeat");
  });

  test("at most 5 rows per group with the real count; empty groups get one line; text in the user's language", async () => {
    for (let i = 0; i < 6; i++) await task({ channelId, title: `Trip step ${i + 1}`, status: "needs_input", nextStep: answer(`Question ${i + 1}?`) });
    await db().task.update({ where: { id: seeded.working.id }, data: { status: "ready_for_review" } });
    await db().suggestion.updateMany({ where: { userId: alex.userId }, data: { status: "added" } });
    const { card, result } = await showTasks({}, { locale: "zh-Hans" });
    const needs = await get();
    const [needsYou, working, suggested] = groups(card);
    expect(card.payload.title).toBe("你的任务");
    expect(groups(card).map((g) => g.title)).toEqual(["需要你", "进行中", "建议", "已完成（近 7 天）"]);
    expect(needsYou!.count).toBe(needs.count);
    expect(needs.count).toBeGreaterThan(5);
    expect(needsYou!.rows).toHaveLength(5);
    expect(needsYou!.rows.find((r) => r.title.startsWith("Trip step"))?.detail).toMatch(/^回答：Question \d\?$/);
    expect(working).toEqual({ type: "group", title: "进行中", count: 0, empty: "现在没有进行中的任务。", rows: [] });
    expect(suggested).toMatchObject({ count: 0, empty: "现在没有建议。", rows: [] });
    expect(result).toMatchObject({ counts: { needsYou: needs.count, working: 0, suggested: 0 } });
  });

  test("scope channel: only this channel's tasks and cards", async () => {
    const { card, result } = await showTasks({ scope: "channel" }, { channel: channelId, locale: "en" });
    const [needsYou] = groups(card);
    // The six trip steps and the sign-in live in this channel.
    expect(needsYou!.count).toBe(7);
    expect(result).toMatchObject({ scope: "channel", counts: { needsYou: 7 } });
    expect(card.channelId).toBe(channelId);
    const all = await get();
    expect(all.count).toBeGreaterThan(7);
  });

  test("a withdrawn form disappears from GET needs-you and show_tasks", async () => {
    const title = "Withdraw from needs list";
    const open = await card({ kind: "form", payload: JSON.stringify({ title, description: null, icon: "question", fields: [{ id: "f1", type: "text", label: "Details", required: false, placeholder: null, multiline: false }], submitLabel: null, state: "open", answers: null }) });
    expect((await get()).items.some((item) => item.kind !== "task" && item.messageId === open.id)).toBe(true);
    llm.script("chat", [call("withdraw_card", { title })], [text("I withdrew it.")]);
    await readSse(await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, json(alex, "POST", { text: "Withdraw that question", clientId: "withdraw-needs" })));
    const needs = await get();
    expect(needs.items.some((item) => item.kind !== "task" && item.messageId === open.id)).toBe(false);
    const shown = await showTasks();
    const rows = groups(shown.card).flatMap((group) => group.rows);
    expect(rows.some((row) => row.title === title)).toBe(false);
  });

  test("a bad argument is a tool error the model can fix; nothing is posted", async () => {
    llm.script("chat", [call("show_tasks", { scope: "everything" })], [text("Let me try that again.")]);
    const before = await db().message.count({ where: { userId: alex.userId, kind: "card" } });
    await readSse(await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, json(alex, "POST", { text: "Tasks?", clientId: "bad-scope" })));
    const result = llm.sent("chat").at(-1)!.messages.flatMap((m) => m.content).findLast((b) => b.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect(await db().message.count({ where: { userId: alex.userId, kind: "card" } })).toBe(before);
  });
});
