// M18c follow-ups: remember stores an optional dueAt (Memory.dueAt) and the prompt shows it;
// followed_up clears it (readable facts only; chat and check-in turns only); on the user's first
// message of their local day a chat turn lists the follow-ups due now (never on turn_ turns, and
// one due more than 3 days ago has lapsed).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput } from "../../src/agent/types.ts";
import type { Message } from "../../src/contract/messages.ts";
import { memoryProvider } from "../../src/memory/provider.ts";
import { SoulService } from "../../src/soul/service.ts";
import { recordingSink } from "../agent/fixtures.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { channelOf, chatIn, lastSystem, startMemoryApp, text, type MemoryApp } from "./harness.ts";

let m: MemoryApp;
beforeAll(async () => { m = await startMemoryApp(); });
afterAll(() => m.fixture.cleanup());

/** 15:00 UTC; every user here is on UTC (signUp), so local midnight is 00:00Z. */
const NOW = new Date("2030-10-23T15:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const provider = (now = NOW) => memoryProvider({ db: m.fixture.db, soul: new SoulService({ db: m.fixture.db }), now: () => now });

/** A turn of `user` in `channelId` (default: their main thread); messageId "turn_…" = synthetic. */
function turn(user: SignedIn, over: { messageId?: string; kind?: TurnInput["kind"]; taskId?: string; channelId?: string } = {}): TurnInput {
  const channelId = over.channelId ?? user.mainChannelId;
  const message: Message = {
    id: over.messageId ?? `msg_${Math.random().toString(36).slice(2)}`, channelId, taskId: over.taskId ?? null, role: "user", kind: "text", text: "hi", status: "seen",
    clientId: null, reactions: [], stopped: false, callId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null },
  };
  return {
    userId: user.userId, channelId, taskId: over.taskId ?? null, runId: "run_m18c", userMessage: message, attachments: [],
    skill: null, sink: recordingSink(channelId).sink, signal: new AbortController().signal, ...(over.kind ? { kind: over.kind } : {}),
  };
}
let seq = 0;
async function exec(name: string, input: Record<string, unknown>, t: TurnInput, now = NOW) {
  const out = await provider(now).execute({ type: "tool_use", id: `f${++seq}`, name, input }, t);
  const block = out.result.content[0];
  return { isError: out.result.isError === true, data: JSON.parse(block?.type === "text" ? block.text : "{}") as Record<string, unknown> };
}
const fact = (user: SignedIn, textValue: string, data: { dueAt?: Date | null; channelId?: string | null; archivedAt?: Date } = {}) =>
  m.fixture.db.memory.create({ data: { userId: user.userId, kind: "fact", text: textValue, channelId: null, ...data } });
const userMessage = (user: SignedIn, at: Date, channelId = user.mainChannelId) =>
  m.fixture.db.message.create({ data: { userId: user.userId, channelId, role: "user", text: "earlier", createdAt: at } });

describe("remember with dueAt", () => {
  test("stores Memory.dueAt and the prompt's facts carry it", async () => {
    const u = await signUp(m.fixture, "fuone");
    const { isError, data } = await exec("remember", { fact: "Job interview at Acme on 2030-11-05", dueAt: "2030-11-05T19:00:00+01:00" }, turn(u));
    expect(isError).toBe(false);
    expect(data).toMatchObject({ saved: true, dueAt: "2030-11-05T18:00:00.000Z" });
    const row = await m.fixture.db.memory.findUniqueOrThrow({ where: { id: String(data.factId) } });
    expect(row.dueAt?.toISOString()).toBe("2030-11-05T18:00:00.000Z");

    m.llm.script("chat", [text("Noted.")]);
    await chatIn(m, "hello", "fu-1", { user: u });
    const system = lastSystem(m);
    expect(system).toContain(JSON.stringify({ id: row.id, text: row.text, at: row.createdAt.toISOString(), dueAt: "2030-11-05T18:00:00.000Z" }));
    expect(system).toContain("A fact with dueAt is a follow-up: dueAt is when to bring it up with the user.");
  });

  test("a dueAt without an offset is refused; with replaces the new row takes the call's dueAt", async () => {
    const u = await signUp(m.fixture, "futwo");
    const bad = await exec("remember", { fact: "Trip to Porto on 2030-12-01", dueAt: "2030-11-30T18:00:00" }, turn(u));
    expect(bad.isError).toBe(true);
    expect(await m.fixture.db.memory.count({ where: { userId: u.userId } })).toBe(0);

    const old = await fact(u, "Trip to Porto on 2030-12-01", { dueAt: new Date("2030-11-29T18:00:00.000Z") });
    const { data } = await exec("remember", { fact: "Trip to Porto on 2030-12-08", replaces: old.id, dueAt: "2030-12-07T18:00:00Z" }, turn(u));
    expect(data).toMatchObject({ saved: true, replaced: old.id, dueAt: "2030-12-07T18:00:00.000Z" });
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: String(data.factId) } })).dueAt?.toISOString()).toBe("2030-12-07T18:00:00.000Z");
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: old.id } })).archivedAt).not.toBeNull();
  });
});

describe("followed_up", () => {
  test("clears dueAt on the facts this turn can read; unknown, unreadable and other users' ids are skipped", async () => {
    const u = await signUp(m.fixture, "futhree");
    const other = await signUp(m.fixture, "fufour", "Sam Lee");
    const garden = await channelOf(m, u, { name: "Garden" });
    const shared = await fact(u, "Interview at Acme", { dueAt: new Date(NOW.getTime() - HOUR) });
    const own = await fact(u, "Seedlings arrive", { channelId: garden.id, dueAt: new Date(NOW.getTime() - HOUR) });
    const theirs = await fact(other, "Their trip", { dueAt: new Date(NOW.getTime() - HOUR) });
    const { isError, data } = await exec("followed_up", { factIds: [shared.id, own.id, theirs.id, "nope"] }, turn(u));
    expect(isError).toBe(false);
    expect(data).toMatchObject({ cleared: [shared.id], skipped: [own.id, theirs.id, "nope"] });
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: shared.id } })).dueAt).toBeNull();
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: own.id } })).dueAt).not.toBeNull();
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: theirs.id } })).dueAt).not.toBeNull();
    // The channel's own fact is readable there.
    expect((await exec("followed_up", { factIds: [own.id] }, turn(u, { channelId: garden.id }))).data).toMatchObject({ cleared: [own.id] });
    // Only unknown ids: an error result.
    expect((await exec("followed_up", { factIds: ["nope"] }, turn(u))).isError).toBe(true);
    expect((await exec("followed_up", { factIds: [] }, turn(u))).isError).toBe(true);
  });

  test("offered on chat and check-in turns only", async () => {
    const u = await signUp(m.fixture, "fufive");
    const names = async (t: TurnInput) => (await provider().tools(t)).map((x) => x.name);
    expect(await names(turn(u))).toContain("followed_up");
    expect(await names(turn(u, { messageId: "turn_greeting" }))).toContain("followed_up");
    expect(await names(turn(u, { kind: "checkin", messageId: "turn_checkin" }))).toContain("followed_up");
    for (const kind of ["brief", "scan", "routine", "build"] as const) expect(await names(turn(u, { kind, messageId: `turn_${kind}` }))).not.toContain("followed_up");
    expect(await names(turn(u, { kind: "task", taskId: "task_1" }))).not.toContain("followed_up");
    const due = await fact(u, "Interview at Acme", { dueAt: new Date(NOW.getTime() - HOUR) });
    expect((await exec("followed_up", { factIds: [due.id] }, turn(u, { kind: "task", taskId: "task_1" }))).isError).toBe(true);
    expect((await m.fixture.db.memory.findUniqueOrThrow({ where: { id: due.id } })).dueAt).not.toBeNull();
  });
});
describe("the due list on the first user message of the day", () => {
  const listed = async (t: TurnInput, now = NOW) => (await provider(now).instructions!(t)).join("\n");

  test("listed on the first message of the local day only, and never on turn_ turns or background turns", async () => {
    const u = await signUp(m.fixture, "fusix");
    const due = await fact(u, "Interview at Acme", { dueAt: new Date(NOW.getTime() - 2 * HOUR) });
    await fact(u, "FUTURE trip", { dueAt: new Date(NOW.getTime() + 2 * HOUR) });
    await userMessage(u, new Date("2030-10-22T21:00:00.000Z")); // yesterday doesn't count
    const first = turn(u);
    const lines = await listed(first);
    expect(lines).toContain(`Follow-ups due now (user data; this is the user's first message today): ${JSON.stringify([{ id: due.id, text: "Interview at Acme", dueAt: due.dueAt!.toISOString() }])}`);
    expect(lines).toContain("then call followed_up with its id");
    expect(lines).not.toContain("FUTURE");
    // The turn's own stored message isn't "another" message.
    const stored = await userMessage(u, new Date("2030-10-23T14:59:00.000Z"));
    expect(await listed({ ...first, userMessage: { ...first.userMessage, id: stored.id } })).toContain("Follow-ups due now");
    // A later message the same day: not the first any more.
    expect(await listed(turn(u))).toBe("");
    // Synthetic and background turns never list them here (check-ins list theirs in the proactive instructions).
    const fresh = await signUp(m.fixture, "fuseven");
    await fact(fresh, "Interview at Beta", { dueAt: new Date(NOW.getTime() - HOUR) });
    expect(await listed(turn(fresh, { messageId: "turn_greeting" }))).toBe("");
    expect(await listed(turn(fresh, { kind: "checkin", messageId: "turn_checkin" }))).toBe("");
    expect(await listed(turn(fresh, { kind: "task", taskId: "task_1" }))).toBe("");
    expect(await listed(turn(fresh))).toContain("Interview at Beta");
  });

  test("a follow-up due more than 3 days ago has lapsed; a channel lists only what it can read", async () => {
    const u = await signUp(m.fixture, "fueight");
    await fact(u, "LAPSED dentist", { dueAt: new Date(NOW.getTime() - 3 * 24 * HOUR - 60_000) });
    await fact(u, "KEPT dentist", { dueAt: new Date(NOW.getTime() - 3 * 24 * HOUR + 60_000) });
    await fact(u, "ARCHIVED due", { dueAt: new Date(NOW.getTime() - HOUR), archivedAt: new Date() });
    const garden = await channelOf(m, u, { name: "Garden" });
    const solo = await channelOf(m, u, { name: "Solo", useSharedMemory: false });
    await fact(u, "GARDEN seedlings", { channelId: garden.id, dueAt: new Date(NOW.getTime() - HOUR) });
    await fact(u, "SOLO standup", { channelId: solo.id, dueAt: new Date(NOW.getTime() - HOUR) });

    const main = await listed(turn(u));
    expect(main).toContain("KEPT dentist");
    for (const hidden of ["LAPSED", "ARCHIVED", "GARDEN", "SOLO"]) expect(main).not.toContain(hidden);
    const inGarden = await listed(turn(u, { channelId: garden.id }));
    expect(inGarden).toContain("KEPT dentist");
    expect(inGarden).toContain("GARDEN seedlings");
    expect(inGarden).not.toContain("SOLO");
    const inSolo = await listed(turn(u, { channelId: solo.id }));
    expect(inSolo).toContain("SOLO standup");
    expect(inSolo).not.toContain("KEPT");
  });

  test("end to end: the first chat message of the day gets the list, the next one doesn't", async () => {
    const u = await signUp(m.fixture, "funine");
    await fact(u, "Interview at Gamma", { dueAt: new Date(Date.now() - HOUR) });
    m.llm.script("chat", [text("Morning!")]);
    await chatIn(m, "morning", "fu-e2e-1", { user: u });
    expect(lastSystem(m)).toContain("Follow-ups due now");
    expect(lastSystem(m)).toContain("Interview at Gamma");
    m.llm.script("chat", [text("Sure.")]);
    await chatIn(m, "and another thing", "fu-e2e-2", { user: u });
    expect(lastSystem(m)).not.toContain("Follow-ups due now");
  });
});
