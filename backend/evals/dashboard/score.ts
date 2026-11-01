import type { ToolEvent } from "../score/types.ts";
import { EXPECTED, BATCHES } from "./fixtures.ts";

export interface DashboardFacts {
  buildRuns: number; savedUpdates: number; calls: Pick<ToolEvent, "name">[];
  before: { html: string; pageUpdatedAt: string } | null;
  after: { html: string; pageUpdatedAt: string; dataVersion: number; data: unknown } | null;
}
export function scoreDashboard(facts: DashboardFacts) {
  const data = facts.after?.data as { total?: unknown; categories?: { name: string; count: number }[]; recent?: unknown[] } | null;
  const checks = [
    { name: "exactly one build run", pass: facts.buildRuns === 1, actual: facts.buildRuns },
    { name: "at least 3 saved update_artifact_data calls", pass: facts.savedUpdates >= 3, actual: facts.savedUpdates },
    { name: "no refresh_artifact or edit_artifact", pass: !facts.calls.some(c => ["refresh_artifact", "edit_artifact"].includes(c.name)), actual: facts.calls.filter(c => ["refresh_artifact", "edit_artifact"].includes(c.name)).map(c => c.name) },
    { name: "stored HTML unchanged after task", pass: !!facts.before && !!facts.after && facts.after.html === facts.before.html, actual: !!facts.before && !!facts.after && facts.after.html === facts.before.html },
    { name: "final total matches all batches", pass: data?.total === EXPECTED.total, actual: data?.total ?? null },
    { name: "category counts match", pass: Array.isArray(data?.categories) && data.categories.length === 3 && Object.entries(EXPECTED.categories).every(([name, count]) => data.categories!.filter(c => c.name === name && c.count === count).length === 1), actual: data?.categories ?? null },
    { name: "dataVersion >= 4", pass: (facts.after?.dataVersion ?? 0) >= 4, actual: facts.after?.dataVersion ?? null },
    { name: "latest 5 match the last batch", pass: Array.isArray(data?.recent) && data.recent.length === 5 && BATCHES.at(-1)!.slice(-5).every((expected, i) => { const item = data.recent![i] as Record<string, unknown> | null; return item !== null && typeof item === "object" && Object.entries(expected).every(([key, value]) => item[key] === value); }), actual: data?.recent ?? null },
    { name: "pageUpdatedAt unchanged", pass: !!facts.before && !!facts.after && facts.after.pageUpdatedAt === facts.before.pageUpdatedAt, actual: facts.after?.pageUpdatedAt ?? null },
  ];
  return { pass: checks.every(c => c.pass), checks };
}
