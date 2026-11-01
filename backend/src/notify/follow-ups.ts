// M21: a "needs you" item still waiting FOLLOW_UP_MS after its push is reminded once more, with the
// same text and the same collapse id (the newer push replaces the older one on the phone).
// - Tasks in Needs input / Ready for review whose push went out (Task.lastNotifiedStatus = status)
//   and that haven't changed since (Task.updatedAt). Claimed by writing "<status>:reminded", so
//   it happens once, also across restarts; the next transition clears it (triggers.ts).
// - Pending approvals created FOLLOW_UP_MS ago (in memory: an approval created before this
//   process started isn't followed up, rather than twice).
// Quiet hours: a task's follow-up waits until they end (it goes out at the first pass after);
// an approval's doesn't (approvals ignore quiet hours, like their first push).
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { toApproval } from "../approvals/serialize.ts";
import type { NotifyInput, NotifyResult } from "./notifier.ts";
import { inUserQuietHours } from "./quiet.ts";
import { TASK_PHRASE } from "../tasks/phrases.ts";
import { NOTIFY_USAGE_LIMIT } from "./phrases.ts";
import { approvalBody, approvalTarget, collapseIdFor, deepLink, isNotifying, Recent, remindedMark, taskBody } from "./triggers.ts";

/** The phrase key of a Task.updates column's last row (null when there's none or it doesn't parse). */
function lastUpdateKey(raw: string): string | null {
  try {
    const rows: unknown = JSON.parse(raw);
    const last: unknown = Array.isArray(rows) ? rows.at(-1) : null;
    const text = last && typeof last === "object" ? (last as { text?: unknown }).text : null;
    const key = text && typeof text === "object" ? (text as { key?: unknown }).key : null;
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
}

/** How long a "needs you" item waits before the one follow-up (the brief: "after a while"). */
export const FOLLOW_UP_MS = 2 * 60 * 60 * 1000;
/** How often the pass runs. */
export const FOLLOW_UP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 100;

export interface FollowUpOptions {
  now?: () => Date;
  delayMs?: number;
  intervalMs?: number;
  /** approvals created before this aren't followed up (default: when the service was built) */
  since?: Date;
}

export class FollowUps {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private readonly now: () => Date;
  private readonly since: Date;
  /** M21 review: approvals are walked forward by createdAt, so old ignored cards can't fill every batch. */
  private approvalCursor: Date | null = null;
  private readonly approvals = new Recent();

  constructor(private readonly deps: FollowUpOptions & { db: Db; notify: (input: NotifyInput) => Promise<NotifyResult> }) {
    this.now = deps.now ?? (() => new Date());
    this.since = deps.since ?? this.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.deps.intervalMs ?? FOLLOW_UP_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; overlapping calls share the pass in progress. Resolves to the number of follow-ups sent. */
  sweep(): Promise<number> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(): Promise<number> {
    const due = new Date(this.now().getTime() - (this.deps.delayMs ?? FOLLOW_UP_MS));
    let sent = 0;
    try {
      sent += await this.tasks(due);
    } catch (error) {
      log.error("task follow-ups failed", { error: { name: (error as Error).name } });
    }
    try {
      sent += await this.pendingApprovals(due);
    } catch (error) {
      log.error("approval follow-ups failed", { error: { name: (error as Error).name } });
    }
    return sent;
  }

  private async tasks(due: Date): Promise<number> {
    const { db } = this.deps;
    const rows = await db.task.findMany({
      where: { status: { in: ["needs_input", "ready_for_review"] }, lastNotifiedStatus: { in: ["needs_input", "ready_for_review"] }, archivedAt: null, updatedAt: { lte: due } },
      orderBy: { updatedAt: "asc" }, take: BATCH,
      select: { id: true, userId: true, channelId: true, title: true, status: true, lastNotifiedStatus: true, updatedAt: true, failure: true, updates: true },
    });
    const quiet = new Map<string, boolean>();
    let sent = 0;
    for (const task of rows) {
      if (task.lastNotifiedStatus !== task.status || !isNotifying(task.status)) continue;
      if (!quiet.has(task.userId)) quiet.set(task.userId, await inUserQuietHours(db, task.userId, this.now()));
      if (quiet.get(task.userId)) continue; // waits for the end of the quiet hours
      // Claim it once; raw SQL so Task.updatedAt (the list order) doesn't move.
      const claimed = await db.$executeRaw`UPDATE "Task" SET "lastNotifiedStatus" = ${remindedMark(task.status)} WHERE "id" = ${task.id} AND "status" = ${task.status} AND "lastNotifiedStatus" = ${task.status} AND "archivedAt" IS NULL`;
      if (claimed === 0) continue;
      // M29: the same text as the first push (a failed task, one paused at the usage limit).
      const body = task.status === "needs_input" && !task.failure && lastUpdateKey(task.updates) === TASK_PHRASE.pausedUsageLimit
        ? { key: NOTIFY_USAGE_LIMIT } : taskBody(task.status, task.title, task.failure !== null);
      await this.deps.notify({
        userId: task.userId, channelId: task.channelId, body, route: deepLink("tasks", task.id),
        collapseId: collapseIdFor.task(task.id),
      });
      sent++;
    }
    return sent;
  }

  private async pendingApprovals(due: Date): Promise<number> {
    const { db } = this.deps;
    const from = this.approvalCursor && this.approvalCursor > this.since ? this.approvalCursor : this.since;
    const rows = await db.approval.findMany({
      where: { status: "pending", version: { gte: 1 }, createdAt: { gte: from, lte: due } },
      orderBy: { createdAt: "asc" }, take: BATCH,
    });
    // The next pass starts at the newest one seen (gte: rows sharing that time are skipped by the
    // seen set), so a full batch of cards nobody decides doesn't hide newer ones for good.
    const last = rows.at(-1);
    if (last) this.approvalCursor = last.createdAt;
    let sent = 0;
    const now = this.now();
    for (const row of rows) {
      if (row.expiresAt && row.expiresAt <= now) continue;
      if (!this.approvals.add(row.id)) continue;
      try {
        const approval = toApproval(row);
        const target = await approvalTarget(db, row.userId, approval, null);
        if (!target) continue;
        await this.deps.notify({ userId: row.userId, channelId: target.channelId, body: approvalBody(approval), route: target.route, collapseId: collapseIdFor.approval(row.id) });
        sent++;
      } catch (error) {
        log.warn("approval follow-up skipped", { approvalId: row.id, error: { name: (error as Error).name } });
      }
    }
    return sent;
  }
}
