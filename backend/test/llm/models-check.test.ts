import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { checkModels, runModelsCheck } from "../../src/cli/models-check.ts";
import { loadModelConfig } from "../../src/llm/index.ts";
import { anthropicText, anthropicTool, caps, env, fakeFetch, openaiText, openaiTool, rawConfig, registry, response, settings } from "./fixtures.ts";
const serverEnv = { PUBLIC_URL: "http://localhost:3000", DATABASE_URL: "file:test.db", BETTER_AUTH_SECRET: "01234567890123456789012345678901", ...env, MODEL_CHAT: "test-model" };
test("models:check table probes every model with protocol-specific SSE and vision PNG", async () => {
  const raw = rawConfig("anthropic", { ...caps, vision: true });
  const second = rawConfig("openai");
  raw.providers.push({ ...second.providers[0]!, id: "openai-provider" });
  raw.models.push({ ...second.models[0]!, id: "second-model", provider: "openai-provider" });
  const config = loadModelConfig({ ...settings, MODEL_CHAT: "test-model,second-model", MODEL_TASK: "second-model" }, env, () => JSON.stringify(raw));
  const fake = fakeFetch(call => {
    const anthropic = call.url.endsWith("/messages");
    if (call.body.tools) return response(anthropic ? anthropicTool() : openaiTool());
    return response(anthropic ? anthropicText() : openaiText());
  });
  const lines: string[] = [];
  const result = await checkModels(config, { fetch: fake.fetch, env }, line => lines.push(line));
  expect(result.exitCode).toBe(0); expect(fake.calls).toHaveLength(5);
  expect(result.rows[0]).toMatchObject({ model: "test-model", protocol: "anthropic", reachable: true, streaming: true, toolCalls: true, usageReported: true, vision: true, passed: true });
  expect(result.rows[1]?.vision).toBe("n/a");
  expect(lines.join("\n")).toContain("usage reported"); expect(lines.join("\n")).toContain("chat: test-model -> second-model"); expect(lines.join("\n")).toContain("task: second-model");
  expect(lines.join("\n")).not.toContain(env.TEST_KEY);
  const vision = fake.calls.find(call => JSON.stringify(call.body).includes('"type":"image"'))!;
  expect(vision.body.messages[0].content[1].source.data).toStartWith("iVBORw0KGgo");
  const png = Buffer.from(vision.body.messages[0].content[1].source.data, "base64");
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length))).toBe(png.readUInt32BE(offset + 8 + length));
    if (png.subarray(offset + 4, offset + 8).toString() === "IDAT") expect(inflateSync(png.subarray(offset + 8, offset + 8 + length))).toEqual(Buffer.from([0, 255, 0, 0]));
    offset += 12 + length;
  }
});
test("models:check requires valid get_time args, not just arbitrary tool JSON", async () => {
  for (const args of [["{}"], ['{"timezone":3}']]) {
    const fake = fakeFetch(call => response(call.body.tools ? openaiTool(args) : openaiText()));
    const result = await checkModels(registry(), { fetch: fake.fetch, env }, () => {});
    expect(result.rows[0]?.toolCalls).toBe(false); expect(result.exitCode).toBe(1);
  }
});
test("models:check reports missing usage without failing otherwise supported models", async () => {
  const fake = fakeFetch(call => response(call.body.tools ? openaiTool().replace(/data: .*"choices":\[\],"usage":.*\n\n/, "") : openaiText(false)));
  const result = await checkModels(registry(), { fetch: fake.fetch, env }, () => {});
  expect(result.rows[0]?.usageReported).toBe(false); expect(result.exitCode).toBe(0);
});
test("models:check exits nonzero for preferred failures; failing fallback alone is nonfatal", async () => {
  const config = registry(); config.models.push({ ...config.models[0]!, id: "fallback" }); config.roles.chat.push("fallback");
  const fake = fakeFetch(call => call.body.model === "fallback" ? new Response(env.TEST_KEY, { status: 401 }) : response(call.body.tools ? openaiTool() : openaiText()));
  const lines: string[] = [];
  expect((await checkModels(config, { fetch: fake.fetch, env }, line => lines.push(line))).exitCode).toBe(0);
  config.roles.task = ["fallback"];
  expect((await checkModels(config, { fetch: fake.fetch, env }, () => {})).exitCode).toBe(1);
  expect(lines.join("\n")).toContain("HTTP 401"); expect(lines.join("\n")).not.toContain(env.TEST_KEY);
});
test("models:check load errors name fields and never make requests", async () => {
  const fake = fakeFetch(openaiText());
  const lines: string[] = [];
  expect(await runModelsCheck({ env: serverEnv, readFile: () => "{", fetch: fake.fetch, write: line => lines.push(line) })).toBe(1);
  expect(lines.join("\n")).toContain("valid JSON"); expect(fake.calls).toHaveLength(0);
});
test("models:check entry function accepts env/readFile/fetch injection", async () => {
  const fake = fakeFetch(call => response(call.body.tools ? openaiTool() : openaiText()));
  expect(await runModelsCheck({ env: serverEnv, readFile: () => JSON.stringify(rawConfig()), fetch: fake.fetch, write: () => {} })).toBe(0);
  expect(fake.calls).toHaveLength(2);
});
