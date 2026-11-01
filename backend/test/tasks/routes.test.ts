// Task routes (L116-L121): list scope (a channel / Everything, never archived, newest first), the +
// FAB, Mark complete / Archive (only the user resolves), the task's own paged session and its SSE
// replies (idempotent per clientId), usage limits, and 404 for someone else's task.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessagePage } from "../../src/contract/messages.ts";
import { TaskDetail, TaskList } from "../../src/contract/tasks.ts";
import { titleFromPrompt } from "../../src/tasks/serialize.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, messagesOf, ofType, startApp, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const req = (user: SignedIn, path: string, method = "GET", body?: unknown) =>
  t.fixture.app.request(path, method === "GET" ? { headers: user.headers } : json(user, method, body));
const create = async (prompt: string, channelId = t.alex.mainChannelId): Promise<TaskDetail> => {
  const response = await req(t.alex, "/api/tasks", "POST", { prompt, channelId });
  expect(response.status).toBe(200);
  const task = TaskDetail.parse(await response.json());
  await t.fixture.runs.idle();
  return task;
};
const list = async (user: SignedIn, query = "") => TaskList.parse(await (await req(user, `/api/tasks${query}`)).json()).tasks;

describe("tasks routes", () => {
  test("the + FAB starts a task: title from the prompt's first line, no chip, the prompt is the first turn's request", async () => {
    t.llm.script("task", [call("update_task", { title: "Quarterly report draft" })], [text("Drafting now.")]);
    const prompt = "Draft the quarterly report\nUse last quarter's numbers";
    const response = await req(t.alex, "/api/tasks", "POST", { prompt, channelId: t.alex.mainChannelId });
    expect(response.status).toBe(200);
    const created = TaskDetail.parse(await response.json());
    expect(created).toMatchObject({ title: "Draft the quarterly report", status: "working", source: "user", prompt, channelId: t.alex.mainChannelId, steps: [], updates: [], resources: [], noticedAt: null, archived: false });
    await t.fixture.runs.idle();
    // M18: the turn ended with nothing open and no question, so the task is done (resolved).
    expect(await t.fixture.db.task.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ title: "Quarterly report draft", status: "resolved", spawnMessageId: null });
    expect(await t.fixture.db.message.count({ where: { channelId: t.alex.mainChannelId, kind: "task_spawn" } })).toBe(0);
    expect(t.llm.sent("task")[0]!.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: prompt }] });
    expect(titleFromPrompt(`\n\n  ${"x".repeat(100)}`)).toBe(`${"x".repeat(79)}…`);
    const bad = await req(t.alex, "/api/tasks", "POST", { prompt: "   ", channelId: t.alex.mainChannelId });
    expect(bad.status).toBe(400);
  });

  test("lists a channel or Everything, newest first, never archived; someone else's channel is 404", async () => {
    const side = (await t.fixture.db.channel.create({ data: { userId: t.alex.userId, name: "Launch", purpose: "Q4 launch" } })).id;
    const a = await create("Book the venue");
    const b = await create("Write the launch post", side);
    const c = await create("Old idea");
    expect((await req(t.alex, `/api/tasks/${c.id}`, "PATCH", { archived: true })).status).toBe(200);

    const everything = await list(t.alex);
    expect(everything.map((x) => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(everything.some((x) => x.id === c.id)).toBe(false);
    const stamps = everything.map((x) => x.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect((await list(t.alex, `?channelId=${side}`)).map((x) => x.id)).toEqual([b.id]);
    expect((await list(t.alex, `?channelId=${t.alex.mainChannelId}`)).every((x) => x.channelId === t.alex.mainChannelId)).toBe(true);
    expect(await list(t.alex, "?channelId=everything")).toHaveLength(everything.length);
    expect((await req(t.alex, `/api/tasks?channelId=${sam.mainChannelId}`)).status).toBe(404);
    expect(await list(sam)).toEqual([]);

    const back = TaskDetail.parse(await (await req(t.alex, `/api/tasks/${c.id}`, "PATCH", { archived: false })).json());
    expect(back.archived).toBe(false);
    expect((await list(t.alex)).some((x) => x.id === c.id)).toBe(true);
  });

  // M10: a rename ({ title }) is allowed for any task (test/tasks/rename.test.ts); the prompt and routine-only keys still aren't.
  test("Mark complete and Archive are the only status changes a client can make", async () => {
    const task = await create("Renew the domain");
    for (const body of [{ status: "ready_for_review" }, { status: "working" }, { prompt: "Changed" }, { paused: true }]) {
      const response = await req(t.alex, `/api/tasks/${task.id}`, "PATCH", body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    const resolved = TaskDetail.parse(await (await req(t.alex, `/api/tasks/${task.id}`, "PATCH", { status: "resolved" })).json());
    expect(resolved.status).toBe("resolved");
    const event = await t.fixture.db.event.findFirstOrThrow({ where: { userId: t.alex.userId, type: "task" }, orderBy: { id: "desc" } });
    expect(JSON.parse(event.payload).task).toMatchObject({ id: task.id, status: "resolved" });
  });

  test("someone else's task is 404 on every route, and nothing changes", async () => {
    // An open task (M18: a turn that just stops would resolve it on its own).
    t.llm.script("task", [call("ask_user", { question: "Which quarter?" })]);
    const task = await create("Private task");
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("needs_input");
    const routes: [string, string, unknown][] = [
      ["GET", `/api/tasks/${task.id}`, undefined],
      ["PATCH", `/api/tasks/${task.id}`, { status: "resolved" }],
      ["GET", `/api/tasks/${task.id}/messages`, undefined],
      ["POST", `/api/tasks/${task.id}/messages`, { text: "hi", clientId: "sam-1" }],
      ["POST", "/api/tasks", { prompt: "Sneaky", channelId: t.alex.mainChannelId }],
    ];
    for (const [method, path, body] of routes) expect((await req(sam, path, method, body)).status).toBe(404);
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).status).not.toBe("resolved");
    expect(await t.fixture.db.message.count({ where: { clientId: "sam-1" } })).toBe(0);
    expect((await t.fixture.app.request(`/api/tasks/${task.id}`)).status).toBe(401);
  });

  test("the task's session pages like a channel and stays out of the channel's timeline", async () => {
    const task = await create("Collect receipts");
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await t.fixture.db.message.create({ data: {
        userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: task.id, role: i % 2 ? "assistant" : "user",
        text: `step ${i}`, payload: JSON.stringify({ skill: null }), createdAt: new Date(base + 1000 * (i + 1)),
      } });
    }
    const page = MessagePage.parse(await (await req(t.alex, `/api/tasks/${task.id}/messages?limit=3`)).json());
    expect(page.messages.map((m) => m.text)).toEqual(["step 2", "step 3", "step 4"]);
    expect(page.hasMore).toBe(true);
    const older = MessagePage.parse(await (await req(t.alex, `/api/tasks/${task.id}/messages?limit=10&before=${page.messages[0]!.id}`)).json());
    expect(older.messages.map((m) => m.text).slice(-2)).toEqual(["step 0", "step 1"]);
    expect(older.hasMore).toBe(false);
    expect([...page.messages, ...older.messages].every((m) => m.taskId === task.id)).toBe(true);
    const timeline = MessagePage.parse(await (await req(t.alex, `/api/channels/${t.alex.mainChannelId}/messages?limit=100`)).json());
    expect(timeline.messages.some((m) => m.taskId !== null)).toBe(false);
    const other = await create("Another one");
    expect((await req(t.alex, `/api/tasks/${other.id}/messages?before=${page.messages[0]!.id}`)).status).toBe(400);
  });

  test("a reply streams until its turn's done; a retry with the same clientId is the same message and run", async () => {
    const task = await create("Plan the dinner");
    t.llm.script("task", [text("Booked for 8.")]);
    const first = await readSse(await req(t.alex, `/api/tasks/${task.id}/messages`, "POST", { text: "Book it for 8", clientId: "d-1" }));
    const echo = messagesOf(first).find((m) => m.role === "user")!;
    expect(echo).toMatchObject({ taskId: task.id, clientId: "d-1", text: "Book it for 8" });
    expect(ofType(first, "done").at(-1)!.payload).toMatchObject({ taskId: task.id, status: "completed" });
    const runs = await t.fixture.db.run.count({ where: { taskId: task.id } });

    const retry = await readSse(await req(t.alex, `/api/tasks/${task.id}/messages`, "POST", { text: "Book it for 8", clientId: "d-1" }), { timeoutMs: 2000 });
    expect(messagesOf(retry).find((m) => m.role === "user")?.id).toBe(echo.id);
    expect(ofType(retry, "done")).toHaveLength(0);
    expect(await t.fixture.db.run.count({ where: { taskId: task.id } })).toBe(runs);
    expect(await t.fixture.db.message.count({ where: { clientId: "d-1" } })).toBe(1);
    expect((await req(t.alex, `/api/tasks/${task.id}/messages`, "POST", { text: "  ", clientId: "d-2" })).status).toBe(400);
  });
});

describe("usage limits", () => {
  test("over the limit a task's turn is skipped: needs_input, an update and the usage line in its thread; a reply is 429", async () => {
    const limited = await startApp({ SESSION_TOKEN_LIMIT: "100", WEEKLY_TOKEN_LIMIT: "0" });
    try {
      const { fixture, llm, alex } = limited;
      llm.script("task", [text("Started."), { type: "usage", inputTokens: 90, outputTokens: 30, estimated: false }]);
      const first = TaskDetail.parse(await (await fixture.app.request("/api/tasks", json(alex, "POST", { prompt: "First", channelId: alex.mainChannelId }))).json());
      await fixture.runs.idle();
      const second = TaskDetail.parse(await (await fixture.app.request("/api/tasks", json(alex, "POST", { prompt: "Second", channelId: alex.mainChannelId }))).json());
      await fixture.runs.idle();

      const paused = TaskDetail.parse(await (await fixture.app.request(`/api/tasks/${second.id}`, { headers: alex.headers })).json());
      expect(paused.status).toBe("needs_input");
      expect(paused.latestUpdate?.text).toMatchObject({ key: "task.paused_usage_limit", params: { at: { type: "datetime" } } });
      expect(await fixture.db.run.findFirstOrThrow({ where: { taskId: second.id } })).toMatchObject({ status: "skipped" });
      expect((await fixture.db.message.findFirstOrThrow({ where: { kind: "usage_limit" } })).taskId).toBe(second.id);
      expect(llm.sent("task")).toHaveLength(1);

      const refused = await fixture.app.request(`/api/tasks/${first.id}/messages`, json(alex, "POST", { text: "More", clientId: "u-1" }));
      expect(refused.status).toBe(429);
      expect((await errorOf(refused)).code).toBe("usage_limited");
    } finally {
      await limited.fixture.cleanup();
    }
  });
});
