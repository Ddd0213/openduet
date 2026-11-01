// M18a in the chat: tell_task / resolve_task / delete_task (chat turns answering the user only), the
// history lines of artifact cards, and the main thread's task list across channels.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { historyText } from "../../src/agent/context.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import { chatInstructions } from "../../src/tasks/context.ts";
import { offeredNames } from "../helpers/offered.ts";
import { readSse } from "../helpers/sse.ts";
import { signUp } from "../helpers/session.ts";
import { call, json, startApp, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

const chat = async (body: string, clientId: string) =>
  readSse(await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: body, clientId })));
/** The tool_result a chat turn got for one call id (parsed JSON). */
function resultOf(id: string): { isError: boolean; data: Record<string, unknown> } {
  for (const request of t.llm.sent("chat") as LlmRequest[]) {
    for (const message of request.messages) {
      for (const block of message.content) {
        if (block.type === "tool_result" && block.toolUseId === id) {
          const raw = block.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
          return { isError: !!block.isError, data: JSON.parse(raw) as Record<string, unknown> };
        }
      }
    }
  }
  throw new Error(`no tool_result for ${id}`);
}
const waitingTask = async (title: string) => {
  t.llm.script("task", [call("ask_user", { question: "Which one?" })]);
  const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title, prompt: title });
  await t.fixture.runs.idle();
  return task;
};

describe("tell_task", () => {
  test("stores the user's words in the task's thread as forwarded \"chat\" and queues a reply turn; chat turns only", async () => {
    const task = await waitingTask("Singles' Day watch");
    const runs = await t.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } });
    t.llm.script("chat", [call("tell_task", { taskId: task.id, text: "Also check Pinduoduo." }, "tell-1")], [text("Passed it on.")]);
    t.llm.script("task", [text("Pinduoduo has the same price.")]);
    await chat("Also check Pinduoduo", "m18c-1");
    await t.fixture.runs.idle();
    expect(resultOf("tell-1")).toMatchObject({ isError: false, data: { taskId: task.id, link: `duet://tasks/${task.id}` } });
    const stored = await t.fixture.db.message.findFirstOrThrow({ where: { taskId: task.id, role: "user", text: "Also check Pinduoduo." } });
    expect(JSON.parse(stored.payload)).toMatchObject({ forwarded: "chat" });
    const page = await (await t.fixture.app.request(`/api/tasks/${task.id}/messages`, { headers: t.alex.headers })).json() as { messages: { id: string; payload: { forwarded?: string | null } }[] };
    expect(page.messages.find((m) => m.id === stored.id)?.payload.forwarded).toBe("chat");
    expect(await t.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } })).toBe(runs + 1);
    expect(JSON.stringify(t.llm.sent("task").at(-1)!.messages.at(-1))).toContain("Also check Pinduoduo.");
    // The forwarded turn ended done: the result is posted in the chat (the user isn't in the task).
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("resolved");
    // Offered in chat turns, not in a task's own turns.
    expect(offeredNames(t.llm.sent("chat").at(-1))).toEqual(expect.arrayContaining(["tell_task", "resolve_task", "delete_task"]));
    expect(offeredNames(t.llm.sent("task").at(-1))).not.toEqual(expect.arrayContaining(["tell_task"]));
  });

  test("a routine is refused; someone else's task is unknown", async () => {
    const routine = await t.fixture.db.task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Daily digest", status: "scheduled", routine: true } });
    const sam = await signUp(t.fixture, "sam_m18", "Sam Lee");
    const theirs = await t.fixture.db.task.create({ data: { userId: sam.userId, channelId: sam.mainChannelId, title: "Sam's", status: "needs_input" } });
    t.llm.script("chat", [
      call("tell_task", { taskId: routine.id, text: "Skip Fridays" }, "tell-r"),
      call("resolve_task", { taskId: routine.id }, "resolve-r"),
      call("tell_task", { taskId: theirs.id, text: "hi" }, "tell-x"),
      call("delete_task", { taskId: theirs.id }, "delete-x"),
    ], [text("Done.")]);
    await chat("Skip Fridays in the digest", "m18c-2");
    expect(resultOf("tell-r")).toEqual({ isError: true, data: { error: "It's a scheduled task; use manage_scheduled_task." } });
    expect(resultOf("resolve-r")).toEqual({ isError: true, data: { error: "It's a scheduled task; pause or delete it instead." } });
    expect(resultOf("tell-x").isError).toBe(true);
    expect(resultOf("delete-x").isError).toBe(true);
    expect(await t.fixture.db.task.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    expect(await t.fixture.db.message.count({ where: { taskId: routine.id } })).toBe(0);
  });
});

describe("only on the user's own words", () => {
  test("a chat turn that isn't answering a message of theirs (turn_...) gets no tell_task, resolve_task or delete_task", async () => {
    const task = await waitingTask("Hand-back test");
    const provider = t.tasks.providers.find((p) => p.name === "tasks")!;
    const at = new Date().toISOString();
    const userMessage = (id: string) => ({ id, channelId: t.alex.mainChannelId, taskId: null, role: "user", kind: "text", text: "", status: "seen", clientId: null, reactions: [], stopped: false, callId: null, createdAt: at, updatedAt: at, payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null } });
    const turn = (id: string) => ({ userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: null, kind: "chat", runId: crypto.randomUUID(), userMessage: userMessage(id) }) as unknown as Parameters<typeof provider.tools>[0];
    const names = async (id: string) => (await provider.tools(turn(id))).map((tool) => tool.name);
    expect(await names("turn_handback")).not.toContain("delete_task");
    expect(await names("turn_handback")).not.toContain("resolve_task");
    expect(await names("turn_handback")).not.toContain("tell_task");
    expect(await names("turn_handback")).toContain("start_task");
    expect(await names("msg_real")).toEqual(expect.arrayContaining(["tell_task", "resolve_task", "delete_task"]));
    const refused = await provider.execute!({ type: "tool_use", id: "c1", name: "delete_task", input: { taskId: task.id } }, turn("turn_handback"));
    expect(refused.result.isError).toBe(true);
    expect(await t.fixture.db.task.findUnique({ where: { id: task.id } })).not.toBeNull();
  });
});

describe("resolve_task and delete_task", () => {
  test("resolve_task marks it complete; delete_task deletes it and says it can't be undone", async () => {
    const open = await waitingTask("Book the venue");
    const doomed = await waitingTask("Old idea");
    t.llm.script("chat", [call("resolve_task", { taskId: open.id }, "res-1"), call("delete_task", { taskId: doomed.id }, "del-1")], [text("Done and deleted.")]);
    await chat("Mark the venue one done and delete the old idea", "m18c-3");
    expect(resultOf("res-1")).toMatchObject({ isError: false, data: { taskId: open.id, status: "resolved" } });
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("resolved");
    const deleted = resultOf("del-1");
    expect(deleted).toMatchObject({ isError: false, data: { taskId: doomed.id, deleted: true } });
    expect(String(deleted.data.note)).toContain("can't be undone");
    expect(await t.fixture.db.task.findUnique({ where: { id: doomed.id } })).toBeNull();
  });
});

describe("history lines", () => {
  test("an artifact card reads as its title and status (failed with its reason)", () => {
    const artifact = (status: string, extra: Record<string, unknown> = {}) => ({ artifact: { id: "a1", title: "Q3 budget", status }, metrics: [], ...extra });
    expect(historyText("artifact", "", artifact("ready"))).toBe('[artifact "Q3 budget" ready id="a1"]');
    expect(historyText("artifact", "Claude made a page.", artifact("building"))).toBe('Claude made a page.\n[artifact "Q3 budget" building id="a1"]');
    expect(historyText("artifact", "", artifact("failed", { reason: { key: "system.model_unreachable", params: { reason: { type: "text", value: "timeout" } } } })))
      .toBe('[artifact "Q3 budget" failed id="a1" (Couldn\'t reach the model (timeout). Check the model settings.)]');
  });
});

describe("the main thread's task list", () => {
  test("every channel's open tasks and those finished in the last 3 days, newest first, at most 15; a sub-channel keeps its own 10", async () => {
    const lee = await signUp(t.fixture, "lee_m18", "Lee Park");
    const side = await t.fixture.db.channel.create({ data: { userId: lee.userId, name: "Trips", purpose: "Travel" } });
    const now = new Date("2026-11-03T12:00:00.000Z");
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const update = JSON.stringify([{ text: { text: `Found ${"a cheaper flight ".repeat(20)}` }, source: "Claude", at: ago(2).toISOString() }]);
    const make = (title: string, status: string, hours: number, data: Record<string, unknown> = {}) =>
      t.fixture.db.task.create({ data: { userId: lee.userId, channelId: lee.mainChannelId, title, status, updatedAt: ago(hours), ...data } });
    const flight = await make("Flights to Lisbon", "needs_input", 1, { channelId: side.id, updates: update });
    const report = await make("Q3 report", "resolved", 30);
    await make("Old report", "resolved", 24 * 4);
    await make("Digest", "scheduled", 0, { routine: true });
    await make("Hidden", "working", 0, { archivedAt: ago(1) });
    const lines = await chatInstructions(t.fixture.db, lee.userId, lee.mainChannelId, now);
    const listLine = lines.find((l) => l.startsWith("Your tasks across all channels"))!;
    const list = JSON.parse(listLine.slice(listLine.indexOf("["), listLine.lastIndexOf("]") + 1)) as Record<string, unknown>[];
    expect(list.map((x) => x.title)).toEqual(["Flights to Lisbon", "Q3 report"]);
    expect(list[0]).toMatchObject({ id: flight.id, status: "needs_input", channel: "Trips", updatedAt: ago(1).toISOString() });
    expect(String(list[0]!.lastUpdate)).toStartWith("Found a cheaper flight");
    expect(String(list[0]!.lastUpdate).length).toBeLessThanOrEqual(160);
    expect(list[1]).toMatchObject({ id: report.id, channel: "main", lastUpdate: null });
    expect(lines.some((l) => l.includes("tell_task"))).toBe(true);

    for (let i = 0; i < 16; i++) await make(`Open ${i}`, "working", 3 + i);
    const capped = await chatInstructions(t.fixture.db, lee.userId, lee.mainChannelId, now);
    const cappedLine = capped.find((l) => l.startsWith("Your tasks across all channels"))!;
    expect((JSON.parse(cappedLine.slice(cappedLine.indexOf("["), cappedLine.lastIndexOf("]") + 1)) as unknown[]).length).toBe(15);

    const sub = await chatInstructions(t.fixture.db, lee.userId, side.id, now);
    const subLine = sub.find((l) => l.startsWith("Recent tasks in this channel"))!;
    expect((JSON.parse(subLine.slice(subLine.indexOf("["), subLine.lastIndexOf("]") + 1)) as { title: string }[]).map((x) => x.title)).toEqual(["Flights to Lisbon"]);
  });
});
