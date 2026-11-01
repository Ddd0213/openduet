// What every suite shares: its cases (JSON next to it, checked with zod), a clean account before
// each case, the call cap, and one progress line per case on stderr (never a secret: ids, pass /
// fail and call counts only).
import { z } from "zod";
import type { TurnRecord } from "../score/types.ts";
import type { EvalEnv } from "./env.ts";
import { calendar, inbox, readJson, type MailFixture } from "./fixtures.ts";

export interface RunOptions {
  /** only these case ids (comma list on the command line) */
  cases: string[] | null;
  /** at most this many cases (after --cases) */
  limit: number | null;
  /** each case this many times */
  repeat: number;
  /** triage only: which classifier */
  classifier: "current" | "triage";
  /** triage only: the rules alone, no model */
  rulesOnly: boolean;
}

export interface SuiteResult {
  /** the suite's own numbers and every row (results.json) */
  json: Record<string, unknown>;
  /** the readable report (results.md, after the header) */
  markdown: string;
  /** one line for the console */
  summary: string;
  pass: boolean;
  /** set when the suite didn't run at all (a tool or module that doesn't exist yet) */
  skipped?: string;
}

export interface Suite {
  id: string;
  /** model calls a full run takes, roughly (README) */
  calls: string;
  /** why it can't run on this checkout with these options (null: it can) */
  skip(opts: RunOptions): Promise<string | null>;
  run(env: EvalEnv, opts: RunOptions): Promise<SuiteResult>;
}

/** A suite's cases from <suite>/cases.json, filtered and limited. */
export function loadCases<T extends { id: string }>(suite: string, schema: z.ZodType<T>, opts: Pick<RunOptions, "cases" | "limit">): T[] {
  const all = readJson(`${suite}/cases.json`, z.array(schema)) as T[];
  const picked = opts.cases ? all.filter((c) => opts.cases!.includes(c.id)) : all;
  return opts.limit !== null ? picked.slice(0, opts.limit) : picked;
}

export interface CaseRun<T, R> { case: T; repeat: number; row: R; turns: TurnRecord[] }

/**
 * Runs `each` for every case (× repeat) on a clean account, stops once the call cap is reached,
 * and prints "suite case pass|FAIL calls" per case (`note` instead, e.g. "undecided", when set).
 */
export async function eachCase<T extends { id: string }, R extends { pass: boolean; note?: string }>(
  env: EvalEnv, suite: string, cases: readonly T[], opts: Pick<RunOptions, "repeat">,
  each: (c: T, repeat: number) => Promise<{ row: R; turns: TurnRecord[] }>,
): Promise<CaseRun<T, R>[]> {
  const out: CaseRun<T, R>[] = [];
  for (let r = 1; r <= opts.repeat; r++) {
    for (const c of cases) {
      if (env.meter.exhausted) return out;
      await env.tidy();
      const before = env.meter.calls;
      const { row, turns } = await each(c, r);
      out.push({ case: c, repeat: r, row, turns });
      const spent = env.meter.calls - before;
      process.stderr.write(`  ${suite} ${c.id}${opts.repeat > 1 ? ` #${r}` : ""}: ${row.note ?? (row.pass ? "pass" : "FAIL")} (${spent} model calls, ${env.meter.calls} total)\n`);
    }
  }
  return out;
}

/** The base inbox and calendar (fixtures/), plus extra mail for this case, newest first. */
export function useFixtures(env: EvalEnv, extra: MailFixture[] = [], opts: { inbox?: boolean; calendar?: boolean } = {}): void {
  env.composio.mailbox = [...extra, ...(opts.inbox === false ? [] : inbox())];
  env.composio.events = opts.calendar === false ? [] : calendar();
}

/** Turns stored in results.json: the timeline's text and tool calls, what was shown, what the fakes saw. */
export const transcript = (turns: readonly TurnRecord[]) => turns.map((t) => ({
  kind: t.kind, userText: t.userText, status: t.status, error: t.error, modelCalls: t.modelCalls, ms: t.ms,
  timeline: t.timeline, shown: t.shown.map((m) => ({ role: m.role, kind: m.kind, text: m.text, payload: m.payload })),
  apps: t.apps, web: t.web, computer: t.computer,
}));

/** "pass" / "FAIL" for tables. */
export const mark = (ok: boolean | null): string => (ok === null ? "–" : ok ? "pass" : "FAIL");

/** Failed / timed-out turns, to list under a table (a failure of the run, not of the model's behaviour). */
export function turnProblems(runs: readonly CaseRun<{ id: string }, unknown>[]): string[] {
  return runs.flatMap((r) => r.turns.filter((t) => t.status !== "completed").map((t) => `${r.case.id}: turn ${t.status}${t.error ? ` (${t.error})` : ""}`));
}

/** The markdown section listing turnProblems (none: nothing). */
export function problemLines(runs: readonly CaseRun<{ id: string }, unknown>[]): string[] {
  const list = turnProblems(runs);
  return list.length ? ["", "## Turns that didn't complete", "", ...list.map((p) => `- ${p}`)] : [];
}
