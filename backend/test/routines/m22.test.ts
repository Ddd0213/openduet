// M22 W1 (#23, #25, candidate 2, #48): the routine fatigue rule (failed runs in a row across days,
// a run's own automatic retries count once, pause at ROUTINE_FAIL_LIMIT with pausedBy "failures",
// a good run resets, PATCH resumes), routine memory (save_routine_state -> the next run's prompt,
// kept only when the run ends well), a once routine that failed stays scheduled, and a scan never
// hides or replaces an Up next item the user saved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { ROUTINE_FAIL_LIMIT } from "../../src/contract/m22.ts";
import { SaveForLaterResponse, TaskDetail } from "../../src/contract/tasks.ts";
import { LlmError } from "../../src/llm/index.ts";
import { createProactive, type Proactive } from "../../src/proactive/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import type { RoutineSchedule } from "../../src/routines/schedule.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { call, json, RoleScriptedLlm, text } from "../tasks/harness.ts";

const START = new Date("2030-10-23T09:00:00.000Z");
const llm = new RoleScriptedLlm();
const clock = { now: START };
let fixture: TestApp;
let tasks: Tasks;
let proactive: Proactive;
let alex: SignedIn;
beforeAll(async () => {
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const providers: ToolProvider[] = [];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      // a run's automatic retry after 5 ms (production: 1 / 5 / 15 min)
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent, backgroundRetryMs: [5] });
      tasks = createTasks({ db: core.db, events: core.events, runs, now: () => clock.now });
      proactive = createProactive({ db: core.db, runs, usage: core.usage, tasks: tasks.service, catalog: null, notify: async () => "sent", now: () => clock.now, welcomeDelaysMs: [0, 0], builtins: false });
      providers.push(...tasks.providers, ...proactive.providers);
      return { agent, runs, routes: [...tasks.routes, ...proactive.routes] };
    },
  });
  alex = await signUp(fixture, "alex");
});
afterAll(async () => { await proactive.scheduler.stop(); await fixture.cleanup(); });

const db = () => fixture.db;
const daily = (hour: number, minute: number): RoutineSchedule => ({ cadence: "daily", hour, minute });
const routine = (title: string, schedule: RoutineSchedule) => {
  clock.now = START;
  return proactive.routines.create({ userId: alex.userId, channelId: alex.mainChannelId, title, prompt: `Do: ${title}`, schedule, quiet: false });
};
const auth = () => new LlmError({ kind: "http", status: 401, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 1 });
const http502 = () => new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 });
const runNow = async (id: string) => {
  const row = await db().task.findUniqueOrThrow({ where: { id } });
  await proactive.routines.runNow(row);
  await fixture.runs.idle();
};
const view = async (id: string) => TaskDetail.parse(await (await fixture.app.request(`/api/tasks/${id}`, { headers: alex.headers })).json());
const patch = async (id: string, body: unknown) => TaskDetail.parse(await (await fixture.app.request(`/api/tasks/${id}`, json(alex, "PATCH", body))).json());
/** The routine prompt (the user message that holds it) of the newest routine run request. */
const lastPrompt = () => JSON.stringify(llm.sent("proactive").flatMap((r) => r.messages).filter((m) => JSON.stringify(m).includes("[Scheduled task")).at(-1));

describe("fatigue rule", () => {
  test("failed runs in a row count across runs (a run's own retries once); a good run resets; at the limit it pauses itself; PATCH resumes", async () => {
    expect(ROUTINE_FAIL_LIMIT).toBe(3);
    const row = await routine("Inbox sweep", daily(8, 0));
    // one run: fails, its automatic retry fails too -> one failure, one card
    llm.script("proactive", http502(), http502());
    await runNow(row.id);
    expect(await db().run.count({ where: { taskId: row.id, kind: "routine", status: "failed" } })).toBe(2);
    expect((await view(row.id)).routine).toMatchObject({ failStreak: 1, paused: false, pausedBy: null, lastRunStatus: "failed" });
    llm.script("proactive", auth());
    await runNow(row.id);
    expect((await view(row.id)).routine?.failStreak).toBe(2);
    // a run that ends well resets the count
    llm.script("proactive", [text("Two new mails from Dana.")]);
    await runNow(row.id);
    expect((await view(row.id)).routine).toMatchObject({ failStreak: 0, lastRunStatus: "completed" });

    for (let i = 1; i <= ROUTINE_FAIL_LIMIT; i++) {
      llm.script("proactive", auth());
      await runNow(row.id);
      if (i < ROUTINE_FAIL_LIMIT) expect((await view(row.id)).routine).toMatchObject({ failStreak: i, paused: false });
    }
    const paused = await view(row.id);
    expect(paused.routine).toMatchObject({ failStreak: 3, paused: true, pausedBy: "failures", nextRunAt: null });
    expect(paused.latestUpdate?.text).toEqual({ key: "task.routine_paused_failures", params: { count: { type: "number", value: 3 } } });
    expect(paused.status).toBe("scheduled");
    // paused: its slots don't run
    const runs = await db().run.count({ where: { taskId: row.id } });
    clock.now = new Date("2030-10-24T08:00:30.000Z");
    await proactive.routines.tick(clock.now);
    await fixture.runs.idle();
    expect(await db().run.count({ where: { taskId: row.id } })).toBe(runs);

    const resumed = await patch(row.id, { paused: false });
    expect(resumed.routine).toMatchObject({ paused: false, pausedBy: null, failStreak: 0 });
    expect(resumed.routine?.nextRunAt).not.toBeNull();
    expect((await patch(row.id, { paused: true })).routine).toMatchObject({ paused: true, pausedBy: "user" });
  });
});

describe("routine memory", () => {
  test("save_routine_state goes to the next run's prompt; a run that fails keeps the earlier notes; the state never reaches the app", async () => {
    const row = await routine("Watch the price", daily(10, 0));
    llm.script("proactive", [call("save_routine_state", { state: "Price seen: 120 EUR. Reported: 120 EUR." })], [text("It's 120 EUR.")]);
    await runNow(row.id);
    expect(lastPrompt()).toContain("No notes from an earlier run yet");
    expect(lastPrompt()).toContain("save_routine_state");
    const saved = JSON.parse((await db().task.findUniqueOrThrow({ where: { id: row.id } })).routineState!);
    expect(saved).toMatchObject({ text: "Price seen: 120 EUR. Reported: 120 EUR." });

    llm.script("proactive", [call("save_routine_state", { state: "Price seen: 99 EUR." })], auth());
    await runNow(row.id);
    expect(lastPrompt()).toContain("<previous_state>\\nPrice seen: 120 EUR. Reported: 120 EUR.\\n</previous_state>");
    expect(JSON.parse((await db().task.findUniqueOrThrow({ where: { id: row.id } })).routineState!).text).toBe("Price seen: 120 EUR. Reported: 120 EUR.");

    llm.script("proactive", [text("Still 120 EUR, nothing new.")]);
    await runNow(row.id);
    expect(lastPrompt()).toContain("Price seen: 120 EUR. Reported: 120 EUR.");
    const body = await (await fixture.app.request(`/api/tasks/${row.id}`, { headers: alex.headers })).text();
    expect(body).not.toContain("Price seen");
  });

  test("a once routine whose run failed stays scheduled (not resolved)", async () => {
    const row = await routine("Call the bank", { cadence: "once", hour: 12, minute: 0, at: "2030-10-23T12:00:00.000Z" });
    llm.script("proactive", auth());
    clock.now = new Date("2030-10-23T12:00:30.000Z");
    await proactive.routines.tick(clock.now);
    await fixture.runs.idle();
    const after = await db().task.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "scheduled", lastRunStatus: "failed", nextRunAt: null, resolvedAt: null });
  });
});

describe("Up next scans and saved requests", () => {
  test("a scan never hides or replaces an item the user saved (the same title is refused, the saved one stays open)", async () => {
    const saved = await fixture.app.request("/api/up-next", json(alex, "POST", { prompt: "Renew the passport", channelId: alex.mainChannelId }));
    expect(saved.status).toBe(201);
    const id = SaveForLaterResponse.parse(await saved.json()).suggestion.id;
    llm.script("proactive", [call("add_up_next", { title: "Renew the passport", body: "It expires soon", prompt: "Renew it" })], [text("done")]);
    await proactive.service.startUpNextScan(alex.userId);
    await fixture.runs.idle();
    const rows = await db().suggestion.findMany({ where: { userId: alex.userId, title: "Renew the passport" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, status: "open", fromUser: true, origin: "chat", body: "Renew the passport" });
  });
});
