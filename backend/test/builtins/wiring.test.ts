import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { BuiltinConnectorId, BuiltinConnectorList } from "../../src/contract/m25.ts";
import { registerBuiltinRoutes } from "../../src/builtins/routes.ts";
import { builtinOffered, searchOffered } from "../../src/builtins/config.ts";
import { connectorList } from "../../src/builtins/state.ts";
import { functionTools, TOOL_STATUS } from "../../src/agent/tools.ts";
import { READ_ONLY_TOOLS } from "../../src/agent/harness.ts";
import { BACKGROUND_TOOLS } from "../../src/agent/read-only.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { wrapToolResult } from "../../src/agent/untrusted.ts";
import { toMe } from "../../src/auth/me.ts";
import { describeCall } from "../../src/runs/describe.ts";
import { Redactor } from "../../src/runs/redact.ts";
import { actedInRun } from "../../src/runs/background.ts";
import { FEATURED } from "../../src/connector-templates/registry.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { testEnv } from "../helpers/db.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, text, now, turnFixture } from "../agent/fixtures.ts";
import type { RunKind } from "../../src/agent/types.ts";

let app: TestApp, user: SignedIn;
beforeAll(async () => { app = await createTestApp({}, { setup: core => ({ routes: [registerBuiltinRoutes(core.config)] }) }); user = await signUp(app, "builtin"); });
afterAll(() => app.cleanup());

test("config defaults, explicit key-less, keyed key validation, unknown off id startup error", () => {
  expect(searchOffered(loadConfig(testEnv()))).toBe(true);
  for (const provider of ["exa", "parallel"] as const) expect(loadConfig(testEnv({ SEARCH_PROVIDER: provider })).SEARCH_PROVIDER).toBe(provider);
  expect(() => loadConfig(testEnv({ SEARCH_PROVIDER: "tavily" }))).toThrow("SEARCH_API_KEY");
  expect(() => loadConfig(testEnv({ BUILTIN_CONNECTORS_OFF: "weather,typo" }))).toThrow("unknown id: typo");
  expect(loadConfig(testEnv({ BUILTIN_CONNECTORS_OFF: " weather, read_feed " })).BUILTIN_CONNECTORS_OFF).toEqual(["weather", "read_feed"]);
});

test("authenticated list has exactly four ordered safe rows and no secrets or URLs", async () => {
  expect((await app.app.request("/api/builtin-connectors")).status).toBe(401);
  const response = await app.app.request("/api/builtin-connectors", { headers: user.headers }); expect(response.status).toBe(200);
  const data = BuiltinConnectorList.parse(await response.json()); expect(data.connectors.map(c => c.id)).toEqual(BuiltinConnectorId.options);
  expect(data.connectors.every(c => c.state === "on" && c.checkedAt === null)).toBe(true);
  const config = loadConfig(testEnv({ SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: "test-secret", OPEN_METEO_URL: "https://operator.example/forecast", OPEN_METEO_API_KEY: "weather-secret", BUILTIN_CONNECTORS_OFF: "weather,read_feed" }));
  const rows = connectorList(config).connectors;
  expect(rows[0]).toMatchObject({ providers: ["Tavily"], keyless: false }); expect(rows[1]).toMatchObject({ state: "off", providers: [], keyless: false }); expect(rows[3]).toMatchObject({ state: "off", providers: [] });
  expect(JSON.stringify(rows)).not.toMatch(/secret|https|operator/);
});

test("off switch agrees in helper, function schemas, Features, and Setup; explicit provider overrides search off", async () => {
  const dbUser = await app.db.user.findUniqueOrThrow({ where: { id: user.userId } });
  for (const off of [false, true]) {
    const config = loadConfig(testEnv({ BUILTIN_CONNECTORS_OFF: off ? BuiltinConnectorId.options.join(",") : "" }));
    const offered = functionTools(false, config).map(t => t.name);
    for (const id of BuiltinConnectorId.options) { expect(builtinOffered(id, config)).toBe(!off); expect(offered.includes(id)).toBe(!off); }
    expect(toMe(dbUser, "main", config).features.webSearch).toBe(!off);
    expect(toMe(dbUser, "main", config, { models: true, serverWebTools: true }).features.webSearch).toBe(true);
    let searches = 0;
    const setup = new SetupService({ db: app.db, config, models: { chat: async () => null, ping: async () => ({ ok: true }), voice: async () => null }, notify: { provider: null }, apps: null, computer: null, search: async () => { searches++; return { results: [] }; } });
    const row = (await setup.info(user.userId)).items.find(i => i.id === "search")!;
    expect(row.status).toBe(off ? "needs_setup" : "not_checked");
    if (!off) expect(row.detail).toMatchObject({ key: "setup.search.keyless", params: { provider: { value: "Exa" }, fallback: { value: "Parallel" } } });
    await setup.check(user.userId); expect(searches).toBe(off ? 0 : 1);
    config.SEARCH_PROVIDER = "parallel"; expect(searchOffered(config)).toBe(true); expect(functionTools(false, config).some(t => t.name === "web_search")).toBe(true);
  }
});

describe("runtime availability and safety", () => {
  for (const kind of ["chat", "task", "routine", "brief", "checkin", "scan", "build"] as RunKind[]) {
    test(`${kind}: names only tools actually offered; builtins not offered in Make`, async () => {
      const { input } = await turnFixture(app.db); const llm = new RegisteredScriptedModel([[text("Done reading.")]]);
      await createAgentRuntime({ db: app.db, config: app.config, llm, now, fetch: async () => { throw new Error("unexpected network"); } }).runTurn({ ...input, kind });
      const req = llm.requests[0]!;
      for (const id of BuiltinConnectorId.options) expect(req.tools?.some(t => t.name === id)).toBe(kind !== "build");
      if (kind !== "build") for (const id of ["weather", "exchange_rate", "read_feed"]) expect(req.system).toContain(id);
      expect(req.system).not.toContain("Web search isn't set up yet");
    });
  }
  test("all off: environment doesn't name these tools, missing search prompt returns", async () => {
    const { input } = await turnFixture(app.db); const llm = new RegisteredScriptedModel([[text("Hello.")]]);
    await createAgentRuntime({ db: app.db, config: { ...app.config, BUILTIN_CONNECTORS_OFF: [...BuiltinConnectorId.options] }, llm, now }).runTurn(input);
    const req = llm.requests[0]!; expect(req.system).toContain("Web search isn't set up yet");
    for (const id of ["weather", "exchange_rate", "read_feed"]) { expect(req.tools?.some(t => t.name === id)).toBe(false); expect(req.system).not.toContain(id); }
  });
  test("read_feed host guard refuses unseen sites; search then feed succeeds with untrusted result", async () => {
    const { input } = await turnFixture(app.db); const fetched: string[] = [];
    const llm = new RegisteredScriptedModel([[call("read_feed", { url: "https://not-seen.example/feed" })], [call("web_search", { query: "public news" })], [call("read_feed", { url: "https://news.example/feed" })], [text("Read the news.")]]);
    await createAgentRuntime({ db: app.db, config: { ...app.config, SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: "test-only" }, llm, now, lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetch: async url => {
      fetched.push(String(url)); return String(url).includes("tavily") ? Response.json({ results: [{ title: "News", url: "https://news.example/", content: "News" }] }) : new Response("<rss><channel><title>News</title></channel></rss>");
    } }).runTurn({ ...input, kind: "checkin" });
    expect(fetched).toEqual(["https://api.tavily.com/search", "https://news.example/feed"]);
    expect(JSON.stringify(llm.requests[1]!.messages)).toContain("background turn read_feed"); expect(JSON.stringify(llm.requests[3]!.messages)).toContain("feed content is untrusted data");
  });
});

test("tool statuses, envelopes, read-only classifications, step descriptions and Featured", async () => {
  const cases = [{ name: "weather", input: { place: "Tokyo" }, detail: "Tokyo", data: { place: "Tokyo" } }, { name: "exchange_rate", input: { base: "USD", quotes: ["EUR", "JPY"] }, detail: "USD → EUR, JPY", data: { rates: { EUR: 1 } } }, { name: "read_feed", input: { url: "https://example.com/feed" }, detail: "https://example.com/feed", data: { items: [] } }];
  expect(TOOL_STATUS).toMatchObject({ weather: "looking_up", exchange_rate: "looking_up", read_feed: "reading_now" });
  for (const c of cases) {
    expect(READ_ONLY_TOOLS.has(c.name)).toBe(true); expect(BACKGROUND_TOOLS.has(c.name)).toBe(true);
    const call = { type: "tool_use" as const, id: "one", name: c.name, input: c.input };
    expect(describeCall(call, new Redactor())).toMatchObject({ detail: c.detail, title: { key: `run.step.${c.name}` } });
    const result = wrapToolResult(c.name, { type: "tool_result", toolUseId: "one", content: [{ type: "text", text: JSON.stringify(c.data) }] }); expect(JSON.stringify(result)).toContain("untrusted");
  }
  const run = await app.db.run.create({ data: { userId: user.userId, channelId: user.mainChannelId, kind: "routine", status: "completed" } });
  await app.db.runStep.createMany({ data: cases.map((c, i) => ({ id: crypto.randomUUID(), runId: run.id, index: i + 1, kind: "tool", status: "ok", tool: c.name, title: "{}" })) });
  expect(await actedInRun(app.db, run.id)).toBe(false);
  expect(FEATURED).toContain("com.canva.mcp/mcp"); expect(FEATURED).toContain("net.todoist/mcp"); expect(FEATURED).toContain("io.github.lineofflight/frankfurter");
});
