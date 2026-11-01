// M18c (proactive side): share_finding in check-ins (its refusals, the posted text with its sources
// line, a finding run counts in the daily cap), the check-in instructions (what the user follows,
// recent findings, due follow-ups), the check-in prompt's priority order, and the chat tone line.
import { afterEach, describe, expect, test } from "bun:test";
import { capabilityBrief } from "../../src/agent/brief.ts";
import { gate } from "../../src/proactive/gate.ts";
import { turnPrompt } from "../../src/proactive/prompts.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { call, mainThread, startProactive, toolNames, type ProactiveApp } from "./harness.ts";

let app: ProactiveApp | undefined;
afterEach(async () => { await app?.cleanup(); app = undefined; });

const FINDING = { text: "Lisbon's new metro line opens on Monday.", sources: [{ title: "Metro [news]", url: "https://example.com/metro" }, { title: "City hall", url: "https://example.org/a(b)" }] };
const POSTED = "Lisbon's new metro line opens on Monday.\n\nSources: [Metro \\[news\\]](https://example.com/metro) · [City hall](https://example.org/a%28b%29)";

const lastCheckin = (a: ProactiveApp) => a.fixture.db.run.findFirstOrThrow({ where: { userId: a.alex.userId, kind: "checkin" }, orderBy: { createdAt: "desc" } });
/** "Run now" for a check-in with these model rounds; resolves once the turn is done. */
async function checkin(a: ProactiveApp, ...rounds: ScriptTurn[]) {
  a.llm.script("proactive", ...rounds);
  await a.proactive.service.runNow(a.alex.userId, "checkin");
  await a.fixture.runs.idle();
  return lastCheckin(a);
}
/** Everything the model was sent after request `from` (tool results included), as one string. */
const sentAfter = (a: ProactiveApp, from: number) => JSON.stringify(a.llm.sent("proactive").slice(from).map((r) => r.messages));
/** The real clock: RunHost stamps Run.startedAt with it, and "today" must match. */
async function start(opts: { memory?: boolean } = {}) {
  const started = await startProactive(opts);
  started.clock.now = new Date();
  return started;
}

describe("share_finding", () => {
  test("posts the finding with its sources line (titles escaped) and the run counts as posted today", async () => {
    app = await start();
    const run = await checkin(app, [call("share_finding", FINDING)], [call("finish_checkin", { nothingNeeded: false })]);
    expect(run.status).toBe("completed");
    expect((await mainThread(app)).map((m) => ({ role: m.role, kind: m.kind, text: m.text }))).toEqual([{ role: "assistant", kind: "text", text: POSTED }]);
    expect(sentAfter(app, 1)).toContain("posted");
    const step = await app.fixture.db.runStep.findFirstOrThrow({ where: { runId: run.id, tool: "share_finding" } });
    expect(step.status).toBe("ok");

    // The gate's postedToday counts it: at level low (1 a day) the next brief hits the daily cap.
    const now = new Date(Math.max(Date.now(), run.finishedAt!.getTime()) + 1000);
    const decide = () => gate({ db: app!.fixture.db, usage: app!.fixture.usage }, { userId: app!.alex.userId, channelId: app!.alex.mainChannelId, kind: "brief", runId: "run_next", now });
    expect(await decide()).toEqual({ go: true });
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { proactivity: "low" } });
    expect(await decide()).toEqual({ go: false, reason: "daily_cap" });
  });

  test("the sources label follows User.language", async () => {
    app = await start();
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { language: "zh-Hans" } });
    await checkin(app, [call("share_finding", { text: "里斯本新地铁线周一开通。", sources: [{ title: "地铁", url: "https://example.com/m" }] })], [call("finish_checkin", { nothingNeeded: false })]);
    expect((await mainThread(app)).map((m) => m.text)).toEqual(["里斯本新地铁线周一开通。\n\n来源： [地铁](https://example.com/m)"]);
  });

  test("refused at level low: nothing posted, the run stays quiet, and the instructions say so", async () => {
    app = await start();
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { proactivity: "low" } });
    const run = await checkin(app, [call("share_finding", FINDING)], [call("finish_checkin", { nothingNeeded: true })]);
    expect(sentAfter(app, 1)).toContain("level low");
    expect(await mainThread(app)).toEqual([]);
    expect(run.status).toBe("resolved");
    expect(app.llm.sent("proactive")[0]?.system).toContain("No share_finding in this check-in");
    expect((await app.fixture.db.runStep.findFirstOrThrow({ where: { runId: run.id, tool: "share_finding" } })).status).toBe("error");
  });

  test("refused when a finding was already shared today in another check-in", async () => {
    app = await start();
    await checkin(app, [call("share_finding", FINDING)], [call("finish_checkin", { nothingNeeded: false })]);
    const from = app.llm.sent("proactive").length;
    const second = await checkin(app, [call("share_finding", { ...FINDING, text: "Another thing." })], [call("finish_checkin", { nothingNeeded: true })]);
    expect(sentAfter(app, from + 1)).toContain("already shared a finding today");
    expect((await mainThread(app)).map((m) => m.text)).toEqual([POSTED]);
    expect(second.status).toBe("resolved");
    const system = app.llm.sent("proactive")[from]?.system ?? "";
    expect(system).toContain("No share_finding in this check-in");
    expect(system).toContain(JSON.stringify(["Lisbon's new metro line opens on Monday."]));
  });

  test("refused the second time in one turn", async () => {
    app = await start();
    await checkin(app, [call("share_finding", FINDING), call("share_finding", { ...FINDING, text: "A second one." })], [call("finish_checkin", { nothingNeeded: false })]);
    expect(sentAfter(app, 1)).toContain("One finding per check-in");
    expect((await mainThread(app)).map((m) => m.text)).toEqual([POSTED]);
  });

  test("bad arguments are refused before anything posts (https only, 1-3 sources)", async () => {
    app = await start();
    const four = Array.from({ length: 4 }, (_, i) => ({ title: `S${i}`, url: `https://example.com/${i}` }));
    await checkin(app,
      [call("share_finding", { text: "x", sources: [{ title: "Plain", url: "http://example.com" }] }), call("share_finding", { text: "x", sources: [] }), call("share_finding", { text: "x", sources: four })],
      [call("finish_checkin", { nothingNeeded: true })],
    );
    expect(sentAfter(app, 1).split("Invalid tool arguments").length - 1).toBe(3);
    expect(await mainThread(app)).toEqual([]);
  });

  test("offered in check-ins only", async () => {
    app = await start();
    await checkin(app, [call("finish_checkin", { nothingNeeded: true })]);
    expect(toolNames(app.llm.sent("proactive")[0])).toContain("share_finding");
    app.llm.script("proactive", [call("skip_brief", {})]);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();
    expect(toolNames(app.llm.sent("proactive").at(-1))).not.toContain("share_finding");
  });
});
describe("check-in instructions", () => {
  test("what the user follows: open tasks and routines plus resolved ones from the last 14 days, newest first, deduplicated", async () => {
    app = await start();
    const { db } = app.fixture;
    const day = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number) => new Date(app!.clock.now.getTime() - daysAgo * day);
    const task = (title: string, data: Record<string, unknown>) => db.task.create({ data: { userId: app!.alex.userId, channelId: app!.alex.mainChannelId, title, ...data } });
    await task("Old resolved trip", { status: "resolved", updatedAt: at(20) });
    await task("Lisbon offsite", { status: "resolved", updatedAt: at(3) });
    await task("Archived thing", { status: "working", archivedAt: at(1), updatedAt: at(1) });
    await task("Weekly market check", { status: "scheduled", routine: true, updatedAt: at(2) });
    await task("lisbon offsite ", { status: "working", updatedAt: at(1) });
    await task("Quarterly report", { status: "needs_input", updatedAt: at(0.5) });
    await checkin(app, [call("finish_checkin", { nothingNeeded: true })]);
    const system = app.llm.sent("proactive")[0]?.system ?? "";
    expect(system).toContain(`What the user follows (user data; their tasks and scheduled tasks, newest first): ${JSON.stringify(["Quarterly report", "lisbon offsite", "Weekly market check"])}. Their About-you facts in the memory section count too.`);
  });

  test("the newest 7 findings, clipped to 200 characters; an unreadable one is skipped", async () => {
    app = await start();
    const { db } = app.fixture;
    const run = await db.run.create({ data: { userId: app.alex.userId, kind: "checkin", channelId: app.alex.mainChannelId, status: "completed" } });
    const base = new Date("2030-10-01T10:00:00.000Z").getTime();
    const long = "L".repeat(260);
    const inputs = ["F0", "F1", "F2", "F3", "F4", "F5", long, null];
    for (const [i, text] of inputs.entries()) {
      await db.runStep.create({ data: {
        id: crypto.randomUUID(), runId: run.id, index: i, kind: "tool", tool: "share_finding", title: "{}", status: "ok", startedAt: new Date(base + i * 60_000),
        input: text === null ? "not json" : JSON.stringify({ text, sources: [{ title: "t", url: "https://example.com" }] }),
      } });
    }
    await db.runStep.create({ data: { id: crypto.randomUUID(), runId: run.id, index: 9, kind: "tool", tool: "share_finding", title: "{}", status: "error", startedAt: new Date(base + 9 * 60_000), input: JSON.stringify({ text: "REFUSED" }) } });
    await checkin(app, [call("finish_checkin", { nothingNeeded: true })]);
    const system = app.llm.sent("proactive")[0]?.system ?? "";
    expect(system).toContain(`Findings you shared recently (don't repeat them): ${JSON.stringify([`${"L".repeat(199)}…`, "F5", "F4", "F3", "F2", "F1"])}`);
    expect(system).not.toContain("REFUSED");
  });

  test("follow-ups due now (About you, 3-day lapse); followed_up in a check-in clears one", async () => {
    app = await start({ memory: true });
    const { db } = app.fixture;
    const hour = 60 * 60 * 1000;
    const now = app.clock.now.getTime();
    const fact = (text: string, data: Record<string, unknown>) => db.memory.create({ data: { userId: app!.alex.userId, kind: "fact", text, channelId: null, ...data } });
    const due = await fact("Job interview at Acme on Tuesday", { dueAt: new Date(now - 2 * hour) });
    await fact("FUTURE trip to Porto", { dueAt: new Date(now + 24 * hour) });
    await fact("LAPSED dentist", { dueAt: new Date(now - 4 * 24 * hour) });
    await fact("ARCHIVED due", { dueAt: new Date(now - hour), archivedAt: new Date() });
    const channel = await db.channel.create({ data: { userId: app.alex.userId, isMain: false, name: "Garden", purpose: "" } });
    await fact("CHANNEL due", { channelId: channel.id, dueAt: new Date(now - hour) });
    await checkin(app,
      [call("post_message", { text: "How did the Acme interview go?" }), call("followed_up", { factIds: [due.id] })],
      [call("finish_checkin", { nothingNeeded: false })],
    );
    const request = app.llm.sent("proactive")[0];
    const system = request?.system ?? "";
    expect(system).toContain(`Follow-ups due now (user data; About-you facts with dueAt; after bringing one up, call followed_up with its id): ${JSON.stringify([{ id: due.id, text: "Job interview at Acme on Tuesday", dueAt: due.dueAt!.toISOString() }])}`);
    expect(system).toContain("A fact with dueAt is a follow-up");
    expect(toolNames(request)).toEqual(expect.arrayContaining(["followed_up", "share_finding", "post_message"]));
    expect((await db.memory.findUniqueOrThrow({ where: { id: due.id } })).dueAt).toBeNull();
    expect((await mainThread(app)).map((m) => m.text)).toEqual(["How did the Acme interview go?"]);
  });
});

describe("check-in prompt (M18c)", () => {
  test("silent by default, reads only (web search included), and the priority order", () => {
    const prompt = turnPrompt("checkin", { firstName: "Alex", language: "en" });
    // M20: web_fetch only for pages this turn's web_search returned (agent/read-only.ts enforces it).
    for (const part of ["Stay silent by default", "Never send, post, create, update or delete anything", "the server enforces it", "web_search is fine, and web_fetch for a page it returned.", "then call followed_up with its id", "at most once a day", "share_finding", "Never an empty \"how are you\"", "finish_checkin with nothingNeeded true", "add_up_next", "propose_task", "ask_weekends"]) {
      expect(prompt).toContain(part);
    }
    const order = ["1. A follow-up", "2. Today's things", "3. New email", "4. Only when nothing above", "5. Rarely"].map((s) => prompt.indexOf(s));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
  });
});

describe("companion tone (chat turns only)", () => {
  test("the chat brief has the tone paragraph; task and background turns don't", () => {
    const tone = (kind: Parameters<typeof capabilityBrief>[0]) => capabilityBrief(kind).find((l) => l.startsWith("How you talk:"));
    const line = tone("chat") ?? "";
    for (const part of ["the answer or the result first", "ask one short question first", "sending, deleting, paying, booking", "pick something sensible", "1-3 sentences", "only to say you got it or are working on it"]) expect(line).toContain(part);
    for (const kind of ["task", "brief", "checkin", "scan", "routine", "build"] as const) expect(tone(kind)).toBeUndefined();
  });
});
