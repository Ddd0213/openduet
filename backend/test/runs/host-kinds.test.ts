// RunHost runs any RunKind (M3 tasks, M4 brief/checkin/scan) without changing M2 chat: submitted
// turns share the channel's queue unless they belong to a task (own queue), their prompt reaches
// the model but is never stored, hooks wrap the turn (after lands before `done`; a before that
// says no, or throws, skips it), and startup recovery cancels stale runs of every kind.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { SubmitInput, TurnOutcome } from "../../src/runs/host.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

let script: (input: TurnInput) => Promise<TurnResult>;
const agent = stubAgent((input) => script(input));
let fixture: TestApp;
let alex: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({}, { agent, heartbeatMs: 1000 });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const completed = (): TurnResult => ({ status: "completed", error: null, usage: usage(2, 1), model: MODEL });
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastId = async () => (await fixture.db.event.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0;
const since = (id: number): Promise<DuetEvent[]> => fixture.events.replay(alex.userId, id);
const doneOf = (events: DuetEvent[], runId: string) => events.filter((e) => e.type === "done" && e.payload.runId === runId);
/** submit() is null only while shutting down, which these tests never do. */
const submitted = async (input: SubmitInput): Promise<string> => {
  const runId = await fixture.runs.submit(input);
  if (!runId) throw new Error("submit was refused");
  return runId;
};
const chat = (text: string, clientId: string) => ({
  userId: alex.userId, channelId: alex.mainChannelId, text, clientId, fileIds: [], skill: null, quickReply: null,
});

describe("RunHost with any kind", () => {
  test("a submitted turn (no task) queues behind the channel's chat; its prompt reaches the model but is never stored", async () => {
    const chatStarted = gate();
    const releaseChat = gate();
    script = async (input) => {
      if (input.kind === "chat") {
        chatStarted.open();
        await releaseChat.opened;
      }
      await input.sink.upsertMessage({ role: "assistant", kind: "text", text: `${input.kind} reply` });
      return completed();
    };
    const before = agent.turns.length;
    const sent = await fixture.runs.send(chat("Hi there", "k-1"));
    await chatStarted.opened;
    const checkinId = await submitted({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "checkin", prompt: "Morning check-in: anything due today?" });
    await sleep(30);
    // Same channel queue: the check-in waits for the chat turn.
    expect((await fixture.db.run.findUniqueOrThrow({ where: { id: checkinId } })).status).toBe("queued");
    releaseChat.open();
    await fixture.runs.idle();

    const turns = agent.turns.slice(before);
    expect(turns.map((t) => t.kind)).toEqual(["chat", "checkin"]);
    expect(turns[0]!.runId).toBe(sent.runId!);
    expect(turns[1]).toMatchObject({ runId: checkinId, taskId: null, channelId: alex.mainChannelId, skill: null, attachments: [] });
    expect(turns[1]!.userMessage).toMatchObject({ id: `turn_${checkinId}`, role: "user", text: "Morning check-in: anything due today?", taskId: null });
    expect(await fixture.db.message.count({ where: { text: "Morning check-in: anything due today?" } })).toBe(0);
    expect(await fixture.db.message.count({ where: { id: `turn_${checkinId}` } })).toBe(0);
    expect(await fixture.db.message.findFirstOrThrow({ where: { text: "checkin reply" } })).toMatchObject({ role: "assistant", taskId: null, channelId: alex.mainChannelId });
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: checkinId } })).toMatchObject({ kind: "checkin", status: "completed", taskId: null, inputTokens: 2, outputTokens: 1 });
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: sent.runId! } })).toMatchObject({ kind: "chat", status: "completed" });
  });

  test("the after hook sees the finished run and lands before done", async () => {
    script = async ({ sink }) => {
      await sink.upsertMessage({ role: "assistant", kind: "text", text: "Here's your brief." });
      return completed();
    };
    const seen: { outcome: TurnOutcome; status: string; doneYet: number }[] = [];
    const runId = await submitted({
      userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "brief", prompt: "Write the morning brief",
      hooks: {
        before: async () => true,
        after: async (outcome) => {
          const run = await fixture.db.run.findUniqueOrThrow({ where: { id: outcome.runId } });
          seen.push({ outcome, status: run.status, doneYet: doneOf(await since(0), outcome.runId).length });
        },
      },
    });
    await fixture.runs.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ outcome: { runId, skipped: false, result: { status: "completed" } }, status: "completed", doneYet: 0 });
    expect(doneOf(await since(0), runId).map((e) => e.payload)).toEqual([{ runId, taskId: null, kind: "brief", status: "completed", error: null }]);
  });

  test("a before hook that says no, or throws, skips the turn: no model call, Run skipped, done(cancelled)", async () => {
    script = async () => { throw new Error("the model must not be called"); };
    const before = agent.turns.length;
    const mark = await lastId();
    const outcomes: TurnOutcome[] = [];
    const after = async (outcome: TurnOutcome) => { outcomes.push(outcome); };
    const declined = await submitted({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "scan", prompt: "Scan", hooks: { before: async () => false, after } });
    const broken = await submitted({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "scan", prompt: "Scan", hooks: { before: async () => { throw new Error("boom"); }, after } });
    await fixture.runs.idle();

    expect(agent.turns.length).toBe(before);
    expect(outcomes).toEqual([{ runId: declined, skipped: true }, { runId: broken, skipped: true }]);
    for (const id of [declined, broken]) {
      const run = await fixture.db.run.findUniqueOrThrow({ where: { id } });
      expect(run).toMatchObject({ kind: "scan", status: "skipped", startedAt: null, inputTokens: 0, outputTokens: 0 });
      expect(run.finishedAt).not.toBeNull();
    }
    const events = await since(mark);
    expect(events.filter((e) => e.type === "done").map((e) => e.payload)).toEqual([
      { runId: declined, taskId: null, kind: "scan", status: "cancelled", error: null },
      { runId: broken, taskId: null, kind: "scan", status: "cancelled", error: null },
    ]);
    // Nothing ran, so no pill, dots or message ever showed.
    expect(events.some((e) => e.type === "status" || e.type === "typing" || e.type === "message")).toBe(false);
  });

  test("a task's turns have their own queue: chat stays free, waitingFor counts the held ones", async () => {
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Plan the offsite", prompt: "Plan the offsite" } });
    const taskStarted = gate();
    const releaseTask = gate();
    script = async (input) => {
      if (input.kind === "task") {
        taskStarted.open();
        await releaseTask.opened;
      }
      await input.sink.upsertMessage({ role: "assistant", kind: "text", text: `${input.kind}: ${input.userMessage.text}` });
      return completed();
    };
    const submit = (prompt: string) => submitted({ userId: alex.userId, channelId: alex.mainChannelId, taskId: task.id, kind: "task", prompt });
    const first = await submit("Start on the offsite");
    const second = await submit("Carry on with the offsite");
    await taskStarted.opened;
    // The first is running; the second waits on the task's queue.
    expect(fixture.runs.waitingFor(task.id)).toBe(1);
    expect(fixture.runs.waitingFor("another-task")).toBe(0);

    // Meanwhile the channel's chat answers right away, and its stream ends on its own done.
    const response = await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, {
      method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Quick question", clientId: "k-2" }),
    });
    expect(response.status).toBe(200);
    const frames = await readSse(response);
    expect(frames.events.filter((e) => e.type === "done").map((e) => e.payload)).toEqual([expect.objectContaining({ taskId: null, status: "completed" })]);
    expect((await fixture.db.run.findUniqueOrThrow({ where: { id: first } })).status).toBe("running");
    expect((await fixture.db.run.findUniqueOrThrow({ where: { id: second } })).status).toBe("queued");

    releaseTask.open();
    await fixture.runs.idle();
    expect(fixture.runs.waitingFor(task.id)).toBe(0);
    const replies = await fixture.db.message.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
    expect(replies.map((m) => [m.role, m.text]).sort()).toEqual([["assistant", "task: Carry on with the offsite"], ["assistant", "task: Start on the offsite"]]);
    expect(await fixture.db.message.findFirstOrThrow({ where: { text: "chat: Quick question" } })).toMatchObject({ taskId: null });
    for (const id of [first, second]) {
      expect(await fixture.db.run.findUniqueOrThrow({ where: { id } })).toMatchObject({ kind: "task", status: "completed", taskId: task.id });
      expect(doneOf(await since(0), id).map((e) => e.payload)).toEqual([{ runId: id, taskId: task.id, kind: "task", status: "completed", error: null }]);
    }
  });

  test("startup recovery cancels stale runs of every kind and clears their pills with the run's taskId", async () => {
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Book the venue" } });
    const make = (kind: string, status: string, extra: { taskId?: string; channelId?: string | null } = {}) =>
      fixture.db.run.create({ data: { userId: alex.userId, kind, status, channelId: alex.mainChannelId, ...extra } });
    const checkin = await make("checkin", "queued");
    const taskRun = await make("task", "running", { taskId: task.id });
    const brief = await make("brief", "running");
    const nowhere = await make("scan", "running", { channelId: null });
    const finished = await make("chat", "completed");
    const mark = await lastId();

    expect(await fixture.runs.recoverStaleRuns()).toBe(4);
    for (const run of [checkin, taskRun, brief, nowhere]) {
      const row = await fixture.db.run.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe("cancelled");
      expect(row.finishedAt).not.toBeNull();
    }
    expect((await fixture.db.run.findUniqueOrThrow({ where: { id: finished.id } })).status).toBe("completed");

    const events = await since(mark);
    const done = events.filter((e) => e.type === "done").map((e) => e.payload);
    expect(done).toHaveLength(3);
    expect(done).toEqual(expect.arrayContaining([
      { runId: checkin.id, taskId: null, kind: "checkin", status: "cancelled", error: null },
      { runId: taskRun.id, taskId: task.id, kind: "task", status: "cancelled", error: null },
      { runId: brief.id, taskId: null, kind: "brief", status: "cancelled", error: null },
    ]));
    const pills = events.filter((e) => e.type === "status").map((e) => e.payload);
    expect(pills).toEqual(expect.arrayContaining([{ runId: taskRun.id, taskId: task.id, kind: "task", status: null }]));
    expect(pills.every((p) => p.status === null)).toBe(true);
    expect(events.filter((e) => e.type === "typing").every((e) => !e.payload.typing)).toBe(true);
    // A run with no channel has no thread to clear.
    expect(events.some((e) => "runId" in e.payload && e.payload.runId === nowhere.id)).toBe(false);
  });
});
