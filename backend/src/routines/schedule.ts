// Routine schedules (M9, contract §3): a Schedule (daily / weekdays / weekly / hourly / once) as
// slots in the user's timezone, reusing the proactive engine's slot math (DST included), and the
// one normalising step every writer goes through (schedule_task, manage_scheduled_task, PATCH).
import type { z } from "zod";
import type { Schedule } from "../contract/common.ts";
import { localParts, safeZone, slotsBetween, type ScheduleSpec } from "../scheduler/slots.ts";

export type RoutineSchedule = z.infer<typeof Schedule>;

const DAY = 24 * 60 * 60_000;

function firstSlot(spec: ScheduleSpec, after: Date, days: number): Date | null {
  return slotsBetween(spec, after, new Date(after.getTime() + days * DAY))[0] ?? null;
}

/** The first slot strictly after `after`, or null (a "once" routine whose time has passed). */
export function nextRoutineSlot(schedule: RoutineSchedule, timeZone: string, after: Date): Date | null {
  const zone = safeZone(timeZone);
  const at = { hour: schedule.hour, minute: schedule.minute };
  switch (schedule.cadence) {
    case "once": {
      const when = schedule.at ? new Date(schedule.at) : null;
      return when && when.getTime() > after.getTime() ? when : null;
    }
    case "hourly":
      return firstSlot({ timeZone: zone, times: Array.from({ length: 24 }, (_, hour) => ({ hour, minute: schedule.minute })), weekendsOn: true }, after, 2);
    case "daily":
      return firstSlot({ timeZone: zone, times: [at], weekendsOn: true }, after, 3);
    case "weekdays":
      return firstSlot({ timeZone: zone, times: [at], weekendsOn: false }, after, 5);
    case "weekly": {
      const weekday = schedule.weekday ?? 1;
      const slots = slotsBetween({ timeZone: zone, times: [at], weekendsOn: true }, after, new Date(after.getTime() + 9 * DAY));
      return slots.find((slot) => localParts(slot, zone).weekday === weekday) ?? null;
    }
  }
}

/** A schedule as a tool or the app may write it: hour / minute optional where they don't matter. */
export interface ScheduleInput {
  cadence: RoutineSchedule["cadence"];
  hour?: number | undefined;
  minute?: number | undefined;
  weekday?: number | undefined;
  at?: string | undefined;
}

export type Normalized = { ok: true; schedule: RoutineSchedule } | { ok: false; message: string };

/**
 * The stored form of a schedule: only the keys its cadence uses. weekly needs a weekday; once
 * takes `at` (an ISO time with offset, in the future) or, without it, the next hour:minute in the
 * user's timezone; hourly runs at `minute` past every hour.
 */
export function normalizeSchedule(input: ScheduleInput, timeZone: string, now: Date): Normalized {
  const minute = input.minute ?? 0;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, message: "minute must be 0-59" };
  if (input.cadence === "hourly") return { ok: true, schedule: { cadence: "hourly", hour: input.hour ?? 0, minute } };
  if (input.cadence === "once") {
    if (input.at !== undefined) {
      const at = new Date(input.at);
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(input.at) || Number.isNaN(at.getTime())) return { ok: false, message: "at must be an ISO time with a timezone offset" };
      if (at.getTime() <= now.getTime()) return { ok: false, message: "at must be in the future" };
      const local = localParts(at, safeZone(timeZone));
      return { ok: true, schedule: { cadence: "once", hour: local.hour, minute: local.minute, at: at.toISOString() } };
    }
    if (input.hour === undefined) return { ok: false, message: "a once schedule needs at (or hour and minute)" };
    const next = nextRoutineSlot({ cadence: "daily", hour: input.hour, minute }, timeZone, now);
    if (!next) return { ok: false, message: "no such time" };
    return { ok: true, schedule: { cadence: "once", hour: input.hour, minute, at: next.toISOString() } };
  }
  if (input.hour === undefined) return { ok: false, message: `a ${input.cadence} schedule needs hour (0-23) and minute` };
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) return { ok: false, message: "hour must be 0-23" };
  if (input.cadence === "weekly") {
    if (input.weekday === undefined) return { ok: false, message: "a weekly schedule needs weekday (0 = Sunday ... 6 = Saturday)" };
    return { ok: true, schedule: { cadence: "weekly", hour: input.hour, minute, weekday: input.weekday } };
  }
  return { ok: true, schedule: { cadence: input.cadence, hour: input.hour, minute } };
}

/** "<taskId>:<slot ISO>": the Run.slotKey that claims a routine's slot once. */
export const slotKey = (taskId: string, slot: Date): string => `${taskId}:${slot.toISOString()}`;

/** The slot a slotKey claims (for RunRecord.scheduledFor), or null. */
export function slotOf(key: string | null | undefined): Date | null {
  if (!key) return null;
  const at = key.indexOf(":");
  if (at < 0) return null;
  const slot = new Date(key.slice(at + 1));
  return Number.isNaN(slot.getTime()) ? null : slot;
}
