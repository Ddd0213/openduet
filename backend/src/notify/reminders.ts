// Reminder delivery (set_reminder, L78): every ~30 s, each Reminder with firedAt = null and
// at <= now posts the assistant's message (the text the model wrote) in its channel and notifies.
// A reminder is claimed atomically (firedAt set first) so it never fires twice, even with two
// ticks racing; after a restart, overdue ones still fire because only firedAt matters.
import type { Reminder } from "@prisma/client";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { loadMessage } from "../runs/serialize.ts";
import type { NotifySink } from "./notifier.ts";
import { collapseIdFor, deepLink } from "./triggers.ts";

export const REMINDER_INTERVAL_MS = 30_000;

export interface ReminderDeps {
  db: Db;
  events: EventBus;
  notifier: NotifySink;
  now?: () => Date;
  intervalMs?: number;
}

export class ReminderService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: ReminderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Fires overdue reminders right away, then checks every intervalMs. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? REMINDER_INTERVAL_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; overlapping calls share the pass in progress. Resolves to the number fired. */
  tick(): Promise<number> {
    if (!this.running) {
      this.running = this.fireDue().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async fireDue(): Promise<number> {
    let fired = 0;
    try {
      const due = await this.deps.db.reminder.findMany({ where: { firedAt: null, at: { lte: this.now() } }, orderBy: { at: "asc" }, take: 100 });
      for (const reminder of due) {
        try {
          if (await this.fire(reminder)) fired++;
        } catch (error) {
          log.error("reminder failed", { reminderId: reminder.id, error: { name: (error as Error).name } });
        }
      }
    } catch (error) {
      log.error("reminder pass failed", { error: { name: (error as Error).name } });
    }
    return fired;
  }

  private async fire(reminder: Reminder): Promise<boolean> {
    const { db, events, notifier } = this.deps;
    const claimed = await db.reminder.updateMany({ where: { id: reminder.id, firedAt: null }, data: { firedAt: this.now() } });
    if (claimed.count === 0) return false;
    const channel = await db.channel.findFirst({ where: { id: reminder.channelId, userId: reminder.userId }, select: { id: true } });
    if (!channel) {
      // The channel is gone; the reminder stays claimed so it isn't retried forever.
      log.warn("reminder channel no longer exists", { reminderId: reminder.id });
      return false;
    }
    let messageId: string;
    try {
      messageId = (await db.message.create({ data: { userId: reminder.userId, channelId: channel.id, role: "assistant", kind: "text", text: reminder.text, payload: JSON.stringify({ skill: null }) } })).id;
    } catch (error) {
      // Nothing was posted: release the claim so the next pass tries again.
      await db.reminder.updateMany({ where: { id: reminder.id }, data: { firedAt: null } });
      throw error;
    }
    const message = await loadMessage(db, messageId);
    if (message) await events.emit(reminder.userId, channel.id, "message", { message });
    // M21: the deep link opens the reminder's line; quiet hours don't apply (the user picked the time).
    await notifier.notify({
      userId: reminder.userId, channelId: channel.id, body: { text: reminder.text },
      route: deepLink("channels", channel.id, messageId), collapseId: collapseIdFor.message(messageId),
    });
    return true;
  }
}
