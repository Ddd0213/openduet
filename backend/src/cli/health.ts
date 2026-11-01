// Container healthcheck (compose: `bun src/cli/health.ts`). Exits 0 when the database answers,
// the API answers GET /api/server-info on PORT, and, when COMPUTER_URL is set, the computer answers
// its /health. Adds no HTTP route. Prints one short line per check and never prints secrets.
import { loadConfig, type Config } from "../config.ts";
import { databaseIsHealthy, openDatabase } from "../db.ts";
import { probeComputer, type ComputerHealth } from "../computer/health.ts";

export type HealthCheck = { name: "database" | "api" | "computer"; ok: boolean; detail: string };

export type HealthDeps = {
  database: () => Promise<boolean>;
  api: () => Promise<boolean>;
  computer?: () => Promise<ComputerHealth>;
};

export async function runHealthChecks(deps: HealthDeps): Promise<HealthCheck[]> {
  const settle = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  const [database, api, computer] = await Promise.all([
    settle(deps.database, false),
    settle(deps.api, false),
    deps.computer ? settle(deps.computer, { ok: false, reason: "unreachable" } as ComputerHealth) : undefined,
  ]);
  const checks: HealthCheck[] = [
    { name: "database", ok: database, detail: database ? "ok" : "not answering" },
    { name: "api", ok: api, detail: api ? "ok" : "not answering" },
  ];
  if (computer === undefined) checks.push({ name: "computer", ok: true, detail: "not configured" });
  else if (computer.ok) checks.push({ name: "computer", ok: true, detail: computer.browser ? "ok (browser open)" : "ok" });
  else checks.push({ name: "computer", ok: false, detail: computer.status ? `${computer.reason} (${computer.status})` : computer.reason });
  return checks;
}

async function apiAnswers(port: number, timeoutMs: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}

async function databaseAnswers(config: Config): Promise<boolean> {
  const db = await openDatabase(config.DATABASE_URL);
  try { return await databaseIsHealthy(db); } finally { await db.$disconnect().catch(() => undefined); }
}

async function main(): Promise<number> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(error instanceof Error ? `${error.message}\n` : "invalid configuration\n");
    return 1;
  }
  const timeoutMs = 5_000;
  const computerUrl = config.COMPUTER_URL;
  const checks = await runHealthChecks({
    database: () => databaseAnswers(config),
    api: () => apiAnswers(config.PORT, timeoutMs),
    ...(computerUrl ? { computer: () => probeComputer(computerUrl, { timeoutMs }) } : {}),
  });
  for (const check of checks) process.stdout.write(`${check.name}: ${check.detail}\n`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
