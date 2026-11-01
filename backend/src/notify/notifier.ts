// Notifications (L78). notify() always stores a `notification` event: the app turns it into a
// local UNNotification when it's inactive or the channel isn't on screen. A remote push goes
// out only when the user has no live GET /api/events stream (a suspended app is reached only by
// push). Delivery never throws to the caller; failures are logged without tokens, keys or text.
//
// M21:
// - "Online" is EventBus.onlineCount: open GET /api/events streams only. A POST /messages answer
//   stream left open after the app was suspended no longer swallows pushes.
// - collapseId (one per task / approval / message) and quiet hours: a push with `quiet: true`
//   inside the user's quiet hours (User.quietStart / quietEnd, the same as the proactive gate) is
//   delivered passive (no sound, no lighting up). Approvals don't pass `quiet`.
// - An approval decided after its push went out: the push is withdrawn (provider.withdraw; APNs
//   only, see providers/types.ts).
// - Started alongside: the per-channel unread feed (events/unread.ts) and the "still waiting"
//   follow-ups (follow-ups.ts), so index.ts wiring is unchanged.
//
// M29:
// - When a run stops (a reply, a card that waits on the user, a failure): run-end.ts, fed by RunHost
//   through posted() / ended().
// - `passive` is decided once per notification (quiet + inside quiet hours) and goes on the
//   `notification` event too, so the app's local notification is as quiet as the remote push.
// - APNs pushes carry the Waiting on you count as the badge (needs/service.ts needsYou).
import type { Phrase } from "../contract/common.ts";
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import { ChannelUnreadFeed, type UnreadFeedDeps } from "../events/unread.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { needsYou } from "../needs/service.ts";
import { FollowUps, type FollowUpOptions } from "./follow-ups.ts";
import { NOTIFY_OPEN_APP, NOTIFY_TITLE, renderPhrase } from "./phrases.ts";
import type { PushMessage, PushProvider } from "./providers/types.ts";
import { inUserQuietHours } from "./quiet.ts";
import { RunEndNotices, type RunNotices, type RunRef } from "./run-end.ts";
import { collapseIdFor, NotificationTriggers } from "./triggers.ts";

export interface NotifyInput {
  userId: string;
  /** the thread it belongs to (APNs thread-id); null for account-wide notices */
  channelId?: string | null;
  /** defaults to notify.title ("OpenDuet"), which every fixed notification uses */
  title?: Phrase;
  body: Phrase;
  /** duet://channels/<id>[?message=<id>], duet://tasks/<id>[?message=<id>], duet://artifacts/<id> */
  route: string;
  /** M21: task-<id> / approval-<id> / message-<id>; a newer push for the same thing replaces the older one */
  collapseId?: string;
  /**
   * M21: true = inside the user's quiet hours the push is passive (approvals, reminders, the brief
   * leave it unset). M29: the notification event's `passive` is the same.
   */
  quiet?: boolean;
}

/**
 * local_only: no NOTIFY_PROVIDER · app_connected: a live stream will show it locally ·
 * sent / failed / no_devices: the remote push outcome.
 */
export type NotifyResult = "local_only" | "app_connected" | "sent" | "failed" | "no_devices";

/** What callers (scheduler, reminders) depend on. */
export interface NotifySink {
  notify(input: NotifyInput): Promise<NotifyResult>;
}

export interface NotifierDeps {
  db: Db;
  events: EventBus;
  provider: PushProvider | null;
  /** test seam for quiet hours and the follow-ups */
  now?: () => Date;
  /** M21: the "still waiting" follow-ups; false = off (tests) */
  followUps?: Omit<FollowUpOptions, "now"> | false;
  /** M21: the per-channel unread feed; false = off (tests) */
  unread?: Pick<UnreadFeedDeps, "debounceMs"> | false;
}

/** Collapse ids of approval pushes remembered for withdraw (in memory: a restart forgets them). */
const PUSHED_LIMIT = 2000;

export class Notifier implements NotifySink, RunNotices {
  private readonly triggers: NotificationTriggers;
  private readonly runEnd: RunEndNotices;
  private readonly inFlight = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => Date;
  private readonly unread: ChannelUnreadFeed | null;
  private readonly followUps: FollowUps | null;
  /** approval collapse ids whose remote push went out (withdraw candidates) */
  private readonly pushed = new Set<string>();
  /** approval collapse ids already decided (a push finishing after the decision is withdrawn at once) */
  private readonly decided = new Set<string>();

  constructor(private readonly deps: NotifierDeps) {
    this.now = deps.now ?? (() => new Date());
    this.triggers = new NotificationTriggers(deps.db);
    this.runEnd = new RunEndNotices({ db: deps.db, notify: (input) => this.notify(input), track: (work) => this.track(work) });
    this.unread = deps.unread === false ? null : new ChannelUnreadFeed({ db: deps.db, events: deps.events, ...deps.unread });
    this.followUps = deps.followUps === false ? null : new FollowUps({ db: deps.db, notify: (input) => this.notify(input), now: this.now, ...deps.followUps });
  }

  /** Starts listening to stored events (task, approval, alert message), the unread feed and the follow-ups. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.events.onPublish(({ userId, event }) => {
      if (event.type !== "task" && event.type !== "approval" && event.type !== "message") return;
      if (event.type === "approval" && event.payload.approval.status !== "pending") this.decide(userId, collapseIdFor.approval(event.payload.approval.id));
      this.track(
        this.triggers.fromEvent(userId, event).then((input) => (input ? this.notify(input) : null)).catch((error: unknown) => {
          log.error("notification trigger failed", { type: event.type, error: { name: (error as Error).name } });
        }),
      );
    });
    this.unread?.start();
    this.followUps?.start();
  }

  /** Stops listening, waits for deliveries in flight and closes provider connections. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unread?.stop();
    await this.followUps?.stop();
    await this.idle();
    await this.unread?.idle();
    await this.deps.provider?.close().catch(() => undefined);
  }

  /** Resolves once every delivery started so far (including event-triggered ones) has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  notify(input: NotifyInput): Promise<NotifyResult> {
    return this.track(this.deliver(input));
  }

  /** The follow-up pass (follow-ups.ts); exposed for tests. */
  sweepFollowUps(): Promise<number> {
    return this.followUps?.sweep() ?? Promise.resolve(0);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** An approval was decided: withdraw its push if one went out (or when the one in flight lands). */
  private decide(userId: string, collapseId: string): void {
    this.decided.add(collapseId);
    if (this.decided.size > PUSHED_LIMIT) this.decided.delete(this.decided.values().next().value as string);
    if (this.pushed.has(collapseId)) this.track(this.withdraw(userId, collapseId));
  }

  private remember(userId: string, collapseId: string): void {
    if (!collapseId.startsWith("approval-")) return;
    if (this.decided.has(collapseId)) {
      this.track(this.withdraw(userId, collapseId));
      return;
    }
    this.pushed.add(collapseId);
    if (this.pushed.size > PUSHED_LIMIT) this.pushed.delete(this.pushed.values().next().value as string);
  }

  /** Takes back a delivered remote push; ignores whether the app is online (another device decided). */
  private async withdraw(userId: string, collapseId: string): Promise<void> {
    this.pushed.delete(collapseId);
    const { provider } = this.deps;
    if (!provider?.withdraw) return;
    try {
      await provider.withdraw(userId, collapseId);
    } catch (error) {
      log.warn("push withdraw failed", { provider: provider.name, error: { name: (error as Error).name } });
    }
  }

  /** M29: a message a run just posted (run-end.ts: forms, connection requests and sign-ins push now). */
  posted(run: RunRef, message: Message): void {
    try {
      this.runEnd.posted(run, message);
    } catch (error) {
      log.error("run notice failed", { runId: run.runId, error: { name: (error as Error).name } });
    }
  }

  /** M29: a run ended (run-end.ts decides whether it pushes). */
  ended(run: RunRef, status: "completed" | "failed" | "cancelled"): void {
    try {
      this.runEnd.ended(run, status);
    } catch (error) {
      log.error("run notice failed", { runId: run.runId, error: { name: (error as Error).name } });
    }
  }

  /** M29: quiet + inside the user's quiet hours; read once for the event and the remote push. */
  private async passive(input: NotifyInput): Promise<boolean> {
    if (!input.quiet) return false;
    try {
      return await inUserQuietHours(this.deps.db, input.userId, this.now());
    } catch (error) {
      log.warn("quiet hours unavailable", { error: { name: (error as Error).name } });
      return false;
    }
  }

  /** M29: the app icon's badge, the Waiting on you count (GET /api/needs-you); null when it can't be read. */
  private async badge(userId: string): Promise<number | null> {
    try {
      return (await needsYou(this.deps.db, userId, { now: this.now() })).count;
    } catch (error) {
      log.warn("badge count unavailable", { error: { name: (error as Error).name } });
      return null;
    }
  }

  private async deliver(input: NotifyInput): Promise<NotifyResult> {
    const title: Phrase = input.title ?? { key: NOTIFY_TITLE };
    const channelId = input.channelId ?? null;
    if (!input.route.startsWith("duet://")) {
      log.error("notification route must be a duet:// link", { userId: input.userId });
      return "failed";
    }
    const passive = await this.passive(input);
    try {
      await this.deps.events.emit(input.userId, channelId, "notification", { title, body: input.body, route: input.route, collapseId: input.collapseId ?? null, passive });
    } catch (error) {
      log.error("notification event failed", { userId: input.userId, error: { name: (error as Error).name } });
    }
    const { provider } = this.deps;
    if (!provider) return "local_only";
    if (this.deps.events.onlineCount(input.userId) > 0) return "app_connected";
    try {
      const user = await this.deps.db.user.findUnique({ where: { id: input.userId }, select: { language: true, timezone: true } });
      if (!user) return "failed";
      const render = (phrase: Phrase) => renderPhrase(phrase, user.language, user.timezone);
      const message: PushMessage = {
        userId: input.userId,
        title: render(title),
        body: render(input.body),
        teaser: render({ key: NOTIFY_OPEN_APP }),
        route: input.route,
        channelId,
      };
      if (input.collapseId) message.collapseId = input.collapseId;
      if (passive) message.passive = true;
      if (provider.badges) {
        const badge = await this.badge(input.userId);
        if (badge !== null) message.badge = badge;
      }
      const outcome = await provider.send(message);
      if (outcome === "sent" && input.collapseId) this.remember(input.userId, input.collapseId);
      return outcome;
    } catch (error) {
      log.error("push failed", { provider: provider.name, error: { name: (error as Error).name } });
      return "failed";
    }
  }
}
