// Hash-only session storage. Better Auth creates rows only inside the sign-in request's slot.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import type { Db } from "../db.ts";
import { effectiveExpiresAt, hashedTokenPlaceholder, SessionList, sessionTokenHash } from "../contract/m28.ts";
import { log } from "../log.ts";
import type { SessionConnections } from "./connections.ts";

export const signInSession = new AsyncLocalStorage<{ token?: string; id?: string }>();

export async function findSession(db: Db, token: string, now = new Date()) {
  const row = await db.session.findUnique({ where: { tokenHash: sessionTokenHash(token) } });
  return row && effectiveExpiresAt(row) > now ? row : null;
}

/** Must finish before the listener starts: no fallback lookup by raw token exists. */
export async function convertLegacySessions(db: Db, now = new Date()) {
  const counts = await db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("PRAGMA secure_delete = ON");
    const rows = await tx.session.findMany({ where: { tokenHash: null } });
    let converted = 0, expired = 0;
    for (const row of rows) {
      const expiresAt = effectiveExpiresAt(row);
      if (expiresAt <= now) {
        await tx.session.delete({ where: { id: row.id } });
        expired++;
      } else {
        await tx.session.update({ where: { id: row.id }, data: {
          tokenHash: sessionTokenHash(row.token), token: hashedTokenPlaceholder(row.id), expiresAt,
        } });
        converted++;
      }
    }
    return { converted, expired };
  }, { timeout: 30_000 });
  try {
    const checkpoint = await db.$queryRawUnsafe<Array<{ busy: number | bigint }>>("PRAGMA wal_checkpoint(TRUNCATE)");
    if (checkpoint.some(row => Number(row.busy) !== 0)) log.warn("session conversion checkpoint busy");
  } catch (error) {
    log.warn("session conversion checkpoint failed", { error: { name: (error as Error).name } });
  }
  log.info("legacy sessions converted", counts);
  return counts;
}

type RevokeDeps = { db: Db; connections: SessionConnections };

async function deleteSessions(tx: Prisma.TransactionClient, userId: string, ids: string[], alsoUnlinkedTokens: boolean) {
  await tx.deviceToken.deleteMany({ where: { userId, OR: [
    { sessionId: { in: ids } }, ...(alsoUnlinkedTokens ? [{ sessionId: null }] : []),
  ] } });
  return tx.session.deleteMany({ where: { userId, id: { in: ids } } });
}

export async function revokeSessions(deps: RevokeDeps, userId: string, ids: string[], options = { alsoUnlinkedTokens: false }) {
  const deleted = await deps.db.$transaction(tx => deleteSessions(tx, userId, ids, options.alsoUnlinkedTokens));
  deps.connections.close(ids);
  return deleted.count;
}

/** Select and delete in the same transaction, including sessions signed in since the list loaded. */
export async function revokeOtherSessions(deps: RevokeDeps, userId: string, currentId: string) {
  const result = await deps.db.$transaction(async tx => {
    const rows = await tx.session.findMany({ where: { userId, id: { not: currentId } } });
    const ids = rows.map(row => row.id);
    const now = new Date();
    const revoked = rows.filter(row => row.tokenHash !== null && effectiveExpiresAt(row) > now).length;
    await deleteSessions(tx, userId, ids, true);
    return { ids, revoked };
  });
  deps.connections.close(result.ids);
  return result.revoked;
}

export async function listSessions(db: Db, userId: string, currentId: string, now = new Date()) {
  const rows = (await db.session.findMany({ where: { userId, expiresAt: { gt: now }, tokenHash: { not: null } } }))
    .filter(row => effectiveExpiresAt(row) > now);
  rows.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId)
    || (b.lastUsedAt?.getTime() ?? -Infinity) - (a.lastUsedAt?.getTime() ?? -Infinity)
    || b.createdAt.getTime() - a.createdAt.getTime());
  const devices = await db.deviceToken.findMany({ where: { userId, provider: "apns", sessionId: { in: rows.map(row => row.id) } }, select: { sessionId: true } });
  const push = new Set(devices.map(row => row.sessionId));
  return SessionList.parse({ sessions: rows.map(row => ({
    id: row.id, current: row.id === currentId, createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null, expiresAt: effectiveExpiresAt(row).toISOString(),
    deviceName: row.deviceName, userAgent: row.userAgent || null, signInIp: row.ipAddress,
    lastIp: row.lastIp, push: push.has(row.id),
  })) });
}
