// M13: voice settings, Features.voice, starting / resuming a call (which model, the credential per
// engine, the 409 for a second open call), Cache-Control: no-store, and the StepFun key only in the
// owner's POST /api/calls answer (never in logs, events, Run / RunStep / AuditLog / Message rows).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GEMINI_LIVE_URL, GEMINI_TOKEN_URL } from "../../src/calls/credentials.ts";
import { VOICE_TOOLS } from "../../src/calls/voices.ts";
import { StartCallResponse, VoiceSettings } from "../../src/contract/m13.ts";
import { Me } from "../../src/contract/auth.ts";
import { captureOutput } from "../channels/harness.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { channel, chatModel, GEMINI_KEY, line, realtimeModel, req, settle, startCallsApp, STEP_KEY, stopCallsApp, text, type CallsApp } from "./harness.ts";

let t: CallsApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startCallsApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => stopCallsApp(t));

/** Ends every open call of the user (each test starts clean). */
async function hangUp(user: SignedIn) {
  for (const c of await t.fixture.db.call.findMany({ where: { userId: user.userId, status: "open" } })) {
    expect((await req(t, user, "POST", `/api/calls/${c.id}/end`, { seconds: 1 })).status).toBe(200);
  }
}

describe("voice settings and Features.voice", () => {
  test("nothing set up: configured false, voice false; a realtime model makes both true", async () => {
    const u = await signUp(t.fixture, "vera", "Vera Ng");
    const before = await req(t, u, "GET", "/api/voice-settings");
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(VoiceSettings.parse(before.body)).toMatchObject({ modelId: null, voice: null, configured: false });
    expect(before.body.voices.gemini[0]).toBe("Puck");
    expect(before.body.voices.stepfun).toEqual(["qingchunshaonv", "wenrounansheng", "linjiajiejie"]);
    expect(Me.parse((await req(t, u, "GET", "/api/me")).body).features.voice).toBe(false);

    // A key-less provider or a failed one doesn't count.
    await realtimeModel(t, u, "gemini", { key: null });
    await realtimeModel(t, u, "stepfun", { status: "failed" });
    expect((await req(t, u, "GET", "/api/voice-settings")).body.configured).toBe(false);
    expect((await req(t, u, "GET", "/api/me")).body.features.voice).toBe(false);

    const step = await realtimeModel(t, u, "stepfun");
    expect((await req(t, u, "GET", "/api/voice-settings")).body.configured).toBe(true);
    expect((await req(t, u, "GET", "/api/me")).body.features.voice).toBe(true);

    const put = await req(t, u, "PUT", "/api/voice-settings", { modelId: step.entryId, voice: "linjiajiejie" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ modelId: step.entryId, voice: "linjiajiejie", configured: true });
  });

  test("PUT checks the model (a realtime entry of a gemini / stepfun provider) and the voice (its engine's)", async () => {
    const u = await signUp(t.fixture, "vic", "Vic Ho");
    const gem = await realtimeModel(t, u, "gemini");
    const chat = await chatModel(t, u);
    const bad = await req(t, u, "PUT", "/api/voice-settings", { modelId: chat });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "validation_failed", field: "modelId" });
    const other = await realtimeModel(t, sam, "gemini");
    expect((await req(t, u, "PUT", "/api/voice-settings", { modelId: other.entryId })).status).toBe(400);
    const wrongVoice = await req(t, u, "PUT", "/api/voice-settings", { modelId: gem.entryId, voice: "qingchunshaonv" });
    expect(wrongVoice.status).toBe(400);
    expect(wrongVoice.body.error).toMatchObject({ code: "validation_failed", field: "voice" });
    expect((await req(t, u, "PUT", "/api/voice-settings", { voice: "Nobody" })).status).toBe(400);
    expect((await req(t, u, "PUT", "/api/voice-settings", { modelId: gem.entryId, voice: "Kore" })).body).toMatchObject({ modelId: gem.entryId, voice: "Kore" });
    // A stepfun model drops the gemini voice.
    const step = await realtimeModel(t, u, "stepfun");
    expect((await req(t, u, "PUT", "/api/voice-settings", { modelId: step.entryId })).body).toMatchObject({ modelId: step.entryId, voice: null });
    expect((await req(t, u, "PUT", "/api/voice-settings", { modelId: null })).body).toMatchObject({ modelId: null, configured: true });
  });
});

describe("starting a call", () => {
  test("no usable realtime model: 400 not_configured; logged out 401; another user's channel 404", async () => {
    const u = await signUp(t.fixture, "nora", "Nora Li");
    const none = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("not_configured");
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect((await req(t, null, "POST", "/api/calls", { channelId: u.mainChannelId })).status).toBe(401);
    await realtimeModel(t, u, "stepfun");
    expect((await req(t, u, "POST", "/api/calls", { channelId: sam.mainChannelId })).status).toBe(404);
  });

  test("gemini: a one-use token minted with the vault key; the key itself never in the answer", async () => {
    const gem = await realtimeModel(t, t.alex, "gemini");
    const before = t.google.mints.length;
    const res = await req(t, t.alex, "POST", "/api/calls", { channelId: t.alex.mainChannelId, language: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = StartCallResponse.parse(res.body);
    expect(t.google.mints.length).toBe(before + 1);
    const mint = t.google.mints.at(-1)!;
    expect(mint.url).toBe(GEMINI_TOKEN_URL);
    expect(mint.headers.get("x-goog-api-key")).toBe(GEMINI_KEY);
    expect(mint.body.uses).toBe(1);
    const now = t.clock.now;
    expect(Date.parse(String(mint.body.expireTime))).toBe(now + 30 * 60_000);
    expect(Date.parse(String(mint.body.newSessionExpireTime))).toBe(now + 60_000);
    expect(body.credential).toEqual({ kind: "token", value: "auth_tokens/test-token-1", expiresAt: new Date(now + 30 * 60_000).toISOString() });
    expect(body.url).toBe(GEMINI_LIVE_URL);
    expect(body.model).toBe(gem.modelId);
    expect(body.call).toMatchObject({ engine: "gemini", modelEntryId: gem.entryId, voice: "Puck", status: "open", seconds: 0, title: "" });
    expect(body.tools).toEqual(VOICE_TOOLS);
    expect(body.tools.map((x) => x.name)).toEqual(["send_to_assistant", "assistant_status", "stop_assistant", "search_memory"]);
    expect(body.instructions).toContain("You are OpenDuet's voice on a live voice call.");
    expect(body.instructions).toContain("never approve");
    expect(res.text).not.toContain(GEMINI_KEY);
    await hangUp(t.alex);
  });

  test("a failed mint is 400 with the reason, and leaves no call open", async () => {
    const u = await signUp(t.fixture, "gil", "Gil Ra");
    await realtimeModel(t, u, "gemini");
    t.google.status = 403;
    try {
      const res = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("not_configured");
      expect(res.body.error.message).toContain("403");
      expect(res.text).not.toContain(GEMINI_KEY);
      expect(await t.fixture.db.call.count({ where: { userId: u.userId } })).toBe(0);
    } finally {
      t.google.status = 200;
    }
  });

  test("which model: the request's, else the settings', else the first usable; voice request -> settings -> default", async () => {
    const u = await signUp(t.fixture, "ola", "Ola Ek");
    const first = await realtimeModel(t, u, "gemini");
    const step = await realtimeModel(t, u, "stepfun");
    let res = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(res.body.call.modelEntryId).toBe(first.entryId);
    await hangUp(u);
    await req(t, u, "PUT", "/api/voice-settings", { modelId: step.entryId, voice: "wenrounansheng" });
    res = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(res.body.call).toMatchObject({ modelEntryId: step.entryId, engine: "stepfun", voice: "wenrounansheng" });
    await hangUp(u);
    res = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, modelId: first.entryId, voice: "Kore" });
    expect(res.body.call).toMatchObject({ modelEntryId: first.entryId, voice: "Kore" });
    await hangUp(u);
    const wrong = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, modelId: first.entryId, voice: "linjiajiejie" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.field).toBe("voice");
    // A deleted settings model falls back to the first usable one.
    await t.fixture.db.modelEntry.delete({ where: { id: step.entryId } });
    res = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(res.body.call.modelEntryId).toBe(first.entryId);
    await hangUp(u);
    const notRealtime = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, modelId: "nope" });
    expect(notRealtime.status).toBe(400);
    expect(notRealtime.body.error.field).toBe("modelId");
  });

  test("an open call on another channel: 409 conflict; resume with callId adds \"This call so far\"", async () => {
    const u = await signUp(t.fixture, "pat", "Pat Yu");
    await realtimeModel(t, u, "gemini");
    const shop = await channel(t, u, "Shop");
    const first = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(first.status).toBe(200);
    const id = first.body.call.id as string;
    expect(first.body.instructions).not.toContain("This call so far");
    const conflict = await req(t, u, "POST", "/api/calls", { channelId: shop });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("conflict");

    await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line("l1", "user", "Order brake pads please"), line("l2", "voice", "Passing that to Claude now.", "2026-11-02T18:00:06.000Z")] });
    const mints = t.google.mints.length;
    const again = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, callId: id });
    expect(again.status).toBe(200);
    expect(again.body.call.id).toBe(id);
    expect(t.google.mints.length).toBe(mints + 1);
    expect(again.body.instructions).toContain("This call so far");
    expect(again.body.instructions).toContain("User: Order brake pads please");
    expect(again.body.instructions).toContain("You: Passing that to Claude now.");
    expect((await req(t, u, "POST", "/api/calls", { channelId: shop, callId: id })).status).toBe(400);
    expect((await req(t, sam, "POST", "/api/calls", { channelId: sam.mainChannelId, callId: id })).status).toBe(404);

    // Without callId in the same chat: the forgotten call ends, a new one starts.
    const fresh = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(fresh.status).toBe(200);
    expect(fresh.body.call.id).not.toBe(id);
    expect((await t.fixture.db.call.findUniqueOrThrow({ where: { id } })).status).toBe("ended");
    expect((await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, callId: id })).status).toBe(409);
    await hangUp(u);
  });

  test("instructions: language, the soul, About you only when the channel reads it, the channel's own memory, recent messages; capped", async () => {
    const u = await signUp(t.fixture, "quin", "Quin Bo");
    await realtimeModel(t, u, "gemini");
    const db = t.fixture.db;
    await db.soul.create({ data: { userId: u.userId, name: "Duet", addressAs: "Q" } });
    const own = await channel(t, u, "Garden", { useSharedMemory: false, purpose: "The allotment" });
    const other = await channel(t, u, "Taxes");
    await db.memory.create({ data: { userId: u.userId, channelId: null, kind: "fact", text: "SHARED lives in Leeds" } });
    await db.memory.create({ data: { userId: u.userId, channelId: own, kind: "fact", text: "OWN tomatoes in bed 3" } });
    await db.memory.create({ data: { userId: u.userId, channelId: other, kind: "fact", text: "OTHER private tax id" } });
    await db.message.create({ data: { userId: u.userId, channelId: own, role: "user", kind: "text", text: "What's planted?", payload: "{}", status: "seen" } });
    await db.message.create({ data: { userId: u.userId, channelId: own, role: "assistant", kind: "text", text: "**Tomatoes** and beans.", payload: "{}", status: "sent" } });
    const res = await req(t, u, "POST", "/api/calls", { channelId: own, language: "zh-Hans" });
    const ins = res.body.instructions as string;
    expect(ins).toContain("Chinese");
    expect(ins).toContain("the language the user is speaking right now");
    expect(ins).toContain("\"Duet\"");
    expect(ins).toContain("\"Q\"");
    expect(ins).toContain("OWN tomatoes in bed 3");
    expect(ins).toContain("The allotment");
    expect(ins).not.toContain("SHARED lives in Leeds");
    expect(ins).not.toContain("OTHER private tax id");
    expect(ins).toContain("User: What's planted?");
    expect(ins).toContain("OpenDuet: Tomatoes and beans.");
    expect(ins.length).toBeLessThan(20_000);
    await hangUp(u);
    // The main thread reads About you.
    await db.memory.create({ data: { userId: u.userId, channelId: null, kind: "document", text: "x".repeat(50_000) } });
    const main = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
    expect(main.body.instructions).toContain("About you");
    expect(main.body.instructions.length).toBeLessThan(20_000);
    await hangUp(u);
  });
});

describe("the StepFun key", () => {
  test("only in its owner's POST /api/calls answer: never in logs, events, Run / RunStep / AuditLog / Message rows", async () => {
    const u = await signUp(t.fixture, "ria", "Ria Os");
    await chatModel(t, u);
    const step = await realtimeModel(t, u, "stepfun");
    const out = captureOutput();
    let start;
    try {
      start = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
      expect(start.status).toBe(200);
      expect(start.body.credential).toEqual({ kind: "key", value: STEP_KEY });
      expect(start.body.url).toBe(`wss://api.stepfun.com/v1/realtime?model=${step.modelId}`);
      expect(start.headers.get("cache-control")).toBe("no-store");
      const id = start.body.call.id as string;
      // Another user can't reach the call; logged out is 401.
      expect((await req(t, sam, "GET", `/api/calls/${id}`)).status).toBe(404);
      expect((await req(t, sam, "POST", `/api/calls/${id}/tool`, { name: "assistant_status" })).status).toBe(404);
      expect((await req(t, null, "GET", `/api/calls/${id}`)).status).toBe(401);
      // A hand-off turn, the detail and the end.
      t.scripts.push([text(`Done. ${"x".repeat(10)}`)], [text("Brake pads")]);
      const tool = await req(t, u, "POST", `/api/calls/${id}/tool`, { name: "send_to_assistant", arguments: { text: "Order brake pads" }, lines: [line("a", "user", "brake pads please")] });
      expect(tool.body.result).toBe("Sent to OpenDuet.");
      await settle(t);
      const detail = await req(t, u, "GET", `/api/calls/${id}`);
      expect(detail.headers.get("cache-control")).toBe("no-store");
      const end = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 30 });
      expect(end.status).toBe(200);
      await settle(t);
      for (const r of [detail, end]) expect(r.text).not.toContain(STEP_KEY);
    } finally {
      out.stop();
    }
    expect(out.text()).not.toContain(STEP_KEY);
    const db = t.fixture.db;
    const rows = await Promise.all([db.message.findMany(), db.run.findMany(), db.runStep.findMany(), db.auditLog.findMany(), db.event.findMany(), db.call.findMany(), db.callLine.findMany()]);
    expect(JSON.stringify(rows)).not.toContain(STEP_KEY);
    // The models the hand-off ran on never saw it either.
    expect(JSON.stringify(t.scripts.requests().map((r) => r.request))).not.toContain(STEP_KEY);
  });
});
