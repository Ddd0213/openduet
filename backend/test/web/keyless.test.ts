import { describe, expect, test } from "bun:test";
import { webSearch } from "../../src/web/search.ts";
import type { Fetch } from "../../src/llm/index.ts";
import { connectorList, UNREACHABLE } from "../../src/builtins/state.ts";
import type { BuiltinConfig } from "../../src/builtins/config.ts";

const hits = Array.from({ length: 7 }, (_, i) => ({ title: `Title ${i}` + "t".repeat(600), url: `https://example.com/${i}`, excerpts: ["text".repeat(1500)] }));
function fake(opts: { failure?: number | "network" | "tool" | "timeout"; sse?: boolean } = {}) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const provider = String(url).includes("exa") ? "exa" : "parallel";
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    expect(init?.redirect).toBe("error");
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test", version: "1" } } }, { headers: { "Mcp-Session-Id": "session-test" } });
    expect(headers.get("Mcp-Session-Id")).toBe("session-test");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    expect(body.method).toBe("tools/call"); calls.push(provider);
    if (provider === "exa") expect(body.params).toEqual({ name: "web_search_exa", arguments: { query: "public query", numResults: 5 } });
    else expect(body.params).toEqual({ name: "web_search", arguments: { objective: "public query", search_queries: ["public query"] } });
    if (provider === "exa" && opts.failure) {
      if (opts.failure === "network") throw new TypeError("secret URL network error");
      if (opts.failure === "timeout") return new Promise<Response>(() => {});
      if (opts.failure === "tool") return Response.json({ id: body.id, result: { isError: true, content: [{ type: "text", text: "free tier busy" }] } });
      return new Response("provider-secret", { status: opts.failure });
    }
    const text = provider === "exa" ? hits.map(h => `Title: ${h.title}\nURL: ${h.url}\nPublished: N/A\nAuthor: N/A\nHighlights:\n${h.excerpts[0]}`).join("\n\n---\n\n") : JSON.stringify({ results: hits });
    const answer = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } };
    if (!opts.sse) return Response.json(answer);
    const bytes = new TextEncoder().encode(`: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify(answer)}\r\n\r\n`);
    // Never close: the client must finish at its JSON-RPC answer and cancel the reader.
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, -3)); c.enqueue(bytes.slice(-3)); } }), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, calls };
}

describe("M25 key-less search", () => {
  test("default is Exa; parses SSE and text, caps to 5/500/4000 without cutting before parsing", async () => {
    const f = fake({ sse: true }); const result = await webSearch("public query", {}, f);
    expect(f.calls).toEqual(["exa"]); expect(result.isError).toBeUndefined();
    if (result.isError) throw new Error(result.error);
    expect(result.results).toHaveLength(5);
    for (const [i, hit] of result.results.entries()) {
      expect(hit).toEqual({ title: hits[i]!.title.slice(0, 500), url: hits[i]!.url, snippet: hits[i]!.excerpts[0]!.slice(0, 4000) });
    }
  });
  for (const failure of [429, 503, "network", "tool", "timeout"] as const) {
    test(`default falls back once after ${failure}`, async () => {
      const f = fake({ failure }); const config = {};
      const result = await webSearch("public query", config, f);
      expect(result.isError).toBeUndefined(); expect(f.calls).toEqual(["exa", "parallel"]);
      expect(connectorList(config).connectors[0]!.state).toBe("on");
    }, 20_000);
  }
  for (const SEARCH_PROVIDER of ["exa", "parallel"] as const) {
    test(`explicit ${SEARCH_PROVIDER}, even with off switch, calls only it`, async () => {
      const f = fake(); const config: BuiltinConfig = { SEARCH_PROVIDER, BUILTIN_CONNECTORS_OFF: ["web_search"], SEARCH_API_KEY: "unused-secret" };
      expect((await webSearch("public query", config, f)).isError).toBeUndefined(); expect(f.calls).toEqual([SEARCH_PROVIDER]);
    });
  }
  test("explicit Exa fails without falling back; caller abort also never falls back", async () => {
    const f = fake({ failure: 429 }); expect((await webSearch("public query", { SEARCH_PROVIDER: "exa" }, f)).isError).toBe(true); expect(f.calls).toEqual(["exa"]);
    const controller = new AbortController(); controller.abort(); const aborted = fake();
    expect((await webSearch("public query", {}, { ...aborted, signal: controller.signal })).isError).toBe(true); expect(aborted.calls).toEqual([]);
  });
  test("keyed providers never fall back; unavailable then success updates the same four-row state", async () => {
    const config: BuiltinConfig = { SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: "test-secret" };
    let calls = 0;
    const result = await webSearch("public query", config, { fetch: async url => { calls++; expect(String(url)).toContain("tavily"); return new Response("test-secret", { status: 503 }); } });
    expect(result).toEqual({ isError: true, error: UNREACHABLE }); expect(calls).toBe(1);
    expect(connectorList(config).connectors[0]).toMatchObject({ state: "unreachable", checkedAt: expect.any(String), providers: ["Tavily"], keyless: false });
    await webSearch("public query", config, { fetch: async () => Response.json({ results: [] }) });
    expect(connectorList(config).connectors[0]!.state).toBe("on");
  });
  test("both providers unavailable: honest error, offered but unreachable", async () => {
    const config = {}; const result = await webSearch("public query", config, { fetch: async () => new Response(null, { status: 429 }) });
    expect(result).toEqual({ isError: true, error: UNREACHABLE }); expect(connectorList(config).connectors[0]!.state).toBe("unreachable");
  });
});
