// M23 W3 (#30 memory sources): a fact saved outside the chat from something Claude read carries
// sourceRef (where it was read; the id stays on the server); a source this run didn't read is
// refused; chat turns don't take a source; MemoryFact.sourceRef in the API; in the prompt a sourced
// fact is marked with `from` and one line says what that means.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput } from "../../src/agent/types.ts";
import { MemoryState } from "../../src/contract/account.ts";
import type { Message } from "../../src/contract/messages.ts";
import { promptSections } from "../../src/memory/prompt.ts";
import { memoryProvider } from "../../src/memory/provider.ts";
import { SoulService } from "../../src/soul/service.ts";
import { recordingSink } from "../agent/fixtures.ts";
import { startMemoryApp, type MemoryApp } from "./harness.ts";

const EMAIL_ID = "18c2f0a1b2c3d4e5";
let m: MemoryApp;
let runId: string;
beforeAll(async () => {
  m = await startMemoryApp();
  // A check-in run that read one Gmail email (as runs/steps.ts records execute_app_tools).
  const run = await m.fixture.db.run.create({ data: { userId: m.alex.userId, kind: "checkin", status: "running" } });
  runId = run.id;
  await m.fixture.db.runStep.create({ data: {
    id: crypto.randomUUID(), runId, index: 0, kind: "tool", tool: "GMAIL_FETCH_EMAILS", app: "Gmail", title: JSON.stringify({ text: "Fetch emails" }), status: "ok",
    input: JSON.stringify({ query: "newer_than:1d" }), output: JSON.stringify({ messages: [{ messageId: EMAIL_ID, subject: "Re: Q4 budget" }] }),
  } });
});
afterAll(() => m.fixture.cleanup());

const db = () => m.fixture.db;
const provider = () => memoryProvider({ db: db(), soul: new SoulService({ db: db() }) });
const turn = (over: Partial<TurnInput> & { messageId?: string } = {}): TurnInput => {
  const id = over.messageId ?? "turn_checkin_1";
  const message: Message = {
    id, channelId: m.alex.mainChannelId, taskId: null, role: "user", kind: "text", text: "", status: "seen",
    clientId: null, reactions: [], stopped: false, callId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null },
  };
  return {
    userId: m.alex.userId, channelId: m.alex.mainChannelId, taskId: null, kind: "checkin", runId, userMessage: message, attachments: [],
    skill: null, sink: recordingSink(m.alex.mainChannelId).sink, signal: new AbortController().signal, ...over,
  };
};
const remember = (input: Record<string, unknown>, over: Partial<TurnInput> & { messageId?: string } = {}) =>
  provider().execute({ type: "tool_use", id: crypto.randomUUID(), name: "remember", input }, turn(over));
const resultText = (r: Awaited<ReturnType<typeof remember>>) => r.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const source = { app: "gmail", kind: "email", id: EMAIL_ID, title: "Re: Q4 budget", at: "2030-03-19T16:20:00+08:00" };

describe("remember with a source", () => {
  test("outside chat turns remember offers source; chat turns don't (and refuse one)", async () => {
    const schemaOf = async (input: TurnInput) => JSON.stringify((await provider().tools(input)).find((t) => t.name === "remember"));
    for (const kind of ["brief", "checkin", "scan", "routine"] as const) expect(await schemaOf(turn({ kind }))).toContain("\"source\"");
    expect(await schemaOf(turn({ kind: "task", taskId: "task_1" }))).toContain("\"source\"");
    expect(await schemaOf(turn({ kind: "chat", messageId: "msg_1" }))).not.toContain("\"source\"");
    expect(await schemaOf(turn({ kind: "build" }))).not.toContain("\"source\"");
    const refused = await remember({ fact: "Budget review on Friday", source }, { kind: "chat", messageId: "msg_1" });
    expect(refused.result.isError).toBe(true);
    expect(await db().memory.count({ where: { userId: m.alex.userId, text: "Budget review on Friday" } })).toBe(0);
  });

  test("a source read in this run: the fact keeps it (the record's app name); the API shows it without the id", async () => {
    const saved = await remember({ fact: "Q4 budget review is with Priya on 2030-03-22", source });
    expect(saved.result.isError).toBeUndefined();
    const row = await db().memory.findFirstOrThrow({ where: { userId: m.alex.userId, text: "Q4 budget review is with Priya on 2030-03-22" } });
    expect(JSON.parse(row.sourceRef!)).toEqual({ app: "Gmail", kind: "email", id: EMAIL_ID, title: "Re: Q4 budget", at: "2030-03-19T16:20:00+08:00" });
    expect(row.sourceMessageId).toBeNull();

    // "About you" (GET /api/memory) lists it with its source; the id stays on the server.
    const response = await m.fixture.app.request("/api/memory", { headers: m.alex.headers });
    const body = await response.text();
    expect(body).not.toContain(EMAIL_ID);
    const fact = MemoryState.parse(JSON.parse(body)).facts.find((f) => f.id === row.id)!;
    expect(fact.sourceRef).toEqual({ app: "Gmail", kind: "email", title: "Re: Q4 budget", at: "2030-03-19T08:20:00.000Z" });
  });

  test("a source this run didn't read is refused and nothing is saved; without a source it saves as before", async () => {
    const other = await db().run.create({ data: { userId: m.alex.userId, kind: "checkin", status: "running" } });
    const refused = await remember({ fact: "Lease renews in June", source: { ...source, id: "18ffffffffffffff" } });
    expect(refused.result.isError).toBe(true);
    expect(resultText(refused)).toContain("wasn't read in this turn");
    const elsewhere = await remember({ fact: "Lease renews in June", source }, { runId: other.id });
    expect(elsewhere.result.isError).toBe(true);
    expect(await db().memory.count({ where: { userId: m.alex.userId, text: "Lease renews in June" } })).toBe(0);

    await remember({ fact: "Prefers morning meetings" });
    expect((await db().memory.findFirstOrThrow({ where: { userId: m.alex.userId, text: "Prefers morning meetings" } })).sourceRef).toBeNull();
  });
});

describe("sourced facts in the prompt", () => {
  test("a sourced fact carries from {app, kind, title, at} and one line explains it; the id never goes in", async () => {
    const channel = await db().channel.findUniqueOrThrow({ where: { id: m.alex.mainChannelId } });
    const { memory } = await promptSections(db(), m.alex.userId, channel, "Alex");
    const all = memory.join("\n");
    expect(all).not.toContain(EMAIL_ID);
    const facts = JSON.parse(memory.find((l) => l.startsWith("Memory facts: "))!.slice("Memory facts: ".length)) as { text: string; from?: unknown }[];
    expect(facts.find((f) => f.text === "Q4 budget review is with Priya on 2030-03-22")?.from).toEqual({ app: "Gmail", kind: "email", title: "Re: Q4 budget", at: "2030-03-19T08:20:00.000Z" });
    expect(facts.find((f) => f.text === "Prefers morning meetings")).not.toHaveProperty("from");
    expect(memory.some((l) => l.startsWith("A fact with from was saved from something you read"))).toBe(true);
  });

  test("no sourced fact, no extra line", async () => {
    const solo = await db().channel.create({ data: { userId: m.alex.userId, name: "Solo", purpose: "", useSharedMemory: false } });
    await db().memory.create({ data: { userId: m.alex.userId, channelId: solo.id, kind: "fact", text: "Uses metric units" } });
    const { memory } = await promptSections(db(), m.alex.userId, solo, "Alex");
    expect(memory.some((l) => l.startsWith("A fact with from"))).toBe(false);
  });
});
