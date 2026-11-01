// Proactive turns (L75, L118, L119) through the real run host, agent runtime and providers on a
// role-scripted model: silent check-ins, check-ins that act, the brief and its push, Run now,
// the Up next scan, weekends, and the usage limit.
import { afterEach, describe, expect, test } from "bun:test";
import { RunNowResponse, ScheduleInfo, UpNext } from "../../src/contract/tasks.ts";
import { phrase } from "../../src/agent/phrase.ts";
import { offeredNames } from "../helpers/offered.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, eventsAfter, json, lastEventId, mainThread, messagesIn, ofType, startProactive, text, toolNames, type ProactiveApp } from "./harness.ts";

let app: ProactiveApp | undefined;
afterEach(async () => { await app?.cleanup(); app = undefined; });

const slot = new Date("2030-10-23T10:49:00.000Z");
const runOf = async (a: ProactiveApp, kind: string) => a.fixture.db.run.findFirstOrThrow({ where: { userId: a.alex.userId, kind }, orderBy: { createdAt: "desc" } });

describe("check-ins", () => {
  test("a check-in with nothing to say stays silent and is logged resolved", async () => {
    app = await startProactive();
    const before = (await mainThread(app)).length;
    const from = await lastEventId(app);
    app.llm.script("proactive", [text("Nothing new since this morning."), call("finish_checkin", { nothingNeeded: true })]);
    expect(await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "checkin", scheduledFor: slot })).toBe(true);
    await app.fixture.runs.idle();

    const run = await runOf(app, "checkin");
    expect(run.status).toBe("resolved");
    expect(run.scheduledFor?.toISOString()).toBe(slot.toISOString());
    expect(run.channelId).toBe(app.alex.mainChannelId);
    expect((await mainThread(app)).length).toBe(before);
    const events = await eventsAfter(app, from);
    expect(messagesIn(events)).toEqual([]);
    expect(ofType(events, "typing").filter((e) => e.payload.typing)).toEqual([]);
    expect(ofType(events, "done").map((e) => e.payload.runId)).toEqual([run.id]);
    expect(app.pushes).toEqual([]);
    // The model was told what this turn is and got the check-in tools (no start_task).
    const request = app.llm.sent("proactive")[0];
    expect(JSON.stringify(request?.messages[0])).toContain("Scheduled check-in");
    expect(toolNames(request)).toEqual(expect.arrayContaining(["post_message", "add_up_next", "finish_checkin", "set_weekends", "propose_task", "propose_tasks"]));
    expect(toolNames(request)).not.toContain("start_task");
    expect(toolNames(request)).not.toContain("ask_weekends"); // Wednesday
  });

  test("a check-in that needs the user posts in the main thread and adds Up next items", async () => {
    app = await startProactive();
    app.llm.script("proactive",
      [text("(thinking aloud, never shown)"), call("add_up_next", { title: "Reply to Dana", body: "She asked about the offsite dates.", prompt: "Draft a reply to Dana about the offsite dates", app: "Gmail" })],
      [call("post_message", { text: "Heads up: the launch review moved to 3 PM today." })],
      [call("finish_checkin", { nothingNeeded: false })],
    );
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "checkin", scheduledFor: slot });
    await app.fixture.runs.idle();

    expect((await runOf(app, "checkin")).status).toBe("completed");
    const thread = await mainThread(app);
    expect(thread.map((m) => m.text)).toEqual(["Heads up: the launch review moved to 3 PM today."]);
    const upNext = UpNext.parse(await (await app.fixture.app.request("/api/up-next", { headers: app.alex.headers })).json());
    expect(upNext.scanning).toBe(false);
    expect(upNext.suggestions.map((s) => ({ title: s.title, app: s.app, origin: s.origin, channelId: s.channelId }))).toEqual([
      { title: "Reply to Dana", app: "Gmail", origin: "checkin", channelId: app.alex.mainChannelId },
    ]);
  });
});

describe("morning brief", () => {
  test("posts the brief, starts a first step as a task and pushes the first line", async () => {
    app = await startProactive();
    app.llm.script("proactive",
      [call("start_first_step", { title: "Draft a reply to Sam", prompt: "Draft a reply to Sam about the budget" })],
      [text("Morning, Alex! For today: Ship the deck. Prep the 1:1. Reply to Sam.\n\nUpdates:\n1. **Budget** Sam needs numbers by noon; I started [a draft](duet://tasks/x).")],
    );
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "brief", scheduledFor: new Date("2030-10-23T08:19:00.000Z") });
    await app.fixture.runs.idle();

    const run = await runOf(app, "brief");
    expect(run.status).toBe("completed");
    const prompt = JSON.stringify(app.llm.sent("proactive")[0]?.messages[0]);
    expect(prompt).toContain("Scheduled morning brief");
    expect(prompt).toContain(JSON.stringify(phrase("agent.morning_greeting", "en").replace("{name}", "Alex")).slice(1, -1));
    const thread = await mainThread(app);
    expect(thread.map((m) => m.text).join("\n\n")).toContain("Morning, Alex! For today:");
    const task = await app.fixture.db.task.findFirstOrThrow({ where: { userId: app.alex.userId } });
    expect(task).toMatchObject({ title: "Draft a reply to Sam", source: "proactive", channelId: app.alex.mainChannelId });
    expect(app.pushes).toEqual([{
      userId: app.alex.userId, channelId: app.alex.mainChannelId, title: { key: "notify.title" },
      body: { text: "Morning, Alex! For today: Ship the deck. Prep the 1:1. Reply to Sam." }, route: `duet://channels/${app.alex.mainChannelId}`,
    }]);
  });

  test("nothing to brief on: no message, no push, logged resolved", async () => {
    app = await startProactive();
    const before = (await mainThread(app)).length;
    app.llm.script("proactive", [call("skip_brief", { reason: "No mail, events or tasks." })]);
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "brief", scheduledFor: new Date("2030-10-23T08:19:00.000Z") });
    await app.fixture.runs.idle();
    expect((await runOf(app, "brief")).status).toBe("resolved");
    expect((await mainThread(app)).length).toBe(before);
    expect(app.pushes).toEqual([]);
  });

  test("on a Friday the brief asks about weekends once; yes in chat turns them on", async () => {
    app = await startProactive();
    app.clock.now = new Date("2030-10-25T08:20:00.000Z"); // Friday
    app.llm.script("proactive", [text("Morning, Alex! For today: A. B. C."), call("ask_weekends", {})]);
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "brief", scheduledFor: new Date("2030-10-25T08:19:00.000Z") });
    await app.fixture.runs.idle();
    expect(toolNames(app.llm.sent("proactive")[0])).toContain("ask_weekends");
    const ask = (await mainThread(app)).find((m) => m.kind === "quick_replies");
    expect(ask?.text).toBe(phrase("agent.weekends_ask", "en"));
    expect(JSON.parse(ask!.payload)).toEqual({ options: ["Yes", "Not now"], chosen: null });

    // Already asked: a later Friday brief doesn't get the tool again.
    app.llm.script("proactive", [call("skip_brief", {})]);
    await app.proactive.service.runNow(app.alex.userId, "brief");
    await app.fixture.runs.idle();
    expect(toolNames(app.llm.sent("proactive")[1])).not.toContain("ask_weekends");

    // The user taps Yes: a chat turn, where set_weekends is offered.
    app.llm.script("chat", [call("set_weekends", { on: true })], [text("Done, I'll check in on weekends too.")]);
    const response = await app.fixture.app.request(`/api/channels/${app.alex.mainChannelId}/messages`, json(app.alex, "POST", {
      text: "Yes", clientId: "c-yes", quickReply: { messageId: ask!.id, option: "Yes" },
    }));
    expect(response.status).toBe(200);
    await readSse(response, { timeoutMs: 10_000 });
    expect(offeredNames(app.llm.sent("chat")[0])).toContain("set_weekends");
    expect((await app.fixture.db.user.findUniqueOrThrow({ where: { id: app.alex.userId } })).weekendsOn).toBe(true);
  });
});

describe("routes", () => {
  test("Run now runs a check-in outside the schedule; GET /api/schedule shows times, next runs and history", async () => {
    app = await startProactive();
    app.llm.script("proactive", [call("finish_checkin", { nothingNeeded: true })]);
    const response = await app.fixture.app.request("/api/schedule/run", json(app.alex, "POST", { kind: "checkin" }));
    expect(response.status).toBe(200);
    const { run } = RunNowResponse.parse(await response.json());
    expect(run).toMatchObject({ kind: "checkin", scheduledFor: null });
    await app.fixture.runs.idle();
    // A run cancelled by a restart shows as skipped (RunRecord has no "cancelled").
    await app.fixture.db.run.create({ data: { userId: app.alex.userId, kind: "brief", scheduledFor: new Date("2030-10-22T08:19:00.000Z"), status: "cancelled" } });

    const user = await app.fixture.db.user.findUniqueOrThrow({ where: { id: app.alex.userId } });
    const info = ScheduleInfo.parse(await (await app.fixture.app.request("/api/schedule", { headers: app.alex.headers })).json());
    const [hour, minute] = user.briefTime.split(":").map(Number);
    expect(info.weekendsOn).toBe(false);
    expect(info.brief.time).toEqual({ hour: hour!, minute: minute! });
    expect(info.checkin.times).toEqual([10, 13, 16, 19, 22].map((h) => ({ hour: h, minute: user.checkinMinute })));
    expect(new Date(info.brief.nextRunAt).getTime()).toBeGreaterThan(app.clock.now.getTime());
    expect(new Date(info.checkin.nextRunAt).getTime()).toBeGreaterThan(app.clock.now.getTime());
    expect(info.checkin.history).toEqual([expect.objectContaining({ id: run.id, kind: "checkin", scheduledFor: null, status: "resolved" })]);
    expect(info.brief.history).toEqual([expect.objectContaining({ kind: "brief", status: "skipped", scheduledFor: "2030-10-22T08:19:00.000Z" })]);

    expect((await app.fixture.app.request("/api/schedule/run", json(app.alex, "POST", { kind: "scan" }))).status).toBe(400);
    expect((await app.fixture.app.request("/api/schedule/run", json(app.alex, "POST", {}))).status).toBe(400);
    expect((await app.fixture.app.request("/api/schedule")).status).toBe(401);
    expect((await app.fixture.app.request("/api/up-next/scan", { method: "POST" })).status).toBe(401);
  });

  test("Run now with something to say: the result shows in chat and in Tasks (Up next, Scheduled history)", async () => {
    app = await startProactive();
    app.llm.script("proactive",
      [call("post_message", { text: "Your 3 PM with Dana moved to tomorrow." })],
      [call("add_up_next", { title: "Confirm the new time with Dana", body: "She moved the 3 PM.", prompt: "Reply to Dana confirming tomorrow", app: "Gmail" })],
      [call("finish_checkin", { nothingNeeded: false })],
    );
    const response = await app.fixture.app.request("/api/schedule/run", json(app.alex, "POST", { kind: "checkin" }));
    expect(response.status).toBe(200);
    const { run } = RunNowResponse.parse(await response.json());
    await app.fixture.runs.idle();

    // Chat: the main thread's messages.
    expect((await mainThread(app)).map((m) => m.text)).toContain("Your 3 PM with Dana moved to tomorrow.");
    // Tasks > Up next and Tasks > Scheduled.
    const upNext = UpNext.parse(await (await app.fixture.app.request("/api/up-next", { headers: app.alex.headers })).json());
    expect(upNext.suggestions.map((s) => s.title)).toEqual(["Confirm the new time with Dana"]);
    const info = ScheduleInfo.parse(await (await app.fixture.app.request("/api/schedule", { headers: app.alex.headers })).json());
    expect(info.checkin.history).toEqual([expect.objectContaining({ id: run.id, kind: "checkin", scheduledFor: null, status: "completed" })]);
  });

  test("Show me: 202, scanning while it runs, one scan at a time, items land in Up next, nothing in chat", async () => {
    app = await startProactive();
    const before = (await mainThread(app)).length;
    const gate = deferred();
    app.llm.script("proactive",
      async () => { await gate.promise; return [text("Found a few things."), call("add_up_next", { title: "Prep the launch review", body: "It's at 3 PM and the deck isn't final.", prompt: "Prep me for the launch review", app: "Google Calendar" })]; },
      [call("add_up_next", { title: "Answer Priya", body: "She's waiting on the contract.", prompt: "Draft a reply to Priya", app: "Gmail" })],
      [text("That's all.")],
    );
    const scan = () => app!.fixture.app.request("/api/up-next/scan", { method: "POST", headers: app!.alex.headers });
    expect((await scan()).status).toBe(202);
    const during = UpNext.parse(await (await app.fixture.app.request("/api/up-next", { headers: app.alex.headers })).json());
    expect(during.scanning).toBe(true);
    expect((await scan()).status).toBe(202);
    expect(await app.fixture.db.run.count({ where: { userId: app.alex.userId, kind: "scan" } })).toBe(1);
    gate.resolve();
    await app.fixture.runs.idle();

    const after = UpNext.parse(await (await app.fixture.app.request("/api/up-next", { headers: app.alex.headers })).json());
    expect(after.scanning).toBe(false);
    expect(after.suggestions.map((s) => [s.title, s.origin])).toEqual([["Answer Priya", "scan"], ["Prep the launch review", "scan"]]);
    expect((await mainThread(app)).length).toBe(before);
    expect(JSON.stringify(app.llm.sent("proactive")[0]?.messages[0])).toContain("Up next scan");
    expect(toolNames(app.llm.sent("proactive")[0])).toContain("add_up_next");
    expect(toolNames(app.llm.sent("proactive")[0])).not.toContain("post_message");
  });

  test("Show me: a propose card can't be shown in a scan, so the tool fails and the model adds Up next items instead", async () => {
    app = await startProactive();
    const before = (await mainThread(app)).length;
    app.llm.script("proactive",
      [call("propose_task", { title: "Answer Priya", body: "She's waiting on the contract.", prompt: "Draft a reply to Priya" })],
      [call("add_up_next", { title: "Answer Priya", body: "She's waiting on the contract.", prompt: "Draft a reply to Priya", app: "Gmail" })],
      [text("Done.")],
    );
    expect((await app.fixture.app.request("/api/up-next/scan", { method: "POST", headers: app.alex.headers })).status).toBe(202);
    await app.fixture.runs.idle();
    // The failed call went back to the model as a tool error, not as "shown".
    const second = JSON.stringify(app.llm.sent("proactive")[1]?.messages);
    expect(second).toContain("isError");
    expect(second).not.toContain("waitingForChoice");
    const after = UpNext.parse(await (await app.fixture.app.request("/api/up-next", { headers: app.alex.headers })).json());
    expect(after.suggestions.map((s) => s.title)).toEqual(["Answer Priya"]);
    expect((await mainThread(app)).length).toBe(before);
  });

  test("over the usage limit: a scheduled slot is skipped quietly, Run now and Show me are 429", async () => {
    app = await startProactive({ env: { SESSION_TOKEN_LIMIT: "100" } });
    await app.fixture.usage.record(app.alex.userId, 500);
    await app.proactive.service.runScheduled({ userId: app.alex.userId, kind: "checkin", scheduledFor: slot });
    await app.fixture.runs.idle();
    expect((await runOf(app, "checkin")).status).toBe("skipped");
    expect(app.llm.sent("proactive")).toEqual([]);
    expect(await app.fixture.db.message.count({ where: { userId: app.alex.userId, kind: "usage_limit" } })).toBe(0);
    expect((await app.fixture.app.request("/api/schedule/run", json(app.alex, "POST", { kind: "brief" }))).status).toBe(429);
    expect((await app.fixture.app.request("/api/up-next/scan", { method: "POST", headers: app.alex.headers })).status).toBe(429);
  });
});
