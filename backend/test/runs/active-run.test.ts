// M21 activeRun (contract m21.ts): Channel.activeRun and MessagePage.activeRun are the turn running
// in the channel's own thread, else the first one queued there; null when nothing runs. Chat,
// briefs and a routine's channel turns count; a task's session and a Make build don't. startedAt is
// the run's start, or its queue time while it waits. Real run host + runtime on a scripted model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelList } from "../../src/contract/channels.ts";
import { MessagePage } from "../../src/contract/messages.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { deferred, json, rig, RoleScriptedLlm, text } from "../tasks/harness.ts";

let fixture: TestApp;
let llm: RoleScriptedLlm;
let built: ReturnType<typeof rig>;
let alex: SignedIn;
beforeAll(async () => {
  llm = new RoleScriptedLlm();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      built = rig(core, llm);
      return { agent: built.agent, runs: built.runs, routes: built.tasks.routes };
    },
  });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

/** One model call that waits until released (then answers `reply`) or until its turn is aborted. */
function held(reply = "Done.") {
  const reached = deferred();
  const release = deferred();
  const turn: ScriptTurn = async (request: LlmRequest) => {
    reached.resolve();
    const aborted = new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([release.promise, aborted]);
    if (request.signal?.aborted) throw new Error("aborted");
    return [text(reply)];
  };
  return { turn, reached: reached.promise, release: () => release.resolve() };
}

const db = () => fixture.db;
const newChannel = async (name: string) => (await db().channel.create({ data: { userId: alex.userId, name, purpose: "" } })).id;
const channelOf = async (channelId: string) => {
  const list = ChannelList.parse(await (await fixture.app.request("/api/channels", { headers: alex.headers })).json());
  return list.channels.find((c) => c.id === channelId)!;
};
const pageOf = async (channelId: string) => MessagePage.parse(await (await fixture.app.request(`/api/channels/${channelId}/messages`, { headers: alex.headers })).json());
const send = (channelId: string, body: string, clientId: string) => fixture.app.request(`/api/channels/${channelId}/messages`, json(alex, "POST", { text: body, clientId }));

describe("activeRun", () => {
  test("a running chat turn shows on the channel and the message page (a second one queued behind doesn't replace it); null once done", async () => {
    const channelId = await newChannel("Active chat");
    expect((await channelOf(channelId)).activeRun).toBeNull();
    const first = held("First answer");
    llm.script("chat", first.turn, [text("Second answer")]);
    const stream = await send(channelId, "First", "active-1");
    await first.reached;
    const run = await db().run.findFirstOrThrow({ where: { channelId, kind: "chat", status: "running" } });
    const expected = { runId: run.id, kind: "chat" as const, startedAt: run.startedAt!.toISOString() };
    expect((await channelOf(channelId)).activeRun).toEqual(expected);
    expect((await pageOf(channelId)).activeRun).toEqual(expected);
    const second = await send(channelId, "Second", "active-2");
    expect((await channelOf(channelId)).activeRun).toEqual(expected);
    first.release();
    await Promise.all([readSse(stream), readSse(second)]);
    await fixture.runs.idle();
    expect((await channelOf(channelId)).activeRun).toBeNull();
    expect((await pageOf(channelId)).activeRun).toBeNull();
  });

  test("a Make build, a task's own turn and a brief (not the thread's conversation: Stop couldn't stop it) don't count", async () => {
    const channelId = await newChannel("Not the thread");
    const build = held();
    llm.script("task", build.turn);
    const buildRun = (await fixture.runs.submit({ userId: alex.userId, channelId, taskId: null, kind: "build", prompt: "Build it", queue: "artifact:x" }))!;
    await build.reached;
    const taskTurn = held();
    llm.script("task", taskTurn.turn);
    const task = await built.tasks.service.create({ userId: alex.userId, channelId, title: "Look it up", prompt: "Look it up" });
    await taskTurn.reached;
    expect(await db().run.count({ where: { channelId, status: "running" } })).toBe(2);
    expect((await channelOf(channelId)).activeRun).toBeNull();
    expect((await pageOf(channelId)).activeRun).toBeNull();
    const brief = held("Morning!");
    llm.script("proactive", brief.turn);
    const briefRun = (await fixture.runs.submit({ userId: alex.userId, channelId, taskId: null, kind: "brief", prompt: "Write the brief" }))!;
    await brief.reached;
    expect(await db().run.findUniqueOrThrow({ where: { id: briefRun } })).toMatchObject({ status: "running", kind: "brief" });
    expect((await channelOf(channelId)).activeRun).toBeNull();
    build.release(); taskTurn.release(); brief.release();
    await fixture.runs.idle();
    expect(await db().run.findUniqueOrThrow({ where: { id: buildRun } })).toMatchObject({ status: "completed" });
    expect(task.id).toBeTruthy();
    expect((await channelOf(channelId)).activeRun).toBeNull();
  });

  test("the running one wins over an older queued one; a queued one alone shows its queue time; a routine's channel turn counts", async () => {
    const channelId = await newChannel("Rows");
    const routine = await db().task.create({ data: { userId: alex.userId, channelId, title: "Every morning", routine: true } });
    const queuedAt = new Date(Date.now() - 60_000);
    const queued = await db().run.create({ data: { userId: alex.userId, kind: "chat", status: "queued", channelId, createdAt: queuedAt } });
    expect((await channelOf(channelId)).activeRun).toEqual({ runId: queued.id, kind: "chat", startedAt: queuedAt.toISOString() });
    const startedAt = new Date(Date.now() - 5_000);
    const running = await db().run.create({ data: { userId: alex.userId, kind: "routine", status: "running", channelId, taskId: routine.id, startedAt } });
    expect((await pageOf(channelId)).activeRun).toEqual({ runId: running.id, kind: "routine", startedAt: startedAt.toISOString() });
    // A task's own session run and a finished run never count.
    await db().run.updateMany({ where: { id: { in: [queued.id, running.id] } }, data: { status: "completed" } });
    await db().run.create({ data: { userId: alex.userId, kind: "task", status: "running", channelId, taskId: routine.id, startedAt } });
    expect((await channelOf(channelId)).activeRun).toBeNull();
    await db().run.deleteMany({ where: { channelId } });
  });
});
