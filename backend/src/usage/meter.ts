// Token usage and limits (L79, L166): a 5-hour session that starts with the first message and a
// 7-day weekly window, counted the same way for every model (input + output per Run).
// A limit of 0 means "no limit": the counters still run so the Usage bars show usage.
import type { Usage } from "@prisma/client";
import type { Config } from "../config.ts";
import type { UsageState } from "../contract/account.ts";
import type { Db } from "../db.ts";

export const SESSION_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Limits = Pick<Config, "SESSION_TOKEN_LIMIT" | "WEEKLY_TOKEN_LIMIT">;

/** Wall-clock parts of `at` in an IANA zone (UTC when the zone is unknown). */
function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch {
    return zonedParts(at, "UTC");
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  const n = (key: string) => Number(parts[key]);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour") % 24, minute: n("minute"), second: n("second") };
}

/** The instant of local midnight on the 1st of (year, month) in the zone; month may overflow (13 = next January). */
function monthStart(year: number, month: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, 1);
  let guess = wall;
  // Two passes settle the zone offset (also across a DST change near midnight).
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
    guess = wall - offset;
  }
  return new Date(guess);
}

/** The user's calendar month (their timezone) around `now`: [start, next). The free Full reset expires at next - 1 ms. */
export function userMonth(now: Date, timeZone: string): { start: Date; next: Date } {
  const { year, month } = zonedParts(now, timeZone);
  return { start: monthStart(year, month, timeZone), next: monthStart(year, month + 1, timeZone) };
}

export class UsageMeter {
  constructor(private readonly db: Db, private readonly limits: Limits, private readonly now: () => Date = () => new Date()) {}

  /** The meter's clock (tests pass a fake one); the Usage panel's ranges use it too. */
  clock(): Date {
    return this.now();
  }

  /** The user's row with expired windows rolled over (persisted). */
  private async current(userId: string): Promise<Usage> {
    const row = await this.db.usage.upsert({ where: { userId }, create: { userId }, update: {} });
    const now = this.now().getTime();
    const patch: Partial<Usage> = {};
    if (row.sessionWindowStart && now - row.sessionWindowStart.getTime() >= SESSION_MS) Object.assign(patch, { sessionTokens: 0, sessionWindowStart: null });
    if (row.weeklyWindowStart && now - row.weeklyWindowStart.getTime() >= WEEK_MS) Object.assign(patch, { weeklyTokens: 0, weeklyWindowStart: null });
    return Object.keys(patch).length ? this.db.usage.update({ where: { userId }, data: patch }) : row;
  }

  private resumesAt(row: Usage): Date | null {
    const session = this.limits.SESSION_TOKEN_LIMIT > 0 && row.sessionTokens >= this.limits.SESSION_TOKEN_LIMIT && row.sessionWindowStart
      ? new Date(row.sessionWindowStart.getTime() + SESSION_MS) : null;
    const weekly = this.limits.WEEKLY_TOKEN_LIMIT > 0 && row.weeklyTokens >= this.limits.WEEKLY_TOKEN_LIMIT && row.weeklyWindowStart
      ? new Date(row.weeklyWindowStart.getTime() + WEEK_MS) : null;
    if (session && weekly) return session > weekly ? session : weekly;
    return session ?? weekly;
  }

  /** The user's current calendar month in their timezone (UTC for an unknown user). */
  private async month(userId: string): Promise<{ start: Date; next: Date }> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    return userMonth(this.now(), user?.timezone ?? "UTC");
  }

  async state(userId: string): Promise<UsageState> {
    const row = await this.current(userId);
    const resumes = this.resumesAt(row);
    const month = await this.month(userId);
    const usedThisMonth = row.fullResetUsedAt !== null && row.fullResetUsedAt >= month.start && row.fullResetUsedAt < month.next;
    return {
      session: { used: row.sessionTokens, limit: this.limits.SESSION_TOKEN_LIMIT, resetsAt: row.sessionWindowStart ? new Date(row.sessionWindowStart.getTime() + SESSION_MS).toISOString() : null },
      weekly: { used: row.weeklyTokens, limit: this.limits.WEEKLY_TOKEN_LIMIT, resetsAt: row.weeklyWindowStart ? new Date(row.weeklyWindowStart.getTime() + WEEK_MS).toISOString() : null },
      fullReset: { available: !usedThisMonth, expiresAt: new Date(month.next.getTime() - 1).toISOString() },
      limited: resumes !== null,
      resumesAt: resumes?.toISOString() ?? null,
    };
  }

  /** Called when a message is sent: starts the session/weekly windows if none is running. */
  async touch(userId: string): Promise<void> {
    const row = await this.current(userId);
    const now = this.now();
    if (!row.sessionWindowStart || !row.weeklyWindowStart) {
      await this.db.usage.update({ where: { userId }, data: { sessionWindowStart: row.sessionWindowStart ?? now, weeklyWindowStart: row.weeklyWindowStart ?? now } });
    }
  }

  /**
   * The free monthly "Full reset" (L79): zeroes both counters and closes both windows (the next
   * message starts fresh ones). Claimed atomically, so two taps can't both succeed. Returns false
   * when it was already used in the user's current calendar month.
   */
  async fullReset(userId: string): Promise<boolean> {
    await this.current(userId);
    const month = await this.month(userId);
    const claimed = await this.db.usage.updateMany({
      where: { userId, OR: [{ fullResetUsedAt: null }, { fullResetUsedAt: { lt: month.start } }, { fullResetUsedAt: { gte: month.next } }] },
      data: { sessionTokens: 0, sessionWindowStart: null, weeklyTokens: 0, weeklyWindowStart: null, fullResetUsedAt: this.now() },
    });
    return claimed.count === 1;
  }

  /** Adds a finished run's tokens to both windows. */
  async record(userId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    await this.touch(userId);
    await this.db.usage.update({ where: { userId }, data: { sessionTokens: { increment: tokens }, weeklyTokens: { increment: tokens } } });
  }
}
