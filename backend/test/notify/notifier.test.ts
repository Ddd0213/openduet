// Notifier (L78): the notification event always, a remote push only without a live stream, and
// which stored events trigger one (task ready / needs input, new approval, alert card).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Approval } from "../../src/contract/approvals.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { TaskSummary } from "../../src/contract/tasks.ts";
import { Notifier } from "../../src/notify/notifier.ts";
import { renderPhrase } from "../../src/notify/phrases.ts";
import type { PushProvider } from "../../src/notify/providers/types.ts";
import { tapChannel } from "../../src/runs/stream.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { FakeProvider, WithdrawingProvider } from "./fakes.ts";

let fixture: TestApp;
let alex: SignedIn;
let mei: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp();
  alex = await signUp(fixture, "alex");
  mei = await signUp(fixture, "mei", "Mei Chen");
  await fixture.db.user.update({ where: { id: mei.userId }, data: { language: "zh-Hans", timezone: "Asia/Shanghai" } });
});
afterAll(() => fixture.cleanup());

const iso = () => new Date().toISOString();
const task = (status: TaskSummary["status"], over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: "task-1", channelId: alex.mainChannelId, title: "Launch review prep", status, source: "user", latestUpdate: null,
  updateCount: 0, schedule: null, archived: false, pinned: false, routine: null, nextStep: null, failure: null, resolvedAt: null, app: null, createdAt: iso(), updatedAt: iso(), ...over,
});
const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "approval-1", kind: "email", status: "pending", version: 1,
  preview: { kind: "email", app: "Gmail", to: ["sam@example.com"], cc: [], subject: "Launch notes", body: "Hi Sam", attachments: [] },
  expiresAt: null, taskId: null, messageId: null, result: null, changedFields: [], why: null, always: null, updatedAt: iso(), ...over,
});

/** A started Notifier on the shared bus; always stopped so notifiers never pile up. */
async function withNotifier(provider: PushProvider | null, run: (notifier: Notifier) => Promise<void>) {
  const notifier = new Notifier({ db: fixture.db, events: fixture.events, provider });
  notifier.start();
  try {
    await run(notifier);
  } finally {
    await notifier.stop();
  }
}
const notificationEvents = (userId: string) => fixture.db.event.findMany({ where: { userId, type: "notification" }, orderBy: { id: "asc" } });

describe("notify()", () => {
  test("without a provider: only the notification event, titled OpenDuet", async () => {
    await withNotifier(null, async (notifier) => {
      const before = (await notificationEvents(alex.userId)).length;
      const result = await notifier.notify({ userId: alex.userId, channelId: alex.mainChannelId, body: { text: "Call Sam back" }, route: `duet://channels/${alex.mainChannelId}` });
      expect(result).toBe("local_only");
      const rows = await notificationEvents(alex.userId);
      expect(rows).toHaveLength(before + 1);
      expect(JSON.parse(rows.at(-1)!.payload)).toEqual({ title: { key: "notify.title" }, body: { text: "Call Sam back" }, route: `duet://channels/${alex.mainChannelId}`, collapseId: null, passive: false });
      expect(rows.at(-1)!.channelId).toBe(alex.mainChannelId);
    });
  });

  test("no live stream: the remote push carries rendered text, the teaser and the route", async () => {
    const provider = new FakeProvider();
    await withNotifier(provider, async (notifier) => {
      expect(await notifier.notify({ userId: alex.userId, body: { text: "Call Sam back" }, route: "duet://tasks/t1" })).toBe("sent");
    });
    expect(provider.sent).toEqual([{ userId: alex.userId, title: "OpenDuet", body: "Call Sam back", teaser: "Launch OpenDuet to see it.", route: "duet://tasks/t1", channelId: null }]);
    expect(provider.closed).toBe(true);
  });

  test("a live GET /api/events stream gets the event and no remote push goes out", async () => {
    const provider = new FakeProvider();
    const seen: DuetEvent[] = [];
    const unsubscribe = fixture.events.subscribe(alex.userId, (e) => seen.push(e));
    const response = await fixture.app.request("/api/events", { headers: alex.headers });
    expect(response.status).toBe(200);
    expect(fixture.events.onlineCount(alex.userId)).toBe(1);
    await withNotifier(provider, async (notifier) => {
      expect(await notifier.notify({ userId: alex.userId, body: { text: "hi" }, route: "duet://tasks/t1" })).toBe("app_connected");
    });
    await response.body!.cancel();
    unsubscribe();
    expect(fixture.events.onlineCount(alex.userId)).toBe(0);
    expect(provider.sent).toHaveLength(0);
    expect(seen.map((e) => e.type)).toEqual(["notification"]);
  });

  test("M21: only GET /api/events counts as online; a POST answer stream left open doesn't swallow the push", async () => {
    const provider = new FakeProvider();
    // What runs/stream.ts does for POST /messages: a plain subscriber that never calls present().
    const tap = tapChannel(fixture.events, alex.userId, alex.mainChannelId);
    expect(fixture.events.subscriberCount(alex.userId)).toBe(1);
    expect(fixture.events.onlineCount(alex.userId)).toBe(0);
    await withNotifier(provider, async (notifier) => {
      expect(await notifier.notify({ userId: alex.userId, body: { text: "Approve the email?" }, route: "duet://tasks/t1" })).toBe("sent");
      // Once the app's GET stream is open again, it is online; closing it makes pushes go out again.
      const response = await fixture.app.request("/api/events", { headers: alex.headers });
      expect(await notifier.notify({ userId: alex.userId, body: { text: "x" }, route: "duet://tasks/t1" })).toBe("app_connected");
      await response.body!.cancel();
      expect(await notifier.notify({ userId: alex.userId, body: { text: "y" }, route: "duet://tasks/t1" })).toBe("sent");
    });
    tap.stop();
    expect(provider.sent.map((m) => m.body)).toEqual(["Approve the email?", "y"]);
  });

  test("renders keys in the user's language", async () => {
    const provider = new FakeProvider();
    await withNotifier(provider, async (notifier) => {
      await notifier.notify({ userId: mei.userId, body: { key: "notify.task_ready", params: { title: { type: "text", value: "发布评审" } } }, route: "duet://tasks/t1" });
    });
    expect(provider.sent[0]).toMatchObject({ title: "OpenDuet", body: "「发布评审」待你审阅。", teaser: "打开 OpenDuet 查看。" });
  });

  test("never throws: a bad route or a failing provider is just 'failed'", async () => {
    await withNotifier(new FakeProvider(new Error("boom")), async (notifier) => {
      expect(await notifier.notify({ userId: alex.userId, body: { text: "x" }, route: "https://example.com" })).toBe("failed");
      expect(await notifier.notify({ userId: alex.userId, body: { text: "x" }, route: "duet://tasks/t1" })).toBe("failed");
    });
  });
});

describe("event triggers", () => {
  /** A real Task row (M21: the push dedup is Task.lastNotifiedStatus); its status follows each event. */
  const taskRow = (title = "Launch review prep") => fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title, status: "working" } });
  const moveTo = async (notifier: Notifier, id: string, status: TaskSummary["status"]) => {
    const row = await fixture.db.task.update({ where: { id }, data: { status } });
    await fixture.events.emit(alex.userId, alex.mainChannelId, "task", { task: task(status, { id, title: row.title }) });
    await notifier.idle();
  };

  test("a task notifies once per change into Ready for review / Needs input", async () => {
    const provider = new FakeProvider();
    const row = await taskRow();
    await withNotifier(provider, async (notifier) => {
      for (const status of ["working", "ready_for_review", "ready_for_review", "needs_input", "needs_input", "working", "ready_for_review"] as const) {
        await moveTo(notifier, row.id, status);
      }
      await moveTo(notifier, row.id, "resolved");
    });
    expect(provider.sent.map((m) => m.body)).toEqual(["Launch review prep is ready for review.", "Launch review prep needs your input.", "Launch review prep is ready for review."]);
    expect(provider.sent.every((m) => m.route === `duet://tasks/${row.id}` && m.channelId === alex.mainChannelId && m.collapseId === `task-${row.id}`)).toBe(true);
  });

  test("M21: after a restart a task that still needs input isn't pushed again (Task.lastNotifiedStatus); leaving and coming back pushes", async () => {
    const provider = new FakeProvider();
    const row = await taskRow("Visa form");
    await withNotifier(provider, (notifier) => moveTo(notifier, row.id, "needs_input"));
    expect((await fixture.db.task.findUniqueOrThrow({ where: { id: row.id } })).lastNotifiedStatus).toBe("needs_input");
    // A new process: nothing in memory. The task is re-emitted (pinned, renamed): no second push.
    await withNotifier(provider, async (notifier) => {
      await fixture.events.emit(alex.userId, alex.mainChannelId, "task", { task: task("needs_input", { id: row.id, title: "Visa form", pinned: true }) });
      await notifier.idle();
    });
    expect(provider.sent.map((m) => m.body)).toEqual(["Visa form needs your input."]);
    // Back to work, then needing input again: that is a new transition.
    await withNotifier(provider, async (notifier) => {
      await moveTo(notifier, row.id, "working");
      expect((await fixture.db.task.findUniqueOrThrow({ where: { id: row.id } })).lastNotifiedStatus).toBeNull();
      await moveTo(notifier, row.id, "needs_input");
    });
    expect(provider.sent.map((m) => m.body)).toEqual(["Visa form needs your input.", "Visa form needs your input."]);
  });

  test("M21: a stale task event (the row moved on) neither pushes nor clears the newer claim", async () => {
    const provider = new FakeProvider();
    const row = await taskRow("Expense report");
    await withNotifier(provider, async (notifier) => {
      await moveTo(notifier, row.id, "needs_input");
      // a late "working" event while the row is still needs_input
      await fixture.events.emit(alex.userId, alex.mainChannelId, "task", { task: task("working", { id: row.id }) });
      // a late "ready_for_review" event while the row is needs_input
      await fixture.events.emit(alex.userId, alex.mainChannelId, "task", { task: task("ready_for_review", { id: row.id }) });
      await notifier.idle();
    });
    expect(provider.sent.map((m) => m.body)).toEqual(["Expense report needs your input."]);
    expect((await fixture.db.task.findUniqueOrThrow({ where: { id: row.id } })).lastNotifiedStatus).toBe("needs_input");
  });

  test("a new pending approval notifies once; edits and decisions don't", async () => {
    const provider = new FakeProvider();
    await withNotifier(provider, async (notifier) => {
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval() });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval() });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ version: 2 }) });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ id: "approval-2", status: "approved" }) });
      await fixture.events.emit(alex.userId, null, "approval", { approval: approval({ id: "approval-3", taskId: "task-9", preview: { kind: "action", app: "Google Calendar", toolName: "", rows: [], browser: null } }) });
      await notifier.idle();
    });
    expect(provider.sent.map((m) => [m.body, m.route]).sort()).toEqual([
      ["Something is waiting for your approval.", "duet://tasks/task-9"],
      ["Waiting for your approval: Launch notes", `duet://channels/${alex.mainChannelId}`],
    ]);
  });

  test("Claude's alert card notifies with its body; other messages don't", async () => {
    const provider = new FakeProvider();
    const base = { channelId: alex.mainChannelId, taskId: null, text: "", status: "sent" as const, clientId: null, reactions: [], stopped: false, callId: null, createdAt: iso(), updatedAt: iso() };
    const alert = { ...base, id: "msg-alert", role: "assistant" as const, kind: "alert" as const, payload: { title: { key: "alert.one_thing" }, body: { text: "Northfield wants a call today." }, action: { label: { key: "alert.open_browser" }, type: "open_url" as const, url: null, toolkit: null } } };
    await withNotifier(provider, async (notifier) => {
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: alert });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: alert });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: { ...base, id: "msg-text", role: "assistant", kind: "text", text: "hi", payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null } } });
      await notifier.idle();
    });
    // M21: the deep link carries the card's message id; one collapse id per message.
    expect(provider.sent.map((m) => [m.body, m.route, m.collapseId])).toEqual([["Northfield wants a call today.", `duet://channels/${alex.mainChannelId}?message=msg-alert`, "message-msg-alert"]]);
  });

  test("M18: a resolved task's result notifies once and opens its chat; ready_for_review results and old texts don't", async () => {
    const provider = new FakeProvider();
    const base = { channelId: alex.mainChannelId, taskId: null, text: "Prices compared.", status: "sent" as const, clientId: null, reactions: [], stopped: false, callId: null, createdAt: iso(), updatedAt: iso(), role: "assistant" as const, kind: "text" as const };
    const payload = (status: "resolved" | "ready_for_review") => ({ skill: null, attachments: [], replyTo: null, forwarded: null, taskResult: { taskId: "task-1", title: "Price watch", status, sourceCount: 2 } });
    await withNotifier(provider, async (notifier) => {
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: { ...base, id: "msg-result", payload: payload("resolved") } });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: { ...base, id: "msg-result", payload: payload("resolved") } });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: { ...base, id: "msg-review", payload: payload("ready_for_review") } });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: { ...base, id: "msg-user", role: "user", payload: payload("resolved") } });
      // an old result re-emitted (a reaction, after a restart emptied the dedup set): no push
      await fixture.events.emit(alex.userId, alex.mainChannelId, "message", { message: { ...base, id: "msg-old", createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), payload: payload("resolved") } });
      await notifier.idle();
    });
    expect(provider.sent.map((m) => [m.body, m.route])).toEqual([["Price watch is done.", `duet://channels/${alex.mainChannelId}?message=msg-result`]]);
  });

  test("after stop() events no longer notify", async () => {
    const provider = new FakeProvider();
    const notifier = new Notifier({ db: fixture.db, events: fixture.events, provider });
    notifier.start();
    await notifier.stop();
    await fixture.events.emit(alex.userId, alex.mainChannelId, "task", { task: task("needs_input", { id: "task-after-stop" }) });
    await notifier.idle();
    expect(provider.sent).toHaveLength(0);
  });
});

describe("M21 push hygiene", () => {
  /** Alex: UTC, default quiet hours 22:30-08:30. */
  const at = (iso: string) => () => new Date(iso);
  const started = async (provider: PushProvider, now: () => Date, run: (notifier: Notifier) => Promise<void>) => {
    const notifier = new Notifier({ db: fixture.db, events: fixture.events, provider, now, followUps: false, unread: false });
    notifier.start();
    try {
      await run(notifier);
    } finally {
      await notifier.stop();
    }
  };

  test("quiet hours make task pushes passive; approvals (no `quiet`) and daytime pushes stay normal; the collapse id goes along", async () => {
    const provider = new FakeProvider();
    await started(provider, at("2026-10-28T23:10:00.000Z"), async (notifier) => {
      await notifier.notify({ userId: alex.userId, body: { text: "night task" }, route: "duet://tasks/t1", collapseId: "task-t1", quiet: true });
      await notifier.notify({ userId: alex.userId, body: { text: "night approval" }, route: "duet://tasks/t1", collapseId: "approval-a1" });
    });
    await started(provider, at("2026-10-28T12:00:00.000Z"), async (notifier) => {
      await notifier.notify({ userId: alex.userId, body: { text: "day task" }, route: "duet://tasks/t1", collapseId: "task-t1", quiet: true });
    });
    expect(provider.sent.map((m) => [m.body, m.collapseId, m.passive ?? false])).toEqual([
      ["night task", "task-t1", true],
      ["night approval", "approval-a1", false],
      ["day task", "task-t1", false],
    ]);
  });

  test("a decided approval withdraws its push (also when the decision lands while the push is still in flight); one never pushed isn't withdrawn", async () => {
    const provider = new WithdrawingProvider();
    await started(provider, at("2026-10-28T12:00:00.000Z"), async (notifier) => {
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ id: "ap-w1", taskId: "task-w", messageId: "msg-card" }) });
      await notifier.idle();
      expect(provider.sent.map((m) => [m.route, m.collapseId])).toEqual([["duet://tasks/task-w?message=msg-card", "approval-ap-w1"]]);
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ id: "ap-w1", taskId: "task-w", status: "approved", version: 2 }) });
      await notifier.idle();
      expect(provider.withdrawn).toEqual([{ userId: alex.userId, collapseId: "approval-ap-w1" }]);

      // Decided before the push finished: withdrawn as soon as it lands.
      let release!: () => void;
      provider.hold = new Promise<void>((resolve) => { release = resolve; });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ id: "ap-w2" }) });
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ id: "ap-w2", status: "declined", version: 2 }) });
      release();
      await notifier.idle();
      provider.hold = null;
      expect(provider.withdrawn.map((w) => w.collapseId)).toEqual(["approval-ap-w1", "approval-ap-w2"]);

      // Never pushed (e.g. created before this process): nothing to withdraw.
      await fixture.events.emit(alex.userId, alex.mainChannelId, "approval", { approval: approval({ id: "ap-w3", status: "approved", version: 2 }) });
      await notifier.idle();
      expect(provider.withdrawn).toHaveLength(2);
    });
  });
});

describe("renderPhrase", () => {
  test("model text stays as written; unknown keys fall back to the key", () => {
    expect(renderPhrase({ text: "As written" }, "zh-Hans", "UTC")).toBe("As written");
    expect(renderPhrase({ key: "notify.title" }, "zh-Hans", "UTC")).toBe("OpenDuet");
    expect(renderPhrase({ key: "no.such_key" }, "en", "UTC")).toBe("no.such_key");
    expect(renderPhrase({ key: "system.reminder_set", params: { at: { type: "datetime", value: "2026-10-26T10:00:00.000Z" } } }, "en", "UTC")).toContain("OpenDuet set a reminder for Oct 26, 2026");
  });
});
