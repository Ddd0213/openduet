// GET /api/usage and the monthly free Full reset (L79, L166), with a fake clock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerAccountRoutes } from "../../src/account/routes.ts";
import { UsageState } from "../../src/contract/account.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { userMonth } from "../../src/usage/meter.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";

let now = new Date("2026-11-20T10:00:00.000Z");
let fixture: TestApp;
let alex: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({ SESSION_TOKEN_LIMIT: "1000", WEEKLY_TOKEN_LIMIT: "5000" }, { now: () => now, setup: () => ({ routes: [registerAccountRoutes()] }) });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const usage = async () => {
  const response = await fixture.app.request("/api/usage", { headers: alex.headers });
  expect(response.status).toBe(200);
  return UsageState.parse(await response.json());
};
const reset = () => fixture.app.request("/api/usage/full-reset", { method: "POST", headers: alex.headers });

describe("userMonth", () => {
  test("is the calendar month in the user's timezone", () => {
    // 16:30 UTC on Oct 31 is already Nov 1 in Shanghai.
    const shanghai = userMonth(new Date("2026-10-31T16:30:00.000Z"), "Asia/Shanghai");
    expect(shanghai.start.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(shanghai.next.toISOString()).toBe("2026-11-30T16:00:00.000Z");
    // Los Angeles: November starts in PDT and ends in PST.
    const la = userMonth(new Date("2026-11-15T12:00:00.000Z"), "America/Los_Angeles");
    expect(la.start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(la.next.toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(userMonth(new Date("2026-12-31T23:00:00.000Z"), "Not/AZone").next.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("usage", () => {
  test("starts empty with the free reset available until the end of the user's month", async () => {
    const state = await usage();
    expect(state).toMatchObject({ session: { used: 0, limit: 1000, resetsAt: null }, weekly: { used: 0, limit: 5000, resetsAt: null }, limited: false, resumesAt: null });
    expect(state.fullReset).toEqual({ available: true, expiresAt: "2026-11-30T23:59:59.999Z" });
    await fixture.app.request("/api/usage", { headers: { ...alex.headers, "X-Timezone": "Asia/Shanghai" } });
    expect((await usage()).fullReset.expiresAt).toBe("2026-11-30T15:59:59.999Z");
  });

  test("full reset zeroes both counters, lifts old limit lines and works once a month", async () => {
    await fixture.usage.record(alex.userId, 1200);
    expect((await usage()).limited).toBe(true);
    const line = await fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "system", kind: "usage_limit", payload: JSON.stringify({ resumesAt: now.toISOString() }) } });
    const seen: DuetEvent[] = [];
    const stop = fixture.events.subscribe(alex.userId, (e) => seen.push(e));
    const response = await reset();
    stop();
    expect(response.status).toBe(200);
    const state = UsageState.parse(await response.json());
    expect(state).toMatchObject({ session: { used: 0, resetsAt: null }, weekly: { used: 0, resetsAt: null }, limited: false, fullReset: { available: false } });
    expect(seen.find((e) => e.type === "usage")).toBeDefined();
    expect(await fixture.db.message.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ kind: "system", role: "system" });
    expect(seen.some((e) => e.type === "message" && e.payload.message.id === line.id)).toBe(true);

    const second = await reset();
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe("stale_version");
  });

  test("the next month in the user's timezone brings it back", async () => {
    now = new Date("2026-11-30T16:30:00.000Z"); // Dec 1, 00:30 in Shanghai
    expect((await usage()).fullReset).toEqual({ available: true, expiresAt: "2026-12-31T15:59:59.999Z" });
    expect((await reset()).status).toBe(200);
    expect((await reset()).status).toBe(409);
  });
});
