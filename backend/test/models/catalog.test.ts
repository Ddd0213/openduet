// M12 remote models (contract §2, §9): the provider's own list enriched from a fake models.dev
// document, the defaults without it, the 24 h cache and stale-on-failure, and `addedAs`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RemoteModelList } from "../../src/contract/m12.ts";
import { call, startModelsApp, type ModelsApp } from "./harness.ts";

const MODELS_DEV = {
  openai: { name: "OpenAI", models: {
    "gpt-a": { id: "gpt-a", name: "GPT A", limit: { context: 400000, output: 128000 }, tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }], modalities: { input: ["text", "image"], output: ["text"] } },
    "gpt-realtime": { id: "gpt-realtime", name: "GPT Realtime", limit: { context: 32000, output: 4096 }, tool_call: true, modalities: { input: ["text", "audio"], output: ["text", "audio"] } },
    "gpt-notools": { name: "No tools", tool_call: false, limit: { context: 8000, output: 2000 } },
  } },
  anthropic: { name: "Anthropic", models: {
    "claude-x": { id: "claude-x", name: "Claude X", limit: { context: 200000, output: 64000 }, tool_call: true, reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024, max: 63999 }], modalities: { input: ["text", "image"], output: ["text"] } },
  } },
};
const LIST = { data: [{ id: "gpt-zzz" }, { id: "gpt-a" }, { id: "gpt-realtime" }, { id: "gpt-notools" }] };
const KEY = "sk-catalog-test-key-123456";

const remote = async (t: ModelsApp, providerId: string) => {
  const r = await call(t, t.alex, "GET", `/api/providers/${providerId}/remote-models`);
  expect(r.status).toBe(200);
  return RemoteModelList.parse(r.body).models;
};
const devCalls = (t: ModelsApp) => t.net.calls.filter((c) => c.url === "https://models.dev/api.json").length;

describe("GET /api/providers/:id/remote-models", () => {
  let t: ModelsApp;
  let providerId: string;
  beforeAll(async () => {
    t = await startModelsApp();
    t.net.modelsDev = MODELS_DEV;
    t.net.lists.set("api.openai.com", LIST);
    providerId = (await call(t, t.alex, "POST", "/api/providers", { kind: "openai", key: KEY })).body.provider.id;
  });
  afterAll(() => t.fixture.cleanup());

  test("the provider's list is the truth, sorted by modelId, each row enriched (or the defaults)", async () => {
    const rows = await remote(t, providerId);
    expect(rows.map((r) => r.modelId)).toEqual(["gpt-a", "gpt-notools", "gpt-realtime", "gpt-zzz"]);
    expect(rows[0]).toEqual({
      modelId: "gpt-a", label: "GPT A", contextWindow: 400000, maxOutputTokens: 128000, thinkingLevels: ["minimal", "low", "medium", "high"],
      thinkingFormat: "effort", tools: true, vision: true, realtime: false, source: "models.dev", addedAs: null, transcription: false,
    });
    expect(rows[1]).toMatchObject({ modelId: "gpt-notools", label: "No tools", tools: false, thinkingLevels: [], thinkingFormat: "none", source: "models.dev" });
    expect(rows[2]).toMatchObject({ modelId: "gpt-realtime", realtime: true, vision: false });
    expect(rows[3]).toEqual({
      modelId: "gpt-zzz", label: "gpt-zzz", contextWindow: 128000, maxOutputTokens: 8192, thinkingLevels: [], thinkingFormat: "none",
      tools: true, vision: false, realtime: false, source: "default", addedAs: null, transcription: false,
    });
  });

  test("addedAs is the ModelEntry of the same provider + modelId; adding copies the numbers", async () => {
    const added = await call(t, t.alex, "POST", "/api/models", { providerId, modelId: "gpt-a" });
    expect(added.body.model).toMatchObject({ modelId: "gpt-a", label: "GPT A", contextWindow: 400000, maxOutputTokens: 128000, thinkingLevels: ["minimal", "low", "medium", "high"], thinkingFormat: "effort", vision: true, source: "models.dev", purpose: "chat", edited: [] });
    const realtime = await call(t, t.alex, "POST", "/api/models", { providerId, modelId: "gpt-realtime" });
    expect(realtime.body.model.purpose).toBe("realtime");
    const rows = await remote(t, providerId);
    expect(rows.find((r) => r.modelId === "gpt-a")!.addedAs).toBe(added.body.model.id);
    expect(rows.find((r) => r.modelId === "gpt-realtime")!.addedAs).toBe(realtime.body.model.id);
    expect(rows.find((r) => r.modelId === "gpt-zzz")!.addedAs).toBeNull();
  });

  test("custom: the id in any provider's models, then without its vendor/ prefix; anthropic budget format", async () => {
    t.net.lists.set("gw.example.test", { data: [{ id: "anthropic/claude-x" }, { id: "gpt-a" }] });
    const id = (await call(t, t.alex, "POST", "/api/providers", { kind: "custom", protocol: "anthropic", baseUrl: "https://gw.example.test", key: KEY })).body.provider.id;
    const rows = await remote(t, id);
    expect(rows.find((r) => r.modelId === "anthropic/claude-x")).toMatchObject({ label: "Claude X", thinkingLevels: ["off", "medium"], thinkingFormat: "budget", contextWindow: 200000, source: "models.dev" });
    expect(rows.find((r) => r.modelId === "gpt-a")).toMatchObject({ label: "GPT A", thinkingFormat: "effort", source: "models.dev" });
  });
});

describe("the models.dev cache", () => {
  test("kept 24 h; a failed refresh keeps the stale copy (and backs off); without any copy the defaults", async () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const t = await startModelsApp({ now: () => now });
    try {
      t.net.modelsDev = MODELS_DEV;
      t.net.lists.set("api.openai.com", LIST);
      const providerId = (await call(t, t.alex, "POST", "/api/providers", { kind: "openai", key: KEY })).body.provider.id;
      expect((await remote(t, providerId))[0]!.source).toBe("models.dev");
      expect(devCalls(t)).toBe(1);
      now += 23 * 60 * 60 * 1000;
      await remote(t, providerId);
      expect(devCalls(t)).toBe(1);
      // A day later the refresh fails: the stale copy is still used.
      now += 2 * 60 * 60 * 1000;
      t.net.modelsDevStatus = 500;
      expect((await remote(t, providerId))[0]).toMatchObject({ modelId: "gpt-a", source: "models.dev", label: "GPT A" });
      expect(devCalls(t)).toBe(2);
      await remote(t, providerId);
      expect(devCalls(t)).toBe(2);
      // It recovers after the back-off.
      now += 6 * 60 * 1000;
      t.net.modelsDevStatus = 200;
      t.net.modelsDev = { openai: { models: { "gpt-a": { name: "GPT A (new)" } } } };
      expect((await remote(t, providerId))[0]!.label).toBe("GPT A (new)");
      expect(devCalls(t)).toBe(3);
    } finally {
      await t.fixture.cleanup();
    }

    const cold = await startModelsApp();
    try {
      cold.net.modelsDevStatus = 503;
      cold.net.lists.set("api.openai.com", LIST);
      const providerId = (await call(cold, cold.alex, "POST", "/api/providers", { kind: "openai", key: KEY })).body.provider.id;
      const rows = await remote(cold, providerId);
      expect(rows.every((r) => r.source === "default" && r.contextWindow === 128000 && r.maxOutputTokens === 8192 && r.tools)).toBe(true);
      // gpt-realtime still reads as realtime by its id.
      expect(rows.find((r) => r.modelId === "gpt-realtime")!.realtime).toBe(true);
    } finally {
      await cold.fixture.cleanup();
    }
  });
});
