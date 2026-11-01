// M21 follow-ups: a "needs you" item still waiting FOLLOW_UP_MS (2 h) after its push is reminded once
// more (same text, same collapse id), once across restarts for tasks (Task.lastNotifiedStatus);
// quiet hours hold a task's follow-up until they end, an approval's goes out anyway.
import { afterEach, describe, expect, test } from "bun:test";
import { FollowUps, FOLLOW_UP_MS } from "../../src/notify/follow-ups.ts";
import { Notifier, type NotifyInput, type NotifyResult } from "../../src/notify/notifier.ts";
import { NotificationTriggers } from "../../src/notify/triggers.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { FakeProvider } from "./fakes.ts";

let fixture: TestApp | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

/** Alex is UTC with the default quiet hours 22:30-08:30; noon is outside them. */
const NOON = new Date("2026-10-28T12:00:00.000Z");
const ago = (from: Date, ms: number) => new Date(from.getTime() - ms);
const preview = JSON.stringify({ kind: "email", app: "Gmail", to: ["sam@example.com"], cc: [], subject: "Launch notes", body: "Hi", attachments: [] });

async function setup(): Promise<{ app: TestApp; alex: SignedIn; calls: NotifyInput[]; sink: (input: NotifyInput) => Promise<NotifyResult> }> {
  fixture = await createTestApp();
  const alex = await signUp(fixture, "alex");
  const calls: NotifyInput[] = [];
  return { app: fixture, alex, calls, sink: async (input) => { calls.push(input); return "sent"; } };
}

const waitingTask = (app: TestApp, alex: SignedIn, over: { title: string; status?: string; lastNotifiedStatus?: string | null; updatedAt: Date }) =>
  app.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, status: "needs_input", lastNotifiedStatus: "needs_input", ...over } });

describe("follow-ups", () => {
  test("a task still waiting after 2 h is reminded once (same text and collapse id); newer, never pushed or already reminded ones aren't", async () => {
    const { app, alex, calls, sink } = await setup();
    let now = NOON;
    const followUps = new FollowUps({ db: app.db, notify: sink, now: () => now, since: ago(NOON, 24 * 60 * 60 * 1000) });
    const due = await waitingTask(app, alex, { title: "Visa form", updatedAt: ago(NOON, FOLLOW_UP_MS + 60_000) });
    const review = await waitingTask(app, alex, { title: "Deck", status: "ready_for_review", lastNotifiedStatus: "ready_for_review", updatedAt: ago(NOON, 3 * 60 * 60 * 1000) });
    await waitingTask(app, alex, { title: "Too new", updatedAt: ago(NOON, FOLLOW_UP_MS - 60_000) });
    await waitingTask(app, alex, { title: "Never pushed", lastNotifiedStatus: null, updatedAt: ago(NOON, 5 * 60 * 60 * 1000) });
    await waitingTask(app, alex, { title: "Already reminded", lastNotifiedStatus: "needs_input:reminded", updatedAt: ago(NOON, 5 * 60 * 60 * 1000) });

    expect(await followUps.sweep()).toBe(2);
    expect(calls.map((c) => [c.body, c.route, c.collapseId])).toEqual([
      [{ key: "notify.task_ready", params: { title: { type: "text", value: "Deck" } } }, `duet://tasks/${review.id}`, `task-${review.id}`],
      [{ key: "notify.task_needs_input", params: { title: { type: "text", value: "Visa form" } } }, `duet://tasks/${due.id}`, `task-${due.id}`],
    ]);
    // Once: a later pass, or a new process, sends nothing more for them.
    expect(await followUps.sweep()).toBe(0);
    expect(await new FollowUps({ db: app.db, notify: sink, now: () => now }).sweep()).toBe(0);
    // An hour later only "Too new" has waited 2 h.
    now = new Date(NOON.getTime() + 60 * 60 * 1000);
    expect(await followUps.sweep()).toBe(1);
    expect(calls.at(-1)?.body).toEqual({ key: "notify.task_needs_input", params: { title: { type: "text", value: "Too new" } } });
    expect(await followUps.sweep()).toBe(0);
    const row = await app.db.task.findUniqueOrThrow({ where: { id: due.id } });
    expect(row.lastNotifiedStatus).toBe("needs_input:reminded");
    // The bookkeeping write doesn't move the task in the list.
    expect(row.updatedAt.toISOString()).toBe(ago(NOON, FOLLOW_UP_MS + 60_000).toISOString());
  });

  test("a reminded task re-emitted doesn't push again; leaving needs input and coming back is a new push", async () => {
    const { app, alex } = await setup();
    const row = await waitingTask(app, alex, { title: "Visa form", lastNotifiedStatus: "needs_input:reminded", updatedAt: ago(NOON, 3 * 60 * 60 * 1000) });
    const triggers = new NotificationTriggers(app.db);
    const summary = (status: "needs_input" | "working") => ({
      id: row.id, channelId: alex.mainChannelId, title: "Visa form", status, source: "user" as const, latestUpdate: null, updateCount: 0,
      schedule: null, archived: false, pinned: false, routine: null, nextStep: null, failure: null, resolvedAt: null, app: null, createdAt: NOON.toISOString(), updatedAt: NOON.toISOString(),
    });
    const event = (status: "needs_input" | "working") => ({ id: 1, type: "task" as const, channelId: alex.mainChannelId, createdAt: NOON.toISOString(), payload: { task: summary(status) } });
    expect(await triggers.fromEvent(alex.userId, event("needs_input"))).toBeNull();
    await app.db.task.update({ where: { id: row.id }, data: { status: "working" } });
    expect(await triggers.fromEvent(alex.userId, event("working"))).toBeNull();
    await app.db.task.update({ where: { id: row.id }, data: { status: "needs_input" } });
    expect(await triggers.fromEvent(alex.userId, event("needs_input"))).toMatchObject({ collapseId: `task-${row.id}`, quiet: true });
  });

  test("quiet hours hold a task's follow-up until they end; a pending approval's goes out anyway", async () => {
    const { app, alex, calls, sink } = await setup();
    let now = new Date("2026-10-28T23:30:00.000Z"); // inside 22:30-08:30
    const followUps = new FollowUps({ db: app.db, notify: sink, now: () => now, since: ago(now, 24 * 60 * 60 * 1000) });
    const task = await waitingTask(app, alex, { title: "Visa form", updatedAt: ago(now, 150 * 60 * 1000) });
    const message = await app.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "assistant", kind: "text", text: "card" } });
    const approval = await app.db.approval.create({ data: { userId: alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", preview, messageId: message.id, createdAt: ago(now, 150 * 60 * 1000) } });

    expect(await followUps.sweep()).toBe(1);
    expect(calls).toEqual([{
      userId: alex.userId, channelId: alex.mainChannelId, body: { key: "notify.approval", params: { title: { type: "text", value: "Launch notes" } } },
      route: `duet://channels/${alex.mainChannelId}?message=${message.id}`, collapseId: `approval-${approval.id}`,
    }]);
    now = new Date("2026-10-29T08:35:00.000Z"); // quiet hours are over
    expect(await followUps.sweep()).toBe(1);
    expect(calls.at(-1)).toMatchObject({ route: `duet://tasks/${task.id}`, collapseId: `task-${task.id}` });
    expect(await followUps.sweep()).toBe(0);
  });

  test("approvals: pending ones created after the process started, once; decided, expired or older ones aren't", async () => {
    const { app, alex, calls, sink } = await setup();
    const since = ago(NOON, 4 * 60 * 60 * 1000);
    const followUps = new FollowUps({ db: app.db, notify: sink, now: () => NOON, since });
    const make = (over: Record<string, unknown>) => app.db.approval.create({ data: { userId: alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", preview, createdAt: ago(NOON, 3 * 60 * 60 * 1000), ...over } });
    const task = await waitingTask(app, alex, { title: "Send it", status: "working", lastNotifiedStatus: null, updatedAt: NOON });
    const pending = await make({});
    const inTask = await make({ taskId: task.id, messageId: "msg-card" });
    await make({ status: "approved" });
    await make({ expiresAt: ago(NOON, 60_000) });
    await make({ createdAt: ago(since, 60_000) }); // before this process started
    await make({ createdAt: ago(NOON, 60 * 60 * 1000) }); // not due yet

    expect(await followUps.sweep()).toBe(2);
    expect(calls.map((c) => [c.collapseId, c.route])).toEqual([
      [`approval-${pending.id}`, `duet://channels/${alex.mainChannelId}`],
      [`approval-${inTask.id}`, `duet://tasks/${task.id}?message=msg-card`],
    ]);
    expect(calls.every((c) => c.quiet === undefined)).toBe(true);
    expect(await followUps.sweep()).toBe(0);
  });

  test("more than a batch of old undecided cards doesn't hide a newer one's follow-up (the walk moves forward)", async () => {
    const { app, alex, calls, sink } = await setup();
    const since = ago(NOON, 24 * 60 * 60 * 1000);
    const followUps = new FollowUps({ db: app.db, notify: sink, now: () => NOON, since });
    // 100 cards from early on that nobody decides (no expiresAt), then a newer one, all due.
    const base = ago(NOON, 20 * 60 * 60 * 1000).getTime();
    for (let i = 0; i < 100; i++) {
      await app.db.approval.create({ data: { userId: alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", preview, createdAt: new Date(base + i * 1000) } });
    }
    const newer = await app.db.approval.create({ data: { userId: alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", preview, createdAt: ago(NOON, 3 * 60 * 60 * 1000) } });
    expect(await followUps.sweep()).toBe(100);
    expect(await followUps.sweep()).toBe(1);
    expect(calls.at(-1)?.collapseId).toBe(`approval-${newer.id}`);
    expect(await followUps.sweep()).toBe(0);
  });

  test("the Notifier runs them: the follow-up is a real push with the task's collapse id", async () => {
    const { app, alex } = await setup();
    const provider = new FakeProvider();
    const notifier = new Notifier({ db: app.db, events: app.events, provider, now: () => NOON, unread: false });
    notifier.start();
    try {
      const task = await waitingTask(app, alex, { title: "Visa form", updatedAt: ago(NOON, 3 * 60 * 60 * 1000) });
      expect(await notifier.sweepFollowUps()).toBe(1);
      expect(provider.sent).toEqual([expect.objectContaining({ body: "Visa form needs your input.", route: `duet://tasks/${task.id}`, collapseId: `task-${task.id}` })]);
    } finally {
      await notifier.stop();
    }
  });
});
