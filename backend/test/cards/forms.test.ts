// M9 cards Claude writes (contract §2): ask_form / show_card input checks (a bad call is a tool
// error the model can fix), form submit through POST .../messages { form } (400 field form, 409
// stale_version), Skip (dismiss), ask_form in a task (needs_input), and what the model reads back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildCard, buildForm } from "../../src/cards/tools.ts";
import type { FormPayload } from "../../src/cards/forms.ts";
import { MessageActionResponse, SendMessageRequest, type Message } from "../../src/contract/messages.ts";
import { TaskDetail } from "../../src/contract/tasks.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, messagesOf, startApp, text, type TaskApp } from "../tasks/harness.ts";

let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const channelPath = () => `/api/channels/${t.alex.mainChannelId}/messages`;
const chat = async (body: Record<string, unknown>) => readSse(await t.fixture.app.request(channelPath(), json(t.alex, "POST", body)));
const post = (body: Record<string, unknown>, path = channelPath(), user: SignedIn = t.alex) => t.fixture.app.request(path, json(user, "POST", body));
const act = (messageId: string, body: Record<string, unknown>, user: SignedIn = t.alex) =>
  t.fixture.app.request(`/api/messages/${messageId}/action`, json(user, "POST", body));
const toolResults = (role: "chat" | "task", index: number) =>
  t.llm.sent(role)[index]!.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
const resultText = (block: { content?: unknown }) => JSON.stringify(block.content);

const TRIP = {
  title: "Trip details",
  icon: "plane",
  fields: [
    { type: "single", label: "Seat", options: [{ label: "Window" }, { label: "Aisle", detail: "easier to get up" }], allowOther: true },
    { type: "multi", label: "Extras", options: [{ label: "Bag" }, { label: "Meal" }, { label: "Wi-Fi" }] },
    { type: "text", label: "Notes", placeholder: "Anything else?" },
  ],
};

let counter = 0;
/** One chat turn whose model asks TRIP; returns the stored form card. */
async function askTrip(): Promise<Extract<Message, { kind: "form" }>> {
  t.llm.script("chat", [text("A few questions first:"), call("ask_form", TRIP)]);
  const frames = await chat({ text: "Book my flight", clientId: `ask-${++counter}` });
  const card = messagesOf(frames).findLast((m) => m.kind === "form");
  if (card?.kind !== "form") throw new Error("no form card");
  return card;
}
const submit = (card: { id: string }, answers: unknown[], clientId: string, path = channelPath()) =>
  post({ text: "Seat: Window", clientId, form: { messageId: card.id, answers } }, path);
const stored = async (id: string) => {
  const row = await t.fixture.db.message.findUniqueOrThrow({ where: { id } });
  return { ...row, payload: JSON.parse(row.payload) as FormPayload };
};

describe("ask_form / show_card input", () => {
  test("a bad ask_form call is a tool error the model reads; a good one posts the card and ends the turn", async () => {
    t.llm.script("chat",
      [call("ask_form", { title: "Pick", fields: [{ type: "single", label: "One?", options: [{ label: "Only" }] }] })],
      [call("ask_form", { title: "Pick", fields: [{ type: "single", label: "One?", options: [{ label: "A" }, { label: "B" }] }], bogus: true })],
      [call("ask_form", { title: "Pick", fields: [{ type: "single", label: "One?", options: [{ label: "A" }, { label: "B" }] }] })],
    );
    const before = t.llm.sent("chat").length;
    const frames = await chat({ text: "Help me choose", clientId: "bad-form" });
    // Three model calls and no fourth: ask_form ended the turn.
    expect(t.llm.sent("chat").length - before).toBe(3);
    const [first, second] = [toolResults("chat", before + 1), toolResults("chat", before + 2)];
    expect(first.at(-1)).toMatchObject({ isError: true });
    expect(resultText(first.at(-1)!)).toContain("2-8 options");
    expect(second.at(-1)).toMatchObject({ isError: true });
    expect(resultText(second.at(-1)!)).toContain("Invalid tool arguments");

    const forms = messagesOf(frames).filter((m) => m.kind === "form");
    expect(new Set(forms.map((m) => m.id)).size).toBe(1);
    const card = forms.at(-1)!;
    if (card.kind !== "form") throw new Error("no form");
    expect(card.payload).toMatchObject({ title: "Pick", icon: "question", state: "open", answers: null, submitLabel: null, description: null });
    expect(card.payload.fields).toEqual([{ id: "f1", type: "single", label: "One?", required: true, allowOther: false, options: [{ id: "f1o1", label: "A", detail: null }, { id: "f1o2", label: "B", detail: null }] }]);
    expect(t.llm.remaining("chat")).toBe(0);
  });

  test("buildForm and buildCard reject what the app can't draw", () => {
    const field = (over: Record<string, unknown>) => ({ title: "T", fields: [{ type: "single", label: "Q", ...over }] }) as never;
    expect(buildForm(field({ options: [{ label: "A" }, { label: "a" }] }))).toMatchObject({ ok: false, error: "two options have the same label" });
    expect(buildForm(field({ type: "text", options: [{ label: "A" }] }))).toMatchObject({ ok: false, field: "fields.0.options" });
    expect(buildForm(field({ options: [{ label: "A" }, { label: "B" }], placeholder: "x" }))).toMatchObject({ ok: false, error: "placeholder and multiline are for text fields only" });
    expect(buildForm(field({ type: "multi", options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })) }))).toMatchObject({ ok: false, error: "a multi field needs 2-10 options" });
    const text = buildForm({ title: "T", fields: [{ type: "text", label: "Why?" }] } as never);
    expect(text.ok && text.payload.fields[0]).toEqual({ id: "f1", type: "text", label: "Why?", required: false, placeholder: null, multiline: false });

    const card = (over: Record<string, unknown>) => buildCard({ title: "Status", ...over } as never);
    expect(card({ blocks: [{ type: "bars", bars: [{ label: "Mon", value: 1 }] }] })).toMatchObject({ ok: false, field: "blocks.0.bars" });
    expect(card({ blocks: [{ type: "progress", label: "Done" }] })).toMatchObject({ ok: false, error: "a progress block needs label and value (0 to 1)" });
    expect(card({ blocks: [{ type: "text" }] })).toMatchObject({ ok: false, field: "blocks.0.text" });
    expect(card({ actions: [{ label: "Open", type: "open_url", value: "http://example.com" }] })).toMatchObject({ ok: false, field: "actions.0.value" });
    expect(card({ actions: [{ label: "Open", type: "open_route", value: "https://example.com" }] })).toMatchObject({ ok: false, field: "actions.0.value" });
    expect(card({})).toMatchObject({ ok: true, payload: { icon: "sparkle", tint: "orange", subtitle: null, blocks: [], actions: [] } });
  });

  test("show_card posts an info card and the turn carries on; a bad block is a tool error", async () => {
    t.llm.script("chat",
      [call("show_card", { title: "Weekly sales", blocks: [{ type: "bars", bars: [{ label: "Mon", value: 3 }] }] })],
      [call("show_card", {
        title: "Weekly sales", subtitle: "Oct 20-26", icon: "chart", tint: "green",
        blocks: [
          { type: "metrics", metrics: [{ label: "Revenue", value: "$12k", delta: "+8%", trend: "up" }] },
          { type: "checklist", checklist: [{ text: "Send the recap", done: false }] },
          { type: "bars", bars: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }], unit: "k" },
        ],
        actions: [
          { label: "Send recap", type: "send", value: "Send the weekly recap" },
          { label: "Open report", type: "open_url", value: "https://example.com/report" },
          { label: "Tasks", type: "open_route", value: "duet://tasks" },
        ],
      })],
      [text("Here's the week.")],
    );
    const before = t.llm.sent("chat").length;
    const frames = await chat({ text: "How did we do?", clientId: "card-1" });
    expect(t.llm.sent("chat").length - before).toBe(3);
    expect(toolResults("chat", before + 1).at(-1)).toMatchObject({ isError: true });
    const cards = messagesOf(frames).filter((m) => m.kind === "card");
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    if (card.kind !== "card") throw new Error("no card");
    expect(card.payload).toMatchObject({ icon: "chart", tint: "green", title: "Weekly sales", subtitle: "Oct 20-26" });
    expect(card.payload.blocks.map((b) => b.type)).toEqual(["metrics", "checklist", "bars"]);
    expect(card.payload.actions.map((a) => [a.type, a.style])).toEqual([["send", "primary"], ["open_url", "secondary"], ["open_route", "secondary"]]);
    expect(messagesOf(frames).some((m) => m.role === "assistant" && m.text === "Here's the week.")).toBe(true);
  });
});

describe("task suggestion icons", () => {
  test("propose_tasks keeps a CardIcon per item (null = lightbulb); an unknown key is a tool error", async () => {
    t.llm.script("chat",
      [call("propose_tasks", { tasks: [{ title: "Plan", prompt: "Plan it", icon: "rocket" }] })],
      [call("propose_tasks", { tasks: [{ title: "Reply to Dana", prompt: "Draft a reply to Dana", icon: "mail" }, { title: "Tidy notes", prompt: "Tidy my notes" }] })],
    );
    const before = t.llm.sent("chat").length;
    const frames = await chat({ text: "Ideas?", clientId: "icons-1" });
    expect(toolResults("chat", before + 1).at(-1)).toMatchObject({ isError: true });
    const card = messagesOf(frames).find((m) => m.kind === "task_suggestions");
    expect(card?.kind === "task_suggestions" && card.payload.items.map((i) => i.icon)).toEqual(["mail", null]);
  });
});

describe("form submit", () => {
  test("answers are checked against the card: 400 validation_failed, field form, and the card stays open", async () => {
    const card = await askTrip();
    const bad: [string, unknown[]][] = [
      ["unknown field", [{ fieldId: "nope", optionIds: [] }]],
      ["option of another field", [{ fieldId: "f1", optionIds: ["f2o1"] }, { fieldId: "f2", optionIds: ["f2o1"] }]],
      ["two options on a single field", [{ fieldId: "f1", optionIds: ["f1o1", "f1o2"] }, { fieldId: "f2", optionIds: ["f2o1"] }]],
      ["option plus Other text on a single field", [{ fieldId: "f1", optionIds: ["f1o1"], text: "Exit row" }, { fieldId: "f2", optionIds: ["f2o1"] }]],
      ["a required field left out", [{ fieldId: "f1", optionIds: ["f1o1"] }]],
      ["typed text where Other isn't allowed", [{ fieldId: "f1", optionIds: ["f1o1"] }, { fieldId: "f2", optionIds: [], text: "Lounge" }]],
      ["options on a text field", [{ fieldId: "f1", optionIds: ["f1o1"] }, { fieldId: "f2", optionIds: ["f2o1"] }, { fieldId: "f3", optionIds: ["f2o1"] }]],
      ["a field answered twice", [{ fieldId: "f1", optionIds: ["f1o1"] }, { fieldId: "f1", optionIds: ["f1o2"] }, { fieldId: "f2", optionIds: ["f2o1"] }]],
    ];
    for (const [label, answers] of bad) {
      const response = await submit(card, answers, `bad-${label}`);
      expect({ label, status: response.status }).toEqual({ label, status: 400 });
      expect(await errorOf(response)).toMatchObject({ code: "validation_failed", field: "form" });
    }
    const notForm = await post({ text: "x", clientId: "not-form", form: { messageId: (await t.fixture.db.message.findFirstOrThrow({ where: { clientId: "bad-form" } })).id, answers: [{ fieldId: "f1", optionIds: [] }] } });
    expect(await errorOf(notForm)).toMatchObject({ code: "validation_failed", field: "form" });
    expect((await stored(card.id)).payload.state).toBe("open");
    expect(await t.fixture.db.message.count({ where: { clientId: { startsWith: "bad-" }, role: "user", kind: "text", text: "Seat: Window" } })).toBe(0);
  });

  test("a good submit turns the card submitted, stores the user's text and runs a normal turn that reads the answers", async () => {
    const card = await askTrip();
    t.llm.script("chat", [text("Booked: aisle seat with a bag and a meal.")]);
    const frames = await readSse(await submit(card, [
      { fieldId: "f2", optionIds: ["f2o2", "f2o1"] },
      { fieldId: "f1", optionIds: [], text: "Exit row" },
      { fieldId: "f3", optionIds: [], text: "   " },
    ], "submit-1"));
    const updated = messagesOf(frames).find((m) => m.id === card.id);
    expect(updated?.kind === "form" && updated.payload).toMatchObject({ state: "submitted", answers: [
      { fieldId: "f1", optionIds: [], text: "Exit row" },
      { fieldId: "f2", optionIds: ["f2o2", "f2o1"], text: null },
    ] });
    const mine = messagesOf(frames).find((m) => m.role === "user")!;
    expect(mine).toMatchObject({ kind: "text", text: "Seat: Window", taskId: null });
    // The model reads the server's summary, not the app's text.
    const request = t.llm.sent("chat").at(-1)!;
    expect(request.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Form \"Trip details\" answered: Seat: Exit row\nExtras: Meal, Bag" }] });
    expect(JSON.stringify(request.messages)).toContain("[form \\\"Trip details\\\" (answered)]");
    // The server's note stays in the stored row; the app's payload doesn't carry it.
    expect(mine.payload).not.toHaveProperty("form");
    expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: mine.id } })).payload).form).toMatchObject({ messageId: card.id, title: "Trip details" });

    // A later turn still reads the answered line in its history.
    t.llm.script("chat", [text("Anything else?")]);
    await chat({ text: "Thanks", clientId: "after-submit" });
    expect(JSON.stringify(t.llm.sent("chat").at(-1)!.messages)).toContain("Form \\\"Trip details\\\" answered: Seat: Exit row");
  });

  test("a card that isn't open any more is 409 stale_version, and nothing is stored", async () => {
    const card = await askTrip();
    t.llm.script("chat", [text("Got it.")]);
    await readSse(await submit(card, [{ fieldId: "f1", optionIds: ["f1o1"] }, { fieldId: "f2", optionIds: ["f2o3"] }], "stale-1"));
    const users = await t.fixture.db.message.count({ where: { role: "user" } });
    const again = await submit(card, [{ fieldId: "f1", optionIds: ["f1o2"] }, { fieldId: "f2", optionIds: ["f2o1"] }], "stale-2");
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toMatchObject({ code: "stale_version", field: "form" });
    expect(await t.fixture.db.message.count({ where: { role: "user" } })).toBe(users);
    expect((await stored(card.id)).payload.answers).toEqual([{ fieldId: "f1", optionIds: ["f1o1"], text: null }, { fieldId: "f2", optionIds: ["f2o3"], text: null }]);
    // Skipping a submitted form is 409 too.
    expect((await act(card.id, { action: "dismiss" })).status).toBe(409);
  });

  test("answers without a text key parse as text null (Swift drops nil keys)", async () => {
    const parsed = SendMessageRequest.parse({ text: "Seat: Window", clientId: "c", form: { messageId: "m1", answers: [{ fieldId: "f1", optionIds: ["f1o1"] }] } });
    expect(parsed.form?.answers).toEqual([{ fieldId: "f1", optionIds: ["f1o1"], text: null }]);
    const card = await askTrip();
    t.llm.script("chat", [text("Window and Wi-Fi, done.")]);
    const response = await submit(card, [{ fieldId: "f1", optionIds: ["f1o1"] }, { fieldId: "f2", optionIds: ["f2o3"] }], "no-text-key");
    expect(response.status).toBe(200);
    await readSse(response);
    expect((await stored(card.id)).payload).toMatchObject({ state: "submitted", answers: [{ fieldId: "f1", optionIds: ["f1o1"], text: null }, { fieldId: "f2", optionIds: ["f2o3"], text: null }] });
  });
});

describe("form Skip (dismiss)", () => {
  test("dismiss turns the form dismissed with no turn and no post; twice is fine; a submit after is 409", async () => {
    const card = await askTrip();
    const runs = await t.fixture.db.run.count();
    const messages = await t.fixture.db.message.count();
    const response = await act(card.id, { action: "dismiss" });
    expect(response.status).toBe(200);
    const dismissed = MessageActionResponse.parse(await response.json()).message;
    expect(dismissed.kind === "form" && dismissed.payload).toMatchObject({ state: "dismissed", answers: null });
    expect((await act(card.id, { action: "dismiss" })).status).toBe(200);
    expect(await t.fixture.db.run.count()).toBe(runs);
    expect(await t.fixture.db.message.count()).toBe(messages);
    expect((await submit(card, [{ fieldId: "f1", optionIds: ["f1o1"] }, { fieldId: "f2", optionIds: ["f2o1"] }], "after-skip")).status).toBe(409);
    expect((await act(card.id, { action: "start" })).status).toBe(400);
    expect((await act(card.id, { action: "dismiss" }, sam)).status).toBe(404);
    // The model later reads that the user skipped it.
    t.llm.script("chat", [text("No problem.")]);
    await chat({ text: "Never mind", clientId: "after-dismiss" });
    expect(JSON.stringify(t.llm.sent("chat").at(-1)!.messages)).toContain("(the user skipped it)");
  });
});

describe("ask_form in a task", () => {
  test("the task waits (needs_input) after ask_form; its form is answered in the task's own thread", async () => {
    t.llm.script("task", [call("ask_form", { title: "Venue", fields: [{ type: "single", label: "Which city?", options: [{ label: "Lisbon" }, { label: "Porto" }] }] })]);
    const before = t.llm.sent("task").length;
    const created = TaskDetail.parse(await (await post({ prompt: "Plan the offsite", channelId: t.alex.mainChannelId }, "/api/tasks")).json());
    await t.fixture.runs.idle();
    expect(t.llm.sent("task").length - before).toBe(1);
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("needs_input");
    const card = await t.fixture.db.message.findFirstOrThrow({ where: { taskId: created.id, kind: "form" } });

    // The channel's route doesn't take a task's card.
    const elsewhere = await submit(card, [{ fieldId: "f1", optionIds: ["f1o1"] }], "task-form-wrong");
    expect(await errorOf(elsewhere)).toMatchObject({ code: "validation_failed", field: "form" });

    t.llm.script("task", [text("Lisbon it is."), call("finish_task", { summary: "Lisbon booked." })]);
    const frames = await readSse(await submit(card, [{ fieldId: "f1", optionIds: ["f1o1"] }], "task-form", `/api/tasks/${created.id}/messages`));
    expect(messagesOf(frames).find((m) => m.id === card.id)).toMatchObject({ payload: { state: "submitted" } });
    await t.fixture.runs.idle();
    expect(t.llm.sent("task").at(-1)!.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Form \"Venue\" answered: Which city?: Lisbon" }] });
    // M18: finish_task with nothing of the user's touched resolves the task.
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("resolved");
  });
});

describe("withdraw_card", () => {
  const simplePayload = (title: string) => {
    const built = buildForm({ title, fields: [{ type: "text", label: "Details" }] });
    if (!built.ok) throw new Error(built.error);
    return built.payload;
  };
  const askTitle = async (title: string) => {
    t.llm.script("chat", [call("ask_form", { title, fields: [{ type: "text", label: "Details" }] })]);
    const frames = await chat({ text: `Ask ${title}`, clientId: `withdraw-ask-${++counter}` });
    const card = messagesOf(frames).findLast((message) => message.kind === "form");
    if (!card || card.kind !== "form") throw new Error("no form card");
    return card;
  };
  const withdraw = async (input: Record<string, unknown>) => {
    t.llm.script("chat", [call("withdraw_card", input)], [text("The requested card is withdrawn.")]);
    await chat({ text: "Please withdraw that card", clientId: `withdraw-${++counter}` });
    const result = t.llm.sent("chat").flatMap((request) => request.messages.flatMap((message) => message.content)).findLast((block) => block.type === "tool_result");
    if (!result || result.type !== "tool_result" || result.content[0]?.type !== "text") throw new Error("no withdraw result");
    return { data: JSON.parse(result.content[0].text) as Record<string, unknown>, isError: result.isError === true };
  };

  test("withdraws by trimmed case-insensitive title, reports remaining cards, and leaves other kinds and threads alone", async () => {
    const target = await askTitle("Notion page location");
    const remaining = await askTitle("Keep this question");
    const approval = await t.fixture.db.message.create({ data: {
      userId: t.alex.userId, channelId: t.alex.mainChannelId, role: "assistant", kind: "approval", text: "", payload: "{}", status: "sent",
    } });
    const userMessage = await t.fixture.db.message.create({ data: {
      userId: t.alex.userId, channelId: t.alex.mainChannelId, role: "user", kind: "text", text: "Keep my message", payload: JSON.stringify({ skill: null }), status: "seen",
    } });
    const otherChannel = await t.fixture.db.channel.create({ data: { userId: t.alex.userId, isMain: false, name: "Other" } });
    const otherChannelCard = await t.fixture.db.message.create({ data: {
      userId: t.alex.userId, channelId: otherChannel.id, role: "assistant", kind: "form", text: "", payload: JSON.stringify(simplePayload("Other channel")), status: "sent",
    } });
    const otherTask = await t.fixture.db.task.create({ data: { userId: t.alex.userId, channelId: otherChannel.id, title: "Other task", prompt: "Other task", status: "working" } as never });
    const otherTaskCard = await t.fixture.db.message.create({ data: {
      userId: t.alex.userId, channelId: otherChannel.id, taskId: otherTask.id, role: "assistant", kind: "form", text: "", payload: JSON.stringify(simplePayload("Other task card")), status: "sent",
    } });

    const byTitle = await withdraw({ title: "  NOTION PAGE LOCATION " });
    expect(byTitle.isError).toBe(false);
    expect(byTitle.data.withdrawn).toEqual(["Notion page location"]);
    expect(byTitle.data.remaining).toEqual(expect.arrayContaining(["Keep this question", "Pick", "Trip details"]));
    expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: target.id } })).payload)).toMatchObject({ state: "dismissed", closedBy: "assistant" });
    expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: remaining.id } })).payload).state).toBe("open");
    expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: approval.id } })).payload).toBe("{}");
    expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: userMessage.id } })).text).toBe("Keep my message");
    expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: otherChannelCard.id } })).payload).state).toBe("open");
    expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: otherTaskCard.id } })).payload).state).toBe("open");

    const all = await withdraw({ all: true });
    expect(all.isError).toBe(false);
    expect(all.data.withdrawn).toEqual(expect.arrayContaining(["Keep this question"]));
    expect(all.data.remaining).toEqual([]);
    const again = await withdraw({ all: true });
    expect(again).toMatchObject({ isError: false, data: { withdrawn: [], remaining: [] } });
  });
  test("withdraws a task card and refreshes the task nextStep", async () => {
    t.llm.script("task", [call("ask_form", { title: "Task question", fields: [{ type: "text", label: "Details" }] })]);
    const created = TaskDetail.parse(await (await post({ prompt: "Work on the task", channelId: t.alex.mainChannelId }, "/api/tasks")).json());
    await t.fixture.runs.idle();
    const card = await t.fixture.db.message.findFirstOrThrow({ where: { taskId: created.id, kind: "form" } });
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: created.id } })).nextStep).not.toBeNull();
    t.llm.script("task", [call("withdraw_card", { title: "task question" })], [text("I withdrew that question.")]);
    await readSse(await post({ text: "Cancel the question", clientId: "withdraw-task" }, `/api/tasks/${created.id}/messages`));
    await t.fixture.runs.idle();
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: created.id } })).nextStep).toBeNull();
    expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: card.id } })).payload)).toMatchObject({ state: "dismissed", closedBy: "assistant" });
  });

  test("requires exactly one selector and never errors when no card matches", async () => {
    const neither = await withdraw({});
    expect(neither).toMatchObject({ isError: true, data: { error: "Invalid tool arguments" } });
    const both = await withdraw({ title: "x", all: true });
    expect(both).toMatchObject({ isError: true, data: { error: "Invalid tool arguments" } });
    const missing = await withdraw({ title: "does not exist" });
    expect(missing).toMatchObject({ isError: false, data: { withdrawn: [] } });
  });
});
