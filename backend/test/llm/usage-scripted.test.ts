import { expect, test } from "bun:test";
import { estimateTokens, LlmError } from "../../src/llm/index.ts";
import { UsageTracker } from "../../src/llm/usage.ts";
import { ScriptedModel } from "../helpers/scripted-model.ts";
import { collect, request } from "./fixtures.ts";
test("token estimates distinguish Latin, Chinese, kana, Hangul, fullwidth punctuation", () => {
  expect(estimateTokens("")).toBe(0); expect(estimateTokens("abcdefgh")).toBe(2); expect(estimateTokens("你好世界")).toBe(4); expect(estimateTokens("あア한，。！")).toBe(6); expect(estimateTokens("abcd你好")).toBe(3);
});
test("anthropic delta usage updates cached input counts; malformed counts are ignored", () => {
  const usage = new UsageTracker();
  usage.anthropic({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
  usage.anthropic({ output_tokens: 9, cache_creation_input_tokens: 4 });
  expect(usage.finish(request, [])).toEqual({ inputTokens: 17, outputTokens: 9, estimated: false });
  usage.anthropic({ input_tokens: -1, output_tokens: "bad" });
  expect(usage.finish(request, []).outputTokens).toBe(9);
});
test("partial OpenAI usage retains reported counts and estimates missing output", () => {
  const usage = new UsageTracker(); usage.openai({ prompt_tokens: 0 });
  expect(usage.finish(request, [{ type: "text", text: "你好" }])).toEqual({ inputTokens: 0, outputTokens: 2, estimated: true });
});
test("scripted turns record snapshots and accept request-aware scripts and stop reasons", async () => {
  const model = new ScriptedModel([
    input => { expect(input.system).toBe("Be helpful."); expect(input.tools).toHaveLength(1); return [{ type: "text_delta", text: "hello" }, { type: "tool_call", id: "call", name: "test", input: { x: 1 } }, { type: "usage", inputTokens: 2, outputTokens: 3, estimated: false }, { type: "stop", stopReason: "tool_use" }]; },
    [{ type: "text_delta", text: "done" }],
    new LlmError({ kind: "timeout", providerId: "test", modelId: "test", attempts: 1 }),
  ]);
  const input = { ...request, tools: [{ name: "test", description: "test", inputSchema: { type: "object" } }] };
  const events = await collect(model.stream(input));
  expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "test", input: { x: 1 } }] } });
  input.system = "changed"; expect(model.requests[0]?.system).toBe("Be helpful.");
  expect((await collect(model.stream(request))).at(-1)).toMatchObject({ stopReason: "end_turn" });
  await expect(collect(model.stream(request))).rejects.toBeInstanceOf(LlmError);
  expect(model.requests).toHaveLength(3);
});
test("scripted partial-output errors and AbortSignal requests are supported", async () => {
  const failure = new LlmError({ kind: "network", providerId: "test", modelId: "test", attempts: 1 });
  const model = new ScriptedModel([[{ type: "text_delta", text: "partial" }, failure]]);
  const signal = new AbortController().signal;
  const iterator = model.stream({ ...request, signal })[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "partial" });
  await expect(iterator.next()).rejects.toBe(failure);
  expect(model.requests[0]?.signal).toBe(signal);
});
