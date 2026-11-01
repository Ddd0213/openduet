// M13: ending a call (status, seconds, the title from the utility model or the fallback, the one
// `call` line in the chat with callId null; idempotent), a turn still running at hang-up posting
// visibly, and the 2 h sweep.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanTitle } from "../../src/calls/title.ts";
import { ChannelList } from "../../src/contract/channels.ts";
import { MessageActionResponse } from "../../src/contract/messages.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { chatModel, line, realtimeModel, req, settle, startCallsApp, stopCallsApp, text, type CallsApp } from "./harness.ts";

let t: CallsApp;
beforeAll(async () => {
  t = await startCallsApp();
});
afterAll(() => stopCallsApp(t));

async function openCall(user: SignedIn, channelId = user.mainChannelId) {
  const res = await req(t, user, "POST", "/api/calls", { channelId });
  expect(res.status).toBe(200);
  return res.body.call.id as string;
}

describe("end", () => {
  test("the title from the utility model; one call line (kind call, callId null); a second end answers the same message", async () => {
    const u = await signUp(t.fixture, "abe", "Abe Cole");
    await chatModel(t, u);
    await realtimeModel(t, u, "gemini");
    const id = await openCall(u);
    await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line("1", "user", "Reorder the brake pads"), line("2", "voice", "Passing that on.")] });
    let asked: LlmRequest | null = null;
    t.scripts.push((r: LlmRequest) => { asked = r; return [text("\"Reorder brake pads.\"")]; });
    const end = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 192, lines: [line("3", "user", "Thanks", "2026-11-02T18:03:00.000Z")] });
    expect(end.status).toBe(200);
    expect(end.headers.get("cache-control")).toBe("no-store");
    const { message } = MessageActionResponse.parse(end.body);
    expect(message).toMatchObject({ role: "system", kind: "call", callId: null, payload: { callId: id, seconds: 192, title: "Reorder brake pads", lineCount: 3 } });
    expect(asked!.role).toBe("utility");
    expect(JSON.stringify(asked!.messages)).toContain("Reorder the brake pads");
    const call = await t.fixture.db.call.findUniqueOrThrow({ where: { id } });
    expect(call).toMatchObject({ status: "ended", seconds: 192, title: "Reorder brake pads" });
    expect(call.endedAt).not.toBeNull();

    // Shows in the chat (the call's one line) and counts as unread.
    const list = await req(t, u, "GET", `/api/channels/${u.mainChannelId}/messages`);
    expect(list.body.messages.map((m: { kind: string }) => m.kind)).toEqual(["call"]);
    const main = ChannelList.parse((await req(t, u, "GET", "/api/channels")).body).channels.find((c) => c.isMain)!;
    expect(main.unreadCount).toBe(1);
    // GET /api/calls/:id after the end.
    const detail = await req(t, u, "GET", `/api/calls/${id}`);
    expect(detail.body.call).toMatchObject({ status: "ended", title: "Reorder brake pads", seconds: 192 });
    expect(detail.body.lines).toHaveLength(3);

    const models = t.scripts.requests().length;
    const again = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 999 });
    expect(again.status).toBe(200);
    expect(again.body.message.id).toBe(message.id);
    expect(again.body.message.payload.seconds).toBe(192);
    expect(t.scripts.requests().length).toBe(models);
    expect(await t.fixture.db.message.count({ where: { userId: u.userId, kind: "call" } })).toBe(1);
    // Two ends at once still post one line.
    const id2 = await openCall(u);
    t.scripts.push([text("Second call")]);
    await req(t, u, "POST", `/api/calls/${id2}/lines`, { lines: [line("x", "user", "hello")] });
    const [a, b] = await Promise.all([req(t, u, "POST", `/api/calls/${id2}/end`, { seconds: 4 }), req(t, u, "POST", `/api/calls/${id2}/end`, { seconds: 4 })]);
    expect(a.body.message.id).toBe(b.body.message.id);
    // Another user: 404.
    const sam = await signUp(t.fixture, "sam2", "Sam Two");
    expect((await req(t, sam, "POST", `/api/calls/${id}/end`, { seconds: 1 })).status).toBe(404);
  });

  test("fallback title: nothing said, or no model (in User.language)", async () => {
    const u = await signUp(t.fixture, "bea", "Bea Dunn");
    await realtimeModel(t, u, "stepfun");
    let id = await openCall(u);
    let end = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 2 });
    expect(end.body.message.payload).toMatchObject({ title: "", lineCount: 0 });
    expect((await req(t, u, "GET", `/api/calls/${id}`)).body.call.title).toBe("Voice call");
    // Lines but no chat / utility model set up: the fallback, in Chinese for a zh-Hans user.
    await t.fixture.db.user.update({ where: { id: u.userId }, data: { language: "zh-Hans" } });
    id = await openCall(u);
    end = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 3, lines: [line("a", "user", "你好")] });
    expect(end.body.message.payload).toMatchObject({ title: "", lineCount: 1 });
    expect((await req(t, u, "GET", `/api/calls/${id}`)).body.call.title).toBe("语音通话");
    // A model whose answer is empty: the fallback too.
    await chatModel(t, u);
    id = await openCall(u);
    t.scripts.push([text("   ")]);
    end = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 3, lines: [line("a", "user", "你好")] });
    expect(end.body.message.payload.title).toBe("");
  });

  test("legacy chat payloads normalize either fallback on reads and repeated end; detail remains readable", async () => {
    const u = await signUp(t.fixture, "legacytitle", "Legacy Title");
    await realtimeModel(t, u, "gemini");
    for (const title of ["Voice call", "语音通话", "Plan for Friday"]) {
      const id = await openCall(u);
      const end = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 43 });
      const payload = { ...end.body.message.payload, title };
      await t.fixture.db.call.update({ where: { id }, data: { title } });
      await t.fixture.db.message.update({ where: { id: end.body.message.id }, data: { payload: JSON.stringify(payload) } });
      const list = await req(t, u, "GET", `/api/channels/${u.mainChannelId}/messages`);
      const message = list.body.messages.find((m: { id: string }) => m.id === end.body.message.id);
      expect(message.payload.title).toBe(title === "Plan for Friday" ? title : "");
      const again = await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 999 });
      expect(again.body.message.payload.title).toBe(message.payload.title);
      expect((await req(t, u, "GET", `/api/calls/${id}`)).body.call.title).toBe(title);
      // Serialization does not migrate or rewrite the legacy stored row.
      expect(JSON.parse((await t.fixture.db.message.findUniqueOrThrow({ where: { id: message.id } })).payload).title).toBe(title);
    }
  });

  test("cleanTitle: first line, quotes and the trailing period gone, <= 60 characters", () => {
    expect(cleanTitle("Title: \"Plan for Friday.\"\nmore")).toBe("Plan for Friday");
    expect(cleanTitle("「周五的计划」。")).toBe("周五的计划");
    expect([...cleanTitle("x".repeat(100))].length).toBe(60);
  });

  test("a turn still running at hang-up posts the rest of its reply in the chat (no callId)", async () => {
    const u = await signUp(t.fixture, "cal", "Cal Moe");
    await chatModel(t, u);
    await realtimeModel(t, u, "gemini");
    const id = await openCall(u);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const started = new Promise<void>((r) => { reached = r; });
    t.scripts.push(async () => { reached(); await gate; return [text("Here is the long answer.")]; });
    await req(t, u, "POST", `/api/calls/${id}/tool`, { name: "send_to_assistant", arguments: { text: "Write it up" } });
    await started;
    t.scripts.push([text("Write-up")]);
    await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 20 });
    release();
    await settle(t);
    const reply = await t.fixture.db.message.findFirstOrThrow({ where: { userId: u.userId, text: "Here is the long answer." } });
    expect(reply.callId).toBeNull();
    const hand = await t.fixture.db.message.findFirstOrThrow({ where: { userId: u.userId, role: "user" } });
    expect(hand.callId).toBe(id);
  });
});

describe("sweep", () => {
  test("an open call with nothing for 2 h ends the same way (seconds = last activity - start); a fresh one stays", async () => {
    const u = await signUp(t.fixture, "dee", "Dee Ash");
    const v = await signUp(t.fixture, "eli", "Eli Fern");
    await realtimeModel(t, u, "gemini");
    await realtimeModel(t, v, "gemini");
    const stale = await openCall(u);
    const fresh = await openCall(v);
    const db = t.fixture.db;
    const start = t.clock.now;
    await db.call.update({ where: { id: stale }, data: { startedAt: new Date(start - 3 * 3600_000), lastActiveAt: new Date(start - 3 * 3600_000 + 300_000) } });
    await db.call.update({ where: { id: fresh }, data: { lastActiveAt: new Date(start - 3600_000) } });
    expect(await t.calls.service.sweep()).toBe(1);
    const ended = await db.call.findUniqueOrThrow({ where: { id: stale } });
    expect(ended).toMatchObject({ status: "ended", seconds: 300, title: "Voice call" });
    const msg = await db.message.findFirstOrThrow({ where: { userId: u.userId, kind: "call" } });
    expect(JSON.parse(msg.payload)).toEqual({ callId: stale, seconds: 300, title: "", lineCount: 0 });
    expect((await db.call.findUniqueOrThrow({ where: { id: fresh } })).status).toBe("open");
    expect(await t.calls.service.sweep()).toBe(0);
    // A request keeps a call alive: lastActiveAt moves.
    await req(t, v, "POST", `/api/calls/${fresh}/lines`, { lines: [line("k", "user", "still here")] });
    expect((await db.call.findUniqueOrThrow({ where: { id: fresh } })).lastActiveAt.getTime()).toBe(t.clock.now);
    await req(t, v, "POST", `/api/calls/${fresh}/end`, { seconds: 1 });
  });
});
