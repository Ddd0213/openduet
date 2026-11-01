// M29 tools on demand (agent/loading.ts), read from the run records:
//  - recentTools: the tools the runs of this history window used or loaded, newest first. They stay
//    loaded while that conversation is in context, so a follow-up ("change the title") needs no
//    load round;
//  - frequentTools: how often the user called each of some tools in the last 30 days, for a
//    connector named in the message (its most-used tools come preloaded; never a guess).
// Tool names only: no arguments or results leave here (load_tools' own record names tools).
import type { Db } from "../db.ts";
import type { WindowRun } from "./takeover.ts";

const LOAD_TOOLS = "load_tools";
/** Steps read for the window's tool names (newest first). */
const RECENT_TAKE = 400;
/** load_tools steps read (their record names what they loaded). */
const LOAD_TAKE = 40;
const FREQUENT_DAYS = 30;
const FREQUENT_TAKE = 2_000;

function namesOf(raw: string | null, keys: readonly string[]): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return keys.flatMap((key) => {
      const list = (value as Record<string, unknown>)[key];
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item.length <= 128) : [];
    });
  } catch {
    return [];
  }
}

/**
 * The tool names the window's runs used, and the ones their load_tools calls loaded (from the
 * result; from the request when the result can't be read), newest first, without repeats. The
 * caller keeps the ones its turn still offers.
 */
export async function recentTools(db: Db, runs: readonly WindowRun[]): Promise<string[]> {
  const runIds = runs.map((run) => run.id);
  if (!runIds.length) return [];
  const [used, loads] = await Promise.all([
    db.runStep.findMany({
      where: { runId: { in: runIds }, kind: "tool", tool: { not: null } },
      orderBy: [{ startedAt: "desc" }, { index: "desc" }],
      take: RECENT_TAKE,
      select: { tool: true, startedAt: true },
    }),
    db.runStep.findMany({
      where: { runId: { in: runIds }, kind: "tool", tool: LOAD_TOOLS },
      orderBy: [{ startedAt: "desc" }, { index: "desc" }],
      take: LOAD_TAKE,
      select: { input: true, output: true, startedAt: true },
    }),
  ]);
  const loadsAt = loads.map((step) => {
    const answered = namesOf(step.output, ["loaded", "alreadyAvailable"]);
    return { at: step.startedAt.getTime(), names: answered.length ? answered : namesOf(step.input, ["tools"]) };
  });
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string) => { if (name !== LOAD_TOOLS && !seen.has(name)) { seen.add(name); out.push(name); } };
  let next = 0;
  for (const step of used) {
    const at = step.startedAt.getTime();
    // a load_tools step's names go where the step itself sits (newest first)
    while (next < loadsAt.length && loadsAt[next]!.at >= at) loadsAt[next++]!.names.forEach(push);
    push(step.tool!);
  }
  while (next < loadsAt.length) loadsAt[next++]!.names.forEach(push);
  return out;
}

/** `candidates` the user called in the last 30 days, most calls first (ties: the candidates' order). */
export async function frequentTools(db: Db, userId: string, candidates: readonly string[], now: Date): Promise<string[]> {
  if (!candidates.length) return [];
  const since = new Date(now.getTime() - FREQUENT_DAYS * 24 * 60 * 60_000);
  const steps = await db.runStep.findMany({
    where: { kind: "tool", tool: { in: [...candidates] }, run: { userId, createdAt: { gte: since } } },
    orderBy: { startedAt: "desc" },
    take: FREQUENT_TAKE,
    select: { tool: true },
  });
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.tool!, (counts.get(step.tool!) ?? 0) + 1);
  return candidates.filter((name) => counts.has(name)).sort((a, b) => counts.get(b)! - counts.get(a)!);
}
