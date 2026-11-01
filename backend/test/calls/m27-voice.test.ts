import { afterAll, beforeAll, expect, test } from "bun:test";
import { REALTIME_VOICES } from "../../src/contract/m27voice.ts";
import { signUp } from "../helpers/session.ts";
import { realtimeModel, req, startCallsApp, stopCallsApp, type CallsApp } from "./harness.ts";
let t: CallsApp;
beforeAll(async () => { t = await startCallsApp({ noResolver: true }); });
afterAll(() => stopCallsApp(t));

test("VoiceSettings lists only own voice providers oldest first, metadata, models and region presets", async () => {
  const u = await signUp(t.fixture, "voice_page");
  await t.fixture.db.user.update({ where: { id: u.userId }, data: { region: "US" } });
  const gem = await realtimeModel(t, u, "gemini", { key: null });
  const step = await realtimeModel(t, u, "stepfun", { status: "failed" });
  await t.fixture.db.modelProvider.update({ where: { id: step.providerId }, data: { region: "intl", error: "the key was refused" } });
  await realtimeModel(t, t.alex, "stepfun");
  await t.fixture.db.modelProvider.create({ data: { userId: u.userId, kind: "openai", protocol: "openai", name: "Not voice", baseUrl: "https://other.invalid/v1" } });
  const res = await req(t, u, "GET", "/api/voice-settings");
  expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.body.providers.map((p: { id: string }) => p.id)).toEqual([gem.providerId, step.providerId]);
  expect(res.body.providers[0].key).toEqual({ set: false, last4: null });
  expect(res.body.providers[1]).toMatchObject({ status: "failed", error: "the key was refused", region: "intl", key: { set: true, last4: "8765" }, voices: [...REALTIME_VOICES["stepfun:intl"]], realtimeModels: [{ id: step.entryId, modelId: step.modelId, label: "stepfun" }] });
  expect(res.body.presets).toEqual([{ kind: "gemini", regions: [], defaultRegion: null }, { kind: "stepfun", regions: [{ region: "cn", host: "api.stepfun.com" }, { region: "intl", host: "api.stepfun.ai" }], defaultRegion: "intl" }]);
  expect(res.body.dictation).toMatchObject({ engine: "device", onDeviceOnly: false, providerId: null, modelId: null, cloudReady: false });
});

test("intl voice validation, old settings fall back, resumed invalid voice falls back; legacy cn URL unchanged", async () => {
  const u = await signUp(t.fixture, "voices_intl");
  const step = await realtimeModel(t, u, "stepfun");
  await t.fixture.db.user.update({ where: { id: u.userId }, data: { voiceModelId: step.entryId, voiceName: "qingchunshaonv" } });
  let started = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
  expect(started.body.url).toBe(`wss://api.stepfun.com/v1/realtime?model=${step.modelId}`);
  const id = started.body.call.id;
  await t.fixture.db.modelProvider.update({ where: { id: step.providerId }, data: { region: "intl" } });
  expect((await req(t, u, "PUT", "/api/voice-settings", { dictation: { engine: "cloud" } })).body.voice).toBe("qingchunshaonv");
  const bad = await req(t, u, "PUT", "/api/voice-settings", { modelId: step.entryId, voice: "qingchunshaonv" });
  expect(bad.status).toBe(400); expect(bad.body.error.field).toBe("voice");
  expect((await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, callId: id, voice: "qingchunshaonv" })).status).toBe(400);
  started = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, callId: id });
  expect(started.body.url).toBe(`wss://api.stepfun.ai/v1/realtime?model=${step.modelId}`);
  expect(started.body.call.voice).toBe("soft-spoken-gentleman");
  const ok = await req(t, u, "PUT", "/api/voice-settings", { modelId: step.entryId, voice: "lively-girl" });
  expect(ok.status).toBe(200); expect(ok.body.voices.stepfun).toEqual([...REALTIME_VOICES["stepfun:cn"]]);
  await req(t, u, "PUT", "/api/voice-settings", { modelId: null, voice: "lively-girl" });
  expect((await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId, callId: id, voice: "lively-girl" })).body.call.voice).toBe("lively-girl");
});

test("dictation partial writes, provider/model validation, change/clear semantics and cloudReady failures", async () => {
  const u = await signUp(t.fixture, "dictation_settings");
  const a = await realtimeModel(t, u, "stepfun");
  const b = await realtimeModel(t, u, "gemini", { key: null });
  const foreign = await realtimeModel(t, t.alex, "gemini");
  const put = (dictation: Record<string, unknown>) => req(t, u, "PUT", "/api/voice-settings", { dictation });
  expect((await put({ engine: "cloud" })).body.dictation.cloudReady).toBe(false);
  expect((await put({ modelId: "typed-asr" })).body.error.field).toBe("dictation.modelId");
  expect((await put({ providerId: foreign.providerId })).body.error.field).toBe("dictation.providerId");
  const custom = await t.fixture.db.modelProvider.create({ data: { userId: u.userId, kind: "custom", protocol: "openai", name: "Custom", baseUrl: "https://custom.invalid/v1" } });
  expect((await put({ providerId: custom.id })).body.error.field).toBe("dictation.providerId");
  const saved = await put({ providerId: a.providerId, modelId: "  unlisted-asr  ", onDeviceOnly: true });
  expect(saved.body.dictation).toEqual({ engine: "cloud", providerId: a.providerId, modelId: "unlisted-asr", onDeviceOnly: true, cloudReady: true });
  expect((await put({ engine: "device" })).body.dictation).toMatchObject({ cloudReady: true, modelId: "unlisted-asr", onDeviceOnly: true });
  expect((await put({ providerId: a.providerId })).body.dictation.modelId).toBe("unlisted-asr");
  expect((await put({ providerId: b.providerId })).body.dictation).toMatchObject({ modelId: null, cloudReady: false });
  expect((await put({ modelId: "audio-model" })).body.dictation.cloudReady).toBe(false);
  await t.vault.put(u.userId, "provider", b.providerId, "key", "test-key-123456");
  expect((await req(t, u, "GET", "/api/voice-settings")).body.dictation.cloudReady).toBe(true);
  await t.fixture.db.modelProvider.update({ where: { id: b.providerId }, data: { status: "failed" } });
  expect((await req(t, u, "GET", "/api/voice-settings")).body.dictation.cloudReady).toBe(false);
  await t.fixture.db.modelProvider.delete({ where: { id: b.providerId } });
  expect((await req(t, u, "GET", "/api/voice-settings")).body.dictation).toMatchObject({ providerId: null, cloudReady: false });
  expect((await put({ providerId: null })).body.dictation).toMatchObject({ modelId: null, providerId: null });
  const raw = await t.fixture.db.user.findUniqueOrThrow({ where: { id: u.userId } });
  expect(raw.dictationOnDevice).toBe(true); expect(raw.dictationEngine).toBe("device");
});

test("preset default CN/null is mainland; valid dictation provider with no model is not cloudReady", async () => {
  const u = await signUp(t.fixture, "voice_defaults");
  for (const country of ["CN", null]) {
    await t.fixture.db.user.update({ where: { id: u.userId }, data: { region: country } });
    expect((await req(t, u, "GET", "/api/voice-settings")).body.presets[1].defaultRegion).toBe("cn");
  }
  const step = await realtimeModel(t, u, "stepfun");
  const res = await req(t, u, "PUT", "/api/voice-settings", { dictation: { providerId: step.providerId } });
  expect(res.body.dictation).toMatchObject({ providerId: step.providerId, modelId: null, cloudReady: false });
});
