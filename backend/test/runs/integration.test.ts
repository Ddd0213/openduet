// The whole chat path in-process: route -> run host -> real agent runtime -> scripted model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { LlmError } from "../../src/llm/index.ts";
import { memoryProvider } from "../../src/memory/provider.ts";
import { SoulService } from "../../src/soul/service.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";

const llm = new RegisteredScriptedModel([
  // turn 1: remember a fact, then answer in two rounds
  [{ type: "tool_call", id: "t1", name: "remember", input: { fact: "Prefers short answers" } }, { type: "usage", inputTokens: 40, outputTokens: 8, estimated: false }],
  [{ type: "text_delta", text: "Got it, " }, { type: "text_delta", text: "I'll keep it short." }, { type: "usage", inputTokens: 60, outputTokens: 12, estimated: false }],
  // turn 2: ask with quick replies (ends the turn)
  [{ type: "tool_call", id: "t2", name: "quick_replies", input: { text: "Morning or evening?", options: ["Morning", "Evening"] } }],
  // turn 3: the gateway fails
  new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }),
]);

let fixture: TestApp;
let alex: SignedIn;

beforeAll(async () => {
  // M11: remember is the memory provider's (src/memory/), wired like index.ts does.
  fixture = await createTestApp({}, { agent: ({ db, config }) => createAgentRuntime({ db, llm, config, providers: [memoryProvider({ db, soul: new SoulService({ db }) })] }) });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const send = async (text: string, clientId: string) =>
  readSse(await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, {
    method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId }),
  }));
const statuses = (f: SseFrames) => f.events.flatMap((e) => (e.type === "status" ? [e.payload.status] : []));
const done = (f: SseFrames) => f.events.find((e) => e.type === "done");

describe("route -> agent runtime -> scripted model", () => {
  test("a tool round and a streamed reply reach the app, the store and the run", async () => {
    const frames = await send("Remember I like short answers", "i-1");
    expect(statuses(frames)).toEqual(["thinking", "checking_memory", "thinking", null]);
    const reply = frames.events.flatMap((e) => (e.type === "message" && e.payload.message.role === "assistant" ? [e.payload.message] : [])).at(-1);
    expect(reply?.text).toBe("Got it, I'll keep it short.");
    expect(done(frames)?.payload).toMatchObject({ status: "completed", error: null });
    expect(await fixture.db.memory.count({ where: { userId: alex.userId, text: "Prefers short answers" } })).toBe(1);
    const run = await fixture.db.run.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
    expect(run).toMatchObject({ status: "completed", inputTokens: 100, outputTokens: 20, model: "scripted-test-only" });
    // The model saw the user's message as the last turn.
    expect(JSON.stringify(llm.requests[0]?.messages.at(-1))).toContain("Remember I like short answers");
  });

  test("quick replies end the turn with a chip card", async () => {
    const frames = await send("Set up my brief", "i-2");
    const card = frames.events.flatMap((e) => (e.type === "message" && e.payload.message.kind === "quick_replies" ? [e.payload.message] : [])).at(-1);
    expect(card).toMatchObject({ text: "Morning or evening?", payload: { options: ["Morning", "Evening"], chosen: null } });
    expect(done(frames)?.payload.status).toBe("completed");
  });

  test("a gateway error ends failed with a model_error card (system.model_error) and no invented reply", async () => {
    const frames = await send("Hello?", "i-3");
    const assistantMessages = frames.events.filter((e) => e.type === "message" && e.payload.message.role === "assistant");
    expect(assistantMessages).toHaveLength(0);
    // M12: the model_error card replaces the grey system line.
    expect(frames.events.some((e) => e.type === "message" && e.payload.message.kind === "system")).toBe(false);
    const card = frames.events.flatMap((e) => (e.type === "message" && e.payload.message.kind === "model_error" ? [e.payload.message] : [])).at(-1);
    expect(card?.kind === "model_error" && card.payload).toMatchObject({
      phrase: { key: "system.model_error", params: { status: { type: "number", value: 502 } } }, modelId: null, modelLabel: null, retry: true, state: "open",
    });
    expect(JSON.stringify(card)).not.toContain("retryOf");
    expect(done(frames)?.payload).toMatchObject({ status: "failed", error: { key: "system.model_error" } });
  });
});
