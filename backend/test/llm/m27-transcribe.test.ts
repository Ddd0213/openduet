import { expect, spyOn, test } from "bun:test";
import { anthropicParams } from "../../src/llm/adapters/anthropic.ts";
import { openaiParams } from "../../src/llm/adapters/openai.ts";
import { UnsupportedRequest } from "../../src/llm/errors.ts";
import { transcribe, type AdapterContext, type TranscriptionTarget } from "../../src/llm/index.ts";
import { captureOutput } from "../channels/harness.ts";
import { wav } from "../calls/wav-fixtures.ts";
import { fakeFetch, o, openaiText, response, sse } from "./fixtures.ts";

const target: TranscriptionTarget = { transcription: "asr_sse", provider: { id: "voice", protocol: "openai", baseUrl: "https://api.stepfun.ai/v1" }, modelId: "test-asr", key: "test-secret-must-not-leak", transcriptionPath: "/audio/asr/sse" };
const options = { language: "zh" };
const done = (text = "  今天很好  ") => sse({ type: "transcript.text.done", text });
const chat = { ...target, transcription: "chat_audio" as const, transcriptionPath: null, provider: { ...target.provider, baseUrl: "https://google.invalid/v1", reasoningOff: "none" as const } };

test("audio maps to OpenAI input_audio without vision; Anthropic refuses and assistant audio is not dropped", () => {
  const ctx: AdapterContext = { provider: target.provider, apiKey: target.key, timeoutMs: 60000, model: { id: "a", provider: "voice", label: "A", contextWindow: 128000, maxOutputTokens: 8192, capabilities: { tools: false, vision: false, thinking: false, serverWebTools: false, promptCaching: false } } };
  const request = { role: "utility" as const, system: "Transcribe", messages: [{ role: "user" as const, content: [{ type: "audio" as const, format: "wav" as const, data: "YWJj" }] }] };
  expect(openaiParams(request, ctx).messages[1]).toEqual({ role: "user", content: [{ type: "input_audio", input_audio: { data: "YWJj", format: "wav" } }] });
  expect(() => anthropicParams(request, { ...ctx, provider: { ...ctx.provider, protocol: "anthropic" } })).toThrow(UnsupportedRequest);
  expect(() => openaiParams({ ...request, messages: [{ ...request.messages[0]!, role: "assistant" }] }, ctx)).toThrow(UnsupportedRequest);
});

test("chat_audio uses one model, fixed instruction, language hint, no tools and thinking off; joins deltas and trims", async () => {
  const f = fakeFetch(openaiText());
  expect(await transcribe(chat, wav(), { language: "de", fetch: f.fetch })).toBe("Hello 世界");
  expect(f.calls).toHaveLength(1);
  const c = f.calls[0]!;
  expect(c.url).toBe("https://google.invalid/v1/chat/completions");
  expect(c.body.model).toBe("test-asr"); expect(c.body.tools).toBeUndefined(); expect(c.body.reasoning_effort).toBe("none");
  expect(c.body.messages[0].content).toContain("Language hint: de");
  expect(c.body.messages[1].content[0]).toEqual({ type: "input_audio", input_audio: { data: wav().toString("base64"), format: "wav" } });
  const silent = fakeFetch(o({}, "stop") + sse("[DONE]"));
  expect(await transcribe(chat, wav(), { ...options, fetch: silent.fetch })).toBe("");
});

test("ASR SSE request/body, delta ignored, final done text, CRLF and chunk boundaries", async () => {
  const f = fakeFetch((c) => {
    expect(c.init.redirect).toBe("error"); expect(c.init.signal).toBeDefined();
    expect(c.headers.get("authorization")).toBe(`Bearer ${target.key}`); expect(c.headers.get("x-api-key")).toBeNull();
    expect(c.headers.get("accept")).toBe("text/event-stream");
    const bytes = new TextEncoder().encode((": ping\n\n" + sse({ type: "transcript.text.delta", delta: "ignored" }) + done()).replaceAll("\n", "\r\n"));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }));
  });
  expect(await transcribe(target, wav(), { ...options, fetch: f.fetch })).toBe("今天很好");
  expect(f.calls[0]!.url).toBe("https://api.stepfun.ai/v1/audio/asr/sse");
  expect(f.calls[0]!.body).toEqual({ audio: { data: wav().toString("base64"), input: { transcription: { model: "test-asr", language: "zh", enable_itn: true }, format: { type: "wav" } } } });
  expect(await transcribe(target, wav(), { ...options, fetch: fakeFetch(sse({ text: "" }, "transcript.text.done")).fetch })).toBe("");
});

test("SSE error / missing done / malformed done fail without body or secret leakage, with one attempt", async () => {
  const logs = captureOutput();
  try {
    for (const body of [sse({ error: target.key }, "error"), sse({ type: "error", message: target.key }), done() + sse({ message: target.key }, "error"), sse({ type: "transcript.text.delta", delta: target.key }), sse({ type: "transcript.text.done", text: 4 })]) {
      const f = fakeFetch(body);
      try { await transcribe(target, wav(), { ...options, fetch: f.fetch }); throw new Error("must fail"); }
      catch (e) { expect(e).toMatchObject({ name: "LlmError", code: "invalid_response", attempts: 1 }); expect(String(e)).not.toContain(target.key); }
      expect(f.calls).toHaveLength(1);
    }
    for (const [status, code] of [[401, "auth"], [429, "rate_limit"], [500, "http"], [302, "http"]] as const) {
      const f = fakeFetch(() => new Response(target.key, { status, headers: { Location: "https://evil.invalid" } }));
      await expect(transcribe(target, wav(), { ...options, fetch: f.fetch })).rejects.toMatchObject({ code, status });
      expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.redirect).toBe("error");
    }
    expect(logs.text()).not.toContain(target.key); expect(logs.text()).toBe("");
  } finally { logs.stop(); }
});

test("one 60 s deadline covers ASR headers/body and chat retries, even uncooperative transports", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const durations: number[] = [];
  const mock = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { durations.push(ms); return timeout(20); });
  try {
    for (const f of [fakeFetch(() => new Promise<Response>(() => {})), fakeFetch(() => new Response(new ReadableStream({ start() {} })))]) {
      await expect(transcribe(target, wav(), { ...options, fetch: f.fetch })).rejects.toMatchObject({ code: "timeout" });
      expect(f.calls).toHaveLength(1);
    }
    const retried = fakeFetch(() => new Response("no", { status: 429 }));
    await expect(transcribe(chat, wav(), { ...options, fetch: retried.fetch })).rejects.toMatchObject({ code: "timeout" });
    expect(retried.calls).toHaveLength(1);
    expect(durations).toEqual([60000, 60000, 60000]);
  } finally { mock.mockRestore(); }
});

test("chat retries before output stay on the same model; failures never log body/key", async () => {
  const logs = captureOutput();
  try {
    const f = fakeFetch((_c, index) => index === 0 ? new Response(target.key, { status: 503, headers: { "retry-after": "0" } }) : response(openaiText()));
    expect(await transcribe(chat, wav(), { ...options, fetch: f.fetch })).toBe("Hello 世界");
    expect(f.calls).toHaveLength(2); expect(f.calls.every(c => c.body.model === target.modelId)).toBe(true);
    const bad = fakeFetch(() => new Response(target.key, { status: 401 }));
    await expect(transcribe(chat, wav(), { ...options, fetch: bad.fetch })).rejects.toMatchObject({ code: "auth" });
    expect(logs.text()).toBe("");
  } finally { logs.stop(); }
});
