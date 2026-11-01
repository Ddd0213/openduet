// The Usage panel (M9, contract §5): token totals from Run rows over a range, by model and by
// kind, plus a series of hour / day / month buckets in the user's timezone (oldest first).
// Every run counts the same way (input + output tokens); runs without tokens are left out.
import type { z } from "zod";
import type { UsageRange as UsageRangeSchema, UsageStats } from "../contract/account.ts";
import type { Db } from "../db.ts";
import { addDays, localDate, safeZone, zonedInstant, type LocalDate } from "../scheduler/slots.ts";

/**
 * A model id's display label and provider (models.json); null when the config doesn't know it.
 * M12: `providerId` is the run's (a ModelProvider.id for models set up in the app).
 */
export type ModelLabels = (modelId: string, providerId?: string | null) => { label: string; provider: string } | null;
export type UsageRange = z.infer<typeof UsageRangeSchema>;

type Kind = UsageStats["byKind"][number]["kind"];
const KIND: Record<string, Kind> = { chat: "chat", task: "task", build: "build", brief: "proactive", checkin: "proactive", scan: "proactive", routine: "proactive" };
const KIND_ORDER: readonly Kind[] = ["chat", "task", "build", "proactive"];
/** byModel key for runs whose row has no model (e.g. a provider that never reported one) */
export const UNKNOWN_MODEL = "unknown";

const MIDNIGHT = { hour: 0, minute: 0 };
const HOUR = 60 * 60_000;

interface Counted { createdAt: Date; kind: string; model: string | null; providerId: string | null; inputTokens: number; outputTokens: number; tokensEstimated: boolean }

const startOfDay = (date: LocalDate, zone: string) => zonedInstant(date, MIDNIGHT, zone);
const startOfMonth = (year: number, month: number, zone: string) => {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return zonedInstant({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 }, MIDNIGHT, zone);
};

/** Bucket starts from `first` up to `now` (oldest first), by the range's bucket size. */
function bucketStarts(range: UsageRange, now: Date, zone: string, first: Date | null): Date[] {
  const today = localDate(now, zone);
  if (range === "today") {
    // Absolute hours from local midnight: a DST day has 23 or 25 of them.
    const starts: Date[] = [];
    for (let at = startOfDay(today, zone).getTime(); at <= now.getTime(); at += HOUR) starts.push(new Date(at));
    return starts;
  }
  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    return Array.from({ length: days }, (_, i) => startOfDay(addDays(today, i - (days - 1)), zone));
  }
  if (!first) return [];
  const from = localDate(first, zone);
  const starts: Date[] = [];
  for (let year = from.year, month = from.month; year < today.year || (year === today.year && month <= today.month); month === 12 ? (year++, month = 1) : month++) {
    starts.push(startOfMonth(year, month, zone));
  }
  return starts;
}

/** The index of the last bucket starting at or before `at` (buckets are sorted ascending). */
function bucketOf(starts: readonly Date[], at: Date): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]!.getTime() <= at.getTime()) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The range's first instant (local midnight today / 6 or 29 days ago), or null for all time. */
export function rangeStart(range: UsageRange, now: Date, timeZone: string): Date | null {
  const zone = safeZone(timeZone);
  const today = localDate(now, zone);
  if (range === "today") return startOfDay(today, zone);
  if (range === "7d") return startOfDay(addDays(today, -6), zone);
  if (range === "30d") return startOfDay(addDays(today, -29), zone);
  return null;
}

/** Pure: the stats of already-loaded runs (only those inside the range are expected). */
export function summarizeUsage(rows: readonly Counted[], opts: { range: UsageRange; now: Date; timeZone: string; labels: ModelLabels }): UsageStats {
  const zone = safeZone(opts.timeZone);
  const since = rangeStart(opts.range, opts.now, zone);
  const counted = rows.filter((r) => r.inputTokens + r.outputTokens > 0);
  const first = counted.reduce<Date | null>((min, r) => (!min || r.createdAt < min ? r.createdAt : min), null);
  const starts = bucketStarts(opts.range, opts.now, zone, first);
  const series = starts.map((start) => ({ start: start.toISOString(), inputTokens: 0, outputTokens: 0 }));

  const totals = { inputTokens: 0, outputTokens: 0, runs: 0 };
  const models = new Map<string, { model: string; label: string; provider: string | null; inputTokens: number; outputTokens: number; runs: number }>();
  const kinds = new Map<Kind, { kind: Kind; inputTokens: number; outputTokens: number; runs: number }>();
  let estimated = false;
  for (const row of counted) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.runs += 1;
    estimated ||= row.tokensEstimated;

    const id = row.model ?? UNKNOWN_MODEL;
    const known = row.model ? opts.labels(row.model, row.providerId) : null;
    const entry = models.get(id) ?? { model: id, label: known?.label ?? id, provider: row.providerId ?? known?.provider ?? null, inputTokens: 0, outputTokens: 0, runs: 0 };
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    entry.runs += 1;
    models.set(id, entry);

    const kind = KIND[row.kind] ?? "proactive";
    const group = kinds.get(kind) ?? { kind, inputTokens: 0, outputTokens: 0, runs: 0 };
    group.inputTokens += row.inputTokens;
    group.outputTokens += row.outputTokens;
    group.runs += 1;
    kinds.set(kind, group);

    if (series.length > 0) {
      const bucket = series[bucketOf(starts, row.createdAt)]!;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
    }
  }
  const tokens = (m: { inputTokens: number; outputTokens: number }) => m.inputTokens + m.outputTokens;
  return {
    range: opts.range,
    since: since?.toISOString() ?? null,
    until: opts.now.toISOString(),
    totals,
    estimated,
    byModel: [...models.values()].sort((a, b) => tokens(b) - tokens(a) || a.model.localeCompare(b.model)),
    byKind: KIND_ORDER.flatMap((kind) => (kinds.has(kind) ? [kinds.get(kind)!] : [])),
    bucket: opts.range === "today" ? "hour" : opts.range === "all" ? "month" : "day",
    series,
  };
}

/** Loads the user's runs in the range (createdAt in [since, now]) and summarizes them. */
export async function usageStats(db: Db, user: { id: string; timezone: string }, range: UsageRange, now: Date, labels: ModelLabels): Promise<UsageStats> {
  const since = rangeStart(range, now, user.timezone);
  const rows = await db.run.findMany({
    where: {
      userId: user.id,
      createdAt: { ...(since ? { gte: since } : {}), lte: now },
      OR: [{ inputTokens: { gt: 0 } }, { outputTokens: { gt: 0 } }],
    },
    select: { createdAt: true, kind: true, model: true, providerId: true, inputTokens: true, outputTokens: true, tokensEstimated: true },
  });
  return summarizeUsage(rows, { range, now, timeZone: user.timezone, labels: await withEntryLabels(db, user.id, rows, labels) });
}

/**
 * M12: the user's own ModelEntry labels first (by modelId and the run's provider, else by modelId
 * alone), then `fallback` (the legacy models.json labels).
 */
async function withEntryLabels(db: Db, userId: string, rows: readonly { model: string | null }[], fallback: ModelLabels): Promise<ModelLabels> {
  const ids = [...new Set(rows.flatMap((r) => (r.model ? [r.model] : [])))];
  const entries = ids.length ? await db.modelEntry.findMany({ where: { userId, modelId: { in: ids } }, select: { modelId: true, providerId: true, label: true } }) : [];
  if (!entries.length) return fallback;
  return (modelId, providerId) => {
    const hit = entries.find((e) => e.modelId === modelId && e.providerId === providerId) ?? entries.find((e) => e.modelId === modelId);
    return hit ? { label: hit.label, provider: hit.providerId } : fallback(modelId, providerId);
  };
}
