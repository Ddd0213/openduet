// The proactive engine's clock (L75): per onboarded user, a morning brief at User.briefTime and 5
// check-ins at User.checkinMinute, weekdays only until weekends are on, all in the user's timezone.
// Every ~30 s tick looks back at most 24 h (and never before onboardedAt or the latest schedule
// change) for due slots without a Run: < 2 h late -> claim and run once; >= 2 h late -> a "skipped"
// Run in the history. The Run's unique (userId, kind, scheduledFor) is the claim, so two ticks, two
// processes or a restart never run a slot twice (P2002 = someone else has it).
// A slot whose run was cancelled by a restart (runs.recoverStaleRuns) and is still < 2 h late runs
// once more: the cancelled row gives up its scheduledFor (kept as history, shown as skipped) and
// the slot is claimed again. index.ts: recoverStaleRuns() first, then scheduler.start().
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { SCHEDULED_KINDS, slotsBetween, specFor, specKey, type ScheduledKind } from "./slots.ts";

export * from "./slots.ts";

export const TICK_MS = 30_000;
export const LATE_LIMIT_MS = 2 * 60 * 60_000;
export const LOOKBACK_MS = 24 * 60 * 60_000;

/** Runs a claimed slot (the proactive service). */
export interface SlotRunner {
  /**
   * Creates the slot's Run (scheduledFor set; throws Prisma's P2002 when it already exists) and
   * queues the turn. false = not queued (shutting down; the slot is picked up after the restart).
   */
  runScheduled(input: { userId: string; kind: ScheduledKind; scheduledFor: Date }): Promise<boolean>;
}

/** M9: the routines' due slots, swept on the same tick (src/routines/service.ts). */
export interface RoutineTicker {
  tick(now: Date): Promise<TickReport>;
}

export interface SchedulerDeps {
  db: Db;
  runner: SlotRunner;
  now?: () => Date;
  tickMs?: number;
  /** M9: the built-in morning brief and check-ins (PROACTIVE_BUILTINS); default true here, createProactive passes the config */
  builtins?: boolean;
  routines?: RoutineTicker;
}

export interface TickReport { started: number; skipped: number }

/** Prisma's unique-constraint violation, without depending on its error classes. */
export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<TickReport> | null = null;
  /** userId:kind -> the spec seen last and since when; slots before a change are never due */
  private readonly specs = new Map<string, { key: string; since: Date }>();
  private readonly now: () => Date;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Ticks once right away (slots missed while the server was down), then every ~30 s. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    await this.tick().catch(() => undefined);
  }

  /** Stops ticking and waits for a tick in progress. Call before runs.shutdown(). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass over every onboarded user; a tick already in progress is joined, not doubled. */
  tick(now: Date = this.now()): Promise<TickReport> {
    if (this.running) return this.running;
    const work = this.sweep(now).finally(() => { this.running = null; });
    this.running = work;
    return work;
  }

  private async sweep(now: Date): Promise<TickReport> {
    const report: TickReport = { started: 0, skipped: 0 };
    if (this.deps.routines) {
      try {
        const routines = await this.deps.routines.tick(now);
        report.started += routines.started;
        report.skipped += routines.skipped;
      } catch (error) {
        log.error("routine sweep failed", { error: { name: (error as Error).name } });
      }
    }
    // M9: the built-in brief and check-ins only with PROACTIVE_BUILTINS (the first-day scan isn't scheduled here).
    if (this.deps.builtins === false) return report;
    const users = await this.deps.db.user.findMany({
      where: { onboardedAt: { not: null } },
      select: { id: true, timezone: true, briefTime: true, checkinMinute: true, weekendsOn: true, onboardedAt: true },
    });
    for (const user of users) {
      for (const kind of SCHEDULED_KINDS) {
        try {
          await this.sweepUser(user, kind, now, report);
        } catch (error) {
          log.error("scheduled slot failed", { userId: user.id, kind, error: { name: (error as Error).name } });
        }
      }
    }
    if (report.started || report.skipped) log.info("scheduler tick", { ...report });
    return report;
  }

  private async sweepUser(
    user: { id: string; timezone: string; briefTime: string; checkinMinute: number; weekendsOn: boolean; onboardedAt: Date | null },
    kind: ScheduledKind, now: Date, report: TickReport,
  ): Promise<void> {
    const { db } = this.deps;
    const spec = specFor(user, kind);
    const from = this.windowStart(user.id, kind, specKey(spec), user.onboardedAt ?? now, now);
    const due = slotsBetween(spec, from, now);
    if (!due.length) return;
    const rows = await db.run.findMany({ where: { userId: user.id, kind, scheduledFor: { in: due } }, select: { id: true, status: true, scheduledFor: true } });
    const byTime = new Map(rows.map((row) => [row.scheduledFor!.getTime(), row]));
    for (const slot of due) {
      const late = now.getTime() - slot.getTime();
      const row = byTime.get(slot.getTime());
      if (row) {
        // Interrupted by a restart before it reached the model, and still in time: free the slot
        // (the old row stays as history). One that had started (startedAt set) never runs twice.
        if (row.status !== "cancelled" || late >= LATE_LIMIT_MS) continue;
        const freed = await db.run.updateMany({ where: { id: row.id, status: "cancelled", startedAt: null, scheduledFor: slot }, data: { scheduledFor: null } });
        if (freed.count !== 1) continue;
      }
      if (late < LATE_LIMIT_MS) {
        if (await this.claim(user.id, kind, slot)) report.started++;
      } else if (await this.recordSkipped(user.id, kind, slot)) {
        report.skipped++;
      }
    }
  }

  /** The oldest instant a slot may be due from: 24 h back, onboarding, or the last schedule change. */
  private windowStart(userId: string, kind: ScheduledKind, key: string, onboardedAt: Date, now: Date): Date {
    const id = `${userId}:${kind}`;
    const seen = this.specs.get(id);
    let since: Date;
    if (!seen) since = new Date(now.getTime() - LOOKBACK_MS);
    else if (seen.key !== key) since = now; // a new brief time, timezone or weekend setting starts now
    else since = seen.since;
    this.specs.set(id, { key, since });
    const floor = Math.max(since.getTime(), onboardedAt.getTime(), now.getTime() - LOOKBACK_MS);
    return new Date(floor);
  }

  private async claim(userId: string, kind: ScheduledKind, scheduledFor: Date): Promise<boolean> {
    try {
      return await this.deps.runner.runScheduled({ userId, kind, scheduledFor });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async recordSkipped(userId: string, kind: ScheduledKind, scheduledFor: Date): Promise<boolean> {
    try {
      await this.deps.db.run.create({ data: { userId, kind, scheduledFor, status: "skipped", finishedAt: this.now() } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}
