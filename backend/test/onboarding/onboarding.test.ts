// Onboarding with real data (L76, L77): POST /api/onboarding/complete (welcome + first-day scan as
// events, once) and GET /api/onboarding (chips, Slack row), on a role-scripted model.
import { afterEach, describe, expect, test } from "bun:test";
import { phrase } from "../../src/agent/phrase.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { OnboardingCompleteResponse, OnboardingInfo } from "../../src/contract/auth.ts";
import { completeOnboarding } from "../../src/onboarding/info.ts";
import { call, eventsAfter, lastEventId, mainThread, messagesIn, ofType, startProactive, text, toolNames, type ProactiveApp } from "../proactive/harness.ts";

let app: ProactiveApp | undefined;
afterEach(async () => { await app?.cleanup(); app = undefined; });

const complete = (a: ProactiveApp) => a.fixture.app.request("/api/onboarding/complete", { method: "POST", headers: a.alex.headers });
const welcome = phrase("agent.welcome", "en").replaceAll("{name}", "Alex");
const trace = (events: DuetEvent[]) => events.flatMap((e) =>
  e.type === "typing" ? [`typing:${e.payload.typing}`]
    : e.type === "message" ? [`${e.payload.message.kind}:${e.payload.message.text}`]
      : e.type === "done" ? [`done:${e.payload.status}`] : []);

async function finishOnboarding(a: ProactiveApp) {
  const from = await lastEventId(a);
  const response = await complete(a);
  expect(response.status).toBe(200);
  const body = OnboardingCompleteResponse.parse(await response.json());
  await a.fixture.runs.idle();
  const run = await a.fixture.db.run.findFirstOrThrow({ where: { userId: a.alex.userId, kind: "scan" } });
  return { body, run, events: await eventsAfter(a, from) };
}

describe("POST /api/onboarding/complete", () => {
  test("Composio not set up: welcome, scan line, not-set-up line, typing on then off; a second call reruns nothing", async () => {
    app = await startProactive({ composio: false });
    const { body, run, events } = await finishOnboarding(app);
    expect(body.scanStarted).toBe(true);
    expect(body.user.onboardedAt).not.toBeNull();
    expect(body.user.id).toBe(app.alex.userId);
    expect(run.status).toBe("completed");
    expect(run.scheduledFor?.toISOString()).toBe(body.user.onboardedAt!);
    expect(trace(events)).toEqual([
      "typing:true", `text:${welcome}`, `text:${phrase("agent.welcome_scan", "en")}`, `text:${phrase("agent.scan_not_set_up", "en")}`, "typing:false", "done:completed",
    ]);
    // Every typing / done event belongs to the scan run.
    for (const e of [...ofType(events, "typing"), ...ofType(events, "done")]) expect(e.payload).toMatchObject({ runId: run.id, taskId: null });
    expect(messagesIn(events).every((m) => m.channelId === app!.alex.mainChannelId && m.role === "assistant")).toBe(true);
    expect(app.llm.requests).toEqual([]);

    const from = await lastEventId(app);
    const again = OnboardingCompleteResponse.parse(await (await complete(app)).json());
    await app.fixture.runs.idle();
    expect(again.scanStarted).toBe(false);
    expect(again.user.onboardedAt).toBe(body.user.onboardedAt);
    expect(await app.fixture.db.run.count({ where: { userId: app.alex.userId, kind: "scan" } })).toBe(1);
    expect(messagesIn(await eventsAfter(app, from))).toEqual([]);
  });

  test("a scan that couldn't be queued undoes onboarding, so the next call starts it", async () => {
    app = await startProactive({ composio: false });
    const refused = await completeOnboarding(app.fixture.db, { startFirstDayScan: async () => false }, app.alex.userId);
    expect(refused.scanStarted).toBe(false);
    expect(refused.user.onboardedAt).toBeNull();
    const { body } = await finishOnboarding(app);
    expect(body.scanStarted).toBe(true);
  });

  test("a first-day scan a restart cancelled before it started is queued again at startup, once", async () => {
    app = await startProactive({ composio: false });
    const onboardedAt = new Date(app.clock.now.getTime() - 60_000);
    await app.fixture.db.user.update({ where: { id: app.alex.userId }, data: { onboardedAt } });
    // The previous process queued it; recoverStaleRuns cancelled it before it reached the model.
    await app.fixture.db.run.create({ data: { userId: app.alex.userId, kind: "scan", scheduledFor: onboardedAt, status: "cancelled" } });
    const from = await lastEventId(app);
    expect(await app.proactive.service.resumeFirstDayScans()).toBe(1);
    await app.fixture.runs.idle();
    expect(trace(await eventsAfter(app, from))).toContain(`text:${welcome}`);
    expect(await app.proactive.service.resumeFirstDayScans()).toBe(0);
    const runs = await app.fixture.db.run.findMany({ where: { userId: app.alex.userId, kind: "scan" } });
    expect(runs.map((r) => r.status).sort()).toEqual(["cancelled", "completed"]);
  });

  test("Composio set up but nothing connected: says so and offers Gmail and Google Calendar", async () => {
    app = await startProactive();
    const { events } = await finishOnboarding(app);
    expect(trace(events)).toEqual([
      "typing:true", `text:${welcome}`, `text:${phrase("agent.welcome_scan", "en")}`, `text:${phrase("agent.scan_no_apps", "en")}`,
      "alert:", "alert:", "typing:false", "done:completed",
    ]);
    const cards = messagesIn(events).filter((m) => m.kind === "alert").map((m) => m.payload);
    expect(cards).toEqual([
      { title: { text: "Gmail" }, body: { key: "connectors.connect_body", params: { app: { type: "text", value: "Gmail" } } },
        action: { label: { key: "agent.connect_app", params: { app: { type: "text", value: "Gmail" } } }, type: "open_connector", url: null, toolkit: "gmail" } },
      { title: { text: "Google Calendar" }, body: { key: "connectors.connect_body", params: { app: { type: "text", value: "Google Calendar" } } },
        action: { label: { key: "agent.connect_app", params: { app: { type: "text", value: "Google Calendar" } } }, type: "open_connector", url: null, toolkit: "googlecalendar" } },
    ]);
    expect(app.llm.requests).toEqual([]);
  });

  test("with apps connected: memory -> Gmail -> Calendar, the profile read, quick replies and 3 task cards", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "gmail", "acc_gmail", "alex@acme.test");
    app.fake!.connect(app.alex.userId, "googlecalendar", "acc_cal", "alex@acme.test");
    await app.fixture.db.memory.create({ data: { userId: app.alex.userId, kind: "fact", text: "Leads the Q4 launch" } });
    app.llm.script("proactive",
      [call("check_memory", {})],
      [call("execute_app_tools", { calls: [{ tool: "GMAIL_FETCH_EMAILS", arguments: { query: "newer_than:14d", max_results: 20 } }] })],
      [call("execute_app_tools", { calls: [{ tool: "GOOGLECALENDAR_FIND_EVENT", arguments: { query: "this week" } }] })],
      [text("You lead the Q4 launch with Dana and Sam.\n\nHow I'll help:\n- Keep the launch on track\n- Prep your meetings\n- Draft replies"), call("confirm_profile", {})],
      [text("Here's what looks like it's on your plate:\n- Launch review Thursday\n- Sam's budget question"), call("propose_tasks", { tasks: [
        { title: "Prep the launch review", prompt: "Prep me for the launch review", app: "Google Calendar" },
        { title: "Reply to Sam", prompt: "Draft a reply to Sam about the budget", app: "Gmail" },
        { title: "Summarize the launch thread", prompt: "Summarize the launch email thread", app: "Gmail" },
      ] })],
    );
    const { run, events } = await finishOnboarding(app);
    expect(run.status).toBe("completed");
    expect(app.llm.remaining("proactive")).toBe(0);

    const statuses = ofType(events, "status").map((e) => e.payload.status);
    expect(statuses.filter((s) => s === "checking_memory" || s === "searching_email" || s === "checking_calendar")).toEqual(["checking_memory", "searching_email", "checking_calendar"]);
    const first = ofType(events, "typing")[0];
    expect(first?.payload).toMatchObject({ runId: run.id, typing: true });

    const thread = (await mainThread(app)).filter((m) => m.role === "assistant");
    expect(thread.slice(0, 2).map((m) => m.text)).toEqual([welcome, phrase("agent.welcome_scan", "en")]);
    const kinds = thread.slice(2).map((m) => m.kind).filter((k, i, all) => k !== all[i - 1]);
    expect(kinds).toEqual(["text", "quick_replies", "text", "task_suggestions"]);
    const all = thread.map((m) => m.text).join("\n");
    expect(all.indexOf("How I'll help:")).toBeLessThan(all.indexOf(phrase("agent.sound_off", "en")));
    expect(all.indexOf(phrase("agent.sound_off", "en"))).toBeLessThan(all.indexOf("Here's what looks like it's on your plate:"));
    const replies = thread.find((m) => m.kind === "quick_replies")!;
    expect(JSON.parse(replies.payload).options).toEqual(["Sounds right", "Something's off"]);
    const cards = thread.find((m) => m.kind === "task_suggestions")!;
    expect(cards.text).toBe(phrase("agent.places_to_start", "en"));
    expect(JSON.parse(cards.payload).items).toHaveLength(3);

    expect(app.fake!.executions.map((e) => e.slug)).toEqual(["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_FIND_EVENT"]);
    const firstRequest = app.llm.sent("proactive")[0];
    expect(JSON.stringify(firstRequest?.messages[0])).toContain("First-day scan");
    expect(toolNames(firstRequest)).toEqual(expect.arrayContaining(["check_memory", "confirm_profile", "propose_tasks", "execute_app_tools"]));
    expect(toolNames(firstRequest)).toContain("set_weekends");
    for (const name of ["start_task", "add_up_next", "post_message", "start_first_step"]) expect(toolNames(firstRequest)).not.toContain(name);
    expect(JSON.stringify(app.llm.sent("proactive")[1]?.messages.at(-1))).toContain("Leads the Q4 launch");
    // M23: the first-day scan's three suggestion cards each have their Up next row (one item, one answer).
    expect(await app.fixture.db.suggestion.count({ where: { userId: app.alex.userId } })).toBe(3);
  });
});

describe("GET /api/onboarding", () => {
  test("not configured: only channels and skills, Slack not connected", async () => {
    app = await startProactive({ composio: false });
    await app.fixture.db.channel.create({ data: { userId: app.alex.userId, name: "Launch" } });
    await app.fixture.db.skill.create({ data: { userId: app.alex.userId, name: "weekly-report", instructions: "Write it like last week." } });
    const info = OnboardingInfo.parse(await (await app.fixture.app.request("/api/onboarding", { headers: app.alex.headers })).json());
    expect(info).toEqual({ chips: [{ kind: "channel", label: "Launch" }, { kind: "skill", label: "weekly-report" }], slack: { connected: false } });
    expect((await app.fixture.app.request("/api/onboarding")).status).toBe(401);
  });

  test("fewer than three: the server's Composio toolkits fill the rows, common ones first", async () => {
    app = await startProactive();
    const info = OnboardingInfo.parse(await (await app.fixture.app.request("/api/onboarding", { headers: app.alex.headers })).json());
    expect(info.chips).toEqual([
      { kind: "app", label: "Gmail", toolkit: "gmail" },
      { kind: "app", label: "Google Calendar", toolkit: "googlecalendar" },
      { kind: "app", label: "Slack", toolkit: "slack" },
      { kind: "app", label: "Google Docs", toolkit: "googledocs" },
      { kind: "app", label: "Acme", toolkit: "acme" },
    ]);
    expect(info.slack.connected).toBe(false);
  });

  test("connected apps by display name, then channels and skills; Slack connected", async () => {
    app = await startProactive();
    app.fake!.connect(app.alex.userId, "slack", "acc_slack", "alex@acme.test");
    await app.fixture.db.channel.create({ data: { userId: app.alex.userId, name: "Launch" } });
    await app.fixture.db.skill.create({ data: { userId: app.alex.userId, name: "weekly-report", instructions: "Write it like last week." } });
    const info = OnboardingInfo.parse(await (await app.fixture.app.request("/api/onboarding", { headers: app.alex.headers })).json());
    expect(info).toEqual({
      chips: [{ kind: "app", label: "Slack", toolkit: "slack" }, { kind: "channel", label: "Launch" }, { kind: "skill", label: "weekly-report" }],
      slack: { connected: true },
    });
  });
});
