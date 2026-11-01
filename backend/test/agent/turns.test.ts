// M14a B1/B3/B4: how the turn loop treats bad tool arguments, ends a turn and keeps its context small.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { claimsDeliverable, couldBePass, isPass } from "../../src/agent/harness.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import type { LlmEvent, LlmRequest, ToolResultBlock } from "../../src/llm/index.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, now, text, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });
function runtime(llm: RegisteredScriptedModel, providers: ToolProvider[] = []) {
  return createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url, BUILTIN_CONNECTORS_OFF: ["web_search"] }, now, providers, fetch: async () => { throw new Error("Unexpected network in scripted turn"); } });
}
/** A provider tool that records its calls and answers with `answer(call)`. */
function probe(name: string, answer: (input: Record<string, unknown>) => ToolResultBlock["content"] | Error = () => [{ type: "text", text: "{\"ok\":true}" }]) {
  const calls: Record<string, unknown>[] = [];
  const provider: ToolProvider = {
    name: `probe-${name}`,
    async tools() { return [{ name, description: "probe", inputSchema: { type: "object" } }]; },
    async execute(c) {
      calls.push(c.input);
      const content = answer(c.input);
      if (content instanceof Error) throw content;
      return { result: { type: "tool_result", toolUseId: c.id, content }, endTurn: false };
    },
  };
  return { provider, calls };
}
const results = (request: LlmRequest | undefined) => (request?.messages.at(-1)?.content ?? []).flatMap(b => (b.type === "tool_result" ? [b] : []));
const resultText = (block: ToolResultBlock | undefined) => (block?.content ?? []).flatMap(c => (c.type === "text" ? [c.text] : [])).join("");
const posted = (recording: Awaited<ReturnType<typeof turnFixture>>["recording"]) => [...recording.messages.values()].filter(m => m.role === "assistant").map(m => m.text);

describe("B1: a call with invalid arguments", () => {
  test("is answered with an error tool_result and never executed; the turn goes on", async () => {
    const { input, recording } = await turnFixture(database.db);
    const tool = probe("lookup");
    const bad: LlmEvent = { type: "tool_call", id: "bad1", name: "lookup", input: {}, invalid: "arguments" };
    const llm = new RegisteredScriptedModel([[bad], [text("好了")]]);
    const result = await runtime(llm, [tool.provider]).runTurn(input);
    expect(result.status).toBe("completed");
    expect(tool.calls).toHaveLength(0);
    const answer = results(llm.requests[1])[0];
    expect(answer).toMatchObject({ toolUseId: "bad1", isError: true });
    expect(resultText(answer)).toContain("Your arguments for lookup were not valid JSON. Send the call again with one JSON object.");
    expect(posted(recording)).toEqual(["好了"]);
  });
  test("a valid call in the same round still runs", async () => {
    const { input } = await turnFixture(database.db);
    const tool = probe("lookup");
    const llm = new RegisteredScriptedModel([[{ type: "tool_call", id: "bad", name: "lookup", input: {}, invalid: "arguments" }, call("lookup", { q: 1 }, "good")], [text("ok")]]);
    await runtime(llm, [tool.provider]).runTurn(input);
    expect(tool.calls).toEqual([{ q: 1 }]);
    expect(results(llm.requests[1]).map(r => [r.toolUseId, !!r.isError])).toEqual([["bad", true], ["good", false]]);
  });
});

describe("M27: pass predicates", () => {
  test("ASCII and full-width pass work with or without a reaction", () => {
    for (const reacted of [false, true]) for (const value of ["(pass)", " （pass） \n"]) expect(isPass(value, reacted)).toBe(true);
  });
  test("short Chinese and English parentheticals pass only after a stored reaction", () => {
    for (const value of ["（收到）", " (ok)! ", "（好的）。", "(no reply needed)", "（谢谢）！…", `(${"字".repeat(24)})`, `(${"😀".repeat(24)})`]) {
      expect(isPass(value, true)).toBe(true);
      expect(isPass(value, false)).toBe(false);
    }
  });
  test("prose, long, mismatched or nested parentheses are never swallowed", () => {
    for (const value of ["(Updated) Here is the plan…", "（注：更新）后面还有正文", "Here is (ok)", "（收到） (ok)", "(ok）", "((ok))", "()", "（ ）", `(${"x".repeat(25)})`, "(ok", "ok)"]) {
      expect(isPass(value, true)).toBe(false);
      expect(isPass(value, false)).toBe(false);
    }
  });
  test("streaming holds possible passes and releases ordinary prose", () => {
    for (const value of ["(", "(pa", "（", "（pass", "（pass）"]) expect(couldBePass(value)).toBe(true);
    for (const value of ["（收", "（收到）", "(no reply needed", "(ok)! "]) expect(couldBePass(value, true)).toBe(true);
    for (const value of ["（收到）", "(ok)"]) expect(couldBePass(value)).toBe(false);
    for (const value of ["（收到）正文", "(Updated) Here is the plan", `(${"x".repeat(25)}`, "((ok)"]) expect(couldBePass(value, true)).toBe(false);
  });
});

describe("B3: how a turn ends", () => {
  test("a reply that is exactly (pass) is never posted and needs no nudge", async () => {
    const { input, recording } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[text("  (pa"), text("ss) ")]]);
    expect((await runtime(llm).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(1);
    expect(posted(recording)).toEqual([]);
  });
  test("a full-width pass is never streamed, posted or nudged", async () => {
    const { input, recording } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[text("（pa"), text("ss）")]]);
    expect((await runtime(llm).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(1);
    expect(recording.updates).toHaveLength(0);
  });
  test("a stored reaction suppresses stage directions, but a spacing refusal does not", async () => {
    for (const status of ["reacted", "not_reacted"]) {
      const { input, recording } = await turnFixture(database.db);
      const react = probe("react", () => [{ type: "text", text: JSON.stringify({ status }) }]);
      const llm = new RegisteredScriptedModel([[call("react", { emoji: "👍" })], [text("（收"), text("到）。")]]);
      expect((await runtime(llm, [react.provider]).runTurn(input)).status).toBe("completed");
      expect(llm.requests).toHaveLength(2);
      expect(posted(recording)).toEqual(status === "reacted" ? [] : ["（收到）。"]);
      if (status === "reacted") expect(recording.updates).toHaveLength(0);
    }
  });
  test("bubbles hold back a possible (pass) only until it can't be one", async () => {
    const cases: [string[], string][] = [[["(may", "be later)"], "(maybe later)"], [["(pass", ") 好的"], "(pass) 好的"], [["(", "笑)"], "(笑)"]];
    for (const [chunks, shown] of cases) {
      const { input, recording } = await turnFixture(database.db);
      await runtime(new RegisteredScriptedModel([chunks.map(c => text(c))])).runTurn(input);
      expect(posted(recording)).toEqual([shown]);
      expect(recording.updates.every(u => u.draft.kind !== "text" || u.draft.text.trim() !== "(pass)")).toBe(true);
    }
  });
  test("a turn whose only output is a successful react is complete: no nudge", async () => {
    const { input, recording } = await turnFixture(database.db);
    const react = probe("react", () => [{ type: "text", text: "{\"status\":\"reacted\"}" }]);
    const llm = new RegisteredScriptedModel([[call("react", { messageId: input.userMessage.id, emoji: "👍" })], []]);
    expect((await runtime(llm, [react.provider]).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]!.messages)).not.toContain("Your reply was empty");
    expect(posted(recording)).toEqual([]);
  });
  test("an empty chat reply gets one nudge; the answer after it is posted", async () => {
    const { input, recording } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[], [text("在的，我来看看")]]);
    expect((await runtime(llm).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]!.messages.at(-1))).toContain("[Your reply was empty. Answer the user, or reply exactly (pass) if no reply is needed.]");
    expect(llm.requests[1]!.messages.at(-1)!.role).toBe("user");
    expect(posted(recording)).toEqual(["在的，我来看看"]);
  });
  test("a second empty reply ends quietly; task turns are nudged, background turns are not", async () => {
    const chat = await turnFixture(database.db);
    const twice = new RegisteredScriptedModel([[], []]);
    expect((await runtime(twice).runTurn(chat.input)).status).toBe("completed");
    expect(twice.requests).toHaveLength(2);
    expect(posted(chat.recording)).toEqual([]);
    const task = await turnFixture(database.db, true);
    const taskLlm = new RegisteredScriptedModel([[], [text("ok")]]);
    await runtime(taskLlm).runTurn(task.input);
    expect(taskLlm.requests).toHaveLength(2);
    const brief = await turnFixture(database.db);
    const briefLlm = new RegisteredScriptedModel([[]]);
    expect((await runtime(briefLlm).runTurn({ ...brief.input, kind: "brief" })).status).toBe("completed");
    expect(briefLlm.requests).toHaveLength(1);
  });
  test("an empty reply after a tool such as web_search gets one nudge; the answer after it is posted", async () => {
    const { input, recording } = await turnFixture(database.db);
    const search = probe("web_search", () => [{ type: "text", text: "{\"results\":[{\"title\":\"Lisbon weather\",\"snippet\":\"Sunny, 22°C\"}]}" }]);
    const llm = new RegisteredScriptedModel([[call("web_search", { query: "weather lisbon" })], [], [text("Sunny in Lisbon, 22°C.")]]);
    expect((await runtime(llm, [search.provider]).runTurn(input)).status).toBe("completed");
    expect(search.calls).toHaveLength(1);
    expect(llm.requests).toHaveLength(3);
    expect(JSON.stringify(llm.requests[2]!.messages.at(-1))).toContain("[Your reply was empty. Answer the user, or reply exactly (pass) if no reply is needed.]");
    expect(posted(recording)).toEqual(["Sunny in Lisbon, 22°C."]);
  });
  test("an empty reply after a successful card tool is complete; after a react that failed it is nudged", async () => {
    const { input } = await turnFixture(database.db);
    const card = probe("show_card", () => [{ type: "text", text: "{\"shown\":true}" }]);
    const llm = new RegisteredScriptedModel([[call("show_card", { title: "Flights" })], []]);
    expect((await runtime(llm, [card.provider]).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]!.messages)).not.toContain("Your reply was empty");

    const failed = await turnFixture(database.db);
    const react = probe("react", () => new Error("boom"));
    const again = new RegisteredScriptedModel([[call("react", { messageId: failed.input.userMessage.id, emoji: "👍" })], [], [text("Got it.")]]);
    expect((await runtime(again, [react.provider]).runTurn(failed.input)).status).toBe("completed");
    expect(again.requests).toHaveLength(3);
    expect(JSON.stringify(again.requests[2]!.messages.at(-1))).toContain("Your reply was empty");
  });
  test("the step budget ends in a tool-less wrap-up whose text is posted", async () => {
    const { input, recording } = await turnFixture(database.db);
    const tool = probe("lookup");
    const llm = new RegisteredScriptedModel([...Array.from({ length: 12 }, (_, i) => [call("lookup", { page: i })]), [text("做完了前 12 步，剩下的需要你确认。")]]);
    const result = await runtime(llm, [tool.provider]).runTurn(input);
    expect(result).toMatchObject({ status: "completed", error: null });
    expect(llm.requests).toHaveLength(13);
    expect(llm.requests[12]!.tools).toEqual([]);
    expect(llm.requests[11]!.tools?.length).toBeGreaterThan(0);
    expect(resultText(results(llm.requests[12])[0])).toContain("{\"ok\":true}");
    expect(JSON.stringify(llm.requests[12]!.messages.at(-1))).toContain("Summarize for the user what you accomplished, what is still pending, and what they should do next.");
    expect(posted(recording)).toEqual(["做完了前 12 步，剩下的需要你确认。"]);
  });
  test("the same call with the same input a third time gets the repeat note (key order doesn't matter)", async () => {
    const { input } = await turnFixture(database.db);
    const tool = probe("lookup");
    const llm = new RegisteredScriptedModel([[call("lookup", { a: 1, b: 2 })], [call("lookup", { b: 2, a: 1 })], [call("lookup", { a: 1, b: 2 })], [call("lookup", { a: 2 })], [text("好")]]);
    await runtime(llm, [tool.provider]).runTurn(input);
    const note = "[You've called lookup with the same input 3 times; the answer won't change. Use what you have or try something else.]";
    expect(resultText(results(llm.requests[1])[0])).not.toContain(note);
    expect(resultText(results(llm.requests[2])[0])).not.toContain(note);
    expect(resultText(results(llm.requests[3])[0])).toContain(note);
    expect(resultText(results(llm.requests[4])[0])).not.toContain(note);
    expect(tool.calls).toHaveLength(4);
  });
  test("a provider tool that throws says it may or may not have taken effect", async () => {
    const { input } = await turnFixture(database.db);
    const tool = probe("send", () => new Error("boom"));
    const llm = new RegisteredScriptedModel([[call("send", { to: "x" })], [text("我检查一下")]]);
    expect((await runtime(llm, [tool.provider]).runTurn(input)).status).toBe("completed");
    const answer = results(llm.requests[1])[0];
    expect(answer?.isError).toBe(true);
    expect(resultText(answer)).toContain("The tool failed on the server; it may or may not have taken effect. Check before trying it again.");
  });
});

describe("B4: context budget inside a turn", () => {
  test("a tool result over 20k chars is seen whole once, then kept as head 14k + marker + tail 4k", async () => {
    const { input } = await turnFixture(database.db);
    const long = "H".repeat(14_000) + "M".repeat(32_000) + "T".repeat(4_000);
    const tool = probe("read_page", () => [{ type: "text", text: long }]);
    const small = probe("note");
    const llm = new RegisteredScriptedModel([[call("read_page", {})], [call("note", {})], [text("读完了")]]);
    await runtime(llm, [tool.provider, small.provider]).runTurn(input);
    const firstSeen = (llm.requests[1]!.messages.flatMap(m => m.content).find(b => b.type === "tool_result") as ToolResultBlock);
    expect(resultText(firstSeen)).toBe(long);
    const later = llm.requests[2]!.messages.flatMap(m => m.content).filter(b => b.type === "tool_result") as ToolResultBlock[];
    const capped = resultText(later[0]);
    expect(capped).toBe(`${"H".repeat(14_000)}\n[… 32000 characters cut …]\n${"T".repeat(4_000)}`);
    expect(resultText(later[1])).toBe("{\"ok\":true}");
  });
  test("images stay only in the newest 4 messages that carry them", async () => {
    const { input } = await turnFixture(database.db);
    let n = 0;
    const shot = probe("screenshot", () => [{ type: "text", text: `shot ${++n}` }, { type: "image", mediaType: "image/png", data: `img${n}` }]);
    const llm = new RegisteredScriptedModel([...Array.from({ length: 6 }, () => [call("screenshot", { n: Math.random() })]), [text("看完了")]]);
    await runtime(llm, [shot.provider]).runTurn(input);
    const last = llm.requests[6]!.messages;
    const images = last.flatMap(m => m.content.flatMap(b => (b.type === "tool_result" ? b.content : [b]))).filter(b => b.type === "image").map(b => (b as { data: string }).data);
    expect(images).toEqual(["img3", "img4", "img5", "img6"]);
    const omitted = JSON.stringify(last).split("[image omitted to save context]").length - 1;
    expect(omitted).toBe(2);
    // the text next to an omitted image stays
    expect(JSON.stringify(last)).toContain("shot 1");
  });
});

describe("B5: the post-turn claim check", () => {
  const CLAIM = "[Your reply says something was made, done or set up, but no tool in this turn did it. Do it now with the right tool, or correct your reply.]";
  const noted = (request: LlmRequest | undefined) => JSON.stringify(request?.messages.at(-1) ?? null).includes(CLAIM);

  test("zh: a claim with no tool gets one corrective round; its text is a follow-up bubble", async () => {
    const { input, recording } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[text("提醒已经设置好了，明天九点提醒你。")], [text("更正一下：我还没有设提醒。")]]);
    expect((await runtime(llm).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(noted(llm.requests[1])).toBe(true);
    expect(llm.requests[1]!.messages.at(-1)!.role).toBe("user");
    expect(posted(recording)).toEqual(["提醒已经设置好了，明天九点提醒你。", "更正一下：我还没有设提醒。"]);
  });
  test("en: \"I'll remind you\" / \"I've created\" are claims; the check runs at most once per turn", async () => {
    for (const claim of ["Sure, I'll remind you at 9.", "I've created the doc for you."]) {
      const { input, recording } = await turnFixture(database.db);
      // the corrective round claims again: not checked a second time, the turn just ends
      const llm = new RegisteredScriptedModel([[text(claim)], [text("Here's your summary, all done.")]]);
      expect((await runtime(llm).runTurn(input)).status).toBe("completed");
      expect(llm.requests).toHaveLength(2);
      expect(noted(llm.requests[1])).toBe(true);
      expect(posted(recording)).toHaveLength(2);
    }
  });
  test("an ordinary \"好的，已完成你说的修改\" after a successful tool is not flagged", async () => {
    const { input, recording } = await turnFixture(database.db);
    const tool = probe("update_doc");
    const llm = new RegisteredScriptedModel([[call("update_doc", { change: "标题" })], [text("好的，已完成你说的修改")]]);
    expect((await runtime(llm, [tool.provider]).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(posted(recording)).toEqual(["好的，已完成你说的修改"]);
  });
  test("a read-only tool or a tool that failed doesn't back a claim; replies without a claim aren't checked", async () => {
    const search = probe("search_app_tools");
    const failing = probe("send_email", () => new Error("boom"));
    for (const name of ["search_app_tools", "send_email"]) {
      const { input } = await turnFixture(database.db);
      const llm = new RegisteredScriptedModel([[call(name, { q: "x" })], [text("I've sent the email.")], [text("Correction: it wasn't sent.")]]);
      expect((await runtime(llm, [search.provider, failing.provider]).runTurn(input)).status).toBe("completed");
      expect(llm.requests).toHaveLength(3);
      expect(noted(llm.requests[2])).toBe(true);
    }
    const plain = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[text("我看了一下，周五下午有空。")]]);
    await runtime(llm).runTurn(plain.input);
    expect(llm.requests).toHaveLength(1);
  });
  test("ordinary answers are not claims (\"Here's the difference…\", \"Here's the weather\" after web_search, zh facts)", async () => {
    for (const answer of [
      "Here's the difference between TCP and UDP: TCP is connection-oriented.",
      "Here's the weather in Lisbon: sunny, 22°C.",
      "Here is your schedule for tomorrow, as I read it from the calendar: two meetings.",
      "两个版本都添加了夜间模式。",
      "该功能已经添加到 iOS 18 中。",
      "该项目已完成融资。",
      "这是你要的对比：A 更快，B 更便宜。",
    ]) expect(claimsDeliverable(answer)).toBe(false);
    for (const claim of [
      "Here's your summary, all done.", "Here's the doc I made for you.", "Here is the reminder I've set up.", "I've created the doc for you.", "Sure, I'll remind you at 9.",
      "提醒已经设置好了，明天九点提醒你。", "文档已经生成好了。", "邮件已经发送了。", "我已经发给他了。", "已帮你创建好日程", "都搞定了", "我会提醒你",
    ]) expect(claimsDeliverable(claim)).toBe(true);

    const { input, recording } = await turnFixture(database.db);
    const search = probe("web_search", () => [{ type: "text", text: "{\"results\":[{\"title\":\"Lisbon\",\"snippet\":\"Sunny, 22°C\"}]}" }]);
    const llm = new RegisteredScriptedModel([[call("web_search", { query: "weather lisbon" })], [text("Here's the weather in Lisbon: sunny, 22°C.")]]);
    expect((await runtime(llm, [search.provider]).runTurn(input)).status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(posted(recording)).toEqual(["Here's the weather in Lisbon: sunny, 22°C."]);
  });
  test("task turns are checked; background turns are not", async () => {
    const task = await turnFixture(database.db, true);
    const taskLlm = new RegisteredScriptedModel([[text("文档已经生成好了。")], [text("还没开始，我现在就做。")]]);
    await runtime(taskLlm).runTurn(task.input);
    expect(taskLlm.requests).toHaveLength(2);
    const brief = await turnFixture(database.db);
    const briefLlm = new RegisteredScriptedModel([[text("Here's your morning brief.")]]);
    expect((await runtime(briefLlm).runTurn({ ...brief.input, kind: "brief" })).status).toBe("completed");
    expect(briefLlm.requests).toHaveLength(1);
  });
});
