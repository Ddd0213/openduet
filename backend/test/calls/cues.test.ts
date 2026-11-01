// M13: the cue watcher (`call` SSE events while a call is open): Claude's final reply (<= 600
// characters at a sentence end), a new approval card's notice (once), a failed turn's notice,
// progress (only a change, at most one per gap, "still working" after the idle time), seq rising.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { shortenForSpeech } from "../../src/calls/text.ts";
import { toApproval } from "../../src/approvals/serialize.ts";
import { failing } from "../models/harness.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { chatModel, eventsOf, realtimeModel, req, settle, startCallsApp, stopCallsApp, text, type CallsApp } from "./harness.ts";

let t: CallsApp;
beforeAll(async () => {
  t = await startCallsApp({ progressGapMs: 15_000, idleMs: 150 });
});
afterAll(() => stopCallsApp(t));

async function setUp(name: string) {
  const u = await signUp(t.fixture, name, `${name} Test`);
  await chatModel(t, u);
  await realtimeModel(t, u, "gemini");
  const start = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
  expect(start.status).toBe(200);
  return { u, id: start.body.call.id as string };
}

const cues = async (u: SignedIn) => (await eventsOf(t, u.userId, "call")).map((e) => e.payload);

describe("reply and failure cues", () => {
  test("Claude's final reply of a call turn (shortened at a sentence end), then a plain chat turn's too", async () => {
    const { u, id } = await setUp("rui");
    const long = `${"The pads are ordered. ".repeat(40)}Delivery is Friday.`;
    t.scripts.push([text(long)]);
    await req(t, u, "POST", `/api/calls/${id}/tool`, { name: "send_to_assistant", arguments: { text: "Order pads" } });
    await settle(t);
    let got = await cues(u);
    const reply = got.find((c) => c.kind === "reply")!;
    expect(reply.callId).toBe(id);
    expect([...reply.text].length).toBeLessThanOrEqual(600);
    expect(reply.text.endsWith("ordered.")).toBe(true);

    // A turn the user typed in the chat while the call is open: its reply is a cue too.
    t.scripts.push([text("Short answer.")]);
    await t.runs.send({ userId: u.userId, channelId: u.mainChannelId, text: "typed", clientId: "typed-1", fileIds: [], skill: null, quickReply: null });
    await settle(t);
    got = await cues(u);
    expect(got.filter((c) => c.kind === "reply").map((c) => c.text)).toEqual([reply.text, "Short answer."]);
    const seqs = got.map((c) => c.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("a failed turn is a notice; after the end no cues go out", async () => {
    const { u, id } = await setUp("sol");
    t.scripts.push(failing(529));
    await req(t, u, "POST", `/api/calls/${id}/tool`, { name: "send_to_assistant", arguments: { text: "Do it" } });
    await settle(t);
    const notice = (await cues(u)).find((c) => c.kind === "notice")!;
    expect(notice.text).toContain("OpenDuet couldn't finish that");
    await req(t, u, "POST", `/api/calls/${id}/end`, { seconds: 10 });
    const before = (await cues(u)).length;
    t.scripts.push([text("After the call.")]);
    await t.runs.send({ userId: u.userId, channelId: u.mainChannelId, text: "later", clientId: "later-1", fileIds: [], skill: null, quickReply: null });
    await settle(t);
    expect((await cues(u)).length).toBe(before);
  });
});

describe("approval notice", () => {
  test("a new pending card in the call's channel: one notice with its title; another channel's: none", async () => {
    const { u } = await setUp("tom");
    const db = t.fixture.db;
    const elsewhere = await db.channel.create({ data: { userId: u.userId, isMain: false, name: "Other" } });
    const card = await db.message.create({ data: { userId: u.userId, channelId: u.mainChannelId, role: "assistant", kind: "text", text: "", payload: "{}", status: "sent" } });
    const preview = JSON.stringify({ kind: "email", app: "Gmail", from: "a@example.com", to: ["b@example.com"], cc: [], subject: "Brake pad order", body: "hi", attachments: [] });
    const row = await db.approval.create({ data: { userId: u.userId, kind: "email", toolSlug: "GMAIL_SEND", messageId: card.id, preview } });
    await t.fixture.events.emit(u.userId, u.mainChannelId, "approval", { approval: toApproval(row) });
    await t.fixture.events.emit(u.userId, u.mainChannelId, "approval", { approval: toApproval(row) });
    const otherCard = await db.message.create({ data: { userId: u.userId, channelId: elsewhere.id, role: "assistant", kind: "text", text: "", payload: "{}", status: "sent" } });
    const other = await db.approval.create({ data: { userId: u.userId, kind: "email", toolSlug: "GMAIL_SEND", messageId: otherCard.id, preview } });
    await t.fixture.events.emit(u.userId, elsewhere.id, "approval", { approval: toApproval(other) });
    await settle(t);
    const notices = (await cues(u)).filter((c) => c.kind === "notice");
    expect(notices.map((c) => c.text)).toEqual(["Brake pad order needs your approval on the card in the chat"]);
  });
});

describe("progress", () => {
  test("only a change, at most one per 15 s; \"still working\" after the idle time; nothing after done", async () => {
    const { u, id } = await setUp("uma");
    const ch = u.mainChannelId;
    const emit = (status: "thinking" | "searching_web" | "writing_draft" | null) =>
      t.fixture.events.emit(u.userId, ch, "status", { runId: "run_fake", taskId: null, status });
    await emit("thinking");
    await emit("thinking"); // no change: nothing
    t.clock.now += 5_000;
    await emit("searching_web"); // a change, but 5 s after the last: dropped
    t.clock.now += 11_000;
    await emit("searching_web"); // 16 s after: sent
    await emit("writing_draft"); // 0 s after: dropped
    await settle(t);
    let progress = (await cues(u)).filter((c) => c.kind === "progress").map((c) => c.text);
    expect(progress).toEqual(["OpenDuet is thinking it through.", "OpenDuet is searching the web."]);
    // Nothing for the idle time: "still working" (the watcher's timer is 150 ms here).
    await Bun.sleep(200);
    await settle(t);
    progress = (await cues(u)).filter((c) => c.kind === "progress").map((c) => c.text);
    expect(progress.at(-1)).toBe("OpenDuet is still working.");
    await t.fixture.events.emit(u.userId, ch, "done", { runId: "run_fake", taskId: null, status: "cancelled", error: null });
    const count = (await cues(u)).length;
    await Bun.sleep(250);
    await settle(t);
    expect((await cues(u)).length).toBe(count);
    const all = await cues(u);
    expect(all.every((c) => c.callId === id)).toBe(true);
  });
});

describe("shortenForSpeech", () => {
  test("cuts at the last sentence end that fits; falls back to a word boundary", () => {
    expect(shortenForSpeech("Short.", 600)).toBe("Short.");
    expect(shortenForSpeech("One sentence here. Two three four five", 25)).toBe("One sentence here.");
    expect(shortenForSpeech("第一句。第二句很长很长很长很长很长", 10)).toBe("第一句。");
    const words = shortenForSpeech("alpha beta gamma delta epsilon zeta eta theta", 20);
    expect([...words].length).toBeLessThanOrEqual(20);
    expect(words.endsWith("…")).toBe(true);
    expect(shortenForSpeech("**Bold** and [a link](https://x.y).", 600)).toBe("Bold and a link.");
  });
});
