// M14 A1: a burst of chat messages becomes one turn. When a plain message's turn starts, the plain
// messages still waiting right behind it on the same queue are folded in: the turn answers the
// newest (the history holds the earlier ones), each turns seen with the turn's first event, and
// each folded Run ends `skipped` with its done and no card or reply. A /skill, a brief or any other
// job that can't fold ends the burst. Stop works on the folded turn; activeRuns stays right.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { modelErrorCard } from "../../src/models/cards.ts";
import type { SendInput } from "../../src/runs/host.ts";
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
});
afterAll(() => fixture.cleanup());

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
};
const completed = (): TurnResult => ({ status: "completed", error: null, usage: usage(1, 1), model: MODEL });
/** Replies "Re: <text>" after the seen receipt; the turn whose text is `hold` waits for `release`. */
function replying(hold: string, started: { open: () => void }, release: Promise<void>) {
  return async (input: TurnInput): Promise<TurnResult> => {
    if (input.userMessage.text === hold) {
      started.open();
      await release;
    }
    await input.onFirstEvent?.();
    await input.sink.upsertMessage({ role: "assistant", kind: "text", text: `Re: ${input.userMessage.text}` });
    return completed();
  };
}
let seq = 0;
const send = (text: string, extra: Partial<SendInput> = {}) => fixture.runs.send({
  userId: alex.userId, channelId: alex.mainChannelId, text, clientId: `fold-${++seq}`, fileIds: [], skill: null, quickReply: null, ...extra,
});
const lastEventId = async () => (await fixture.db.event.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0;
const since = (id: number): Promise<DuetEvent[]> => fixture.events.replay(alex.userId, id);

describe("folding a burst of chat messages", () => {
  test("messages waiting behind a running turn are answered by one turn, each seen, each folded run skipped", async () => {
    const started = gate();
    const release = gate();
    script = replying("one", started, release.opened);
    const before = agent.turns.length;
    const mark = await lastEventId();
    const one = await send("one");
    await started.opened;
    const two = await send("hey");
    const three = await send("can you");
    const four = await send("book the 22:10 to Vienna");
    release.open();
    await fixture.runs.idle();

    const turns = agent.turns.slice(before);
    expect(turns.map((t) => t.userMessage.text)).toEqual(["one", "book the 22:10 to Vienna"]);
    expect(turns[1]!.runId).toBe(two.runId!);
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: two.runId! } })).toMatchObject({ status: "completed" });
    for (const folded of [three, four]) {
      const run = await fixture.db.run.findUniqueOrThrow({ where: { id: folded.runId! } });
      expect(run).toMatchObject({ status: "skipped", startedAt: null, inputTokens: 0 });
      expect(run.finishedAt).not.toBeNull();
    }
    for (const sent of [one, two, three, four]) {
      expect((await fixture.db.message.findUniqueOrThrow({ where: { id: sent.message.id } })).status).toBe("seen");
    }
    // One reply for the burst, no card for the folded runs, one done per run.
    expect(await fixture.db.message.count({ where: { channelId: alex.mainChannelId, role: "assistant", text: { startsWith: "Re: " } } })).toBe(2);
    expect(await fixture.db.message.count({ where: { userId: alex.userId, kind: "model_error" } })).toBe(0);
    const events = await since(mark);
    for (const sent of [two, three, four]) {
      expect(events.filter((e) => e.type === "done" && e.payload.runId === sent.runId)).toHaveLength(1);
    }
    const doneOrder = events.flatMap((e) => (e.type === "done" ? [e.payload.runId] : []));
    expect(doneOrder.indexOf(two.runId!)).toBeLessThan(doneOrder.indexOf(three.runId!));
    // No turn left: a resend of a folded message gets the stored one back without a run.
    expect((await fixture.runs.send({ userId: alex.userId, channelId: alex.mainChannelId, text: "can you", clientId: three.message.clientId!, fileIds: [], skill: null, quickReply: null })).runId).toBeNull();

    // The folded turn's context naturally holds the burst, newest last.
    const ctx = await buildContext(fixture.db, { ...turns[1]!, kind: "chat" }, new Date());
    const lastUser = ctx.messages.at(-1)!;
    const text = lastUser.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(text).toContain("hey");
    expect(text).toContain("can you");
    expect(text.trim().endsWith("book the 22:10 to Vienna")).toBe(true);
  });

  test("a /skill message and a brief end the burst; a quote reply folds", async () => {
    const started = gate();
    const release = gate();
    script = replying("start", started, release.opened);
    const before = agent.turns.length;
    const start = await send("start");
    await started.opened;
    const quoted = (await fixture.db.message.findFirstOrThrow({ where: { channelId: alex.mainChannelId, role: "assistant" }, orderBy: { createdAt: "desc" } })).id;
    await send("a");
    await send("b, about this", { replyTo: quoted });
    await send("summarise", { skill: "notes" });
    await send("c");
    await send("d");
    const brief = await fixture.runs.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "brief", prompt: "[brief]" });
    await send("e");
    release.open();
    await fixture.runs.idle();

    const turns = agent.turns.slice(before);
    expect(turns.map((t) => t.userMessage.text)).toEqual(["start", "b, about this", "summarise", "d", "[brief]", "e"]);
    expect(turns[0]!.runId).toBe(start.runId!);
    expect(turns[4]!.runId).toBe(brief!);
    expect(await fixture.db.run.count({ where: { userId: alex.userId, kind: "chat", status: "skipped" } })).toBe(2 + 2);
  });

  test("Stop on a folded turn stops the burst: the turn is cancelled, the folded run ends, nothing else runs", async () => {
    const started = gate();
    const release = gate();
    const second = gate();
    script = async (input) => {
      if (input.userMessage.text === "first") {
        started.open();
        await release.opened;
        return completed();
      }
      second.open();
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", error: null, usage: usage(0, 0), model: null };
    };
    const before = agent.turns.length;
    await send("first");
    await started.opened;
    const two = await send("second");
    const three = await send("third");
    release.open();
    await second.opened;
    expect(agent.turns.at(-1)!.userMessage.id).toBe(three.message.id);
    expect(fixture.runs.busy({ userId: alex.userId, channelId: alex.mainChannelId })).toBe(true);

    expect(await fixture.runs.stop({ userId: alex.userId, channelId: alex.mainChannelId })).toBe(1);
    await fixture.runs.idle();
    expect(agent.turns.length).toBe(before + 2);
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: two.runId! } })).toMatchObject({ status: "cancelled" });
    expect(await fixture.db.run.findUniqueOrThrow({ where: { id: three.runId! } })).toMatchObject({ status: "skipped" });
    expect(fixture.runs.busy({ userId: alex.userId, channelId: alex.mainChannelId })).toBe(false);
    // activeRuns let go of both messages.
    for (const sent of [two, three]) {
      const again = await fixture.runs.send({ userId: alex.userId, channelId: alex.mainChannelId, text: sent.message.text, clientId: sent.message.clientId!, fileIds: [], skill: null, quickReply: null });
      expect(again.runId).toBeNull();
    }
  });

  test("a folded turn that fails before its first event keeps the burst on its card; Retry marks every message seen", async () => {
    const started = gate();
    const release = gate();
    let failures = 0;
    script = async (input) => {
      if (input.userMessage.text === "lead") {
        started.open();
        await release.opened;
        return completed();
      }
      // A failure before any event (not retried on its own): the burst stays "Delivered".
      if (failures++ === 0) return { status: "failed", error: { key: "system.model_context_length" }, usage: usage(0, 0), model: null };
      await input.onFirstEvent?.();
      await input.sink.upsertMessage({ role: "assistant", kind: "text", text: `Re: ${input.userMessage.text}` });
      return completed();
    };
    await send("lead");
    await started.opened;
    const burst = [await send("x1"), await send("x2"), await send("x3")];
    release.open();
    await fixture.runs.idle();
    for (const sent of burst) expect((await fixture.db.message.findUniqueOrThrow({ where: { id: sent.message.id } })).status).toBe("sent");
    const card = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "model_error" }, orderBy: { createdAt: "desc" } });
    const stored = JSON.parse(card.payload) as { runId: string; retryOf: { messageId: string; folded?: string[] } };
    expect(stored.runId).toBe(burst[0]!.runId!);
    expect(stored.retryOf.messageId).toBe(burst[2]!.message.id);
    expect(stored.retryOf.folded).toEqual(burst.map((s) => s.message.id));

    // The Retry tap, through the real card handler (its schema keeps only the M12 fields of retryOf).
    const before = agent.turns.length;
    await modelErrorCard({ db: fixture.db, events: fixture.events, runs: fixture.runs })(card, { action: "retry", itemId: null });
    await fixture.runs.idle();
    expect(agent.turns.slice(before).map((t) => t.userMessage.id)).toEqual([burst[2]!.message.id]);
    for (const sent of burst) expect((await fixture.db.message.findUniqueOrThrow({ where: { id: sent.message.id } })).status).toBe("seen");
  });
});
