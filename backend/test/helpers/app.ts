// Reusable in-process app with a fresh migrated SQLite database; no server or network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "../../src/agent/types.ts";
import { createApp, type RegisterRoutes } from "../../src/app.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import type { Db } from "../../src/db.ts";
import { EventBus } from "../../src/events/bus.ts";
import { FileStore } from "../../src/files/store.ts";
import { RunHost, unavailableAgent } from "../../src/runs/host.ts";
import { UsageMeter } from "../../src/usage/meter.ts";
import { createTestDatabase, testEnv } from "./db.ts";
import { SessionConnections } from "../../src/auth/connections.ts";

export interface TestAppOptions {
  /** an agent, or a factory for one that needs the test database (the real runtime) */
  agent?: AgentRuntime | ((deps: { db: Db; config: Config }) => AgentRuntime);
  /** fake clock for the usage windows */
  now?: () => Date;
  heartbeatMs?: number;
  /**
   * Builds module services on the test database (M3+: approvals, connectors, tasks). Whatever it
   * returns is passed to createApp; `runs` replaces the default RunHost, `agent` the option above.
   */
  setup?: (core: TestCore) => TestSetup | Promise<TestSetup>;
}

export interface TestCore { db: Db; config: Config; events: EventBus; usage: UsageMeter; files: FileStore; connections: SessionConnections }
export interface TestSetup { agent?: AgentRuntime; runs?: RunHost; routes?: RegisterRoutes[] }

export async function createTestApp(overrides: Record<string, string | undefined> = {}, options: TestAppOptions = {}) {
  const database = await createTestDatabase();
  const filesDir = mkdtempSync(join(tmpdir(), "duet-files-"));
  let runs: RunHost | undefined;
  const connections = new SessionConnections(database.db);
  const cleanup = async () => {
    await runs?.shutdown();
    connections.stop();
    await database.cleanup();
    rmSync(filesDir, { recursive: true, force: true });
  };
  try {
    const config = loadConfig(testEnv({ FILES_DIR: filesDir, ...overrides, DATABASE_URL: database.url }));
    const auth = createAuth(config, database.db);
    const events = new EventBus(database.db);
    const usage = new UsageMeter(database.db, config, options.now);
    const files = new FileStore(config.FILES_DIR);
    const extra = options.setup ? await options.setup({ db: database.db, config, events, usage, files, connections }) : {};
    const agent = extra.agent ?? (typeof options.agent === "function" ? options.agent({ db: database.db, config }) : options.agent);
    runs = extra.runs ?? new RunHost({ db: database.db, events, usage, files, agent: agent ?? unavailableAgent });
    const app = createApp({ config, db: database.db, auth, events, usage, files, runs, connections, heartbeatMs: options.heartbeatMs, routes: extra.routes });
    return { app, db: database.db, config, auth, events, usage, files, runs, connections, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
