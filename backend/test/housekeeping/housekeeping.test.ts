// Hourly cleanup: the Event log keeps the newest MAX_REPLAY per user and the last 7 days;
// unsent uploads older than 24 h lose their row and bytes, sent and fresh ones stay.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Housekeeping } from "../../src/housekeeping/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;
const now = new Date("2026-10-25T09:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  fixture = await createTestApp();
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const housekeeping = (keepEvents?: number) => new Housekeeping({ db: fixture.db, files: fixture.files, now: () => now, keepEvents });
const addEvents = (userId: string, count: number, at: Date) =>
  fixture.db.event.createMany({ data: Array.from({ length: count }, () => ({ userId, type: "typing", payload: "{}", createdAt: at })) });

describe("event log", () => {
  test("keeps the newest N per user and everything from the last 7 days", async () => {
    await fixture.db.event.deleteMany();
    await addEvents(alex.userId, 5, new Date(now.getTime() - 10 * day));
    await addEvents(alex.userId, 2, new Date(now.getTime() - 1 * day));
    await addEvents(sam.userId, 3, new Date(now.getTime() - 30 * day));
    // keep 3: alex's 2 recent + the newest old one; sam's 3 (all old) stay as the newest 3.
    expect((await housekeeping(3).tick()).events).toBe(4);
    expect(await fixture.db.event.count({ where: { userId: alex.userId } })).toBe(3);
    expect(await fixture.db.event.count({ where: { userId: sam.userId } })).toBe(3);
    // keep 1: recent events still stay because they're within 7 days.
    expect((await housekeeping(1).tick()).events).toBe(3);
    const left = await fixture.db.event.findMany({ where: { userId: alex.userId } });
    expect(left).toHaveLength(2);
    expect(left.every((e) => e.createdAt.getTime() > now.getTime() - 7 * day)).toBe(true);
    expect(await fixture.db.event.count({ where: { userId: sam.userId } })).toBe(1);
  });

  test("with the default MAX_REPLAY nothing recent-enough is touched", async () => {
    expect((await housekeeping().tick()).events).toBe(0);
  });
});

describe("unsent uploads", () => {
  test("removes unsent uploads older than 24 h with their bytes; sent, fresh and Claude's files stay", async () => {
    const file = async (age: number, messageId: string | null, source = "user") => {
      const path = await fixture.files.save(alex.userId, "text/plain", new TextEncoder().encode("hello"));
      const row = await fixture.db.channelFile.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, messageId, path, name: "a.txt", mime: "text/plain", size: 5, source, createdAt: new Date(now.getTime() - age) } });
      return { row, full: join(fixture.files.root, path) };
    };
    const message = await fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "user", kind: "text", text: "see attached" } });
    const stale = await file(25 * 60 * 60 * 1000, null);
    const sent = await file(3 * day, message.id);
    const fresh = await file(60 * 60 * 1000, null);
    const assistantFile = await file(3 * day, null, "assistant");
    expect((await housekeeping().tick()).uploads).toBe(1);
    expect(await fixture.db.channelFile.findUnique({ where: { id: stale.row.id } })).toBeNull();
    expect(existsSync(stale.full)).toBe(false);
    for (const kept of [sent, fresh, assistantFile]) {
      expect(await fixture.db.channelFile.findUnique({ where: { id: kept.row.id } })).not.toBeNull();
      expect(existsSync(kept.full)).toBe(true);
    }
  });

  test("start() runs a pass and stop() waits for it", async () => {
    const service = housekeeping();
    service.start();
    await service.stop();
    expect(await service.tick()).toEqual({ events: 0, uploads: 0, convertedSessions: 0, legacyExpiredSessions: 0,
      expiredSessions: 0, expiredDeviceTokens: 0, orphanDeviceTokens: 0 });
  });
});
