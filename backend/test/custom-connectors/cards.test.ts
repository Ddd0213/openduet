// M11 connection cards: request_secret / request_connection post a card and end the turn; POST
// /api/messages/:id/connect creates the connector exactly like "Add connector" (verified first; a
// failure is 400 and the card stays open), turns it on in the card's channel, posts
// system.connection_added and carries the thread on (a chat turn, or the task's own turn); a card
// that isn't open is 409; app cards can't be submitted and turn connected when the account is
// active; dismiss through /action.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "../../src/contract/messages.ts";
import { errorOf } from "../helpers/http.ts";
import { call, chatIn, FakeMcp, get, json, newChannel, resultsIn, startChannels, text, thread, toolNames, waitFor, type ChannelApp } from "../channels/harness.ts";

let m: ChannelApp;
const mcp = new FakeMcp();
beforeAll(async () => {
  m = await startChannels();
  mcp.tools = [{ name: "list_issues", annotations: { readOnlyHint: true } }];
  mcp.required = { "x-token": "tok-correct-5566" };
  m.net.route("issues.example.com", mcp.handler);
});
afterAll(() => m.cleanup());

const connect = (messageId: string, body: Record<string, unknown>, user = m.alex) => m.fixture.app.request(`/api/messages/${messageId}/connect`, json(user, "POST", body));
const cardIn = async (channelId: string): Promise<Extract<Message, { kind: "connection_request" }>> => {
  const card = (await thread(m, m.alex, channelId)).filter((x) => x.kind === "connection_request").at(-1);
  if (!card || card.kind !== "connection_request") throw new Error("no connection card");
  return card;
};

describe("request_secret card", () => {
  test("posts an api_key card and ends the turn; submit connects it in that channel, says so and carries on; again 409", async () => {
    const channel = await newChannel(m, m.alex, { name: "Forecasts" });
    m.llm.script("chat", [call("request_secret", { name: "Weather", purpose: "Get the forecast for your trip", domain: "https://api.weather.example.com/v1" })]);
    const before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, channel.id, "what's the weather in Oslo?");
    // endTurn: one model call only.
    expect(m.llm.sent("chat").length).toBe(before + 1);
    expect(m.llm.sent("chat").at(-1)!.system).toContain("request_secret");
    const card = await cardIn(channel.id);
    expect(card.payload).toEqual({
      type: "api_key", name: "Weather", purpose: "Get the forecast for your trip", url: null, domain: "api.weather.example.com", toolkit: null,
      headerName: "Authorization", valuePrefix: "Bearer ", fields: [{ key: "key", label: "Weather API key", secret: true, placeholder: null }], state: "open", connectorId: null,
    });

    m.llm.script("chat", [text("Connected. Oslo: 4°C and rain.")]);
    const res = await connect(card.id, { values: { key: "wx-card-key-778899" } });
    expect(res.status).toBe(200);
    const { message } = await res.json() as { message: Message };
    if (message.kind !== "connection_request") throw new Error("kind");
    expect(message.payload).toMatchObject({ state: "connected", name: "Weather", domain: "api.weather.example.com" });
    const connectorId = message.payload.connectorId!;
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connectorId } });
    expect([row.kind, row.domain, row.headerName, row.valuePrefix]).toEqual(["api_key", "api.weather.example.com", "Authorization", "Bearer "]);
    // Made in this channel: on only here.
    expect((await m.system.access.resolve(m.alex.userId, channel.id)).connectors.has(connectorId)).toBe(true);
    const other = await newChannel(m, m.alex, { name: "Elsewhere" });
    expect((await m.system.access.resolve(m.alex.userId, other.id)).connectors.has(connectorId)).toBe(false);

    await m.runs.idle();
    const messages = await thread(m, m.alex, channel.id);
    expect(messages.some((x) => x.kind === "system" && x.payload.phrase.key === "system.connection_added" && JSON.stringify(x.payload.phrase.params) === "{\"name\":{\"type\":\"text\",\"value\":\"Weather\"}}")).toBe(true);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", kind: "text", text: "Connected. Oslo: 4°C and rain." });
    const followUp = m.llm.sent("chat").at(-1)!;
    expect(JSON.stringify(followUp.messages)).toContain("\\\"Weather\\\" is connected now");
    expect(toolNames(followUp)).toContain("call_api");

    const again = await connect(card.id, { values: { key: "another-key-0000" } });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("conflict");
    expect((await connect(card.id, { values: { key: "x" } }, m.sam)).status).toBe(404);
    expect(await m.fixture.db.customConnector.count({ where: { userId: m.alex.userId } })).toBe(1);
  });
});

describe("request_connection card (mcp)", () => {
  test("a failed verification is 400 with the reason and the card stays open; the right value connects it", async () => {
    const channel = await newChannel(m, m.alex, { name: "Issues" });
    m.llm.script("chat", [call("request_connection", { type: "mcp", name: "Issue tracker", purpose: "Read your open issues", url: "https://issues.example.com/mcp", headers: [{ name: "X-Token", label: "Access token", secret: true }] })]);
    await chatIn(m, m.alex, channel.id, "what issues are open?");
    const card = await cardIn(channel.id);
    expect(card.payload).toMatchObject({ type: "mcp", url: "https://issues.example.com/mcp", fields: [{ key: "X-Token", label: "Access token", secret: true, placeholder: null }], state: "open" });

    const wrong = await connect(card.id, { values: { "X-Token": "tok-wrong-0000" } });
    expect(wrong.status).toBe(400);
    const error = await errorOf(wrong);
    expect([error.code, error.field]).toEqual(["validation_failed", "url"]);
    expect(error.message).toContain("refused the credentials");
    expect((await cardIn(channel.id)).payload.state).toBe("open");
    expect(await m.fixture.db.customConnector.count({ where: { kind: "mcp" } })).toBe(0);
    const unknown = await connect(card.id, { values: { "X-Token": "a", Other: "b" } });
    expect([unknown.status, (await errorOf(unknown)).field]).toEqual([400, "values"]);
    const missing = await connect(card.id, { values: {} });
    expect([missing.status, (await errorOf(missing)).field]).toEqual([400, "values.X-Token"]);

    m.llm.script("chat", [text("Here are your issues.")]);
    const ok = await connect(card.id, { values: { "X-Token": "tok-correct-5566" } });
    expect(ok.status).toBe(200);
    await m.runs.idle();
    const connected = await cardIn(channel.id);
    expect(connected.payload).toMatchObject({ state: "connected" });
    const connector = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connected.payload.connectorId! } });
    expect(JSON.parse(connector.headers)).toEqual([{ name: "X-Token", secret: true, value: null }]);
    expect(await m.fixture.db.vaultSecret.count({ where: { ownerId: connector.id, name: "header:X-Token" } })).toBe(1);
  });

  test("Not now dismisses it; then connect is 409", async () => {
    const channel = await newChannel(m, m.alex, { name: "Later" });
    m.llm.script("chat", [call("request_connection", { type: "mcp", name: "Tracker", purpose: "Issues", url: "https://issues.example.com/mcp" })]);
    await chatIn(m, m.alex, channel.id, "connect my tracker");
    const card = await cardIn(channel.id);
    const dismissed = await m.fixture.app.request(`/api/messages/${card.id}/action`, json(m.alex, "POST", { action: "dismiss" }));
    expect(dismissed.status).toBe(200);
    expect((await cardIn(channel.id)).payload.state).toBe("dismissed");
    expect((await cardIn(channel.id)).payload).not.toHaveProperty("closedBy");
    expect((await m.fixture.app.request(`/api/messages/${card.id}/action`, json(m.alex, "POST", { action: "save_skill" }))).status).toBe(400);
    expect((await connect(card.id, { values: {} })).status).toBe(409);
  });

  test("withdraw_card dismisses an open connection request and marks it assistant-closed", async () => {
    const channel = await newChannel(m, m.alex, { name: "Withdraw connection" });
    m.llm.script("chat", [call("request_connection", { type: "mcp", name: "Tracker", purpose: "Issues", url: "https://issues.example.com/mcp" })]);
    await chatIn(m, m.alex, channel.id, "connect the tracker");
    const card = await cardIn(channel.id);
    m.llm.script("chat", [call("withdraw_card", { title: " tracker " })], [text("I withdrew the request.")]);
    await chatIn(m, m.alex, channel.id, "cancel that connection request");
    const request = m.llm.sent("chat").findLast((candidate) => resultsIn(candidate).length > 0);
    expect(resultsIn(request)[0]).toMatchObject({ withdrawn: ["Tracker"], remaining: [] });
    expect((await cardIn(channel.id)).payload).toMatchObject({ state: "dismissed", closedBy: "assistant" });
  });

  test("a card asking for secret:false still stores every typed value in the vault; the list shows only set + last 4", async () => {
    const plain = new FakeMcp();
    plain.tools = [{ name: "read_docs", annotations: { readOnlyHint: true } }];
    plain.required = { authorization: "Bearer user-token-13572468" };
    m.net.route("plain.example.com", plain.handler);
    const channel = await newChannel(m, m.alex, { name: "Plain" });
    m.llm.script("chat", [call("request_connection", { type: "mcp", name: "Plain docs", purpose: "Read the docs", url: "https://plain.example.com/mcp", headers: [{ name: "Authorization", label: "Token", secret: false }] })]);
    await chatIn(m, m.alex, channel.id, "connect the docs");
    const card = await cardIn(channel.id);
    expect(card.payload.fields).toEqual([{ key: "Authorization", label: "Token", secret: true, placeholder: null }]);
    m.llm.script("chat", [text("Connected.")]);
    expect((await connect(card.id, { values: { Authorization: "Bearer user-token-13572468" } })).status).toBe(200);
    await m.runs.idle();
    const connectorId = (await cardIn(channel.id)).payload.connectorId!;
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(JSON.parse(row.headers)).toEqual([{ name: "Authorization", secret: true, value: null }]);
    expect(await m.fixture.db.vaultSecret.count({ where: { ownerId: connectorId, name: "header:Authorization" } })).toBe(1);
    const listed = await (await get(m, m.alex, "/api/custom-connectors")).json() as { connectors: { id: string; headers: unknown[] }[] };
    expect(listed.connectors.find((c) => c.id === connectorId)!.headers).toEqual([{ name: "Authorization", secret: true, value: null, secretInfo: { set: true, last4: "2468" } }]);
    expect(JSON.stringify(listed)).not.toContain("user-token-13572468");
  });
});

describe("request_connection card (app)", () => {
  test("an app card can't be submitted; it turns connected (and on in that channel) once the account is active", async () => {
    const channel = await newChannel(m, m.alex, { name: "Team" });
    await m.system.access.setScope(m.alex.userId, { kind: "app", id: "slack" }, "channels");
    m.llm.script("chat", [call("request_connection", { type: "app", name: "Slack", purpose: "Post the summary to #team" })]);
    await chatIn(m, m.alex, channel.id, "post this to slack");
    const card = await cardIn(channel.id);
    expect(card.payload).toMatchObject({ type: "app", name: "Slack", toolkit: "slack", fields: [], state: "open" });
    const submit = await connect(card.id, { values: {} });
    expect([submit.status, (await errorOf(submit)).field]).toEqual([400, "type"]);

    // The user connects Slack through the existing flow; the next accounts listing syncs the card.
    expect((await m.fixture.app.request("/api/connectors/slack/connect", json(m.alex, "POST"))).status).toBe(200);
    m.fake.connect(m.alex.userId, "slack", "ca_slack_1");
    expect((await get(m, m.alex, "/api/connectors")).status).toBe(200);
    await waitFor(async () => (await cardIn(channel.id)).payload.state === "connected", "the app card to turn connected");
    expect((await m.system.access.resolve(m.alex.userId, channel.id)).allowsApp("slack")).toBe(true);
    expect(await m.fixture.db.message.count({ where: { channelId: channel.id, kind: "system" } })).toBe(0);
    await m.system.access.setScope(m.alex.userId, { kind: "app", id: "slack" }, "all");
  });

  test("an already connected app answers without a card (or says it's off in this channel); unknown apps are an error result", async () => {
    m.fake.connect(m.alex.userId, "gmail", "ca_gmail_1");
    m.connectors.catalog!.invalidateAccounts(m.alex.userId);
    const channel = await newChannel(m, m.alex, { name: "Mail" });
    await m.system.access.setChannel(m.alex.userId, channel.id, { kind: "app", id: "gmail" }, false);
    m.llm.script("chat",
      [call("request_connection", { type: "app", name: "Gmail", purpose: "Read mail" })],
      [call("request_connection", { type: "app", name: "Frobozz", purpose: "x" })],
      [text("ok")],
    );
    const before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, channel.id, "connect gmail");
    const sent = m.llm.sent("chat").slice(before);
    expect(resultsIn(sent[1])[0]).toMatchObject({ status: "turned_off_in_channel", app: "Gmail" });
    expect(resultsIn(sent[2])[0]!.error).toContain("isn't an app the catalog knows");
    m.llm.script("chat", [call("request_connection", { type: "app", name: "Gmail", purpose: "Read mail" })], [text("ok")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "connect gmail");
    expect(resultsIn(m.llm.sent("chat").at(-1))[0]).toMatchObject({ status: "already_connected", app: "Gmail" });
    expect((await thread(m, m.alex, channel.id)).some((x) => x.kind === "connection_request")).toBe(false);
  });
});

describe("a task's card", () => {
  test("submitting a card in a task's session continues that task", async () => {
    m.llm.script("task", [call("request_secret", { name: "Stocks", purpose: "Track prices", domain: "api.stocks.example.com" })]);
    const created = await m.fixture.app.request("/api/tasks", json(m.alex, "POST", { prompt: "Track my stocks", channelId: m.alex.mainChannelId }));
    expect(created.status).toBe(200);
    const task = await created.json() as { id: string };
    const card = await waitFor(() => m.fixture.db.message.findFirst({ where: { taskId: task.id, kind: "connection_request" } }), "the task's card");
    await m.runs.idle();
    const sent = m.llm.sent("task").length;
    m.llm.script("task", [text("Tracking now.")]);
    expect((await connect(card.id, { values: { key: "stocks-key-445566" } })).status).toBe(200);
    await waitFor(async () => m.llm.sent("task").length > sent, "the task's next turn");
    await m.runs.idle();
    expect(JSON.stringify(m.llm.sent("task").at(-1)!.messages)).toContain("is connected now");
    expect(await m.fixture.db.message.count({ where: { taskId: task.id, kind: "system", payload: { contains: "system.connection_added" } } })).toBe(1);
  });
});
