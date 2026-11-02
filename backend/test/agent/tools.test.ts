import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAgentRuntime, TOOL_STATUS } from "../../src/agent/runtime.ts";
import { phrase } from "../../src/agent/phrase.ts";
import { memoryProvider } from "../../src/memory/provider.ts";
import { SoulService } from "../../src/soul/service.ts";
import en from "../../src/i18n/en.json";
import zh from "../../src/i18n/zh-Hans.json";
import type { ToolResultBlock } from "../../src/llm/index.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, now, text, toolData, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });

test("all seven tools execute with real rows, tool results and localized system keys", async () => {
  const { input, recording } = await turnFixture(database.db);
  await database.db.message.create({ data: { userId: input.userId, channelId: input.channelId, role: "user", text: "明天的发布评审准备好了" } });
  const at = "2030-10-26T10:00:00+08:00";
  const llm = new RegisteredScriptedModel([
    [call("remember", { fact: "喜欢中文" }, "memory"), call("search_past_chats", { query: "发布评审" }, "past"), call("web_search", { query: "发布评审" }, "search"), call("web_fetch", { url: "https://public.example/page" }, "page"), call("set_reminder", { at, text: "准备评审" }, "reminder"), call("send_feedback", { text: "很好用" }, "feedback")],
    // M23 W4: this turn used web_search, so its quick replies aren't shown and the turn goes on.
    [text("要继续吗？"), call("quick_replies", { options: ["好", "暂不"] }, "quick")],
    [text("评审在明天上午十点。")],
  ]);
  // M11: remember lives in the memory provider (src/memory/); the main thread saves to "About you".
  const providers = [memoryProvider({ db: database.db, soul: new SoulService({ db: database.db }) })];
  const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url, SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: "test-only" }, now, providers,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async url => String(url).includes("api.tavily.com") ? Response.json({ results: [{ title: "Review", url: "https://public.example", content: "Snippet" }] }) : new Response("<html><body>页面内容</body></html>", { headers: { "content-type": "text/html" } }),
  }).runTurn(input);
  expect(result.status).toBe("completed"); expect(llm.requests).toHaveLength(3);
  expect(await database.db.memory.findMany({ where: { userId: input.userId }, select: { kind: true, text: true, channelId: true, source: true } })).toEqual([{ kind: "fact", text: "喜欢中文", channelId: null, source: "assistant" }]);
  expect(await database.db.reminder.findFirst({ where: { userId: input.userId } })).toMatchObject({ channelId: input.channelId, at: new Date(at), text: "准备评审", firedAt: null });
  expect(await database.db.feedback.findFirst({ where: { userId: input.userId } })).toMatchObject({ text: "很好用" });
  const results = llm.requests[1]!.messages.at(-1)!.content as ToolResultBlock[];
  expect(toolData(results[0]!)).toMatchObject({ saved: true, scope: "shared" });
  expect(toolData(results[1]!)).toMatchObject({ results: [{ text: "明天的发布评审准备好了", channelName: "main thread" }] });
  expect(toolData(results[2]!)).toMatchObject({ results: [{ title: "Review", snippet: "Snippet" }] });
  expect(toolData(results[3]!)).toMatchObject({ text: "页面内容" });
  expect([...recording.messages.values()].filter(m => m.kind === "system").map(m => m.payload)).toEqual([{ phrase: { key: "system.reminder_set", params: { at: { type: "datetime", value: at } } } }, { phrase: { key: "system.feedback_thanks" } }]);
  expect([...recording.messages.values()].some(m => m.kind === "quick_replies")).toBe(false);
  expect(toolData((llm.requests[2]!.messages.at(-1)!.content as ToolResultBlock[])[0]!)).toMatchObject({ shown: false, reason: "web_search" });
  // The page's text is short: the result says it may need the browser.
  expect(toolData(results[3]!)).toMatchObject({ note: expect.stringContaining("may need JavaScript") });
  expect(recording.statuses).toEqual(["thinking", "checking_memory", "thinking", "checking_memory", "thinking", "searching_web", "thinking", "reading_now", "thinking", "checking", "thinking", "checking", "thinking", "thinking", "thinking", null]);
  expect(TOOL_STATUS.web_fetch).toBe("reading_now");
});

test("invalid arguments and past reminders yield isError without writes", async () => {
  const { input, recording } = await turnFixture(database.db);
  const llm = new RegisteredScriptedModel([
    [call("remember", { fact: "" }), call("quick_replies", { options: ["one"] }), call("set_reminder", { at: "2000-01-01T00:00:00Z", text: "past" }), call("set_reminder", { at: "not iso", text: "bad" }), call("send_feedback", { text: 123 }), call("unknown_tool", {}), call("web_fetch", { url: "file:///secret" })],
    [text("请提供有效参数")],
  ]);
  expect((await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now }).runTurn(input)).status).toBe("completed");
  expect(llm.requests[1]?.messages.at(-1)?.content.every(b => b.type === "tool_result" && b.isError)).toBe(true);
  expect(await database.db.memory.count({ where: { userId: input.userId } })).toBe(0);
  expect(await database.db.reminder.count({ where: { userId: input.userId } })).toBe(0);
  expect(await database.db.feedback.count({ where: { userId: input.userId } })).toBe(0);
  expect([...recording.messages.values()].every(m => m.kind === "text")).toBe(true);
});

test("web failures are tool errors and do not fail the whole turn", async () => {
  const { input } = await turnFixture(database.db);
  const llm = new RegisteredScriptedModel([[call("web_search", { query: "query" }), call("web_fetch", { url: "https://private.example" })], [text("暂时无法读取")]]);
  const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url, SEARCH_PROVIDER: "brave", SEARCH_API_KEY: "secret-test-key" }, now, lookup: async () => [{ address: "10.0.0.1", family: 4 }], fetch: async () => new Response("secret-test-key", { status: 503 }) }).runTurn(input);
  expect(result.status).toBe("completed");
  expect(llm.requests[1]?.messages.at(-1)?.content.every(b => b.type === "tool_result" && b.isError)).toBe(true);
  expect(JSON.stringify(llm.requests[1]?.messages)).not.toContain("secret-test-key");
});

test("quick reply question payload ends immediately", async () => {
  const { input, recording } = await turnFixture(database.db);
  const llm = new RegisteredScriptedModel([[call("quick_replies", { options: ["Yes", "No", "Not now"], text: "Continue?" })], [text("must not stream")]]);
  expect((await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now }).runTurn(input)).status).toBe("completed");
  expect(llm.requests).toHaveLength(1);
  expect([...recording.messages.values()][0]).toMatchObject({ kind: "quick_replies", text: "Continue?" });
  expect(recording.typing.at(-1)).toBe(false);
});

test("tool-posted quick reply text and provider messages cannot bypass note cleanup", async () => {
  const { input, recording } = await turnFixture(database.db);
  const llm = new RegisteredScriptedModel([
    [call("post_message", { text: "查到了。[tools: web_search → ok]" })],
    [call("quick_replies", { options: ["好", "不用"], text: "继续吗？[attachment][tools: quick_replies → ok]" })],
  ]);
  const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now, providers: [{
    name: "posting-test",
    tools: async () => [{ name: "post_message", description: "Post text", inputSchema: { type: "object" } }],
    execute: async (tool, turn) => {
      await turn.sink.upsertMessage({ role: "assistant", kind: "text", text: String(tool.input.text) });
      return { result: { type: "tool_result", toolUseId: tool.id, content: [{ type: "text", text: "ok" }] }, endTurn: false };
    },
  }] }).runTurn(input);
  expect(result.status).toBe("completed");
  expect([...recording.messages.values()].map((m) => ({ kind: m.kind, text: m.text }))).toEqual([
    { kind: "text", text: "查到了。" }, { kind: "quick_replies", text: "继续吗？" },
  ]);
  for (const { draft } of recording.updates) if ("text" in draft) expect(draft.text).not.toContain("[");
});

test("i18n keys and placeholders match, phrase selects the user's language", () => {
  expect(Object.keys(en.phrases).sort()).toEqual(Object.keys(zh.phrases).sort());
  for (const key of Object.keys(en.phrases) as (keyof typeof en.phrases)[]) expect(en.phrases[key].match(/\{\w+\}/g) ?? []).toEqual(zh.phrases[key].match(/\{\w+\}/g) ?? []);
  expect(phrase("agent.morning_greeting", "zh-Hans")).toBe("早上好，{name}！今天：");
  expect(phrase("system.usage_limit_lifted", "en")).toBe("Usage limit lifted");
  expect(phrase("agent.morning_greeting", "zh-Hans")).toBe("早上好，{name}！今天：");
  expect(phrase("agent.on_it", "unknown")).toBe("On it");
});
