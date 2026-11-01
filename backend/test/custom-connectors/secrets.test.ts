// M11 secrets never leak. One end-to-end flow with every path a secret could take: a key typed into
// a request_secret card, an MCP server added with a secret header, APIs and MCP tools that echo the
// secret back (in bodies, headers, JSON-RPC errors, structured content), approved writes, a failed
// verification whose error echoes the header, and a key rotation. Then every sink is searched for
// the secret strings: every table of the database (Message, RunStep, AuditLog, Event, Approval ...),
// stdout / stderr (the JSON logs), every model request (prompts, tool results, tool lists), and
// every HTTP answer and live event the app got.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { Message } from "../../src/contract/messages.ts";
import { modelToolName } from "../../src/custom-connectors/provider.ts";
import { log } from "../../src/log.ts";
import { call, captureOutput, chatIn, dumpDatabase, FakeMcp, json, newChannel, resultsIn, startChannels, text, thread, type ChannelApp } from "../channels/harness.ts";

const CARD_KEY = "sk-LEAKCHECK-card-a1b2c3d4e5f6";
const HEADER_SECRET = "hdr-LEAKCHECK-mcp-z9y8x7w6v5u4";
const ROTATED_KEY = "sk-LEAKCHECK-rotated-77665544";
const SECRETS = [CARD_KEY, HEADER_SECRET, ROTATED_KEY];

let m: ChannelApp;
let output: ReturnType<typeof captureOutput>;
const answers: string[] = [];
const live: DuetEvent[] = [];
let stopEvents = () => {};

beforeAll(async () => {
  m = await startChannels();
  stopEvents = m.fixture.events.subscribe(m.alex.userId, (event) => { live.push(event); });
  // An API that echoes whatever credentials it got, everywhere it can.
  m.net.route("api.leak.example.com", (request) => {
    const auth = request.headers.authorization ?? "";
    const key = auth.replace(/^Bearer /, "");
    const path = new URL(request.url).pathname;
    if (path === "/away") return new Response(null, { status: 302, headers: { location: `https://evil.example.com/?k=${key}` } });
    if (path === "/fail") return new Response(`invalid key ${key}`, { status: 500, headers: { "content-type": "text/plain" } });
    return Response.json({ youSent: auth, key, nested: { again: [key] } }, { headers: { location: `https://api.leak.example.com/next?k=${key}`, "retry-after": key } });
  });
  // An MCP server that echoes the secret header in results and errors.
  const mcp = new FakeMcp();
  mcp.required = { "x-secret": HEADER_SECRET };
  mcp.tools = [
    { name: "echo", annotations: { readOnlyHint: true } },
    { name: "explode", annotations: { readOnlyHint: true } },
    { name: "save_note", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  ];
  mcp.answer = (c) => (c.name === "explode"
    ? { isError: true, content: [{ type: "text", text: `failed with ${c.headers["x-secret"]}` }] }
    : { content: [{ type: "text", text: `header was ${c.headers["x-secret"]}` }], structuredContent: { header: c.headers["x-secret"], list: [c.headers["x-secret"]] } });
  m.net.route("mcp.leak.example.com", mcp.handler);
  // An MCP server whose initialize error quotes the header it got.
  m.net.route("mcp-bad.leak.example.com", (request) => {
    const body = JSON.parse(request.body ?? "{}") as { id?: number };
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `token ${request.headers["x-secret"]} is not valid here` } });
  });
  output = captureOutput();
});
afterAll(async () => {
  output.stop();
  stopEvents();
  await m.cleanup();
});

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await m.fixture.app.request(path, init);
  answers.push(JSON.stringify([...res.headers]));
  if (!(res.headers.get("content-type") ?? "").includes("event-stream")) answers.push(await res.clone().text());
  return res;
}
async function say(channelId: string, body: string) {
  const frames = await chatIn(m, m.alex, channelId, body);
  answers.push(JSON.stringify(frames));
  return frames;
}
/** Approves the chat's pending cards; M21: the chat then carries on in one turn (answered `reply`), awaited here. */
async function approveAll(slugPrefix: string, reply = "Thanks.") {
  const pending = await m.fixture.db.approval.findMany({ where: { userId: m.alex.userId, status: "pending", toolSlug: { startsWith: slugPrefix } } });
  m.llm.script("chat", [text(reply)]);
  const asked = m.llm.sent("chat").length;
  for (const approval of pending) expect((await req(`/api/approvals/${approval.id}/approve`, json(m.alex, "POST", { version: approval.version }))).status).toBe(200);
  for (let i = 0; i < 200 && m.llm.sent("chat").length === asked; i++) await Bun.sleep(25);
  await m.runs.idle();
  return pending.length;
}

test("secrets typed into cards or stored for connectors never reach a response, a log line, a model request or a stored row", async () => {
  const channel = await newChannel(m, m.alex, { name: "Leak check" });

  // 1. A key typed into a request_secret card; the follow-up turn uses it through call_api.
  m.llm.script("chat", [call("request_secret", { name: "Leaky", purpose: "Fetch data", domain: "api.leak.example.com" })]);
  await say(channel.id, "fetch my data");
  const card = (await thread(m, m.alex, channel.id)).find((x): x is Extract<Message, { kind: "connection_request" }> => x.kind === "connection_request")!;
  m.llm.script("chat",
    [call("call_api", { connector: "Leaky", method: "GET", url: "https://api.leak.example.com/echo", headers: { Authorization: "Bearer guess" } })],
    [call("call_api", { connector: "Leaky", method: "GET", url: "https://api.leak.example.com/fail" }), call("call_api", { connector: "Leaky", method: "GET", url: "https://api.leak.example.com/away" })],
    [call("call_api", { connector: "Leaky", method: "POST", url: "https://api.leak.example.com/echo", body: { a: 1 } })],
    [text("Fetched.")],
  );
  expect((await req(`/api/messages/${card.id}/connect`, json(m.alex, "POST", { values: { key: CARD_KEY } }))).status).toBe(200);
  await m.runs.idle();
  const apiResults = m.llm.sent("chat").slice(-3).flatMap((r) => resultsIn(r));
  expect(JSON.stringify(apiResults)).toContain("[redacted]");
  expect(m.net.to("api.leak.example.com").some((r) => r.headers.authorization === `Bearer ${CARD_KEY}`)).toBe(true);
  expect(await approveAll("api:")).toBe(1);

  // 2. An MCP server with a secret header: echoing reads, an erroring tool, an approved write.
  const created = await req("/api/custom-connectors", json(m.alex, "POST", { kind: "mcp", name: "Leaky MCP", url: "https://mcp.leak.example.com/mcp", headers: [{ name: "X-Secret", value: HEADER_SECRET, secret: true }] }));
  expect(created.status).toBe(200);
  const mcpId = ((await created.json()) as { connector: { id: string } }).connector.id;
  m.llm.script("chat",
    [call(modelToolName(mcpId, "echo"), {}), call(modelToolName(mcpId, "explode"), {})],
    [call(modelToolName(mcpId, "save_note"), { text: "hi" })],
    [text("Noted.")],
  );
  await say(channel.id, "use the mcp server");
  const mcpResults = resultsIn(m.llm.sent("chat").at(-2));
  expect(JSON.stringify(mcpResults)).toContain("[redacted]");
  expect(await approveAll("mcp:", "All done.")).toBe(1);
  // The carried-on turn (M21) is the one that reads the approved call's result.
  expect(m.llm.sent("chat").at(-1)!.system).toContain("approved since your last turn");
  m.llm.script("chat", [text("Nothing new.")]);
  await say(channel.id, "status?");

  // 3. A failed verification whose error quotes the header; a key rotation; the lists.
  const bad = await req("/api/custom-connectors", json(m.alex, "POST", { kind: "mcp", name: "Bad", url: "https://mcp-bad.leak.example.com/mcp", headers: [{ name: "X-Secret", value: HEADER_SECRET, secret: true }] }));
  expect(bad.status).toBe(400);
  expect(await bad.clone().text()).toContain("[redacted]");
  const leakyId = card.payload.connectorId ?? (await m.fixture.db.customConnector.findFirstOrThrow({ where: { name: "Leaky" } })).id;
  expect((await req(`/api/custom-connectors/${leakyId}`, json(m.alex, "PATCH", { key: ROTATED_KEY }))).status).toBe(200);
  expect((await req(`/api/custom-connectors/${leakyId}/test`, json(m.alex, "POST"))).status).toBe(200);
  await req("/api/custom-connectors", { headers: m.alex.headers });
  await req(`/api/channels/${channel.id}/messages?limit=100`, { headers: m.alex.headers });
  await req(`/api/channels/${channel.id}/access`, { headers: m.alex.headers });
  await m.runs.idle();
  await m.system.connectors.settled();

  // The scan.
  const sinks: [string, string][] = [
    ["database", await dumpDatabase(m.fixture.db)],
    ["stdout/stderr", output.text()],
    ["model requests", JSON.stringify(m.llm.requests.map((r) => ({ system: r.system, messages: r.messages, tools: r.tools })))],
    ["HTTP answers", answers.join("\n")],
    ["live events", JSON.stringify(live)],
  ];
  for (const [name, content] of sinks) {
    for (const secret of SECRETS) {
      if (content.includes(secret)) throw new Error(`${name} contains a secret (${secret.slice(0, 12)}…)`);
    }
  }
  // The scan saw real content (the flow ran through every sink); the log capture works.
  expect(sinks.filter(([name]) => name !== "stdout/stderr").every(([, content]) => content.length > 0)).toBe(true);
  log.warn("leak scan marker", { connectorId: leakyId });
  expect(output.text()).toContain("leak scan marker");
  // The dump really reads the rows (names, cards, run steps) and the model saw the redacted echoes.
  const [, database] = sinks[0]!;
  for (const table of ["Message:", "RunStep:", "AuditLog:", "Event:", "Approval:", "VaultSecret:", "CustomConnector:"]) expect(database).toContain(table);
  expect(database).toContain("Leaky MCP");
  expect(sinks[2]![1]).toContain("[redacted]");
  expect((await m.fixture.db.runStep.count()) > 0 && (await m.fixture.db.event.count()) > 0).toBe(true);
  // The vault still holds them (server-side only).
  expect(await m.system.vault.get(m.alex.userId, "connector", leakyId, "key")).toBe(ROTATED_KEY);
  expect(await m.system.vault.get(m.alex.userId, "connector", mcpId, "header:X-Secret")).toBe(HEADER_SECRET);
});
