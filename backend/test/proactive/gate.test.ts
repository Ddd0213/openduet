// M14b proactivity gate: the level, quiet hours (Claude-initiated messages only), the daily cap and
// "don't interrupt", all decided in code before any model call. The user's own reminders, "Run now"
// and routines are never gated: a 23:30 "go to sleep" reminder inside quiet hours still goes out.
import { afterEach, describe, expect, test } from "bun:test";
import { decide, inQuietHours, QUIET_DEFAULT, type GateFacts } from "../../src/proactive/gate.ts";
import { ReminderService } from "../../src/notify/reminders.ts";
import type { NotifyInput, NotifyResult, NotifySink } from "../../src/notify/notifier.ts";
import { offeredNames } from "../helpers/offered.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, startProactive, text, toolNames, type ProactiveApp } from "./harness.ts";

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  kind: "checkin", proactivity: "normal", localMinute: 14 * 60, quietStart: QUIET_DEFAULT.start, quietEnd: QUIET_DEFAULT.end,
  postedToday: 0, sinceUserMs: 3 * 60 * 60 * 1000, runActive: false, unanswered: false, usageShare: 0.1, ...over,
});

describe("decide", () => {
  test("quiet hours wrap past midnight; equal start and end means none", () => {
    expect(inQuietHours(23 * 60 + 30, 1350, 510)).toBe(true);
    expect(inQuietHours(3 * 60, 1350, 510)).toBe(true);
    expect(inQuietHours(8 * 60 + 30, 1350, 510)).toBe(false);
    expect(inQuietHours(12 * 60, 1350, 510)).toBe(false);
    expect(inQuietHours(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(inQuietHours(13 * 60, 600, 600)).toBe(false);
  });

  test("each rule, for check-ins", () => {
    expect(decide(facts())).toEqual({ go: true });
    expect(decide(facts({ proactivity: "off" }))).toEqual({ go: false, reason: "off" });
    expect(decide(facts({ localMinute: 23 * 60 + 30 }))).toEqual({ go: false, reason: "quiet_hours" });
    expect(decide(facts({ postedToday: 3 }))).toEqual({ go: false, reason: "daily_cap" });
    expect(decide(facts({ proactivity: "low", postedToday: 1 }))).toEqual({ go: false, reason: "daily_cap" });
    expect(decide(facts({ proactivity: "high", postedToday: 4 }))).toEqual({ go: true });
    expect(decide(facts({ sinceUserMs: 10 * 60 * 1000 }))).toEqual({ go: false, reason: "user_active" });
    expect(decide(facts({ sinceUserMs: null }))).toEqual({ go: true });
    expect(decide(facts({ runActive: true }))).toEqual({ go: false, reason: "run_active" });
    expect(decide(facts({ unanswered: true }))).toEqual({ go: false, reason: "unanswered" });
    expect(decide(facts({ usageShare: 0.8 }))).toEqual({ go: false, reason: "usage" });
  });

  test("the brief keeps the time the user set and doesn't wait for an answer; off, the cap and usage still apply", () => {
    const brief = (over: Partial<GateFacts>) => decide(facts({ kind: "brief", ...over }));
    expect(brief({ localMinute: 8 * 60 + 19 })).toEqual({ go: true });
    expect(brief({ unanswered: true, sinceUserMs: 60_000, runActive: true })).toEqual({ go: true });
    expect(brief({ proactivity: "off" })).toEqual({ go: false, reason: "off" });
    expect(brief({ postedToday: 3 })).toEqual({ go: false, reason: "daily_cap" });
    expect(brief({ usageShare: 0.9 })).toEqual({ go: false, reason: "usage" });
  });
});

class Sink implements NotifySink {
  readonly calls: NotifyInput[] = [];
  async notify(input: NotifyInput): Promise<NotifyResult> {
    this.calls.push(input);
    return "local_only";
  }
}

let app: ProactiveApp | undefined;
afterEach(async () => { await app?.cleanup(); app = undefined; });

/** 2030-10-23 23:30 in Shanghai (UTC+8). */
const lateNight = new Date("2030-10-23T15:30:00.000Z");
const runOf = (a: ProactiveApp, kind: string) => a.fixture.db.run.findFirstOrThrow({ where: { userId: a.alex.userId, kind }, orderBy: { createdAt: "desc" } });

describe("the gate on scheduled turns", () => {
  test("23:30 local: the scheduled check-in is skipped with no model call, but the user's own 23:30 reminder is delivered and Run now still runs", async () => {
    app = await startProactive();
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { timezone: "Asia/Shanghai" } });
    app.clock.now = lateNight;
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "checkin", scheduledFor: lateNight });
    await app.fixture.runs.idle();
    expect((await runOf(app, "checkin")).status).toBe("skipped");
    expect(app.llm.sent("proactive")).toEqual([]);

    // "Every day at 23:30 remind me to go to sleep": quiet hours don't apply to what the user asked for.
    await app.fixture.db.reminder.create({ data: { userId: app.alex.userId, channelId: app.alex.mainChannelId, at: new Date(lateNight.getTime() - 1000), text: "Time to go to sleep." } });
    const sink = new Sink();
    const reminders = new ReminderService({ db: app.fixture.db, events: app.fixture.events, notifier: sink, now: () => lateNight });
    expect(await reminders.tick()).toBe(1);
    expect(sink.calls.map((c) => c.body)).toEqual([{ text: "Time to go to sleep." }]);
    expect(await app.fixture.db.message.count({ where: { userId: app.alex.userId, role: "assistant", text: "Time to go to sleep." } })).toBe(1);

    // Run now is the user asking: not gated either.
    app.llm.script("proactive", [text("Nothing new."), call("finish_checkin", { nothingNeeded: true })]);
    expect((await app.fixture.app.request("/api/schedule/run", json(app.alex, "POST", { kind: "checkin" }))).status).toBe(200);
    await app.fixture.runs.idle();
    expect(app.llm.sent("proactive")).toHaveLength(1);
  });

  test("proactivity off skips the scheduled brief; an unanswered check-in holds the next one back until the user replies", async () => {
    app = await startProactive();
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { proactivity: "off" } });
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "brief", scheduledFor: new Date("2030-10-23T08:19:00.000Z") });
    await app.fixture.runs.idle();
    expect((await runOf(app, "brief")).status).toBe("skipped");
    expect(app.llm.sent("proactive")).toEqual([]);

    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { proactivity: "normal" } });
    const posted = new Date(app.clock.now.getTime() - 2 * 60 * 60 * 1000);
    await app.fixture.db.run.create({ data: { userId: app.alex.userId, kind: "checkin", channelId: app.alex.mainChannelId, status: "completed", startedAt: posted, finishedAt: posted } });
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "checkin", scheduledFor: new Date("2030-10-23T10:49:00.000Z") });
    await app.fixture.runs.idle();
    expect((await runOf(app, "checkin")).status).toBe("skipped");
    expect(app.llm.sent("proactive")).toEqual([]);

    // The user answered (an hour ago): the next check-in runs.
    await app.fixture.db.message.create({ data: { userId: app.alex.userId, channelId: app.alex.mainChannelId, role: "user", text: "thanks", createdAt: new Date(app.clock.now.getTime() - 60 * 60 * 1000) } });
    app.llm.script("proactive", [text("All quiet."), call("finish_checkin", { nothingNeeded: true })]);
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "checkin", scheduledFor: new Date("2030-10-23T13:49:00.000Z") });
    await app.fixture.runs.idle();
    expect(app.llm.sent("proactive")).toHaveLength(1);
  });
});

describe("set_proactivity (no settings page: the user asks in chat)", () => {
  test("chat offers it with the current level in the instructions; it saves the level and quiet hours", async () => {
    app = await startProactive();
    app.llm.script("chat", [call("set_proactivity", { level: "low", quietStart: "21:00", quietEnd: "09:00" })], [text("OK, I'll only message you when something needs you, and never 21:00-09:00.")]);
    const response = await app.fixture.app.request(`/api/channels/${app.alex.mainChannelId}/messages`, json(app.alex, "POST", { text: "message me less, and nothing after 9pm", clientId: "p-1" }));
    await readSse(response, { timeoutMs: 10_000 });
    const request = app.llm.sent("chat")[0];
    expect(offeredNames(request)).toContain("set_proactivity");
    expect(request?.system).toContain("level normal (at most 3 a day), quiet hours 22:30-08:30");
    const user = await app.fixture.db.user.findUniqueOrThrow({ where: { id: app.alex.userId } });
    expect(user).toMatchObject({ proactivity: "low", quietStart: 21 * 60, quietEnd: 9 * 60 });
    expect(JSON.stringify(app.llm.sent("chat").at(-1)?.messages.at(-1))).toContain("dailyCap");
  });
});
