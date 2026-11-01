// M21: the morning brief runs strictly once per local date (proactive/gate.ts "brief_done"), read
// from Run rows, so a changed brief time, a second slot or a restart can't bring a second one.
// Today's first-day scan counts as the day's hello. Failed or skipped briefs don't count.
import { afterEach, describe, expect, test } from "bun:test";
import { decide, gate, QUIET_DEFAULT, type GateFacts } from "../../src/proactive/gate.ts";
import { startProactive, text, type ProactiveApp } from "./harness.ts";

let app: ProactiveApp | undefined;
afterEach(async () => { await app?.cleanup(); app = undefined; });

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  kind: "brief", proactivity: "normal", localMinute: 9 * 60, quietStart: QUIET_DEFAULT.start, quietEnd: QUIET_DEFAULT.end,
  postedToday: 0, sinceUserMs: null, runActive: false, unanswered: false, usageShare: 0, ...over,
});

describe("decide", () => {
  test("a brief already today is brief_done; check-ins don't look at it; off, usage and the cap still come first", () => {
    expect(decide(facts())).toEqual({ go: true });
    expect(decide(facts({ briefToday: true }))).toEqual({ go: false, reason: "brief_done" });
    expect(decide(facts({ kind: "checkin", localMinute: 14 * 60, briefToday: true }))).toEqual({ go: true });
    expect(decide(facts({ briefToday: true, proactivity: "off" }))).toEqual({ go: false, reason: "off" });
    expect(decide(facts({ briefToday: true, postedToday: 3 }))).toEqual({ go: false, reason: "daily_cap" });
  });
});

describe("gate() reads it from the database", () => {
  test("by local date: completed or resolved briefs and today's first-day scan count; failed ones, yesterday's and the Up next scan don't", async () => {
    app = await startProactive();
    const { db, usage } = app.fixture;
    const userId = app.alex.userId;
    const channelId = app.alex.mainChannelId;
    // 09:00 in Shanghai on 2030-10-23 (UTC+8).
    await db.user.update({ where: { id: userId }, data: { timezone: "Asia/Shanghai" } });
    const now = new Date("2030-10-23T01:00:00.000Z");
    const check = () => gate({ db, usage }, { userId, channelId, kind: "brief", runId: "run_next", now });
    const run = (data: { kind: string; status: string; finishedAt: Date; scheduledFor?: Date | null }) =>
      db.run.create({ data: { userId, channelId, startedAt: data.finishedAt, ...data } });
    const reset = () => db.run.deleteMany({ where: { userId } });

    expect(await check()).toEqual({ go: true });
    // 07:30 local today = 23:30 UTC the day before: still today.
    await run({ kind: "brief", status: "completed", finishedAt: new Date("2030-10-22T23:30:00.000Z"), scheduledFor: new Date("2030-10-22T23:19:00.000Z") });
    expect(await check()).toEqual({ go: false, reason: "brief_done" });
    await reset();
    await run({ kind: "brief", status: "resolved", finishedAt: new Date("2030-10-23T00:20:00.000Z"), scheduledFor: null });
    expect(await check()).toEqual({ go: false, reason: "brief_done" });
    await reset();
    // Yesterday (23:59 local on the 22nd) and a failed one today: the brief still runs.
    await run({ kind: "brief", status: "completed", finishedAt: new Date("2030-10-22T15:59:00.000Z"), scheduledFor: new Date("2030-10-22T00:19:00.000Z") });
    await run({ kind: "brief", status: "failed", finishedAt: new Date("2030-10-23T00:20:00.000Z"), scheduledFor: new Date("2030-10-23T00:19:00.000Z") });
    expect(await check()).toEqual({ go: true });
    // The Up next scan (scheduledFor null) isn't the day's hello; the first-day scan is.
    await run({ kind: "scan", status: "completed", finishedAt: new Date("2030-10-23T00:30:00.000Z"), scheduledFor: null });
    expect(await check()).toEqual({ go: true });
    await run({ kind: "scan", status: "completed", finishedAt: new Date("2030-10-23T00:40:00.000Z"), scheduledFor: new Date("2030-10-23T00:35:00.000Z") });
    expect(await check()).toEqual({ go: false, reason: "brief_done" });
  });

  test("end to end: the brief time moves later the same day (or the server restarted): the second slot is skipped without a model call", async () => {
    app = await startProactive();
    // The harness records finishedAt on the real clock; keep the gate's day the same.
    app.clock.now = new Date();
    app.llm.script("proactive", [text("Morning, Alex! For today: Ship the deck.")]);
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "brief", scheduledFor: new Date(app.clock.now.getTime() - 60_000) });
    await app.fixture.runs.idle();
    expect(app.llm.sent("proactive")).toHaveLength(1);

    // A second slot (brief time changed from 08:19 to 09:19, or the in-memory window lost on restart).
    app.clock.now = new Date(Date.now() + 1000);
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "brief", scheduledFor: new Date(app.clock.now.getTime() - 1000) });
    await app.fixture.runs.idle();
    expect(app.llm.sent("proactive")).toHaveLength(1);
    const runs = await app.fixture.db.run.findMany({ where: { userId: app.alex.userId, kind: "brief" }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["completed", "skipped"]);
  });
});
