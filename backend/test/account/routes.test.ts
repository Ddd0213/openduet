// Account routes (M4-B): PATCH /api/me, POST /api/channels with Claude's hello, feedback,
// memory and push devices, mounted through the setup hook like the main agent will.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerAccountRoutes } from "../../src/account/routes.ts";
import { MemoryState, RegisterDeviceResponse } from "../../src/contract/account.ts";
import { Me } from "../../src/contract/auth.ts";
import { Channel } from "../../src/contract/channels.ts";
import { ApiError } from "../../src/contract/common.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { MessagePage } from "../../src/contract/messages.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({}, { setup: () => ({ routes: [registerAccountRoutes()] }) });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const json = (method: string, body: unknown, who = alex) => ({ method, headers: { ...who.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const recorded = (userId: string) => {
  const seen: DuetEvent[] = [];
  const stop = fixture.events.subscribe(userId, (event) => seen.push(event));
  return { seen, stop };
};
const thread = async (channelId: string, who = alex) =>
  MessagePage.parse(await (await fixture.app.request(`/api/channels/${channelId}/messages`, { headers: who.headers })).json()).messages;

describe("PATCH /api/me", () => {
  test("updates first name, brief time and weekends and returns Me", async () => {
    const response = await fixture.app.request("/api/me", json("PATCH", { firstName: "Al", briefTime: { hour: 7, minute: 5 }, weekendsOn: true }));
    expect(response.status).toBe(200);
    const me = Me.parse(await response.json());
    expect(me).toMatchObject({ firstName: "Al", briefTime: { hour: 7, minute: 5 }, weekendsOn: true, mainChannelId: alex.mainChannelId });
    expect((await fixture.db.user.findUniqueOrThrow({ where: { id: alex.userId } })).briefTime).toBe("07:05");
  });

  test("a partial update keeps the other fields; bad input is 400 with the field", async () => {
    const me = Me.parse(await (await fixture.app.request("/api/me", json("PATCH", { weekendsOn: false }))).json());
    expect(me).toMatchObject({ firstName: "Al", briefTime: { hour: 7, minute: 5 }, weekendsOn: false });
    const bad = await fixture.app.request("/api/me", json("PATCH", { briefTime: { hour: 24, minute: 0 } }));
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).field).toBe("briefTime.hour");
    const unknown = await fixture.app.request("/api/me", json("PATCH", { email: "x@example.com" }));
    expect(unknown.status).toBe(400);
  });

  test("needs a session", async () => {
    const response = await fixture.app.request("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
  });
});

describe("POST /api/channels", () => {
  // M11: the greeting is Claude's own background chat turn (test/channels covers its prompt and
  // quick replies with a scripted model); this app has no agent, so only the queued run shows.
  test("creates the channel and queues Claude's greeting as a chat turn there", async () => {
    const { seen, stop } = recorded(alex.userId);
    const response = await fixture.app.request("/api/channels", json("POST", { name: "Q4 planning", icon: "chart", colorHex: "#6290C2", purpose: "Planning" }));
    stop();
    expect(response.status).toBe(200);
    const channel = Channel.parse(await response.json());
    expect(channel).toMatchObject({ isMain: false, name: "Q4 planning", icon: "chart", colorHex: "#6290C2", purpose: "Planning", archived: false, soulExtra: "", useSharedMemory: true });
    expect(seen[0]?.type).toBe("channel");
    const runs = await fixture.db.run.findMany({ where: { userId: alex.userId, channelId: channel.id } });
    expect(runs.map((r) => [r.kind, r.taskId])).toEqual([["chat", null]]);
    await fixture.runs.idle();
    // No server-written hello: nothing but what the (unavailable) model turn left.
    expect((await thread(channel.id)).some((m) => m.role === "assistant" && m.kind === "quick_replies")).toBe(false);
  });

  test("greet: false queues nothing", async () => {
    const response = await fixture.app.request("/api/channels", { ...json("POST", { name: "旅行", icon: "plane", colorHex: "#5D927A", greet: false }, sam), headers: { ...sam.headers, "Content-Type": "application/json" } });
    const channel = Channel.parse(await response.json());
    expect(await fixture.db.run.count({ where: { channelId: channel.id } })).toBe(0);
    expect(await thread(channel.id, sam)).toEqual([]);
  });

  test("validates name, icon and colour", async () => {
    for (const body of [{ name: " ", icon: "chart", colorHex: "#6290C2" }, { name: "x", icon: "rocket", colorHex: "#6290C2" }, { name: "x", icon: "chart", colorHex: "#000000" }]) {
      expect((await fixture.app.request("/api/channels", json("POST", body))).status).toBe(400);
    }
  });
});

describe("POST /api/feedback", () => {
  test("stores the rating and thanks in the rated message's thread", async () => {
    const rated = await fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "assistant", kind: "text", text: "answer" } });
    const response = await fixture.app.request("/api/feedback", json("POST", { messageId: rated.id, rating: "good" }));
    expect(response.status).toBe(204);
    expect(await fixture.db.feedback.findFirst({ where: { userId: alex.userId, messageId: rated.id } })).toMatchObject({ rating: "good", text: "" });
    const last = (await thread(alex.mainChannelId)).at(-1)!;
    expect(last).toMatchObject({ role: "system", kind: "system", payload: { phrase: { key: "system.feedback_thanks" } } });
  });

  test("profile feedback without a message goes to the main thread", async () => {
    expect((await fixture.app.request("/api/feedback", json("POST", { text: "Love it" }))).status).toBe(204);
    expect(await fixture.db.feedback.findFirst({ where: { userId: alex.userId, text: "Love it" } })).toMatchObject({ messageId: null, rating: null });
  });

  test("someone else's message is 404; an empty body is 400", async () => {
    const theirs = await fixture.db.message.create({ data: { userId: sam.userId, channelId: sam.mainChannelId, role: "assistant", kind: "text", text: "x" } });
    expect((await fixture.app.request("/api/feedback", json("POST", { messageId: theirs.id, rating: "bad" }))).status).toBe(404);
    expect((await fixture.app.request("/api/feedback", json("POST", {}))).status).toBe(400);
  });
});

describe("memory", () => {
  test("empty, then the edited document and Claude's facts newest first", async () => {
    const empty = MemoryState.parse(await (await fixture.app.request("/api/memory", { headers: sam.headers })).json());
    expect(empty).toEqual({ document: "", facts: [], updatedAt: null });
    await fixture.db.memory.create({ data: { userId: sam.userId, kind: "fact", text: "older", createdAt: new Date(Date.now() - 60_000) } });
    await fixture.db.memory.create({ data: { userId: sam.userId, kind: "fact", text: "newer" } });
    const put = await fixture.app.request("/api/memory", json("PUT", { document: "Prefers mornings." }, sam));
    expect(put.status).toBe(200);
    const state = MemoryState.parse(await put.json());
    expect(state.document).toBe("Prefers mornings.");
    expect(state.facts.map((f) => f.text)).toEqual(["newer", "older"]);
    expect(state.updatedAt).not.toBeNull();
    await fixture.app.request("/api/memory", json("PUT", { document: "Edited." }, sam));
    expect(await fixture.db.memory.count({ where: { userId: sam.userId, kind: "document" } })).toBe(1);
    expect(MemoryState.parse(await (await fixture.app.request("/api/memory", { headers: alex.headers })).json()).document).toBe("");
  });
});

describe("devices", () => {
  const token = "ab".repeat(32);
  test("re-registers only your own token; sign-out deletion permits a new owner", async () => {
    const first = RegisterDeviceResponse.parse(await (await fixture.app.request("/api/devices", json("POST", { provider: "apns", token, environment: "sandbox", locale: "en" }))).json());
    const again = RegisterDeviceResponse.parse(await (await fixture.app.request("/api/devices", json("POST", { provider: "apns", token: token.toUpperCase(), environment: "production", locale: "zh-Hans" }))).json());
    expect(again.deviceId).toBe(first.deviceId);
    expect(await fixture.db.deviceToken.findUniqueOrThrow({ where: { id: first.deviceId } })).toMatchObject({ userId: alex.userId, environment: "production", locale: "zh-Hans", token });
    const refused = await fixture.app.request("/api/devices", json("POST", { provider: "apns", token, environment: "sandbox", locale: "en" }, sam));
    expect(refused.status).toBe(404);
    expect(ApiError.parse(await refused.json()).error.code).toBe("not_found");
    expect(await fixture.db.deviceToken.findUniqueOrThrow({ where: { id: first.deviceId } })).toMatchObject({ userId: alex.userId, environment: "production", locale: "zh-Hans" });
    expect((await fixture.app.request(`/api/devices/${first.deviceId}`, { method: "DELETE", headers: sam.headers })).status).toBe(404);
    expect((await fixture.app.request(`/api/devices/${first.deviceId}`, { method: "DELETE", headers: alex.headers })).status).toBe(204);
    const moved = RegisterDeviceResponse.parse(await (await fixture.app.request("/api/devices", json("POST", { provider: "apns", token, environment: "production", locale: "en" }, sam))).json());
    expect(moved.deviceId).not.toBe(first.deviceId);
    expect((await fixture.app.request(`/api/devices/${moved.deviceId}`, { method: "DELETE", headers: sam.headers })).status).toBe(204);
    expect(await fixture.db.deviceToken.count()).toBe(0);
  });

  test("rejects a malformed token", async () => {
    expect((await fixture.app.request("/api/devices", json("POST", { provider: "apns", token: "not-hex", environment: "production", locale: "en" }))).status).toBe(400);
  });
});
