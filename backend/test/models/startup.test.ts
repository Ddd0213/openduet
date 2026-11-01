// M12 contract §7 startup: reading models.json / LLM_* is never fatal. No file and no LLM_* is the
// normal start (models are set up in the app); a broken one is ignored with its problem fields (no
// values), an unreadable one too. A server built with no legacy configuration answers,
// imports nothing, and reports Features.models false until a model is set up.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadLegacyModels } from "../../src/models/legacy.ts";
import { settings } from "../llm/fixtures.ts";
import { call, setUp, startModelsApp, type ModelsApp } from "./harness.ts";

const absent = (path: string): string => {
  throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
};
const file = (body: unknown) => () => JSON.stringify(body);

describe("loadLegacyModels (what index.ts does at startup)", () => {
  test("no models.json and no LLM_*: absent, no throw", () => {
    expect(loadLegacyModels(settings, {}, absent)).toEqual({ status: "absent", models: null });
  });

  test("LLM_* without its key: ignored with the problem named, never the values", () => {
    const shortcut = { ...settings, MODEL_CHAT: undefined, LLM_PROTOCOL: "openai" as const, LLM_BASE_URL: "https://gateway.invalid/v1", LLM_MODEL: "secret-model-name" };
    const result = loadLegacyModels(shortcut, {}, absent);
    expect(result.status).toBe("ignored");
    if (result.status !== "ignored") throw new Error("unreachable");
    expect(result.problems.join("\n")).toContain("LLM_API_KEY");
  });

  test("a broken models.json: ignored, no throw; a valid shortcut loads", () => {
    expect(loadLegacyModels(settings, { TEST_KEY: "k-never-logged" }, file({ providers: "nope" })).status).toBe("ignored");
    const loaded = loadLegacyModels(
      { ...settings, MODEL_CHAT: undefined, LLM_PROTOCOL: "openai", LLM_BASE_URL: "https://gateway.invalid/v1", LLM_MODEL: "m" },
      { LLM_API_KEY: "k-shortcut" }, absent,
    );
    expect(loaded.status).toBe("loaded");
    expect(loaded.models?.models.map((m) => m.id)).toContain("m");
  });

  test("an unreadable file (not ENOENT): ignored as 'could not be read', no throw", () => {
    const denied = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    const result = loadLegacyModels(settings, {}, denied);
    expect(result).toEqual({ status: "ignored", models: null, problems: ["MODELS_FILE could not be read"] });
  });
});

describe("a server with no legacy configuration", () => {
  let t: ModelsApp;
  beforeAll(async () => {
    t = await startModelsApp({ legacy: null });
  });
  afterAll(() => t.fixture.cleanup());

  test("answers, imports nothing, and Features.models is false until a model is set up", async () => {
    const me = await call(t, t.alex, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.features.models).toBe(false);
    const state = await call(t, t.alex, "GET", "/api/models");
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ providers: [], models: [], configured: false });
    expect(await t.fixture.db.modelProvider.count()).toBe(0);

    await setUp(t);
    expect((await call(t, t.alex, "GET", "/api/me")).body.features.models).toBe(true);
  });
});
