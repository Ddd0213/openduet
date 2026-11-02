// M9 routines (contract §3): schedule_task / manage_scheduled_task, the routines list in the chat
// context, slots claimed once (nextRunAt compare-and-set + unique Run.slotKey), pause, once,
// quiet, Run now (409 while one runs), PATCH rules, GET /api/tasks/:id/runs, and
// PROACTIVE_BUILTINS off (no brief / check-ins, ScheduleInfo.builtins false; routines still run).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RoutineRuns, RunNowResponse, ScheduleInfo, TaskDetail, TaskList } from "../../src/contract/tasks.ts";
import { normalizeSchedule, slotKey } from "../../src/routines/schedule.ts";
import type { RoutineSchedule } from "../../src/routines/schedule.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { offeredNames } from "../helpers/offered.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, mainThread, startProactive, text, toolNames, type ProactiveApp } from "../proactive/harness.ts";

/** Wednesday 2030-10-23 09:00 UTC (the harness default). */
const START = new Date("2030-10-23T09:00:00.000Z");
const at = (iso: string) => new Date(iso);

let app: ProactiveApp;
let sam: SignedIn;
let side: string;
beforeAll(async () => {
  app = await startProactive({ builtins: false, taskClock: true });
  sam = await signUp(app.fixture, "sam", "Sam Lee");
  side = (await app.fixture.db.channel.create({ data: { userId: app.alex.userId, name: "Finance", purpose: "Bills" } })).id;
});
afterAll(() => app.cleanup());

const db = () => app.fixture.db;
const req = (path: string, method = "GET", body?: unknown, user: SignedIn = app.alex) =>
  app.fixture.app.request(path, method === "GET" ? { headers: user.headers } : json(user, method, body));
const chat = async (body: string, clientId: string) => readSse(await req(`/api/channels/${app.alex.mainChannelId}/messages`, "POST", { text: body, clientId }));
const task = (id: string) => db().task.findUniqueOrThrow({ where: { id } });
const routineRuns = (taskId: string) => db().run.findMany({ where: { taskId, kind: "routine" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const daily = (hour: number, minute: number): RoutineSchedule => ({ cadence: "daily", hour, minute });
async function routine(title: string, schedule: RoutineSchedule, opts: { quiet?: boolean; channelId?: string; prompt?: string } = {}) {
  app.clock.now = START;
  return app.proactive.routines.create({
    userId: app.alex.userId, channelId: opts.channelId ?? side, title, prompt: opts.prompt ?? `Do: ${title}`, schedule, quiet: opts.quiet ?? false,
  });
}
async function tickAt(iso: string) {
  app.clock.now = at(iso);
  const report = await app.proactive.routines.tick(app.clock.now);
  await app.fixture.runs.idle();
  return report;
}

describe("schedule_task", () => {
  test("creates a routine in this channel: scheduled, routine state, next slot in the user's timezone, listed in chat", async () => {
    await db().user.update({ where: { id: app.alex.userId }, data: { timezone: "Asia/Shanghai" } });
    app.clock.now = START;
    app.llm.script("chat",
      [call("schedule_task", { title: "Weekly invoices", prompt: "Check unpaid invoices", schedule: { cadence: "weekly" } })],
      [call("schedule_task", { title: "Morning digest", prompt: "Summarise my inbox", schedule: { cadence: "daily", hour: 8, minute: 30 }, quiet: true })],
      [text("Scheduled: every day at 8:30.")],
    );
    const before = app.llm.sent("chat").length;
    const frames = await chat("Every morning at 8:30 summarise my inbox", "sched-1");
    const results = app.llm.sent("chat").slice(before + 1).map((r) => r.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").at(-1));
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toContain("weekly schedule needs hour");
    expect(frames.events.some((e) => e.type === "done")).toBe(true);

    const row = await db().task.findFirstOrThrow({ where: { userId: app.alex.userId, title: "Morning digest" } });
    // 09:00 UTC = 17:00 in Shanghai; the next 08:30 there is tomorrow 00:30 UTC.
    expect(row).toMatchObject({ routine: true, status: "scheduled", routineQuiet: true, routinePaused: false, channelId: app.alex.mainChannelId, prompt: "Summarise my inbox" });
    expect(row.nextRunAt?.toISOString()).toBe("2030-10-24T00:30:00.000Z");
    expect(JSON.parse(row.schedule!)).toEqual({ cadence: "daily", hour: 8, minute: 30 });
    expect(await db().task.count({ where: { userId: app.alex.userId, title: "Weekly invoices" } })).toBe(0);

    const listed = TaskList.parse(await (await req("/api/tasks")).json()).tasks.find((x) => x.id === row.id)!;
    expect(listed).toMatchObject({ status: "scheduled", schedule: { cadence: "daily", hour: 8, minute: 30 }, pinned: false, routine: { paused: false, quiet: true, nextRunAt: "2030-10-24T00:30:00.000Z", lastRunAt: null, lastRunStatus: null } });
    const event = await db().event.findFirstOrThrow({ where: { userId: app.alex.userId, type: "task" }, orderBy: { id: "desc" } });
    expect(JSON.parse(event.payload).task).toMatchObject({ id: row.id, routine: { quiet: true } });

    // The next chat turn lists it (id, title, schedule, paused) and offers both tools.
    app.llm.script("chat", [text("Yes, it's set.")]);
    await chat("Is it set?", "sched-2");
    const request = app.llm.sent("chat").at(-1)!;
    expect(request.system).toContain(`"id":"${row.id}","title":"Morning digest"`);
    expect(offeredNames(request)).toEqual(expect.arrayContaining(["schedule_task", "manage_scheduled_task"]));
    // Other tasks have routine null.
    expect(TaskList.parse(await (await req("/api/tasks")).json()).tasks.every((x) => (x.id === row.id) === (x.routine !== null))).toBe(true);
    await db().user.update({ where: { id: app.alex.userId }, data: { timezone: "UTC" } });
  });

  test("normalizeSchedule: every writer's rules", () => {
    const now = START;
    expect(normalizeSchedule({ cadence: "hourly", minute: 15 }, "UTC", now)).toEqual({ ok: true, schedule: { cadence: "hourly", hour: 0, minute: 15 } });
    expect(normalizeSchedule({ cadence: "weekly", hour: 9, minute: 0 }, "UTC", now)).toMatchObject({ ok: false });
    expect(normalizeSchedule({ cadence: "daily", hour: 24, minute: 0 }, "UTC", now)).toMatchObject({ ok: false, message: "hour must be 0-23" });
    expect(normalizeSchedule({ cadence: "once", at: "2030-10-23T08:00:00Z" }, "UTC", now)).toMatchObject({ ok: false, message: "at must be in the future" });
    expect(normalizeSchedule({ cadence: "once", at: "2030-10-24T08:00:00" }, "UTC", now)).toMatchObject({ ok: false });
    expect(normalizeSchedule({ cadence: "once", hour: 7, minute: 5 }, "UTC", now)).toEqual({ ok: true, schedule: { cadence: "once", hour: 7, minute: 5, at: "2030-10-24T07:05:00.000Z" } });
    expect(normalizeSchedule({ cadence: "once", at: "2030-10-24T10:00:00+08:00" }, "Asia/Shanghai", now)).toEqual({ ok: true, schedule: { cadence: "once", hour: 10, minute: 0, at: "2030-10-24T02:00:00.000Z" } });
  });
});

describe("slots", () => {
  test("a due slot runs once in the routine's channel; a second tick or a second claim of the slot doesn't run it again", async () => {
    const row = await routine("Bills check", daily(9, 30));
    expect(row.nextRunAt?.toISOString()).toBe("2030-10-23T09:30:00.000Z");
    expect(await tickAt("2030-10-23T09:20:00.000Z")).toEqual({ started: 0, skipped: 0 });

    app.llm.script("proactive", [text("Two bills are due this week: rent and power.")]);
    const [a, b] = await Promise.all([app.proactive.routines.tick(at("2030-10-23T09:31:00.000Z")), app.proactive.routines.tick(at("2030-10-23T09:31:00.000Z"))]);
    await app.fixture.runs.idle();
    expect(a.started + b.started).toBe(1);
    const runs = await routineRuns(row.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", channelId: side, slotKey: slotKey(row.id, at("2030-10-23T09:30:00.000Z")) });
    expect(JSON.parse(runs[0]!.title!)).toEqual({ text: "Bills check" });
    const posted = await db().message.findFirstOrThrow({ where: { channelId: side, role: "assistant" }, orderBy: { createdAt: "desc" } });
    expect(posted).toMatchObject({ text: "Two bills are due this week: rent and power.", taskId: null });
    const after = await task(row.id);
    expect(after).toMatchObject({ status: "scheduled", lastRunStatus: "completed" });
    expect(after.nextRunAt?.toISOString()).toBe("2030-10-24T09:30:00.000Z");
    const prompt = JSON.stringify(app.llm.sent("proactive").at(-1)!.messages.at(-1));
    expect(prompt).toContain("[Scheduled task \\\"Bills check\\\"");
    expect(prompt).toContain("Do: Bills check");

    // Another process with the old row: the compare-and-set wins, but the slot's Run already exists (slotKey).
    await db().task.update({ where: { id: row.id }, data: { nextRunAt: at("2030-10-23T09:30:00.000Z") } });
    expect(await tickAt("2030-10-23T09:32:00.000Z")).toEqual({ started: 0, skipped: 0 });
    expect(await routineRuns(row.id)).toHaveLength(1);
    expect(app.llm.remaining("proactive")).toBe(0);
  });

  test("a slot found more than 2 h late is recorded skipped, never run", async () => {
    const row = await routine("Late one", daily(5, 0));
    await db().task.update({ where: { id: row.id }, data: { nextRunAt: at("2030-10-23T05:00:00.000Z") } });
    const sent = app.llm.sent("proactive").length;
    expect(await tickAt("2030-10-23T09:00:00.000Z")).toEqual({ started: 0, skipped: 1 });
    expect(await routineRuns(row.id)).toMatchObject([{ status: "skipped", slotKey: slotKey(row.id, at("2030-10-23T05:00:00.000Z")) }]);
    expect(await task(row.id)).toMatchObject({ lastRunStatus: "skipped" });
    expect((await task(row.id)).nextRunAt?.toISOString()).toBe("2030-10-24T05:00:00.000Z");
    expect(app.llm.sent("proactive").length).toBe(sent);
  });

  test("a paused routine has no next run and its slot never runs; resume picks the next slot from now", async () => {
    const row = await routine("Paused one", daily(10, 0));
    const paused = TaskDetail.parse(await (await req(`/api/tasks/${row.id}`, "PATCH", { paused: true })).json());
    expect(paused.routine).toMatchObject({ paused: true, nextRunAt: null });
    expect((await tickAt("2030-10-23T10:01:00.000Z")).started).toBe(0);
    expect(await routineRuns(row.id)).toHaveLength(0);

    app.clock.now = at("2030-10-23T11:00:00.000Z");
    const resumed = TaskDetail.parse(await (await req(`/api/tasks/${row.id}`, "PATCH", { paused: false })).json());
    expect(resumed.routine).toMatchObject({ paused: false, nextRunAt: "2030-10-24T10:00:00.000Z" });

    // A slot queued before the pause doesn't run either (the before hook re-reads the routine):
    // a held chat turn in the channel keeps the routine's run waiting while the user pauses it.
    const gate = deferred();
    app.llm.script("chat", async () => { await gate.promise; return [text("Here you go.")]; });
    const held = await req(`/api/channels/${side}/messages`, "POST", { text: "Hold on", clientId: "hold-1" });
    try {
      app.clock.now = at("2030-10-24T10:00:30.000Z");
      // (other routines of this file may be due too; only this one's run matters here)
      expect((await app.proactive.routines.tick(app.clock.now)).started).toBeGreaterThanOrEqual(1);
      expect(await routineRuns(row.id)).toMatchObject([{ status: "queued" }]);
      expect((await req(`/api/tasks/${row.id}`, "PATCH", { paused: true })).status).toBe(200);
    } finally {
      gate.resolve();
    }
    await readSse(held);
    await app.fixture.runs.idle();
    expect(await routineRuns(row.id)).toMatchObject([{ status: "skipped", startedAt: null }]);
    expect(await task(row.id)).toMatchObject({ routinePaused: true, nextRunAt: null, lastRunStatus: "skipped" });
  });

  test("a once routine runs at its time and then has no next run (M22: it's resolved, with resolvedAt)", async () => {
    const row = await routine("Call the bank", { cadence: "once", hour: 12, minute: 0, at: "2030-10-23T12:00:00.000Z" });
    expect(row.nextRunAt?.toISOString()).toBe("2030-10-23T12:00:00.000Z");
    app.llm.script("proactive", [text("Reminder: call the bank about the card.")]);
    expect(await tickAt("2030-10-23T12:00:30.000Z")).toEqual({ started: 1, skipped: 0 });
    const after = await task(row.id);
    expect(after.nextRunAt).toBeNull();
    expect(after).toMatchObject({ status: "resolved", lastRunStatus: "completed" });
    expect(after.resolvedAt?.toISOString()).toBe("2030-10-23T12:00:30.000Z");
    // A day later (the other routines' late slots are skipped then) it doesn't run again.
    expect((await tickAt("2030-10-24T12:00:30.000Z")).started).toBe(0);
    expect(await routineRuns(row.id)).toHaveLength(1);
    expect((await task(row.id)).nextRunAt).toBeNull();
  });

  test("a quiet routine posts nothing unless something needs the user (post_message)", async () => {
    const row = await routine("Watch the inbox", daily(13, 0), { quiet: true, channelId: app.alex.mainChannelId });
    const before = (await mainThread(app)).length;
    app.llm.script("proactive", [text("Nothing new, all quiet.")]);
    await tickAt("2030-10-23T13:00:10.000Z");
    expect((await mainThread(app)).length).toBe(before);
    expect((await routineRuns(row.id)).at(-1)).toMatchObject({ status: "resolved" });
    expect(await task(row.id)).toMatchObject({ lastRunStatus: "resolved" });
    expect(toolNames(app.llm.sent("proactive").at(-1))).toContain("post_message");
    expect(toolNames(app.llm.sent("proactive").at(-1))).not.toContain("start_task");

    app.llm.script("proactive", [text("(muted)"), call("post_message", { text: "Dana needs the contract signed today." })], [text("done")]);
    await tickAt("2030-10-24T13:00:10.000Z");
    const thread = await mainThread(app);
    expect(thread.slice(before).map((m) => m.text)).toEqual(["Dana needs the contract signed today."]);
    expect((await routineRuns(row.id)).at(-1)).toMatchObject({ status: "completed" });

    // post_message writes past the tool sink's cleanup: a copied history note is still dropped there.
    app.llm.script("proactive", [call("post_message", { text: "Sign it today.[tools: read_inbox → ok][attachment]" })], [text("done")]);
    await tickAt("2030-10-25T13:00:10.000Z");
    expect((await mainThread(app)).at(-1)!.text).toBe("Sign it today.");
  });
});

describe("routine routes", () => {
  test("Run now queues a run outside the schedule; a second one while it runs is 409 conflict", async () => {
    const row = await routine("Run me", daily(18, 0));
    const gate = deferred();
    app.llm.script("proactive", async () => { await gate.promise; return [text("Ran on demand.")]; });
    const first = await req(`/api/tasks/${row.id}/run`, "POST");
    expect(first.status).toBe(200);
    const run = RunNowResponse.parse(await first.json()).run;
    expect(run).toMatchObject({ kind: "routine", scheduledFor: null });
    const again = await req(`/api/tasks/${row.id}/run`, "POST");
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("conflict");
    gate.resolve();
    await app.fixture.runs.idle();
    expect(await db().run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed", slotKey: null });
    // The schedule didn't move.
    expect((await task(row.id)).nextRunAt?.toISOString()).toBe("2030-10-23T18:00:00.000Z");

    const plain = await db().task.create({ data: { userId: app.alex.userId, channelId: app.alex.mainChannelId, title: "Plain", prompt: "p", status: "needs_input" } });
    expect((await req(`/api/tasks/${plain.id}/run`, "POST")).status).toBe(400);
    expect((await req(`/api/tasks/${row.id}/run`, "POST", {}, sam)).status).toBe(404);
  });

  test("GET /api/tasks/:id/runs: the routine's runs, newest first, at most 30", async () => {
    const row = await routine("History", daily(20, 0));
    const base = at("2030-10-01T20:00:00.000Z").getTime();
    for (let i = 0; i < 32; i++) {
      const slot = new Date(base + i * 86_400_000);
      await db().run.create({ data: {
        userId: app.alex.userId, kind: "routine", status: i % 5 === 0 ? "failed" : "completed", channelId: side, taskId: row.id,
        slotKey: slotKey(row.id, slot), startedAt: slot, createdAt: slot,
      } });
    }
    await db().run.create({ data: { userId: app.alex.userId, kind: "routine", status: "cancelled", channelId: side, taskId: row.id, createdAt: new Date(base + 40 * 86_400_000) } });
    const { runs } = RoutineRuns.parse(await (await req(`/api/tasks/${row.id}/runs`)).json());
    expect(runs).toHaveLength(30);
    expect(runs[0]).toMatchObject({ status: "skipped", scheduledFor: null });
    expect(runs[1]).toMatchObject({ kind: "routine", scheduledFor: new Date(base + 31 * 86_400_000).toISOString() });
    const starts = runs.slice(1).map((r) => r.scheduledFor!);
    expect(starts).toEqual([...starts].sort().reverse());
    const plain = await db().task.create({ data: { userId: app.alex.userId, channelId: app.alex.mainChannelId, title: "Plain 2", prompt: "p", status: "needs_input" } });
    expect((await req(`/api/tasks/${plain.id}/runs`)).status).toBe(400);
    expect((await req(`/api/tasks/${row.id}/runs`, "GET", undefined, sam)).status).toBe(404);
  });

  test("PATCH: pinned (and, M10, title) on any task; paused / schedule only on a routine; bad values are 400", async () => {
    const row = await routine("Patch me", daily(7, 0));
    const plain = await db().task.create({ data: { userId: app.alex.userId, channelId: app.alex.mainChannelId, title: "Plain 3", prompt: "p", status: "needs_input" } });
    for (const body of [{ paused: true }, { schedule: daily(8, 0) }]) {
      const response = await req(`/api/tasks/${plain.id}`, "PATCH", body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    expect(TaskDetail.parse(await (await req(`/api/tasks/${plain.id}`, "PATCH", { pinned: true })).json()).pinned).toBe(true);
    expect(TaskDetail.parse(await (await req(`/api/tasks/${row.id}`, "PATCH", { pinned: true })).json()).pinned).toBe(true);

    for (const body of [
      { status: "resolved" }, { schedule: { cadence: "weekly", hour: 9, minute: 0 } }, { schedule: { cadence: "daily", hour: 25, minute: 0 } },
      { schedule: { cadence: "once", hour: 9, minute: 0, at: "2030-10-01T09:00:00.000Z" } }, { title: "   " }, { quiet: true }, { prompt: "x" },
    ]) {
      const response = await req(`/api/tasks/${row.id}`, "PATCH", body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    app.clock.now = at("2030-10-23T09:00:00.000Z");
    const changed = TaskDetail.parse(await (await req(`/api/tasks/${row.id}`, "PATCH", { title: "Gym", schedule: { cadence: "weekly", hour: 6, minute: 45, weekday: 5 } })).json());
    expect(changed).toMatchObject({ title: "Gym", schedule: { cadence: "weekly", hour: 6, minute: 45, weekday: 5 }, routine: { nextRunAt: "2030-10-25T06:45:00.000Z" } });
  });

  test("manage_scheduled_task pauses, updates, resumes and deletes; an unknown id is a tool error", async () => {
    const row = await routine("Managed", daily(16, 0), { channelId: app.alex.mainChannelId });
    app.clock.now = START;
    app.llm.script("chat",
      [call("manage_scheduled_task", { taskId: row.id, action: "pause" })],
      [call("manage_scheduled_task", { taskId: row.id, action: "update", title: "Managed weekly", schedule: { cadence: "weekly", hour: 9, minute: 0, weekday: 1 }, quiet: true })],
      [call("manage_scheduled_task", { taskId: "nope", action: "resume" })],
      [call("manage_scheduled_task", { taskId: row.id, action: "update" })],
      [text("Paused and moved to Mondays.")],
    );
    const before = app.llm.sent("chat").length;
    await chat("Pause it and make it weekly on Mondays", "manage-1");
    const results = app.llm.sent("chat").slice(before + 1).map((r) => r.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").at(-1));
    expect(results.map((r) => r?.type === "tool_result" && (r.isError ?? false))).toEqual([false, false, true, true]);
    expect(await task(row.id)).toMatchObject({ title: "Managed weekly", routinePaused: true, routineQuiet: true, nextRunAt: null });

    app.llm.script("chat", [call("manage_scheduled_task", { taskId: row.id, action: "resume" })], [call("manage_scheduled_task", { taskId: row.id, action: "delete" })], [text("Deleted.")]);
    await chat("Resume it, actually delete it", "manage-2");
    expect(await db().task.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await db().event.count({ where: { userId: app.alex.userId, type: "task_deleted", payload: { contains: row.id } } })).toBe(1);
    // Someone else's routine is unknown to Alex's tools.
    const theirs = await app.proactive.routines.create({ userId: sam.userId, channelId: sam.mainChannelId, title: "Sam's", prompt: "p", schedule: daily(9, 0), quiet: false });
    app.llm.script("chat", [call("manage_scheduled_task", { taskId: theirs.id, action: "delete" })], [text("Can't.")]);
    await chat("Delete Sam's", "manage-3");
    expect(await db().task.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

describe("PROACTIVE_BUILTINS", () => {
  test("default: built-ins are enabled and a due morning brief runs without an explicit switch", async () => {
    const on = await startProactive();
    try {
      expect(ScheduleInfo.parse(await (await on.fixture.app.request("/api/schedule", { headers: on.alex.headers })).json()).builtins).toBe(true);
      await on.fixture.db.user.update({ where: { id: on.alex.userId }, data: {
        onboardedAt: START, timezone: "UTC", briefTime: "09:10", checkinMinute: 5,
      } });
      on.llm.script("proactive", [text("Here's your morning brief.")]);
      on.clock.now = at("2030-10-23T09:12:00.000Z");
      const report = await on.proactive.scheduler.tick(on.clock.now);
      await on.fixture.runs.idle();
      expect(report.started).toBe(1);
      expect(await on.fixture.db.run.count({ where: { userId: on.alex.userId, kind: "brief", status: "completed" } })).toBe(1);
      expect(on.pushes).toHaveLength(1);
      expect(on.pushes[0]!.body).toEqual({ text: "Here's your morning brief." });
    } finally {
      await on.cleanup();
    }
  });

  test("off: no brief or check-in slots, builtins false, no weekend switch in chat; routines still run", async () => {
    await db().user.update({ where: { id: app.alex.userId }, data: { onboardedAt: at("2030-10-01T00:00:00.000Z"), briefTime: "09:10", checkinMinute: 5 } });
    const info = ScheduleInfo.parse(await (await req("/api/schedule")).json());
    expect(info.builtins).toBe(false);
    const row = await routine("Still runs", daily(9, 10));
    app.llm.script("proactive", [text("Routine ran.")]);
    app.clock.now = at("2030-10-23T09:12:00.000Z");
    await app.proactive.scheduler.tick(app.clock.now);
    await app.fixture.runs.idle();
    expect(await db().run.count({ where: { userId: app.alex.userId, kind: { in: ["brief", "checkin"] } } })).toBe(0);
    expect(await routineRuns(row.id)).toHaveLength(1);
    app.llm.script("chat", [text("ok")]);
    await chat("Do weekends too", "builtins-off");
    expect(offeredNames(app.llm.sent("chat").at(-1))).not.toContain("set_weekends");
  });

  test("on: ScheduleInfo.builtins true and the weekend switch is offered", async () => {
    const on = await startProactive({ builtins: true });
    try {
      expect(ScheduleInfo.parse(await (await on.fixture.app.request("/api/schedule", { headers: on.alex.headers })).json()).builtins).toBe(true);
      on.llm.script("chat", [text("ok")]);
      await readSse(await on.fixture.app.request(`/api/channels/${on.alex.mainChannelId}/messages`, json(on.alex, "POST", { text: "Weekends too", clientId: "on-1" })));
      expect(offeredNames(on.llm.sent("chat").at(-1))).toContain("set_weekends");
    } finally {
      await on.cleanup();
    }
  });
});
