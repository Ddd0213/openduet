// Reactions (L157): PUT / DELETE /api/messages/:id/reactions/:emoji (the user's own threads, by
// "user", idempotent), Claude's react tool (by "assistant", only on the user's messages), the message
// re-emitted with its reactions (`message` event) and serialized with them on every read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ReactionResponse, type Message } from "../../src/contract/messages.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, chat, json, lastEventId, messagesOf, ofType, startMake, storedEvents, text, timeline, toolResults, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
let sam: SignedIn;
let mine: Message;
let assistantMessage: Message;
beforeAll(async () => {
  m = await startMake();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
  m.llm.script("chat", [text("Morning! Here's your day.")]);
  const frames = await chat(m, "Morning", "r-1");
  mine = messagesOf(frames).find((x) => x.role === "user")!;
  assistantMessage = messagesOf(frames).filter((x) => x.role === "assistant" && x.kind === "text").at(-1)!;
});
afterAll(() => m.fixture.cleanup());

const react = (id: string, emoji: string, method: "PUT" | "DELETE", user: SignedIn = m.alex) =>
  m.fixture.app.request(`/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`, json(user, method));
const reactionsOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return ReactionResponse.parse(await response.json()).message.reactions;
};

describe("user reactions", () => {
  test("PUT adds (idempotent), DELETE removes; the message event carries them; reads include them", async () => {
    const before = await lastEventId(m.fixture);
    expect(await reactionsOf(await react(assistantMessage.id, "👍", "PUT"))).toEqual([{ emoji: "👍", by: "user" }]);
    expect(await reactionsOf(await react(assistantMessage.id, "👍", "PUT"))).toEqual([{ emoji: "👍", by: "user" }]);
    expect(await reactionsOf(await react(assistantMessage.id, "❤️", "PUT"))).toEqual([{ emoji: "👍", by: "user" }, { emoji: "❤️", by: "user" }]);
    expect(await reactionsOf(await react(mine.id, "⭐", "PUT"))).toEqual([{ emoji: "⭐", by: "user" }]);
    const events = ofType(await storedEvents(m.fixture, m.alex.userId, before), "message").filter((e) => e.payload.message.id === assistantMessage.id);
    expect(events.at(-1)!.payload.message.reactions).toHaveLength(2);
    expect(await reactionsOf(await react(assistantMessage.id, "👍", "DELETE"))).toEqual([{ emoji: "❤️", by: "user" }]);
    const loaded = (await timeline(m)).find((x) => x.id === assistantMessage.id)!;
    expect(loaded.reactions).toEqual([{ emoji: "❤️", by: "user" }]);
  });

  test("❤ and ❤️ are one reaction (one stored form); DELETE of either removes it", async () => {
    expect(await reactionsOf(await react(mine.id, "❤", "PUT"))).toEqual([{ emoji: "⭐", by: "user" }, { emoji: "❤️", by: "user" }]);
    expect(await reactionsOf(await react(mine.id, "❤️", "PUT"))).toEqual([{ emoji: "⭐", by: "user" }, { emoji: "❤️", by: "user" }]);
    expect(await reactionsOf(await react(mine.id, "❤", "DELETE"))).toEqual([{ emoji: "⭐", by: "user" }]);
    expect(await reactionsOf(await react(mine.id, "👍\uFE0F", "PUT"))).toContainEqual({ emoji: "👍", by: "user" });
    expect(await reactionsOf(await react(mine.id, "👍", "DELETE"))).toEqual([{ emoji: "⭐", by: "user" }]);
  });

  test("only the user's own messages; one emoji only", async () => {
    expect((await react(assistantMessage.id, "👍", "PUT", sam)).status).toBe(404);
    expect((await react("missing", "👍", "PUT")).status).toBe(404);
    for (const bad of ["ok", "👍👍", "a👍", "x".repeat(20)]) expect((await react(assistantMessage.id, bad, "PUT")).status).toBe(400);
    for (const good of ["👍🏽", "🇨🇳", "1️⃣"]) expect((await react(assistantMessage.id, good, "PUT")).status).toBe(200);
    expect((await m.fixture.app.request(`/api/messages/${assistantMessage.id}/reactions/${encodeURIComponent("👍")}`, { method: "PUT" })).status).toBe(401);
  });
});

describe("Claude's react tool", () => {
  test("reacts to the message the turn answers by default (by claude); the user's own DELETE leaves it; no per-turn id in the prompt", async () => {
    m.llm.script("chat", [call("react", { emoji: "❤️" })], [text("Congrats!")]);
    const frames = await chat(m, "I got the job!", "r-2");
    const target = messagesOf(frames).find((x) => x.role === "user" && x.text === "I got the job!")!.id;
    const reacted = messagesOf(frames).filter((x) => x.id === target).at(-1)!;
    expect(reacted.reactions).toEqual([{ emoji: "❤️", by: "assistant" }]);
    expect(await reactionsOf(await react(target, "❤️", "DELETE"))).toEqual([{ emoji: "❤️", by: "assistant" }]);
    // M14b: the message id isn't in the system prompt any more (it broke the prompt cache every turn).
    expect(m.llm.sent("chat").at(-1)?.system).not.toContain(target);
  });

  test("never on Claude's own messages or another user's", async () => {
    m.llm.script("chat", [call("react", { messageId: assistantMessage.id, emoji: "👍" })], [text("ok")]);
    await chat(m, "thanks", "r-3");
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("only react to the user's messages");
    expect((await timeline(m)).find((x) => x.id === assistantMessage.id)!.reactions.some((r) => r.by === "assistant")).toBe(false);
  });
  test("final: true stores the reaction and ends the runtime without another model call or text", async () => {
    const channel = await m.fixture.db.channel.create({ data: { userId: m.alex.userId, name: "Final reaction" } });
    const before = m.llm.sent("chat").length;
    m.llm.script("chat", [call("react", { emoji: "👍", final: true })]);
    const frames = await chatIn(channel.id, "ok明白了", "final-1");
    const target = messagesOf(frames).filter(x => x.role === "user").at(-1)!;
    expect(target.reactions).toEqual([{ emoji: "👍", by: "assistant" }]);
    expect(m.llm.sent("chat").length - before).toBe(1);
    expect(messagesOf(frames).filter(x => x.role === "assistant" && x.kind === "text")).toEqual([]);
    expect(await m.fixture.db.message.count({ where: { channelId: channel.id, role: "assistant" } })).toBe(0);
    const schema = m.llm.sent("chat").at(-1)!.tools!.find(tool => tool.name === "react")!.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect((schema.properties as Record<string, { type: string }>).final!.type).toBe("boolean");
  });

  test("final: true does not end a turn when spacing refuses the reaction", async () => {
    const channel = await m.fixture.db.channel.create({ data: { userId: m.alex.userId, name: "Final spacing" } });
    m.llm.script("chat", [call("react", { emoji: "👍", final: true })]);
    await chatIn(channel.id, "ok", "final-spacing-1");
    const before = m.llm.sent("chat").length;
    m.llm.script("chat", [call("react", { emoji: "❤️", final: true })], [text("(pass)")]);
    await chatIn(channel.id, "thanks!", "final-spacing-2");
    expect(m.llm.sent("chat").length - before).toBe(2);
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("not_reacted");
    expect(await m.fixture.db.reaction.count({ where: { by: "assistant", message: { channelId: channel.id } } })).toBe(1);
  });
});

const chatIn = async (channelId: string, body: string, clientId: string) =>
  readSse(await m.fixture.app.request(`/api/channels/${channelId}/messages`, json(m.alex, "POST", { text: body, clientId })));

describe("M14b: reactions stay rare", () => {
  test("at most one Claude reaction among the thread's latest 6 messages; the refusal isn't an error and says how to end", async () => {
    const channel = await m.fixture.db.channel.create({ data: { userId: m.alex.userId, name: "Spacing" } });
    m.llm.script("chat", [call("react", { emoji: "👍" })], [text("(pass)")]);
    const first = await chatIn(channel.id, "ok", "s-1");
    const okId = messagesOf(first).find((x) => x.role === "user")!.id;
    m.llm.script("chat", [call("react", { emoji: "❤️" })], [text("(pass)")]);
    await chatIn(channel.id, "thanks!", "s-2");
    const refused = toolResults(m.llm.sent("chat").at(-1));
    expect(refused).toContain("not_reacted");
    expect(refused).toContain("(pass)");
    expect(refused).not.toContain("isError");
    const rows = await m.fixture.db.reaction.findMany({ where: { by: "assistant", message: { channelId: channel.id } } });
    expect(rows.map((r) => [r.messageId, r.emoji])).toEqual([[okId, "👍"]]);
  });

  test("a new emoji on the same message replaces Claude's earlier one", async () => {
    const channel = await m.fixture.db.channel.create({ data: { userId: m.alex.userId, name: "Replace" } });
    m.llm.script("chat", [call("react", { emoji: "👍" }), call("react", { emoji: "🎉" })], [text("(pass)")]);
    const frames = await chatIn(channel.id, "We shipped it", "p-1");
    const id = messagesOf(frames).find((x) => x.role === "user")!.id;
    const rows = await m.fixture.db.reaction.findMany({ where: { messageId: id, by: "assistant" } });
    expect(rows.map((r) => r.emoji)).toEqual(["🎉"]);
  });
});
