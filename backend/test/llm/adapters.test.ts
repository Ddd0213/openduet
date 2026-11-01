import { describe, expect, test } from "bun:test";
import { createLlm, LlmError, type ImageBlock, type LlmRequest } from "../../src/llm/index.ts";
import { a, aEnd, aStart, anthropicText, anthropicTool, caps, collect, env, fakeFetch, o, openaiText, openaiTool, registry, request, sse } from "./fixtures.ts";
const tool = { name: "get_time", description: "Get time", inputSchema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } };
const image: ImageBlock = { type: "image", mediaType: "image/png", data: "aGVsbG8=" };
describe("official SDK adapters", () => {
  for (const protocol of ["anthropic", "openai"] as const) {
    const text = protocol === "anthropic" ? anthropicText : openaiText;
    const tools = protocol === "anthropic" ? anthropicTool : openaiTool;
    test(`${protocol}: streams text, assembles canonical assistant, and reports usage`, async () => {
      const fake = fakeFetch(text());
      const events = await collect(createLlm(registry(protocol), { fetch: fake.fetch, env }).stream(request));
      expect(events.slice(0, 2)).toEqual([{ type: "text_delta", text: "Hello " }, { type: "text_delta", text: "世界" }]);
      expect(events[2]).toEqual({ type: "usage", inputTokens: protocol === "anthropic" ? 15 : 11, outputTokens: protocol === "anthropic" ? 7 : 9, estimated: false });
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", message: { role: "assistant", content: [{ type: "text", text: "Hello 世界" }] }, model: { providerId: "test-provider", modelId: "test-model" } });
      expect(fake.calls[0]?.url).toBe(protocol === "anthropic" ? "https://gateway.invalid/v1/messages" : "https://gateway.invalid/v1/chat/completions");
      expect(fake.calls[0]?.headers.get(protocol === "anthropic" ? "x-api-key" : "authorization")).toBe(protocol === "anthropic" ? env.TEST_KEY : `Bearer ${env.TEST_KEY}`);
      expect(fake.calls[0]?.init.redirect).toBe("error");
    });
    test(`${protocol}: joins JSON argument fragments before one tool_call`, async () => {
      const fake = fakeFetch(tools());
      const events = await collect(createLlm(registry(protocol), { fetch: fake.fetch, env }).stream({ ...request, tools: [tool] }));
      expect(events.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_test", name: "get_time", input: { timezone: "UTC" } }]);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", message: { content: [{ type: "tool_use", id: "call_test", name: "get_time", input: { timezone: "UTC" } }] } });
      expect(fake.calls[0]?.body.tools[0]).toMatchObject(protocol === "anthropic" ? { name: tool.name, input_schema: tool.inputSchema } : { type: "function", function: { name: tool.name, parameters: tool.inputSchema } });
    });
    // M14: invalid JSON / non-object arguments no longer fail the turn: the call is kept with input
    // {} and flagged invalid (the runtime answers it with an error result); the raw text never leaks.
    test(`${protocol}: flags invalid JSON and non-object arguments instead of failing`, async () => {
      for (const args of [["{bad"], ["[]"]]) {
        const fake = fakeFetch(tools(args));
        const events = await collect(createLlm(registry(protocol), { fetch: fake.fetch, env, sleep: async () => {} }).stream(request));
        expect(events.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_test", name: "get_time", input: {}, invalid: "arguments" }]);
        expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", message: { content: [{ type: "tool_use", id: "call_test", name: "get_time", input: {} }] } });
        expect(JSON.stringify(events)).not.toContain("{bad");
        expect(fake.calls).toHaveLength(1);
      }
    });
    test(`${protocol}: tool_use, tool_result, and images convert without mutating request`, async () => {
      const input: LlmRequest = { ...request, messages: [
        { role: "user", content: [{ type: "text", text: "look" }, image] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_test", name: "get_time", input: { timezone: "UTC" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "call_test", content: [{ type: "text", text: "tool output" }, image], isError: true }] },
      ] };
      const before = JSON.stringify(input);
      const fake = fakeFetch(text());
      await collect(createLlm(registry(protocol, { ...caps, vision: true, promptCaching: true }), { fetch: fake.fetch, env }).stream(input));
      expect(JSON.stringify(input)).toBe(before);
      const messages = fake.calls[0]!.body.messages;
      if (protocol === "anthropic") {
        expect(messages[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: image.data } });
        expect(messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_test", is_error: true, content: [{ type: "text", text: "tool output" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } }] });
      } else {
        expect(messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } });
        expect(messages[2].tool_calls[0]).toMatchObject({ id: "call_test", function: { name: "get_time", arguments: '{"timezone":"UTC"}' } });
        expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_test", content: "[Tool error]\ntool output" });
        expect(messages[4]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }] });
        expect(JSON.stringify(fake.calls[0]!.body)).not.toContain("cache_control");
      }
    });
    test(`${protocol}: capability gates tools, thinking, caching and server parameters`, async () => {
      const fake = fakeFetch(text());
      await collect(createLlm(registry(protocol, { ...caps, tools: false }), { fetch: fake.fetch, env }).stream({ ...request, role: "utility", tools: [tool], thinking: true, serverTools: ["web_search", "web_fetch"] }));
      const body = fake.calls[0]!.body;
      expect(body.tools).toBeUndefined(); expect(body.thinking).toBeUndefined(); expect(body.reasoning_effort).toBeUndefined(); expect(body.web_search_options).toBeUndefined(); expect(JSON.stringify(body)).not.toContain("cache_control");
      if (protocol === "openai") expect(body.stream_options).toEqual({ include_usage: true });
    });
    test(`${protocol}: nonvision refuses screenshots before any HTTP request`, async () => {
      const fake = fakeFetch(text());
      await expect(collect(createLlm(registry(protocol), { fetch: fake.fetch, env }).stream({ ...request, messages: [{ role: "user", content: [image] }] }))).rejects.toMatchObject({ kind: "config" });
      expect(fake.calls).toHaveLength(0);
    });
    test(`${protocol}: usage omission triggers Latin/CJK estimates`, async () => {
      const fake = fakeFetch(text(false));
      const events = await collect(createLlm(registry(protocol), { fetch: fake.fetch, env }).stream({ ...request, system: "", messages: [{ role: "user", content: [{ type: "text", text: "abcd中文" }] }] }));
      expect(events.find(e => e.type === "usage")).toEqual({ type: "usage", inputTokens: 3, outputTokens: 4, estimated: true });
    });
    test(`${protocol}: thinking is capability gated and replayed only to identical model`, async () => {
      for (const enabled of [false, true]) {
        const fake = fakeFetch(text());
        const input: LlmRequest = { ...request, thinking: true, messages: [{ role: "assistant", content: [
          { type: "thinking", text: "mine", signature: "sig", origin: { providerId: "test-provider", modelId: "test-model" } },
          { type: "thinking", text: "other-provider", signature: "sig", origin: { providerId: "elsewhere", modelId: "test-model" } },
          { type: "thinking", text: "other-model", signature: "sig", origin: { providerId: "test-provider", modelId: "elsewhere" } },
          { type: "thinking", text: "", redacted: "opaque", origin: { providerId: "test-provider", modelId: "test-model" } },
          { type: "text", text: "answer" },
        ] }, ...request.messages] };
        await collect(createLlm(registry(protocol, { ...caps, thinking: enabled }), { fetch: fake.fetch, env }).stream(input));
        const body = fake.calls[0]!.body;
        expect(JSON.stringify(body)).not.toContain("other-provider"); expect(JSON.stringify(body)).not.toContain("other-model");
        if (protocol === "anthropic") {
          expect(body.thinking).toEqual(enabled ? { type: "adaptive" } : undefined);
          expect(body.messages[0].content.some((b: { type: string }) => b.type === "thinking")).toBe(enabled);
          expect(body.messages[0].content.some((b: { type: string }) => b.type === "redacted_thinking")).toBe(enabled);
        } else {
          expect(body.reasoning_effort).toBe(enabled ? "medium" : undefined);
          expect(body.messages[1].reasoning_content).toBe(enabled ? "mine" : undefined);
          expect(JSON.stringify(body)).not.toContain("opaque");
        }
      }
    });
  }
  test("anthropic: signed and redacted thinking are assembled for replay", async () => {
    const body = aStart() + a("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) + a("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "think" } }) + a("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }) + a("content_block_stop", { index: 0 }) + a("content_block_start", { index: 1, content_block: { type: "redacted_thinking", data: "encrypted" } }) + a("content_block_stop", { index: 1 }) + aEnd();
    const fake = fakeFetch(body);
    const events = await collect(createLlm(registry("anthropic", { ...caps, thinking: true }), { fetch: fake.fetch, env }).stream(request));
    expect(events[0]).toEqual({ type: "thinking_delta", text: "think" });
    expect(events.at(-1)).toMatchObject({ message: { content: [{ type: "thinking", text: "think", signature: "sig", origin: { providerId: "test-provider", modelId: "test-model" } }, { type: "thinking", redacted: "encrypted" }] } });
  });
  test("anthropic: a compatible gateway's unsigned thinking block streams and replays", async () => {
    // DeepSeek-style gateways send content_block_start { type: "thinking", thinking } with no signature.
    const body = aStart() + a("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) + a("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "red" } }) + a("content_block_stop", { index: 0 }) + a("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) + a("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Red." } }) + a("content_block_stop", { index: 1 }) + aEnd();
    const config = registry("anthropic", { ...caps, thinking: true });
    const first = fakeFetch(body);
    const events = await collect(createLlm(config, { fetch: first.fetch, env }).stream({ ...request, thinking: true }));
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", message: { content: [{ type: "thinking", text: "red", signature: "" }, { type: "text", text: "Red." }] } });
    if (done?.type !== "done") throw new Error("expected done");
    const second = fakeFetch(anthropicText());
    await collect(createLlm(config, { fetch: second.fetch, env }).stream({ ...request, thinking: true, messages: [...request.messages, done.message, { role: "user", content: [{ type: "text", text: "again" }] }] }));
    expect(second.calls[0]!.body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "red", signature: "" });
  });
  test("anthropic: caching uses three prefix breakpoints, server tools only when requested", async () => {
    const fake = fakeFetch(anthropicText());
    const config = registry("anthropic", { ...caps, promptCaching: true, serverWebTools: true });
    await collect(createLlm(config, { fetch: fake.fetch, env }).stream({ ...request, tools: [tool, { ...tool, name: "second" }], serverTools: ["web_search", "web_fetch"] }));
    const body = fake.calls[0]!.body;
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.filter((t: { cache_control?: unknown }) => t.cache_control)).toHaveLength(1);
    expect(body.tools.slice(-2)).toMatchObject([{ name: "web_search", type: "web_search_20250305" }, { name: "web_fetch", type: "web_fetch_20250910", cache_control: { type: "ephemeral" } }]);
    const unrequested = fakeFetch(anthropicText());
    await collect(createLlm(config, { fetch: unrequested.fetch, env }).stream(request));
    expect(unrequested.calls[0]!.body.tools).toBeUndefined();
  });
  test("anthropic: bearer auth replaces x-api-key and retains extra headers", async () => {
    const config = registry("anthropic"); config.providers[0]!.auth = "bearer"; config.providers[0]!.headers = { "x-custom-gateway": "configured" };
    const fake = fakeFetch(anthropicText());
    await collect(createLlm(config, { fetch: fake.fetch, env }).stream(request));
    expect(fake.calls[0]!.headers.get("authorization")).toBe(`Bearer ${env.TEST_KEY}`);
    expect(fake.calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(fake.calls[0]!.headers.get("x-custom-gateway")).toBe("configured");
  });
  test("openai: interleaved tool indexes are stitched independently", async () => {
    const body = o({ tool_calls: [{ index: 1, id: "second", type: "function", function: { name: "two", arguments: '{"b":' } }, { index: 0, id: "first", type: "function", function: { name: "one", arguments: '{"a":' } }] }) + o({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }) + o({}, "tool_calls") + sse("[DONE]");
    const fake = fakeFetch(body);
    const events = await collect(createLlm(registry(), { fetch: fake.fetch, env }).stream(request));
    expect(events.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "first", name: "one", input: { a: 1 } }, { type: "tool_call", id: "second", name: "two", input: { b: 2 } }]);
  });
  test("openai: a gateway that repeats the final chunk (usage on the second) yields the tool call once", async () => {
    // The shape a real gateway sent (2026-10-27): finish_reason tool_calls twice, usage on the second.
    const last = sse({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 } });
    const body = o({ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "get_time", arguments: "" } }] })
      + o({ role: "assistant", content: "", tool_calls: [{ index: 0, function: { arguments: '{"timezone":"UTC"}' } }] })
      + o({ role: "assistant", content: "" }, "tool_calls") + last + sse("[DONE]");
    const fake = fakeFetch(body);
    const events = await collect(createLlm(registry(), { fetch: fake.fetch, env }).stream({ ...request, tools: [tool] }));
    expect(events.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_test", name: "get_time", input: { timezone: "UTC" } }]);
    expect(events.find(e => e.type === "usage")).toMatchObject({ inputTokens: 11, outputTokens: 9, estimated: false });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", message: { content: [{ type: "tool_use", id: "call_test", name: "get_time", input: { timezone: "UTC" } }] } });
  });
  test("openai: gateway reasoning deltas emit canonical thinking", async () => {
    const fake = fakeFetch(o({ reasoning_content: "think" }) + o({ content: "answer" }, "stop") + sse("[DONE]"));
    const events = await collect(createLlm(registry("openai", { ...caps, thinking: true }), { fetch: fake.fetch, env }).stream(request));
    expect(events[0]).toEqual({ type: "thinking_delta", text: "think" });
    expect(events.at(-1)).toMatchObject({ message: { content: [{ type: "thinking", text: "think", origin: { providerId: "test-provider", modelId: "test-model" } }, { type: "text", text: "answer" }] } });
  });
  test("openai: native search is gated; unsupported native fetch fails safely", async () => {
    const fake = fakeFetch(openaiText());
    const llm = createLlm(registry("openai", { ...caps, serverWebTools: true }), { fetch: fake.fetch, env });
    await collect(llm.stream({ ...request, serverTools: ["web_search"] }));
    expect(fake.calls[0]!.body.web_search_options).toEqual({});
    await expect(collect(llm.stream({ ...request, serverTools: ["web_fetch"] }))).rejects.toMatchObject({ kind: "config" });
    expect(fake.calls).toHaveLength(1);
  });
});
test("native Anthropic server tool blocks remain opaque and replay only to origin", async () => {
  const native = { type: "server_tool_use", id: "srv_call", name: "web_search", input: {} };
  const result = { type: "web_search_tool_result", tool_use_id: "srv_call", content: [{ type: "web_search_result", url: "https://example.invalid", title: "Example", encrypted_content: "opaque" }] };
  const body = aStart() + a("content_block_start", { index: 0, content_block: native }) + a("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"example"}' } }) + a("content_block_stop", { index: 0 }) + a("content_block_start", { index: 1, content_block: result }) + a("content_block_stop", { index: 1 }) + aEnd();
  const fake = fakeFetch(body);
  const llm = createLlm(registry("anthropic", { ...caps, serverWebTools: true }), { fetch: fake.fetch, env });
  const events = await collect(llm.stream(request));
  expect(events.some(e => e.type === "tool_call")).toBe(false);
  const done = events.at(-1)!;
  if (done.type !== "done") throw new Error("Expected done");
  expect(done.message.content[0]).toMatchObject({ type: "provider_data", data: { ...native, input: { query: "example" } } });
  const replay = fakeFetch(anthropicText());
  await collect(createLlm(llm.models, { fetch: replay.fetch, env }).stream({ ...request, messages: [done.message, ...request.messages] }));
  expect(replay.calls[0]!.body.messages[0].content[1]).toEqual(result);
  const other = fakeFetch(openaiText());
  await collect(createLlm(registry("openai", { ...caps, serverWebTools: true }), { fetch: other.fetch, env }).stream({ ...request, messages: [done.message, ...request.messages] }));
  expect(JSON.stringify(other.calls[0]!.body)).not.toContain("encrypted_content");
});
test("stop reasons normalize refusal and maximum-token stops on both protocols", async () => {
  for (const protocol of ["anthropic", "openai"] as const) for (const [native, canonical] of protocol === "anthropic" ? [["refusal", "refusal"], ["max_tokens", "max_tokens"]] : [["content_filter", "refusal"], ["length", "max_tokens"]]) {
    const fake = fakeFetch(protocol === "anthropic" ? aStart() + aEnd(native) : o({}, native) + sse("[DONE]"));
    expect((await collect(createLlm(registry(protocol), { fetch: fake.fetch, env }).stream(request))).at(-1)).toMatchObject({ stopReason: canonical });
  }
});
test("openai output token limit uses only the gateway-compatible field", async () => {
  for (const thinking of [true, false]) {
    const fake = fakeFetch(openaiText());
    await collect(createLlm(registry("openai", { ...caps, thinking }), { fetch: fake.fetch, env }).stream({ ...request, maxTokens: 9000 }));
    expect(fake.calls[0]!.body[thinking ? "max_completion_tokens" : "max_tokens"]).toBe(8192);
    expect(fake.calls[0]!.body[thinking ? "max_tokens" : "max_completion_tokens"]).toBeUndefined();
  }
});
test("openai: parallel tool results keep tool messages contiguous; their images follow in one user message", async () => {
  const shot = (data: string): ImageBlock => ({ ...image, data });
  const input: LlmRequest = { ...request, messages: [
    { role: "user", content: [{ type: "text", text: "compare" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "call_a", name: "get_time", input: { timezone: "UTC" } },
      { type: "tool_use", id: "call_b", name: "get_time", input: { timezone: "Asia/Shanghai" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", toolUseId: "call_a", content: [{ type: "text", text: "a" }, shot("QQ==")] },
      { type: "tool_result", toolUseId: "call_b", content: [{ type: "text", text: "b" }, shot("Qg==")] },
      { type: "text", text: "which is later?" },
    ] },
  ] };
  const fake = fakeFetch(openaiText());
  await collect(createLlm(registry("openai", { ...caps, vision: true }), { fetch: fake.fetch, env }).stream(input));
  const roles = fake.calls[0]!.body.messages.map((m: { role: string }) => m.role);
  expect(roles).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
  expect(fake.calls[0]!.body.messages[5].content).toEqual([
    { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,Qg==" } },
    { type: "text", text: "which is later?" },
  ]);
});
