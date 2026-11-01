// M24 check/uncheck uses the existing authenticated action route and card lock, never a turn.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CardMessage, MessageActionResponse, type Message } from "../../src/contract/messages.ts";
import { TaskDetail } from "../../src/contract/tasks.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, lastEventId, messagesOf, restarted, startApp, storedEvents, text, type TaskApp } from "./harness.ts";

type Card = Extract<Message, { kind: "card" }>;
let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const CARD = {
  title: "Trip plan", subtitle: "This week", icon: "plane", tint: "blue", text: "Ready when you are.",
  blocks: [
    { type: "line_chart", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Distance", values: [10, null, 20] }], unit: "km" },
    { type: "checklist", checkable: true, checklist: [{ text: "Pack a bag", done: false }, { text: "Find tickets", done: true }] },
    { type: "checklist", checklist: [{ text: "Booking confirmed", done: true }] },
    { type: "checklist", checkable: true, checklist: [{ text: "Check in", done: false }] },
  ],
  actions: [{ label: "Details", type: "send", value: "Tell me about the trip" }],
};
const act = (id: string, body: Record<string, unknown>, user: SignedIn = t.alex) =>
  t.fixture.app.request(`/api/messages/${id}/action`, json(user, "POST", body));
const cardOf = async (response: Response): Promise<Card> => {
  expect(response.status).toBe(200);
  return CardMessage.parse(MessageActionResponse.parse(await response.json()).message);
};
const itemsOf = (card: Card) => card.payload.blocks.flatMap((b) => b.type === "checklist" ? b.items : []);
const rowOf = (id: string) => t.fixture.db.message.findUniqueOrThrow({ where: { id } });
const counts = async () => ({
  runs: await t.fixture.db.run.count(), messages: await t.fixture.db.message.count(), tasks: await t.fixture.db.task.count(),
  approvals: await t.fixture.db.approval.count(), requests: t.llm.requests.length,
});
let counter = 0;
async function postCard(): Promise<Card> {
  t.llm.script("chat", [call("show_card", CARD)], [text("Here's your plan.")]);
  const frames = await readSse(await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: "Plan my trip", clientId: `checklist-${++counter}` })));
  return CardMessage.parse(messagesOf(frames).find((m) => m.kind === "card"));
}

describe("M24 checklist actions", () => {
  test("the runtime rejects a bad chart, then posts the corrected chart and checkable lists and continues", async () => {
    t.llm.script("chat", [call("show_card", { title: "Bad trend", blocks: [{ type: "line_chart", labels: ["A", "B", "C"], series: [{ name: "N", values: [1, 2] }] }] })]);
    const before = t.llm.sent("chat").length;
    const card = await postCard();
    expect(t.llm.sent("chat").length - before).toBe(3);
    const result = t.llm.sent("chat")[before + 1]!.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("blocks.0.series.0.values");
    expect(await t.fixture.db.message.count({ where: { kind: "card", payload: { contains: "Bad trend" } } })).toBe(0);
    expect<unknown>(card.payload.blocks[0]).toEqual(CARD.blocks[0]);
    expect(itemsOf(card).map((item) => item.id)).toEqual(["c1", "c2", null, "c3"]);
    expect(JSON.parse((await rowOf(card.id)).payload)).toEqual(card.payload);
  });

  test("check/uncheck only changes the named item, persists it, emits message, and is idempotent", async () => {
    const card = await postCard();
    const before = await counts();
    const eventId = await lastEventId(t.fixture);
    const checked = await cardOf(await act(card.id, { action: "check", itemId: "c3" }));
    const expected = structuredClone(card.payload);
    const block = expected.blocks[3]!;
    if (block.type !== "checklist") throw new Error("no checklist");
    block.items[0]!.done = true;
    expect(checked).toEqual({ ...card, payload: expected, updatedAt: checked.updatedAt });
    expect(JSON.parse((await rowOf(card.id)).payload)).toEqual(expected);
    const checkedRow = await rowOf(card.id);
    expect(await cardOf(await act(card.id, { action: "check", itemId: "c3" }))).toEqual(checked);
    expect(await rowOf(card.id)).toEqual(checkedRow);
    const unchecked = await cardOf(await act(card.id, { action: "uncheck", itemId: "c3" }));
    expect(unchecked.payload).toEqual(card.payload);
    expect(await cardOf(await act(card.id, { action: "uncheck", itemId: "c3" }))).toEqual(unchecked);
    expect(await counts()).toEqual(before);
    const events = await storedEvents(t.fixture, t.alex.userId, eventId);
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.type === "message" && event.channelId === card.channelId && event.payload.message.id === card.id)).toBe(true);
    expect(events.map((event) => event.type === "message" && event.payload.message)).toEqual([checked, checked, unchecked, unchecked]);
  });

  test("simultaneous taps on different items do not overwrite each other; repeated taps and a restart keep state", async () => {
    const card = await postCard();
    await Promise.all(["c1", "c3"].map(async (itemId) => cardOf(await act(card.id, { action: "check", itemId }))));
    const current = CardMessage.shape.payload.parse(JSON.parse((await rowOf(card.id)).payload));
    expect(itemsOf({ ...card, payload: current }).map((item) => item.done)).toEqual([true, true, true, true]);
    const [a, b] = await Promise.all([act(card.id, { action: "uncheck", itemId: "c1" }), act(card.id, { action: "uncheck", itemId: "c1" })]);
    expect((await cardOf(a)).payload).toEqual((await cardOf(b)).payload);
    const next = restarted(t.fixture, t.llm);
    try {
      const persisted = await cardOf(await next.app.request(`/api/messages/${card.id}/action`, json(t.alex, "POST", { action: "check", itemId: "c3" })));
      expect(itemsOf(persisted).map((item) => item.done)).toEqual([false, true, true, true]);
    } finally { await next.runs.shutdown(); }
  });

  test("authentication and ownership are enforced; unknown, absent and null item ids are 404 without changes", async () => {
    const card = await postCard();
    const before = await rowOf(card.id);
    const eventId = await lastEventId(t.fixture);
    const anonymous = await t.fixture.app.request(`/api/messages/${card.id}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check", itemId: "c1" }) });
    expect(anonymous.status).toBe(401);
    const foreign = await act(card.id, { action: "check", itemId: "c1" }, sam);
    expect(foreign.status).toBe(404);
    expect((await errorOf(foreign)).code).toBe("not_found");
    for (const action of ["check", "uncheck"]) {
      const missing = await act("missing", { action, itemId: "c1" });
      expect(missing.status).toBe(404);
      for (const itemId of ["missing", "c4", undefined, null]) {
        const response = await act(card.id, { action, itemId });
        expect(response.status).toBe(404);
        expect(await errorOf(response)).toMatchObject({ code: "not_found", field: "itemId" });
      }
    }
    expect(await rowOf(card.id)).toEqual(before);
    expect(await storedEvents(t.fixture, t.alex.userId, eventId)).toEqual([]);
    expect(await storedEvents(t.fixture, sam.userId, eventId)).toEqual([]);
  });

  test("legacy read-only items without ids can never be ticked", async () => {
    const row = await t.fixture.db.message.create({ data: {
      userId: t.alex.userId, channelId: t.alex.mainChannelId, kind: "card", role: "assistant", text: "",
      payload: JSON.stringify({ title: "Status", subtitle: null, icon: "check", tint: "green", actions: [], blocks: [{ type: "checklist", items: [{ text: "Done", done: true }] }] }),
    } });
    for (const action of ["check", "uncheck"]) {
      for (const itemId of ["c1", null]) expect((await act(row.id, { action, itemId })).status).toBe(404);
    }
    expect(await rowOf(row.id)).toEqual(row);
  });

  test("non-card messages and unrelated actions are 400 validation_failed", async () => {
    const card = await postCard();
    const plain = await t.fixture.db.message.findFirstOrThrow({ where: { userId: t.alex.userId, kind: "text" } });
    for (const action of ["check", "uncheck"]) {
      const response = await act(plain.id, { action, itemId: "c1" });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    for (const action of ["done", "start", "dismiss"]) {
      const response = await act(card.id, { action, itemId: "c1" });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
  });

  test("malformed action bodies are rejected before changing a checklist", async () => {
    const card = await postCard();
    const before = await rowOf(card.id);
    for (const body of [{ action: "toggle", itemId: "c1" }, { action: "check", itemId: "" }, { action: "check", itemId: 1 }, { action: "check", itemId: "c1", done: false }]) {
      const response = await act(card.id, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    expect(await rowOf(card.id)).toEqual(before);
  });

  test("a tick in a waiting task changes only the card: no turn, task mutation or wakeup", async () => {
    t.llm.script("task", [call("show_card", CARD), call("ask_form", { title: "Destination", fields: [{ type: "text", label: "Where?" }] })]);
    const response = await t.fixture.app.request("/api/tasks", json(t.alex, "POST", { prompt: "Prepare a trip", channelId: t.alex.mainChannelId }));
    const task = TaskDetail.parse(await response.json());
    await t.fixture.runs.idle();
    const beforeTask = await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(beforeTask.status).toBe("needs_input");
    const row = await t.fixture.db.message.findFirstOrThrow({ where: { taskId: task.id, kind: "card" } });
    const before = await counts();
    const eventId = await lastEventId(t.fixture);
    const checked = await cardOf(await act(row.id, { action: "check", itemId: "c1" }));
    expect(checked.taskId).toBe(task.id);
    expect(itemsOf(checked)[0]).toMatchObject({ id: "c1", done: true });
    expect((await cardOf(await act(row.id, { action: "uncheck", itemId: "c1" }))).payload).toEqual(JSON.parse(row.payload));
    await t.fixture.runs.idle();
    expect(await counts()).toEqual(before);
    expect(await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(beforeTask);
    const events = await storedEvents(t.fixture, t.alex.userId, eventId);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === "message" && event.payload.message.id === row.id)).toBe(true);
  });
});
