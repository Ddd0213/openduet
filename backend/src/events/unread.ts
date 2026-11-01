// M21 (docs/API.md M21 "channel event when the assistant posts"): every new assistant or system line in a
// channel's own thread (taskId null) is followed by a `channel` event carrying the channel's new
// unreadCount (runs/serialize.ts toChannel), so the menu's red dots update live. Built on stored
// `message` events (EventBus.onPublish), so the run host and every other writer stay unchanged.
//
// - New message ids only: a streaming reply re-emits the same id every ~125 ms, a reaction or an
//   edit re-emits an old one; neither counts. A message older than FRESH_MS when first seen (a
//   re-emit after a restart emptied the set) doesn't either.
// - Throttled per channel: the first new line starts a DEBOUNCE_MS timer, more lines in that window
//   ride along, and the timer reads the count fresh from the database.
// - Re-entrancy: the publish listener runs inside the bus's serialized write, so it only starts a
//   timer; the emit happens later, queued behind the write like any other (no await on the tail).
import type { DuetEvent } from "../contract/events.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { toChannel } from "../runs/serialize.ts";
import type { EventBus } from "./bus.ts";

export const UNREAD_DEBOUNCE_MS = 1000;
const FRESH_MS = 2 * 60 * 1000;
const SEEN_LIMIT = 5000;

export interface UnreadFeedDeps {
  db: Db;
  events: EventBus;
  debounceMs?: number;
  now?: () => number;
}

export class ChannelUnreadFeed {
  private unsubscribe: (() => void) | null = null;
  /** message ids already seen, insertion ordered (oldest dropped past SEEN_LIMIT) */
  private readonly seen = new Set<string>();
  /** pending timer per `${userId}:${channelId}` */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: UnreadFeedDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.events.onPublish(({ userId, event }) => this.onEvent(userId, event));
  }

  /** Stops listening and drops pending updates (the app reloads its channel list on reconnect). */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Resolves once every channel update started so far has been emitted. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private onEvent(userId: string, event: DuetEvent): void {
    if (event.type !== "message") return;
    const { message } = event.payload;
    if (message.role === "user" || message.taskId !== null) return;
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    if (this.now() - Date.parse(message.createdAt) > FRESH_MS) return;
    const key = `${userId}:${message.channelId}`;
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const job = this.emit(userId, message.channelId).finally(() => this.inFlight.delete(job));
      this.inFlight.add(job);
    }, this.deps.debounceMs ?? UNREAD_DEBOUNCE_MS);
    this.timers.set(key, timer);
  }

  private async emit(userId: string, channelId: string): Promise<void> {
    try {
      const row = await this.deps.db.channel.findFirst({ where: { id: channelId, userId } });
      if (!row) return; // deleted meanwhile: its channel_deleted event already went out
      await this.deps.events.emit(userId, channelId, "channel", { channel: await toChannel(this.deps.db, row) });
    } catch (error) {
      log.warn("channel unread update failed", { error: { name: (error as Error).name } });
    }
  }
}
