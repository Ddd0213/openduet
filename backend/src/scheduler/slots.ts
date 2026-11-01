// Slot math for the proactive engine (L75), pure functions on Intl only (no dependency): a user's
// local wall-clock schedule (the morning brief at User.briefTime, 5 check-ins at
// 10/13/16/19/22:checkinMinute) as UTC instants in the user's IANA timezone.
// DST: a local time that doesn't exist (spring forward) moves forward by the gap (02:30 -> 03:30),
// a local time that happens twice (fall back) takes its first occurrence.

export interface LocalTime { hour: number; minute: number }
export interface LocalDate { year: number; month: number; day: number }
export interface LocalParts extends LocalDate, LocalTime { second: number; /** 0 = Sunday */ weekday: number }

export type ScheduledKind = "brief" | "checkin";
export const SCHEDULED_KINDS: readonly ScheduledKind[] = ["brief", "checkin"];
/** The 5 daily check-ins, roughly 3 hours apart (L75: 10:49, 1:49, 4:49, 7:49, 10:49 PM). */
export const CHECKIN_HOURS: readonly number[] = [10, 13, 16, 19, 22];
const DEFAULT_BRIEF: LocalTime = { hour: 8, minute: 19 };
const DEFAULT_CHECKIN_MINUTE = 49;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The zone if Intl knows it, else "UTC" (a bad User.timezone never stops the scheduler). */
export function safeZone(timeZone: string): string {
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Wall-clock fields of an instant in a zone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const out: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) out[part.type] = part.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour) % 24, minute: Number(out.minute), second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday ?? ""),
  };
}

export function localDate(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = localParts(instant, timeZone);
  return { year, month, day };
}

/** The wall clock of an instant as if it were UTC, in ms (minute precision is all we need). */
function wallOf(instant: number, timeZone: string): number {
  const p = localParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The zone's UTC offset at an instant in ms (local = utc + offset). */
export function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallOf(whole, timeZone) - whole;
}

/**
 * The UTC instant of a local wall-clock time on a local date. The offsets a day before and a day
 * after bracket at most one transition: a wall time valid under both (fall back) takes the earlier
 * instant; valid under neither (spring forward) uses the offset from before the gap, which lands
 * the same distance past the transition (02:30 -> 03:30 when the clock jumps an hour).
 */
export function zonedInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => wallOf(instant, timeZone) === wall)
    .sort((a, b) => a - b);
  return new Date(valid[0] ?? wall - before);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday, of the calendar date itself (not of some instant). */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

const compareDates = (a: LocalDate, b: LocalDate) => a.year - b.year || a.month - b.month || a.day - b.day;
export const isWeekend = (weekday: number) => weekday === 0 || weekday === 6;

/** User.briefTime ("HH:mm"); a malformed value falls back to the column default 08:19. */
export function parseBriefTime(value: string): LocalTime {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : { ...DEFAULT_BRIEF };
}

export function checkinTimes(minute: number): LocalTime[] {
  const m = Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : DEFAULT_CHECKIN_MINUTE;
  return CHECKIN_HOURS.map((hour) => ({ hour, minute: m }));
}

/** One job's schedule: local times every day, or only Monday to Friday (local) until weekends are on. */
export interface ScheduleSpec { timeZone: string; times: LocalTime[]; weekendsOn: boolean }

export interface ScheduleUser { timezone: string; briefTime: string; checkinMinute: number; weekendsOn: boolean }

export function specFor(user: ScheduleUser, kind: ScheduledKind): ScheduleSpec {
  return {
    timeZone: safeZone(user.timezone),
    times: kind === "brief" ? [parseBriefTime(user.briefTime)] : checkinTimes(user.checkinMinute),
    weekendsOn: user.weekendsOn,
  };
}

/** A stable key of a spec, to notice schedule changes. */
export const specKey = (spec: ScheduleSpec) =>
  `${spec.timeZone}|${spec.weekendsOn ? 1 : 0}|${spec.times.map((t) => `${t.hour}:${t.minute}`).join(",")}`;

/** Every slot with from < slot <= to, oldest first. */
export function slotsBetween(spec: ScheduleSpec, from: Date, to: Date): Date[] {
  if (to.getTime() <= from.getTime()) return [];
  const seen = new Set<number>();
  // A day of margin on both sides: the local date of an instant can differ from UTC's by a day.
  const last = localDate(new Date(to.getTime() + DAY), spec.timeZone);
  for (let day = localDate(new Date(from.getTime() - DAY), spec.timeZone); compareDates(day, last) <= 0; day = addDays(day, 1)) {
    if (!spec.weekendsOn && isWeekend(weekdayOf(day))) continue;
    for (const time of spec.times) {
      const slot = zonedInstant(day, time, spec.timeZone).getTime();
      if (slot > from.getTime() && slot <= to.getTime()) seen.add(slot);
    }
  }
  return [...seen].sort((a, b) => a - b).map((t) => new Date(t));
}

/** The first slot strictly after `after` (a weekend is the longest stretch without one). */
export function nextSlot(spec: ScheduleSpec, after: Date): Date {
  const found = slotsBetween(spec, after, new Date(after.getTime() + 5 * DAY))[0];
  if (!found) throw new Error("schedule has no slot within 5 days");
  return found;
}
