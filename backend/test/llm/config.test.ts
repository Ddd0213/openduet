import { describe, expect, test } from "bun:test";
import { loadModelConfig, ModelConfigError, normalizeBaseUrl } from "../../src/llm/index.ts";
import { caps, env, rawConfig, settings } from "./fixtures.ts";
const absent = (): never => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
describe("model configuration", () => {
  test("normalizes URLs without double v1 and retains openai paths", () => {
    expect(normalizeBaseUrl("https://gateway.invalid/prefix/v1///", "anthropic")).toBe("https://gateway.invalid/prefix");
    expect(normalizeBaseUrl("https://gateway.invalid/v1/", "openai")).toBe("https://gateway.invalid/v1");
    expect(normalizeBaseUrl("https://gateway.invalid", "openai")).toBe("https://gateway.invalid");
  });
  test("https required except exact local or allowlisted hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(normalizeBaseUrl(`http://${host}:11434/v1`, "openai")).toStartWith("http:");
    expect(() => normalizeBaseUrl("http://10.0.0.5/v1", "openai")).toThrow("host 10.0.0.5");
    expect(normalizeBaseUrl("http://10.0.0.5/v1", "openai", ["10.0.0.5"])).toBe("http://10.0.0.5/v1");
    expect(() => normalizeBaseUrl("http://localhost.evil.invalid/v1", "openai")).toThrow("must be https");
    expect(() => normalizeBaseUrl("ftp://localhost/v1", "openai")).toThrow("must be https");
  });
  test("rejects credentials, queries and fragments without leaking their values", () => {
    for (const url of ["https://user:secret@gateway.invalid", "https://gateway.invalid?key=secret", "https://gateway.invalid/#secret"]) {
      try { normalizeBaseUrl(url, "anthropic"); throw new Error("expected error"); }
      catch (error) { expect(String(error)).not.toContain("secret"); }
    }
  });
  test("loads shortcut, defaults tools/limits and resolves roles", () => {
    const modelConfig = loadModelConfig({ ...settings, MODEL_CHAT: undefined, LLM_PROTOCOL: "anthropic", LLM_BASE_URL: "http://localhost:8000/v1/", LLM_MODEL: "shortcut" }, env, absent);
    expect(modelConfig.providers[0]).toMatchObject({ baseUrl: "http://localhost:8000", auth: "x-api-key", apiKeyEnv: "LLM_API_KEY" });
    expect(modelConfig.models[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192, capabilities: caps });
    expect(modelConfig.roles).toEqual({ chat: ["shortcut"], task: ["shortcut"], proactive: ["shortcut"], utility: ["shortcut"] });
    expect(JSON.stringify(modelConfig)).not.toContain(env.LLM_API_KEY);
  });
  test("shortcut fields are named and empty key never copied from Config", () => {
    try { loadModelConfig(settings, {}, absent); throw new Error("expected error"); }
    catch (error) { expect(error).toBeInstanceOf(ModelConfigError); expect(String(error)).toContain("LLM_PROTOCOL"); expect(String(error)).toContain("LLM_BASE_URL"); expect(String(error)).toContain("LLM_MODEL"); }
    expect(() => loadModelConfig({ ...settings, LLM_PROTOCOL: "openai", LLM_BASE_URL: "https://gateway.invalid/v1", LLM_MODEL: "test-model" }, {}, absent)).toThrow("env var LLM_API_KEY");
  });
  test("collects field-specific URL, role, capability and key problems", () => {
    const config = rawConfig("anthropic", { ...caps, tools: false });
    config.providers[0]!.baseUrl = "http://10.0.0.5";
    try { loadModelConfig({ ...settings, MODEL_TASK: "unknown" }, {}, () => JSON.stringify(config)); throw new Error("expected error"); }
    catch (error) {
      expect(error).toBeInstanceOf(ModelConfigError);
      expect(String(error)).toContain("models.json providers[0].baseUrl must be https");
      expect(String(error)).toContain('MODEL_TASK: unknown model "unknown"');
      expect(String(error)).toContain('MODEL_CHAT model "test-model" lacks the tools capability');
      expect(String(error)).toContain("env var TEST_KEY (providers[0].apiKeyEnv) is empty");
    }
  });
  test("fallback chains retain order; unset roles use chat, utility can be tool-less", () => {
    const raw = rawConfig();
    raw.models.push({ ...raw.models[0]!, id: "fallback" });
    raw.models.push({ ...raw.models[0]!, id: "utility", capabilities: { ...caps, tools: false } });
    const config = loadModelConfig({ ...settings, MODEL_CHAT: "test-model, fallback", MODEL_UTILITY: "utility" }, env, () => JSON.stringify(raw));
    expect(config.roles.chat).toEqual(["test-model", "fallback"]);
    expect(config.roles.task).toEqual(config.roles.chat);
    expect(config.roles.proactive).toEqual(config.roles.chat);
    expect(config.roles.utility).toEqual(["utility"]);
    expect(() => loadModelConfig({ ...settings, MODEL_CHAT: "test-model, " }, env, () => JSON.stringify(raw))).toThrow('unknown model ""');
  });
  test("strict schema reports malformed fields; rejects duplicate ids/providers and bad limits", () => {
    const raw = rawConfig();
    expect(() => loadModelConfig(settings, env, () => JSON.stringify({ ...raw, models: [{ ...raw.models[0], contextWindow: "bad" }] }))).toThrow("models[0].contextWindow");
    const duplicate = { providers: [raw.providers[0], raw.providers[0]], models: [raw.models[0], { ...raw.models[0], maxOutputTokens: 999999, provider: "missing" }] };
    try { loadModelConfig(settings, env, () => JSON.stringify(duplicate)); throw new Error("expected error"); }
    catch (error) { expect(String(error)).toContain("providers[1].id is duplicated"); expect(String(error)).toContain("models[1].id is duplicated"); expect(String(error)).toContain("models[1].provider"); expect(String(error)).toContain("models[1].maxOutputTokens"); }
  });
  test("headers cannot carry credentials; auth only valid for anthropic", () => {
    const raw = rawConfig();
    const data = { ...raw, providers: [{ ...raw.providers[0], auth: "bearer", headers: { Authorization: "test-secret-never-log" } }] };
    try { loadModelConfig(settings, env, () => JSON.stringify(data)); throw new Error("expected error"); }
    catch (error) { expect(String(error)).toContain("providers[0].auth"); expect(String(error)).toContain("providers[0].headers.Authorization"); expect(String(error)).not.toContain(env.TEST_KEY); }
  });
  test("JSON parse/read failures do not silently choose shortcut; paths use backend", () => {
    expect(() => loadModelConfig(settings, env, () => "{" )).toThrow("valid JSON");
    expect(() => loadModelConfig(settings, env, () => { throw Object.assign(new Error(env.TEST_KEY), { code: "EACCES" }); })).toThrow("MODELS_FILE could not be read");
    let path = "";
    loadModelConfig({ ...settings, MODELS_FILE: "relative/models.json" }, env, p => { path = p; return JSON.stringify(rawConfig()); });
    // relative to backend/, whatever the checkout's directory is called
    expect(path).toEndWith("/backend/relative/models.json");
  });
  test("example is loadable with dummy env keys and configured roles", async () => {
    const example = await Bun.file(new URL("../../models.example.json", import.meta.url)).text();
    const modelConfig = loadModelConfig({ ...settings, MODEL_CHAT: "REPLACE_WITH_ANTHROPIC_GATEWAY_MODEL_ID,REPLACE_WITH_OPENROUTER_GATEWAY_MODEL_ID" }, { ANTHROPIC_API_KEY: "dummy", OPENROUTER_API_KEY: "dummy", OLLAMA_API_KEY: "dummy" }, () => example);
    expect(modelConfig.models).toHaveLength(3);
    expect(modelConfig.providers[2]?.baseUrl).toBe("http://localhost:11434/v1");
  });
});
