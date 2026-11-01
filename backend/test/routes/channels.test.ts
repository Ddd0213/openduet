// Channels and the paged thread: list, edit, read marker, pagination, someone else's channel,
// and X-Timezone / X-Locale keeping the profile in sync (L165).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Channel, ChannelList } from "../../src/contract/channels.ts";
import { MessagePage } from "../../src/contract/messages.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp();
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const json = (method: string, body: unknown, who = alex) => ({ method, headers: { ...who.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const page = async (query: string) => {
  const response = await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages${query}`, { headers: alex.headers });
  expect(response.status).toBe(200);
  return MessagePage.parse(await response.json());
};
const assistantLine = (text: string, createdAt: Date) =>
  fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "assistant", kind: "text", text, createdAt } });

describe("channels", () => {
  test("lists the main thread first", async () => {
    const response = await fixture.app.request("/api/channels", { headers: alex.headers });
    const { channels } = ChannelList.parse(await response.json());
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: alex.mainChannelId, isMain: true, unreadCount: 0, archived: false });
  });

  test("X-Timezone and X-Locale update the profile", async () => {
    await fixture.app.request("/api/channels", { headers: { ...alex.headers, "X-Timezone": "Asia/Shanghai", "X-Locale": "zh-Hans" } });
    expect(await fixture.db.user.findUniqueOrThrow({ where: { id: alex.userId } })).toMatchObject({ timezone: "Asia/Shanghai", language: "zh-Hans" });
    await fixture.app.request("/api/channels", { headers: { ...alex.headers, "X-Timezone": "Not/AZone", "X-Locale": "fr" } });
    expect(await fixture.db.user.findUniqueOrThrow({ where: { id: alex.userId } })).toMatchObject({ timezone: "Asia/Shanghai", language: "zh-Hans" });
  });

  test("the main thread can't be renamed or archived; other fields can change", async () => {
    const rename = await fixture.app.request(`/api/channels/${alex.mainChannelId}`, json("PATCH", { name: "Main" }));
    expect(rename.status).toBe(400);
    expect((await errorOf(rename)).field).toBe("name");
    const purpose = await fixture.app.request(`/api/channels/${alex.mainChannelId}`, json("PATCH", { purpose: "Everything" }));
    expect(purpose.status).toBe(200);
    expect(Channel.parse(await purpose.json()).purpose).toBe("Everything");
  });

  test("the read marker drives unread counts and only moves forward", async () => {
    const t0 = new Date(Date.now() - 60_000);
    const t1 = new Date(Date.now() - 30_000);
    await assistantLine("first", t0);
    await assistantLine("second", t1);
    const unread = async () => ChannelList.parse(await (await fixture.app.request("/api/channels", { headers: alex.headers })).json()).channels[0]!.unreadCount;
    expect(await unread()).toBe(2);
    expect((await fixture.app.request(`/api/channels/${alex.mainChannelId}/read`, json("POST", { at: t0.toISOString() }))).status).toBe(204);
    expect(await unread()).toBe(1);
    await fixture.app.request(`/api/channels/${alex.mainChannelId}/read`, json("POST", { at: new Date(t0.getTime() - 1000).toISOString() }));
    expect(await unread()).toBe(1);
    await fixture.app.request(`/api/channels/${alex.mainChannelId}/read`, json("POST", { at: new Date().toISOString() }));
    expect(await unread()).toBe(0);
  });

  test("M21: mark read by messageId uses that message's own time; `at` alone gets 1 ms of tolerance (the .601 case)", async () => {
    await fixture.db.message.deleteMany({ where: { channelId: alex.mainChannelId } });
    await fixture.db.channel.update({ where: { id: alex.mainChannelId }, data: { lastReadAt: null } });
    const unread = async () => ChannelList.parse(await (await fixture.app.request("/api/channels", { headers: alex.headers })).json()).channels[0]!.unreadCount;
    const read = (body: unknown) => fixture.app.request(`/api/channels/${alex.mainChannelId}/read`, json("POST", body));
    const base = Date.now() - 120_000;
    await assistantLine("a choice", new Date(base + 600));
    const last = await assistantLine("the quick replies", new Date(base + 601));
    expect(await unread()).toBe(2);
    // An older app sends the newest line's time with its last millisecond lost (.600 for .601).
    expect((await read({ at: new Date(base + 600).toISOString() })).status).toBe(204);
    expect(await unread()).toBe(0);
    // messageId: the marker is the message's own createdAt, whatever the app's clock or encoding.
    const later = await assistantLine("later", new Date(base + 5_000));
    expect(await unread()).toBe(1);
    expect((await read({ messageId: later.id, at: new Date(base).toISOString() })).status).toBe(204);
    expect(await unread()).toBe(0);
    const row = await fixture.db.channel.findUniqueOrThrow({ where: { id: alex.mainChannelId } });
    expect(row.lastReadAt?.getTime()).toBe(base + 5_000);
    // It still only moves forward, and only for this channel's own thread.
    expect((await read({ messageId: last.id })).status).toBe(204);
    expect((await fixture.db.channel.findUniqueOrThrow({ where: { id: alex.mainChannelId } })).lastReadAt?.getTime()).toBe(base + 5_000);
    const unknown = await read({ messageId: "msg_nope" });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).field).toBe("messageId");
    expect((await read({})).status).toBe(400);
  });

  test("pages go oldest-first within a page, older pages via ?before, with a correct hasMore", async () => {
    await fixture.db.message.deleteMany({ where: { channelId: alex.mainChannelId } });
    const base = Date.now() - 1_000_000;
    // Pairs share a timestamp so the id tie-break is exercised.
    for (let i = 0; i < 120; i++) await assistantLine(`m${i}`, new Date(base + Math.floor(i / 2) * 1000));
    const newest = await page("");
    expect(newest.messages).toHaveLength(50);
    expect(newest.hasMore).toBe(true);
    expect(newest.messages.at(-1)!.text).toBe("m119");
    const middle = await page(`?before=${newest.messages[0]!.id}`);
    const oldest = await page(`?before=${middle.messages[0]!.id}`);
    expect(middle.hasMore).toBe(true);
    expect(oldest.messages).toHaveLength(20);
    expect(oldest.hasMore).toBe(false);
    const all = [...oldest.messages, ...middle.messages, ...newest.messages];
    expect(new Set(all.map((m) => m.id)).size).toBe(120);
    const times = all.map((m) => m.createdAt);
    expect(times).toEqual([...times].sort());
    expect((await page("?limit=5")).messages).toHaveLength(5);
    const bad = await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages?limit=0`, { headers: alex.headers });
    expect(bad.status).toBe(400);
  });

  test("someone else's channel is 404 everywhere", async () => {
    const id = sam.mainChannelId;
    expect((await fixture.app.request(`/api/channels/${id}/messages`, { headers: alex.headers })).status).toBe(404);
    expect((await fixture.app.request(`/api/channels/${id}/files`, { headers: alex.headers })).status).toBe(404);
    expect((await fixture.app.request(`/api/channels/${id}`, json("PATCH", { purpose: "x" }))).status).toBe(404);
    expect((await fixture.app.request(`/api/channels/${id}/read`, json("POST", { at: new Date().toISOString() }))).status).toBe(404);
    expect((await fixture.app.request("/api/channels/does-not-exist/messages", { headers: alex.headers })).status).toBe(404);
  });
});
