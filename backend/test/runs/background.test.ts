// M14 A5: a routine / brief / check-in run that failed with a retryable model error (429, 5xx,
// network, timeout, invalid response) and posted nothing and wrote nothing is tried again on its
// own (+1 / +5 / +15 min in production, ms here), at most 3 times; only the last failure shows the
// model_error card. A write tool, a posted bubble, a non-retryable error or a chat turn: no retry.
// The retries live in memory; shutdown drops them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import type { Phrase } from "../../src/contract/common.ts";
import { retryableFailure } from "../../src/runs/background.ts";
import { RunHost, type RetryOf, type TurnOutcome } from "../../src/runs/host.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

let script: (input: TurnInput, attempt: number) => Promise<TurnResult>;
const attempts = new Map<string, number>();
const agent = stubAgent((input) => {
  const n = (attempts.get(input.userMessage.text) ?? 0) + 1;
  attempts.set(input.userMessage.text, n);
  return script(input, n);
});
let fixture: TestApp;
let alex: SignedIn;
const outcomes: TurnOutcome[] = [];
beforeAll(async () => {
  fixture = await createTestApp({}, {
    setup: (core) => {
      const runs = new RunHost({ ...core, agent, backgroundRetryMs: [5, 5, 5] });
      // What the routine / proactive modules register (their hooks; here: record the outcome).
      for (const kind of ["routine", "brief", "checkin"] as const) runs.retryable(kind, () => ({ after: async (o) => { outcomes.push(o); } }));
      return { runs, agent };
    },
  });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const fail = (error: Phrase): TurnResult => ({ status: "failed", error, usage: usage(1, 0), model: MODEL });
const ok = (): TurnResult => ({ status: "completed", error: null, usage: usage(1, 1), model: MODEL });
const status = (value: number): Phrase => ({ key: "system.model_error", params: { status: { type: "number", value } } });
const submit = async (kind: "routine" | "brief" | "checkin" | "chat", prompt: string, recordTaskId: string | null = null) => {
  const runId = await fixture.runs.submit({
    userId: alex.userId, channelId: alex.mainChannelId, taskId: null, recordTaskId, kind, prompt, title: { text: prompt },
    hooks: { after: async (o) => { outcomes.push(o); } },
  });
  if (!runId) throw new Error("refused");
  return runId;
};
const runsOf = (title: string) => fixture.db.run.findMany({ where: { userId: alex.userId, title: JSON.stringify({ text: title }) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const cards = () => fixture.db.message.findMany({ where: { userId: alex.userId, kind: "model_error" } });

describe("retryableFailure", () => {
  test("429 / 5xx / 408, network, timeout, invalid response; never auth, quota, context, filter, no model, internal", () => {
    for (const phrase of [status(429), status(502), status(529), status(408), { key: "system.model_rate_limit" }, { key: "system.model_network" },
      { key: "system.model_timeout" }, { key: "system.model_invalid_response" },
      { key: "system.model_unreachable", params: { reason: { type: "text", value: "timeout" } } },
      { key: "system.model_unreachable", params: { reason: { type: "text", value: "network error" } } }] as Phrase[]) {
      expect(retryableFailure(phrase)).toBe(true);
    }
    for (const phrase of [status(400), status(401), status(413), { key: "system.model_auth" }, { key: "system.model_quota" },
      { key: "system.model_context_length" }, { key: "system.model_content_filter" }, { key: "system.no_model" }, { key: "system.model_output_limit" },
      { key: "system.model_unreachable", params: { reason: { type: "text", value: "internal" } } }] as Phrase[]) {
      expect(retryableFailure(phrase)).toBe(false);
    }
    expect(retryableFailure(null)).toBe(false);
  });
});

describe("background runs retry on their own", () => {
  test("a brief that hits 429 is tried again (up to 3 times) and the success shows no card", async () => {
    script = async (_input, n) => (n <= 3 ? fail(n === 1 ? status(429) : n === 2 ? { key: "system.model_network" } : status(503)) : ok());
    const first = await submit("brief", "Morning brief A");
    await fixture.runs.idle();
    const rows = await runsOf("Morning brief A");
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "failed", "completed"]);
    expect(rows[0]!.id).toBe(first);
    expect(rows.every((r) => r.kind === "brief" && r.scheduledFor === null)).toBe(true);
    expect(agent.turns.filter((t) => t.userMessage.text === "Morning brief A")).toHaveLength(4);
    expect(await cards()).toHaveLength(0);
    // The module's hooks run for every attempt.
    expect(outcomes.filter((o) => rows.some((r) => r.id === o.runId))).toHaveLength(4);
  });

  test("after 3 retries the 4th failure fails as today: one model_error card, on the last run", async () => {
    script = async () => fail(status(529));
    await submit("checkin", "Check-in B");
    await fixture.runs.idle();
    const rows = await runsOf("Check-in B");
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "failed", "failed"]);
    const all = await cards();
    expect(all).toHaveLength(1);
    expect(JSON.parse(all[0]!.payload)).toMatchObject({ runId: rows[3]!.id, retry: true, state: "open" });
  });

  test("a routine keeps its task on every retry; reads alone still retry", async () => {
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Invoices", routine: true, status: "scheduled" } });
    script = async (input, n) => {
      if (n === 1) {
        const h = input.steps!.toolStart({ type: "tool_use", id: "s1", name: "web_search", input: { query: "unpaid invoices" } });
        input.steps!.toolEnd(h, { type: "tool_result", toolUseId: "s1", content: [{ type: "text", text: "[]" }] });
        return fail({ key: "system.model_timeout" });
      }
      return ok();
    };
    await submit("routine", "Routine C", task.id);
    await fixture.runs.idle();
    const rows = await runsOf("Routine C");
    expect(rows.map((r) => [r.status, r.taskId])).toEqual([["failed", task.id], ["completed", task.id]]);
    // The retry knows what the failed attempt looked up (A3).
    expect(agent.turns.filter((t) => t.userMessage.text === "Routine C").at(-1)!.takeover).toContain("web_search (unpaid invoices) → ok");
  });

  test("no retry after a write tool, a posted bubble, a non-retryable error, or for a chat turn", async () => {
    script = async (input) => {
      const text = input.userMessage.text;
      if (text === "Wrote D") {
        const h = input.steps!.toolStart({ type: "tool_use", id: "w1", name: "add_up_next", input: { title: "Pay rent" } });
        input.steps!.toolEnd(h, { type: "tool_result", toolUseId: "w1", content: [{ type: "text", text: "{\"ok\":true}" }] });
      }
      if (text === "Posted D") await input.sink.upsertMessage({ role: "assistant", kind: "text", text: "Morning! Here's the plan" });
      return fail(text === "Auth D" ? { key: "system.model_auth" } : status(503));
    };
    for (const [kind, prompt] of [["brief", "Wrote D"], ["brief", "Posted D"], ["routine", "Auth D"], ["chat", "Chat D"]] as const) await submit(kind, prompt);
    await fixture.runs.idle();
    for (const prompt of ["Wrote D", "Posted D", "Auth D", "Chat D"]) expect((await runsOf(prompt)).map((r) => r.status)).toEqual(["failed"]);
    expect((await cards()).length).toBe(1 + 4);
  });

  test("shutdown drops a pending retry (kept in memory only)", async () => {
    const host = new RunHost({ db: fixture.db, events: fixture.events, usage: fixture.usage, files: fixture.files, agent, backgroundRetryMs: [60_000] });
    host.retryable("brief", () => ({}));
    script = async () => fail(status(429));
    const runId = await host.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "brief", prompt: "Brief E", title: { text: "Brief E" } });
    for (let i = 0; i < 200 && (await fixture.db.run.findUniqueOrThrow({ where: { id: runId! } })).status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    await host.shutdown();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await runsOf("Brief E")).map((r) => r.status)).toEqual(["failed"]);
    expect(agent.turns.filter((t) => t.userMessage.text === "Brief E")).toHaveLength(1);
  });

  test("M14: a refused key, no credit or a model not set up: the card offers the settings (retry false, nothing to resubmit)", async () => {
    for (const [i, key] of ["system.model_auth", "system.model_quota", "system.model_config", "system.model_context_length"].entries()) {
      script = async () => fail({ key });
      const runId = await submit("brief", `Setup ${i}`);
      await fixture.runs.idle();
      const card = (await cards()).find((c) => JSON.parse(c.payload).runId === runId)!;
      const stored = JSON.parse(card.payload) as { retry: boolean; retryOf?: RetryOf };
      // a too-long conversation can still be retried (on another model); the other three can't
      expect([key, stored.retry, !!stored.retryOf]).toEqual([key, key === "system.model_context_length", key === "system.model_context_length"]);
    }
  });

  test("a Retry the user tapped isn't retried on its own: when it fails with 429 its card shows at once", async () => {
    // The first attempt fails for good (card), the tapped retry hits a 429: no silent +1/+5/+15 min retries.
    script = async (_input, n) => fail(n === 1 ? { key: "system.model_context_length" } : status(429));
    const first = await submit("brief", "Brief F");
    await fixture.runs.idle();
    const card = (await cards()).find((c) => JSON.parse(c.payload).runId === first)!;
    const stored = JSON.parse(card.payload) as { runId: string; retryOf: RetryOf };
    await fixture.runs.retry(alex.userId, stored.runId, stored.retryOf, null);
    await fixture.runs.idle();
    const rows = await runsOf("Brief F");
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(agent.turns.filter((t) => t.userMessage.text === "Brief F")).toHaveLength(2);
    const last = (await cards()).filter((c) => JSON.parse(c.payload).runId === rows[1]!.id);
    expect(last).toHaveLength(1);
    expect(JSON.parse(last[0]!.payload)).toMatchObject({ retry: true, state: "open" });
  });

  test("an automatic retry keeps the original turn's gating: a gate that now says no skips it, with no turn and no card", async () => {
    // The original turn's own hooks (a scheduled check-in's gate, a scheduled routine's pause check);
    // the module's retry hooks (what a tapped Retry gets) let everything through.
    const gateCalls: string[] = [];
    const gated = { before: async (runId: string) => { gateCalls.push(runId); return gateCalls.length === 1; } };
    script = async () => fail(status(429));
    const first = await fixture.runs.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "checkin", prompt: "Check-in G", title: { text: "Check-in G" }, hooks: gated });
    await fixture.runs.idle();
    const rows = await runsOf("Check-in G");
    expect(rows.map((r) => r.status)).toEqual(["failed", "skipped"]);
    expect(rows[0]!.id).toBe(first!);
    expect(gateCalls).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(agent.turns.filter((t) => t.userMessage.text === "Check-in G")).toHaveLength(1);
    expect((await cards()).filter((c) => rows.some((r) => r.id === JSON.parse(c.payload).runId))).toHaveLength(0);
  });

  test("shutdown waits for a retry whose timer already fired, and that retry creates no Run once stopping began", async () => {
    let reached!: () => void;
    const inFlight = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    // The resubmit's first lookup (the channel) is held until shutdown has begun.
    const channel = {
      findFirst: async (args: Parameters<typeof fixture.db.channel.findFirst>[0]) => {
        reached();
        await released;
        return fixture.db.channel.findFirst(args);
      },
    };
    const db = new Proxy(fixture.db, { get: (target, key) => (key === "channel" ? channel : Reflect.get(target, key, target)) });
    const host = new RunHost({ db, events: fixture.events, usage: fixture.usage, files: fixture.files, agent, backgroundRetryMs: [5] });
    host.retryable("brief", () => ({}));
    script = async () => fail(status(429));
    await host.submit({ userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "brief", prompt: "Brief H", title: { text: "Brief H" } });
    await inFlight;
    let finished = false;
    const stopping = host.shutdown().then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(finished).toBe(false);
    release();
    await stopping;
    expect((await runsOf("Brief H")).map((r) => r.status)).toEqual(["failed"]);
    await new Promise((r) => setTimeout(r, 30));
    expect((await runsOf("Brief H")).map((r) => r.status)).toEqual(["failed"]);
    expect(agent.turns.filter((t) => t.userMessage.text === "Brief H")).toHaveLength(1);
  });
});
