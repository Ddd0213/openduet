// M29 (the approval spinner): an MCP connection is warmed when the card is posted (one plain
// initialize, no connector headers or token, shared by calls at the same time, never throwing);
// an SSE answer is read to its end so the connection goes back to the pool (cut after 2 s if the
// server keeps it open); a server whose DELETE answered 405 isn't asked again.
import { expect, test } from "bun:test";
import { mcpCallTool, mcpWarmUp } from "../../src/custom-connectors/mcp.ts";
import type { NetDeps } from "../../src/custom-connectors/net.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

/** An MCP server answering tools/call as SSE: the answer, then `tail` (or nothing), then the end (or never). */
function sseServer(opts: { tail?: string; endsAfterAnswer: boolean; deleteStatus?: number }) {
  const seen = { deletes: 0, read: false, cancelled: false, cancelledAt: 0 };
  let answeredAt = 0;
  const net: NetDeps = {
    lookup,
    fetch: async (_url: URL, init: RequestInit): Promise<Response> => {
      if (init.method === "DELETE") { seen.deletes++; return new Response(JSON.stringify({ error: "method not allowed" }), { status: opts.deleteStatus ?? 405, headers: { "content-type": "application/json" } }); }
      const message = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s-1" });
      const encoder = new TextEncoder();
      const answer = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } })}\n\n`;
      let step = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (step === 0) { step++; answeredAt = performance.now(); controller.enqueue(encoder.encode(answer)); return; }
          if (step === 1 && opts.tail) { step++; controller.enqueue(encoder.encode(opts.tail)); return; }
          if (opts.endsAfterAnswer) { seen.read = true; controller.close(); return; }
          await new Promise(() => {}); // stays open
        },
        cancel() { seen.cancelled = true; seen.cancelledAt = performance.now() - answeredAt; },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  };
  return { net, seen };
}

test("an SSE answer the server ends is read to its end (the connection is reused), not cancelled", async () => {
  const { net, seen } = sseServer({ tail: ": done\n\n", endsAfterAnswer: true });
  const answer = await mcpCallTool({ url: "https://mcp.drain.example.com/mcp", headers: {} }, "ping", {}, net);
  expect(answer).toMatchObject({ isError: false, text: "pong" });
  await Bun.sleep(100);
  expect(seen.read).toBe(true);
  expect(seen.cancelled).toBe(false);
});

test("an SSE answer the server keeps open is cut about 2 s after the answer; the call doesn't wait for it", async () => {
  const { net, seen } = sseServer({ endsAfterAnswer: false });
  const started = performance.now();
  const answer = await mcpCallTool({ url: "https://mcp.open.example.com/mcp", headers: {} }, "ping", {}, net);
  expect(answer.text).toBe("pong");
  expect(performance.now() - started).toBeLessThan(1000);
  while (!seen.cancelled && performance.now() - started < 5000) await Bun.sleep(50);
  expect(seen.cancelled).toBe(true);
  expect(seen.cancelledAt).toBeGreaterThan(1500);
  expect(seen.cancelledAt).toBeLessThan(3500);
}, 10_000);

test("a server whose DELETE answered 405 gets no DELETE for its later sessions; another status keeps them", async () => {
  const notion = sseServer({ endsAfterAnswer: true, deleteStatus: 405 });
  const target = { url: "https://mcp.no-delete.example.com/mcp", headers: {} };
  await mcpCallTool(target, "ping", {}, notion.net);
  await Bun.sleep(50);
  expect(notion.seen.deletes).toBe(1);
  await mcpCallTool(target, "ping", {}, notion.net);
  await mcpCallTool(target, "ping", {}, notion.net);
  await Bun.sleep(50);
  expect(notion.seen.deletes).toBe(1);

  const other = sseServer({ endsAfterAnswer: true, deleteStatus: 204 });
  const otherTarget = { url: "https://mcp.deletes.example.com/mcp", headers: {} };
  await mcpCallTool(otherTarget, "ping", {}, other.net);
  await mcpCallTool(otherTarget, "ping", {}, other.net);
  await Bun.sleep(50);
  expect(other.seen.deletes).toBe(2);
});

test("warm-up: one plain initialize (no connector headers), shared by calls at the same time, read to its end", async () => {
  const requests: { method: string; headers: Record<string, string>; body: string }[] = [];
  let ended = false;
  const net: NetDeps = {
    lookup,
    fetch: async (_url: URL, init: RequestInit) => {
      requests.push({ method: String(init.method), headers: Object.fromEntries(new Headers(init.headers)), body: String(init.body) });
      await Bun.sleep(30);
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("{\"error\":\"invalid_token\"}")); },
        pull(controller) { ended = true; controller.close(); },
      });
      return new Response(body, { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
    },
  };
  const url = new URL("https://mcp.warm.example.com/mcp");
  await Promise.all([mcpWarmUp(url, net), mcpWarmUp(url, net), mcpWarmUp(url, net)]);
  expect(requests).toHaveLength(1);
  const [sent] = requests;
  expect(sent!.method).toBe("POST");
  expect(Object.keys(sent!.headers).sort()).toEqual(["accept", "content-type", "mcp-protocol-version"]);
  expect(JSON.parse(sent!.body)).toMatchObject({ jsonrpc: "2.0", id: 0, method: "initialize" });
  expect(ended).toBe(true);
  // Done: the next warm-up is a new request.
  await mcpWarmUp(url, net);
  expect(requests).toHaveLength(2);
});

test("warm-up never throws: an unreachable server, a private address, a hanging answer", async () => {
  const down: NetDeps = { lookup, fetch: async () => { throw new TypeError("connection refused"); } };
  await expect(mcpWarmUp(new URL("https://mcp.down.example.com/mcp"), down)).resolves.toBeUndefined();
  const internal: NetDeps = { lookup: async () => [{ address: "10.0.0.5", family: 4 }], fetch: async () => { throw new Error("must not be called"); } };
  await expect(mcpWarmUp(new URL("https://mcp.internal.example.com/mcp"), internal)).resolves.toBeUndefined();
  const hanging: NetDeps = { lookup, fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 200 }) };
  const started = performance.now();
  await expect(mcpWarmUp(new URL("https://mcp.hang.example.com/mcp"), hanging)).resolves.toBeUndefined();
  expect(performance.now() - started).toBeLessThan(3500);
}, 10_000);
