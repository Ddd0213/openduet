import { describe, expect, test } from "bun:test";
import { createLlm, LlmError } from "../../src/llm/index.ts";
import { retryDelay } from "../../src/llm/stream.ts";
import { a, aEnd, aStart, anthropicText, collect, env, fakeFetch, o, oUsage, openaiText, openaiTool, registry, request, response, sse } from "./fixtures.ts";
function chain(protocol: "anthropic" | "openai" = "openai") {
  const config = registry(protocol);
  config.models.push({ ...config.models[0]!, id: "fallback" });
  for (const role of ["chat", "task", "proactive", "utility"] as const) config.roles[role] = ["test-model", "fallback"];
  return config;
}
describe("stream reliability", () => {
  for (const protocol of ["anthropic", "openai"] as const) {
    const good = protocol === "anthropic" ? anthropicText : openaiText;
    test(`${protocol}: retries 429/5xx/network twice then falls back before first yield`, async () => {
      for (const status of [429, 503, 0]) {
        const waits: number[] = [], fake = fakeFetch((call) => {
          if (call.body.model === "fallback") return response(good());
          if (!status) throw new Error(`network leaked ${env.TEST_KEY}`);
          return new Response(JSON.stringify({ error: { message: `leaked ${env.TEST_KEY}`, type: "error" } }), { status });
        });
        const llm = createLlm(chain(protocol), { fetch: fake.fetch, env, sleep: async ms => { waits.push(ms); }, random: () => 0.5 });
        const events = await collect(llm.stream(request));
        expect(fake.calls.map(c => c.body.model)).toEqual(["test-model", "test-model", "test-model", "fallback"]);
        expect(waits).toEqual([500, 1000]);
        expect(events.at(-1)).toMatchObject({ model: { modelId: "fallback" } });
        expect(llm.roleModels("task").map(m => m.id)).toEqual(["test-model", "fallback"]);
        expect(JSON.stringify(events)).not.toContain(env.TEST_KEY);
      }
    });
    test(`${protocol}: 401/400 falls back immediately without same-model retries`, async () => {
      for (const status of [401, 400]) {
        const fake = fakeFetch((_, index) => index === 0 ? new Response("secret body", { status }) : response(good()));
        const events = await collect(createLlm(chain(protocol), { fetch: fake.fetch, env, sleep: async () => { throw new Error("must not sleep"); } }).stream(request));
        expect(fake.calls).toHaveLength(2);
        expect(events.at(-1)).toMatchObject({ model: { modelId: "fallback" } });
      }
    });
    test(`${protocol}: pin never falls back; errors have safe metadata and phrases`, async () => {
      const fake = fakeFetch(() => new Response(JSON.stringify({ error: { message: env.TEST_KEY } }), { status: 401 }));
      try { await collect(createLlm(chain(protocol), { fetch: fake.fetch, env }).stream({ ...request, pin: { providerId: "test-provider", modelId: "test-model" } })); throw new Error("expected error"); }
      catch (error) {
        expect(error).toBeInstanceOf(LlmError);
        const e = error as LlmError;
        expect(e).toMatchObject({ kind: "http", code: "auth", status: 401, providerId: "test-provider", modelId: "test-model", attempts: 1 });
        // M14a B2: a 401 has its own phrase key (was system.model_error).
        expect(e.toPhrase()).toEqual({ key: "system.model_auth", params: { status: { type: "number", value: 401 } } });
        expect(String(e)).not.toContain(env.TEST_KEY); expect(JSON.stringify(e)).not.toContain(env.TEST_KEY); expect("cause" in e).toBe(false);
      }
      expect(fake.calls).toHaveLength(1);
    });
    test(`${protocol}: partial output then stream error fails with no retry or fallback`, async () => {
      const partial = protocol === "anthropic" ? aStart() + a("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } }) + a("error", { error: { type: "overloaded_error", message: env.TEST_KEY } }) : o({ content: "partial" }) + sse({ error: { message: env.TEST_KEY, code: "server_error" } });
      const fake = fakeFetch(partial);
      const events = [];
      try { for await (const event of createLlm(chain(protocol), { fetch: fake.fetch, env }).stream(request)) events.push(event); throw new Error("expected error"); }
      catch (error) { expect(error).toBeInstanceOf(LlmError); expect(String(error)).not.toContain(env.TEST_KEY); }
      expect(events).toEqual([{ type: "text_delta", text: "partial" }]); expect(fake.calls).toHaveLength(1);
    });
    // M14a B1: an openai-protocol stream that ends cleanly after text but without finish_reason is an
    // end_turn (some gateways never send one); anthropic without message_stop stays invalid.
    test(`${protocol}: truncated SSE after partial text is ${protocol === "anthropic" ? "not successful done" : "end_turn (gateway without finish_reason)"}`, async () => {
      const body = protocol === "anthropic" ? aStart() + a("content_block_start", { index: 0, content_block: { type: "text", text: "partial" } }) : o({ content: "partial" });
      const fake = fakeFetch(body);
      const events = collect(createLlm(chain(protocol), { fetch: fake.fetch, env }).stream(request));
      if (protocol === "anthropic") await expect(events).rejects.toMatchObject({ kind: "network", attempts: 1 });
      else expect((await events).at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", message: { content: [{ type: "text", text: "partial" }] } });
      expect(fake.calls).toHaveLength(1);
    });
  }
  test("Retry-After seconds/date are obeyed; jitter is deterministic when injected", async () => {
    const waits: number[] = [], fake = fakeFetch((_, index) => index < 2 ? new Response("limited", { status: 429, headers: { "retry-after": "3" } }) : response(openaiText()));
    await collect(createLlm(registry(), { fetch: fake.fetch, env, sleep: async ms => { waits.push(ms); } }).stream(request));
    expect(waits).toEqual([3000, 3000]);
    expect(retryDelay(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" }), 0, () => 1000, () => 0)).toBe(9000);
    expect(retryDelay(undefined, 1, () => 0, () => 0)).toBe(500);
  });
  test("timeout covers stalled SSE reader and does not retry after output", async () => {
    const config = chain(); config.timeoutMs = 15;
    const fake = fakeFetch(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(o({ content: "partial" }))); } }), { headers: { "content-type": "text/event-stream" } }));
    await expect(collect(createLlm(config, { fetch: fake.fetch, env }).stream(request))).rejects.toMatchObject({ kind: "timeout", attempts: 1 });
    expect(fake.calls).toHaveLength(1);
  });
  test("timeout covers non-cooperative connection; two retries then failure", async () => {
    const config = registry(); config.timeoutMs = 10;
    const fake = fakeFetch(() => new Promise<Response>(() => {}));
    await expect(collect(createLlm(config, { fetch: fake.fetch, env, sleep: async () => {} }).stream(request))).rejects.toMatchObject({ kind: "timeout", attempts: 3 });
    expect(fake.calls).toHaveLength(3);
  });
  test("timeout is an idle deadline: a long stream that keeps sending bytes completes", async () => {
    // 9 chunks 25 ms apart (~225 ms total) under a 100 ms deadline. Most chunks are
    // partial tool JSON, so only raw bytes (not canonical events) prove liveness.
    const config = chain(); config.timeoutMs = 100;
    const pieces = openaiTool(["{", "\"time", "zone", "\":", "\"U", "TC", "\"}"]).split(/(?<=\n\n)/);
    const fake = fakeFetch(() => new Response(new ReadableStream({ async start(controller) {
      for (const piece of pieces) { await Bun.sleep(25); controller.enqueue(new TextEncoder().encode(piece)); }
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } }));
    const events = await collect(createLlm(config, { fetch: fake.fetch, env }).stream(request));
    expect(events.find(e => e.type === "tool_call")).toMatchObject({ input: { timezone: "UTC" } });
    expect(fake.calls).toHaveLength(1);
  });
  test("a slow consumer does not trip the idle deadline", async () => {
    const config = chain(); config.timeoutMs = 30;
    const fake = fakeFetch(openaiText());
    const events = [];
    for await (const event of createLlm(config, { fetch: fake.fetch, env }).stream(request)) { events.push(event); await Bun.sleep(60); }
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
  });
  test("external abort does not retry/fallback; empty pin is config error", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => { controller.abort(); return new Promise<Response>(() => {}); });
    await expect(collect(createLlm(chain(), { fetch: fake.fetch, env }).stream({ ...request, signal: controller.signal }))).rejects.toMatchObject({ kind: "network", attempts: 1 });
    expect(fake.calls).toHaveLength(1);
    await expect(collect(createLlm(chain(), { fetch: fake.fetch, env }).stream({ ...request, pin: { providerId: "missing", modelId: "missing" } }))).rejects.toMatchObject({ kind: "config", attempts: 0 });
  });
  describe("failed attempts are reported with safe fields only", () => {
    const drain = async (events: AsyncIterable<unknown>) => { const got: unknown[] = []; try { for await (const e of events) got.push(e); } catch (error) { return { got, error }; } return { got, error: undefined }; };
    test("anthropic: an SSE error event after output names its type, no retry", async () => {
      const reports: Record<string, unknown>[] = [];
      const body = aStart() + a("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
        + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } })
        + sse({ type: "error", error: { type: "overloaded_error", message: `upstream busy ${env.TEST_KEY}` } }, "error");
      const fake = fakeFetch(() => response(body));
      const { got, error } = await drain(createLlm(chain("anthropic"), { fetch: fake.fetch, env, report: f => reports.push(f) }).stream(request));
      expect(got.length).toBeGreaterThan(0);
      expect(error).toMatchObject({ kind: "network", attempts: 1 });
      expect(fake.calls).toHaveLength(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ provider: "test-provider", model: "test-model", role: "chat", attempt: 1, kind: "network", status: null, afterOutput: true, aborted: false, cause: { type: "overloaded_error" } });
      expect(JSON.stringify(reports)).not.toContain(env.TEST_KEY);
      expect(JSON.stringify(reports)).not.toContain("upstream busy");
    });
    test("anthropic: a stream cut before message_stop is reported as incomplete", async () => {
      const reports: Record<string, unknown>[] = [];
      const body = aStart() + a("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "cut" } });
      const fake = fakeFetch(() => response(body));
      const { error } = await drain(createLlm(chain("anthropic"), { fetch: fake.fetch, env, report: f => reports.push(f) }).stream(request));
      expect(error).toMatchObject({ kind: "network" });
      expect(reports[0]).toMatchObject({ afterOutput: true, cause: { class: "InvalidModelResponse", where: "incomplete" } });
    });
    for (const protocol of ["anthropic", "openai"] as const) test(`${protocol}: transport errors before output are reported per attempt without their message`, async () => {
      const reports: Record<string, unknown>[] = [];
      const fake = fakeFetch((call) => {
        if (call.body.model === "fallback") return response(protocol === "anthropic" ? anthropicText() : openaiText());
        throw Object.assign(new Error(`socket closed ${env.TEST_KEY}`), { code: "ECONNRESET" });
      });
      const events = await collect(createLlm(chain(protocol), { fetch: fake.fetch, env, sleep: async () => {}, report: f => reports.push(f) }).stream(request));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(reports.map(r => r.attempt)).toEqual([1, 2, 3]);
      expect(reports.every(r => r.kind === "network" && r.afterOutput === false)).toBe(true);
      expect(JSON.stringify(reports)).not.toContain(env.TEST_KEY);
      expect(JSON.stringify(reports)).not.toContain("socket closed");
    });
    test("a cause that would echo the key is dropped", async () => {
      const reports: Record<string, unknown>[] = [];
      const fake = fakeFetch(() => { throw Object.assign(new Error("x"), { code: env.TEST_KEY.replace(/-/g, "_") }); });
      const keyEnv = { ...env, TEST_KEY: env.TEST_KEY.replace(/-/g, "_") };
      await drain(createLlm(registry("openai"), { fetch: fake.fetch, env: keyEnv, sleep: async () => {}, report: f => reports.push(f) }).stream(request));
      expect(reports.length).toBe(3);
      expect(reports.every(r => r.cause === null)).toBe(true);
      expect(JSON.stringify(reports)).not.toContain(keyEnv.TEST_KEY);
    });
  });
  describe("a tool call cut off by max_tokens", () => {
    const toolStart = (index: number) => a("content_block_start", { index, content_block: { type: "tool_use", id: `call_${index}`, name: "write_file", input: {} } });
    const toolJson = (index: number, partial_json: string) => a("content_block_delta", { index, delta: { type: "input_json_delta", partial_json } });
    const textBlock = a("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "写入中" } }) + a("content_block_stop", { index: 0 });
    test("anthropic: dropped from the message and counted; a complete call before it is kept", async () => {
      for (const stopped of [true, false]) {
        const body = aStart() + textBlock
          + toolStart(1) + toolJson(1, '{"path":"a.md","content":"ok"}') + a("content_block_stop", { index: 1 })
          + toolStart(2) + toolJson(2, '{"path":"b.md","content":"very long') + (stopped ? a("content_block_stop", { index: 2 }) : "")
          + aEnd("max_tokens");
        const events = await collect(createLlm(registry("anthropic"), { fetch: fakeFetch(body).fetch, env }).stream(request));
        expect(events.filter(e => e.type === "tool_call").map(e => (e as { id: string }).id)).toEqual(["call_1"]);
        const done = events.at(-1) as { type: string; stopReason: string; droppedTools?: number; message: { content: { type: string; id?: string }[] } };
        expect(done).toMatchObject({ type: "done", stopReason: "max_tokens", droppedTools: 1 });
        expect(done.message.content.map(b => b.id ?? b.type)).toEqual(["text", "call_1"]);
      }
    });
    // M14a B1: broken tool JSON without a max_tokens stop is kept as an invalid-arguments call (the
    // runtime answers it with an error result) instead of failing the turn.
    test("anthropic: broken tool JSON without a max_tokens stop is flagged invalid, not a failed turn", async () => {
      const reports: Record<string, unknown>[] = [];
      const body = aStart() + toolStart(0) + toolJson(0, '{"path":') + a("content_block_stop", { index: 0 }) + aEnd("tool_use");
      const fake = fakeFetch(body);
      const events = await collect(createLlm(registry("anthropic"), { fetch: fake.fetch, env, sleep: async () => {}, report: f => reports.push(f) }).stream(request));
      expect(events.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_0", name: "write_file", input: {}, invalid: "arguments" }]);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
      expect(reports).toHaveLength(0);
    });
    test("openai: a call cut off by finish_reason length is dropped and counted", async () => {
      const body = o({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "write_file", arguments: '{"path":"a.md","content":"lo' } }] })
        + o({ tool_calls: [{ index: 0, function: { arguments: "ng" } }] }) + o({}, "length") + oUsage() + sse("[DONE]");
      const events = await collect(createLlm(registry("openai"), { fetch: fakeFetch(body).fetch, env }).stream(request));
      expect(events.some(e => e.type === "tool_call")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens", droppedTools: 1, message: { content: [] } });
    });
    test("openai: broken arguments with finish_reason tool_calls are flagged invalid (M14a); complete calls report no drops", async () => {
      const broken = o({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "write_file", arguments: '{"path":' } }] }) + o({}, "tool_calls") + oUsage() + sse("[DONE]");
      const flagged = await collect(createLlm(registry("openai"), { fetch: fakeFetch(broken).fetch, env, sleep: async () => {} }).stream(request));
      expect(flagged.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_0", name: "write_file", input: {}, invalid: "arguments" }]);
      expect((flagged.at(-1) as { droppedTools?: number }).droppedTools).toBeUndefined();
      const events = await collect(createLlm(registry("openai"), { fetch: fakeFetch(openaiTool()).fetch, env }).stream(request));
      expect((events.at(-1) as { droppedTools?: number }).droppedTools).toBeUndefined();
    });
  });
  // M14a B2: each code has its own phrase key (was system.model_unreachable with an English reason).
  test("unreachable phrases are one fixed key per code, no free text", () => {
    for (const kind of ["timeout", "network", "config"] as const) expect(new LlmError({ kind, providerId: "p", modelId: "m", attempts: 3 }).toPhrase()).toEqual({ key: `system.model_${kind}` });
  });
});
