// The per-user event log behind both SSE streams (L73). Every event is validated against the
// contract, stored in Event (increasing id) and then pushed to live subscribers, so a reconnect
// with Last-Event-ID replays exactly what was missed.
//
// M21:
// - Presence: only GET /api/events registers (present()); the POST /messages answer stream is a
//   plain subscriber, so it never makes the app look "online" to push delivery (onlineCount).
// - Coalescing: a streaming reply re-emits its message on every flush (~125 ms). Live subscribers
//   get every version, but once a message has gone quiet (no new version for `quietMs`), or has
//   more than `maxVersions` stored versions, its superseded `message` events are deleted and only
//   the newest stays: a long reply ends up as one stored event with its exact final text. Only
//   `message` events are compacted (an upsert by id carries the whole message); status, typing,
//   done, approval etc. are never touched. The newest version is always written before older ones
//   are deleted, so a replay running at the same time never misses the final state.
// - Resume: a reconnect that would replay more than RESYNC_REPLAY_LIMIT events, or whose
//   Last-Event-ID is older than what is kept, gets one `resync` instead (routes/events.ts).
import { z } from "zod";
import { DuetEvent } from "../contract/events.ts";
import { normalizeAssistantProtocol } from "../contract/common.ts";
import { RESYNC_REPLAY_LIMIT, type ResyncPayload } from "../contract/m21.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

export type EventType = DuetEvent["type"];
// What callers pass: the zod input, so fields with a default (M21 RunRef.kind, the artifact
// statuses) may be left out; write() parses it, so subscribers and the log get the full shape.
type PayloadOf<T extends EventType> = Extract<z.input<typeof DuetEvent>, { type: T }>["payload"];
type Listener = (event: DuetEvent) => void;
/** Sees every stored event of every user (push notifications); never counts as a subscriber. */
export type PublishListener = (published: { userId: string; event: DuetEvent }) => void;

/** One replay page; the total is capped by RESYNC_REPLAY_LIMIT (a bigger gap gets `resync`). */
export const MAX_REPLAY = 2000;
/** A message with no new version for this long is compacted to its newest stored event. */
export const COALESCE_QUIET_MS = 30_000;
/** ... or as soon as it has more stored versions than this (a very long reply). */
export const COALESCE_MAX_VERSIONS = 50;
/** Messages tracked for compaction at once; past it the least recently updated are compacted early. */
const COALESCE_TRACKED = 2000;

export interface EventBusOptions {
  /** test seam for the compaction clock */
  now?: () => number;
  quietMs?: number;
  maxVersions?: number;
}

/** What a reconnect gets: the missed events, or one `resync` whose envelope id is the new cursor. */
export type ResumePlan = { kind: "replay" } | { kind: "resync"; reason: ResyncPayload["reason"]; id: number };

interface Versions { ids: number[]; at: number }

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly publishListeners = new Set<PublishListener>();
  /** live GET /api/events streams per user (M21: the only thing that counts as "online") */
  private readonly presence = new Map<string, number>();
  /** stored `message` event ids per message id, oldest first; Map order = least recently updated first */
  private readonly versions = new Map<string, Versions>();
  /** Serializes writes so subscribers see events in id order. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly maxVersions: number;

  constructor(private readonly db: Db, options: EventBusOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.quietMs = options.quietMs ?? COALESCE_QUIET_MS;
    this.maxVersions = Math.max(1, options.maxVersions ?? COALESCE_MAX_VERSIONS);
  }

  emit<T extends EventType>(userId: string, channelId: string | null, type: T, payload: PayloadOf<T>): Promise<DuetEvent> {
    const run = this.tail.then(() => this.write(userId, channelId, type, payload));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async write(userId: string, channelId: string | null, type: EventType, payload: unknown): Promise<DuetEvent> {
    // `resync` is built per stream (routes/events.ts) and never stored.
    if (type === "resync") throw new Error("resync events are never stored");
    // Validate before storing: an invalid event must never reach the log or the app.
    const probe = DuetEvent.parse({ id: 1, type, channelId, createdAt: new Date().toISOString(), payload });
    const row = await this.db.event.create({ data: { userId, channelId, type, payload: JSON.stringify(probe.payload) } });
    const event = DuetEvent.parse({ id: row.id, type, channelId, createdAt: row.createdAt.toISOString(), payload: probe.payload });
    for (const listener of this.listeners.get(userId) ?? []) {
      try { listener(event); } catch { /* one broken stream never blocks the others */ }
    }
    for (const listener of this.publishListeners) {
      try { listener({ userId, event }); } catch { /* a hook never breaks the write */ }
    }
    // After the listeners: compaction only ever deletes versions someone already got live.
    await this.coalesce(event);
    return event;
  }

  /** Calls `listener` after each event is stored, for every user. Returns the unsubscribe function. */
  onPublish(listener: PublishListener): () => void {
    this.publishListeners.add(listener);
    return () => {
      this.publishListeners.delete(listener);
    };
  }

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) { set = new Set(); this.listeners.set(userId, set); }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  /**
   * M21: marks the user online while a GET /api/events stream is open (docs/API.md "Push": a
   * remote push goes out only without one). Returns the release function (idempotent).
   */
  present(userId: string): () => void {
    this.presence.set(userId, (this.presence.get(userId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.presence.get(userId) ?? 1) - 1;
      if (left > 0) this.presence.set(userId, left);
      else this.presence.delete(userId);
    };
  }

  /** Open GET /api/events streams of the user: what push delivery treats as "the app is online". */
  onlineCount(userId: string): number {
    return this.presence.get(userId) ?? 0;
  }

  /** Every live listener of the user, answer streams included (not presence: see onlineCount). */
  subscriberCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }

  /** Stored events after `afterId`, oldest first (one page). */
  async replay(userId: string, afterId: number): Promise<DuetEvent[]> {
    const rows = await this.db.event.findMany({ where: { userId, id: { gt: afterId } }, orderBy: { id: "asc" }, take: MAX_REPLAY });
    const events: DuetEvent[] = [];
    for (const row of rows) {
      const parsed = DuetEvent.safeParse({ id: row.id, type: row.type, channelId: row.channelId, createdAt: row.createdAt.toISOString(), payload: normalizeAssistantProtocol(JSON.parse(row.payload)) });
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  /** Stored events after `afterId`, page by page (each page at most MAX_REPLAY), at most `max` in total. */
  async *replayAll(userId: string, afterId: number, max = Number.POSITIVE_INFINITY): AsyncGenerator<DuetEvent[]> {
    let cursor = afterId;
    let left = max;
    while (left > 0) {
      const page = (await this.replay(userId, cursor)).slice(0, left);
      if (page.length > 0) yield page;
      left -= page.length;
      const last = page.at(-1);
      if (!last || page.length < MAX_REPLAY) return;
      cursor = last.id;
    }
  }

  /**
   * M21: what a reconnect after `since` gets (docs/API.md M21 `resync`). pruned: `since` is older
   * than every event kept for this user (housekeeping deleted what came after it), or newer than
   * the newest one (the database was restored or reset); replay_limit: more than
   * RESYNC_REPLAY_LIMIT events were missed. The resync id is the newest stored event: the client's
   * new cursor. `since` 0 means "everything": never pruned.
   */
  async resumePlan(userId: string, since: number, limit = RESYNC_REPLAY_LIMIT): Promise<ResumePlan> {
    const [oldest, newest] = await Promise.all([
      this.db.event.findFirst({ where: { userId }, orderBy: { id: "asc" }, select: { id: true } }),
      this.db.event.findFirst({ where: { userId }, orderBy: { id: "desc" }, select: { id: true } }),
    ]);
    const cursor = async () =>
      newest?.id ?? (await this.db.event.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? Math.max(1, since);
    if (since > 0 && (!oldest || !newest || since < oldest.id || since > newest.id)) {
      return { kind: "resync", reason: "pruned", id: await cursor() };
    }
    // More than `limit` after `since`: the (limit+1)th one exists. An index walk, not a full count.
    const over = await this.db.event.findFirst({ where: { userId, id: { gt: since } }, orderBy: { id: "asc" }, skip: limit, select: { id: true } });
    if (over) return { kind: "resync", reason: "replay_limit", id: await cursor() };
    return { kind: "replay" };
  }

  /** M21: tracks a message's stored versions and deletes the superseded ones that are due (see the header). */
  private async coalesce(event: DuetEvent): Promise<void> {
    const stale: number[] = [];
    const now = this.now();
    const current = event.type === "message" ? event.payload.message.id : null;
    if (current !== null) {
      const entry = this.versions.get(current) ?? { ids: [], at: now };
      // Re-insert so the Map stays ordered least recently updated first.
      this.versions.delete(current);
      entry.ids.push(event.id);
      entry.at = now;
      if (entry.ids.length > this.maxVersions) stale.push(...entry.ids.splice(0, entry.ids.length - 1));
      this.versions.set(current, entry);
    }
    for (const [key, entry] of this.versions) {
      // The message just written is the last entry; everything before it is older.
      if (key === current) break;
      if (now - entry.at < this.quietMs && this.versions.size <= COALESCE_TRACKED) break;
      stale.push(...entry.ids.slice(0, -1));
      this.versions.delete(key);
    }
    for (let i = 0; i < stale.length; i += 500) {
      try {
        await this.db.event.deleteMany({ where: { id: { in: stale.slice(i, i + 500) }, type: "message" } });
      } catch (error) {
        // Nothing lost: the superseded versions just stay stored (housekeeping removes them later).
        log.warn("event compaction failed", { count: stale.length, error: { name: (error as Error).name } });
        return;
      }
    }
  }
}

/** `Last-Event-ID` header wins over `?since=`; null when neither is a valid id. */
export function resumeFrom(header: string | undefined, query: string | undefined): number | null {
  const parsed = z.coerce.number().int().nonnegative().safeParse(header ?? query);
  return parsed.success && (header ?? query) !== undefined ? parsed.data : null;
}
