// M12 one-time import (contract §6, §9): a models.json fixture and the LLM_* shortcut become the
// user's own providers (kind custom, imported) and models (source imported); keys land in the vault
// from the (injected) environment; providers without a key are skipped; the defaults come from
// MODEL_CHAT / MODEL_UTILITY; a second run changes nothing; after the user deletes everything nothing
// comes back; parallel first calls (one importer or two on the same database) import once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser } from "../../src/auth/users.ts";
import { ModelsState } from "../../src/contract/m12.ts";
import { loadModelConfig, type ModelConfig } from "../../src/llm/index.ts";
import { LegacyImporter } from "../../src/models/import.ts";
import { captureOutput } from "../channels/harness.ts";
import { settings } from "../llm/fixtures.ts";
import { TEST_PASSWORD } from "../helpers/session.ts";
import { call, startModelsApp, type ModelsApp } from "./harness.ts";

const ENV = { GATEWAY_KEY: "sk-legacy-gateway-key-1111", CLAUDE_KEY: "sk-legacy-claude-key-2222" };
const caps = { tools: true, vision: false, thinking: false, serverWebTools: false, promptCaching: false };
const FILE = {
  providers: [
    { id: "gateway", protocol: "openai", baseUrl: "https://gw.example.test/v1/", apiKeyEnv: "GATEWAY_KEY", headers: { "X-Team": "duet" } },
    { id: "claude", protocol: "anthropic", baseUrl: "https://claude.example.test/v1/", apiKeyEnv: "CLAUDE_KEY", auth: "bearer" },
  ],
  models: [
    { id: "big", provider: "gateway", label: "Big model", contextWindow: 200000, maxOutputTokens: 32000, capabilities: { ...caps, vision: true, thinking: true } },
    { id: "small", provider: "gateway", label: "Small model", contextWindow: 64000, maxOutputTokens: 4096, capabilities: { ...caps, tools: false } },
    { id: "sonnet", provider: "claude", label: "Sonnet", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { ...caps, serverWebTools: true, promptCaching: true } },
  ],
};
/** models.json as loaded at startup: MODEL_CHAT=sonnet,big, MODEL_UTILITY=small. */
const legacyFile = (): ModelConfig => loadModelConfig({ ...settings, MODEL_CHAT: "sonnet,big", MODEL_UTILITY: "small" }, ENV, () => JSON.stringify(FILE));

/** The rows an import wrote (stable across runs: ids, names, values, no timestamps that change). */
async function snapshot(t: ModelsApp, userId: string) {
  const db = t.fixture.db;
  const [providers, models, secrets, user] = await Promise.all([
    db.modelProvider.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    db.modelEntry.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    db.vaultSecret.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true, utilityModelId: true, modelsImportedAt: true } }),
  ]);
  return JSON.stringify({ providers, models, secrets: secrets.map((s) => ({ id: s.id, ownerId: s.ownerId, updatedAt: s.updatedAt })), user });
}

/** A user created straight in the database (no sign-in, so nothing has asked for models yet). */
async function bareUser(t: ModelsApp, username: string): Promise<string> {
  await createUser(t.fixture.db, t.fixture.auth, { username, name: "Sam", password: TEST_PASSWORD, timezone: "UTC" });
  return (await t.fixture.db.user.findFirstOrThrow({ where: { username } })).id;
}

describe("import from a models.json fixture", () => {
  let t: ModelsApp;
  beforeAll(async () => { t = await startModelsApp({ legacy: legacyFile(), env: ENV }); });
  afterAll(() => t.fixture.cleanup());

  test("providers (kind custom, imported) with their keys in the vault; models (source imported); the defaults", async () => {
    const s = ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body);
    const gateway = s.providers.find((p) => p.name === "gateway")!;
    const claude = s.providers.find((p) => p.name === "claude")!;
    expect(s.providers).toHaveLength(2);
    expect(gateway).toMatchObject({ kind: "custom", protocol: "openai", baseUrl: "https://gw.example.test/v1", auth: null, headers: [{ name: "X-Team", value: "duet" }], key: { set: true, last4: "1111" }, status: "active", error: null, imported: true, modelCount: 2 });
    expect(claude).toMatchObject({ kind: "custom", protocol: "anthropic", baseUrl: "https://claude.example.test", auth: "bearer", key: { set: true, last4: "2222" }, imported: true, modelCount: 1 });
    const byId = new Map(s.models.map((m) => [m.modelId, m]));
    expect(byId.get("big")).toMatchObject({ providerId: gateway.id, purpose: "chat", label: "Big model", contextWindow: 200000, maxOutputTokens: 32000, thinkingLevels: ["off", "low", "medium", "high"], thinkingFormat: "effort", tools: true, vision: true, source: "imported", edited: [] });
    expect(byId.get("small")).toMatchObject({ tools: false, thinkingLevels: [], thinkingFormat: "none", source: "imported" });
    expect(byId.get("sonnet")).toMatchObject({ providerId: claude.id, serverWebTools: true, promptCaching: true, thinkingLevels: [], thinkingFormat: "none" });
    // MODEL_CHAT's first model is the default; MODEL_UTILITY's first (it differs) the background model.
    expect(s.defaults).toEqual({ defaultModelId: byId.get("sonnet")!.id, defaultThinking: null, utilityModelId: byId.get("small")!.id });
    expect(s.configured).toBe(true);
    expect(await t.vault.get(t.alex.userId, "provider", gateway.id, "key")).toBe(ENV.GATEWAY_KEY);
    expect(await t.vault.get(t.alex.userId, "provider", claude.id, "key")).toBe(ENV.CLAUDE_KEY);
    expect((await t.fixture.db.user.findUniqueOrThrow({ where: { id: t.alex.userId } })).modelsImportedAt).not.toBeNull();
    // The default's native web tools turn webSearch on.
    expect((await call(t, t.alex, "GET", "/api/me")).body.features).toMatchObject({ models: true, webSearch: true });
  });

  test("a second run changes nothing; after the user deletes everything nothing comes back", async () => {
    const before = await snapshot(t, t.alex.userId);
    await call(t, t.alex, "GET", "/api/models");
    await new LegacyImporter({ db: t.fixture.db, vault: t.vault, legacy: legacyFile(), env: ENV }).ensure(t.alex.userId);
    expect(await snapshot(t, t.alex.userId)).toBe(before);
    const s = ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body);
    const gateway = s.providers.find((p) => p.name === "gateway")!;
    const claude = s.providers.find((p) => p.name === "claude")!;
    expect((await call(t, t.alex, "DELETE", `/api/providers/${gateway.id}`)).status).toBe(204);
    expect((await call(t, t.alex, "DELETE", `/api/providers/${claude.id}`)).status).toBe(204);
    expect(ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body)).toMatchObject({ providers: [], models: [], configured: false });
    // A fresh importer (a restart) finds the user imported already.
    await new LegacyImporter({ db: t.fixture.db, vault: t.vault, legacy: legacyFile(), env: ENV }).ensure(t.alex.userId);
    expect(ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body).providers).toEqual([]);
    expect(await t.fixture.db.vaultSecret.count({ where: { userId: t.alex.userId } })).toBe(0);
  });

  test("two parallel first calls import once (one importer, and two importers on the same database)", async () => {
    const one = await bareUser(t, "parallel1");
    await Promise.all([t.models.importer.ensure(one), t.models.importer.ensure(one), t.models.service.state(one), t.models.service.features(one)]);
    const two = await bareUser(t, "parallel2");
    const a = new LegacyImporter({ db: t.fixture.db, vault: t.vault, legacy: legacyFile(), env: ENV });
    const b = new LegacyImporter({ db: t.fixture.db, vault: t.vault, legacy: legacyFile(), env: ENV });
    await Promise.all([a.ensure(two), b.ensure(two), a.ensure(two), b.ensure(two)]);
    for (const userId of [one, two]) {
      expect(await t.fixture.db.modelProvider.count({ where: { userId } })).toBe(2);
      expect(await t.fixture.db.modelEntry.count({ where: { userId } })).toBe(3);
      expect(await t.fixture.db.vaultSecret.count({ where: { userId, ownerKind: "provider" } })).toBe(2);
    }
  });

  test("the keys never reach a log line; the import logs counts only", async () => {
    const userId = await bareUser(t, "quiet1");
    const out = captureOutput();
    try {
      await t.models.importer.ensure(userId);
    } finally {
      out.stop();
    }
    expect(out.text()).toContain("legacy models imported");
    expect(out.text()).not.toContain(ENV.GATEWAY_KEY);
    expect(out.text()).not.toContain(ENV.CLAUDE_KEY);
  });
});

describe("import: the LLM_* shortcut, missing keys, no legacy configuration", () => {
  test("LLM_* (no models.json) becomes one provider gateway with its model as the default", async () => {
    const absent = (): never => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    const env = { LLM_API_KEY: "sk-legacy-shortcut-key-3333" };
    const legacy = loadModelConfig({ ...settings, MODEL_CHAT: undefined, LLM_PROTOCOL: "anthropic", LLM_BASE_URL: "https://llm.example.test/v1/", LLM_MODEL: "house-model", LLM_AUTH_HEADER: "bearer", LLM_CAPABILITIES: ["tools", "vision"] }, env, absent);
    const t = await startModelsApp({ legacy, env });
    try {
      const s = ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body);
      expect(s.providers).toEqual([expect.objectContaining({ name: "gateway", kind: "custom", protocol: "anthropic", auth: "bearer", baseUrl: "https://llm.example.test", imported: true, key: { set: true, last4: "3333" }, modelCount: 1 })]);
      expect(s.models).toEqual([expect.objectContaining({ modelId: "house-model", label: "house-model", contextWindow: 128000, maxOutputTokens: 8192, tools: true, vision: true, thinkingLevels: [], source: "imported" })]);
      // MODEL_UTILITY falls back to the same model: no separate background model.
      expect(s.defaults).toEqual({ defaultModelId: s.models[0]!.id, defaultThinking: null, utilityModelId: null });
      expect(await t.vault.get(t.alex.userId, "provider", s.providers[0]!.id, "key")).toBe(env.LLM_API_KEY);
    } finally {
      await t.fixture.cleanup();
    }
  });

  test("a provider whose key is empty at import time is skipped; the default is then the first imported model with tools", async () => {
    const t = await startModelsApp({ legacy: legacyFile(), env: { GATEWAY_KEY: ENV.GATEWAY_KEY, CLAUDE_KEY: "  " } });
    try {
      const s = ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body);
      expect(s.providers.map((p) => p.name)).toEqual(["gateway"]);
      expect(s.models.map((m) => m.modelId).sort()).toEqual(["big", "small"]);
      const byId = new Map(s.models.map((m) => [m.modelId, m.id]));
      expect(s.defaults).toEqual({ defaultModelId: byId.get("big")!, defaultThinking: null, utilityModelId: byId.get("small")! });
      expect(await t.fixture.db.vaultSecret.count({ where: { userId: t.alex.userId } })).toBe(1);
    } finally {
      await t.fixture.cleanup();
    }
  });

  test("without a legacy configuration nothing is imported and modelsImportedAt stays null; a later import keeps the user's own setup", async () => {
    const t = await startModelsApp({ legacy: null });
    try {
      expect(ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body)).toMatchObject({ providers: [], models: [], configured: false });
      expect((await t.fixture.db.user.findUniqueOrThrow({ where: { id: t.alex.userId } })).modelsImportedAt).toBeNull();
      // The user sets up a provider named like the legacy one, with their own default.
      const own = await call(t, t.alex, "POST", "/api/providers", { kind: "openai", key: "sk-own-key-44444444", name: "gateway" });
      const mine = await call(t, t.alex, "POST", "/api/models", { providerId: own.body.provider.id, modelId: "gpt-a" });
      // A restart with models.json: the import adds next to it and keeps the user's default.
      await new LegacyImporter({ db: t.fixture.db, vault: t.vault, legacy: legacyFile(), env: ENV }).ensure(t.alex.userId);
      const s = ModelsState.parse((await call(t, t.alex, "GET", "/api/models")).body);
      expect(s.providers.map((p) => p.name).sort()).toEqual(["claude", "gateway", "gateway 2"]);
      expect(s.providers.find((p) => p.name === "gateway")).toMatchObject({ imported: false, kind: "openai" });
      expect(s.providers.find((p) => p.name === "gateway 2")).toMatchObject({ imported: true, kind: "custom" });
      expect(s.defaults.defaultModelId).toBe(mine.body.model.id);
      expect(s.defaults.utilityModelId).toBe(s.models.find((m) => m.modelId === "small")!.id);
      expect((await t.fixture.db.user.findUniqueOrThrow({ where: { id: t.alex.userId } })).modelsImportedAt).not.toBeNull();
    } finally {
      await t.fixture.cleanup();
    }
  });
});
