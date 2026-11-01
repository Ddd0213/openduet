// M29: one push when a run stops (it finished, it waits on the user, it failed) and the user isn't
// looking: what the run posted decides it (notify/run-end.ts, fed by RunHost), plus task failures,
// routines, Make builds, the usage limit, quiet hours on the event too, the APNs badge and the
// human check's single push. A stub model (scripts keyed by a marker in the turn's text), the real
// run host, tasks, routines and Notifier, and a fake push provider (no live event stream, so every
// notification is also a remote push).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageDraft, TurnInput, TurnResult, TurnSink } from "../../src/agent/types.ts";
import { ArtifactResponse } from "../../src/contract/artifacts.ts";
import type { Phrase } from "../../src/contract/common.ts";
import type { Message } from "../../src/contract/messages.ts";
import { ROUTINE_FAIL_LIMIT } from "../../src/contract/m22.ts";
import { needsYou } from "../../src/needs/service.ts";
import { Notifier, type NotifyInput } from "../../src/notify/notifier.ts";
import { ApnsProvider } from "../../src/notify/providers/apns.ts";
import type { PushMessage } from "../../src/notify/providers/types.ts";
import { RoutineService } from "../../src/routines/service.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { computerRig } from "../computer/harness.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";
import { buildTurn, PAGE, startMake } from "../make/harness.ts";
import { call, json, lastEventId, ofType, storedEvents } from "../tasks/harness.ts";
import { FakeProvider, fakeTransport, testP8 } from "./fakes.ts";

type Script = (input: TurnInput) => Promise<TurnResult>;
/** marker in the turn's text -> what the model does; anything else just completes */
const scripts = new Map<string, Script>();
const agent = stubAgent(async (input) => {
  for (const [marker, script] of scripts) if (input.userMessage.text.includes(marker)) return script(input);
  return ok();
});
const ok = (): TurnResult => ({ status: "completed", error: null, usage: usage(1, 1), model: MODEL });
const failed = (error: Phrase): TurnResult => ({ status: "failed", error, usage: usage(1, 0), model: MODEL });
const AUTH: Phrase = { key: "system.model_auth" };
const RETRYABLE: Phrase = { key: "system.model_error", params: { status: { type: "number", value: 529 } } };
const say = (sink: TurnSink, text: string) => sink.upsertMessage({ role: "assistant", kind: "text", text });
const card = (sink: TurnSink, draft: { kind: Message["kind"]; text?: string; payload: Record<string, unknown> }) => sink.upsertMessage({ role: "assistant", ...draft } as MessageDraft);

const FORM = {
  title: "Trip dates", description: null, icon: "calendar", submitLabel: null, state: "open", answers: null,
  fields: [{ id: "f1", type: "text", label: "When do you leave?", required: true, placeholder: null, multiline: false }],
};
const CONNECT = {
  type: "api_key", name: "Notion", purpose: "Read the roadmap", url: null, domain: "api.notion.com", toolkit: null,
  headerName: "Authorization", valuePrefix: "Bearer ", fields: [{ key: "key", label: "API key", secret: true, placeholder: null }], state: "open", connectorId: null,
};
const SIGN_IN = { requestId: "sr1", domain: "shop.example.com", state: "pending", step: "credentials", reason: null, outcome: null };
const ALERT = {
  title: { key: "alert.one_thing" }, body: { key: "alert.human_check", params: { domain: { type: "text", value: "shop.example.com" } } },
  action: { label: { key: "alert.open_browser" }, type: "open_browser", url: null, toolkit: null },
};

const DAY = new Date("2026-10-28T12:00:00.000Z");
/** Alex: UTC, default quiet hours 22:30-08:30 */
const NIGHT = new Date("2026-10-28T23:10:00.000Z");
const clock = { now: DAY };
const provider = new FakeProvider();
let fixture: TestApp;
let notifier: Notifier;
let tasks: Tasks;
let routines: RoutineService;
let alex: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({ SESSION_TOKEN_LIMIT: "1000000" }, {
    setup: (core) => {
      notifier = new Notifier({ db: core.db, events: core.events, provider, now: () => clock.now, followUps: false, unread: false });
      // a background run's automatic retry after 5 ms (production: 1 / 5 / 15 min)
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent, backgroundRetryMs: [5], notices: notifier });
      runs.retryable("checkin", () => ({}));
      tasks = createTasks({ db: core.db, events: core.events, runs });
      routines = new RoutineService({ db: core.db, runs, usage: core.usage, tasks: tasks.service });
      return { agent, runs };
    },
  });
  alex = await signUp(fixture, "alex");
  notifier.start();
});
afterAll(async () => {
  await notifier.stop();
  await fixture.cleanup();
});

/** What `act` pushed (remote pushes and the stored notification events), once everything settled. */
async function pushed(act: () => Promise<unknown>): Promise<{ sent: PushMessage[]; events: { body: Phrase; route: string; collapseId: string | null; passive: boolean }[] }> {
  const from = provider.sent.length;
  const after = await lastEventId(fixture);
  await act();
  await settle();
  const events = ofType(await storedEvents(fixture, alex.userId, after), "notification").map((e) => ({
    body: e.payload.body, route: e.payload.route, collapseId: e.payload.collapseId, passive: e.payload.passive,
  }));
  return { sent: provider.sent.slice(from), events };
}
async function settle() {
  for (let i = 0; i < 3; i++) {
    await fixture.runs.idle();
    await notifier.idle();
  }
}
let sends = 0;
const send = (text: string, extra: { callId?: string; taskId?: string } = {}) => fixture.runs.send({
  userId: alex.userId, channelId: alex.mainChannelId, text, clientId: `m29-${++sends}`, fileIds: [], skill: null, quickReply: null, ...extra,
});
const submit = (kind: "checkin" | "scan" | "brief", prompt: string) => fixture.runs.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind, prompt });
const link = (messageId: string) => `duet://channels/${alex.mainChannelId}?message=${messageId}`;
const keys = (r: Awaited<ReturnType<typeof pushed>>) => r.events.map((e) => e.body.key);

describe("done", () => {
  test("a reply to the user and a proactive message push once each, on the run's newest message", async () => {
    scripts.set("[reply]", async ({ sink }) => {
      const first = await say(sink, "Looking");
      await sink.upsertMessage({ id: first.id, role: "assistant", kind: "text", text: "Looking at your inbox" }); // a streaming update
      await say(sink, "Two mails from Dana need you.");
      return ok();
    });
    const reply = await pushed(() => send("[reply] anything from Dana?"));
    const last = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, text: "Two mails from Dana need you." } });
    expect(reply.events).toEqual([{ body: { key: "notify.reply" }, route: link(last.id), collapseId: `message-${last.id}`, passive: false }]);
    expect(reply.sent.map((m) => [m.body, m.route, m.collapseId, m.passive ?? false])).toEqual([["OpenDuet replied to you.", link(last.id), `message-${last.id}`, false]]);

    scripts.set("[scan]", async ({ sink }) => {
      await say(sink, "Your Q4 deck changed overnight.");
      return ok();
    });
    const scan = await pushed(() => submit("scan", "[scan] look around"));
    const message = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, text: "Your Q4 deck changed overnight." } });
    expect(scan.events).toEqual([{ body: { key: "notify.message" }, route: link(message.id), collapseId: `message-${message.id}`, passive: false }]);
    expect(scan.sent.map((m) => m.body)).toEqual(["OpenDuet sent you a message."]);
  });

  test("a quiet check-in (nothing posted) pushes nothing; a brief's end adds nothing to its own push", async () => {
    expect(await pushed(() => submit("checkin", "[quiet] check in"))).toEqual({ sent: [], events: [] });
    scripts.set("[brief]", async ({ sink }) => {
      await say(sink, "Good morning. Three things today.");
      return ok();
    });
    expect(await pushed(() => submit("brief", "[brief] morning"))).toEqual({ sent: [], events: [] });
  });
});

describe("waiting on you", () => {
  test("a reply with a form pushes only the form, the moment it's posted", async () => {
    let during: PushMessage[] = [];
    scripts.set("[form]", async ({ sink }) => {
      await say(sink, "A quick question first.");
      const before = provider.sent.length;
      await card(sink, { kind: "form", text: "", payload: FORM });
      await notifier.idle();
      during = provider.sent.slice(before);
      return ok();
    });
    const result = await pushed(() => send("[form] plan my trip"));
    const form = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "form" }, orderBy: { createdAt: "desc" } });
    expect(result.events).toEqual([{ body: { key: "notify.form" }, route: link(form.id), collapseId: `message-${form.id}`, passive: false }]);
    expect(result.sent.map((m) => m.body)).toEqual(["OpenDuet has a question for you."]);
    // pushed while the run was still going, not at its end
    expect(during.map((m) => m.collapseId)).toEqual([`message-${form.id}`]);
  });

  test("a connection request and a sign-in push when posted, with the app / site", async () => {
    scripts.set("[connect]", async ({ sink }) => {
      await card(sink, { kind: "connection_request", text: "", payload: CONNECT });
      return ok();
    });
    scripts.set("[signin]", async ({ sink }) => {
      await card(sink, { kind: "sign_in", payload: SIGN_IN });
      return ok();
    });
    const connect = await pushed(() => send("[connect] read my roadmap"));
    expect(keys(connect)).toEqual(["notify.connect"]);
    expect(connect.events[0]!.body).toEqual({ key: "notify.connect", params: { name: { type: "text", value: "Notion" } } });
    expect(connect.sent.map((m) => m.body)).toEqual(["Connect Notion to continue."]);
    const signIn = await pushed(() => send("[signin] order it"));
    const row = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "sign_in" } });
    expect(signIn.events).toEqual([{ body: { key: "notify.sign_in", params: { name: { type: "text", value: "shop.example.com" } } }, route: link(row.id), collapseId: `message-${row.id}`, passive: false }]);
    expect(signIn.sent.map((m) => m.body)).toEqual(["Sign in to shop.example.com to continue."]);
  });
});

describe("failures", () => {
  test("no push while a background run will be retried; its last failure pushes notify.failed on the card", async () => {
    const cardsBefore = await fixture.db.message.count({ where: { userId: alex.userId, kind: "model_error" } });
    let attempt = 0;
    const early: PushMessage[][] = [];
    scripts.set("[retry]", async () => {
      attempt += 1;
      early.push(provider.sent.slice());
      return failed(RETRYABLE);
    });
    const before = provider.sent.length;
    const result = await pushed(() => submit("checkin", "[retry] check in"));
    expect(attempt).toBe(2);
    // the first failure (retried in 5 ms) pushed nothing before the retry ran
    expect(early[1]!.length).toBe(before);
    const cards = await fixture.db.message.findMany({ where: { userId: alex.userId, kind: "model_error" }, orderBy: { createdAt: "asc" } });
    expect(cards).toHaveLength(cardsBefore + 1);
    const errorCard = cards.at(-1)!;
    expect(result.events).toEqual([{ body: { key: "notify.failed" }, route: link(errorCard.id), collapseId: `message-${errorCard.id}`, passive: false }]);
    expect(result.sent.map((m) => m.body)).toEqual(["OpenDuet couldn't finish. Open it to see why."]);
  });

  test("a task that failed pushes notify.task_failed, not notify.task_needs_input", async () => {
    scripts.set("[taskfail]", async () => failed(AUTH));
    const result = await pushed(() => tasks.service.create({ userId: alex.userId, channelId: alex.mainChannelId, title: "Launch review prep", prompt: "[taskfail] prep the review" }));
    const task = await fixture.db.task.findFirstOrThrow({ where: { userId: alex.userId, title: "Launch review prep" } });
    expect(task.status).toBe("needs_input");
    expect(task.failure).not.toBeNull();
    expect(result.events).toEqual([{ body: { key: "notify.task_failed", params: { title: { type: "text", value: "Launch review prep" } } }, route: `duet://tasks/${task.id}`, collapseId: `task-${task.id}`, passive: false }]);
    expect(result.sent.map((m) => m.body)).toEqual(["Launch review prep didn't work out. Take a look."]);
  });

  test(`a routine's failure pushes notify.routine_failed; the one that pauses it (${ROUTINE_FAIL_LIMIT} in a row) notify.routine_paused`, async () => {
    scripts.set("[routinefail]", async () => failed(AUTH));
    const row = await routines.create({ userId: alex.userId, channelId: alex.mainChannelId, title: "Inbox sweep", prompt: "[routinefail] sweep the inbox", schedule: { cadence: "daily", hour: 8, minute: 0 }, quiet: false });
    const runs: Awaited<ReturnType<typeof pushed>>[] = [];
    for (let i = 0; i < ROUTINE_FAIL_LIMIT; i++) {
      runs.push(await pushed(async () => routines.runNow(await fixture.db.task.findUniqueOrThrow({ where: { id: row.id } }))));
    }
    const title = { title: { type: "text" as const, value: "Inbox sweep" } };
    expect(runs.map(keys)).toEqual([["notify.routine_failed"], ["notify.routine_failed"], ["notify.routine_paused"]]);
    expect(runs[0]!.events[0]!.body).toEqual({ key: "notify.routine_failed", params: title });
    expect(runs[0]!.events[0]!.route).toStartWith(`duet://channels/${alex.mainChannelId}?message=`);
    expect(runs[2]!.events[0]).toMatchObject({ body: { key: "notify.routine_paused", params: title }, route: `duet://tasks/${row.id}` });
    expect(runs.map((r) => r.sent.map((m) => m.body))).toEqual([
      ["Scheduled task Inbox sweep ran into an error."], ["Scheduled task Inbox sweep ran into an error."], ["Scheduled task Inbox sweep kept failing and is paused."],
    ]);
    expect(await fixture.db.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ routinePaused: true, routinePausedBy: "failures" });
  });

  test("a task stopped at the usage limit pushes notify.usage_limit, and it rings in quiet hours", async () => {
    clock.now = NIGHT;
    await fixture.db.usage.upsert({ where: { userId: alex.userId }, create: { userId: alex.userId, sessionTokens: 2_000_000, sessionWindowStart: new Date() }, update: { sessionTokens: 2_000_000, sessionWindowStart: new Date() } });
    try {
      const result = await pushed(() => tasks.service.create({ userId: alex.userId, channelId: alex.mainChannelId, title: "Budget check", prompt: "Check the budget" }));
      const task = await fixture.db.task.findFirstOrThrow({ where: { userId: alex.userId, title: "Budget check" } });
      expect(task.status).toBe("needs_input");
      expect(result.events).toEqual([{ body: { key: "notify.usage_limit" }, route: `duet://tasks/${task.id}`, collapseId: `task-${task.id}`, passive: false }]);
      expect(result.sent.map((m) => [m.body, m.passive ?? false])).toEqual([["You've hit your usage limit, so OpenDuet stopped for now.", false]]);
    } finally {
      clock.now = DAY;
      await fixture.db.usage.update({ where: { userId: alex.userId }, data: { sessionTokens: 0, sessionWindowStart: null } });
    }
  });
});

describe("never pushed", () => {
  test("a task's own session, a turn a voice call is on, and a run that ended cancelled push nothing", async () => {
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Quiet session", prompt: "p", status: "working" } });
    scripts.set("[session]", async ({ sink }) => {
      await say(sink, "Done in the task.");
      await card(sink, { kind: "form", text: "", payload: FORM });
      return failed(AUTH);
    });
    expect(await pushed(() => send("[session] go on", { taskId: task.id }))).toEqual({ sent: [], events: [] });

    scripts.set("[call]", async ({ sink }) => {
      await say(sink, "Booked for 7 pm.");
      return ok();
    });
    expect(await pushed(() => send("[call] book it", { callId: "call-1" }))).toEqual({ sent: [], events: [] });
    expect((await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, text: "Booked for 7 pm." } })).callId).toBe("call-1");

    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    scripts.set("[stop]", async ({ sink, signal }) => {
      await say(sink, "Working on it");
      started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", error: null, usage: usage(1, 0), model: MODEL };
    });
    const stopped = await pushed(async () => {
      await send("[stop] a long one");
      await running;
      expect(await fixture.runs.stop({ userId: alex.userId, channelId: alex.mainChannelId })).toBe(1);
    });
    expect(stopped).toEqual({ sent: [], events: [] });
  });
});

describe("quiet hours", () => {
  test("a proactive run's push is passive at night, on the event as on the remote push; a chat turn's rings", async () => {
    clock.now = NIGHT;
    try {
      scripts.set("[night]", async ({ sink }) => {
        await say(sink, "Your flight moved to 9:40.");
        return ok();
      });
      const checkin = await pushed(() => submit("checkin", "[night] check in"));
      expect(checkin.events.map((e) => [e.body.key, e.passive])).toEqual([["notify.message", true]]);
      expect(checkin.sent.map((m) => m.passive)).toEqual([true]);
      scripts.set("[nightchat]", async ({ sink }) => {
        await say(sink, "Here it is.");
        return ok();
      });
      const reply = await pushed(() => send("[nightchat] the gate?"));
      expect(reply.events.map((e) => [e.body.key, e.passive])).toEqual([["notify.reply", false]]);
      expect(reply.sent.map((m) => m.passive)).toEqual([undefined]);
      scripts.set("[nightfail]", async () => failed(AUTH));
      const failure = await pushed(() => submit("scan", "[nightfail] scan"));
      expect(failure.events.map((e) => [e.body.key, e.passive])).toEqual([["notify.failed", true]]);
      expect(failure.sent.map((m) => m.passive)).toEqual([true]);
    } finally {
      clock.now = DAY;
    }
  });
});

describe("APNs badge", () => {
  test("an APNs alert push carries the Waiting on you count; the withdraw push and other providers carry none", async () => {
    await fixture.db.deviceToken.create({ data: { userId: alex.userId, provider: "apns", token: "b".repeat(64), environment: "production" } });
    // an open card outside any task counts in Waiting on you
    await fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "assistant", kind: "form", text: "", payload: JSON.stringify(FORM) } });
    const transport = fakeTransport();
    const { pem } = await testP8();
    const apns = new ApnsProvider({ db: fixture.db, keyId: "KEY123", teamId: "TEAM456", key: pem, topic: "com.example.duet", env: null, transport: transport.transport, retryDelayMs: 0 });
    const badged = new Notifier({ db: fixture.db, events: fixture.events, provider: apns, now: () => clock.now, followUps: false, unread: false });
    const count = (await needsYou(fixture.db, alex.userId, { now: clock.now })).count;
    expect(count).toBeGreaterThan(0);
    expect(await badged.notify({ userId: alex.userId, body: { key: "notify.reply" }, route: link("m1"), collapseId: "message-m1" })).toBe("sent");
    expect(JSON.parse(transport.requests[0]!.body).aps.badge).toBe(count);
    await apns.withdraw(alex.userId, "approval-a1");
    expect(JSON.parse(transport.requests[1]!.body)).toEqual({ aps: { "content-available": 1 }, withdraw: ["approval-a1"] });
    await badged.stop();
    // ntfy / Bark (the fake is "ntfy") never get one
    expect(provider.sent.every((m) => m.badge === undefined)).toBe(true);
  });
});

describe("human check", () => {
  test("one push for a human check: the computer's own (duet://computer, the card's collapse id), not the alert card's too", async () => {
    // A chat turn that posted the open_browser alert: no trigger push for the card and no reply push at the end.
    scripts.set("[captcha]", async ({ sink }) => {
      await card(sink, { kind: "alert", payload: ALERT });
      await say(sink, "I'll wait for you there.");
      return ok();
    });
    expect(await pushed(() => send("[captcha] buy it"))).toEqual({ sent: [], events: [] });
    // The real computer path: humanCheck posts the card and notifies once.
    const rig = await computerRig();
    const push = new FakeProvider();
    const real = new Notifier({ db: rig.fixture.db, events: rig.fixture.events, provider: push, followUps: false, unread: false });
    real.start();
    try {
      rig.llm.script("chat", [call("computer_navigate", { url: "https://shop.captcha.test/" })]);
      await rig.send(rig.alex, "Buy it");
      await rig.fixture.runs.idle();
      for (const input of rig.notified) await real.notify(input);
      await real.idle();
      const alert = await rig.fixture.db.message.findFirstOrThrow({ where: { userId: rig.alex.userId, kind: "alert" } });
      expect(push.sent.map((m) => [m.route, m.collapseId])).toEqual([["duet://computer", `message-${alert.id}`]]);
    } finally {
      await real.stop();
      await rig.cleanup();
    }
  });
});

describe("Make", () => {
  test("a build the user asked for pushes ready / failed; a scheduled refresh pushes only a failure, quiet", async () => {
    const notified: NotifyInput[] = [];
    const m = await startMake({ notify: async (input) => { notified.push(input); return "sent"; } });
    try {
      const create = async (prompt: string) => {
        const res = await m.fixture.app.request("/api/artifacts", json(m.alex, "POST", { type: "web_page", prompt, channelId: m.alex.mainChannelId }));
        const id = ArtifactResponse.parse(await res.json()).artifact.id;
        await m.runs.idle();
        return id;
      };
      m.llm.script("task", buildTurn(m, { title: "Bike shop" }));
      const ready = await create("A page for my bike shop");
      expect(notified).toEqual([{
        userId: m.alex.userId, channelId: m.alex.mainChannelId, body: { key: "notify.artifact_ready", params: { title: { type: "text", value: "Bike shop" } } },
        route: `duet://artifacts/${ready}`, collapseId: `artifact-${ready}`, quiet: false,
      }]);

      m.llm.script("task", [{ type: "text_delta", text: "I couldn't." }]);
      const broken = await create("Tune-up price list");
      const title = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: broken } })).title;
      expect(notified.slice(1)).toEqual([{
        userId: m.alex.userId, channelId: m.alex.mainChannelId, body: { key: "notify.artifact_failed", params: { title: { type: "text", value: title } } },
        route: `duet://artifacts/${broken}`, collapseId: `artifact-${broken}`, quiet: false,
      }]);

      m.llm.script("task", buildTurn(m, { html: PAGE.replace("Open 9 to 6.", "Open 8 to 6.") }));
      await m.artifacts.service.refresh(m.alex.userId, ready, "schedule");
      await m.runs.idle();
      expect(notified).toHaveLength(2);
      m.llm.script("task", [{ type: "text_delta", text: "No access." }]);
      await m.artifacts.service.refresh(m.alex.userId, ready, "schedule");
      await m.runs.idle();
      expect(notified.slice(2).map((n) => [n.body, n.quiet])).toEqual([[{ key: "notify.artifact_failed", params: { title: { type: "text", value: "Bike shop" } } }, true]]);
    } finally {
      await m.fixture.cleanup();
    }
  });
});
