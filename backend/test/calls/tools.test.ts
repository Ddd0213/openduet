// M13: the voice's tools and the hidden messages. send_to_assistant posts a user message with callId
// (the voice's text + the user's own words since the last hand-off) and a chat turn whose Claude
// bubbles carry the callId; those are left out of the message list, unread and the last-message
// time but stay in the agent's context; cards of that turn aren't hidden. assistant_status,
// stop_assistant, search_memory (no other channel's private memory), unknown tools, line dedupe.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelList } from "../../src/contract/channels.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { channel, chatModel, line, realtimeModel, req, settle, startCallsApp, stopCallsApp, text, toolCall, type CallsApp } from "./harness.ts";

let t: CallsApp;
beforeAll(async () => {
  t = await startCallsApp();
});
afterAll(() => stopCallsApp(t));

async function openCall(user: SignedIn, channelId: string) {
  const res = await req(t, user, "POST", "/api/calls", { channelId });
  expect(res.status).toBe(200);
  return res.body.call.id as string;
}

const tool = (user: SignedIn, id: string, name: string, args: Record<string, unknown> = {}, lines: unknown[] = []) =>
  req(t, user, "POST", `/api/calls/${id}/tool`, { name, arguments: args, lines });

/** A model turn that waits for release() (or the turn's abort). */
function held(reply = "Done.") {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => { reached = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  const turn = async (request: LlmRequest) => {
    reached();
    const ok = await new Promise<boolean>((resolve) => {
      if (request.signal?.aborted) return resolve(false);
      request.signal?.addEventListener("abort", () => resolve(false), { once: true });
      void releaseP.then(() => resolve(true));
    });
    if (!ok) throw new Error("aborted");
    return [text(reply)];
  };
  return { turn, reached: reachedP, release };
}

const textOf = (r: LlmRequest) => JSON.stringify(r.messages);

describe("send_to_assistant and the hidden messages", () => {
  let u: SignedIn;
  let shop: string;
  let id: string;
  beforeAll(async () => {
    u = await signUp(t.fixture, "hana", "Hana Mori");
    await chatModel(t, u);
    await realtimeModel(t, u, "gemini");
    shop = await channel(t, u, "Bike shop");
    id = await openCall(u, shop);
  });

  test("a hidden user message with the user's own words, and a turn whose reply carries callId", async () => {
    expect((await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line("u1", "user", "We need brake pads"), line("v1", "voice", "Sure, how many?")] })).status).toBe(204);
    t.scripts.push([text("The order for 4 sets is ready.")]);
    const res = await tool(u, id, "send_to_assistant", { text: "Order 4 sets of brake pads." }, [line("u2", "user", "Four sets.", "2026-11-02T18:00:09.000Z")]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({ result: "Sent to OpenDuet." });
    await settle(t);
    const rows = await t.fixture.db.message.findMany({ where: { channelId: shop }, orderBy: { createdAt: "asc" } });
    const hand = rows.find((r) => r.role === "user")!;
    expect(hand.callId).toBe(id);
    expect(hand.text).toBe("Order 4 sets of brake pads.\n\n[The user's own words on the call: «We need brake pads Four sets.»]");
    const reply = rows.find((r) => r.role === "assistant" && r.kind === "text")!;
    expect(reply.text).toBe("The order for 4 sets is ready.");
    expect(reply.callId).toBe(id);
    // The message events still go out, with callId set (the app skips them).
    const events = (await t.fixture.events.replay(u.userId, 0)).filter((e) => e.type === "message");
    expect(events.some((e) => e.type === "message" && e.payload.message.id === hand.id && e.payload.message.callId === id)).toBe(true);
    expect(events.some((e) => e.type === "message" && e.payload.message.id === reply.id && e.payload.message.callId === id)).toBe(true);
  });

  test("M15: listed while the call runs (the hand-off without the model's quote), unread and lastMessageAt count them; the model reads the quote", async () => {
    const list = await req(t, u, "GET", `/api/channels/${shop}/messages`);
    expect(list.status).toBe(200);
    expect(list.body.messages.map((m: { role: string; text: string; callId: string | null }) => [m.role, m.text, m.callId])).toEqual([
      ["user", "Order 4 sets of brake pads.", id],
      ["assistant", "The order for 4 sets is ready.", id],
    ]);
    const channels = ChannelList.parse((await req(t, u, "GET", "/api/channels")).body).channels;
    const row = channels.find((c) => c.id === shop)!;
    expect(row.unreadCount).toBe(1);
    expect(row.lastMessageAt).not.toBeNull();
    // GET /api/calls/:id lists them, oldest first.
    const detail = await req(t, u, "GET", `/api/calls/${id}`);
    expect(detail.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.body.lines.map((l: { id: string }) => l.id)).toEqual(["u1", "v1", "u2"]);
    // A normal message afterwards: the model sees the hand-off and the reply.
    t.scripts.push([text("Noted.")]);
    const sent = await t.fixture.app.request(`/api/channels/${shop}/messages`, {
      method: "POST", headers: { ...u.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Thanks", clientId: "after-call-1" }),
    });
    expect(sent.status).toBe(200);
    await readSse(sent, { timeoutMs: 10_000 });
    await settle(t);
    const last = t.scripts.requests().at(-1)!.request;
    expect(textOf(last)).toContain("Order 4 sets of brake pads.");
    expect(textOf(last)).toContain("[The user's own words on the call: «We need brake pads Four sets.»]");
    expect(textOf(last)).toContain("The order for 4 sets is ready.");
    const visible = await req(t, u, "GET", `/api/channels/${shop}/messages`);
    expect(visible.body.messages.map((m: { text: string }) => m.text)).toEqual(["Order 4 sets of brake pads.", "The order for 4 sets is ready.", "Thanks", "Noted."]);
    const after = ChannelList.parse((await req(t, u, "GET", "/api/channels")).body).channels.find((c) => c.id === shop)!;
    expect(after.unreadCount).toBe(2);
  });

  test("the next hand-off quotes only the user's words since the last one; none: no quote", async () => {
    await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line("u3", "user", "And a chain", "2026-11-02T18:01:00.000Z")] });
    t.scripts.push([text("Added.")], [text("Ok.")]);
    await tool(u, id, "send_to_assistant", { text: "Add a chain." });
    await settle(t);
    await tool(u, id, "send_to_assistant", { text: "Confirm the order." });
    await settle(t);
    const hands = await t.fixture.db.message.findMany({ where: { callId: id, role: "user" }, orderBy: { createdAt: "asc" } });
    expect(hands.map((h) => h.text)).toEqual([
      "Order 4 sets of brake pads.\n\n[The user's own words on the call: «We need brake pads Four sets.»]",
      "Add a chain.\n\n[The user's own words on the call: «And a chain»]",
      "Confirm the order.",
    ]);
  });

  test("cards posted in a call turn have no callId; the turn's reply is listed with it", async () => {
    t.scripts.push([toolCall("post_card", {})], [text("Placed it.")]);
    await tool(u, id, "send_to_assistant", { text: "Place the order." });
    await settle(t);
    const card = await t.fixture.db.message.findFirstOrThrow({ where: { channelId: shop, kind: "confirmation" } });
    expect(card.callId).toBeNull();
    const reply = await t.fixture.db.message.findFirstOrThrow({ where: { channelId: shop, text: "Placed it." } });
    expect(reply.callId).toBe(id);
    const list = await req(t, u, "GET", `/api/channels/${shop}/messages`);
    expect(list.body.messages.map((m: { kind: string }) => m.kind)).toContain("confirmation");
    expect(list.body.messages.map((m: { text: string }) => m.text)).toContain("Placed it.");
  });

  test("bad arguments and unknown tools answer a result string; an ended call is 409", async () => {
    expect((await tool(u, id, "send_to_assistant", {})).body.result).toContain("needs text");
    expect((await tool(u, id, "search_memory", { query: 3 })).body.result).toContain("needs a query");
    const unknown = await tool(u, id, "approve_card", { id: "x" });
    expect(unknown.status).toBe(200);
    expect(unknown.body.result).toContain("There's no tool called \"approve_card\"");
    expect((await req(t, u, "POST", `/api/calls/${id}/tool`, { arguments: {} })).status).toBe(400);
  });
});

describe("legacy voice tool names", () => {
  test("old call tools are mapped to their assistant equivalents", async () => {
    const u = await signUp(t.fixture, "legacy_voice", "Legacy Voice");
    await chatModel(t, u);
    await realtimeModel(t, u, "gemini");
    const id = await openCall(u, u.mainChannelId);
    t.scripts.push([text("Handled through the old name.")]);
    expect((await tool(u, id, "send_to_claude", { text: "Use the compatibility path." })).body.result).toBe("Sent to OpenDuet.");
    await settle(t);
    expect((await tool(u, id, "claude_status")).status).toBe(200);
    expect((await tool(u, id, "stop_claude")).status).toBe(200);
  });
});

describe("assistant_status and stop_assistant", () => {
  test("idle, then running (status, approval title), then stopped", async () => {
    const u = await signUp(t.fixture, "ivo", "Ivo Ruiz");
    await chatModel(t, u);
    await realtimeModel(t, u, "stepfun");
    const id = await openCall(u, u.mainChannelId);
    await t.fixture.db.message.create({ data: { userId: u.userId, channelId: u.mainChannelId, role: "assistant", kind: "text", text: `Yesterday's plan: ${"a".repeat(400)}`, payload: "{}", status: "sent" } });
    let status = (await tool(u, id, "assistant_status")).body.result as string;
    expect(status).toContain("isn't working on anything");
    expect(status).toContain("OpenDuet's latest reply: «Yesterday's plan:");
    expect(status.length).toBeLessThan(450);

    // A pending approval card in this chat.
    const card = await t.fixture.db.message.create({ data: { userId: u.userId, channelId: u.mainChannelId, role: "assistant", kind: "text", text: "", payload: "{}", status: "sent" } });
    await t.fixture.db.approval.create({ data: {
      userId: u.userId, kind: "email", toolSlug: "GMAIL_SEND", messageId: card.id,
      preview: JSON.stringify({ kind: "email", app: "Gmail", from: "a@example.com", to: ["b@example.com"], cc: [], subject: "Brake pad order", body: "hi", attachments: [] }),
    } });
    const h = held("All done.");
    t.scripts.push(h.turn);
    await tool(u, id, "send_to_assistant", { text: "Do the thing." });
    await h.reached;
    status = (await tool(u, id, "assistant_status")).body.result as string;
    expect(status).toContain("OpenDuet is working");
    expect(status).toContain("Brake pad order");
    expect((await tool(u, id, "stop_assistant")).body.result).toBe("Stopped.");
    await settle(t);
    expect((await tool(u, id, "stop_assistant")).body.result).toBe("OpenDuet wasn't working on anything.");
    h.release();
  });
});

describe("search_memory", () => {
  test("shared (when the channel reads About you) + the channel's own; never another channel's", async () => {
    const u = await signUp(t.fixture, "jun", "Jun Park");
    const other = await signUp(t.fixture, "kim", "Kim Lo");
    await realtimeModel(t, u, "gemini");
    const db = t.fixture.db;
    const shop = await channel(t, u, "Shop");
    const garden = await channel(t, u, "Garden", { useSharedMemory: false });
    const taxes = await channel(t, u, "Taxes");
    await db.memory.create({ data: { userId: u.userId, channelId: null, kind: "fact", text: "Supplier preference: Velo Parts for brakes" } });
    await db.memory.create({ data: { userId: u.userId, channelId: shop, kind: "fact", text: "Shop brakes are ordered on Mondays" } });
    await db.memory.create({ data: { userId: u.userId, channelId: taxes, kind: "fact", text: "TAXES private: brakes deductible" } });
    await db.memory.create({ data: { userId: u.userId, channelId: shop, kind: "fact", text: "ARCHIVED brakes note", archivedAt: new Date() } });
    await db.memory.create({ data: { userId: other.userId, channelId: null, kind: "fact", text: "OTHER USER brakes" } });
    await db.memory.create({ data: { userId: u.userId, channelId: garden, kind: "fact", text: "Garden brakes? no, tomatoes" } });

    let id = await openCall(u, shop);
    let result = (await tool(u, id, "search_memory", { query: "brakes" })).body.result as string;
    expect(result).toContain("Velo Parts");
    expect(result).toContain("ordered on Mondays");
    expect(result).not.toContain("TAXES");
    expect(result).not.toContain("ARCHIVED");
    expect(result).not.toContain("OTHER USER");
    expect(result).not.toContain("Garden");
    expect((await tool(u, id, "search_memory", { query: "zebra" })).body.result).toBe("Nothing in memory matches that.");
    await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 5 });

    id = await openCall(u, garden);
    result = (await tool(u, id, "search_memory", { query: "brakes" })).body.result as string;
    expect(result).toContain("Garden brakes");
    expect(result).not.toContain("Velo Parts");
    await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 5 });

    for (let i = 0; i < 15; i++) await db.memory.create({ data: { userId: u.userId, channelId: null, kind: "fact", text: `brakes fact ${i}` } });
    id = await openCall(u, u.mainChannelId);
    result = (await tool(u, id, "search_memory", { query: "brakes" })).body.result as string;
    expect(result.split("\n").length).toBe(10);
    expect(result).not.toContain("ordered on Mondays");
    await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 5 });
  });
});

describe("lines", () => {
  test("deduped by (call, id); another user's call 404; lines on an ended call 409", async () => {
    const u = await signUp(t.fixture, "lea", "Lea Fox");
    const other = await signUp(t.fixture, "max", "Max Ode");
    await realtimeModel(t, u, "gemini");
    const id = await openCall(u, u.mainChannelId);
    const a = line("same", "user", "first");
    expect((await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [a, a, line("b", "voice", "two")] })).status).toBe(204);
    expect((await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [{ ...a, text: "changed" }, line("c", "user", "three")] })).status).toBe(204);
    const rows = await t.fixture.db.callLine.findMany({ where: { callId: id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.lineId, r.text])).toEqual([["same", "first"], ["b", "two"], ["c", "three"]]);
    const foreign = await req(t, other, "POST", `/api/calls/${id}/lines`, { lines: [line("x", "user", "x")] });
    expect(foreign.status).toBe(404);
    expect((await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [] })).status).toBe(400);
    await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 3 });
    const late = await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line("d", "user", "late")] });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("conflict");
    expect((await tool(u, id, "assistant_status")).status).toBe(409);
  });
});
