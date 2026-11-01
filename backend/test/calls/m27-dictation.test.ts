import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { readWav } from "../../src/calls/wav.ts";
import { TRANSCRIPTION_MAX_BYTES } from "../../src/contract/m27voice.ts";
import { captureOutput } from "../channels/harness.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { fakeFetch, openaiText, response, sse } from "../llm/fixtures.ts";
import { realtimeModel, req, startCallsApp, STEP_KEY, stopCallsApp, type CallsApp } from "./harness.ts";
import { wav } from "./wav-fixtures.ts";
let t: CallsApp;
let status = 200;
const net = fakeFetch((c) => status !== 200 ? new Response(STEP_KEY, { status }) : c.url.endsWith("/chat/completions") ? response(openaiText()) : response(sse({ type: "transcript.text.delta", delta: "ignore" }) + sse({ type: "transcript.text.done", text: "  明天提醒我  " })));
beforeAll(async () => { t = await startCallsApp({ fetch: net.fetch }); });
afterAll(() => stopCallsApp(t));
async function upload(user: SignedIn | null, audio: Buffer | string | null = wav(), language?: string | File) {
  const form = new FormData();
  if (audio !== null) form.set("file", typeof audio === "string" ? audio : new File([new Uint8Array(audio)], "not-audio.txt", { type: "text/plain" }));
  if (language !== undefined) form.set("language", language);
  const res = await t.fixture.app.request("/api/transcriptions", { method: "POST", headers: user?.headers ?? {}, body: form });
  return { status: res.status, headers: res.headers, body: await res.json() as { text?: string; error?: { code: string; field?: string; message: string } } };
}

test("route enforces file/format/duration/language/configuration in order and no-store on refusals", async () => {
  const u = await signUp(t.fixture, "transcribe_refusals");
  expect((await upload(null)).status).toBe(401);
  const notMultipart = await req(t, u, "POST", "/api/transcriptions", {});
  expect(notMultipart.status).toBe(400); expect(notMultipart.body.error.field).toBe("file");
  for (const audio of [null, "not a file", Buffer.alloc(0), wav().subarray(0, 30), wav(0.2)]) {
    const res = await upload(u, audio, "not a tag");
    expect(res.status).toBe(400); expect(res.body.error?.field).toBe("file"); expect(res.headers.get("cache-control")).toBe("no-store");
  }
  for (const audio of [Buffer.from("this is not WAV audio at all"), wav(1, { bits: 8 }), wav(1, { encoding: 3 }), wav(1, { channels: 3 }), wav(1, { rate: 7900 })]) {
    const res = await upload(u, audio, "not a tag");
    expect(res.status).toBe(415); expect(res.body.error?.code).toBe("unsupported_type");
  }
  expect((await upload(u, wav(121), "not a tag")).status).toBe(413);
  expect((await upload(u, wav(45, { rate: 48000, channels: 2 }), "not a tag")).status).toBe(413);
  const malformed = await upload(u, wav(), "not a tag");
  expect(malformed.body.error?.field).toBe("language");
  expect((await upload(u)).body.error?.code).toBe("not_configured");
  expect(net.calls).toHaveLength(0);
  const huge = await upload(u, Buffer.alloc(TRANSCRIPTION_MAX_BYTES + 128 * 1024));
  expect(huge.status).toBe(413); expect(huge.headers.get("cache-control")).toBe("no-store");
});

test("WAV chunks, EXTENSIBLE PCM GUID, aligned byte rate and duration boundaries", () => {
  expect(readWav(wav(120))).toEqual({ seconds: 120 });
  expect(readWav(wav(1, { extensible: true, extra: true }))).toEqual({ seconds: 1 });
  expect(readWav(wav(1, { channels: 2, rate: 48000 }))).toEqual({ seconds: 1 });
  expect(() => readWav(wav(121))).toThrow();
  const badGuid = wav(1, { extensible: true }); badGuid[44] = 3;
  expect(() => readWav(badGuid)).toThrow();
  const badRate = wav(); badRate.writeUInt32LE(1, 28);
  expect(() => readWav(badRate)).toThrow();
  const partialChunk = wav(); partialChunk.writeUInt32LE(0xffffffff, 40);
  expect(() => readWav(partialChunk)).toThrow();
});

test("StepFun language maps primary tag, defaults User.language, accepts 120 s and EXTENSIBLE; writes no files or rows", async () => {
  const u = await signUp(t.fixture, "transcribe_step");
  const step = await realtimeModel(t, u, "stepfun");
  await t.fixture.db.modelProvider.update({ where: { id: step.providerId }, data: { region: "intl", baseUrl: "https://api.stepfun.ai/v1" } });
  await req(t, u, "PUT", "/api/voice-settings", { dictation: { providerId: step.providerId, modelId: "unlisted-asr" } });
  await t.fixture.db.user.update({ where: { id: u.userId }, data: { language: "zh-Hans" } });
  const countRows = async () => {
    const tables = await t.fixture.db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table'");
    return Promise.all(tables.map(async ({ name }) => [name, await t.fixture.db.$queryRawUnsafe(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)]));
  };
  const before = await countRows();
  const files = readdirSync(t.fixture.config.FILES_DIR, { recursive: true });
  const userBefore = await t.fixture.db.user.findUniqueOrThrow({ where: { id: u.userId } });
  const logs = captureOutput();
  try {
    const res = await upload(u, wav(120), "zh-Hans-CN");
    expect(res.status).toBe(200); expect(res.body.text).toBe("明天提醒我"); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(net.calls.at(-1)!.body.audio.input.transcription).toEqual({ model: "unlisted-asr", language: "zh", enable_itn: true });
    expect(net.calls.at(-1)!.url).toBe("https://api.stepfun.ai/v1/audio/asr/sse");
    expect((await upload(u, wav(1, { extensible: true, extra: true }))).status).toBe(200);
    expect(net.calls.at(-1)!.body.audio.input.transcription.language).toBe("zh");
    expect((await upload(u, wav(), "de-DE")).body.error?.field).toBe("language");
    expect((await upload(u, wav(121))).status).toBe(413);
    expect(logs.text()).not.toContain(STEP_KEY); expect(logs.text()).not.toContain("明天提醒我");
    const entries = logs.text().trim().split("\n").filter(l => l.includes('"msg":"dictation"') || l.includes('"message":"dictation"'));
    expect(entries).toHaveLength(4);
  } finally { logs.stop(); }
  expect(await countRows()).toEqual(before);
  expect(await t.fixture.db.user.findUniqueOrThrow({ where: { id: u.userId } })).toEqual(userBefore);
  expect(readdirSync(t.fixture.config.FILES_DIR, { recursive: true })).toEqual(files);
});

test("Gemini accepts de hint; failed/no-key/no-model/gone providers are not configured, provider errors are safe 502", async () => {
  const u = await signUp(t.fixture, "transcribe_gem");
  const gem = await realtimeModel(t, u, "gemini");
  await req(t, u, "PUT", "/api/voice-settings", { dictation: { providerId: gem.providerId, modelId: "audio-chat" } });
  expect((await upload(u, wav(), "de-DE")).body.text).toBe("Hello 世界");
  expect(net.calls.at(-1)!.body.messages[0].content).toContain("Language hint: de");
  expect((await upload(u)).status).toBe(200);
  expect(net.calls.at(-1)!.body.messages[0].content).toContain("Language hint: en");
  status = 401;
  try { const bad = await upload(u); expect(bad.status).toBe(502); expect(bad.body.error).toMatchObject({ code: "transcription_failed" }); expect(bad.body.error?.message).toContain("Google refused the key"); expect(JSON.stringify(bad.body)).not.toContain(STEP_KEY); }
  finally { status = 200; }
  await t.fixture.db.modelProvider.update({ where: { id: gem.providerId }, data: { status: "failed" } });
  expect((await upload(u)).body.error?.code).toBe("not_configured");
  await t.fixture.db.modelProvider.update({ where: { id: gem.providerId }, data: { status: "active" } });
  await t.vault.remove(u.userId, "provider", gem.providerId, "key");
  expect((await upload(u)).body.error?.code).toBe("not_configured");
  await t.fixture.db.user.update({ where: { id: u.userId }, data: { dictationModelId: null } });
  expect((await upload(u)).body.error?.code).toBe("not_configured");
  await t.fixture.db.modelProvider.delete({ where: { id: gem.providerId } });
  expect((await upload(u)).body.error?.code).toBe("not_configured");
});
