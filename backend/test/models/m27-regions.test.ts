import { afterAll, beforeAll, expect, test } from "bun:test";
import { defaults, fromModelsDev } from "../../src/models/catalog.ts";
import { call, startModelsApp, type ModelsApp } from "./harness.ts";
import { Providers } from "../../src/models/providers.ts";
import { KeyedLock } from "../../src/tasks/lock.ts";

let t: ModelsApp;
const key = "test-region-key-123456";
beforeAll(async () => { t = await startModelsApp(); });
afterAll(() => t.fixture.cleanup());
const create = (input: Record<string, unknown> = {}) => call(t, t.alex, "POST", "/api/providers", { kind: "stepfun", key, ...input });

test("new StepFun defaults from CN/US/null, explicit region wins, names are free", async () => {
  for (const [country, region, host] of [["CN", "cn", "api.stepfun.com"], ["US", "intl", "api.stepfun.ai"], [null, "cn", "api.stepfun.com"]] as const) {
    await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { region: country } });
    const res = await create({ name: "My own Step name" });
    expect(res.status).toBe(200); expect(res.body.provider.region).toBe(region);
    expect(res.body.provider.baseUrl).toBe(`https://${host}/v1`);
    expect(t.net.listCalls().at(-1)!.url).toBe(`https://${host}/v1/models`);
  }
  expect((await create({ region: "intl" })).body.provider.region).toBe("intl");
  const gem = await create({ kind: "gemini", region: "cn" });
  expect(gem.status).toBe(400); expect(gem.body.error.field).toBe("region");
  const gemId = (await create({ kind: "gemini", name: "My Gemini" })).body.provider.id;
  expect((await call(t, t.alex, "PATCH", `/api/providers/${gemId}`, { region: "intl" })).body.error.field).toBe("region");
  expect((await create({ kind: "openai" })).body.provider.region).toBeNull();
});

test("region PATCH moves the default, rechecks with stored key, keeps proxies; typed URL still needs a key", async () => {
  const id = (await create({ region: "cn" })).body.provider.id;
  const moved = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { region: "intl" });
  expect(moved.status).toBe(200); expect(moved.body.provider.baseUrl).toBe("https://api.stepfun.ai/v1");
  expect(t.net.listCalls().at(-1)!.headers.get("authorization")).toBe(`Bearer ${key}`);
  const proxy = (await create({ baseUrl: "https://proxy.example.test/v1", region: "cn" })).body.provider.id;
  const kept = await call(t, t.alex, "PATCH", `/api/providers/${proxy}`, { region: "intl" });
  expect(kept.status).toBe(200); expect(kept.body.provider.baseUrl).toBe("https://proxy.example.test/v1");
  expect(t.net.listCalls().at(-1)!.url).toBe("https://proxy.example.test/v1/models");
  expect((await call(t, t.alex, "PATCH", `/api/providers/${id}`, { region: "cn", baseUrl: "https://new.example.test/v1" })).body.error.field).toBe("key");
  const explicit = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { region: "cn", baseUrl: "https://new.example.test/v1", key });
  expect(explicit.status).toBe(200); expect(explicit.body.provider.baseUrl).toBe("https://new.example.test/v1");
});

test("wrong-site probes both directions on create and moves, but never on /test; failed moves save nothing", async () => {
  for (const [region, host, other, label] of [["cn", "api.stepfun.com", "api.stepfun.ai", "international"], ["intl", "api.stepfun.ai", "api.stepfun.com", "mainland"]] as const) {
    const id = (await create({ region: region === "cn" ? "intl" : "cn" })).body.provider.id;
    t.net.listStatus.set(host, 401);
    try {
      const before = t.net.listCalls().length;
      const refused = await create({ region });
      expect(refused.status).toBe(400); expect(refused.body.error).toMatchObject({ field: "region", message: `region: this key belongs to StepFun's ${label} site (${other})` });
      expect(t.net.listCalls().slice(before).map((c) => new URL(c.url).host)).toEqual([host, other]);
      const move = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { region });
      expect(move.body.error.field).toBe("region");
      expect((await t.fixture.db.modelProvider.findUniqueOrThrow({ where: { id } })).region).not.toBe(region);
      await t.fixture.db.modelProvider.update({ where: { id }, data: { baseUrl: `https://${host}/v1`, region } });
      const n = t.net.listCalls().length;
      const checked = await call(t, t.alex, "POST", `/api/providers/${id}/test`);
      expect(checked.body.provider.status).toBe("failed"); expect(t.net.listCalls().length).toBe(n + 1);
      t.net.listStatus.set(other, 403);
      expect((await create({ region })).body.error.field).toBe("key");
      t.net.listStatus.delete(other);
    } finally { t.net.listStatus.clear(); }
  }
});

test("recognizer hints use audio-in/text-out and delimited id patterns; realtime never transcribes", async () => {
  for (const id of ["asr", "v/asr-large", "x_transcribe", "x.transcription", "whisper-1", "x-stt"]) expect(defaults(id).transcription).toBe(true);
  for (const id of ["casrthing", "whispered", "x-asr-live", "x-realtime-stt"]) expect(defaults(id).transcription).toBe(false);
  const audio = { modalities: { input: ["audio"], output: ["text"] } };
  expect(fromModelsDev("audio-chat", audio, "openai").transcription).toBe(true);
  expect(fromModelsDev("audio-live", audio, "openai").transcription).toBe(false);
  expect(fromModelsDev("whisper", { modalities: { input: ["audio"], output: ["audio", "text"] } }, "openai").transcription).toBe(false);
  t.net.modelsDev = { stepfun: { models: { "audio-chat": audio } } };
  t.net.lists.set("api.stepfun.com", { data: [{ id: "audio-chat" }, { id: "stepaudio-2.5-asr" }, { id: "asr-realtime" }] });
  const id = (await create({ region: "cn" })).body.provider.id;
  const rows = (await call(t, t.alex, "GET", `/api/providers/${id}/remote-models`)).body.models;
  expect(rows.map((r: { modelId: string; transcription: boolean }) => [r.modelId, r.transcription])).toEqual([["asr-realtime", false], ["audio-chat", true], ["stepaudio-2.5-asr", true]]);
});

test("wrong-site probes refuse redirects and share the verification deadline", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let stalled = false;
  const providers = new Providers({ db: t.fixture.db, events: t.fixture.events, vault: t.vault, catalog: t.models.catalog,
    lock: new KeyedLock(), insecureHosts: [], verifyTimeoutMs: 50, onSecret: () => {},
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      expect(init?.redirect).toBe("manual");
      if (String(url).includes("api.stepfun.com")) return new Response("refused", { status: 403 });
      if (!stalled) return new Response("redirect", { status: 302, headers: { Location: "https://evil.invalid" } });
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  });
  await expect(providers.create(t.alex.userId, { kind: "stepfun", region: "cn", key })).rejects.toMatchObject({ field: "key" });
  expect(calls).toHaveLength(2);
  stalled = true; calls.length = 0;
  await expect(providers.create(t.alex.userId, { kind: "stepfun", region: "cn", key })).rejects.toMatchObject({ field: "key" });
  expect(calls).toHaveLength(2);
  expect(calls.every(c => c.init?.signal?.aborted)).toBe(true);
});
