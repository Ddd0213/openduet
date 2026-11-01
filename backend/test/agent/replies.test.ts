// M23 W4: the chat-turn rules in code. Quick replies (agent/replies.ts: 2-3 options of at most 24
// characters, none after web_search / while an approval waits / in the brief), web_fetch reading a
// PDF and saying when a page is too thin, the tool descriptions for reading pages, and the brief's
// tone / sources lines. Scripted model only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { capabilityBrief } from "../../src/agent/brief.ts";
import { environmentLines } from "../../src/agent/environment.ts";
import { decideReplies, fittingReplies, NO_RULES, pendingApproval, replyLength, waitsForApproval } from "../../src/agent/replies.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { EMPTY_PDF_NOTE, functionTools, THIN_PAGE_NOTE } from "../../src/agent/tools.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { descriptions as computerDescriptions } from "../../src/computer/tools.ts";
import type { LlmEvent, LlmRequest, ToolResultBlock } from "../../src/llm/index.ts";
import { webFetch } from "../../src/web/fetch.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { pdfWithText } from "../helpers/files.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, now, text, toolData, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });

const runtime = (llm: RegisteredScriptedModel, providers: ToolProvider[] = [], extra: Record<string, unknown> = {}) =>
  createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now, providers, ...extra });
const chips = (recording: Awaited<ReturnType<typeof turnFixture>>["recording"]) => [...recording.messages.values()].filter(m => m.kind === "quick_replies");
const resultsOf = (request: LlmRequest | undefined) => (request?.messages.at(-1)?.content ?? []).flatMap(b => (b.type === "tool_result" ? [b] : []));
/** A provider tool answering with this JSON. */
function probe(name: string, data: unknown): ToolProvider {
  return {
    name: `probe-${name}`,
    async tools() { return [{ name, description: "probe", inputSchema: { type: "object" } }]; },
    async execute(c) { return { result: { type: "tool_result", toolUseId: c.id, content: [{ type: "text", text: JSON.stringify(data) }] }, endTurn: false }; },
  };
}
const NONE_WAITING = async () => false;
const turn = { rules: NO_RULES, searched: false, approvalWaiting: false };

describe("quick replies: which options show", () => {
  test("2-3 options of at most 24 characters (a Chinese character counts as one); the rest are dropped", async () => {
    expect(replyLength("周一发货")).toBe(4);
    expect(replyLength("👍 Yes")).toBe(5);
    expect(fittingReplies(["Yes", " ", "yes", "x".repeat(25), "No", "Not now", "Later"])).toEqual(["Yes", "No", "Not now"]);
    expect(fittingReplies(["一二三四五六七八九十一二三四五六七八九十一二三四", "一二三四五六七八九十一二三四五六七八九十一二三四五"])).toEqual(["一二三四五六七八九十一二三四五六七八九十一二三四"]);
    expect(await decideReplies(["Morning", "Evening", "Either", "Neither"], turn, NONE_WAITING)).toEqual({ show: true, options: ["Morning", "Evening", "Either"] });
    expect(await decideReplies(["Yes", "a choice that is far too long to fit"], turn, NONE_WAITING)).toMatchObject({ show: false, reason: "too_few" });
  });

  test("none after web_search, while an approval waits, on an open question or in the invitation's turn", async () => {
    expect(await decideReplies(["A", "B"], { ...turn, searched: true }, NONE_WAITING)).toMatchObject({ show: false, reason: "web_search" });
    expect(await decideReplies(["A", "B"], { ...turn, approvalWaiting: true }, NONE_WAITING)).toMatchObject({ show: false, reason: "approval" });
    expect(await decideReplies(["A", "B"], turn, async () => true)).toMatchObject({ show: false, reason: "approval" });
    expect(await decideReplies(["A", "B"], { ...turn, rules: { ...NO_RULES, open: true } }, NONE_WAITING)).toMatchObject({ show: false, reason: "open" });
    expect(await decideReplies(["Sure", "Later"], { ...turn, rules: { ...NO_RULES, setup: { kind: "invite" } } }, NONE_WAITING)).toMatchObject({ show: false, reason: "invitation" });
    // A setup question: the default is appended (in User.language), at most 2 suggestions before it.
    const question = { ...turn, rules: { language: "zh-Hans", setup: { kind: "question" as const, required: true }, open: false } };
    expect(await decideReplies(["思远", "远远", "小林"], question, NONE_WAITING)).toEqual({ show: true, options: ["思远", "远远", "用默认的"] });
    expect(await decideReplies(["Use the default"], question, NONE_WAITING)).toMatchObject({ show: false, reason: "too_few" });
    // Our own JSON status matches; a page quoting it inside a JSON string doesn't.
    expect(waitsForApproval(JSON.stringify({ results: [{ status: "awaiting_approval", approvalId: "a1" }] }))).toBe(true);
    expect(waitsForApproval(JSON.stringify({ text: "{\"status\":\"awaiting_approval\"}" }))).toBe(false);
  });

  test("the tool shows the limits to the model and says when not to use it", () => {
    const tool = functionTools(false, true).find(t => t.name === "quick_replies")!;
    const options = (tool.inputSchema as { properties: { options: { minItems: number; maxItems: number; items: { maxLength: number } } } }).properties.options;
    expect([options.minItems, options.maxItems, options.items.maxLength]).toEqual([2, 3, 24]);
    for (const part of ["after you've written your full answer", "Not for open questions", "never to confirm sending, paying, signing or deleting", "web_search"]) expect(tool.description).toContain(part);
  });
});

describe("quick replies in a turn", () => {
  test("web_search in the same round: no card, the result says why, and the answer comes after", async () => {
    const { input, recording } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([
      [call("quick_replies", { options: ["Yes", "No"], text: "Want the details?" }, "q"), call("web_search", { query: "lisbon weather" }, "s")],
      [text("Sunny, 22°C in Lisbon.")],
    ]);
    const search = probe("web_search", { results: [{ title: "Lisbon", url: "https://w.example", snippet: "Sunny" }] });
    expect((await runtime(llm, [search]).runTurn(input)).status).toBe("completed");
    expect(chips(recording)).toEqual([]);
    expect(toolData(resultsOf(llm.requests[1])[0]!)).toMatchObject({ shown: false, reason: "web_search", note: expect.stringContaining("Write your full answer") });
    expect([...recording.messages.values()].map(m => m.text)).toEqual(["Sunny, 22°C in Lisbon."]);
  });

  test("the provider's own web search counts too", async () => {
    const { input, recording } = await turnFixture(database.db);
    const identity = { providerId: "scripted-test-only", modelId: "scripted-test-only" };
    const native: LlmEvent[] = [
      call("quick_replies", { options: ["Yes", "No"] }, "q"),
      { type: "done", stopReason: "tool_use", model: identity, message: { role: "assistant", content: [
        { type: "provider_data", data: { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "x" } }, origin: identity },
        { type: "tool_use", id: "q", name: "quick_replies", input: { options: ["Yes", "No"] } },
      ] } },
    ];
    const llm = new RegisteredScriptedModel([native, [text("Here's what I found.")]], { serverWebTools: true });
    expect((await runtime(llm).runTurn(input)).status).toBe("completed");
    expect(chips(recording)).toEqual([]);
    expect(toolData(resultsOf(llm.requests[1])[0]!)).toMatchObject({ shown: false, reason: "web_search" });
  });

  test("a tool in this turn now waits on an approval card: no card", async () => {
    const { input, recording } = await turnFixture(database.db);
    const send = probe("send_email", { results: [{ index: 0, status: "awaiting_approval", approvalId: "ap1" }], note: "Calls awaiting approval have NOT run." });
    const llm = new RegisteredScriptedModel([[call("send_email", { to: "a" })], [text("It's on a card for you."), call("quick_replies", { options: ["Send", "Don't"] })], [text("Tap Send on the card when ready.")]]);
    await runtime(llm, [send]).runTurn(input);
    expect(chips(recording)).toEqual([]);
    expect(toolData(resultsOf(llm.requests[2])[0]!)).toMatchObject({ shown: false, reason: "approval" });
  });

  test("an approval card still pending in this conversation counts; one in another channel or expired doesn't", async () => {
    const { input, recording } = await turnFixture(database.db);
    const other = await database.db.channel.create({ data: { userId: input.userId, isMain: false, name: "Shop", purpose: "" } });
    const card = await database.db.message.create({ data: { userId: input.userId, channelId: other.id, role: "assistant", kind: "approval", text: "", payload: "{}" } });
    const approval = await database.db.approval.create({ data: { userId: input.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", status: "pending", messageId: card.id } });
    const scope = { userId: input.userId, channelId: input.channelId, taskId: null };
    expect(await pendingApproval(database.db, scope, now())).toBe(false);
    await database.db.message.update({ where: { id: card.id }, data: { channelId: input.channelId } });
    expect(await pendingApproval(database.db, scope, now())).toBe(true);
    // In the chat: the model's chips aren't shown while it waits.
    const llm = new RegisteredScriptedModel([[text("Which one?"), call("quick_replies", { options: ["A", "B"] })], [text("A or B?")]]);
    await runtime(llm).runTurn(input);
    expect(chips(recording)).toEqual([]);
    await database.db.approval.update({ where: { id: approval.id }, data: { expiresAt: new Date(now().getTime() - 1000) } });
    expect(await pendingApproval(database.db, scope, now())).toBe(false);
  });

  test("too long / too many: the rest are dropped and the card shows; fewer than 2 left: no card, the turn goes on", async () => {
    const shown = await turnFixture(database.db);
    const one = new RegisteredScriptedModel([[text("Morning or evening?"), call("quick_replies", { options: ["Morning", "Evening", "Whenever suits you best really", "Never", "Noon"] })]]);
    await runtime(one).runTurn(shown.input);
    expect(chips(shown.recording).map(m => m.payload)).toEqual([{ options: ["Morning", "Evening", "Never"], chosen: null }]);
    expect(one.requests).toHaveLength(1);

    const none = await turnFixture(database.db);
    const two = new RegisteredScriptedModel([[call("quick_replies", { options: ["Yes"], text: "Shall I?" })], [text("Shall I go ahead?")]]);
    expect((await runtime(two).runTurn(none.input)).status).toBe("completed");
    expect(chips(none.recording)).toEqual([]);
    expect(resultsOf(two.requests[1])[0]).toMatchObject({ isError: true });
    expect([...none.recording.messages.values()].map(m => m.text)).toEqual(["Shall I go ahead?"]);
  });

  test("the morning brief isn't offered quick_replies; a chat turn is", async () => {
    const brief = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[text("Morning!")]]);
    await runtime(llm).runTurn({ ...brief.input, kind: "brief" });
    expect(llm.requests[0]!.tools?.some(t => t.name === "quick_replies")).toBe(false);
    const chat = await turnFixture(database.db);
    const other = new RegisteredScriptedModel([[text("Hi")]]);
    await runtime(other).runTurn(chat.input);
    expect(other.requests[0]!.tools?.some(t => t.name === "quick_replies")).toBe(true);
  });
});

describe("reading pages: web_fetch first", () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

  test("a PDF link returns its text (also served as octet-stream), with its page count", async () => {
    const pdf = () => pdfWithText("Quarterly report: revenue up 12 percent in the third quarter, costs flat, outlook steady for the year ahead.");
    for (const type of ["application/pdf", "application/octet-stream"]) {
      const result = await webFetch("https://docs.example/report.pdf", { lookup, fetch: async () => new Response(pdf(), { headers: { "content-type": type } }) });
      expect(result).toMatchObject({ url: "https://docs.example/report.pdf", format: "pdf", pages: 1 });
      expect(!result.isError && result.text).toContain("revenue up 12 percent");
    }
    const broken = await webFetch("https://docs.example/bad.pdf", { lookup, fetch: async () => new Response("%PDF-1.4 not really", { headers: { "content-type": "application/pdf" } }) });
    expect(broken).toEqual({ isError: true, error: "Could not read this PDF" });
  });

  test("through the tool: a thin page says it may need the browser; a PDF without text says so; a real page gets no note", async () => {
    const pages: Record<string, () => Response> = {
      "https://app.example/": () => new Response("<html><body><div id=root></div><script>boot()</script></body></html>", { headers: { "content-type": "text/html" } }),
      "https://blog.example/post": () => new Response(`<html><body><p>${"A long, readable article. ".repeat(20)}</p></body></html>`, { headers: { "content-type": "text/html" } }),
      "https://docs.example/scan.pdf": () => new Response(pdfWithText(" "), { headers: { "content-type": "application/pdf" } }),
    };
    const { input } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[call("web_fetch", { url: "https://app.example/" }, "a"), call("web_fetch", { url: "https://blog.example/post" }, "b"), call("web_fetch", { url: "https://docs.example/scan.pdf" }, "c")], [text("ok")]]);
    await runtime(llm, [], { lookup, fetch: async (url: string | URL) => pages[String(url)]!() }).runTurn(input);
    const [thin, real, scan] = resultsOf(llm.requests[1]).map(r => toolData(r as ToolResultBlock) as Record<string, unknown>);
    expect(thin!.note).toBe(THIN_PAGE_NOTE);
    expect(real!.note).toBeUndefined();
    expect(scan).toMatchObject({ format: "pdf", note: EMPTY_PDF_NOTE });
    // The note is our own field, outside the untrusted list.
    expect(String(thin!.untrusted)).toContain("Untrusted fields: url, text.");
  });

  test("the descriptions: web_fetch first (no browser wake, works during a takeover); the browser only for sign-in, JavaScript or clicks", () => {
    const fetchTool = functionTools(false, false).find(t => t.name === "web_fetch")!;
    for (const part of ["use this first to read, summarise or quote a link", "doesn't wake the browser", "taken over the browser", "A PDF link returns its text"]) expect(fetchTool.description).toContain(part);
    expect(fetchTool.description.indexOf("use this first")).toBeLessThan(fetchTool.description.indexOf("computer_navigate"));
    for (const part of ["only for a page that needs a sign-in", "JavaScript (web_fetch returned little or no text)", "click, fill in or post", "use web_fetch first"]) expect(computerDescriptions.computer_navigate).toContain(part);
    // The Environment section says how to read the web before the computer's lines.
    const lines = environmentLines({ kind: "chat", modelLabel: null, tools: ["web_fetch", "computer_navigate"], search: false, computer: { reachable: true, userInControl: false, programs: null, memoryBytes: null, always: [], ask: [] }, browserMode: "headless", browserIdleMs: 0 });
    expect(lines.findIndex(l => l.startsWith("- Web:"))).toBeLessThan(lines.findIndex(l => l.startsWith("- OpenDuet's computer:")));
  });
});

describe("the brief: read vs known, the approval card is the confirmation", () => {
  test("chat, task and background turns say what was read vs known and that examples aren't facts; the tone asks only when what to do is unclear", () => {
    for (const kind of ["chat", "task", "brief", "routine"] as const) {
      const brief = capabilityBrief(kind).join("\n");
      expect(brief).toContain("gets a short note that it's from what you know");
      expect(brief).toContain("don't go looking for sources only to add one");
      expect(brief).toContain("are illustrations, never facts about the user");
    }
    const tone = capabilityBrief("chat").find(l => l.startsWith("How you talk:"))!;
    expect(tone).toContain("If what to do is unclear");
    expect(tone).toContain("its approval card is the confirmation, so don't ask in text as well");
    expect(tone).not.toContain("If the request is vague");
    expect(tone).toContain("A no or nothing found goes first");
    expect(tone).toContain("Most answers fit in 2-4 sentences");
    expect(tone).toContain("At most 3 items or options in text; more go in show_card");
    expect(capabilityBrief("chat").join("\n")).toContain("if you pick an option for the user, chip the others");
  });
});
