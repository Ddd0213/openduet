// Test helper: a fresh SQLite database in a temp dir with every migration applied.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../../src/db.ts";

const backendDir = join(import.meta.dir, "../..");

export async function createTestDatabase(): Promise<{ db: Db; url: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "duet-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const r = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`prisma migrate deploy failed: ${r.stderr.toString()}`);
  const db = await openDatabase(url);
  return {
    db,
    url,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal valid environment for loadConfig in tests. */
export const testEnv = (overrides: Record<string, string | undefined> = {}) => ({
  PUBLIC_URL: "http://localhost:3000",
  DATABASE_URL: "file:./test.db",
  BETTER_AUTH_SECRET: "x".repeat(48),
  ...overrides,
});
