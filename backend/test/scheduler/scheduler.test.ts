// The scheduler (L75) on a real test database with a fake slot runner that claims like the real
// one (it creates the Run with scheduledFor, so a second claim hits the unique key).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../src/db.ts";
import { Scheduler, type ScheduledKind, type SlotRunner } from "../../src/scheduler/index.ts";
import { createTestDatabase } from "../helpers/db.ts";

class FakeRunner implements SlotRunner {
  calls: { userId: string; kind: ScheduledKind; scheduledFor: string }[] = [];
  constructor(private readonly db: Db) {}
  async runScheduled(input: { userId: string; kind: ScheduledKind; scheduledFor: Date }): Promise<boolean> {
    await this.db.run.create({ data: { userId: input.userId, kind: input.kind, scheduledFor: input.scheduledFor, status: "completed", startedAt: new Date() } });
    this.calls.push({ ...input, scheduledFor: input.scheduledFor.toISOString() });
    return true;
  }
  of(userId: string) { return this.calls.filter((c) => c.userId === userId).map((c) => `${c.kind}@${c.scheduledFor}`); }
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
const users: string[] = [];
const at = (s: string) => new Date(s);

async function makeUser(over: { timezone?: string; briefTime?: string; checkinMinute?: number; weekendsOn?: boolean; onboardedAt: Date | null }) {
  const id = crypto.randomUUID();
  await db.user.create({ data: {
    id, name: "Alex Kim", firstName: "Alex", username: id, authEmail: `${id}@test.invalid`,
    timezone: over.timezone ?? "UTC", briefTime: over.briefTime ?? "08:19", checkinMinute: over.checkinMinute ?? 49,
    weekendsOn: over.weekendsOn ?? false, onboardedAt: over.onboardedAt,
  } });
  users.push(id);
  return id;
}

const runsOf = async (userId: string) =>
  (await db.run.findMany({ where: { userId }, orderBy: { scheduledFor: "asc" } })).map((r) => `${r.kind}@${r.scheduledFor?.toISOString() ?? "null"}:${r.status}`);

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
});
// Each test's users stop being scheduled once it ends, so a later tick never touches them.
afterEach(async () => {
  await db.user.updateMany({ where: { id: { in: users } }, data: { onboardedAt: null } });
});
afterAll(async () => {
  await database.cleanup();
});

describe("scheduler", () => {
  test("< 2 h late runs once, >= 2 h late is logged skipped, a second tick adds nothing", async () => {
    // Friday 2030-10-25; onboarded the evening before.
    const userId = await makeUser({ onboardedAt: at("2030-10-24T20:00:00Z") });
    const runner = new FakeRunner(db);
    const scheduler = new Scheduler({ db, runner });
    const first = await scheduler.tick(at("2030-10-25T10:00:00Z"));
    expect(first).toEqual({ started: 1, skipped: 1 });
    // 08:19 brief is 1 h 41 min late -> runs; Thursday 22:49 check-in is > 11 h late -> skipped.
    expect(runner.of(userId)).toEqual(["brief@2030-10-25T08:19:00.000Z"]);
    expect(await runsOf(userId)).toEqual(["checkin@2030-10-24T22:49:00.000Z:skipped", "brief@2030-10-25T08:19:00.000Z:completed"]);

    expect(await scheduler.tick(at("2030-10-25T10:00:30Z"))).toEqual({ started: 0, skipped: 0 });
    // The next check-in, on time.
    expect(await scheduler.tick(at("2030-10-25T10:49:10Z"))).toEqual({ started: 1, skipped: 0 });
    expect(runner.of(userId)).toEqual(["brief@2030-10-25T08:19:00.000Z", "checkin@2030-10-25T10:49:00.000Z"]);
  });

  test("two schedulers (two processes) ticking at once claim each slot once", async () => {
    const userId = await makeUser({ onboardedAt: at("2030-10-25T07:00:00Z") });
    const a = new FakeRunner(db);
    const b = new FakeRunner(db);
    const one = new Scheduler({ db, runner: a });
    const two = new Scheduler({ db, runner: b });
    const now = at("2030-10-25T09:00:00Z");
    // A tick already in progress is joined, not run twice.
    const joined = one.tick(now);
    expect(one.tick(now)).toBe(joined);
    const reports = await Promise.all([joined, two.tick(now)]);
    expect(reports.reduce((n, r) => n + r.started, 0)).toBe(1);
    expect([...a.of(userId), ...b.of(userId)]).toEqual(["brief@2030-10-25T08:19:00.000Z"]);
    expect(await db.run.count({ where: { userId } })).toBe(1);
  });

  test("a long outage: only the last 24 h, nothing before onboarding, weekends only when on", async () => {
    // Monday 2030-10-28 12:00 after being down since Friday; weekdays only.
    const weekdays = await makeUser({ onboardedAt: at("2030-10-01T00:00:00Z") });
    const daily = await makeUser({ weekendsOn: true, onboardedAt: at("2030-10-27T09:00:00Z") });
    const runner = new FakeRunner(db);
    await new Scheduler({ db, runner }).tick(at("2030-10-28T12:00:00Z"));
    // Weekdays: the window is Sunday 12:00 -> Monday 12:00; Sunday has no slots, Monday 08:19 is
    // 3 h 41 min late (skipped) and Monday 10:49 is 1 h 11 min late (runs).
    expect(runner.of(weekdays)).toEqual(["checkin@2030-10-28T10:49:00.000Z"]);
    expect(await runsOf(weekdays)).toEqual(["brief@2030-10-28T08:19:00.000Z:skipped", "checkin@2030-10-28T10:49:00.000Z:completed"]);
    // Every day, but onboarded Sunday 09:00: Sunday 08:19 is before onboarding and never appears.
    expect((await runsOf(daily)).filter((r) => r.startsWith("brief@2030-10-27T08:19"))).toEqual([]);
    expect(await runsOf(daily)).toContain("checkin@2030-10-27T22:49:00.000Z:skipped");
    expect(await runsOf(daily)).toContain("checkin@2030-10-28T10:49:00.000Z:completed");
    // Not onboarded: never scheduled.
    const fresh = await makeUser({ onboardedAt: null });
    await new Scheduler({ db, runner }).tick(at("2030-10-28T12:00:00Z"));
    expect(await db.run.count({ where: { userId: fresh } })).toBe(0);
  });

  test("a slot a restart cancelled runs once more while < 2 h late; later it stays as history", async () => {
    const userId = await makeUser({ onboardedAt: at("2030-10-24T20:00:00Z") });
    // The previous process claimed both slots, then recoverStaleRuns cancelled them.
    await db.run.create({ data: { userId, kind: "brief", scheduledFor: at("2030-10-25T08:19:00Z"), status: "cancelled" } });
    await db.run.create({ data: { userId, kind: "checkin", scheduledFor: at("2030-10-24T22:49:00Z"), status: "cancelled" } });
    const runner = new FakeRunner(db);
    const scheduler = new Scheduler({ db, runner });
    await scheduler.tick(at("2030-10-25T09:00:00Z"));
    expect(runner.of(userId)).toEqual(["brief@2030-10-25T08:19:00.000Z"]);
    expect(await runsOf(userId)).toEqual([
      "brief@null:cancelled", // the interrupted run, kept as history (shown as skipped)
      "checkin@2030-10-24T22:49:00.000Z:cancelled", // too late to rerun: stays as it was
      "brief@2030-10-25T08:19:00.000Z:completed",
    ]);
    await scheduler.tick(at("2030-10-25T09:00:30Z"));
    expect(runner.of(userId)).toHaveLength(1);
  });

  test("a slot that had already started (then a restart cancelled it) never runs a second time", async () => {
    const userId = await makeUser({ onboardedAt: at("2030-10-24T20:00:00Z") });
    // The brief reached the model (startedAt set) and maybe posted and pushed before the restart.
    await db.run.create({ data: { userId, kind: "brief", scheduledFor: at("2030-10-25T08:19:00Z"), status: "cancelled", startedAt: at("2030-10-25T08:19:05Z") } });
    const runner = new FakeRunner(db);
    await new Scheduler({ db, runner }).tick(at("2030-10-25T09:00:00Z"));
    expect(runner.of(userId)).toEqual([]);
    expect((await runsOf(userId)).filter((r) => r.startsWith("brief"))).toEqual(["brief@2030-10-25T08:19:00.000Z:cancelled"]);
  });

  test("a schedule change only counts from when it is seen; start() ticks right away", async () => {
    const userId = await makeUser({ onboardedAt: at("2030-10-25T06:00:00Z") });
    const runner = new FakeRunner(db);
    let now = at("2030-10-25T07:00:00Z");
    const scheduler = new Scheduler({ db, runner, now: () => now, tickMs: 60_000 });
    await scheduler.start();
    expect(runner.of(userId)).toEqual([]);
    // Moved the brief to 07:30 at 08:05: today's 07:30 already passed before the change.
    await db.user.update({ where: { id: userId }, data: { briefTime: "07:30" } });
    now = at("2030-10-25T08:05:00Z");
    await scheduler.tick();
    expect(runner.of(userId)).toEqual([]);
    // Monday's 07:30 runs (Saturday and Sunday are off).
    now = at("2030-10-28T07:31:00Z");
    await scheduler.tick();
    expect(runner.of(userId)).toEqual(["brief@2030-10-28T07:30:00.000Z"]);
    await scheduler.stop();
  });

  test("slots follow the user's timezone and checkinMinute", async () => {
    const userId = await makeUser({ timezone: "Asia/Shanghai", checkinMinute: 7, briefTime: "07:41", onboardedAt: at("2030-10-24T00:00:00Z") });
    const runner = new FakeRunner(db);
    const scheduler = new Scheduler({ db, runner });
    // 2030-10-25 07:41 Shanghai = 2030-10-24T23:41Z; 10:07 = 02:07Z.
    await scheduler.tick(at("2030-10-24T23:42:00Z"));
    await scheduler.tick(at("2030-10-25T02:08:00Z"));
    expect(runner.of(userId)).toEqual(["brief@2030-10-24T23:41:00.000Z", "checkin@2030-10-25T02:07:00.000Z"]);
  });
});
