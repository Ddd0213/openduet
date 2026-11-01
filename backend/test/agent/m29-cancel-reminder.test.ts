// M29: cancel_reminder takes back a reminder that hasn't gone off yet (by a piece of its text and /
// or its time), posts "OpenDuet cancelled the reminder for {at}." in the thread, and never cancels
// one already sent; with nothing named or several matches it cancels nothing and lists them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import en from "../../src/i18n/en.json";
import zh from "../../src/i18n/zh-Hans.json";
import type { ToolResultBlock } from "../../src/llm/index.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, now, text, toolData, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });

const FIVE = "2030-10-25T17:00:00+08:00";
const SIX = "2030-10-25T18:00:00+08:00";

/** One turn: the model calls cancel_reminder with `args`, then says something. */
async function cancel(args: Record<string, unknown>, setup?: (fixture: Awaited<ReturnType<typeof turnFixture>>) => Promise<void>) {
  const fixture = await turnFixture(database.db);
  await setup?.(fixture);
  const llm = new RegisteredScriptedModel([[call("cancel_reminder", args, "c")], [text("ok")]]);
  const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now }).runTurn(fixture.input);
  expect(result.status).toBe("completed");
  const block = (llm.requests[1]!.messages.at(-1)!.content as ToolResultBlock[])[0]!;
  const lines = [...fixture.recording.messages.values()].filter((m) => m.kind === "system").map((m) => m.payload);
  const left = await database.db.reminder.findMany({ where: { userId: fixture.input.userId }, orderBy: { at: "asc" }, select: { text: true, firedAt: true } });
  return { fixture, data: toolData(block) as Record<string, unknown>, isError: block.isError === true, lines, left };
}

const remind = (fixture: Awaited<ReturnType<typeof turnFixture>>, at: string, text: string, extra: { channelId?: string; firedAt?: Date } = {}) =>
  database.db.reminder.create({ data: { userId: fixture.input.userId, channelId: extra.channelId ?? fixture.input.channelId, at: new Date(at), text, ...(extra.firedAt ? { firedAt: extra.firedAt } : {}) } });

test("by text: the one reminder goes, the thread gets the cancelled line, the result lists it", async () => {
  const { data, isError, lines, left } = await cancel({ text: "LAUNCH page" }, async (f) => {
    await remind(f, FIVE, "Check the launch page");
    await remind(f, SIX, "Call Mia");
  });
  expect(isError).toBe(false);
  expect(data.cancelled).toEqual([expect.objectContaining({ text: "Check the launch page", at: new Date(FIVE).toISOString(), inThisChannel: true })]);
  expect(lines).toEqual([{ phrase: { key: "system.reminder_cancelled", params: { at: { type: "datetime", value: new Date(FIVE).toISOString() } } } }]);
  expect(left.map((r) => r.text)).toEqual(["Call Mia"]);
});

test("by time (within a minute), in another channel when this one has none", async () => {
  const { data, isError, left } = await cancel({ at: "2030-10-25T17:00:30+08:00" }, async (f) => {
    const other = await database.db.channel.create({ data: { userId: f.input.userId, name: "Website launch" } });
    await remind(f, FIVE, "Check the launch page", { channelId: other.id });
  });
  expect(isError).toBe(false);
  expect(data.cancelled).toEqual([expect.objectContaining({ text: "Check the launch page", inThisChannel: false })]);
  expect(left).toEqual([]);
});

test("several matches without all: nothing cancelled, the candidates come back; with all: every match goes", async () => {
  const both = async (f: Awaited<ReturnType<typeof turnFixture>>) => { await remind(f, FIVE, "Check the launch page"); await remind(f, SIX, "Check the launch email"); };
  const asked = await cancel({ text: "check the launch" }, both);
  expect(asked.isError).toBe(true);
  expect((asked.data.candidates as unknown[]).length).toBe(2);
  expect(asked.lines).toEqual([]);
  expect(asked.left).toHaveLength(2);
  const gone = await cancel({ text: "check the launch", all: true }, both);
  expect(gone.isError).toBe(false);
  expect((gone.data.cancelled as unknown[]).length).toBe(2);
  expect(gone.lines).toHaveLength(2);
  expect(gone.left).toEqual([]);
});

test("nothing named lists the pending ones and cancels nothing; no match lists them too", async () => {
  const listed = await cancel({}, async (f) => { await remind(f, FIVE, "Check the launch page"); });
  expect(listed.isError).toBe(true);
  expect(listed.data.pending).toEqual([expect.objectContaining({ text: "Check the launch page" })]);
  expect(listed.left).toHaveLength(1);
  const missed = await cancel({ text: "dentist" }, async (f) => { await remind(f, FIVE, "Check the launch page"); });
  expect(missed.isError).toBe(true);
  expect(missed.data.note).toBe("No pending reminder matches.");
  expect(missed.data.pending).toHaveLength(1);
  expect(missed.lines).toEqual([]);
});

test("a reminder that already went off is never cancelled (nor listed); someone else's isn't touched", async () => {
  const { isError, lines, left, fixture } = await cancel({ text: "launch" }, async (f) => {
    await remind(f, FIVE, "Check the launch page", { firedAt: now() });
    const stranger = await turnFixture(database.db);
    await remind(stranger, FIVE, "Check the launch page");
  });
  expect(isError).toBe(true);
  expect(lines).toEqual([]);
  expect(left).toEqual([expect.objectContaining({ text: "Check the launch page", firedAt: expect.any(Date) })]);
  expect(await database.db.reminder.count({ where: { userId: { not: fixture.input.userId }, text: "Check the launch page", firedAt: null } })).toBeGreaterThanOrEqual(1);
});

test("the cancelled line is in both languages with the {at} placeholder", () => {
  expect(en.phrases["system.reminder_cancelled"]).toBe("OpenDuet cancelled the reminder for {at}.");
  expect(zh.phrases["system.reminder_cancelled"]).toBe("OpenDuet 取消了 {at} 的提醒。");
});
