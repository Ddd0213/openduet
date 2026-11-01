// M14b: when the assistant may reach out on its own (the user chose these on 2026-10-27; Codync lead-bot and
// nanoMuse proactivity as references). Decided in code before any model call, so a turn that has
// nothing to do costs no tokens. Only scheduled briefs and check-ins pass through here: the user's
// own reminders and routines, "Run now" and a card's Retry are never gated (asked for = delivered).
import type { Db } from "../db.ts";
import { localParts, safeZone } from "../scheduler/slots.ts";
import type { UsageMeter } from "../usage/meter.ts";

export type Proactivity = "off" | "low" | "normal" | "high";
export const PROACTIVITY_LEVELS: readonly Proactivity[] = ["off", "low", "normal", "high"];
/** Messages the assistant may start per local day, by level. */
export const DAILY_CAP: Record<Proactivity, number> = { off: 0, low: 1, normal: 3, high: 5 };
/** Defaults of User.quietStart / quietEnd: 22:30-08:30 local, in minutes after midnight. */
export const QUIET_DEFAULT = { start: 22 * 60 + 30, end: 8 * 60 + 30 } as const;
/** The user wrote within this long: they're here, a check-in would only interrupt. */
export const RECENT_USER_MS = 30 * 60 * 1000;
/** Over this share of the session or weekly usage the user's own work needs what's left (Codync). */
export const USAGE_HEADROOM = 0.75;

export type GateKind = "brief" | "checkin";
export type GateSkip = "off" | "quiet_hours" | "daily_cap" | "brief_done" | "user_active" | "run_active" | "unanswered" | "usage";
export type GateDecision = { go: true } | { go: false; reason: GateSkip };

export const asProactivity = (value: string): Proactivity =>
  (PROACTIVITY_LEVELS as readonly string[]).includes(value) ? (value as Proactivity) : "normal";

/** Minutes after local midnight inside [start, end); start > end wraps past midnight; start == end = no quiet hours. */
export function inQuietHours(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export interface GateFacts {
  kind: GateKind;
  proactivity: Proactivity;
  /** minutes after local midnight, now */
  localMinute: number;
  quietStart: number;
  quietEnd: number;
  /** briefs and check-ins that posted something since local midnight */
  postedToday: number;
  /** ms since the user's newest message (null = never wrote) */
  sinceUserMs: number | null;
  /** another turn of this user is queued or running */
  runActive: boolean;
  /** the newest proactive message that posted has no user message after it */
  unanswered: boolean;
  /** the higher of session / weekly usage, 0..1 (0 when unlimited) */
  usageShare: number;
  /**
   * M21: a brief already ran today (local date), or the first-day scan did (it is the day's
   * hello): the brief runs strictly once per local date, also after a restart or a changed
   * brief time (read from Run rows, not from memory).
   */
  briefToday?: boolean;
}

/**
 * The rules, in order. The brief keeps its own time (the user set it, so quiet hours don't move it),
 * doesn't wait for an answer (a brief is read, not replied to) and queues behind a running turn in the
 * same thread; check-ins follow every rule.
 */
export function decide(f: GateFacts): GateDecision {
  if (f.proactivity === "off") return { go: false, reason: "off" };
  if (f.usageShare > USAGE_HEADROOM) return { go: false, reason: "usage" };
  if (f.postedToday >= DAILY_CAP[f.proactivity]) return { go: false, reason: "daily_cap" };
  if (f.kind === "brief" && f.briefToday) return { go: false, reason: "brief_done" };
  if (f.kind === "checkin" && inQuietHours(f.localMinute, f.quietStart, f.quietEnd)) return { go: false, reason: "quiet_hours" };
  if (f.kind === "checkin" && f.runActive) return { go: false, reason: "run_active" };
  if (f.kind === "checkin" && f.sinceUserMs !== null && f.sinceUserMs < RECENT_USER_MS) return { go: false, reason: "user_active" };
  if (f.kind === "checkin" && f.unanswered) return { go: false, reason: "unanswered" };
  return { go: true };
}

const share = (part: { used: number; limit: number }) => (part.limit > 0 ? part.used / part.limit : 0);

/**
 * Local midnight of `now` in `timeZone` (User.timezone; an unknown zone reads as UTC). A DST change
 * that day can shift it by an hour; good enough for a daily cap. M18c: also the day of share_finding
 * and of the first message of the day (memory follow-ups).
 */
export function localMidnight(now: Date, timeZone: string): Date {
  const local = localParts(now, safeZone(timeZone));
  return new Date(now.getTime() - ((local.hour * 60 + local.minute) * 60 + local.second) * 1000 - (now.getTime() % 1000));
}

/** Reads the facts for one user from the database and decides. `runId` is the turn being gated. */
export async function gate(deps: { db: Db; usage: UsageMeter }, input: { userId: string; channelId: string; kind: GateKind; runId: string; now: Date }): Promise<GateDecision> {
  const { db, usage } = deps;
  const { userId, channelId, kind, runId, now } = input;
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { proactivity: true, quietStart: true, quietEnd: true, timezone: true } });
  const local = localParts(now, safeZone(user.timezone));
  const localMinute = local.hour * 60 + local.minute;
  const midnight = localMidnight(now, user.timezone);
  const [postedToday, briefsToday, lastUser, active, lastPosted, state] = await Promise.all([
    db.run.count({ where: { userId, kind: { in: ["brief", "checkin"] }, status: "completed", finishedAt: { gte: midnight } } }),
    // M21: a brief that ran today (posted, or found nothing: resolved; scheduled or Run now) or
    // today's first-day scan (its Run has scheduledFor = onboardedAt; the Up next scan has none).
    // Failed and skipped runs don't count, so a brief that broke can still run at the next slot.
    kind === "brief"
      ? db.run.count({
        where: {
          userId, id: { not: runId }, status: { in: ["completed", "resolved"] }, finishedAt: { gte: midnight },
          OR: [{ kind: "brief" }, { kind: "scan", scheduledFor: { not: null } }],
        },
      })
      : Promise.resolve(0),
    db.message.findFirst({ where: { userId, role: "user" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.run.count({ where: { userId, id: { not: runId }, status: { in: ["queued", "running"] } } }),
    db.run.findFirst({ where: { userId, channelId, kind: { in: ["brief", "checkin"] }, status: "completed" }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } }),
    usage.state(userId),
  ]);
  const unanswered = lastPosted?.finishedAt
    ? (await db.message.count({ where: { userId, channelId, role: "user", createdAt: { gt: lastPosted.finishedAt } } })) === 0
    : false;
  return decide({
    kind, proactivity: asProactivity(user.proactivity), localMinute, quietStart: user.quietStart, quietEnd: user.quietEnd,
    postedToday, sinceUserMs: lastUser ? now.getTime() - lastUser.createdAt.getTime() : null,
    runActive: active > 0, unanswered, usageShare: Math.max(share(state.session), share(state.weekly)),
    briefToday: briefsToday > 0,
  });
}
