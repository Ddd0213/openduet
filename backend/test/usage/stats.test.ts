// M9 Usage panel (contract §5): GET /api/usage/stats?range=today|7d|30d|all from Run rows, by
// model (models.json label) and by kind, hour / day / month buckets in the user's timezone
// (oldest first), `estimated`, range validation; and the limits-off default (0 = no limit lines,
// nothing blocked).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerAccountRoutes } from "../../src/account/routes.ts";
import { UsageState, UsageStats } from "../../src/contract/account.ts";
import { summarizeUsage } from "../../src/usage/stats.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { replying, usage } from "../helpers/stub-agent.ts";

/** 2026-10-27 05:00 UTC = 13:00 in Shanghai (UTC+8, no DST). */
const NOW = new Date("2026-10-27T05:00:00.000Z");
const LABELS: Record<string, { label: string; provider: string }> = { "model-a": { label: "Model A", provider: "prov-a" } };

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;
beforeAll(async () => {
  fixture = await createTestApp({}, { now: () => NOW, setup: () => ({ routes: [registerAccountRoutes({ labels: (id) => LABELS[id] ?? null })] }) });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
  await fixture.db.user.update({ where: { id: alex.userId }, data: { timezone: "Asia/Shanghai" } });
  const run = (userId: string, at: string, kind: string, model: string | null, input: number, output: number, estimated = false) =>
    fixture.db.run.create({ data: {
      userId, kind, status: "completed", createdAt: new Date(at), model, providerId: model ? `p-${model}` : null,
      inputTokens: input, outputTokens: output, tokensEstimated: estimated,
    } });
  await run(alex.userId, "2026-10-27T04:30:00.000Z", "chat", "model-a", 100, 10); // today 12:30 local
  await run(alex.userId, "2026-10-26T16:30:00.000Z", "task", "model-b", 50, 5); // today 00:30 local
  await run(alex.userId, "2026-10-26T15:59:00.000Z", "brief", "model-a", 7, 3); // yesterday 23:59 local
  await run(alex.userId, "2026-10-21T00:00:00.000Z", "routine", "model-b", 20, 2, true); // Oct 21 08:00 local
  await run(alex.userId, "2026-10-20T15:00:00.000Z", "build", "model-a", 1000, 100); // Oct 20 23:00 local: outside 7d
  await run(alex.userId, "2026-08-15T03:00:00.000Z", "checkin", null, 4, 1); // August
  await run(alex.userId, "2026-10-27T04:00:00.000Z", "chat", "model-a", 0, 0); // no tokens: not counted
  await run(alex.userId, "2026-10-27T06:00:00.000Z", "chat", "model-a", 9, 9); // after now: not counted
  await run(sam.userId, "2026-10-27T04:30:00.000Z", "chat", "model-a", 999, 999); // someone else's
});
afterAll(() => fixture.cleanup());

const stats = async (query: string, user: SignedIn = alex) => {
  const response = await fixture.app.request(`/api/usage/stats${query}`, { headers: user.headers });
  expect(response.status).toBe(200);
  return UsageStats.parse(await response.json());
};

describe("GET /api/usage/stats", () => {
  test("today: hours from local midnight up to now, oldest first", async () => {
    const s = await stats("?range=today");
    expect(s).toMatchObject({ range: "today", since: "2026-10-26T16:00:00.000Z", until: NOW.toISOString(), bucket: "hour", estimated: false });
    expect(s.totals).toEqual({ inputTokens: 150, outputTokens: 15, runs: 2 });
    expect(s.series).toHaveLength(14);
    expect(s.series[0]).toEqual({ start: "2026-10-26T16:00:00.000Z", inputTokens: 50, outputTokens: 5 });
    expect(s.series.at(-1)).toEqual({ start: "2026-10-27T05:00:00.000Z", inputTokens: 0, outputTokens: 0 });
    expect(s.series.find((b) => b.start === "2026-10-27T04:00:00.000Z")).toEqual({ start: "2026-10-27T04:00:00.000Z", inputTokens: 100, outputTokens: 10 });
  });

  test("7d (the default): one day per bucket at local midnight; by model with labels; by kind; estimated", async () => {
    const s = await stats("");
    expect(s).toMatchObject({ range: "7d", since: "2026-10-20T16:00:00.000Z", bucket: "day", estimated: true });
    expect(s.totals).toEqual({ inputTokens: 177, outputTokens: 20, runs: 4 });
    expect(s.series.map((b) => b.start)).toEqual([20, 21, 22, 23, 24, 25, 26].map((d) => `2026-10-${d}T16:00:00.000Z`));
    expect(s.series[0]).toMatchObject({ inputTokens: 20, outputTokens: 2 });
    expect(s.series[5]).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(s.series[6]).toMatchObject({ inputTokens: 150, outputTokens: 15 });
    expect(s.byModel).toEqual([
      { model: "model-a", label: "Model A", provider: "p-model-a", inputTokens: 107, outputTokens: 13, runs: 2 },
      { model: "model-b", label: "model-b", provider: "p-model-b", inputTokens: 70, outputTokens: 7, runs: 2 },
    ]);
    expect(s.byKind).toEqual([
      { kind: "chat", inputTokens: 100, outputTokens: 10, runs: 1 },
      { kind: "task", inputTokens: 50, outputTokens: 5, runs: 1 },
      { kind: "proactive", inputTokens: 27, outputTokens: 5, runs: 2 },
    ]);
  });

  test("30d and all: 30 days, then months from the first counted run; a run without a model is \"unknown\"", async () => {
    const month = await stats("?range=30d");
    expect(month.series).toHaveLength(30);
    expect(month.series[0]!.start).toBe("2026-09-27T16:00:00.000Z");
    expect(month.totals.runs).toBe(5);
    expect(month.byKind.map((k) => k.kind)).toEqual(["chat", "task", "build", "proactive"]);

    const all = await stats("?range=all");
    expect(all).toMatchObject({ range: "all", since: null, bucket: "month" });
    expect(all.series.map((b) => b.start)).toEqual(["2026-07-31T16:00:00.000Z", "2026-08-31T16:00:00.000Z", "2026-09-30T16:00:00.000Z"]);
    expect(all.series.map((b) => b.inputTokens)).toEqual([4, 0, 1177]);
    expect(all.totals).toEqual({ inputTokens: 1181, outputTokens: 121, runs: 6 });
    expect(all.byModel.find((m) => m.model === "unknown")).toEqual({ model: "unknown", label: "unknown", provider: null, inputTokens: 4, outputTokens: 1, runs: 1 });
    expect(all.byModel[0]!.model).toBe("model-a");
  });

  test("buckets follow the user's timezone; someone else's runs never count; a bad range is 400", async () => {
    const utc = await stats("?range=7d", sam);
    expect(utc.since).toBe("2026-10-21T00:00:00.000Z");
    expect(utc.totals).toEqual({ inputTokens: 999, outputTokens: 999, runs: 1 });
    expect(utc.series.at(-1)).toEqual({ start: "2026-10-27T00:00:00.000Z", inputTokens: 999, outputTokens: 999 });
    const bad = await fixture.app.request("/api/usage/stats?range=week", { headers: alex.headers });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toMatchObject({ code: "validation_failed", field: "range" });
    expect((await fixture.app.request("/api/usage/stats")).status).toBe(401);
  });

  test("summarizeUsage: a DST day has 25 hours in New York (Nov 1 2026)", () => {
    const now = new Date("2026-11-02T04:30:00.000Z"); // Nov 1 23:30 EST
    const s = summarizeUsage([], { range: "today", now, timeZone: "America/New_York", labels: () => null });
    expect(s.since).toBe("2026-11-01T04:00:00.000Z");
    expect(s.series).toHaveLength(25);
    expect(s.byModel).toEqual([]);
    expect(s.totals).toEqual({ inputTokens: 0, outputTokens: 0, runs: 0 });
  });
});

describe("token limits off by default", () => {
  test("with 0 limits nothing is blocked and no usage-limit line is ever posted", async () => {
    const app = await createTestApp({}, { agent: replying("Sure.", usage(4_000_000, 1_000_000)), setup: () => ({ routes: [registerAccountRoutes()] }) });
    try {
      expect(app.config).toMatchObject({ SESSION_TOKEN_LIMIT: 0, WEEKLY_TOKEN_LIMIT: 0 });
      const user = await signUp(app, "alex");
      for (const clientId of ["off-1", "off-2", "off-3"]) {
        const response = await app.app.request(`/api/channels/${user.mainChannelId}/messages`, {
          method: "POST", headers: { ...user.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Big job", clientId }),
        });
        expect(response.status).toBe(200);
        const frames = await readSse(response);
        expect(frames.events.at(-1)).toMatchObject({ type: "done", payload: { status: "completed" } });
      }
      const state = UsageState.parse(await (await app.app.request("/api/usage", { headers: user.headers })).json());
      expect(state).toMatchObject({ limited: false, resumesAt: null, session: { used: 15_000_000, limit: 0 }, weekly: { used: 15_000_000, limit: 0 } });
      expect(await app.db.message.count({ where: { kind: "usage_limit" } })).toBe(0);
      expect(await app.runs.usageLimit(user.userId, user.mainChannelId, null)).toBeNull();
    } finally {
      await app.cleanup();
    }
  });
});
