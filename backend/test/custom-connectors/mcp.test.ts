// M11 custom connectors, MCP: create verifies against an in-process MCP server (initialize,
// notifications/initialized, tools/list with Mcp-Session-Id, paged, JSON or SSE) and a failed
// check is 400 with nothing saved (bad credentials, http, private addresses, unknown hosts);
// secret headers live in the vault; the model sees mcp_<id>_<tool> tools: reads run, writes go to
// an approval card (ToolPolicy "<id>:<tool>", default ask) and run on Approve; test / lazy refresh;
// PATCH; policy; DELETE removes vault, access and policy rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CustomConnectorList, CustomConnectorResponse } from "../../src/contract/m11.ts";
import { MAX_MODEL_TOOLS, modelToolName, offeredTools } from "../../src/custom-connectors/provider.ts";
import { errorOf } from "../helpers/http.ts";
import { call, chatIn, FakeMcp, get, json, newChannel, resultsIn, startChannels, text, toolNames, type ChannelApp } from "../channels/harness.ts";

let m: ChannelApp;
const mcp = new FakeMcp();
const TOKEN = "Bearer mcp-secret-token-0123456789";
beforeAll(async () => {
  m = await startChannels();
  mcp.tools = [
    { name: "search_pages", description: "Search the wiki", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "write_page", description: "Write a page", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] } },
  ];
  mcp.required = { authorization: TOKEN };
  m.net.route("mcp.example.com", mcp.handler);
});
afterAll(() => m.cleanup());

const create = (body: Record<string, unknown>, user = m.alex) => m.fixture.app.request("/api/custom-connectors", json(user, "POST", { kind: "mcp", ...body }));
const docsBody = { name: "Docs", description: "Team wiki", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: TOKEN, secret: true }, { name: "X-Workspace", value: "acme", secret: false }] };

let connectorId = "";

describe("create + verify", () => {
  test("initialize + tools/list against the server; secret headers in the vault, plain ones returned; reads always, writes ask", async () => {
    const res = await create(docsBody);
    expect(res.status).toBe(200);
    const { connector } = CustomConnectorResponse.parse(await res.json());
    connectorId = connector.id;
    expect(connector).toMatchObject({
      kind: "mcp", name: "Docs", url: "https://mcp.example.com/mcp", domain: null, secret: null, status: "active", error: null, scope: "all",
      headers: [{ name: "Authorization", secret: true, value: null, secretInfo: { set: true, last4: "6789" } }, { name: "X-Workspace", secret: false, value: "acme", secretInfo: null }],
      tools: [{ name: "search_pages", access: "read", mode: "always" }, { name: "write_page", access: "write", mode: "ask" }],
    });
    expect(JSON.stringify(connector)).not.toContain("mcp-secret-token");
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(row.headers).not.toContain("mcp-secret-token");
    expect(await m.fixture.db.vaultSecret.count({ where: { ownerId: connectorId, name: "header:Authorization" } })).toBe(1);
    expect(mcp.methods.slice(0, 3)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    const list = mcp.seen.filter((r) => r.method === "POST").at(-1)!;
    expect(list.headers).toMatchObject({ accept: "application/json, text/event-stream", "mcp-session-id": "sess-1", "mcp-protocol-version": "2025-06-18", authorization: TOKEN, "x-workspace": "acme" });
    expect(mcp.closed).toBe(1);
    const listed = CustomConnectorList.parse(await (await get(m, m.alex, "/api/custom-connectors")).json());
    expect(listed.connectors.map((c) => c.id)).toEqual([connectorId]);
    expect(CustomConnectorList.parse(await (await get(m, m.sam, "/api/custom-connectors")).json()).connectors).toEqual([]);
  });

  test("a failed check is 400 with the reason and nothing is saved", async () => {
    const count = () => m.fixture.db.customConnector.count();
    const before = await count();
    const fetches = m.net.requests.length;
    const cases: [Record<string, unknown>, string, string][] = [
      [{ ...docsBody, headers: [{ name: "Authorization", value: "Bearer wrong", secret: true }] }, "url", "refused the credentials"],
      [{ ...docsBody, url: "http://mcp.example.com/mcp" }, "url", "Only https"],
      [{ ...docsBody, url: "https://127.0.0.1/mcp" }, "url", "public host name"],
      [{ ...docsBody, url: "https://localhost/mcp" }, "url", "public host name"],
      [{ ...docsBody, url: "https://wiki.internal/mcp" }, "url", "public host name"],
      [{ ...docsBody, url: "https://unknown.example.com/mcp" }, "url", "couldn't be reached"],
      [{ ...docsBody, headers: [{ name: "Content-Type", value: "x", secret: false }] }, "headers", "set by the server"],
    ];
    for (const [body, field, reason] of cases) {
      const res = await create(body);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.field).toBe(field);
      expect(error.message).toContain(reason);
      expect(error.message).not.toContain("wrong");
    }
    // Resolves to a private address: refused before any request.
    m.net.dns.set("intranet.example.com", ["10.1.2.3"]);
    m.net.route("intranet.example.com", mcp.handler);
    const sent = m.net.requests.length;
    const blocked = await create({ ...docsBody, url: "https://intranet.example.com/mcp" });
    expect(blocked.status).toBe(400);
    expect((await errorOf(blocked)).message).toContain("private or reserved");
    expect(m.net.requests.length).toBe(sent);
    expect(m.net.requests.slice(fetches).some((r) => r.url.startsWith("http://"))).toBe(false);
    expect(await count()).toBe(before);
  });
});
describe("model tools", () => {
  test("mcp_<id>_<tool>: a read runs now, a write is an approval card that runs on Approve; results reach the next turn", async () => {
    const channel = await newChannel(m, m.alex, { name: "Wiki" });
    const search = modelToolName(connectorId, "search_pages");
    const write = modelToolName(connectorId, "write_page");
    expect(search).toMatch(/^mcp_[0-9a-f]{6}_search_pages$/);
    m.llm.script("chat",
      [call(search, { query: "roadmap" })],
      [call(write, { title: "Notes", body: "Hello" })],
      [call(write, { body: "no title" })],
      [text("Waiting for your OK.")],
    );
    const before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, channel.id, "find the roadmap and write notes");
    const sent = m.llm.sent("chat").slice(before);
    // M29: a chat turn lists the connector's tools under "More tools"; a direct call runs and loads it.
    expect(toolNames(sent[0]).some((n) => n.startsWith("mcp_"))).toBe(false);
    expect(toolNames(sent[0])).not.toContain("call_api");
    for (const line of ["Docs (connector):", `- ${search}: Search the wiki`, `- ${write}: Write a page`, "Connections:", "- request_connection: ", "- request_secret: "]) expect(sent[0]!.system).toContain(line);
    expect(toolNames(sent[1])).toContain(search);
    expect(toolNames(sent[2]).filter((n) => n.startsWith("mcp_"))).toEqual([search, write]);
    const offered = sent[2]!.tools!.find((t) => t.name === write)!;
    expect(offered.description).toContain("Docs (custom connector): write_page");
    expect(offered.inputSchema).toMatchObject({ required: ["title"] });
    expect(sent[0]!.system).toContain("Custom connectors on in this channel");
    expect(resultsIn(sent[1])[0]).toMatchObject({ connector: "Docs", tool: "search_pages", status: "ok", text: "search_pages done" });
    expect(mcp.calls.map((c) => [c.name, c.arguments])).toEqual([["search_pages", { query: "roadmap" }]]);
    expect(mcp.calls[0]!.headers.authorization).toBe(TOKEN);
    expect(resultsIn(sent[2])[0]).toMatchObject({ status: "awaiting_approval" });
    expect(resultsIn(sent[3])[0]).toMatchObject({ error: "Invalid tool arguments", issues: ["title: required"] });
    const approval = await m.fixture.db.approval.findFirstOrThrow({ where: { userId: m.alex.userId, toolSlug: `mcp:${connectorId}:write_page`, status: "pending" } });
    expect(approval.kind).toBe("action");
    expect(JSON.parse(approval.arguments)).toEqual({ title: "Notes", body: "Hello" });
    expect(mcp.calls).toHaveLength(1);

    // M21: deciding the turn's only card carries the chat on; that turn gets the approved result.
    m.llm.script("chat", [text("Written.")]);
    const asked = m.llm.sent("chat").length;
    const approved = await m.fixture.app.request(`/api/approvals/${approval.id}/approve`, json(m.alex, "POST", { version: 1 }));
    expect(approved.status).toBe(200);
    expect(mcp.calls.map((c) => c.name)).toEqual(["search_pages", "write_page"]);
    expect((await m.fixture.db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("approved");
    for (let i = 0; i < 200 && m.llm.sent("chat").length === asked; i++) await Bun.sleep(25);
    await m.runs.idle();
    expect(m.llm.sent("chat").at(-1)!.system).toContain("Custom connector calls the user approved since your last turn");
    expect(m.llm.sent("chat").at(-1)!.system).toContain("write_page done");
    expect(JSON.stringify(m.llm.sent("chat").at(-1)!.messages)).toContain(`Approval ${approval.id}: the user approved it and it was carried out`);
  });

  test("a connector turned off in the channel offers nothing there; a chat turn lists all its tools, others at most 60", async () => {
    const channel = await newChannel(m, m.alex, { name: "Quiet" });
    await m.system.access.setChannel(m.alex.userId, channel.id, { kind: "connector", id: connectorId }, false);
    m.llm.script("chat", [call(modelToolName(connectorId, "search_pages"), { query: "x" })], [text("ok")]);
    const before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, channel.id, "search");
    const sent = m.llm.sent("chat").slice(before);
    expect(toolNames(sent[0]).some((n) => n.startsWith("mcp_"))).toBe(false);
    expect(sent[0]!.system).not.toContain(modelToolName(connectorId, "search_pages"));
    // Not offered this turn, so the runtime refuses it before the provider sees it.
    expect(resultsIn(sent[1])[0]!.error).toMatch(/not available/);
    expect(mcp.calls.some((c) => c.arguments.query === "x")).toBe(false);

    const many = new FakeMcp();
    many.tools = Array.from({ length: 70 }, (_, i) => ({ name: `tool_${i}`, annotations: { readOnlyHint: true } }));
    m.net.route("many.example.com", many.handler);
    const big = CustomConnectorResponse.parse(await (await create({ name: "Many", url: "https://many.example.com/mcp", headers: [] })).json()).connector;
    expect(big.tools).toHaveLength(70);
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "hi");
    const request = m.llm.sent("chat").at(-1)!;
    // M29: none sent before load_tools, every one in the index, nothing left out.
    expect(toolNames(request).filter((n) => n.startsWith("mcp_"))).toEqual([]);
    for (let i = 0; i < 70; i++) expect(request.system).toContain(`\n- ${modelToolName(big.id, `tool_${i}`)}`);
    expect(request.system).not.toContain("connector tools were left out of this turn");
    // Other kinds (briefs, check-ins, scans, routines) still send the first 60 in full.
    const rows = [{ ...big, kind: "mcp" }] as unknown as Parameters<typeof offeredTools>[0];
    const stored = big.tools.map((t) => ({ name: t.name, description: "", access: "read" as const, inputSchema: {} }));
    expect(offeredTools(rows, () => stored)).toMatchObject({ leftOut: 10 });
    expect(offeredTools(rows, () => stored).offered).toHaveLength(MAX_MODEL_TOOLS);
    expect(offeredTools(rows, () => stored, Number.POSITIVE_INFINITY)).toMatchObject({ leftOut: 0 });
    await m.fixture.app.request(`/api/custom-connectors/${big.id}`, { method: "DELETE", headers: m.alex.headers });
  });
});

describe("test, refresh, policy, PATCH, DELETE", () => {
  test("POST test re-checks (SSE answers, paged tools/list); a failure marks it failed; stale tools refresh lazily", async () => {
    mcp.sse = true;
    mcp.pageSize = 1;
    mcp.tools.push({ name: "delete_page", description: "Delete a page", inputSchema: { type: "object", properties: { title: { type: "string" } } } });
    const tested = CustomConnectorResponse.parse(await (await m.fixture.app.request(`/api/custom-connectors/${connectorId}/test`, json(m.alex, "POST"))).json()).connector;
    expect(tested.tools.map((t) => [t.name, t.access, t.mode])).toEqual([["search_pages", "read", "always"], ["write_page", "write", "ask"], ["delete_page", "write", "ask"]]);
    expect(mcp.methods.filter((x) => x === "tools/list").length).toBeGreaterThanOrEqual(4);
    mcp.sse = false;
    mcp.pageSize = 0;

    mcp.required = { authorization: "Bearer rotated" };
    const failed = CustomConnectorResponse.parse(await (await m.fixture.app.request(`/api/custom-connectors/${connectorId}/test`, json(m.alex, "POST"))).json()).connector;
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toContain("refused the credentials");
    expect(failed.tools).toHaveLength(3);
    mcp.required = { authorization: TOKEN };

    // Older than the refresh window (15 min after a failure): the next turn's lookup refreshes it.
    mcp.tools = mcp.tools.filter((t) => t.name !== "delete_page");
    await m.fixture.db.customConnector.update({ where: { id: connectorId }, data: { checkedAt: new Date(Date.now() - 25 * 60 * 60_000) } });
    await m.system.connectors.enabledFor(m.alex.userId, m.alex.mainChannelId);
    await m.system.connectors.settled();
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(row.status).toBe("active");
    expect(JSON.parse(row.tools).map((t: { name: string }) => t.name)).toEqual(["search_pages", "write_page"]);
    expect(Date.now() - row.checkedAt!.getTime()).toBeLessThan(60_000);
  });

  test("PUT policy: one tool, or tool null = all its tools; unknown tool 400; someone else's 404", async () => {
    const put = (body: Record<string, unknown>, user = m.alex) => m.fixture.app.request(`/api/custom-connectors/${connectorId}/policy`, json(user, "PUT", body));
    const always = CustomConnectorResponse.parse(await (await put({ tool: "write_page", mode: "always" })).json()).connector;
    expect(always.tools.find((t) => t.name === "write_page")!.mode).toBe("always");
    expect(await m.fixture.db.toolPolicy.findFirst({ where: { userId: m.alex.userId, toolSlug: `${connectorId}:write_page` } })).toMatchObject({ mode: "always" });
    const calls = mcp.calls.length;
    m.llm.script("chat", [call(modelToolName(connectorId, "write_page"), { title: "Direct" })], [text("Done.")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "write it");
    expect(mcp.calls.length).toBe(calls + 1);
    expect(resultsIn(m.llm.sent("chat").at(-1))[0]).toMatchObject({ status: "ok" });

    const all = CustomConnectorResponse.parse(await (await put({ tool: null, mode: "ask" })).json()).connector;
    expect(all.tools.map((t) => t.mode)).toEqual(["ask", "ask"]);
    expect(await m.fixture.db.toolPolicy.findFirst({ where: { userId: m.alex.userId, toolSlug: `toolkit:custom-${connectorId.toLowerCase()}` } })).toMatchObject({ mode: "ask" });
    expect(await m.fixture.db.toolPolicy.count({ where: { userId: m.alex.userId, toolSlug: `${connectorId}:write_page` } })).toBe(0);
    expect((await put({ tool: "nope", mode: "always" })).status).toBe(400);
    expect((await put({ tool: "write_page", mode: "always" }, m.sam)).status).toBe(404);
    await put({ tool: null, mode: "never" });
    await m.fixture.db.toolPolicy.deleteMany({ where: { userId: m.alex.userId, toolSlug: `toolkit:custom-${connectorId.toLowerCase()}` } });
  });

  test("PATCH: a rename doesn't re-check; header changes re-check (null keeps a stored secret); bad changes 400 and change nothing", async () => {
    const patch = (body: Record<string, unknown>, user = m.alex) => m.fixture.app.request(`/api/custom-connectors/${connectorId}`, json(user, "PATCH", body));
    const seen = mcp.seen.length;
    const renamed = CustomConnectorResponse.parse(await (await patch({ name: "Wiki", description: "The team wiki" })).json()).connector;
    expect(renamed).toMatchObject({ name: "Wiki", description: "The team wiki" });
    expect(mcp.seen.length).toBe(seen);
    const kept = await patch({ headers: [{ name: "Authorization", value: null, secret: true }, { name: "X-Workspace", value: "beta", secret: false }] });
    expect(kept.status).toBe(200);
    expect(CustomConnectorResponse.parse(await kept.json()).connector.headers).toEqual([
      { name: "Authorization", secret: true, value: null, secretInfo: { set: true, last4: "6789" } },
      { name: "X-Workspace", secret: false, value: "beta", secretInfo: null },
    ]);
    expect(mcp.seen.at(-2)!.headers).toMatchObject({ authorization: TOKEN, "x-workspace": "beta" });
    for (const [body, field] of [
      [{ headers: [{ name: "X-New", value: null, secret: true }] }, "headers"],
      [{ domain: "example.com" }, "domain"],
      [{ url: "https://nowhere.example.com/mcp" }, "url"],
    ] as const) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).field).toBe(field);
    }
    expect((await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connectorId } })).url).toBe("https://mcp.example.com/mcp");
    expect((await patch({ name: "x" }, m.sam)).status).toBe(404);
  });

  test("DELETE removes the row, its vault rows, access rows and ToolPolicy rows; again 404", async () => {
    const channel = await newChannel(m, m.alex, { name: "Temp" });
    await m.system.access.setChannel(m.alex.userId, channel.id, { kind: "connector", id: connectorId }, true);
    await m.system.access.setScope(m.alex.userId, { kind: "connector", id: connectorId }, "channels");
    await m.fixture.app.request(`/api/custom-connectors/${connectorId}/policy`, json(m.alex, "PUT", { tool: "write_page", mode: "always" }));
    await m.fixture.app.request(`/api/custom-connectors/${connectorId}/policy`, json(m.alex, "PUT", { tool: null, mode: "ask" }));
    await m.fixture.app.request(`/api/custom-connectors/${connectorId}/policy`, json(m.alex, "PUT", { tool: "search_pages", mode: "never" }));
    expect((await m.fixture.app.request(`/api/custom-connectors/${connectorId}`, { method: "DELETE", headers: m.sam.headers })).status).toBe(404);
    expect((await m.fixture.app.request(`/api/custom-connectors/${connectorId}`, { method: "DELETE", headers: m.alex.headers })).status).toBe(204);
    const { db } = m.fixture;
    expect(await db.customConnector.count({ where: { id: connectorId } })).toBe(0);
    expect(await db.vaultSecret.count({ where: { ownerId: connectorId } })).toBe(0);
    expect(await db.accessRule.count({ where: { refId: connectorId } })).toBe(0);
    expect(await db.channelAccess.count({ where: { refId: connectorId } })).toBe(0);
    expect(await db.toolPolicy.count({ where: { OR: [{ toolSlug: { startsWith: `${connectorId}:` } }, { toolSlug: `toolkit:custom-${connectorId.toLowerCase()}` }] } })).toBe(0);
    expect((await m.fixture.app.request(`/api/custom-connectors/${connectorId}`, { method: "DELETE", headers: m.alex.headers })).status).toBe(404);
  });
});

describe("secrets in what the server sends", () => {
  const SECRET = "lk9-token-24680135792468";
  const leaks = (text: string) => text.includes(SECRET.slice(0, 4));

  test("an error text echoing the secret header across its 200-character cut has no part of it; tool names / descriptions / schemas neither", async () => {
    const leaky = new FakeMcp();
    leaky.required = { "x-secret": SECRET };
    leaky.tools = [
      // the description crosses its 1000-character cut inside the secret
      { name: "fail_tool", description: `${"d".repeat(990)}${SECRET}`, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { q: { type: "string", description: `token ${SECRET}` } } } },
      // a name carrying the secret can't be redacted: the tool isn't offered
      { name: `x_${SECRET}`, annotations: { readOnlyHint: true } },
    ];
    // tools/call: a JSON-RPC error whose message has the header crossing character 200
    const handler: typeof leaky.handler = async (request, init) => {
      const message = JSON.parse(request.body ?? "{}") as { id?: number; method?: string };
      if (message.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `${"e".repeat(190)}${request.headers["x-secret"]} is not valid` } });
      return leaky.handler(request, init);
    };
    m.net.route("leaky.example.com", handler);
    const res = await create({ name: "Leaky", url: "https://leaky.example.com/mcp", headers: [{ name: "X-Secret", value: SECRET, secret: true }] });
    expect(res.status).toBe(200);
    const { connector } = CustomConnectorResponse.parse(await res.json());
    expect(connector.tools.map((t) => t.name)).toEqual(["fail_tool"]);
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connector.id } });
    expect(leaks(row.tools)).toBe(false);
    expect(row.tools).toContain("[redacted]");

    m.llm.script("chat", [call(modelToolName(connector.id, "fail_tool"), { q: "x" })], [text("ok")]);
    const before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "try it");
    const sent = m.llm.sent("chat").slice(before);
    const result = resultsIn(sent[1])[0]!;
    expect(result).toMatchObject({ connector: "Leaky", tool: "fail_tool", status: "error" });
    expect(result.error as string).toContain("e".repeat(10));
    expect(leaks(result.error as string)).toBe(false);
    expect(leaks(JSON.stringify(sent))).toBe(false);

    // a failed check (create / test) shows the server's error with the same rule
    leaky.tools = [];
    const listing: typeof leaky.handler = async (request, init) => {
      const message = JSON.parse(request.body ?? "{}") as { id?: number; method?: string };
      if (message.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `${"e".repeat(190)}${request.headers["x-secret"]}` } });
      return leaky.handler(request, init);
    };
    m.net.route("leaky.example.com", listing);
    const failed = await create({ name: "Leaky 2", url: "https://leaky.example.com/mcp", headers: [{ name: "X-Secret", value: SECRET, secret: true }] });
    expect(failed.status).toBe(400);
    const error = await errorOf(failed);
    expect(error.message).toContain("The server returned an error");
    expect(leaks(error.message)).toBe(false);
    await m.fixture.app.request(`/api/custom-connectors/${connector.id}`, { method: "DELETE", headers: m.alex.headers });
  });
});
