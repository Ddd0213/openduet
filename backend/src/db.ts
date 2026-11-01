// Prisma client over SQLite in WAL mode, so background tasks, SSE and the scheduler can
// write while others read, and scripts/backup.sh can take a consistent snapshot.
import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

export async function openDatabase(url: string): Promise<Db> {
  const db = new PrismaClient({ datasourceUrl: url });
  // PRAGMAs return rows, so they go through $queryRawUnsafe.
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
  await db.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
  await db.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
  return db;
}

/** True when the database answers (used by the container healthcheck). */
export async function databaseIsHealthy(db: Db): Promise<boolean> {
  try {
    await db.$queryRawUnsafe("SELECT 1;");
    return true;
  } catch {
    return false;
  }
}
