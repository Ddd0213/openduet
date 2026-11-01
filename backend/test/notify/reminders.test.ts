// Reminder delivery: due reminders post Claude's text in their channel and notify, exactly once,
// also after a restart; future and fired ones wait.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { NotifyInput, NotifyResult, NotifySink } from "../../src/notify/notifier.ts";
import { ReminderService } from "../../src/notify/reminders.ts";
import { MessagePage } from "../../src/contract/messages.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";

let fixture: TestApp;
let alex: SignedIn;
let channelId: string;
const now = new Date("2026-10-25T09:00:00.000Z");

class Sink implements NotifySink {
  readonly calls: NotifyInput[] = [];
  async notify(input: NotifyInput): Promise<NotifyResult> {
    this.calls.push(input);
    return "local_only";
  }
}

beforeAll(async () => {
  fixture = await createTestApp();
  alex = await signUp(fixture, "alex");
  channelId = (await fixture.db.channel.create({ data: { userId: alex.userId, name: "Travel", icon: "plane", colorHex: "#5D927A" } })).id;
});
afterAll(() => fixture.cleanup());

const service = (sink: NotifySink) => new ReminderService({ db: fixture.db, events: fixture.events, notifier: sink, now: () => now });
const thread = async () => MessagePage.parse(await (await fixture.app.request(`/api/channels/${channelId}/messages`, { headers: alex.headers })).json()).messages;

describe("reminders", () => {
  test("a due reminder posts the model's text and notifies once; future and fired ones wait", async () => {
    const due = await fixture.db.reminder.create({ data: { userId: alex.userId, channelId, at: new Date(now.getTime() - 60_000), text: "Time to book the flight to Lisbon." } });
    const future = await fixture.db.reminder.create({ data: { userId: alex.userId, channelId, at: new Date(now.getTime() + 60_000), text: "later" } });
    await fixture.db.reminder.create({ data: { userId: alex.userId, channelId, at: new Date(now.getTime() - 120_000), text: "old", firedAt: new Date(now.getTime() - 100_000) } });
    const sink = new Sink();
    const reminders = service(sink);
    expect(await reminders.tick()).toBe(1);
    expect(await reminders.tick()).toBe(0);
    const messages = await thread();
    const posted = messages.filter((m) => m.text === "Time to book the flight to Lisbon.");
    expect(posted).toEqual([expect.objectContaining({ role: "assistant", kind: "text" })]);
    // M21: the deep link opens the reminder's own line; one collapse id per message.
    expect(sink.calls).toEqual([{
      userId: alex.userId, channelId, body: { text: "Time to book the flight to Lisbon." },
      route: `duet://channels/${channelId}?message=${posted[0]!.id}`, collapseId: `message-${posted[0]!.id}`,
    }]);
    expect((await fixture.db.reminder.findUniqueOrThrow({ where: { id: due.id } })).firedAt?.toISOString()).toBe(now.toISOString());
    expect((await fixture.db.reminder.findUniqueOrThrow({ where: { id: future.id } })).firedAt).toBeNull();
  });

  test("two services racing (or a restart) never fire the same reminder twice", async () => {
    await fixture.db.reminder.create({ data: { userId: alex.userId, channelId, at: new Date(now.getTime() - 5_000), text: "Call Sam." } });
    const sink = new Sink();
    const [a, b] = await Promise.all([service(sink).tick(), service(sink).tick()]);
    expect(a + b).toBe(1);
    expect(sink.calls.map((c) => c.body)).toEqual([{ text: "Call Sam." }]);
    expect((await thread()).filter((m) => m.text === "Call Sam.")).toHaveLength(1);
  });

  test("start() catches up overdue reminders right away; stop() waits for the pass", async () => {
    await fixture.db.reminder.create({ data: { userId: alex.userId, channelId, at: new Date(now.getTime() - 3_600_000), text: "Missed while the server was down." } });
    const sink = new Sink();
    const reminders = service(sink);
    reminders.start();
    await reminders.stop();
    expect(sink.calls.map((c) => c.body)).toEqual([{ text: "Missed while the server was down." }]);
  });

  test("a reminder whose channel is gone is claimed and skipped", async () => {
    const orphan = await fixture.db.reminder.create({ data: { userId: alex.userId, channelId: "gone-channel", at: new Date(now.getTime() - 1_000), text: "x" } });
    const sink = new Sink();
    expect(await service(sink).tick()).toBe(0);
    expect(sink.calls).toHaveLength(0);
    expect((await fixture.db.reminder.findUniqueOrThrow({ where: { id: orphan.id } })).firedAt).not.toBeNull();
  });
});
