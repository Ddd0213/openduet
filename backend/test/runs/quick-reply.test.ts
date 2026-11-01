// M21 quick replies, server-side CAS: a card's options start one turn only while they're current.
// Already chosen, or the user wrote after the card in its thread (an older turn's options): 409
// conflict, and nothing is stored (no user message, no run). Two taps racing: one wins.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
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

const completed = (): TurnResult => ({ status: "completed", error: null, usage: usage(1, 1), model: MODEL });
const send = (body: Record<string, unknown>) =>
  fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, {
    method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
const ask = (options: string[], question = "Which one?") => {
  script = async ({ sink }) => {
    await sink.upsertMessage({ role: "assistant", kind: "quick_replies", text: question, payload: { options } });
    return completed();
  };
};
const quiet = () => { script = async () => completed(); };
/** Sends a typed message, waits for its turn, returns the newest quick_replies card. */
async function card(text: string, options: string[]) {
  ask(options);
  await readSse(await send({ text, clientId: crypto.randomUUID() }));
  await fixture.runs.idle();
  return fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "quick_replies" }, orderBy: { createdAt: "desc" } });
}
const counts = async () => ({ messages: await fixture.db.message.count(), runs: await fixture.db.run.count() });
const chosenOf = async (id: string) => (JSON.parse((await fixture.db.message.findUniqueOrThrow({ where: { id } })).payload) as { chosen: string | null }).chosen;

describe("quick replies are a compare-and-set", () => {
  test("a chip already chosen can't start a second turn", async () => {
    const first = await card("Set a brief", ["Morning", "Evening"]);
    quiet();
    const ok = await send({ text: "Morning", clientId: "qr-a1", quickReply: { messageId: first.id, option: "Morning" } });
    expect(ok.status).toBe(200);
    await readSse(ok);
    await fixture.runs.idle();
    expect(await chosenOf(first.id)).toBe("Morning");

    const before = await counts();
    const again = await send({ text: "Evening", clientId: "qr-a2", quickReply: { messageId: first.id, option: "Evening" } });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toMatchObject({ code: "conflict", field: "quickReply" });
    expect(await counts()).toEqual(before);
    expect(await chosenOf(first.id)).toBe("Morning");
    // The same tap sent again (same clientId) is still the stored message, not a conflict.
    const retry = await send({ text: "Morning", clientId: "qr-a1", quickReply: { messageId: first.id, option: "Morning" } });
    expect(retry.status).toBe(200);
    await readSse(retry, { timeoutMs: 1500 });
    expect(await counts()).toEqual(before);
  });

  test("an older turn's options are refused once the user has written after them", async () => {
    const old = await card("Plan dinner", ["Pasta", "Curry"]);
    quiet();
    // The user types instead of tapping: the card's options are no longer the current question.
    await readSse(await send({ text: "Actually, something light", clientId: "qr-b1" }));
    await fixture.runs.idle();
    const before = await counts();
    const stale = await send({ text: "Curry", clientId: "qr-b2", quickReply: { messageId: old.id, option: "Curry" } });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({ code: "conflict", field: "quickReply" });
    expect(await counts()).toEqual(before);
    expect(await chosenOf(old.id)).toBeNull();
    expect(agent.turns.some((t) => t.userMessage.text === "Curry")).toBe(false);
  });

  test("a message in another thread (a task's session) doesn't make the main thread's card stale", async () => {
    const current = await card("Pick a time", ["9:00", "10:00"]);
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Side task" } });
    await fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, taskId: task.id, role: "user", text: "in the task", payload: "{}" } });
    quiet();
    const ok = await send({ text: "9:00", clientId: "qr-c1", quickReply: { messageId: current.id, option: "9:00" } });
    expect(ok.status).toBe(200);
    await readSse(ok);
    expect(await chosenOf(current.id)).toBe("9:00");
  });

  test("two taps racing on one card: one turn, the other 409", async () => {
    const racing = await card("Which city?", ["Paris", "Rome"]);
    quiet();
    const before = await counts();
    const [a, b] = await Promise.all([
      send({ text: "Paris", clientId: "qr-d1", quickReply: { messageId: racing.id, option: "Paris" } }),
      send({ text: "Rome", clientId: "qr-d2", quickReply: { messageId: racing.id, option: "Rome" } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    await readSse(winner);
    await fixture.runs.idle();
    const after = await counts();
    expect(after.messages - before.messages).toBe(1); // only the winner's user message (the quiet turn posts nothing)
    expect(after.runs - before.runs).toBe(1);
    expect(await chosenOf(racing.id)).toBe(a.status === 200 ? "Paris" : "Rome");
  });

  test("an unknown option or someone else's card stays 400 validation_failed", async () => {
    const mine = await card("Tea or coffee?", ["Tea", "Coffee"]);
    const bad = await send({ text: "Juice", clientId: "qr-e1", quickReply: { messageId: mine.id, option: "Juice" } });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toMatchObject({ code: "validation_failed", field: "quickReply" });
    const sam = await signUp(fixture, "sam", "Sam Lee");
    const theirs = await fixture.db.message.create({ data: { userId: sam.userId, channelId: alex.mainChannelId, role: "assistant", kind: "quick_replies", text: "?", payload: JSON.stringify({ options: ["A"], chosen: null }) } });
    const foreign = await send({ text: "A", clientId: "qr-e2", quickReply: { messageId: theirs.id, option: "A" } });
    expect(foreign.status).toBe(400);
  });
});
