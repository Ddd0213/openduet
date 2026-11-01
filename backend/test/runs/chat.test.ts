// The chat answer stream (L73): order, storage, failures, disconnects, token counts, one run
// per channel at a time. In-process through app.request with a stub AgentRuntime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import type { Message } from "../../src/contract/messages.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

let script: (input: TurnInput) => Promise<TurnResult>;
const agent = stubAgent((input) => script(input));
let fixture: TestApp;
let alex: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({}, { agent, heartbeatMs: 1000 });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const send = (body: Record<string, unknown>) =>
  fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, {
    method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
const messages = (f: SseFrames): Message[] => f.events.flatMap((e) => (e.type === "message" ? [e.payload.message] : []));
const doneEvent = (f: SseFrames) => f.events.find((e) => e.type === "done");
const completed = (tokens = usage(1, 1)): TurnResult => ({ status: "completed", error: null, usage: tokens, model: MODEL });

describe("POST /api/channels/:id/messages", () => {
  test("streams the echoed user message, status, Claude's reply and done, and stores every event", async () => {
    script = async ({ sink, onFirstEvent }) => {
      await sink.status("searching_web");
      // The runtime calls this on the model's first streamed event (M9 seen receipt).
      await onFirstEvent?.();
      await sink.typing(true);
      const draft = await sink.upsertMessage({ role: "assistant", kind: "text", text: "Hel" });
      await sink.upsertMessage({ id: draft.id, role: "assistant", kind: "text", text: "Hello there" });
      return completed(usage(120, 30));
    };
    const response = await send({ text: "What's the weather in Paris?", clientId: "c-1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("text/event-stream");
    const frames = await readSse(response);
    const types = frames.events.map((e) => e.type);

    const [echo, seen] = messages(frames);
    expect(types[0]).toBe("message");
    expect(echo).toMatchObject({ role: "user", clientId: "c-1", status: "sent", text: "What's the weather in Paris?" });
    expect(seen).toMatchObject({ id: echo!.id, status: "seen" });
    const statusAt = frames.events.findIndex((e) => e.type === "status" && e.payload.status === "searching_web");
    const replies = messages(frames).filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.text)).toEqual(["Hel", "Hello there"]);
    expect(new Set(replies.map((m) => m.id)).size).toBe(1);
    const replyAt = frames.events.findIndex((e) => e.type === "message" && e.payload.message.role === "assistant");
    expect(statusAt).toBeGreaterThan(0);
    expect(replyAt).toBeGreaterThan(statusAt);
    expect(types.at(-1)).toBe("done");
    expect(doneEvent(frames)?.payload).toMatchObject({ status: "completed", error: null, taskId: null });
    // Idle again before done: the pill clears and the dots stop.
    expect(frames.events.some((e) => e.type === "status" && e.payload.status === null)).toBe(true);
    expect(frames.events.some((e) => e.type === "typing" && !e.payload.typing)).toBe(true);

    expect(frames.ids).toEqual([...frames.ids].sort((a, b) => a - b));
    expect(await fixture.db.event.count({ where: { id: { in: frames.ids }, userId: alex.userId } })).toBe(frames.ids.length);
  });

  test("every run records its tokens and the usage event follows", async () => {
    const run = await fixture.db.run.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
    expect(run).toMatchObject({ kind: "chat", status: "completed", inputTokens: 120, outputTokens: 30, providerId: "test", model: "scripted-1", tokensEstimated: false });
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    const row = await fixture.db.usage.findUniqueOrThrow({ where: { userId: alex.userId } });
    expect(row.sessionTokens).toBe(150);
    expect(row.weeklyTokens).toBe(150);
  });

  test("a failed model call ends with done(failed) and a model_error card (M12: no grey line), never an invented reply", async () => {
    script = async ({ sink }) => {
      await sink.status("thinking");
      return { status: "failed", error: { key: "system.model_error", params: { status: { type: "number", value: 502 } } }, usage: usage(0, 0), model: null };
    };
    const frames = await readSse(await send({ text: "Hi", clientId: "c-fail" }));
    expect(messages(frames).some((m) => m.role === "assistant")).toBe(false);
    expect(messages(frames).some((m) => m.kind === "system")).toBe(false);
    const card = messages(frames).find((m) => m.kind === "model_error");
    expect(card).toMatchObject({ role: "system", payload: { phrase: { key: "system.model_error" }, modelId: null, modelLabel: null, retry: true, state: "open" } });
    expect(doneEvent(frames)?.payload).toMatchObject({ status: "failed", error: { key: "system.model_error" } });
    const run = await fixture.db.run.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.error!)).toMatchObject({ key: "system.model_error" });
  });

  test("an agent that throws is a failed run with system.model_unreachable", async () => {
    script = async () => { throw new Error("boom"); };
    const frames = await readSse(await send({ text: "Hi again", clientId: "c-throw" }));
    expect(doneEvent(frames)?.payload).toMatchObject({ status: "failed", error: { key: "system.model_unreachable" } });
    expect(messages(frames).some((m) => m.role === "assistant")).toBe(false);
  });

  test("closing the stream mid-run doesn't cancel the run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    script = async ({ sink }) => {
      await sink.status("thinking");
      await gate;
      await sink.upsertMessage({ role: "assistant", kind: "text", text: "Finished anyway" });
      return completed();
    };
    const response = await send({ text: "Take your time", clientId: "c-gone" });
    await readSse(response, { until: (f) => f.events.some((e) => e.type === "status" && e.payload.status === "thinking") });
    release();
    await fixture.runs.idle();
    const run = await fixture.db.run.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
    expect(run.status).toBe("completed");
    expect(await fixture.db.message.count({ where: { channelId: alex.mainChannelId, text: "Finished anyway" } })).toBe(1);
    const done = await fixture.db.event.findFirst({ where: { userId: alex.userId, type: "done" }, orderBy: { id: "desc" } });
    expect(JSON.parse(done!.payload)).toMatchObject({ runId: run.id, status: "completed" });
  });

  test("runs in one channel never overlap and keep their order", async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    script = async ({ userMessage, sink }) => {
      active += 1;
      peak = Math.max(peak, active);
      await sink.status("thinking");
      if (userMessage.text === "one") await gate;
      active -= 1;
      return completed();
    };
    const before = agent.turns.length;
    await readSse(await send({ text: "one", clientId: "q-1" }), { until: (f) => f.events.some((e) => e.type === "status" && e.payload.status === "thinking") });
    // The first run holds the channel; the second is stored and waits its turn.
    const second = await send({ text: "two", clientId: "q-2" });
    expect(await fixture.db.run.count({ where: { userId: alex.userId, status: "queued" } })).toBe(1);
    expect(await fixture.db.run.count({ where: { userId: alex.userId, status: "running" } })).toBe(1);
    release();
    await readSse(second);
    expect(peak).toBe(1);
    expect(agent.turns.slice(before).map((t) => t.userMessage.text)).toEqual(["one", "two"]);
  });

  test("a retry with the same clientId gets the stored message back, never a second copy or run", async () => {
    script = async ({ sink }) => {
      await sink.upsertMessage({ role: "assistant", kind: "text", text: "Once." });
      return completed();
    };
    const runsBefore = await fixture.db.run.count();
    const first = await readSse(await send({ text: "Only once", clientId: "idem-1" }));
    const retry = await readSse(await send({ text: "Only once", clientId: "idem-1" }), { timeoutMs: 2000 });
    const echo = messages(retry).find((m) => m.role === "user");
    expect(echo?.id).toBe(messages(first).find((m) => m.role === "user")!.id);
    expect(retry.events.some((e) => e.type === "done")).toBe(false);
    expect(await fixture.db.message.count({ where: { clientId: "idem-1" } })).toBe(1);
    expect(await fixture.db.run.count()).toBe(runsBefore + 1);

    // Two sends racing with the same clientId share one message and one run.
    const [a, b] = await Promise.all([send({ text: "Racing", clientId: "idem-2" }), send({ text: "Racing", clientId: "idem-2" })]);
    const [fa, fb] = await Promise.all([readSse(a!), readSse(b!)]);
    expect(doneEvent(fa)?.payload.runId).toBe(doneEvent(fb)!.payload.runId);
    expect(await fixture.db.message.count({ where: { clientId: "idem-2" } })).toBe(1);
  });

  test("tapping a quick reply sends its text and marks the chip as chosen", async () => {
    script = async ({ sink }) => {
      await sink.upsertMessage({ role: "assistant", kind: "quick_replies", text: "Which one?", payload: { options: ["Morning", "Evening"] } });
      return completed();
    };
    const card = messages(await readSse(await send({ text: "Set a brief", clientId: "qr-1" }))).find((m) => m.kind === "quick_replies")!;
    expect(card.kind === "quick_replies" && card.payload).toEqual({ options: ["Morning", "Evening"], chosen: null });

    script = async () => completed();
    const bad = await send({ text: "Noon", clientId: "qr-bad", quickReply: { messageId: card.id, option: "Noon" } });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toMatchObject({ code: "validation_failed", field: "quickReply" });

    const frames = await readSse(await send({ text: "Evening", clientId: "qr-2", quickReply: { messageId: card.id, option: "Evening" } }));
    const chosen = messages(frames).find((m) => m.id === card.id);
    expect(chosen?.kind === "quick_replies" && chosen.payload.chosen).toBe("Evening");
  });

  test("an empty message and someone else's channel are rejected before anything is stored", async () => {
    const before = await fixture.db.message.count();
    const empty = await send({ text: "   ", clientId: "e-1" });
    expect(empty.status).toBe(400);
    const sam = await signUp(fixture, "sam", "Sam Lee");
    const foreign = await fixture.app.request(`/api/channels/${sam.mainChannelId}/messages`, {
      method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", clientId: "x" }),
    });
    expect(foreign.status).toBe(404);
    expect(await fixture.db.message.count()).toBe(before);
  });

  test("at startup, runs a previous process left behind are cancelled and their pill cleared", async () => {
    const stale = await fixture.db.run.create({ data: { userId: alex.userId, kind: "chat", status: "running", channelId: alex.mainChannelId, startedAt: new Date() } });
    expect(await fixture.runs.recoverStaleRuns()).toBe(1);
    expect((await fixture.db.run.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("cancelled");
    const done = await fixture.db.event.findFirstOrThrow({ where: { userId: alex.userId, type: "done" }, orderBy: { id: "desc" } });
    expect(JSON.parse(done.payload)).toMatchObject({ runId: stale.id, status: "cancelled" });
  });
});

describe("without an agent", () => {
  test("a turn fails honestly with a model_error card", async () => {
    const bare = await createTestApp();
    try {
      const user = await signUp(bare, "solo");
      const response = await bare.app.request(`/api/channels/${user.mainChannelId}/messages`, {
        method: "POST", headers: { ...user.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hello?", clientId: "s-1" }),
      });
      const frames = await readSse(response);
      expect(doneEvent(frames)?.payload).toMatchObject({ status: "failed", error: { key: "system.model_unreachable" } });
      expect(messages(frames).some((m) => m.role === "assistant")).toBe(false);
      expect(messages(frames).find((m) => m.kind === "model_error")?.payload).toMatchObject({ phrase: { key: "system.model_unreachable" }, state: "open" });
    } finally {
      await bare.cleanup();
    }
  });
});
