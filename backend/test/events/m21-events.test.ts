// M21 event layer: streaming writes are coalesced (the final text exact), a reconnect that would
// replay too much (or from before what is kept) gets one `resync`, and a new Claude line in a
// channel's own thread is followed by a `channel` event with its new unreadCount.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuetEvent } from "../../src/contract/events.ts";
import { RESYNC_REPLAY_LIMIT } from "../../src/contract/m21.ts";
import { EventBus } from "../../src/events/bus.ts";
import { ChannelUnreadFeed } from "../../src/events/unread.ts";
import { loadMessage } from "../../src/runs/serialize.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;
let mei: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({}, { heartbeatMs: 1000 });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
  mei = await signUp(fixture, "mei", "Mei Chen");
});
afterAll(() => fixture.cleanup());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storedMessages = (messageId: string) => fixture.db.event.findMany({ where: { type: "message", payload: { contains: `"id":"${messageId}"` } }, orderBy: { id: "asc" } });

/** A Claude text line in `channelId`, updated in place by `say` and emitted on `bus` (what the run host does). */
async function bubble(bus: EventBus, who: SignedIn, channelId = who.mainChannelId, taskId: string | null = null, role: "assistant" | "user" = "assistant") {
  const row = await fixture.db.message.create({ data: { userId: who.userId, channelId, taskId, role, kind: "text", text: "", payload: JSON.stringify({ skill: null }) } });
  return {
    id: row.id,
    say: async (text: string) => {
      await fixture.db.message.update({ where: { id: row.id }, data: { text } });
      return bus.emit(who.userId, channelId, "message", { message: (await loadMessage(fixture.db, row.id))! });
    },
  };
}

describe("coalescing streaming writes", () => {
  test("every version goes out live; once the message is quiet only its newest stored event stays, with the exact final text", async () => {
    let clock = 1_000_000;
    const bus = new EventBus(fixture.db, { now: () => clock, quietMs: 5000 });
    const live: DuetEvent[] = [];
    const unsubscribe = bus.subscribe(alex.userId, (e) => live.push(e));
    const reply = await bubble(bus, alex);
    const words = "The quick brown fox jumps over the lazy dog, then naps in the sun for a while.".split(" ");
    let text = "";
    for (const word of words) {
      text = text ? `${text} ${word}` : word;
      await reply.say(text);
      clock += 125;
    }
    unsubscribe();
    expect(live.filter((e) => e.type === "message").map((e) => (e.type === "message" ? e.payload.message.text : ""))).toHaveLength(words.length);
    // Still streaming (or just finished): nothing compacted yet, a reconnect mid-reply still works.
    expect(await storedMessages(reply.id)).toHaveLength(words.length);

    // Quiet for longer than quietMs: the next write compacts it.
    clock += 6000;
    const typing = await bus.emit(alex.userId, alex.mainChannelId, "typing", { runId: "r1", taskId: null, kind: "chat", typing: false });
    const stored = await storedMessages(reply.id);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.payload).message.text).toBe(text);
    // A replay from before the reply gets it once, final, and the typing event untouched.
    const replayed = await bus.replay(alex.userId, stored[0]!.id - 1);
    expect(replayed.map((e) => e.type)).toEqual(["message", "typing"]);
    expect(replayed[1]!.id).toBe(typing.id);
  });

  test("a very long reply keeps at most maxVersions stored while it streams; other event types are never touched", async () => {
    const bus = new EventBus(fixture.db, { now: () => 0, quietMs: 60_000, maxVersions: 5 });
    const reply = await bubble(bus, alex);
    const status = await bus.emit(alex.userId, alex.mainChannelId, "status", { runId: "r2", taskId: null, status: null });
    for (let i = 1; i <= 12; i++) {
      await reply.say(`part ${i}`);
      expect((await storedMessages(reply.id)).length).toBeLessThanOrEqual(5);
    }
    const stored = await storedMessages(reply.id);
    expect(JSON.parse(stored.at(-1)!.payload).message.text).toBe("part 12");
    expect(await fixture.db.event.count({ where: { id: status.id } })).toBe(1);
  });
});

/** Reads an SSE body until `until`; `onFrame` may act in between (e.g. emit once the resync arrived). */
async function readUntil(response: Response, until: (events: DuetEvent[]) => boolean, onFrame?: (events: DuetEvent[]) => Promise<void>, timeoutMs = 5000) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: DuetEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(events) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)]);
      if (!chunk || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (data) {
          events.push(JSON.parse(data) as DuetEvent);
          await onFrame?.(events);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

describe("GET /api/events resync", () => {
  const typingRow = (userId: string) => ({ userId, channelId: null, type: "typing", payload: JSON.stringify({ runId: "r", taskId: null, kind: "chat", typing: false }) });

  test("more than RESYNC_REPLAY_LIMIT missed: one resync (id = newest stored event, never stored), then live events on the same stream", async () => {
    const start = (await fixture.events.emit(sam.userId, null, "typing", { runId: "r0", taskId: null, typing: false })).id;
    await fixture.db.event.createMany({ data: Array.from({ length: RESYNC_REPLAY_LIMIT + 1 }, () => typingRow(sam.userId)) });
    const newest = (await fixture.db.event.findFirstOrThrow({ where: { userId: sam.userId }, orderBy: { id: "desc" } })).id;
    const response = await fixture.app.request("/api/events", { headers: { ...sam.headers, "Last-Event-ID": String(start) } });
    let liveId = 0;
    const events = await readUntil(response, (e) => e.some((x) => x.id === liveId), async (e) => {
      if (e.length === 1) liveId = (await fixture.events.emit(sam.userId, null, "typing", { runId: "live", taskId: null, typing: true })).id;
    });
    expect(events[0]).toMatchObject({ id: newest, type: "resync", channelId: null, payload: { reason: "replay_limit" } });
    expect(events.slice(1).map((e) => e.id)).toEqual([liveId]);
    expect(await fixture.db.event.count({ where: { type: "resync" } })).toBe(0);
  });

  test("exactly the limit is replayed in full; Last-Event-ID 0 (\"everything\") is never 'pruned'", async () => {
    const start = (await fixture.events.emit(mei.userId, null, "typing", { runId: "r0", taskId: null, typing: false })).id;
    await fixture.db.event.createMany({ data: Array.from({ length: RESYNC_REPLAY_LIMIT }, () => typingRow(mei.userId)) });
    const newest = (await fixture.db.event.findFirstOrThrow({ where: { userId: mei.userId }, orderBy: { id: "desc" } })).id;
    const frames = await readSse(await fixture.app.request("/api/events", { headers: { ...mei.headers, "Last-Event-ID": String(start) } }), { until: (f) => f.ids.includes(newest), timeoutMs: 10_000 });
    expect(frames.events).toHaveLength(RESYNC_REPLAY_LIMIT);
    expect(frames.events.some((e) => e.type === "resync")).toBe(false);
    expect(await fixture.events.resumePlan(mei.userId, 0, RESYNC_REPLAY_LIMIT + 1)).toEqual({ kind: "replay" });
  });

  test("pruned: Last-Event-ID older than the oldest kept event, or newer than the newest (a restored database)", async () => {
    const who = await signUp(fixture, "lin", "Lin Park");
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await fixture.events.emit(who.userId, null, "typing", { runId: `p${i}`, taskId: null, typing: false })).id);
    const kept = (await fixture.db.event.findMany({ where: { userId: who.userId }, orderBy: { id: "asc" } })).map((e) => e.id);
    // Housekeeping removed everything up to and including ids[1].
    await fixture.db.event.deleteMany({ where: { userId: who.userId, id: { lte: ids[1]! } } });
    const newest = kept.at(-1)!;
    expect(await fixture.events.resumePlan(who.userId, ids[0]!)).toEqual({ kind: "resync", reason: "pruned", id: newest });
    expect(await fixture.events.resumePlan(who.userId, ids[2]!)).toEqual({ kind: "replay" });
    expect(await fixture.events.resumePlan(who.userId, newest)).toEqual({ kind: "replay" });
    const frames = await readSse(await fixture.app.request("/api/events", { headers: { ...who.headers, "Last-Event-ID": String(newest + 1000) } }), { until: (f) => f.events.length > 0 });
    expect(frames.events).toEqual([expect.objectContaining({ id: newest, type: "resync", payload: { reason: "pruned" } })]);
  });
});

describe("channel event when Claude posts (unread feed)", () => {
  const channelEvents = (seen: DuetEvent[], channelId: string) => seen.flatMap((e) => (e.type === "channel" && e.channelId === channelId ? [e.payload.channel] : []));

  test("one debounced channel event per burst with the fresh unreadCount; streaming, user lines, task lines and edits don't count", async () => {
    const travel = await fixture.db.channel.create({ data: { userId: alex.userId, name: "Travel", icon: "plane", colorHex: "#5D927A" } });
    const feed = new ChannelUnreadFeed({ db: fixture.db, events: fixture.events, debounceMs: 40 });
    const seen: DuetEvent[] = [];
    const unsubscribe = fixture.events.subscribe(alex.userId, (e) => seen.push(e));
    feed.start();
    try {
      const first = await bubble(fixture.events, alex, travel.id);
      for (const text of ["Hel", "Hello", "Hello there"]) await first.say(text);
      const second = await bubble(fixture.events, alex, travel.id);
      await second.say("A second line in the same burst.");
      await sleep(80);
      await feed.idle();
      expect(channelEvents(seen, travel.id).map((c) => c.unreadCount)).toEqual([2]);

      // The user's own line, a task's session line and an edit of an old line: no channel event.
      const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: travel.id, title: "Book" } });
      await (await bubble(fixture.events, alex, travel.id, null, "user")).say("Thanks");
      await (await bubble(fixture.events, alex, travel.id, task.id)).say("Working on it");
      await first.say("Hello there (edited)");
      await sleep(80);
      await feed.idle();
      expect(channelEvents(seen, travel.id)).toHaveLength(1);

      // The next new line: a new event, counted fresh from the database.
      await (await bubble(fixture.events, alex, travel.id)).say("Booked.");
      await sleep(80);
      await feed.idle();
      expect(channelEvents(seen, travel.id).map((c) => c.unreadCount)).toEqual([2, 3]);
    } finally {
      feed.stop();
      unsubscribe();
    }
  });

  test("emitting from inside the publish listener doesn't deadlock the bus (debounce 0); stop() drops pending updates", async () => {
    const feed = new ChannelUnreadFeed({ db: fixture.db, events: fixture.events, debounceMs: 0 });
    const seen: DuetEvent[] = [];
    const unsubscribe = fixture.events.subscribe(alex.userId, (e) => seen.push(e));
    feed.start();
    try {
      const line = await bubble(fixture.events, alex);
      await line.say("Ping");
      // The bus keeps taking writes while the feed's emit is queued behind them.
      const after = await Promise.race([fixture.events.emit(alex.userId, null, "typing", { runId: "x", taskId: null, typing: false }), sleep(2000).then(() => null)]);
      expect(after).not.toBeNull();
      await sleep(20);
      await feed.idle();
      expect(channelEvents(seen, alex.mainChannelId)).toHaveLength(1);
    } finally {
      feed.stop();
    }
    const slow = new ChannelUnreadFeed({ db: fixture.db, events: fixture.events, debounceMs: 50 });
    slow.start();
    await (await bubble(fixture.events, alex)).say("Dropped on stop");
    slow.stop();
    await sleep(100);
    unsubscribe();
    expect(channelEvents(seen, alex.mainChannelId)).toHaveLength(1);
  });
});
