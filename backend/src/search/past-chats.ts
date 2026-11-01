// FTS lives outside Prisma's database so migrations never see an unmanaged table.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Db } from "../db.ts";

const Query = z.string().trim().min(1).max(1000);
const IndexRows = z.array(z.object({ messageId: z.string() }));
export interface PastChatHit { messageId: string; channelId: string; channelName: string; text: string; createdAt: string }

export function searchDatabasePath(databaseUrl: string): string {
  const path = z.string().startsWith("file:").parse(databaseUrl).slice(5).split("?")[0]!;
  // Prisma resolves relative SQLite datasource paths against schema.prisma.
  return join(dirname(isAbsolute(path) ? path : resolve(import.meta.dir, "../../prisma", path)), "search.db");
}

export function createPastChatsSearch(db: Db, databaseUrl: string) {
  const path = searchDatabasePath(databaseUrl);
  let queue: Promise<unknown> = Promise.resolve();
  return { path, search(userId: string, query: string): Promise<PastChatHit[]> {
    const run = queue.then(() => search(userId, Query.parse(query)));
    queue = run.catch(() => {});
    return run;
  } };

  async function search(userId: string, query: string): Promise<PastChatHit[]> {
    let ids: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let index: Database | undefined;
      try {
        mkdirSync(dirname(path), { recursive: true });
        index = new Database(path, { create: true });
        index.exec("PRAGMA busy_timeout = 5000; CREATE VIRTUAL TABLE IF NOT EXISTS chats USING fts5(messageId UNINDEXED, userId UNINDEXED, channelId UNINDEXED, text, createdAt UNINDEXED, tokenize='trigram'); CREATE TABLE IF NOT EXISTS sync (id INTEGER PRIMARY KEY CHECK(id = 1), watermark TEXT NOT NULL);");
        if (index.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Invalid search index");
        const watermark = index.query<{ watermark: string }, []>("SELECT watermark FROM sync WHERE id = 1").get()?.watermark;
        const rows = await db.message.findMany({
          where: watermark ? { updatedAt: { gte: new Date(watermark) } } : {},
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          select: { id: true, userId: true, channelId: true, text: true, role: true, createdAt: true, updatedAt: true },
        });
        const remove = index.query("DELETE FROM chats WHERE messageId = ?");
        const insert = index.query("INSERT INTO chats(messageId, userId, channelId, text, createdAt) VALUES (?, ?, ?, ?, ?)");
        index.transaction(() => {
          for (const row of rows) {
            remove.run(row.id);
            if (row.role !== "system" && row.text) insert.run(row.id, row.userId, row.channelId, row.text, row.createdAt.toISOString());
          }
          const latest = rows.at(-1)?.updatedAt.toISOString();
          if (latest) index!.query("INSERT OR REPLACE INTO sync(id, watermark) VALUES (1, ?)").run(latest);
        })();
        if ([...query].length >= 3) {
          const literal = `"${query.replaceAll('"', '""')}"`;
          ids = IndexRows.parse(index.query("SELECT messageId FROM chats WHERE chats MATCH ? AND userId = ? ORDER BY createdAt DESC LIMIT 10").all(literal, userId)).map(row => row.messageId);
        }
        break;
      } catch (error) {
        if (attempt) throw error;
        index?.close(); index = undefined;
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      } finally { index?.close(); }
    }
    const short = [...query].length < 3;
    const rows = await db.message.findMany({
      where: { userId, role: { in: ["user", "assistant"] }, ...(short ? { text: { contains: query } } : { id: { in: ids } }) },
      include: { channel: { select: { name: true, isMain: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10,
    });
    return rows.map(row => ({ messageId: row.id, channelId: row.channelId, channelName: row.channel.isMain ? "main thread" : row.channel.name, text: row.text, createdAt: row.createdAt.toISOString() }));
  }
}
