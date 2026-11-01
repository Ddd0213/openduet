// M23 W3 (#28): one item, one answer. propose_task / propose_tasks create (or reuse) the Up next
// row and put its suggestionId on the card; Start / Hide on the card update the row; Add / Hide in
// Up next update the card (state, taskId) with a `message` event; a second Start returns the task
// already made; Up next rows carry sourceRef (never the email id); a source must be read this turn.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolProvider, TurnInput } from "../../src/agent/types.ts";
import { AddSuggestionResponse, UpNext } from "../../src/contract/tasks.ts";
import { MessageActionResponse, type Message } from "../../src/contract/messages.ts";
import { MutedCardError } from "../../src/proactive/turns.ts";
import { createTaskTools } from "../../src/tasks/tools.ts";
import { recordingSink } from "../agent/fixtures.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, lastEventId, messagesOf, ofType, rig, RoleScriptedLlm, storedEvents, text, type TaskApp } from "./harness.ts";

const EMAIL_ID = "18c2f0a1b2c3d4e5";
const EVENT_ID = "evt7q2design0sync";

/** A stand-in for the connectors provider: execute_app_tools returns one Gmail email / one Calendar event. */
const fakeApps: ToolProvider = {
  name: "fake-apps",
  async tools() {
    return [{ name: "execute_app_tools", description: "Run app tools (test).", inputSchema: { type: "object" } }];
  },
  async execute(callBlock) {
    const slug = String(((callBlock.input.calls as { tool?: string }[] | undefined) ?? [])[0]?.tool ?? "");
    const calendar = slug.startsWith("GOOGLECALENDAR");
    const data = calendar
      ? { items: [{ id: EVENT_ID, summary: "Design sync", start: { dateTime: "2030-03-20T14:00:00+08:00" } }] }
      : { messages: [{ messageId: EMAIL_ID, subject: "Re: Q4 budget", from: "priya@example.com" }] };
    const results = [{ index: 0, app: calendar ? "Google Calendar" : "Gmail", tool: calendar ? "List events" : "Fetch emails", status: "ok", data }];
    return { result: { type: "tool_result", toolUseId: callBlock.id, content: [{ type: "text", text: JSON.stringify({ results }) }] }, endTurn: false };
  },
};

let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  const llm = new RoleScriptedLlm();
  let built: ReturnType<typeof rig> | undefined;
  const fixture: TestApp = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      built = rig(core, llm);
      built.providers.push(fakeApps);
      return { agent: built.agent, runs: built.runs, routes: built.tasks.routes };
    },
  });
  t = { fixture, llm, tasks: built!.tasks, alex: await signUp(fixture, "alex") };
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const db = () => t.fixture.db;
const chat = async (body: string, clientId: string) =>
  readSse(await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: body, clientId })));
const act = (messageId: string, body: Record<string, unknown>, user: SignedIn = t.alex) => t.fixture.app.request(`/api/messages/${messageId}/action`, json(user, "POST", body));
const card = async (response: Response): Promise<Message> => {
  expect(response.status).toBe(200);
  return MessageActionResponse.parse(await response.json()).message;
};
const post = (path: string, user: SignedIn = t.alex) => t.fixture.app.request(path, json(user, "POST"));
const upNext = async () => UpNext.parse(await (await t.fixture.app.request("/api/up-next", { headers: t.alex.headers })).json());
const stored = async (id: string) => {
  const row = await db().message.findUniqueOrThrow({ where: { id } });
  return JSON.parse(row.payload) as Record<string, unknown>;
};
const lastResults = () => JSON.stringify(t.llm.sent("chat").at(-1)?.messages ?? []);
const offer = async (title: string, clientId: string, extra: Record<string, unknown> = {}) => {
  t.llm.script("chat", [call("propose_task", { title, body: `Why: ${title}`, prompt: `Do: ${title}`, ...extra })]);
  const found = messagesOf(await chat(`Anything about ${title}?`, clientId)).find((m) => m.kind === "proactive_suggestion");
  if (!found || found.kind !== "proactive_suggestion") throw new Error("no card");
  return found;
};

describe("propose_task and its Up next row", () => {
  test("a card names its row; the row is open in Up next with sourceRef (never the email id) when the source was read this turn", async () => {
    t.llm.script("chat",
      [call("execute_app_tools", { calls: [{ tool: "GMAIL_FETCH_EMAILS", arguments: { query: "budget" } }] })],
      [call("propose_task", { title: "Reply to Priya about Q4", body: "She asked twice.", prompt: "Draft a reply to Priya about the Q4 budget", source: { app: "Gmail", kind: "email", id: EMAIL_ID, title: "Re: Q4 budget", at: "2030-03-19T16:20:00+08:00" } })],
    );
    const posted = messagesOf(await chat("Anything in my inbox?", "s-1")).find((m) => m.kind === "proactive_suggestion")!;
    if (posted.kind !== "proactive_suggestion") throw new Error("no card");
    const row = await db().suggestion.findUniqueOrThrow({ where: { id: posted.payload.suggestionId! } });
    expect(row).toMatchObject({ status: "open", origin: "chat", app: "Gmail", messageId: posted.id, titleKey: "reply to priya about q4", channelId: t.alex.mainChannelId });
    const listed = await (await t.fixture.app.request("/api/up-next", { headers: t.alex.headers })).text();
    expect(listed).not.toContain(EMAIL_ID);
    const item = UpNext.parse(JSON.parse(listed)).suggestions.find((s) => s.id === row.id)!;
    expect(item).toMatchObject({ title: "Reply to Priya about Q4", app: "Gmail", sourceRef: { app: "Gmail", kind: "email", title: "Re: Q4 budget", at: "2030-03-19T08:20:00.000Z" } });
  });

  test("a source this turn didn't read: an error for the model, no card, no row", async () => {
    const before = await db().suggestion.count({ where: { userId: t.alex.userId } });
    t.llm.script("chat", [call("propose_task", { title: "Pay the Northfield invoice", body: "Due Friday.", prompt: "Pay it", source: { app: "Gmail", kind: "email", id: "18ffffffffffffff", title: "Invoice" } })], [text("ok")]);
    const frames = await chat("Anything to pay?", "s-2");
    expect(messagesOf(frames).some((m) => m.kind === "proactive_suggestion")).toBe(false);
    expect(lastResults()).toContain("wasn't read in this turn");
    expect(await db().suggestion.count({ where: { userId: t.alex.userId } })).toBe(before);
  });

  test("the same thing again links to the same row (two cards, one row); hidden in the last 14 days is refused", async () => {
    const first = await offer("Book the offsite venue", "s-3");
    const second = await offer("book the offsite venue!", "s-4");
    expect(second.payload.suggestionId).toBe(first.payload.suggestionId);
    expect(await db().suggestion.count({ where: { userId: t.alex.userId, titleKey: "book the offsite venue" } })).toBe(1);
    expect((await db().suggestion.findUniqueOrThrow({ where: { id: first.payload.suggestionId! } })).messageId).toBe(second.id);

    const hidden = await offer("Unsubscribe from Daily Deals", "s-5");
    await card(await act(hidden.id, { action: "hide" }));
    const row = await db().suggestion.findUniqueOrThrow({ where: { id: hidden.payload.suggestionId! } });
    expect(row.status).toBe("hidden");
    expect(row.hiddenAt).not.toBeNull();
    t.llm.script("chat", [call("propose_task", { title: "Unsubscribe from daily deals", body: "Again", prompt: "Unsubscribe" })], [text("ok")]);
    expect(messagesOf(await chat("Anything else?", "s-6")).some((m) => m.kind === "proactive_suggestion")).toBe(false);
    expect(lastResults()).toContain("The user hid this suggestion");
  });
});

describe("one item, one answer", () => {
  test("Start on the card: the row is added with the task; Add in Up next then returns that task; the second card shows it started", async () => {
    const first = await offer("Prep the design sync", "o-1");
    const twin = await offer("Prep the design sync", "o-2");
    const suggestionId = first.payload.suggestionId!;
    const before = await lastEventId(t.fixture);
    const started = await card(await act(first.id, { action: "start" }));
    if (started.kind !== "proactive_suggestion") throw new Error("wrong card");
    const taskId = started.payload.taskId!;
    expect(await db().suggestion.findUniqueOrThrow({ where: { id: suggestionId } })).toMatchObject({ status: "added", taskId });
    // The other card of the same item follows, with a message event.
    expect(await stored(twin.id)).toMatchObject({ state: "started", taskId, suggestionId });
    const events = ofType(await storedEvents(t.fixture, t.alex.userId, before), "message").map((e) => e.payload.message);
    expect(events.some((m) => m.id === twin.id && m.kind === "proactive_suggestion" && m.payload.state === "started")).toBe(true);
    await t.fixture.runs.idle();

    const added = AddSuggestionResponse.parse(await (await post(`/api/up-next/${suggestionId}/add`)).json());
    expect(added.task.id).toBe(taskId);
    const again = await card(await act(twin.id, { action: "start" }));
    expect(again.kind === "proactive_suggestion" && again.payload.taskId).toBe(taskId);
    expect(await db().task.count({ where: { userId: t.alex.userId, title: "Prep the design sync" } })).toBe(1);
  });

  test("Add in Up next: the card shows started with the task (message event); Start on it then returns that task", async () => {
    const offered = await offer("Draft the Q2 plan", "o-3");
    const before = await lastEventId(t.fixture);
    const { task } = AddSuggestionResponse.parse(await (await post(`/api/up-next/${offered.payload.suggestionId}/add`)).json());
    expect(await stored(offered.id)).toMatchObject({ state: "started", taskId: task.id });
    const events = ofType(await storedEvents(t.fixture, t.alex.userId, before), "message").map((e) => e.payload.message);
    expect(events.some((m) => m.id === offered.id && m.kind === "proactive_suggestion" && m.payload.state === "started" && m.payload.taskId === task.id)).toBe(true);
    await t.fixture.runs.idle();
    const again = await card(await act(offered.id, { action: "start" }));
    expect(again.kind === "proactive_suggestion" && again.payload).toMatchObject({ state: "started", taskId: task.id });
    expect(await db().task.count({ where: { userId: t.alex.userId, title: "Draft the Q2 plan" } })).toBe(1);
    // A card answered elsewhere: propose_task for it again shows nothing and points at the task.
    t.llm.script("chat", [call("propose_task", { title: "Draft the Q2 plan", body: "Again", prompt: "Draft it" })], [text("ok")]);
    expect(messagesOf(await chat("Plan?", "o-3b")).some((m) => m.kind === "proactive_suggestion")).toBe(false);
    expect(lastResults()).toContain(`duet://tasks/${task.id}`);
  });

  test("Hide in Up next hides the card (message event); Hide on a card hides the row with hiddenAt", async () => {
    const offered = await offer("Clean up the shared drive", "o-4");
    const before = await lastEventId(t.fixture);
    expect((await post(`/api/up-next/${offered.payload.suggestionId}/hide`)).status).toBe(204);
    expect(await stored(offered.id)).toMatchObject({ state: "hidden", taskId: null });
    const events = ofType(await storedEvents(t.fixture, t.alex.userId, before), "message").map((e) => e.payload.message);
    expect(events.some((m) => m.id === offered.id && m.kind === "proactive_suggestion" && m.payload.state === "hidden")).toBe(true);
    expect((await db().suggestion.findUniqueOrThrow({ where: { id: offered.payload.suggestionId! } })).hiddenAt).not.toBeNull();
    expect((await upNext()).suggestions.some((s) => s.id === offered.payload.suggestionId)).toBe(false);

    // Hide on a card whose item was already started in Up next shows that task instead.
    const other = await offer("Renew the passport", "o-5");
    const { task } = AddSuggestionResponse.parse(await (await post(`/api/up-next/${other.payload.suggestionId}/add`)).json());
    await t.fixture.runs.idle();
    const shown = await card(await act(other.id, { action: "hide" }));
    expect(shown.kind === "proactive_suggestion" && shown.payload).toMatchObject({ state: "started", taskId: task.id });
    expect((await db().suggestion.findUniqueOrThrow({ where: { id: other.payload.suggestionId! } })).status).toBe("added");
  });

  test("Start on the card and Add in Up next at the same moment make one task", async () => {
    const offered = await offer("Send the board update", "o-6");
    const [fromCard, fromUpNext] = await Promise.all([act(offered.id, { action: "start" }), post(`/api/up-next/${offered.payload.suggestionId}/add`)]);
    const cardTask = (await card(fromCard)).payload as { taskId: string };
    const upNextTask = AddSuggestionResponse.parse(await fromUpNext.json()).task.id;
    expect(cardTask.taskId).toBe(upNextTask);
    expect(await db().task.count({ where: { userId: t.alex.userId, title: "Send the board update" } })).toBe(1);
    await t.fixture.runs.idle();
  });
});

describe("propose_tasks items", () => {
  test("each item names its row; one already started is left out (said in the result); Start / Hide on an item follow to the row and other cards", async () => {
    const done = await offer("Archive the old threads", "i-0");
    const { task: archived } = AddSuggestionResponse.parse(await (await post(`/api/up-next/${done.payload.suggestionId}/add`)).json());
    await t.fixture.runs.idle();
    t.llm.script("chat",
      [call("execute_app_tools", { calls: [{ tool: "GOOGLECALENDAR_LIST_EVENTS", arguments: {} }] })],
      [call("propose_tasks", { tasks: [
        { title: "Agenda for the design sync", prompt: "Draft an agenda", app: "Google Calendar", source: { app: "Google Calendar", kind: "event", id: EVENT_ID, title: "Design sync" } },
        { title: "Reply to the Northfield thread", prompt: "Draft a reply", app: "Gmail" },
        { title: "Archive the old threads", prompt: "Archive them" },
      ] })],
    );
    const tiles = messagesOf(await chat("What can you take off my plate?", "i-1")).find((m) => m.kind === "task_suggestions")!;
    if (tiles.kind !== "task_suggestions") throw new Error("no card");
    expect(tiles.payload.items.map((i) => i.title)).toEqual(["Agenda for the design sync", "Reply to the Northfield thread"]);
    // The tool result says which one was left out and why (the run's record keeps it).
    await t.fixture.runs.idle();
    const step = await db().runStep.findFirstOrThrow({ where: { tool: "propose_tasks", run: { userId: t.alex.userId } }, orderBy: { startedAt: "desc" } });
    expect(step.output).toContain("already_started");
    expect(step.output).toContain(`duet://tasks/${archived.id}`);
    const [agenda, reply] = tiles.payload.items;
    const agendaRow = await db().suggestion.findUniqueOrThrow({ where: { id: agenda!.suggestionId! } });
    expect(agendaRow).toMatchObject({ status: "open", messageId: tiles.id, app: "Google Calendar" });
    expect((await upNext()).suggestions.find((s) => s.id === agendaRow.id)?.sourceRef).toEqual({ app: "Google Calendar", kind: "event", title: "Design sync", at: null });
    expect(await db().task.count({ where: { userId: t.alex.userId, title: "Archive the old threads" } })).toBe(1);

    // The same row on a proactive card too: Start on the item starts it there as well.
    const single = await offer("Agenda for the design sync", "i-2");
    expect(single.payload.suggestionId).toBe(agenda!.suggestionId);
    const started = await card(await act(tiles.id, { action: "start", itemId: agenda!.id }));
    const taskId = started.kind === "task_suggestions" ? started.payload.items[0]!.taskId! : "";
    expect(taskId).toBeTruthy();
    expect(await db().suggestion.findUniqueOrThrow({ where: { id: agendaRow.id } })).toMatchObject({ status: "added", taskId });
    expect(await stored(single.id)).toMatchObject({ state: "started", taskId });
    await t.fixture.runs.idle();

    const hidden = await card(await act(tiles.id, { action: "hide", itemId: reply!.id }));
    expect(hidden.kind === "task_suggestions" && hidden.payload.items.map((i) => i.id)).toEqual([agenda!.id]);
    expect(await db().suggestion.findUniqueOrThrow({ where: { id: reply!.suggestionId! } })).toMatchObject({ status: "hidden" });
  });

  test("Add in Up next sets the item's taskId; Hide in Up next drops it", async () => {
    t.llm.script("chat", [call("propose_tasks", { tasks: [{ title: "Order the team lunch", prompt: "Order lunch" }, { title: "Book the meeting room", prompt: "Book it" }] })]);
    const tiles = messagesOf(await chat("Anything for Friday?", "i-3")).find((m) => m.kind === "task_suggestions")!;
    if (tiles.kind !== "task_suggestions") throw new Error("no card");
    const [lunch, room] = tiles.payload.items;
    const { task } = AddSuggestionResponse.parse(await (await post(`/api/up-next/${lunch!.suggestionId}/add`)).json());
    expect((await post(`/api/up-next/${room!.suggestionId}/hide`)).status).toBe(204);
    expect(await stored(tiles.id)).toEqual({ items: [{ ...lunch, taskId: task.id }] });
    await t.fixture.runs.idle();
    // Start on the item now answers with that task (no second one, no new user message).
    const before = await db().message.count({ where: { userId: t.alex.userId, role: "user" } });
    const again = await card(await act(tiles.id, { action: "start", itemId: lunch!.id }));
    expect(again.kind === "task_suggestions" && again.payload.items[0]!.taskId).toBe(task.id);
    expect(await db().message.count({ where: { userId: t.alex.userId, role: "user" } })).toBe(before);
    expect(await db().task.count({ where: { userId: t.alex.userId, title: "Order the team lunch" } })).toBe(1);
  });
});

describe("rows and cards stay together", () => {
  test("a card that can't be shown (a muted turn) leaves no row behind", async () => {
    const tools = createTaskTools(t.tasks.service, db());
    const recording = recordingSink(t.alex.mainChannelId);
    const message: Message = {
      id: "turn_scan_1", channelId: t.alex.mainChannelId, taskId: null, role: "user", kind: "text", text: "", status: "seen",
      clientId: null, reactions: [], stopped: false, callId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null },
    };
    const input: TurnInput = {
      userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: null, kind: "scan", runId: "run_scan_1", userMessage: message, attachments: [], skill: null,
      sink: { ...recording.sink, upsertMessage: async (draft) => { throw new MutedCardError(draft.kind); } }, signal: new AbortController().signal,
    };
    await expect(tools.execute({ type: "tool_use", id: "c1", name: "propose_task", input: { title: "Muted one", body: "b", prompt: "p" } }, input)).rejects.toThrow(MutedCardError);
    expect(await db().suggestion.count({ where: { userId: t.alex.userId, title: "Muted one" } })).toBe(0);
  });

  test("Save for Up next keeps its titleKey; someone else's card or row stays theirs", async () => {
    const saved = await t.fixture.app.request("/api/up-next", json(t.alex, "POST", { prompt: "Find a dentist near the office", channelId: t.alex.mainChannelId }));
    expect(saved.status).toBe(201);
    expect((await db().suggestion.findFirstOrThrow({ where: { userId: t.alex.userId, fromUser: true } })).titleKey).toBeTruthy();
    const offered = await offer("Water the plants", "x-1");
    expect((await act(offered.id, { action: "start" }, sam)).status).toBe(404);
    expect((await post(`/api/up-next/${offered.payload.suggestionId}/add`, sam)).status).toBe(404);
    expect(await stored(offered.id)).toMatchObject({ state: "open" });
  });
});
