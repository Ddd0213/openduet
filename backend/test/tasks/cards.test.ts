// Card actions (POST /api/messages/:id/action, L103-L104) and the tools that post the cards:
// propose_tasks -> task_suggestions (Start sends the prompt and starts the task, the item gets its
// taskId; Hide drops it), propose_task -> proactive_suggestion (Start / Hide), plate Done; M6
// actions are 400 and someone else's card is 404.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { phrase } from "../../src/agent/phrase.ts";
import { MessageActionResponse, type Message } from "../../src/contract/messages.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, lastEventId, messagesOf, ofType, startApp, storedEvents, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const chat = async (body: string, clientId: string) =>
  readSse(await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: body, clientId })));
const act = (messageId: string, body: Record<string, unknown>, user: SignedIn = t.alex) =>
  t.fixture.app.request(`/api/messages/${messageId}/action`, json(user, "POST", body));
const card = async (response: Response): Promise<Message> => {
  expect(response.status).toBe(200);
  return MessageActionResponse.parse(await response.json()).message;
};

describe("task suggestions", () => {
  test("propose_tasks posts the card with its lead; Start sends the prompt as the user and starts the task; Hide drops an item", async () => {
    t.llm.script("chat", [call("propose_tasks", { tasks: [
      { title: "Draft the launch review agenda", prompt: "Draft an agenda for Tuesday's launch review", app: "Google Calendar" },
      { title: "Reply to the Northfield thread", prompt: "Draft a reply to the Northfield renewal email", app: "Gmail" },
    ] })]);
    const frames = await chat("What can you take off my plate?", "c-1");
    const posted = messagesOf(frames).find((m) => m.kind === "task_suggestions")!;
    expect(posted.text).toBe(phrase("agent.places_to_start", "en"));
    if (posted.kind !== "task_suggestions") throw new Error("no card");
    expect(posted.payload.items.map((i) => [i.title, i.app, i.taskId])).toEqual([["Draft the launch review agenda", "Google Calendar", null], ["Reply to the Northfield thread", "Gmail", null]]);
    expect(ofType(frames, "status").map((e) => e.payload.status)).not.toContain("starting_task");
    const [first, second] = posted.payload.items;

    const before = await lastEventId(t.fixture);
    const started = await card(await act(posted.id, { action: "start", itemId: first!.id }));
    if (started.kind !== "task_suggestions") throw new Error("wrong card");
    const taskId = started.payload.items[0]!.taskId!;
    expect(taskId).toBeTruthy();
    expect(started.payload.items[1]!.taskId).toBeNull();
    expect(await t.fixture.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ title: first!.title, prompt: first!.prompt, source: "user", channelId: t.alex.mainChannelId });

    const posts = ofType(await storedEvents(t.fixture, t.alex.userId, before), "message").map((e) => e.payload.message);
    const sent = posts.find((m) => m.role === "user")!;
    expect(sent).toMatchObject({ text: first!.prompt, taskId: null });
    const chip = posts.find((m) => m.kind === "task_spawn")!;
    expect(chip.kind === "task_spawn" && chip.payload).toMatchObject({ anchorMessageId: sent.id, task: { id: taskId } });
    expect(posts.some((m) => m.role === "assistant" && m.text === phrase("agent.on_it", "en"))).toBe(true);
    await t.fixture.runs.idle();

    // A second tap keeps the first task.
    const again = await card(await act(posted.id, { action: "start", itemId: first!.id }));
    expect(again.kind === "task_suggestions" && again.payload.items[0]!.taskId).toBe(taskId);
    expect(await t.fixture.db.task.count({ where: { userId: t.alex.userId, title: first!.title } })).toBe(1);

    const hidden = await card(await act(posted.id, { action: "hide", itemId: second!.id }));
    expect(hidden.kind === "task_suggestions" && hidden.payload.items.map((i) => i.id)).toEqual([first!.id]);

    for (const body of [{ action: "start" }, { action: "start", itemId: "nope" }, { action: "done", itemId: first!.id }, { action: "save_skill" }, { action: "dismiss" }]) {
      const response = await act(posted.id, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
  });

  test("two taps at once start one task", async () => {
    t.llm.script("chat", [call("propose_tasks", { lead: "Here's where I'd start:", tasks: [{ title: "Tidy the inbox", prompt: "Archive newsletters older than a week" }] })]);
    const posted = messagesOf(await chat("Anything else?", "c-2")).find((m) => m.kind === "task_suggestions")!;
    expect(posted.text).toBe("Here's where I'd start:");
    if (posted.kind !== "task_suggestions") throw new Error("no card");
    const itemId = posted.payload.items[0]!.id;
    const [a, b] = await Promise.all([act(posted.id, { action: "start", itemId }), act(posted.id, { action: "start", itemId })]);
    const ids = [await card(a), await card(b)].map((m) => (m.kind === "task_suggestions" ? m.payload.items[0]!.taskId : null));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]!);
    expect(await t.fixture.db.task.count({ where: { userId: t.alex.userId, title: "Tidy the inbox" } })).toBe(1);
    await t.fixture.runs.idle();
  });
});

describe("proactive suggestion", () => {
  test("propose_task posts the lead and the card; Start makes a proactive task once; Hide; the lead follows User.language", async () => {
    t.llm.script("chat", [call("propose_task", { title: "Prep for the 2 PM", body: "Pull notes and open questions for the design sync.", prompt: "Prep me for the 2 PM design sync" })]);
    const frames = await chat("Anything I should prep?", "p-1");
    const posted = messagesOf(frames).find((m) => m.kind === "proactive_suggestion")!;
    expect(posted.text).toBe(phrase("agent.task_suggestion_lead", "en"));
    // M23: the card names its Up next row.
    expect(posted.kind === "proactive_suggestion" && posted.payload).toEqual({ title: "Prep for the 2 PM", body: "Pull notes and open questions for the design sync.", prompt: "Prep me for the 2 PM design sync", state: "open", taskId: null, suggestionId: expect.any(String) });

    const started = await card(await act(posted.id, { action: "start" }));
    if (started.kind !== "proactive_suggestion") throw new Error("wrong card");
    expect(started.payload.state).toBe("started");
    const task = await t.fixture.db.task.findUniqueOrThrow({ where: { id: started.payload.taskId! } });
    expect(task).toMatchObject({ source: "proactive", title: "Prep for the 2 PM", description: "Pull notes and open questions for the design sync.", prompt: "Prep me for the 2 PM design sync", spawnMessageId: null });
    expect(task.noticedAt?.toISOString()).toBe(posted.createdAt);
    await t.fixture.runs.idle();

    const again = await card(await act(posted.id, { action: "start" }));
    expect(again.kind === "proactive_suggestion" && again.payload.taskId).toBe(task.id);
    const notHidden = await card(await act(posted.id, { action: "hide" }));
    expect(notHidden.kind === "proactive_suggestion" && notHidden.payload.state).toBe("started");
    expect(await t.fixture.db.task.count({ where: { title: "Prep for the 2 PM" } })).toBe(1);

    await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "zh-Hans" } });
    t.llm.script("chat", [call("propose_task", { title: "整理周报", body: "汇总本周进展。", prompt: "帮我整理这周的周报" })]);
    const zh = messagesOf(await chat("还有吗？", "p-2")).find((m) => m.kind === "proactive_suggestion")!;
    expect(zh.text).toBe(phrase("agent.task_suggestion_lead", "zh-Hans"));
    const hidden = await card(await act(zh.id, { action: "hide" }));
    expect(hidden.kind === "proactive_suggestion" && hidden.payload).toMatchObject({ state: "hidden", taskId: null });
    await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "en" } });
  });
});

describe("plate and other cards", () => {
  test("Done marks a plate row; other actions on it are 400", async () => {
    const plate = await t.fixture.db.message.create({ data: {
      userId: t.alex.userId, channelId: t.alex.mainChannelId, role: "assistant", kind: "plate", text: "",
      payload: JSON.stringify({ items: [
        { id: "p1", title: "Review the deck", detail: "Due today", action: { label: "Review", prompt: "Review the launch deck" }, done: false },
        { id: "p2", title: "Book the room", detail: "Tomorrow", action: { label: "Book", prompt: "Book a room for tomorrow" }, done: false },
      ] }),
    } });
    const done = await card(await act(plate.id, { action: "done", itemId: "p1" }));
    expect(done.kind === "plate" && done.payload.items.map((i) => i.done)).toEqual([true, false]);
    const again = await card(await act(plate.id, { action: "done", itemId: "p1" }));
    expect(again.kind === "plate" && again.payload.items.map((i) => i.done)).toEqual([true, false]);
    for (const body of [{ action: "start", itemId: "p2" }, { action: "done" }, { action: "done", itemId: "zz" }]) expect((await act(plate.id, body)).status).toBe(400);
  });

  test("someone else's card is 404; a message without actions is 400; a bad body is 400", async () => {
    const plain = await t.fixture.db.message.findFirstOrThrow({ where: { userId: t.alex.userId, kind: "text", role: "assistant" } });
    const response = await act(plain.id, { action: "start" }, sam);
    expect(response.status).toBe(404);
    expect((await act("missing", { action: "start" })).status).toBe(404);
    expect((await act(plain.id, { action: "start" })).status).toBe(400);
    expect((await act(plain.id, { action: "launch" })).status).toBe(400);
    expect((await act(plain.id, { action: "start", extra: 1 })).status).toBe(400);
    t.llm.script("chat", [text("ok")]);
  });
});
