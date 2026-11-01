// M14 F1: a graceful shutdown (a deploy: SIGTERM -> runs.shutdown()) leaves a channel's chat turns
// that answer a stored message as they are in the DB (queued, startedAt null / running), with no
// `done` and no card, so the next boot's recoverStaleRuns (A2) answers each exactly once. A Stop
// or a delete that lands during the shutdown still ends its turn cancelled; other kinds too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import { modelErrorCard } from "../../src/models/cards.ts";
import { RunHost } from "../../src/runs/host.ts";
import { RESTART_NOTE } from "../../src/runs/takeover.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

/**
 * Texts whose next turn is held until its signal aborts (then: cancelled); `reached` resolves on
 * start. With `until`, the turn waits for it and then answers as usual instead.
 */
const holds = new Map<string, { reached: () => void; post: boolean; until?: Promise<void> }>();
const agent = stubAgent(async (input: TurnInput): Promise<TurnResult> => {
  const held = holds.get(input.userMessage.text);
  if (held?.until) {
    holds.delete(input.userMessage.text);
    held.reached();
    await held.until;
  }
  if (!held || held.until) {
    await input.onFirstEvent?.();
    await input.sink.upsertMessage({ role: "assistant", kind: "text", text: `Re: ${input.userMessage.text}` });
    return { status: "completed", error: null, usage: usage(1, 1), model: MODEL };
  }
  holds.delete(input.userMessage.text);
  await input.sink.status("thinking");
  await input.sink.typing(true);
  if (held.post) {
    // What the real runtime does for streamed text: a text step, and the bubble.
    input.steps?.text("Half an answer");
    await input.sink.upsertMessage({ role: "assistant", kind: "text", text: "Half an answer" });
  }
  held.reached();
  await new Promise<void>((resolve) => {
    if (input.signal.aborted) return resolve();
    input.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { status: "cancelled", error: null, usage: usage(3, 2), model: MODEL };
});
const hold = (text: string, post = false) => new Promise<void>((reached) => { holds.set(text, { reached, post }); });
/** The next turn on `text` waits for `until`, then answers; resolves when it started. */
const pause = (text: string, until: Promise<void>) => new Promise<void>((reached) => { holds.set(text, { reached, post: false, until }); });

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;
let casey: SignedIn;
let dana: SignedIn;
let erin: SignedIn;
let frank: SignedIn;
beforeAll(async () => {
  fixture = await createTestApp({}, { agent, heartbeatMs: 1000 });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
  casey = await signUp(fixture, "casey", "Casey Park");
  dana = await signUp(fixture, "dana", "Dana Cho");
  erin = await signUp(fixture, "erin", "Erin Wolf");
  frank = await signUp(fixture, "frank", "Frank Ito");
});
afterAll(() => fixture.cleanup());

/** A process: its own RunHost on the same database (a restart = a new one). */
const host = () => new RunHost({ db: fixture.db, events: fixture.events, usage: fixture.usage, files: fixture.files, agent });
const send = (runs: RunHost, who: SignedIn, text: string) =>
  runs.send({ userId: who.userId, channelId: who.mainChannelId, text, clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply: null });
const row = (id: string) => fixture.db.run.findUniqueOrThrow({ where: { id } });
const doneRuns = async (who: SignedIn) =>
  (await fixture.events.replay(who.userId, 0)).filter((e) => e.type === "done").map((e) => (e.payload as { runId: string }).runId);
const turnsFor = (messageId: string, from: number) => agent.turns.slice(from).filter((t) => t.userMessage.id === messageId);
const cards = (who: SignedIn) => fixture.db.message.findMany({ where: { userId: who.userId, kind: "model_error" } });

describe("a graceful shutdown", () => {
  test("leaves a running and a queued chat turn for the next boot, which answers each exactly once", async () => {
    const a = host();
    const reached = hold("Plan my week");
    const running = await send(a, alex, "Plan my week");
    await reached;
    const queued = await send(a, alex, "And the weekend");
    // Another kind behind them keeps today's behaviour: cancelled with done.
    const checkin = await a.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "checkin", prompt: "Check in", title: { text: "Check in" } });
    await a.shutdown();

    const r = await row(running.runId!);
    expect(r.status).toBe("running");
    expect(r.startedAt).not.toBeNull();
    expect(r.finishedAt).toBeNull();
    expect(await row(queued.runId!)).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
    expect(await row(checkin!)).toMatchObject({ status: "cancelled" });
    const done = await doneRuns(alex);
    expect(done).not.toContain(running.runId!);
    expect(done).not.toContain(queued.runId!);
    expect(done).toContain(checkin!);
    expect(await cards(alex)).toHaveLength(0);

    const b = host();
    const from = agent.turns.length;
    expect(await b.recoverStaleRuns()).toBe(2);
    expect(await b.recoverStaleRuns()).toBe(0);
    await b.idle();
    // The running turn did nothing yet: cancelled (with its done now) and run again with the restart note.
    expect(await row(running.runId!)).toMatchObject({ status: "cancelled" });
    expect(await doneRuns(alex)).toContain(running.runId!);
    const [again, ...moreR] = turnsFor(running.message.id, from);
    expect(moreR).toHaveLength(0);
    expect(again!.runId).not.toBe(running.runId);
    expect(again!.takeover).toBe(RESTART_NOTE);
    expect(await row(again!.runId)).toMatchObject({ status: "completed" });
    // The queued one is answered on its own run, as it was.
    const [later, ...moreQ] = turnsFor(queued.message.id, from);
    expect(moreQ).toHaveLength(0);
    expect(later!.runId).toBe(queued.runId!);
    expect(later!.takeover).toBeUndefined();
    expect(await row(queued.runId!)).toMatchObject({ status: "completed" });
    for (const text of ["Re: Plan my week", "Re: And the weekend"]) {
      expect(await fixture.db.message.count({ where: { userId: alex.userId, text } })).toBe(1);
    }
    expect(await cards(alex)).toHaveLength(0);
    expect(await b.recoverStaleRuns()).toBe(0);
    await b.shutdown();
  });

  test("a turn that posted a bubble keeps it; the boot cancels it with the retry card instead of re-running", async () => {
    const a = host();
    const reached = hold("Draft the email", true);
    const sent = await send(a, sam, "Draft the email");
    await reached;
    await a.shutdown();
    expect(await row(sent.runId!)).toMatchObject({ status: "running" });
    expect(await doneRuns(sam)).not.toContain(sent.runId!);
    // The record of what it streamed is written (what boot reads).
    expect(await fixture.db.runStep.count({ where: { runId: sent.runId!, kind: "text" } })).toBe(1);

    const b = host();
    const from = agent.turns.length;
    expect(await b.recoverStaleRuns()).toBe(1);
    await b.idle();
    expect(agent.turns.length).toBe(from);
    expect(await row(sent.runId!)).toMatchObject({ status: "cancelled" });
    expect(await fixture.db.message.count({ where: { userId: sam.userId, role: "assistant", text: "Half an answer" } })).toBe(1);
    const [card, ...more] = await cards(sam);
    expect(more).toHaveLength(0);
    expect(JSON.parse(card!.payload)).toMatchObject({ phrase: { key: "system.turn_interrupted" }, runId: sent.runId, retry: true });
    await b.shutdown();
  });
});

describe("Stop or a delete during the shutdown", () => {
  test("Stop that lands during the shutdown still ends the running turn cancelled with done; the queued one stays", async () => {
    const a = host();
    const reached = hold("Find a flight");
    const running = await send(a, casey, "Find a flight");
    await reached;
    const queued = await send(a, casey, "Under 300 euros");
    const stopping = a.shutdown();
    expect(await a.stop({ userId: casey.userId, channelId: casey.mainChannelId })).toBe(1);
    await stopping;
    expect(await row(running.runId!)).toMatchObject({ status: "cancelled" });
    expect(await doneRuns(casey)).toContain(running.runId!);
    expect(await row(queued.runId!)).toMatchObject({ status: "queued", startedAt: null });

    const b = host();
    const from = agent.turns.length;
    // Only the queued turn is left; the stopped one isn't run again.
    expect(await b.recoverStaleRuns()).toBe(1);
    await b.idle();
    expect(turnsFor(running.message.id, from)).toHaveLength(0);
    expect(turnsFor(queued.message.id, from).map((t) => t.runId)).toEqual([queued.runId!]);
    expect(await cards(casey)).toHaveLength(0);
    await b.shutdown();
  });

  test("a delete (cancel) that lands during the shutdown ends both turns cancelled with done; boot finds nothing", async () => {
    const a = host();
    const reached = hold("Summarise the doc");
    const running = await send(a, dana, "Summarise the doc");
    await reached;
    const queued = await send(a, dana, "In French");
    const stopping = a.shutdown();
    expect(await a.cancel({ userId: dana.userId, channelId: dana.mainChannelId })).toBe(2);
    await stopping;
    for (const id of [running.runId!, queued.runId!]) {
      expect(await row(id)).toMatchObject({ status: "cancelled" });
      expect(await doneRuns(dana)).toContain(id);
    }
    const b = host();
    expect(await b.recoverStaleRuns()).toBe(0);
    await b.shutdown();
  });
});

describe("a shutdown during a folded burst (A1 + F1)", () => {
  /** Host a: a turn is busy, the burst queues behind it, folds when it ends, and the folding turn is held. */
  async function leftBurst(who: SignedIn, texts: [string, string, string], post: boolean) {
    const a = host();
    let open!: () => void;
    const busy = pause(`Busy ${who.userId}`, new Promise<void>((r) => { open = r; }));
    await send(a, who, `Busy ${who.userId}`);
    await busy;
    const burst = [];
    for (const text of texts) burst.push(await send(a, who, text));
    // The folded turn answers the newest message (its history holds the others).
    const reached = hold(texts[2], post);
    open();
    await reached;
    await a.shutdown();
    expect(await row(burst[0]!.runId!)).toMatchObject({ status: "running" });
    for (const sent of burst.slice(1)) expect(await row(sent.runId!)).toMatchObject({ status: "queued", startedAt: null });
    const done = await doneRuns(who);
    for (const sent of burst) expect(done).not.toContain(sent.runId!);
    return burst;
  }

  test("boot answers the burst once: one re-run whose context reaches the newest message; the folded rows aren't answered again", async () => {
    const burst = await leftBurst(erin, ["Book a table", "for four people", "at Nopa tonight"], false);
    const b = host();
    const from = agent.turns.length;
    expect(await b.recoverStaleRuns()).toBe(3);
    expect(await b.recoverStaleRuns()).toBe(0);
    await b.idle();

    const turns = agent.turns.slice(from);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userMessage.id).toBe(burst[2]!.message.id);
    expect(turns[0]!.takeover).toBe(RESTART_NOTE);
    expect(await row(burst[0]!.runId!)).toMatchObject({ status: "cancelled" });
    for (const sent of burst.slice(1)) expect(await row(sent.runId!)).toMatchObject({ status: "skipped", startedAt: null });
    const done = await doneRuns(erin);
    for (const sent of burst) expect(done.filter((id) => id === sent.runId)).toHaveLength(1);
    // One reply for the burst, every message seen, no card.
    expect(await fixture.db.message.count({ where: { userId: erin.userId, role: "assistant", text: { in: burst.map((s) => `Re: ${s.message.text}`) } } })).toBe(1);
    expect(await fixture.db.message.count({ where: { userId: erin.userId, role: "assistant", text: "Re: at Nopa tonight" } })).toBe(1);
    for (const sent of burst) expect((await fixture.db.message.findUniqueOrThrow({ where: { id: sent.message.id } })).status).toBe("seen");
    expect(await cards(erin)).toHaveLength(0);
    // The re-run's context holds the whole burst, newest last.
    const ctx = await buildContext(fixture.db, { ...turns[0]!, kind: "chat" }, new Date());
    const text = ctx.messages.at(-1)!.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(text).toContain("Book a table");
    expect(text).toContain("for four people");
    expect(text.trim().endsWith("at Nopa tonight")).toBe(true);
    await b.shutdown();
  });

  test("a folding turn that had posted gets one card for the burst (no extra answers); its Retry answers the newest, all seen", async () => {
    const burst = await leftBurst(frank, ["Draft a reply", "to the landlord", "about the boiler"], true);
    const b = host();
    const from = agent.turns.length;
    expect(await b.recoverStaleRuns()).toBe(3);
    await b.idle();
    expect(agent.turns.length).toBe(from);
    expect(await row(burst[0]!.runId!)).toMatchObject({ status: "cancelled" });
    for (const sent of burst.slice(1)) expect(await row(sent.runId!)).toMatchObject({ status: "skipped" });
    const [card, ...more] = await cards(frank);
    expect(more).toHaveLength(0);
    const stored = JSON.parse(card!.payload) as { runId: string; retryOf: { messageId: string; folded?: string[] } };
    expect(stored.runId).toBe(burst[0]!.runId!);
    expect(stored.retryOf.messageId).toBe(burst[2]!.message.id);
    expect(stored.retryOf.folded).toEqual(burst.map((s) => s.message.id));

    await modelErrorCard({ db: fixture.db, events: fixture.events, runs: b })(card!, { action: "retry", itemId: null });
    await b.idle();
    expect(agent.turns.slice(from).map((t) => t.userMessage.id)).toEqual([burst[2]!.message.id]);
    expect(await fixture.db.message.count({ where: { userId: frank.userId, role: "assistant", text: { startsWith: "Re: " } } })).toBe(2);
    for (const sent of burst) expect((await fixture.db.message.findUniqueOrThrow({ where: { id: sent.message.id } })).status).toBe("seen");
    await b.shutdown();
  });
});
