// M29 net: the session's closing DELETE runs in the background (capped at 3 s, never rejects); a
// tool list or call returns without waiting for it.
import { expect, test } from "bun:test";
import { mcpCallTool, mcpListTools } from "../../src/custom-connectors/mcp.ts";
import type { NetDeps } from "../../src/custom-connectors/net.ts";

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

function server(onDelete: (init: RequestInit) => Promise<Response>): NetDeps & { deletes: number } {
  const net = {
    deletes: 0,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (_url: URL, init: RequestInit): Promise<Response> => {
      if (init.method === "DELETE") { net.deletes++; return onDelete(init); }
      const message = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "slow-close" } } }, { "mcp-session-id": "s-1" });
      if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } });
      return json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
    },
  };
  return net;
}

test("listing tools doesn't wait for a DELETE that hangs; the DELETE is cut at 3 s", async () => {
  let aborted = 0;
  const net = server(init => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => { aborted = performance.now(); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  }));
  const target = { url: "https://mcp.example.com/mcp", headers: {} };
  const tools = await mcpListTools(target, net);
  const returned = performance.now();
  expect(tools.map(t => t.name)).toEqual(["ping"]);
  expect(aborted).toBe(0);
  while (!aborted && performance.now() - returned < 6000) await Bun.sleep(50);
  expect(net.deletes).toBe(1);
  expect(aborted - returned).toBeGreaterThan(2000);
  expect(aborted - returned).toBeLessThan(4500);
}, 15_000);

test("a failing DELETE is swallowed (no unhandled rejection); the call's answer stands", async () => {
  const net = server(async () => { throw new TypeError("connection reset"); });
  const answer = await mcpCallTool({ url: "https://mcp.example.com/mcp", headers: {} }, "ping", {}, net);
  expect(answer).toMatchObject({ isError: false, text: "pong" });
  await Bun.sleep(100);
  expect(net.deletes).toBe(1);
});
