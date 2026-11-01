// The offline eval runner (M23 W1). Runs on this Mac against a COPY of a duet.db, with a real model
// through the normal resolver and llm/ stream(), and fakes for Composio, web search / web_fetch and
// OpenDuet's computer. Not part of `bun test` or CI: it spends real tokens.
//
//   cd backend && bun evals/run.ts <suite|all> --db <path to duet.db> [--model <ModelEntry id>] [options]
//
// Suites: chips, tone, injection, honesty, soul, skill, triage (all = in that order). See README.md.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createEnv, type EvalEnv } from "./lib/env.ts";
import { EVALS_DIR } from "./lib/fixtures.ts";
import { writeResults } from "./lib/output.ts";
import type { RunOptions, Suite } from "./lib/suite.ts";
import { chips } from "./chips/suite.ts";
import { honesty } from "./honesty/suite.ts";
import { injection } from "./injection/suite.ts";
import { skill } from "./skill/suite.ts";
import { soul } from "./soul/suite.ts";
import { tone } from "./tone/suite.ts";
import { triage } from "./triage/suite.ts";
import { dashboard } from "./dashboard/suite.ts";

const SUITES: Suite[] = [chips, tone, injection, honesty, soul, skill, triage, dashboard];

const USAGE = `Usage: bun evals/run.ts <${SUITES.map((s) => s.id).join("|")}|all> --db <path to duet.db> [options]

  --db <path>          the database to copy (vault.key next to it is copied too); never written. Required.
  --model <id>         ModelEntry id to run on (default: the account's default model)
  --out <dir>          where results go (default: evals/results); one <suite>-<model>-<date>/ folder per suite
  --cases <a,b>        only these case ids (triage: email ids such as n01,c13)
  --limit <n>          at most n cases per suite
  --repeat <n>         run each case n times (default 1)
  --max-calls <n>      stop after n model calls in total (the turn past it fails; the run stops there)
  --classifier <c>     triage: current (today's check-in, default) or triage (src/proactive/triage.ts)
  --rules-only         triage with --classifier triage: the rules alone, no model
  --user <username>    the account to run as (default: the first one)
  --keep-memory        keep the account's own memory facts in the prompt (default: archived on the copy)
  --keep-db            keep the temp copy afterwards (its path is printed)

Model calls per full suite (rough): ${SUITES.map((s) => `${s.id} ${s.calls}`).join("; ")}.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function int(name: string, value: string | undefined, min: number): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number ≥ ${min}`);
  return n;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        db: { type: "string" }, model: { type: "string" }, out: { type: "string" }, cases: { type: "string" },
        limit: { type: "string" }, repeat: { type: "string" }, "max-calls": { type: "string" }, classifier: { type: "string" },
        "rules-only": { type: "boolean" }, user: { type: "string" }, "keep-memory": { type: "boolean" }, "keep-db": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail((error as Error).message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const name = positionals[0];
  if (!name || positionals.length > 1) fail("give one suite name or all");
  const suites = name === "all" ? SUITES : SUITES.filter((s) => s.id === name);
  if (!suites.length) fail(`unknown suite "${name}"`);
  if (!v.db) fail("--db is required (a copy of duet.db is made per run; the file itself is never written)");
  const classifier = v.classifier ?? "current";
  if (classifier !== "current" && classifier !== "triage") fail("--classifier is current or triage");
  const opts: RunOptions = {
    cases: v.cases ? v.cases.split(",").map((c) => c.trim()).filter(Boolean) : null,
    limit: int("limit", v.limit, 1),
    repeat: int("repeat", v.repeat, 1) ?? 1,
    classifier,
    rulesOnly: v["rules-only"] === true,
  };
  const maxCalls = int("max-calls", v["max-calls"], 1);
  const out = v.out ? resolve(v.out) : join(EVALS_DIR, "results");

  // Suites that can't run on this checkout say why and are left out (no database copy for none).
  const runnable: Suite[] = [];
  for (const suite of suites) {
    const why = await suite.skip(opts);
    if (why) process.stderr.write(`skip ${suite.id}: ${why}\n`);
    else runnable.push(suite);
  }
  if (!runnable.length) return 0;

  process.stderr.write("copying the database and building the eval world …\n");
  let env: EvalEnv;
  try {
    env = await createEnv({ db: resolve(v.db), model: v.model ?? null, user: v.user ?? null, keepMemory: v["keep-memory"] === true, keepDb: v["keep-db"] === true, maxCalls, liveDashboard: name === "dashboard" });
  } catch (error) {
    process.stderr.write(`eval setup failed: ${(error as Error).message}\n`);
    return 2;
  }
  let closing: Promise<void> | null = null;
  const close = () => (closing ??= env.close());
  process.on("SIGINT", () => { process.stderr.write("\ninterrupted: removing the database copy …\n"); void close().finally(() => process.exit(130)); });
  process.stderr.write(`model: ${env.model.label} (ModelEntry ${env.model.id}); account ${env.user.username}\n`);

  const lines: string[] = [];
  let allPass = true;
  try {
    for (const suite of runnable) {
      if (env.meter.exhausted) {
        lines.push(`${suite.id}: not run (--max-calls ${maxCalls} reached)`);
        continue;
      }
      process.stderr.write(`\n== ${suite.id}\n`);
      const startedAt = new Date().toISOString();
      const calls0 = env.meter.calls;
      const requests0 = env.meter.requests;
      const result = await suite.run(env, opts);
      const notes = [
        `account ${env.user.username}, persona ${env.persona.name}; database copy of ${resolve(v.db)}`,
        ...(opts.cases ? [`cases: ${opts.cases.join(", ")}`] : []),
        ...(opts.limit ? [`limit: ${opts.limit}`] : []),
        ...(suite.id === "triage" ? [`classifier: ${opts.classifier}${opts.rulesOnly ? " (rules only)" : ""}`] : []),
      ];
      const dir = writeResults(out, {
        suite: suite.id, model: env.model, startedAt, finishedAt: new Date().toISOString(),
        modelCalls: env.meter.calls - calls0, httpRequests: env.meter.requests - requests0, budget: maxCalls,
        stoppedByBudget: env.meter.exhausted, repeat: opts.repeat, notes,
      }, result.json, result.markdown, env.recorder.redact);
      allPass &&= result.pass;
      const line = `${result.summary} · ${env.meter.calls - calls0} model calls · ${dir}`;
      lines.push(line);
      process.stderr.write(`${line}\n`);
    }
  } finally {
    await close();
  }
  process.stdout.write(`\n${lines.join("\n")}\ntotal model calls: ${env.meter.calls}${env.meter.exhausted ? ` (stopped at --max-calls ${maxCalls})` : ""}\n`);
  return allPass ? 0 : 1;
}

process.exit(await main());
