// M29 tools on demand (agent/loading.ts): the pure parts (summaries, the plan, load_tools' names,
// its answer, the "More tools" index, connector mentions, a call's tools), then real turns on a
// scripted model: a chat turn starts with the core tools and load_tools, loading appends, a group
// loads by name up to MAX_GROUP_LOAD, a direct call still runs and stays, other kinds and small
// offers send everything as before. Cross-turn carry-over and connector preload: loading-turns.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { firstSentence, indexLines, LOAD_TOOLS, loadAnswer, MAX_GROUP_LOAD, mentionedConnectors, planLoading, resolveLoad, toolsForCall, type LoadPlan, type ToolIndexEntry } from "../../src/agent/loading.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { RunKind, ToolProvider, TurnInput } from "../../src/agent/types.ts";
import type { LlmRequest, Tool, ToolResultBlock } from "../../src/llm/index.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel, type ScriptTurn } from "../helpers/scripted-model.ts";
import { call, now, text, toolData, turnFixture } from "./fixtures.ts";

const tool = (name: string, description = `${name} does a thing. More detail here.`): Tool => ({ name, description, inputSchema: { type: "object", properties: {} } });
const GROUPS: Record<string, string> = { weather: "Lookups", exchange_rate: "Lookups", show_card: "Cards", ask_form: "Cards", withdraw_card: "Cards" };
const entry = (t: Tool): ToolIndexEntry => t.name.startsWith("mcp_")
  ? { group: "Notion", summary: firstSentence(t.description), connector: true }
  : t.name.startsWith("bulk_") ? { group: "Bulk", summary: "" } : { group: GROUPS[t.name] ?? "Other", summary: firstSentence(t.description) };
const TOOLS = [
  tool("quick_replies"), tool("weather"), tool("exchange_rate"), tool("show_card"), tool("ask_form"), tool("withdraw_card"),
  tool("mcp_ab12cd_search"), tool("mcp_ab12cd_create_pages"), tool("react"),
  ...Array.from({ length: MAX_GROUP_LOAD + 1 }, (_, i) => tool(`bulk_${i}`)),
];
const plan = (kind: RunKind = "chat", tools: Tool[] = TOOLS, minChars = 0): LoadPlan => planLoading({ kind, modelTools: true, tools, entry, minChars });

describe("the pure parts", () => {
  test("firstSentence: up to the first sentence (not at e.g. or a decimal), CJK stops, at most 100 characters cut at a word", () => {
    expect(firstSentence("Search the wiki. Then more.")).toBe("Search the wiki.");
    expect(firstSentence("Use a ref (e.g. e12) from the snapshot. Then click.")).toBe("Use a ref (e.g. e12) from the snapshot.");
    expect(firstSentence("Costs 2.5 credits per page. Fine.")).toBe("Costs 2.5 credits per page.");
    expect(firstSentence("查找页面。然后写入。")).toBe("查找页面。");
    expect(firstSentence("  spaced \n  out  ")).toBe("spaced out");
    const long = firstSentence(`${"word ".repeat(40)}end.`);
    expect([...long].length).toBeLessThanOrEqual(100);
    expect(long.endsWith("word…")).toBe(true);
  });

  test("planLoading: chat and task split core from deferred; other kinds, a model without tools and a small offer don't", () => {
    const chat = plan();
    expect(chat.on).toBe(true);
    expect([...chat.core]).toEqual(["quick_replies", "react"]);
    expect([...chat.deferred.keys()].slice(0, 4)).toEqual(["weather", "exchange_rate", "show_card", "ask_form"]);
    expect(chat.entries.get("mcp_ab12cd_search")).toEqual({ group: "Notion", summary: "mcp_ab12cd_search does a thing.", connector: true });
    expect(plan("task").on).toBe(true);
    for (const kind of ["brief", "checkin", "scan", "routine", "build"] as const) expect(plan(kind).on).toBe(false);
    expect(planLoading({ kind: "chat", modelTools: false, tools: TOOLS, entry, minChars: 0 }).on).toBe(false);
    expect(plan("chat", TOOLS, 1_000_000).on).toBe(false);
    expect(plan("chat", [tool("quick_replies"), tool("react")]).on).toBe(false);
  });
  test("resolveLoad: exact names, a group by name in any case up to MAX_GROUP_LOAD, core and loaded ones are already there, unknown and too big reported", () => {
    const p = plan();
    expect(resolveLoad(["lookups", "show_card", "quick_replies", "nope", "Bulk", " bulk_3 ", LOAD_TOOLS, ""], p, ["show_card"])).toEqual({
      loaded: ["weather", "exchange_rate", "bulk_3"],
      already: ["show_card", "quick_replies"],
      unknown: ["nope"],
      tooMany: [{ group: "Bulk", count: MAX_GROUP_LOAD + 1 }],
      capped: [],
    });
    expect(resolveLoad(["CARDS", "ask_form"], p, [])).toMatchObject({ loaded: ["show_card", "ask_form", "withdraw_card"], already: ["ask_form"] });
    // The turn's cap counts what's loaded already.
    expect(resolveLoad(["weather", "exchange_rate", "show_card"], p, ["ask_form"], 2)).toMatchObject({ loaded: ["weather"], capped: ["exchange_rate", "show_card"] });
  });

  test("loadAnswer: what was loaded and what was there; an error only when nothing is usable", () => {
    expect(loadAnswer({ loaded: ["weather"], already: ["show_card"], unknown: [], tooMany: [], capped: [] })).toEqual({ data: { loaded: ["weather"], alreadyAvailable: ["show_card"], ready: "Call them now." }, isError: false });
    const none = loadAnswer({ loaded: [], already: [], unknown: ["nope"], tooMany: [{ group: "Bulk", count: 17 }], capped: [] });
    expect(none.isError).toBe(true);
    expect(none.data.loaded).toEqual([]);
    expect(none.data.note).toContain("Not tools or groups of this turn: nope.");
    expect(none.data.note).toContain("Bulk has 17 tools: name the ones you need instead of the group.");
    expect(loadAnswer({ loaded: [], already: [], unknown: [], tooMany: [], capped: ["weather"] }).data.note).toContain("so these weren't: weather");
  });

  test("indexLines: the deferred tools under their groups, connectors last; the ones a turn starts with are named as loaded", () => {
    expect(indexLines(plan("routine"))).toEqual([]);
    const lines = indexLines(plan(), ["weather", "quick_replies", "mcp_ab12cd_search"]);
    expect(lines[0]).toStartWith("More tools (offered on this turn, not loaded yet). Before using any of them, call load_tools once");
    expect(lines[1]).toBe("Already loaded for this turn, call them directly: weather, mcp_ab12cd_search.");
    expect(lines.slice(2, 7)).toEqual(["Lookups:", "- exchange_rate: exchange_rate does a thing.", "Cards:", "- show_card: show_card does a thing.", "- ask_form: ask_form does a thing."]);
    expect(lines).toContain("- bulk_0");
    expect(lines.slice(-2)).toEqual(["Notion (connector):", "- mcp_ab12cd_create_pages: mcp_ab12cd_create_pages does a thing."]);
    expect(lines.join("\n")).not.toContain("- weather:");
    expect(lines.join("\n")).not.toContain("- quick_replies");
    expect(indexLines(plan())[1]).toBe("Lookups:");
  });

  test("mentionedConnectors: a connector's name as a whole word in any case; never a built-in group", () => {
    const p = plan();
    expect(mentionedConnectors("去 Notion 写一条会议纪要", p)).toEqual(["Notion"]);
    expect(mentionedConnectors("add it to notion, please", p)).toEqual(["Notion"]);
    expect(mentionedConnectors("the notional value", p)).toEqual([]);
    expect(mentionedConnectors("show me the cards and the lookups", p)).toEqual([]);
    expect(mentionedConnectors("notion", plan("routine"))).toEqual([]);
  });

  test("toolsForCall: the core ones in the turn's order, load_tools, then what's loaded in load order, once each", () => {
    const p = plan();
    expect(toolsForCall(TOOLS, p, []).map((t) => t.name)).toEqual(["quick_replies", "react", LOAD_TOOLS]);
    expect(toolsForCall(TOOLS, p, ["show_card", "weather", "show_card", "quick_replies", "gone"]).map((t) => t.name)).toEqual(["quick_replies", "react", LOAD_TOOLS, "show_card", "weather"]);
    const off = plan("routine");
    expect(toolsForCall(TOOLS, off, ["show_card"])).toEqual(TOOLS);
  });
});

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });

/** A provider of a few tools that records what ran (its pill: searching_email). */
function shelf(name: string, tools: string[]): ToolProvider & { ran: string[] } {
  const ran: string[] = [];
  return {
    name, ran,
    tools: async () => tools.map((t) => tool(t)),
    status: () => "searching_email",
    execute: async (use) => { ran.push(use.name); return { result: { type: "tool_result", toolUseId: use.id, content: [{ type: "text", text: "{\"ok\":true}" }] }, endTurn: false }; },
  };
}
const SHELF = ["shelf_find", "shelf_put", "shelf_drop"];
const BIG = Array.from({ length: MAX_GROUP_LOAD + 1 }, (_, i) => `big_${i}`);
const names = (request: LlmRequest | undefined) => (request?.tools ?? []).map((t) => t.name);
const lastResults = (request: LlmRequest) => request.messages.at(-1)!.content.filter((b): b is ToolResultBlock => b.type === "tool_result").map(toolData);

async function turn(script: ScriptTurn[], opts: { kind?: RunKind; task?: boolean; minChars?: number; providers?: ToolProvider[] } = {}) {
  const { input, recording } = await turnFixture(database.db, opts.task);
  const providers = opts.providers ?? [shelf("shelf", SHELF)];
  const llm = new RegisteredScriptedModel(script);
  const runtime = createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now, providers, deferMinChars: opts.minChars ?? 0 });
  const turnInput: TurnInput = opts.kind ? { ...input, kind: opts.kind } : input;
  const result = await runtime.runTurn(turnInput);
  return { result, llm, recording, providers };
}

describe("in a turn (scripted model, every deferrable tool deferred)", () => {
  test("the first call has the core tools and load_tools; a loaded tool is appended for the next call; the pill stays Thinking", async () => {
    const { result, llm, recording, providers } = await turn([
      [call(LOAD_TOOLS, { tools: ["shelf_find"] }, "l1")],
      [call("shelf_find", {}, "f1")],
      [text("Found it.")],
    ]);
    expect(result.status).toBe("completed");
    const first = names(llm.requests[0]);
    expect(first).toContain("quick_replies");
    expect(first.at(-1)).toBe(LOAD_TOOLS);
    for (const absent of [...SHELF, "weather", "cancel_reminder"]) expect(first).not.toContain(absent);
    const system = llm.requests[0]!.system!;
    expect(system).toContain("More tools (offered on this turn, not loaded yet).");
    expect(system).toContain("Shelf:\n- shelf_find: shelf_find does a thing.");
    expect(system).toContain("Tools ready now: ");
    expect(lastResults(llm.requests[1]!)).toEqual([{ loaded: ["shelf_find"], ready: "Call them now." }]);
    expect(names(llm.requests[1])).toEqual([...first, "shelf_find"]);
    expect(names(llm.requests[2])).toEqual([...first, "shelf_find"]);
    // The index stays as it was for the whole turn.
    expect(llm.requests[2]!.system).toBe(system);
    expect((providers[0] as ReturnType<typeof shelf>).ran).toEqual(["shelf_find"]);
    expect(recording.statuses).toEqual(["thinking", "thinking", "thinking", "searching_email", "thinking", null]);
  });

  test("a small group loads by its name; a big one asks for names; unknown names are said", async () => {
    const { llm } = await turn([
      [call(LOAD_TOOLS, { tools: ["shelf", "Big", "nope"] }, "l1")],
      [call(LOAD_TOOLS, { tools: ["nope"] }, "l2")],
      [text("ok")],
    ], { providers: [shelf("shelf", SHELF), shelf("big", BIG)] });
    const [answer] = lastResults(llm.requests[1]!) as { loaded: string[]; note: string }[];
    expect(answer!.loaded).toEqual(SHELF);
    expect(answer!.note).toContain("Not tools or groups of this turn: nope.");
    expect(answer!.note).toContain(`Big has ${MAX_GROUP_LOAD + 1} tools: name the ones you need instead of the group.`);
    expect(names(llm.requests[1]).slice(-3)).toEqual(SHELF);
    expect(names(llm.requests[1]).some((n) => n.startsWith("big_"))).toBe(false);
    const block = llm.requests[2]!.messages.at(-1)!.content[0]!;
    expect(block).toMatchObject({ type: "tool_result", isError: true });
    expect(names(llm.requests[2])).toEqual(names(llm.requests[1]));
  });

  test("a deferred tool called without load_tools still runs and stays; a name the turn doesn't offer is refused", async () => {
    const { llm, providers } = await turn([
      [call("shelf_put", {}, "p1")],
      [call("no_such_tool", {}, "n1")],
      [text("done")],
    ]);
    expect((providers[0] as ReturnType<typeof shelf>).ran).toEqual(["shelf_put"]);
    expect(names(llm.requests[1]).at(-1)).toBe("shelf_put");
    expect(lastResults(llm.requests[2]!)).toEqual([{ error: "Tool is not available" }]);
    expect(names(llm.requests[2])).toEqual(names(llm.requests[1]));
  });

  test("check-ins and routines send their tools as before; a task turn defers too; a small offer sends everything", async () => {
    for (const kind of ["checkin", "routine"] as const) {
      const { llm } = await turn([[text("ok")]], { kind });
      expect(names(llm.requests[0])).not.toContain(LOAD_TOOLS);
      expect(names(llm.requests[0])).toContain("weather");
      expect(llm.requests[0]!.system).not.toContain("More tools (");
    }
    const routine = await turn([[text("ok")]], { kind: "routine" });
    expect(names(routine.llm.requests[0])).toEqual(expect.arrayContaining(SHELF));
    const task = await turn([[text("ok")]], { task: true });
    expect(names(task.llm.requests[0])).toContain(LOAD_TOOLS);
    expect(names(task.llm.requests[0])).not.toContain("shelf_find");
    const small = await turn([[text("ok")]], { minChars: 1_000_000 });
    expect(names(small.llm.requests[0])).toEqual(expect.arrayContaining([...SHELF, "weather"]));
    expect(names(small.llm.requests[0])).not.toContain(LOAD_TOOLS);
    expect(small.llm.requests[0]!.system).toContain("Tools this turn: ");
    expect(small.llm.requests[0]!.system).not.toContain("More tools (");
  });
});
