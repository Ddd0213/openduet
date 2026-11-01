// M14a B1: OpenAI-compatible gateway quirks (nanomuse-findings G5) are tolerated instead of failing the turn.
import { describe, expect, test } from "bun:test";
import { createLlm, LlmError } from "../../src/llm/index.ts";
import { ThinkSplitter } from "../../src/llm/adapters/think.ts";
import { a, aEnd, aStart, caps, collect, env, fakeFetch, o, oUsage, registry, request, sse } from "./fixtures.ts";

const tool = { name: "get_time", description: "Get time", inputSchema: { type: "object", properties: {} } };
const run = (body: string, capabilities = caps) => collect(createLlm(registry("openai", capabilities), { fetch: fakeFetch(body).fetch, env, sleep: async () => {} }).stream({ ...request, tools: [tool] }));
const texts = (events: Awaited<ReturnType<typeof run>>) => events.flatMap(e => (e.type === "text_delta" ? [e.text] : [])).join("");
const thoughts = (events: Awaited<ReturnType<typeof run>>) => events.flatMap(e => (e.type === "thinking_delta" ? [e.text] : [])).join("");

describe("openai gateway tolerance", () => {
  test("the first non-empty id wins when a gateway resends it on every fragment", async () => {
    const body = o({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_time", arguments: '{"x":' } }] })
      + o({ tool_calls: [{ index: 0, id: "call_a", function: { arguments: "1}" } }] }) + o({}, "tool_calls") + sse("[DONE]");
    const events = await run(body);
    expect(events.filter(e => e.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_a", name: "get_time", input: { x: 1 } }]);
  });

  test("a call with a name but no id gets call_<random>; empty arguments are {}", async () => {
    const body = o({ tool_calls: [{ index: 0, type: "function", function: { name: "get_time", arguments: "" } }] }) + o({}, "tool_calls") + sse("[DONE]");
    const events = await run(body);
    const call = events.find(e => e.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", name: "get_time", input: {} });
    expect(call?.type === "tool_call" && call.invalid).toBeFalsy();
    expect(call?.type === "tool_call" && /^call_[0-9a-f]{32}$/.test(call.id)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: [{ type: "tool_use", id: call?.type === "tool_call" ? call.id : "", input: {} }] } });
  });

  test("a call with no name is still an invalid response, but dropped under max_tokens", async () => {
    const nameless = o({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { arguments: "{}" } }] });
    await expect(run(nameless + o({}, "tool_calls") + sse("[DONE]"))).rejects.toBeInstanceOf(LlmError);
    const cut = await run(nameless + o({}, "length") + sse("[DONE]"));
    expect(cut.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens", droppedTools: 1 });
  });

  test("invalid arguments under max_tokens are dropped as before (not flagged)", async () => {
    const body = o({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "get_time", arguments: '{"a":' } }] }) + o({}, "length") + sse("[DONE]");
    const events = await run(body);
    expect(events.some(e => e.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ stopReason: "max_tokens", droppedTools: 1 });
  });

  test("a stream that ends without finish_reason but with text is end_turn; empty stays invalid", async () => {
    const events = await run(o({ content: "Hello" }) + o({ content: " there" }) + oUsage() + sse("[DONE]"));
    expect(texts(events)).toBe("Hello there");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", message: { content: [{ type: "text", text: "Hello there" }] } });
    await expect(run(o({ role: "assistant", content: "" }) + sse("[DONE]"))).rejects.toBeInstanceOf(LlmError);
    // text plus a tool call that never got its finish chunk: still invalid
    await expect(run(o({ content: "x" }) + o({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "get_time", arguments: "{}" } }] }) + sse("[DONE]"))).rejects.toBeInstanceOf(LlmError);
  });

  test("a leading <think> block (tags split across chunks) becomes thinking, never bubble text", async () => {
    const body = o({ content: "  <thi" }) + o({ content: "nk>step one" }) + o({ content: ", step two</th" }) + o({ content: "ink>\n\nThe answer" }) + o({ content: " is 4." }) + o({}, "stop") + sse("[DONE]");
    const events = await run(body);
    expect(texts(events)).toBe("The answer is 4.");
    expect(thoughts(events)).toBe("step one, step two");
    const done = events.at(-1);
    expect(done?.type === "done" && done.message.content.filter(b => b.type === "text")).toEqual([{ type: "text", text: "The answer is 4." }]);
  });

  test("a <think> later in the text is left alone; ordinary text passes unchanged", async () => {
    const events = await run(o({ content: "Use the <think> tag like this: <think>x</think>" }) + o({}, "stop") + sse("[DONE]"));
    expect(texts(events)).toBe("Use the <think> tag like this: <think>x</think>");
    expect(thoughts(events)).toBe("");
    const lt = await run(o({ content: "<" }) + o({ content: "b>bold</b>" }) + o({}, "stop") + sse("[DONE]"));
    expect(texts(lt)).toBe("<b>bold</b>");
  });
});

describe("anthropic gateway tolerance", () => {
  test("a tool_use block without an id gets one; empty streamed arguments keep {}", async () => {
    const body = aStart() + a("content_block_start", { index: 0, content_block: { type: "tool_use", name: "get_time", input: {} } }) + a("content_block_stop", { index: 0 }) + aEnd("tool_use");
    const events = await collect(createLlm(registry("anthropic"), { fetch: fakeFetch(body).fetch, env }).stream({ ...request, tools: [tool] }));
    const call = events.find(e => e.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", name: "get_time", input: {} });
    expect(call?.type === "tool_call" && call.id.startsWith("call_")).toBe(true);
  });
});

describe("ThinkSplitter", () => {
  const split = (chunks: string[]) => {
    const s = new ThinkSplitter();
    const out = chunks.flatMap(c => s.push(c)).concat(s.end());
    return { text: out.filter(p => p.type === "text").map(p => p.text).join(""), thinking: out.filter(p => p.type === "thinking").map(p => p.text).join("") };
  };
  test("one character at a time", () => {
    expect(split([..."<think>abc</think>Hi"])).toEqual({ text: "Hi", thinking: "abc" });
  });
  test("an unclosed block stays thinking; only whitespace stays text", () => {
    expect(split(["<think>never closed"])).toEqual({ text: "", thinking: "never closed" });
    expect(split(["  "])).toEqual({ text: "  ", thinking: "" });
    expect(split(["<thi"])).toEqual({ text: "<thi", thinking: "" });
  });
});

describe("anthropic wrap-up call (no tools over a tool history)", () => {
  test("declares one inert tool so the Messages API accepts tool_use / tool_result blocks", async () => {
    const fake = fakeFetch(aStart() + a("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "summary" } }) + a("content_block_stop", { index: 0 }) + aEnd());
    const history = [
      { role: "user" as const, content: [{ type: "text" as const, text: "go" }] },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "get_time", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "t1", content: [{ type: "text" as const, text: "12:00" }] }] },
    ];
    await collect(createLlm(registry("anthropic"), { fetch: fake.fetch, env }).stream({ ...request, messages: history, tools: [] }));
    expect(fake.calls[0]!.body.tools.map((t: { name: string }) => t.name)).toEqual(["no_tools_available"]);
    const plain = fakeFetch(aStart() + aEnd());
    await collect(createLlm(registry("anthropic"), { fetch: plain.fetch, env }).stream({ ...request, tools: [] }));
    expect(plain.calls[0]!.body.tools).toBeUndefined();
  });
});
