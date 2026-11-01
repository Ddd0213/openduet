// Loads and checks the JSON fixtures (zod), and turns their relative times ("50 minutes ago",
// "tomorrow 10:00") into real timestamps for this run, in the user's time zone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const EVALS_DIR = join(import.meta.dir, "..");

export const Lang = z.enum(["en", "zh-Hans"]);
export type Lang = z.infer<typeof Lang>;

export const Persona = z.object({
  name: z.string(),
  firstName: z.object({ en: z.string(), "zh-Hans": z.string() }),
  email: z.string(),
  about: z.string(),
  companyDomain: z.string(),
});
export type Persona = z.infer<typeof Persona>;

export const MailFixture = z.object({
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  subject: z.string(),
  minutesAgo: z.number().nonnegative(),
  headers: z.record(z.string(), z.string()).default({}),
  labels: z.array(z.string()).default(["INBOX"]),
  body: z.string(),
});
export type MailFixture = z.infer<typeof MailFixture>;

export const EventFixture = z.object({
  id: z.string(),
  title: z.string(),
  /** days from today (0 = today) */
  day: z.number().int(),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  location: z.string().optional(),
  attendees: z.array(z.string()).default([]),
});
export type EventFixture = z.infer<typeof EventFixture>;

export function readJson<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T> {
  return schema.parse(JSON.parse(readFileSync(join(EVALS_DIR, path), "utf8")));
}

export function readJsonl<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T>[] {
  return readFileSync(join(EVALS_DIR, path), "utf8").split("\n").filter((line) => line.trim()).map((line) => schema.parse(JSON.parse(line)));
}

export const persona = (): Persona => readJson("fixtures/persona.json", Persona);
export const inbox = (): MailFixture[] => readJson("fixtures/inbox.json", z.array(MailFixture));
export const calendar = (): EventFixture[] => readJson("fixtures/calendar.json", z.array(EventFixture));

/** The zone's offset from UTC at `at`, in minutes (Asia/Shanghai: 480). */
export function offsetMinutes(timeZone: string, at: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** ISO 8601 with the zone's offset ("2026-10-29T14:00:00+08:00"). */
export function zonedIso(timeZone: string, at: Date): string {
  const offset = offsetMinutes(timeZone, at);
  const local = new Date(at.getTime() + offset * 60_000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${local.toISOString().slice(0, 19)}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The instant of "day + HH:MM" in the zone (day 0 = today there). */
export function zonedAt(timeZone: string, now: Date, day: number, time: string): Date {
  const offset = offsetMinutes(timeZone, now);
  const local = new Date(now.getTime() + offset * 60_000);
  const [h, m] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, h, m);
  return new Date(wall - offset * 60_000);
}
