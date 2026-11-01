// Prisma client over SQLite in WAL mode, so scripts/backup.sh can take a consistent snapshot
// while the app writes. The app uses one connection: queries queue in the pool instead of
// several connections fighting over SQLite's single write lock inside the process.
import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

/**
 * DATABASE_URL with connection_limit=1 unless it already sets one. Prisma's default pool is
 * 2 x CPUs + 1 connections; on a small server or CI runner a transaction and a concurrent write
 * then wait on each other's lock until both time out (P2028 / P1008). One connection also keeps
 * the PRAGMAs below on every query.
 */
export function sqliteUrl(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

export async function openDatabase(url: string): Promise<Db> {
  const db = new PrismaClient({ datasourceUrl: sqliteUrl(url) });
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
