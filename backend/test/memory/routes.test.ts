// M11-A memory routes: a channel's own memory (GET / PUT /api/channels/:id/memory), the user's
// facts (POST / PATCH / DELETE /api/memory/facts), the overview (GET /api/memory/overview) and
// "About you" (GET /api/memory) leaving out archived facts and channels' own memories.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemoryState } from "../../src/contract/account.ts";
import { ChannelMemoryState, MemoryFactResponse, MemoryOverview } from "../../src/contract/m11.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { channelOf, json, startMemoryApp, type MemoryApp } from "./harness.ts";

let m: MemoryApp;
let sam: SignedIn;
beforeAll(async () => {
  m = await startMemoryApp();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
});
afterAll(() => m.fixture.cleanup());

const request = (path: string, init?: RequestInit) => m.fixture.app.request(path, init);
const get = (path: string, user: SignedIn = m.alex) => request(path, { headers: user.headers });
const anonymous = (path: string, method = "GET", body?: unknown) =>
  request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const fact = (data: { userId: string; channelId: string | null; text: string; archivedAt?: Date; createdAt?: Date }) =>
  m.fixture.db.memory.create({ data: { kind: "fact", source: "assistant", ...data } });

describe("a channel's own memory", () => {
  test("GET: empty at first, with the channel's useSharedMemory", async () => {
    const solo = await channelOf(m, m.alex, { name: "Solo", useSharedMemory: false });
    const response = await get(`/api/channels/${solo.id}/memory`);
    expect(response.status).toBe(200);
    expect(ChannelMemoryState.parse(await response.json())).toEqual({ channelId: solo.id, useSharedMemory: false, document: "", facts: [], updatedAt: null });
  });

  test("PUT replaces the document (one row); GET has its active facts newest first, never another layer's", async () => {
    const shop = await channelOf(m, m.alex, { name: "Shop" });
    const other = await channelOf(m, m.alex, { name: "Other" });
    const first = await fact({ userId: m.alex.userId, channelId: shop.id, text: "Ships on Mondays", createdAt: new Date("2026-01-01T10:00:00Z") });
    const second = await fact({ userId: m.alex.userId, channelId: shop.id, text: "Supplier is Bolt Ltd", createdAt: new Date("2026-01-02T10:00:00Z") });
    await fact({ userId: m.alex.userId, channelId: shop.id, text: "old", archivedAt: new Date() });
    await fact({ userId: m.alex.userId, channelId: other.id, text: "Other channel's" });
    await fact({ userId: m.alex.userId, channelId: null, text: "About you fact" });

    for (const document of ["# Shop\nv1", "# Shop\nv2"]) {
      const put = await request(`/api/channels/${shop.id}/memory`, json(m.alex, "PUT", { document }));
      expect(put.status).toBe(200);
      expect(ChannelMemoryState.parse(await put.json()).document).toBe(document);
    }
    const state = ChannelMemoryState.parse(await (await get(`/api/channels/${shop.id}/memory`)).json());
    expect(state).toMatchObject({ channelId: shop.id, useSharedMemory: true, document: "# Shop\nv2" });
    expect(state.facts.map((f) => f.id)).toEqual([second.id, first.id]);
    expect(state.facts[0]).toEqual({ id: second.id, text: "Supplier is Bolt Ltd", source: "assistant", sourceMessageId: null, sourceRef: null, createdAt: "2026-01-02T10:00:00.000Z" });
    expect(state.updatedAt).not.toBeNull();
    expect(await m.fixture.db.memory.count({ where: { userId: m.alex.userId, channelId: shop.id, kind: "document" } })).toBe(1);
    // "About you" is untouched by a channel's PUT.
    expect(MemoryState.parse(await (await get("/api/memory")).json()).document).toBe("");
  });

  test("the main thread is 400 (field id); someone else's channel or an unknown id is 404; no session is 401; bad body 400", async () => {
    const main = await get(`/api/channels/${m.alex.mainChannelId}/memory`);
    expect(main.status).toBe(400);
    expect(await errorOf(main)).toMatchObject({ code: "validation_failed", field: "id" });
    expect((await request(`/api/channels/${m.alex.mainChannelId}/memory`, json(m.alex, "PUT", { document: "x" }))).status).toBe(400);

    const mine = await channelOf(m, m.alex, { name: "Private" });
    await request(`/api/channels/${mine.id}/memory`, json(m.alex, "PUT", { document: "secret plan" }));
    expect((await get(`/api/channels/${mine.id}/memory`, sam)).status).toBe(404);
    expect((await request(`/api/channels/${mine.id}/memory`, json(sam, "PUT", { document: "overwritten" }))).status).toBe(404);
    expect(ChannelMemoryState.parse(await (await get(`/api/channels/${mine.id}/memory`)).json()).document).toBe("secret plan");
    expect((await get("/api/channels/nope/memory")).status).toBe(404);

    expect((await anonymous(`/api/channels/${mine.id}/memory`)).status).toBe(401);
    expect((await anonymous(`/api/channels/${mine.id}/memory`, "PUT", { document: "x" })).status).toBe(401);
    expect((await request(`/api/channels/${mine.id}/memory`, json(m.alex, "PUT", { document: 5 }))).status).toBe(400);
    expect((await request(`/api/channels/${mine.id}/memory`, json(m.alex, "PUT", { document: "x", extra: 1 }))).status).toBe(400);
  });
});

describe("the user's facts", () => {
  test("POST: \"About you\" (channelId null) or a channel's own memory; source user, no source message, text trimmed", async () => {
    const shared = await request("/api/memory/facts", json(m.alex, "POST", { channelId: null, text: "  Vegetarian  " }));
    expect(shared.status).toBe(200);
    const sharedFact = MemoryFactResponse.parse(await shared.json()).fact;
    expect(sharedFact).toMatchObject({ text: "Vegetarian", source: "user", sourceMessageId: null });
    expect(await m.fixture.db.memory.findUniqueOrThrow({ where: { id: sharedFact.id } })).toMatchObject({ userId: m.alex.userId, channelId: null, kind: "fact", source: "user" });
    expect(MemoryState.parse(await (await get("/api/memory")).json()).facts.map((f) => f.id)).toContain(sharedFact.id);

    const garden = await channelOf(m, m.alex, { name: "Garden" });
    const own = MemoryFactResponse.parse(await (await request("/api/memory/facts", json(m.alex, "POST", { channelId: garden.id, text: "Tomatoes in bed 2" }))).json()).fact;
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: own.id } })).channelId).toBe(garden.id);
    expect(ChannelMemoryState.parse(await (await get(`/api/channels/${garden.id}/memory`)).json()).facts.map((f) => f.id)).toEqual([own.id]);
    expect(MemoryState.parse(await (await get("/api/memory")).json()).facts.map((f) => f.id)).not.toContain(own.id);
  });

  test("POST: someone else's channel 404; the main thread's id 400 (field channelId); bad bodies 400; no session 401", async () => {
    const before = await m.fixture.db.memory.count();
    const theirs = await channelOf(m, sam, { name: "Sam's" });
    expect((await request("/api/memory/facts", json(m.alex, "POST", { channelId: theirs.id, text: "x" }))).status).toBe(404);
    const main = await request("/api/memory/facts", json(m.alex, "POST", { channelId: m.alex.mainChannelId, text: "x" }));
    expect(main.status).toBe(400);
    expect((await errorOf(main)).field).toBe("channelId");
    for (const body of [{ channelId: null, text: "   " }, { channelId: null, text: "x".repeat(2001) }, { text: "no channelId" }, { channelId: null, text: "x", source: "dreaming" }]) {
      expect((await request("/api/memory/facts", json(m.alex, "POST", body))).status).toBe(400);
    }
    expect((await anonymous("/api/memory/facts", "POST", { channelId: null, text: "x" })).status).toBe(401);
    expect(await m.fixture.db.memory.count()).toBe(before);
  });

  test("PATCH edits an active fact's text, keeping its source; archived, unknown or someone else's is 404", async () => {
    const row = await m.fixture.db.memory.create({ data: { userId: m.alex.userId, channelId: null, kind: "fact", text: "Has two cats", source: "assistant", sourceMessageId: "msg_1" } });
    const response = await request(`/api/memory/facts/${row.id}`, json(m.alex, "PATCH", { text: " Has three cats " }));
    expect(response.status).toBe(200);
    expect(MemoryFactResponse.parse(await response.json()).fact).toMatchObject({ id: row.id, text: "Has three cats", source: "assistant", sourceMessageId: "msg_1" });

    const archived = await fact({ userId: m.alex.userId, channelId: null, text: "gone", archivedAt: new Date() });
    expect((await request(`/api/memory/facts/${archived.id}`, json(m.alex, "PATCH", { text: "back" }))).status).toBe(404);
    expect((await request(`/api/memory/facts/${row.id}`, json(sam, "PATCH", { text: "Sam was here" }))).status).toBe(404);
    expect((await request("/api/memory/facts/nope", json(m.alex, "PATCH", { text: "x" }))).status).toBe(404);
    const document = await m.fixture.db.memory.create({ data: { userId: m.alex.userId, channelId: null, kind: "document", text: "doc" } });
    expect((await request(`/api/memory/facts/${document.id}`, json(m.alex, "PATCH", { text: "x" }))).status).toBe(404);
    await m.fixture.db.memory.delete({ where: { id: document.id } });
    expect((await request(`/api/memory/facts/${row.id}`, json(m.alex, "PATCH", { text: "" }))).status).toBe(400);
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: row.id } })).text).toBe("Has three cats");
  });

  test("DELETE archives (204, the row stays for undo); again is 204 and keeps the time; someone else's 404", async () => {
    const row = await fact({ userId: m.alex.userId, channelId: null, text: "Night owl" });
    expect((await request(`/api/memory/facts/${row.id}`, json(sam, "DELETE"))).status).toBe(404);
    const response = await request(`/api/memory/facts/${row.id}`, json(m.alex, "DELETE"));
    expect(response.status).toBe(204);
    const archivedAt = (await m.fixture.db.memory.findUniqueOrThrow({ where: { id: row.id } })).archivedAt;
    expect(archivedAt).not.toBeNull();
    expect(MemoryState.parse(await (await get("/api/memory")).json()).facts.map((f) => f.id)).not.toContain(row.id);
    expect((await request(`/api/memory/facts/${row.id}`, json(m.alex, "DELETE"))).status).toBe(204);
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: row.id } })).archivedAt).toEqual(archivedAt);
    expect((await request("/api/memory/facts/nope", json(m.alex, "DELETE"))).status).toBe(404);
    expect((await anonymous(`/api/memory/facts/${row.id}`, "DELETE")).status).toBe(401);
  });
});

describe("GET /api/memory/overview", () => {
  test("every non-main, non-archived channel oldest first: purpose, active fact count, last message, Claude's latest reply; never memory text", async () => {
    const olive = await signUp(m.fixture, "olive", "Olive Park");
    const db = m.fixture.db;
    const at = (iso: string) => new Date(iso);
    const trips = await db.channel.create({ data: { userId: olive.userId, name: "Trips", purpose: "Plan holidays", createdAt: at("2026-01-01T00:00:00Z") } });
    const quiet = await db.channel.create({ data: { userId: olive.userId, name: "Quiet", purpose: "", useSharedMemory: false, createdAt: at("2026-01-02T00:00:00Z") } });
    await db.channel.create({ data: { userId: olive.userId, name: "Old", archived: true, createdAt: at("2026-01-03T00:00:00Z") } });
    await fact({ userId: olive.userId, channelId: trips.id, text: "PRIVATE: passport expires in May" });
    await fact({ userId: olive.userId, channelId: trips.id, text: "PRIVATE: window seat" });
    await fact({ userId: olive.userId, channelId: trips.id, text: "archived", archivedAt: new Date() });
    await fact({ userId: olive.userId, channelId: null, text: "shared" });
    await db.memory.create({ data: { userId: olive.userId, channelId: trips.id, kind: "document", text: "PRIVATE document" } });
    const message = (data: { channelId: string; role: string; text: string; createdAt: Date; kind?: string }) => db.message.create({ data: { userId: olive.userId, ...data } });
    await message({ channelId: trips.id, role: "assistant", text: "**Lisbon** is booked for [June](https://example.com).", createdAt: at("2026-02-01T09:00:00Z") });
    await message({ channelId: trips.id, role: "user", text: "Thanks", createdAt: at("2026-02-01T09:05:00Z") });
    await message({ channelId: trips.id, role: "assistant", kind: "quick_replies", text: "Pick one", createdAt: at("2026-02-01T09:06:00Z") });

    const response = await get("/api/memory/overview", olive);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(MemoryOverview.parse(body).channels).toEqual([
      { channelId: trips.id, name: "Trips", purpose: "Plan holidays", useSharedMemory: true, factCount: 2, lastMessageAt: "2026-02-01T09:06:00.000Z", recent: "Lisbon is booked for June." },
      { channelId: quiet.id, name: "Quiet", purpose: "", useSharedMemory: false, factCount: 0, lastMessageAt: null, recent: null },
    ]);
    expect(MemoryOverview.parse(await (await get("/api/memory/overview", sam)).json()).channels.map((c) => c.channelId)).not.toContain(trips.id);
    expect((await anonymous("/api/memory/overview")).status).toBe(401);
  });

  test("M15: a voice call's messages (callId set) count for the last message and the latest reply", async () => {
    const quinn = await signUp(m.fixture, "quinn", "Quinn Ash");
    const db = m.fixture.db;
    const at = (iso: string) => new Date(iso);
    const plans = await db.channel.create({ data: { userId: quinn.userId, name: "Plans" } });
    await db.message.create({ data: { userId: quinn.userId, channelId: plans.id, role: "assistant", text: "The visible reply.", createdAt: at("2026-03-01T09:00:00Z") } });
    await db.message.create({ data: { userId: quinn.userId, channelId: plans.id, role: "user", text: "handed over on a call", callId: "call_1", createdAt: at("2026-03-01T10:00:00Z") } });
    await db.message.create({ data: { userId: quinn.userId, channelId: plans.id, role: "assistant", text: "Reply on the call.", callId: "call_1", createdAt: at("2026-03-01T10:01:00Z") } });

    const channels = MemoryOverview.parse(await (await get("/api/memory/overview", quinn)).json()).channels;
    expect(channels).toEqual([
      { channelId: plans.id, name: "Plans", purpose: "", useSharedMemory: true, factCount: 0, lastMessageAt: "2026-03-01T10:01:00.000Z", recent: "Reply on the call." },
    ]);
  });

  test("GET /api/memory leaves out archived facts and channels' own memories", async () => {
    const pia = await signUp(m.fixture, "pia", "Pia Ng");
    const work = await channelOf(m, pia, { name: "Work" });
    const kept = await fact({ userId: pia.userId, channelId: null, text: "Kept" });
    await fact({ userId: pia.userId, channelId: null, text: "Archived", archivedAt: new Date() });
    await fact({ userId: pia.userId, channelId: work.id, text: "Work only" });
    await m.fixture.db.memory.create({ data: { userId: pia.userId, channelId: work.id, kind: "document", text: "Work doc" } });
    const state = MemoryState.parse(await (await get("/api/memory", pia)).json());
    expect(state.document).toBe("");
    expect(state.facts.map((f) => f.text)).toEqual(["Kept"]);
    expect(state.facts[0]?.id).toBe(kept.id);
  });
});
