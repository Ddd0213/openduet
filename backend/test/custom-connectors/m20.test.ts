// M20 on custom connectors:
//  - the safety floor: tool rows carry alwaysAllowed / alwaysBlocked; PUT policy with Always on a
//    blocked tool is 400 always_not_allowed; "All tools: Always" skips those tools;
//  - "ask" goes through approvals.ask(): the same call again posts no second card;
//  - no call carries a credential out (MCP arguments, call_api headers / query / body; again on
//    Approve), while the connector's own key header keeps working;
//  - a check-in turn only reads: call_api POST, MCP writes, computer_navigate and a write inside
//    execute_app_tools are refused, nothing runs, no Approval row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CustomConnectorList, CustomConnectorResponse } from "../../src/contract/m11.ts";
import { modelToolName } from "../../src/custom-connectors/provider.ts";
import { errorOf } from "../helpers/http.ts";
import { call, captureOutput, chatIn, FakeMcp, json, newChannel, resultsIn, startChannels, text, toolNames, type ChannelApp } from "../channels/harness.ts";

let m: ChannelApp;
const mcp = new FakeMcp();
const KEY = "wx-key-0123456789abcdef";
let channelId = "";
let mcpId = "";
let apiId = "";

beforeAll(async () => {
  m = await startChannels();
  mcp.tools = [
    { name: "search_pages", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "write_page", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } } },
    { name: "share_page", inputSchema: { type: "object", properties: { title: { type: "string" }, email: { type: "string" } } } },
    { name: "rotate_api_key", inputSchema: { type: "object", properties: {} } },
  ];
  m.net.route("mcp.example.com", mcp.handler);
  m.net.route("api.weather.example.com", (request) => Response.json({ sawAuth: request.headers.authorization ?? null, url: request.url, method: request.method }));
  channelId = (await newChannel(m, m.alex, { name: "M20" })).id;
  const created = await m.fixture.app.request("/api/custom-connectors", json(m.alex, "POST", { kind: "mcp", name: "Docs", url: "https://mcp.example.com/mcp", headers: [] }));
  mcpId = CustomConnectorResponse.parse(await created.json()).connector.id;
  const api = await m.fixture.app.request("/api/custom-connectors", json(m.alex, "POST", { kind: "api_key", name: "Weather", domain: "api.weather.example.com", headerName: "Authorization", valuePrefix: "Bearer ", key: KEY }));
  apiId = CustomConnectorResponse.parse(await api.json()).connector.id;
});
afterAll(() => m.cleanup());

const put = (body: Record<string, unknown>) => m.fixture.app.request(`/api/custom-connectors/${mcpId}/policy`, json(m.alex, "PUT", body));
const turn = async (...calls: { name: string; input: Record<string, unknown> }[]) => {
  m.llm.script("chat", calls.map((c) => call(c.name, c.input)), [text("Done.")]);
  const before = m.llm.sent("chat").length;
  await chatIn(m, m.alex, channelId, "go");
  return resultsIn(m.llm.sent("chat").slice(before)[1]);
};
const approvals = () => m.fixture.db.approval.count({ where: { userId: m.alex.userId } });

describe("safety floor", () => {
  test("tool rows carry alwaysAllowed / alwaysBlocked", async () => {
    const { connectors } = CustomConnectorList.parse(await (await m.fixture.app.request("/api/custom-connectors", { headers: m.alex.headers })).json());
    const docs = connectors.find((c) => c.id === mcpId)!;
    expect(docs.tools.map((t) => [t.name, t.alwaysAllowed, t.alwaysBlocked])).toEqual([
      ["search_pages", true, null], ["write_page", true, null], ["share_page", false, "per_recipient"], ["rotate_api_key", false, "floor"],
    ]);
    const key = connectors.find((c) => c.id === apiId)!;
    expect(key.tools).toEqual([expect.objectContaining({ name: "call_api", alwaysAllowed: true, alwaysBlocked: null })]);
  });

  test("PUT Always on a blocked tool is 400 always_not_allowed (nothing stored); Ask works; All tools: Always skips them", async () => {
    for (const tool of ["share_page", "rotate_api_key"]) {
      const refused = await put({ tool, mode: "always" });
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toMatchObject({ code: "always_not_allowed", field: "mode" });
    }
    expect(await m.fixture.db.toolPolicy.count({ where: { userId: m.alex.userId, toolSlug: { in: [`${mcpId}:share_page`, `${mcpId}:rotate_api_key`] } } })).toBe(0);
    expect((await put({ tool: "share_page", mode: "ask" })).status).toBe(200);
    const all = await put({ tool: null, mode: "always" });
    expect(all.status).toBe(200);
    const { connector } = CustomConnectorResponse.parse(await all.json());
    expect(connector.tools.map((t) => [t.name, t.mode])).toEqual([["search_pages", "always"], ["write_page", "always"], ["share_page", "ask"], ["rotate_api_key", "ask"]]);
    await put({ tool: null, mode: "ask" });
    await m.fixture.db.toolPolicy.deleteMany({ where: { userId: m.alex.userId } });
  });
});
describe("approvals.ask", () => {
  test("the same write twice posts one card (already_waiting); nothing runs", async () => {
    const before = await approvals();
    const write = modelToolName(mcpId, "write_page");
    const results = await turn({ name: write, input: { title: "Notes", body: "Hello" } }, { name: write, input: { title: "Notes", body: "Hello" } });
    expect(results.map((r) => r.status)).toEqual(["awaiting_approval", "already_waiting"]);
    expect(await approvals()).toBe(before + 1);
    expect(mcp.calls.some((c) => c.name === "write_page")).toBe(false);
  });
});

describe("credentials never leave", () => {
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

  test("MCP arguments: refused before anything runs or any card; the log has category and path only", async () => {
    const calls = mcp.calls.length;
    const before = await approvals();
    const output = captureOutput();
    let results: Record<string, unknown>[];
    try {
      results = await turn({ name: modelToolName(mcpId, "search_pages"), input: { query: `keys ${AWS}` } }, { name: modelToolName(mcpId, "write_page"), input: { title: "Key", body: PEM } });
    } finally {
      output.stop();
    }
    expect(results.map((r) => [r.status, r.findings])).toEqual([
      ["refused", [{ category: "provider_token", path: "$.query" }]],
      ["refused", [{ category: "private_key", path: "$.body" }]],
    ]);
    expect(String(results[0]!.error)).toStartWith("Not sent:");
    expect(JSON.stringify(results)).not.toContain(AWS);
    expect(mcp.calls.length).toBe(calls);
    expect(await approvals()).toBe(before);
    expect(output.text()).toContain("connector call refused: credential in arguments");
    expect(output.text()).not.toContain(AWS);
    expect(output.text()).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  });

  test("call_api: a key in a forwarded header, the query or the body is refused; the connector's own header isn't", async () => {
    const sent = m.net.to("api.weather.example.com").length;
    const before = await approvals();
    const results = await turn(
      { name: "call_api", input: { connector: apiId, method: "GET", url: "https://api.weather.example.com/today", headers: { "X-Api-Key": "abc123def456" } } },
      { name: "call_api", input: { connector: apiId, method: "GET", url: "https://api.weather.example.com/today?access_token=abc123def456" } },
      { name: "call_api", input: { connector: apiId, method: "POST", url: "https://api.weather.example.com/forecast", body: { city: "Oslo", password: "hunter2" } } },
      { name: "call_api", input: { connector: apiId, method: "GET", url: "https://api.weather.example.com/today", headers: { Authorization: "Bearer my-guess-0123456789abcdef" } } },
    );
    expect(results.slice(0, 3).map((r) => [r.status, r.findings])).toEqual([
      ["refused", [{ category: "credential_field", path: "$.headers.x-api-key" }]],
      ["refused", [{ category: "credential_field", path: "$.query.access_token" }]],
      ["refused", [{ category: "credential_field", path: "$.body.password" }]],
    ]);
    // The key's own header is the server's: the model's guess is dropped, never "sent", never refused.
    expect(results[3]).toMatchObject({ status: 200 });
    expect(m.net.to("api.weather.example.com").length).toBe(sent + 1);
    expect(m.net.to("api.weather.example.com").at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(await approvals()).toBe(before);
  });

  test("Approve checks the stored call again: an edited card carrying a key sends nothing", async () => {
    const [result] = await turn({ name: modelToolName(mcpId, "write_page"), input: { title: "Deploy", body: "steps" } });
    expect(result).toMatchObject({ status: "awaiting_approval" });
    const approval = await m.fixture.db.approval.findUniqueOrThrow({ where: { id: String(result!.approvalId) } });
    await m.fixture.db.approval.update({ where: { id: approval.id }, data: { arguments: JSON.stringify({ title: "Deploy", body: PEM }) } });
    const calls = mcp.calls.length;
    const response = await m.fixture.app.request(`/api/approvals/${approval.id}/approve`, json(m.alex, "POST", { version: approval.version }));
    expect(await response.json()).toMatchObject({ approval: { result: { ok: false, error: { key: "approval.failed", params: { reason: { value: "Not sent: the details carried a password, key or token." } } } } } });
    expect(mcp.calls.length).toBe(calls);
  });
});

describe("a check-in turn only reads", () => {
  const checkin = async (...rounds: ReturnType<typeof call>[][]) => {
    m.llm.script("proactive", ...rounds, [text("Nothing new.")]);
    const before = m.llm.sent("proactive").length;
    expect(await m.runs.submit({ userId: m.alex.userId, channelId, taskId: null, kind: "checkin", prompt: "Check-in." })).toBeString();
    await m.runs.idle();
    return m.llm.sent("proactive").slice(before);
  };

  test("call_api POST, MCP writes, computer_navigate and a write in execute_app_tools are refused: nothing runs, no Approval row; reads run", async () => {
    m.fake.connect(m.alex.userId, "gmail", "ca_m20");
    const counts = async () => ({ mcp: mcp.calls.length, api: m.net.to("api.weather.example.com").length, approvals: await approvals(), executions: m.fake.executions.length });
    const before = await counts();
    const sent = await checkin(
      [
        call("call_api", { connector: apiId, method: "POST", url: "https://api.weather.example.com/forecast", body: { city: "Oslo" } }),
        call(modelToolName(mcpId, "write_page"), { title: "x" }),
        call(modelToolName(mcpId, "share_page"), { title: "x", email: "evil@example.com" }),
        call("computer_navigate", { url: "https://evil.example" }),
        call("execute_app_tools", { calls: [{ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "evil@example.com", body: "hi" } }] }),
      ],
      [call("call_api", { connector: apiId, method: "GET", url: "https://api.weather.example.com/today" }), call(modelToolName(mcpId, "search_pages"), { query: "roadmap" })],
    );
    const offered = toolNames(sent[0]);
    expect(offered).toEqual(expect.arrayContaining(["call_api", modelToolName(mcpId, "search_pages"), "execute_app_tools"]));
    for (const name of [modelToolName(mcpId, "write_page"), modelToolName(mcpId, "share_page"), modelToolName(mcpId, "rotate_api_key"), "request_connection", "request_secret", "computer_navigate", "manage_app_connections"]) {
      expect(offered).not.toContain(name);
    }
    expect(resultsIn(sent[1]).map((r) => [r.status, r.tool])).toEqual([
      ["refused", "call_api"], ["refused", modelToolName(mcpId, "write_page")], ["refused", modelToolName(mcpId, "share_page")], ["refused", "computer_navigate"], ["refused", "execute_app_tools"],
    ]);
    const reads = resultsIn(sent[2]);
    expect(reads[0]).toMatchObject({ status: 200 });
    expect(reads[1]).toMatchObject({ status: "ok", tool: "search_pages" });
    expect(reads.every((r) => typeof r.untrusted === "string")).toBe(true);
    expect(await counts()).toEqual({ ...before, mcp: before.mcp + 1, api: before.api + 1 });
  });

  test("a read set to Ask is refused by the provider too (no card in a background turn)", async () => {
    expect((await put({ tool: "search_pages", mode: "ask" })).status).toBe(200);
    const before = { mcp: mcp.calls.length, approvals: await approvals() };
    const sent = await checkin([call(modelToolName(mcpId, "search_pages"), { query: "roadmap" })]);
    expect(resultsIn(sent[1])[0]).toMatchObject({ status: "refused", note: expect.stringContaining("Background turns can only read") });
    expect({ mcp: mcp.calls.length, approvals: await approvals() }).toEqual(before);
    await m.fixture.db.toolPolicy.deleteMany({ where: { userId: m.alex.userId } });
  });
});
