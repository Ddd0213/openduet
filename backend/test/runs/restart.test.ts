// M14 A2: restarts don't drop chat turns. At boot, a chat run that never reached the model is
// queued again as it was (same Run, answered once even when recovery runs twice); one that was
// running < 1 h and did nothing yet runs again with the restart note; anything else is cancelled
// and gets the retry card, whose retry carries the A3 note. Tasks and runs without a message keep
// today's behaviour (cancelled).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import { RunHost, type RetryOf } from "../../src/runs/host.ts";
import { chatTitle } from "../../src/runs/records.ts";
import { RESTART_NOTE } from "../../src/runs/takeover.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

let script: (input: TurnInput) => Promise<TurnResult>;
const agent = stubAgent((input) => script(input));
let fixture: TestApp;
let alex: SignedIn;
beforeAll(async () => {
  fixture = await createTestApp({}, { agent, heartbeatMs: 1000 });
  alex = await signUp(fixture, "alex");
  script = async ({ sink, userMessage }) => {
    await sink.upsertMessage({ role: "assistant", kind: "text", text: `Re: ${userMessage.text}` });
    return { status: "completed", error: null, usage: usage(1, 1), model: MODEL };
  };
});
afterAll(() => fixture.cleanup());

const ago = (ms: number) => new Date(Date.now() - ms);
/** What a send left behind when the previous process died: the message, then its run. */
async function leftover(text: string, run: { status: string; startedAt?: Date | null; title?: boolean }) {
  const message = await fixture.db.message.create({ data: {
    userId: alex.userId, channelId: alex.mainChannelId, role: "user", text, payload: JSON.stringify({ skill: null }), status: "sent", clientId: crypto.randomUUID(),
  } });
  const row = await fixture.db.run.create({ data: {
    userId: alex.userId, kind: "chat", status: run.status, channelId: alex.mainChannelId, startedAt: run.startedAt ?? null,
    title: run.title === false ? null : JSON.stringify(chatTitle(text)),
  } });
  return { message, run: row };
}
const turnsFor = (messageId: string) => agent.turns.filter((t) => t.userMessage.id === messageId);

describe("recoverStaleRuns for chat turns", () => {
  test("a queued turn that never started is answered on the same run, once, even when recovery runs twice", async () => {
    const { message, run } = await leftover("What's on today?", { status: "queued" });
    const before = agent.turns.length;
    expect(await fixture.runs.recoverStaleRuns()).toBe(1);
    expect(await fixture.runs.recoverStaleRuns()).toBe(0);
    await fixture.runs.idle();
    expect(agent.turns.length).toBe(before + 1);
    const turn = turnsFor(message.id)[0]!;
    expect(turn.runId).toBe(run.id);
    expect(turn.takeover).toBeUndefined();
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed" });
    expect(await fixture.db.message.count({ where: { channelId: alex.mainChannelId, text: "Re: What's on today?" } })).toBe(1);
    // A second boot finds nothing left to do.
    expect(await fixture.runs.recoverStaleRuns()).toBe(0);
  });

  test("a running turn that did nothing yet (< 1 h) runs again with the restart note; the old run is cancelled", async () => {
    const { message, run } = await leftover("Plan my week", { status: "running", startedAt: ago(5 * 60_000) });
    expect(await fixture.runs.recoverStaleRuns()).toBe(1);
    await fixture.runs.idle();
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "cancelled" });
    const [turn] = turnsFor(message.id);
    expect(turn!.runId).not.toBe(run.id);
    expect(turn!.takeover).toBe(RESTART_NOTE);
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: turn!.runId } })).toMatchObject({ kind: "chat", status: "completed", title: run.title });
    expect(await fixture.db.message.count({ where: { userId: alex.userId, kind: "model_error" } })).toBe(0);
  });

  test("a running turn that already called a tool is cancelled with the retry card; its retry carries what it did", async () => {
    const { message, run } = await leftover("Book the train", { status: "running", startedAt: ago(60_000) });
    await fixture.db.runStep.create({ data: {
      id: crypto.randomUUID(), runId: run.id, index: 0, kind: "tool", tool: "start_task", title: "{}", detail: "Book the train", status: "ok",
      output: JSON.stringify({ taskId: "task_1", status: "working" }),
    } });
    expect(await fixture.runs.recoverStaleRuns()).toBe(1);
    await fixture.runs.idle();
    expect(turnsFor(message.id)).toHaveLength(0);
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "cancelled" });
    const card = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "model_error" }, orderBy: { createdAt: "desc" } });
    const stored = JSON.parse(card.payload) as { phrase: { key: string }; runId: string; retry: boolean; state: string; retryOf: RetryOf };
    expect(stored).toMatchObject({ phrase: { key: "system.turn_interrupted" }, runId: run.id, retry: true, state: "open" });
    expect(stored.retryOf).toMatchObject({ kind: "chat", messageId: message.id, channelId: alex.mainChannelId, taskId: null });

    await fixture.runs.retry(alex.userId, stored.runId, stored.retryOf, null);
    await fixture.runs.idle();
    const [retried] = turnsFor(message.id);
    expect(retried!.takeover).toContain("The server restarted and interrupted the previous attempt");
    expect(retried!.takeover).toContain("start_task (Book the train) → working task_1");
  });

  test("a turn that ran over an hour, a message that's gone, an untitled run and a task keep today's behaviour", async () => {
    const long = await leftover("Write the report", { status: "running", startedAt: ago(2 * 60 * 60_000) });
    const gone = await leftover("Deleted meanwhile", { status: "queued" });
    await fixture.db.message.delete({ where: { id: gone.message.id } });
    const untitled = await leftover("Old style", { status: "queued", title: false });
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Book the venue" } });
    const taskRun = await fixture.db.run.create({ data: { userId: alex.userId, kind: "task", status: "running", channelId: alex.mainChannelId, taskId: task.id, startedAt: ago(60_000) } });
    const before = agent.turns.length;
    const cardsBefore = await fixture.db.message.count({ where: { userId: alex.userId, kind: "model_error" } });

    expect(await fixture.runs.recoverStaleRuns()).toBe(4);
    await fixture.runs.idle();
    expect(agent.turns.length).toBe(before);
    for (const id of [long.run.id, gone.run.id, untitled.run.id, taskRun.id]) {
      expect((await fixture.db.run.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
    }
    // Only the long chat turn (its message still there) gets a card.
    expect(await fixture.db.message.count({ where: { userId: alex.userId, kind: "model_error" } })).toBe(cardsBefore + 1);
  });
});

describe("two processes recovering at once (a rolling deploy)", () => {
  const process = () => new RunHost({ db: fixture.db, events: fixture.events, usage: fixture.usage, files: fixture.files, agent });

  test("each leftover turn is claimed by one of them (a real transition) and answered once", async () => {
    const queued = await leftover("Water the plants", { status: "queued" });
    // A turn an earlier boot claimed and queued but never started: running, startedAt still null.
    const claimed = await leftover("Feed the cat", { status: "running" });
    const a = process();
    const b = process();
    const [na, nb] = await Promise.all([a.recoverStaleRuns(), b.recoverStaleRuns()]);
    expect(na + nb).toBe(2);
    await Promise.all([a.idle(), b.idle()]);
    for (const { message, run } of [queued, claimed]) {
      expect(turnsFor(message.id).map((t) => t.runId)).toEqual([run.id]);
      expect(await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed" });
      expect(await fixture.db.message.count({ where: { channelId: alex.mainChannelId, text: `Re: ${message.text}` } })).toBe(1);
    }
    await Promise.all([a.shutdown(), b.shutdown()]);
  });

  test("a turn one process claimed but hasn't started yet, claimed again by the other, still runs once", async () => {
    const { message, run } = await leftover("Call the plumber", { status: "queued" });
    const a = process();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    // Something ahead on a's channel queue holds its recovered turn back.
    await a.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "brief", prompt: "[brief]", hooks: { before: async () => { await gate; return false; } } });
    expect(await a.recoverStaleRuns()).toBe(1);
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "running", startedAt: null });
    // b sees it running, never started (and a's waiting brief), and claims it back (running → queued).
    const b = process();
    expect(await b.recoverStaleRuns()).toBe(2);
    await b.idle();
    open();
    await a.idle();
    expect(turnsFor(message.id).map((t) => t.runId)).toEqual([run.id]);
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed" });
    expect(await fixture.db.message.count({ where: { channelId: alex.mainChannelId, text: "Re: Call the plumber" } })).toBe(1);
    await Promise.all([a.shutdown(), b.shutdown()]);
  });
});
