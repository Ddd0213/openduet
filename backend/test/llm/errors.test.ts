// M14a B2: model errors get a fixed code (and phrase key) from status + the SDK error's code/type and
// fixed message patterns; auth / quota / context_length / content_filter are never retried; the body
// is never kept, logged or shown.
import { describe, expect, test } from "bun:test";
import { createLlm, LLM_ERROR_CODES, LLM_ERROR_PHRASE, LlmError } from "../../src/llm/index.ts";
import en from "../../src/i18n/en.json";
import zh from "../../src/i18n/zh-Hans.json";
import { collect, env, fakeFetch, o, registry, request, sse } from "./fixtures.ts";

const pin = { providerId: "test-provider", modelId: "test-model" };
async function fail(protocol: "openai" | "anthropic", status: number, body: unknown) {
  const reports: Record<string, unknown>[] = [];
  const fake = fakeFetch(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" } }));
  try {
    await collect(createLlm(registry(protocol), { fetch: fake.fetch, env, sleep: async () => {}, report: f => reports.push(f) }).stream({ ...request, pin }));
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    return { error, calls: fake.calls.length, reports };
  }
  throw new Error("expected a failure");
}
const oa = (message: string, code?: string, type = "invalid_request_error") => ({ error: { message, type, ...(code ? { code } : {}) } });
const an = (type: string, message: string) => ({ type: "error", error: { type, message } });

describe("error codes", () => {
  const cases: [string, "openai" | "anthropic", number, unknown, string, number][] = [
    ["401 key", "openai", 401, oa("Incorrect API key provided: sk-secret", "invalid_api_key"), "auth", 1],
    ["403 forbidden", "anthropic", 403, an("permission_error", "no access"), "auth", 1],
    ["402 payment", "openai", 402, oa("Insufficient Balance"), "quota", 1],
    ["429 insufficient_quota", "openai", 429, oa("You exceeded your current quota", "insufficient_quota", "insufficient_quota"), "quota", 1],
    ["429 billing (anthropic)", "anthropic", 429, an("billing_error", "credit"), "quota", 1],
    ["429 rate limit", "openai", 429, oa("Rate limit reached for requests", "rate_limit_exceeded", "requests"), "rate_limit", 3],
    ["400 context_length_exceeded", "openai", 400, oa("This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", "context_length_exceeded"), "context_length", 1],
    ["400 prompt is too long (anthropic)", "anthropic", 400, an("invalid_request_error", "prompt is too long: 210000 tokens > 200000 maximum"), "context_length", 1],
    ["413 html body", "openai", 413, "<html><body>413 Request Entity Too Large</body></html>", "context_length", 1],
    ["400 data_inspection_failed", "openai", 400, oa("Input data may contain inappropriate content.", "data_inspection_failed"), "content_filter", 1],
    ["400 sensitive (zh gateway)", "openai", 400, oa("内容包含敏感词，请修改后重试"), "content_filter", 1],
    ["400 plain bad request", "openai", 400, oa("Invalid value for 'temperature'"), "http", 1],
    ["400 content_policy_violation", "openai", 400, oa("Your request was rejected as a result of our safety system.", "content_policy_violation"), "content_filter", 1],
    ["400 flagged (moderation)", "openai", 400, oa("Your input was flagged as potentially violating our usage policy."), "content_filter", 1],
    ["400 content_filter (azure)", "openai", 400, oa("The response was filtered due to the prompt triggering content management policy.", "content_filter"), "content_filter", 1],
    ["400 审核未通过 (zh gateway)", "openai", 400, oa("输入内容审核未通过"), "content_filter", 1],
    // not content checks: an unrelated bad request that merely says "sensitive" / "safety" stays http
    ["400 case sensitive", "openai", 400, oa("Invalid enum value 'Auto' for 'tool_choice' (values are case sensitive)."), "http", 1],
    ["400 safety_settings parameter", "openai", 400, oa("Invalid JSON payload received. Unknown name \"safety_settings\": Cannot find field.", "invalid_argument"), "http", 1],
    ["400 moderation parameter", "anthropic", 400, an("invalid_request_error", "metadata.moderation: Extra inputs are not permitted"), "http", 1],
    ["400 大小写敏感 (zh)", "openai", 400, oa("参数 model 大小写敏感，请检查"), "http", 1],
    ["500 server", "openai", 500, oa("boom", undefined, "server_error"), "http", 3],
  ];
  for (const [name, protocol, status, body, code, calls] of cases) {
    test(`${name} -> ${code} (${calls === 1 ? "no retry" : "retried"})`, async () => {
      const result = await fail(protocol, status, body);
      expect(result.error).toMatchObject({ code, status });
      expect(result.calls).toBe(calls);
      expect(result.error.toPhrase()).toEqual({ key: LLM_ERROR_PHRASE[result.error.code], params: { status: { type: "number", value: status } } });
      // The body never survives: not on the error, not in the phrase, not in the report line.
      const leaked = JSON.stringify([String(result.error), JSON.stringify(result.error), result.error.toPhrase(), result.reports]);
      for (const word of ["sk-secret", "maximum context", "敏感词", "Insufficient Balance", "temperature", "Entity Too Large"]) expect(leaked).not.toContain(word);
      expect(result.reports.every(r => r.code === code)).toBe(true);
    });
  }

  test("an invalid gateway answer is invalid_response, not a network error (still retried before output)", async () => {
    const fake = fakeFetch(o({ role: "assistant", content: "" }) + sse("[DONE]"));
    const error = await collect(createLlm(registry("openai"), { fetch: fake.fetch, env, sleep: async () => {} }).stream({ ...request, pin })).then(() => null, e => e as LlmError);
    expect(error).toMatchObject({ code: "invalid_response", kind: "network" });
    expect(error!.toPhrase()).toEqual({ key: "system.model_invalid_response" });
    expect(fake.calls).toHaveLength(3);
  });

  test("a transport failure is network; LlmError built from kind/status alone gets the default code", async () => {
    const fake = fakeFetch(() => { throw new Error("socket hang up"); });
    const error = await collect(createLlm(registry("openai"), { fetch: fake.fetch, env, sleep: async () => {} }).stream({ ...request, pin })).then(() => null, e => e as LlmError);
    expect(error).toMatchObject({ code: "network" });
    expect(new LlmError({ kind: "http", status: 401, providerId: "p", modelId: "m", attempts: 1 }).code).toBe("auth");
    expect(new LlmError({ kind: "http", status: 429, providerId: "p", modelId: "m", attempts: 1 }).code).toBe("rate_limit");
    expect(new LlmError({ kind: "http", status: 502, providerId: "p", modelId: "m", attempts: 1 }).toPhrase()).toEqual({ key: "system.model_error", params: { status: { type: "number", value: 502 } } });
  });

  test("every code has a phrase in en and zh-Hans", () => {
    for (const code of LLM_ERROR_CODES) {
      const key = LLM_ERROR_PHRASE[code];
      expect((en.phrases as Record<string, string>)[key]).toBeString();
      expect((zh.phrases as Record<string, string>)[key]).toBeString();
    }
    expect(new Set(Object.values(LLM_ERROR_PHRASE)).size).toBe(LLM_ERROR_CODES.length);
    expect((en.phrases as Record<string, string>)["system.model_invalid_response"]).not.toContain("network");
  });
});
