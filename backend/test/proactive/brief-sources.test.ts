// M23 W2 (#27, BriefInfo): the brief and check-ins through the real run host on a role-scripted
// model. The server reads Gmail (and, for the brief, today's calendar) before the model, triage sorts
// the mail (rules, then one "utility" call per email), the instructions carry the sorted mail; the
// brief's message gets TextPayload.brief and the fixed "I couldn't check ..." line for every source it
// couldn't read; skip_brief is refused when a read failed; add_up_next goes through
// suggestions/create.ts with the source the server read.
import { afterEach, describe, expect, test } from "bun:test";
import { phrase } from "../../src/agent/phrase.ts";
import { LlmError } from "../../src/llm/index.ts";
import { call, mainThread, startProactive, text, type ProactiveApp } from "./harness.ts";

let app: ProactiveApp | undefined;
afterEach(async () => { await app?.cleanup(); app = undefined; });

const HOUR = 60 * 60 * 1000;
const promo = { messageId: "promo-1", threadId: "t-promo", sender: "Shop <deals@shop.test>", to: "alex@acme.test", subject: "50% off today only", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:u@shop.test>" }] }, messageText: "Sale!" };
const dana = { messageId: "dana-1", threadId: "t-dana", sender: "Dana Ito <dana@acme.test>", to: "Alex <alex@acme.test>", subject: "Offsite dates", messageTimestamp: "2030-10-23T08:00:00Z", labelIds: ["INBOX"], messageText: "Hi Alex, can you confirm the offsite dates by Friday?" };
const receipt = { messageId: "rcpt-1", sender: "Shop <orders@shop.test>", to: "alex@acme.test", subject: "Your order has shipped", labelIds: ["INBOX"], messageText: "Track it here." };
const inbox = (...messages: object[]) => ({ ok: true as const, data: { messages, resultSizeEstimate: messages.length } });
const verdict = (v: string, reason: string) => [text(JSON.stringify({ verdict: v, reason }))];
const brief = (a: ProactiveApp) => a.fixture.db.message.findMany({ where: { userId: a.alex.userId, role: "assistant", kind: "text" }, orderBy: { createdAt: "asc" } });
const payloadOf = (row: { payload: string }) => JSON.parse(row.payload) as Record<string, unknown>;
const runOf = (a: ProactiveApp, kind: string) => a.fixture.db.run.findFirstOrThrow({ where: { userId: a.alex.userId, kind }, orderBy: { createdAt: "desc" } });
const execs = (a: ProactiveApp, slug: string) => a.fake!.executions.filter((e) => e.slug === slug);

describe("the morning brief reads first", () => {
  test("Gmail and today's calendar read by the server; rules, then one model call per email; sorted mail in the instructions; brief = {unchecked: []}", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test");
    app.fake!.connect(app.alex.userId, "googlecalendar", "acc_cal", "alex@acme.test");
    app.fake!.results.set("GMAIL_FETCH_EMAILS", inbox(promo, dana));
    app.fake!.results.set("GOOGLECALENDAR_EVENTS_LIST", { ok: true, data: { items: [{ id: "ev-1", summary: "Launch review", start: { dateTime: "2030-10-23T15:00:00Z" }, end: { dateTime: "2030-10-23T16:00:00Z" } }] } });
    app.llm.script("utility", verdict("needs_you", "Dana needs the offsite dates confirmed by Friday."));
    app.llm.script("proactive", [text("Morning, Alex! For today: Confirm the offsite. Prep the launch review. Clear the inbox.\n\nUpdates:\n1. **Offsite** Dana needs the dates by Friday.")]);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();

    const [mail] = execs(app, "GMAIL_FETCH_EMAILS");
    expect(mail?.args).toEqual({ query: `in:inbox after:${Math.floor((app.clock.now.getTime() - 24 * HOUR) / 1000)}`, max_results: 50, include_payload: true });
    const [cal] = execs(app, "GOOGLECALENDAR_EVENTS_LIST");
    expect(cal?.args).toMatchObject({ calendarId: "primary", singleEvents: true });
    expect(Date.parse(String(cal!.args.timeMax)) - Date.parse(String(cal!.args.timeMin))).toBe(24 * HOUR);
    // The promotion is settled by a rule; Dana's email is the one model call, and it reads as data.
    const triage = app.llm.sent("utility");
    expect(triage).toHaveLength(1);
    expect(JSON.stringify(triage[0]?.messages)).toContain("Offsite dates");
    expect(JSON.stringify(triage[0]?.messages)).toContain("untrusted_data");
    const system = app.llm.sent("proactive")[0]?.system ?? "";
    expect(system).toContain("Mail triage, computed by the server");
    expect(system).toContain("Dana needs the offsite dates confirmed by Friday.");
    expect(system).toContain("\"canWait\":{\"count\":1");
    expect(system).toContain("Launch review");
    expect(JSON.stringify(app.llm.sent("proactive")[0]?.messages[0])).toContain("The server already read the user's email and sorted it");

    const [row] = await brief(app);
    expect(row?.text).not.toContain("I couldn't check");
    expect(payloadOf(row!).brief).toEqual({ unchecked: [] });
    expect(app.pushes.map((p) => p.body)).toEqual([{ text: "Morning, Alex! For today: Confirm the offsite. Prep the launch review. Clear the inbox." }]);
  });

  test("an expired Gmail and a calendar read that failed: both named at the end of the brief and in TextPayload.brief; the model is told", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test", "EXPIRED");
    app.fake!.connect(app.alex.userId, "googlecalendar", "acc_cal", "alex@acme.test");
    app.fake!.results.set("GOOGLECALENDAR_EVENTS_LIST", { ok: false, kind: "provider", error: "upstream 500" });
    app.llm.script("proactive", [text("Morning, Alex! For today: Prep the launch review.")]);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();

    expect(execs(app, "GMAIL_FETCH_EMAILS")).toEqual([]);
    const system = app.llm.sent("proactive")[0]?.system ?? "";
    expect(system).toContain("Gmail wasn't read for this brief (its connection expired). Never say there's no new mail.");
    expect(system).toContain("Google Calendar wasn't read for this brief (the read failed). Never say the calendar is empty.");
    const line = [phrase("brief.unchecked_expired", "en").replace("{app}", "Gmail"), phrase("brief.unchecked_failed", "en").replace("{app}", "Google Calendar")].join(" ");
    const [row] = await brief(app);
    expect(row?.text).toBe(`Morning, Alex! For today: Prep the launch review.\n\n${line}`);
    expect(payloadOf(row!).brief).toEqual({ unchecked: ["Gmail", "Google Calendar"] });
    expect(app.pushes.map((p) => p.body)).toEqual([{ text: "Morning, Alex! For today: Prep the launch review." }]);
  });

  test("nothing connected (zh-Hans): the brief says so in Chinese, never \"nothing new\"", async () => {
    app = await startProactive();
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { language: "zh-Hans" } });
    app.llm.script("proactive", [text("早上好，Alex！今天：准备发布评审。")]);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();
    const [row] = await brief(app);
    expect(row?.text).toBe("早上好，Alex！今天：准备发布评审。\n\n我没能查看 Gmail：还没有连接。我没能查看 Google Calendar：还没有连接。");
    expect(payloadOf(row!).brief).toEqual({ unchecked: ["Gmail", "Google Calendar"] });
    expect(app.fake!.executions).toEqual([]);
  });

  test("skip_brief is refused after a failed read; when the model still posts nothing, the server posts the line itself", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test");
    app.fake!.results.set("GMAIL_FETCH_EMAILS", { ok: false, kind: "unavailable", error: "timeout" });
    app.llm.script("proactive", [call("skip_brief", {})], []);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();

    expect(JSON.stringify(app.llm.sent("proactive")[1]?.messages)).toContain("Don't skip the brief: a source couldn't be read");
    const line = [phrase("brief.unchecked_failed", "en").replace("{app}", "Gmail"), phrase("brief.unchecked_not_connected", "en").replace("{app}", "Google Calendar")].join(" ");
    const rows = await brief(app);
    expect(rows.map((r) => r.text)).toEqual([line]);
    expect(payloadOf(rows[0]!).brief).toEqual({ unchecked: ["Gmail", "Google Calendar"] });
    expect((await runOf(app, "brief")).status).toBe("completed");
    expect(app.pushes.map((p) => p.body)).toEqual([{ text: line }]);
  });
});
describe("check-ins read new mail first", () => {
  test("only mail since the last check-in, at most 25; a failed model call leaves the email unsorted under needsYou", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test");
    const last = new Date(app.clock.now.getTime() - 3 * HOUR);
    await app.fixture.db.run.create({ data: { userId: app.alex.userId, channelId: app.alex.mainChannelId, kind: "checkin", status: "resolved", startedAt: last, finishedAt: last } });
    app.fake!.results.set("GMAIL_FETCH_EMAILS", inbox(receipt, dana));
    app.llm.script("utility", new LlmError({ kind: "http", status: 500, providerId: "p", modelId: "m", attempts: 1 }));
    app.llm.script("proactive", [call("finish_checkin", { nothingNeeded: true })]);
    await app.proactive.service.runNow(app.alex.userId, "checkin");
    await app.fixture.runs.idle();

    expect(execs(app, "GMAIL_FETCH_EMAILS")[0]?.args).toEqual({ query: `in:inbox after:${Math.floor(last.getTime() / 1000)}`, max_results: 25, include_payload: true });
    expect(execs(app, "GOOGLECALENDAR_EVENTS_LIST")).toEqual([]);
    expect(app.llm.sent("utility")).toHaveLength(1); // the receipt is a rule's
    const system = app.llm.sent("proactive")[0]?.system ?? "";
    expect(system).toContain("\"decidedBy\":\"unsorted\"");
    expect(system).toContain("Could not be sorted (the model call failed)");
    expect(system).toContain("\"canWait\":{\"count\":1");
    expect(system).toContain("never post about canWait mail");
    expect((await runOf(app, "checkin")).status).toBe("resolved");
    expect(await mainThread(app)).toEqual([]);
  });

  test("a mail read that failed: the check-in is told never to say there's no new mail; no brief payload in a check-in", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test");
    app.fake!.results.set("GMAIL_FETCH_EMAILS", { ok: false, kind: "provider", error: "500" });
    app.llm.script("proactive", [call("post_message", { text: "Your 3 PM moved to 4." })], [call("finish_checkin", { nothingNeeded: false })]);
    await app.proactive.service.runNow(app.alex.userId, "checkin");
    await app.fixture.runs.idle();
    expect(app.llm.sent("proactive")[0]?.system).toContain("Gmail wasn't read for this check-in (the read failed). Never say there's no new mail.");
    const rows = await brief(app);
    expect(rows.map((r) => r.text)).toEqual(["Your 3 PM moved to 4."]);
    expect(payloadOf(rows[0]!).brief).toBeUndefined();
  });

  test("the brief's verdicts carry over (no second model call); add_up_next takes the source the server read, and refuses one nobody read", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test");
    app.fake!.results.set("GMAIL_FETCH_EMAILS", inbox(dana));
    app.llm.script("utility", verdict("needs_you", "Dana needs the offsite dates confirmed by Friday."));
    app.llm.script("proactive", [text("Morning, Alex! For today: Confirm the offsite.")]);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();

    app.clock.now = new Date(app.clock.now.getTime() + 2 * HOUR);
    app.llm.script("proactive",
      [call("add_up_next", { title: "Confirm the offsite dates", body: "Dana asked by Friday.", prompt: "Draft a reply to Dana confirming the dates", app: "gmail", source: { kind: "email", id: "dana-1", title: "made up" } })],
      [call("add_up_next", { title: "Reply to Priya", body: "x", prompt: "y", app: "Gmail", source: { kind: "email", id: "never-read-1", title: "Invoice" } })],
      [call("finish_checkin", { nothingNeeded: false })],
    );
    await app.proactive.service.runNow(app.alex.userId, "checkin");
    await app.fixture.runs.idle();

    expect(app.llm.sent("utility")).toHaveLength(1);
    const rows = await app.fixture.db.suggestion.findMany({ where: { userId: app.alex.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Confirm the offsite dates", app: "Gmail", origin: "checkin" });
    expect(JSON.parse(rows[0]!.sourceRef!)).toEqual({ app: "Gmail", kind: "email", id: "dana-1", title: "Offsite dates", at: "2030-10-23T08:00:00.000Z" });
    expect(JSON.stringify(app.llm.sent("proactive").at(-1)?.messages)).toContain("wasn't read in this turn");
    expect((await runOf(app, "checkin")).status).toBe("completed");
  });
});
