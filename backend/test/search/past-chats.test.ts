import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { createPastChatsSearch } from "../../src/search/past-chats.ts";
import { createTestDatabase } from "../helpers/db.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let userId: string, otherUser: string, channelId: string, otherChannel: string;
beforeAll(async () => {
  database = await createTestDatabase();
  userId = "search-user"; otherUser = "other-user";
  for (const id of [userId, otherUser]) await database.db.user.create({ data: { id, name: id, username: id, authEmail: `${id}@test.invalid` } });
  channelId = (await database.db.channel.create({ data: { userId, name: "发布计划" } })).id;
  otherChannel = (await database.db.channel.create({ data: { userId: otherUser, name: "Private" } })).id;
});
afterAll(async () => { await database.cleanup(); });

describe("past chats trigram index", () => {
  test("Chinese phrase, two-character LIKE, user isolation, channel and time", async () => {
    const search = createPastChatsSearch(database.db, database.url);
    const row = await database.db.message.create({ data: { userId, channelId, role: "user", text: "明天的发布评审准备好了" } });
    await database.db.message.create({ data: { userId: otherUser, channelId: otherChannel, role: "user", text: "另一个用户的发布评审是秘密" } });
    const expected = [{ messageId: row.id, channelId, channelName: "发布计划", text: row.text, createdAt: row.createdAt.toISOString() }];
    expect(await search.search(userId, "发布评审")).toEqual(expected);
    // Remove the FTS entry; two-character queries must still use Prisma contains.
    const index = new Database(search.path); index.query("DELETE FROM chats WHERE messageId = ?").run(row.id); index.close();
    await database.db.message.update({ where: { id: row.id }, data: { updatedAt: new Date("2000-01-01") } });
    expect(await search.search(userId, "评审")).toEqual(expected);
    expect(await search.search(userId, "秘密")).toEqual([]);
  });

  test("incrementally indexes new messages and updated streaming text", async () => {
    const search = createPastChatsSearch(database.db, database.url);
    await search.search(userId, "incremental");
    const row = await database.db.message.create({ data: { userId, channelId, role: "assistant", text: "还在写" } });
    await database.db.message.update({ where: { id: row.id }, data: { text: "增量同步完成了" } });
    expect((await search.search(userId, "增量同步"))[0]?.messageId).toBe(row.id);
    await database.db.message.update({ where: { id: row.id }, data: { text: "更新内容完成了" } });
    expect(await search.search(userId, "增量同步")).toEqual([]);
    expect((await search.search(userId, "更新内容"))[0]?.messageId).toBe(row.id);
    await database.db.message.delete({ where: { id: row.id } });
    expect(await search.search(userId, "更新内容")).toEqual([]);
  });

  test("missing or corrupt index rebuilds from Prisma; maximum ten hits", async () => {
    const search = createPastChatsSearch(database.db, database.url);
    await database.db.message.createMany({ data: Array.from({ length: 14 }, (_, i) => ({ userId, channelId, role: "user", text: `索引重建消息 ${i}` })) });
    for (const corrupt of [false, true]) {
      rmSync(search.path, { force: true });
      if (corrupt) writeFileSync(search.path, "not a SQLite database");
      const hits = await search.search(userId, "索引重建");
      expect(hits).toHaveLength(10); expect(hits.every(hit => hit.channelId === channelId)).toBe(true);
    }
  });
});
