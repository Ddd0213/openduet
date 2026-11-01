// M9 seen receipt (contract §1): a user message stays "sent" (Delivered) until the model starts
// answering its own turn (first text / thinking / tool call of the first model call), then turns
// "seen" with a message update. Real agent runtime + run host on the role-scripted model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LlmError } from "../../src/llm/index.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, lastEventId, messagesOf, ofType, startApp, storedEvents, text, type TaskApp } from "../tasks/harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

const send = (body: string, clientId: string) =>
  t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: body, clientId }));
const statusOf = async (clientId: string) => (await t.fixture.db.message.findFirstOrThrow({ where: { clientId } })).status;

describe("seen receipt", () => {
  test("a turn that answers turns the message seen once, after the echo and before the reply", async () => {
    t.llm.script("chat", [text("Hello there.")]);
    const frames = await readSse(await send("Hi", "seen-1"));
    const mine = messagesOf(frames).filter((m) => m.role === "user");
    expect(mine.map((m) => m.status)).toEqual(["sent", "seen"]);
    expect(new Set(mine.map((m) => m.id)).size).toBe(1);
    const seenAt = frames.events.findIndex((e) => e.type === "message" && e.payload.message.role === "user" && e.payload.message.status === "seen");
    const replyAt = frames.events.findIndex((e) => e.type === "message" && e.payload.message.role === "assistant");
    expect(seenAt).toBeGreaterThan(0);
    expect(replyAt).toBeGreaterThan(seenAt);
    expect(await statusOf("seen-1")).toBe("seen");
  });

  test("a provider that fails before any event leaves it delivered, with the usual error line", async () => {
    t.llm.script("chat", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 1 }));
    const frames = await readSse(await send("Are you there?", "seen-2"));
    const mine = messagesOf(frames).filter((m) => m.role === "user");
    expect(mine.map((m) => m.status)).toEqual(["sent"]);
    // M12: the model_error card (instead of the grey line).
    expect(messagesOf(frames).some((m) => m.kind === "model_error" && m.payload.phrase.key === "system.model_error")).toBe(true);
    expect(ofType(frames, "done").at(-1)?.payload).toMatchObject({ status: "failed" });
    expect(await statusOf("seen-2")).toBe("sent");
  });

  test("a message queued behind a running turn turns seen only when its own turn answers", async () => {
    const gate = deferred();
    // First turn: a card (the model is answering: message one is seen), then a round held open.
    t.llm.script("chat",
      [call("show_card", { title: "Working on it", blocks: [{ type: "text", text: "One moment." }] })],
      async () => { await gate.promise; return [text("Done with the first.")]; },
      [text("And the second.")],
    );
    const from = await lastEventId(t.fixture);
    await readSse(await send("First", "seen-q1"), { until: (f) => messagesOf(f).some((m) => m.kind === "card") });
    expect(await statusOf("seen-q1")).toBe("seen");

    const second = await send("Second", "seen-q2");
    expect(second.status).toBe(200);
    expect(await statusOf("seen-q2")).toBe("sent");
    gate.resolve();
    await readSse(second);
    await t.fixture.runs.idle();
    expect(await statusOf("seen-q2")).toBe("seen");

    // Its seen update comes after the first run's done, and after its own echo.
    const secondId = (await t.fixture.db.message.findFirstOrThrow({ where: { clientId: "seen-q2" } })).id;
    const events = await storedEvents(t.fixture, t.alex.userId, from);
    const firstRun = (await t.fixture.db.message.findFirstOrThrow({ where: { clientId: "seen-q1" } })).id;
    const firstDone = events.findIndex((e) => e.type === "done" && e.payload.status === "completed");
    const seen = events.findIndex((e) => e.type === "message" && e.payload.message.id === secondId && e.payload.message.status === "seen");
    expect(firstDone).toBeGreaterThan(-1);
    expect(seen).toBeGreaterThan(firstDone);
    expect(events.filter((e) => e.type === "message" && e.payload.message.id === firstRun && e.payload.message.status === "seen")).toHaveLength(1);
  });
});
