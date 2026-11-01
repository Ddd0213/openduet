// When a scheduled artifact refresh is due (L151): the latest slot of its schedule at or before
// now, in the user's timezone, reusing M4's slot math (src/scheduler/slots.ts).
import { safeZone, slotsBetween } from "../scheduler/slots.ts";
import type { RefreshSchedule } from "./serialize.ts";

const HOUR_MS = 3_600_000;
/** Longer than the longest gap between two slots (a weekend for "weekdays"). */
const LOOKBACK_MS = 4 * 24 * HOUR_MS;

/** The latest slot <= now, or null if there is none in the lookback window. */
export function latestSlot(schedule: RefreshSchedule, timeZone: string, now: Date): Date | null {
  const zone = safeZone(timeZone);
  const from = new Date(now.getTime() - (schedule.cadence === "hourly" ? 2 * HOUR_MS : LOOKBACK_MS));
  // slotsBetween is (from, to]; nudge `to` so a slot exactly at now counts.
  const to = new Date(now.getTime() + 1);
  const times = schedule.cadence === "hourly"
    ? Array.from({ length: 24 }, (_, hour) => ({ hour, minute: schedule.minute }))
    : [{ hour: schedule.hour, minute: schedule.minute }];
  const slots = slotsBetween({ timeZone: zone, times, weekendsOn: schedule.cadence !== "weekdays" }, from, to).filter((s) => s.getTime() <= now.getTime());
  return slots.at(-1) ?? null;
}
