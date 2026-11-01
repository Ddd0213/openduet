// M10 Stop (contract §1): POST /api/channels/:id/stop stops the current turn of the channel's own
// chat (kind chat, taskId null) and POST /api/tasks/:id/stop the current turn of a task's session.
// Text streamed before the stop stays as one text message with stopped: true; nothing streamed =
// nothing posted; typing goes off; the run ends cancelled with `done`; turns queued behind it still
// run; 409 conflict when nothing runs there, 404 for someone else's channel or task. Real agent
// runtime + run host on a scripted model that can hold a model call mid-stream.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Message, MessagePage, StopResponse } from "../../src/contract/messages.ts";
import type { LlmEvent, LlmRequest, ModelRole } from "../../src/llm/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { deferred, json, lastEventId, messagesOf, ofType, rig, RoleScriptedLlm, storedEvents, text } from "../tasks/harness.ts";

/**
 * The next call of a role streams `pieces`, calls `reached` once they were consumed, then waits
 * until its turn is aborted (Stop) or `release` (then it finishes normally). Other calls use the script.
 */
class HoldingLlm extends RoleScriptedLlm {
  private readonly holds = new Map<ModelRole, { pieces: string[]; reached: () => void; release: Promise<void> }>();

  hold(role: ModelRole, pieces: string[] = []) {
    const reached = deferred();
    const release = deferred();
    this.holds.set(role, { pieces, reached: () => reached.resolve(), release: release.promise });
    return { reached: reached.promise, release: () => release.resolve() };
  }

  override async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const hold = this.holds.get(request.role);
    if (!hold) {
      yield* super.stream(request);
      return;
    }
    this.holds.delete(request.role);
    this.requests.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
    for (const piece of hold.pieces) yield { type: "text_delta", text: piece };
    hold.reached();
    const released = await new Promise<boolean>((resolve) => {
      if (request.signal?.aborted) return resolve(false);
      request.signal?.addEventListener("abort", () => resolve(false), { once: true });
      void hold.release.then(() => resolve(true));
    });
    if (!released) throw new Error("aborted");
    const content = hold.pieces.length ? [{ type: "text" as const, text: hold.pieces.join("") }] : [];
    yield { type: "done", stopReason: "end_turn", message: { role: "assistant", content }, model: { providerId: "scripted-test-only", modelId: "scripted-test-only" } };
  }
}

let fixture: TestApp;
let llm: HoldingLlm;
let built: ReturnType<typeof rig>;
let alex: SignedIn;
let sam: SignedIn;
beforeAll(async () => {
  llm = new HoldingLlm();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      built = rig(core, llm);
      return { agent: built.agent, runs: built.runs, routes: built.tasks.routes };
    },
  });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const db = () => fixture.db;
const req = (path: string, method = "GET", body?: unknown, user: SignedIn = alex) =>
  fixture.app.request(path, method === "GET" ? { headers: user.headers } : json(user, method, body));
const newChannel = async (name: string) => (await db().channel.create({ data: { userId: alex.userId, name, purpose: "" } })).id;
const send = (channelId: string, body: string, clientId: string) => req(`/api/channels/${channelId}/messages`, "POST", { text: body, clientId });
const stopChannel = (channelId: string, user: SignedIn = alex) => req(`/api/channels/${channelId}/stop`, "POST", undefined, user);
const assistantTexts = (f: SseFrames) => messagesOf(f).filter((m) => m.role === "assistant" && m.kind === "text");
const doneOf = (f: SseFrames, runId: string) => ofType(f, "done").filter((e) => e.payload.runId === runId);
/** A send's stream closes after its own run's `done`, so the last `done` is that run's. */
const ownDone = (f: SseFrames) => ofType(f, "done").at(-1)!;
const typingOf = (f: SseFrames, runId: string) => ofType(f, "typing").filter((e) => e.payload.runId === runId).map((e) => e.payload.typing);

describe("POST /api/channels/:id/stop", () => {
  test("mid-stream: the streamed text stays as one text message with stopped true; typing off; done cancelled", async () => {
    const channelId = await newChannel("Stop mid-stream");
    const held = llm.hold("chat", ["Here's the start ", "of a longer answer"]);
    const stream = await send(channelId, "Write me a long essay", "stop-mid-1");
    expect(stream.status).toBe(200);
    await held.reached;
    // Someone else can't stop it.
    expect((await stopChannel(channelId, sam)).status).toBe(404);
    const response = await stopChannel(channelId);
    expect(response.status).toBe(200);
    expect(StopResponse.parse(await response.json())).toEqual({ stopped: 1 });
    const frames = await readSse(stream);

    const done = ownDone(frames);
    expect(done.payload).toMatchObject({ status: "cancelled", error: null, taskId: null });
    const replies = assistantTexts(frames);
    expect(new Set(replies.map((m) => m.id)).size).toBe(1);
    expect(replies.at(-1)).toMatchObject({ text: "Here's the start of a longer answer", stopped: true, kind: "text" });
    expect(replies.slice(0, -1).every((m) => !m.stopped)).toBe(true);
    expect(typingOf(frames, done.payload.runId).at(-1)).toBe(false);
    expect(messagesOf(frames).some((m) => m.kind === "system")).toBe(false);

    const stored = await db().message.findMany({ where: { channelId, role: "assistant" } });
    expect(stored).toHaveLength(1);
    const page = MessagePage.parse(await (await req(`/api/channels/${channelId}/messages`)).json());
    expect(page.messages.map((m) => [m.role, m.text, m.stopped])).toEqual([
      ["user", "Write me a long essay", false],
      ["assistant", "Here's the start of a longer answer", true],
    ]);
    // The user's message keeps its receipt (seen: the model had started answering).
    expect(page.messages[0]).toMatchObject({ status: "seen" });
    expect(await db().run.findUniqueOrThrow({ where: { id: done.payload.runId } })).toMatchObject({ status: "cancelled", kind: "chat" });
    expect((await stopChannel(channelId)).status).toBe(409);
  });

  test("before any output: nothing is posted, the receipt stays Delivered, the run ends cancelled", async () => {
    const channelId = await newChannel("Stop early");
    const held = llm.hold("chat");
    const stream = await send(channelId, "Think about it first", "stop-early-1");
    await held.reached;
    expect(StopResponse.parse(await (await stopChannel(channelId)).json())).toEqual({ stopped: 1 });
    const frames = await readSse(stream);
    expect(ownDone(frames).payload).toMatchObject({ status: "cancelled", error: null });
    expect(messagesOf(frames).filter((m) => m.role !== "user")).toEqual([]);
    expect(typingOf(frames, ownDone(frames).payload.runId).at(-1)).toBe(false);
    expect(await db().message.count({ where: { channelId, role: { not: "user" } } })).toBe(0);
    expect(await db().message.findFirstOrThrow({ where: { clientId: "stop-early-1" } })).toMatchObject({ status: "sent" });
  });

  test("nothing running or queued is 409 conflict; someone else's or an unknown channel is 404", async () => {
    const channelId = await newChannel("Idle");
    const idle = await stopChannel(channelId);
    expect(idle.status).toBe(409);
    expect((await errorOf(idle)).code).toBe("conflict");
    expect((await stopChannel(sam.mainChannelId)).status).toBe(404);
    expect((await stopChannel(channelId, sam)).status).toBe(404);
    expect((await stopChannel("nope")).status).toBe(404);
    expect((await fixture.app.request(`/api/channels/${channelId}/stop`, { method: "POST" })).status).toBe(401);
  });

  test("a message queued behind the stopped turn still runs and is answered", async () => {
    const channelId = await newChannel("Queue");
    const held = llm.hold("chat", ["Partial"]);
    const first = await send(channelId, "First question", "stop-queue-1");
    await held.reached;
    llm.script("chat", [text("Second answer")]);
    const second = await send(channelId, "Second question", "stop-queue-2");
    expect(second.status).toBe(200);
    expect(StopResponse.parse(await (await stopChannel(channelId)).json())).toEqual({ stopped: 1 });
    const [a, b] = await Promise.all([readSse(first), readSse(second)]);
    const runA = ownDone(a).payload.runId;
    const runB = ownDone(b).payload.runId;
    expect(runA).not.toBe(runB);
    expect(ownDone(a).payload.status).toBe("cancelled");
    expect(ownDone(b).payload).toMatchObject({ status: "completed", error: null });
    // The channel stream of the second send saw the first run end before its own.
    expect(doneOf(b, runA).map((e) => e.payload.status)).toEqual(["cancelled"]);
    await fixture.runs.idle();
    const page = MessagePage.parse(await (await req(`/api/channels/${channelId}/messages`)).json());
    expect(page.messages.map((m) => [m.role, m.text, m.stopped])).toEqual([
      ["user", "First question", false],
      ["assistant", "Partial", true],
      ["user", "Second question", false],
      ["assistant", "Second answer", false],
    ]);
    expect(page.messages[2]).toMatchObject({ status: "seen" });
    expect((await stopChannel(channelId)).status).toBe(409);
  });

  test("stops only the channel's own chat: a queued chat turn behind a brief is cancelled before it reaches the model, the brief runs on", async () => {
    const channelId = await newChannel("Brief first");
    const brief = llm.hold("proactive", ["Morning, "]);
    const briefRun = (await fixture.runs.submit({ userId: alex.userId, channelId, taskId: null, kind: "brief", prompt: "Write the brief" }))!;
    await brief.reached;
    const sentBefore = llm.sent("chat").length;
    const stream = await send(channelId, "Are you there?", "stop-behind-1");
    // Answered at once: the chat turn is still queued (nothing to wait for).
    expect(StopResponse.parse(await (await stopChannel(channelId)).json())).toEqual({ stopped: 1 });
    expect(await db().run.findUniqueOrThrow({ where: { id: briefRun } })).toMatchObject({ status: "running" });
    brief.release();
    const frames = await readSse(stream);
    await fixture.runs.idle();
    expect(ownDone(frames).payload).toMatchObject({ status: "cancelled", error: null });
    expect(doneOf(frames, briefRun).map((e) => e.payload.status)).toEqual(["completed"]);
    expect(llm.sent("chat").length).toBe(sentBefore);
    const replies = await db().message.findMany({ where: { channelId, role: "assistant" }, orderBy: { createdAt: "asc" } });
    expect(replies.map((m) => m.text)).toEqual(["Morning, "]);
    // Never answered, so still Delivered.
    const page = MessagePage.parse(await (await req(`/api/channels/${channelId}/messages`)).json());
    expect(page.messages.at(-1)).toMatchObject({ role: "user", text: "Are you there?", status: "sent", stopped: false });
  });
});

describe("POST /api/tasks/:id/stop", () => {
  const stopTask = (taskId: string, user: SignedIn = alex) => req(`/api/tasks/${taskId}/stop`, "POST", undefined, user);

  test("stops the task's own turn: partial text stays stopped in its session, the task waits for the user; the channel's stop doesn't touch it", async () => {
    const channelId = await newChannel("Task stop");
    const held = llm.hold("task", ["Looking into ", "flights"]);
    const from = await lastEventId(fixture);
    const task = await built.tasks.service.create({ userId: alex.userId, channelId, title: "Find flights", prompt: "Find flights to Lisbon" });
    await held.reached;
    expect((await stopChannel(channelId)).status).toBe(409);
    expect((await stopTask(task.id, sam)).status).toBe(404);
    const response = await stopTask(task.id);
    expect(response.status).toBe(200);
    expect(StopResponse.parse(await response.json())).toEqual({ stopped: 1 });
    await fixture.runs.idle();

    const page = MessagePage.parse(await (await req(`/api/tasks/${task.id}/messages`)).json());
    expect(page.messages.map((m) => [m.role, m.text, m.stopped, m.taskId])).toEqual([["assistant", "Looking into flights", true, task.id]]);
    expect(await db().message.count({ where: { channelId, taskId: null } })).toBe(0);
    expect(await db().task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "needs_input" });

    const events = await storedEvents(fixture, alex.userId, from);
    const done = ofType(events, "done").filter((e) => e.payload.taskId === task.id);
    expect(done.map((e) => e.payload.status)).toEqual(["cancelled"]);
    expect(ofType(events, "typing").filter((e) => e.payload.taskId === task.id).at(-1)?.payload.typing).toBe(false);
    const statuses = ofType(events, "task").filter((e) => e.payload.task.id === task.id).map((e) => e.payload.task.status);
    expect(statuses.at(-1)).toBe("needs_input");
    // The task's status lands before the run's done.
    const lastTask = events.findLastIndex((e) => e.type === "task" && e.payload.task.id === task.id);
    expect(lastTask).toBeLessThan(events.indexOf(done[0]!));

    const idle = await stopTask(task.id);
    expect(idle.status).toBe(409);
    expect((await errorOf(idle)).code).toBe("conflict");
    expect((await stopTask("nope")).status).toBe(404);
  });

  test("a reply queued behind the stopped task turn still runs", async () => {
    const channelId = await newChannel("Task queue");
    const held = llm.hold("task", ["Draft one"]);
    const task = await built.tasks.service.create({ userId: alex.userId, channelId, title: "Draft", prompt: "Draft the post" });
    await held.reached;
    llm.script("task", [text("Draft two")]);
    const reply = await req(`/api/tasks/${task.id}/messages`, "POST", { text: "Make it shorter", clientId: "stop-task-q-1" });
    expect(reply.status).toBe(200);
    expect(StopResponse.parse(await (await stopTask(task.id)).json())).toEqual({ stopped: 1 });
    const frames = await readSse(reply);
    expect(ownDone(frames).payload).toMatchObject({ status: "completed", taskId: task.id });
    await fixture.runs.idle();
    const page = MessagePage.parse(await (await req(`/api/tasks/${task.id}/messages`)).json());
    expect(page.messages.map((m) => [m.role, m.text, m.stopped])).toEqual([
      ["assistant", "Draft one", true],
      ["user", "Make it shorter", false],
      ["assistant", "Draft two", false],
    ]);
  });

  test("older payloads without stopped parse as false", () => {
    const old = { id: "m1", channelId: "c1", taskId: null, role: "assistant", kind: "text", text: "hi", status: "sent", clientId: null, reactions: [], createdAt: "2026-10-25T08:47:00.000Z", updatedAt: "2026-10-25T08:47:00.000Z", payload: { skill: null, attachments: [] } };
    expect(Message.parse(old).stopped).toBe(false);
  });
});

