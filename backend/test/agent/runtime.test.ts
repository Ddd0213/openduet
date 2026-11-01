import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { TextBubbles } from "../../src/agent/bubbles.ts";
import { LlmError, type LlmEvent } from "../../src/llm/index.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, now, recordingSink, text, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });
function runtime(llm: RegisteredScriptedModel) { return createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now }); }

describe("agent streaming", () => {
  test("tool status order, typing, thinking replay, usage total and pin to first done", async () => {
    const { input, recording } = await turnFixture(database.db);
    const pin = { providerId: "scripted-test-only", modelId: "fallback" };
    const use = call("remember", { fact: "喜欢简洁回复" }, "save");
    const llm = new RegisteredScriptedModel([
      [{ type: "thinking_delta", text: "private reasoning" }, use, { type: "usage", inputTokens: 3, outputTokens: 4, estimated: false }, { type: "done", model: pin, stopReason: "tool_use", message: { role: "assistant", content: [{ type: "thinking", text: "private reasoning", origin: pin }, { type: "tool_use", id: "save", name: "remember", input: { fact: "喜欢简洁回复" } }] } }],
      [text("记住了"), { type: "usage", inputTokens: 5, outputTokens: 6, estimated: true }],
    ], { thinking: true });
    llm.models.models.push({ ...llm.models.models[0]!, id: "fallback" });
    const result = await runtime(llm).runTurn(input);
    expect(result).toMatchObject({ status: "completed", model: pin, usage: { inputTokens: 8, outputTokens: 10, estimated: true } });
    expect(recording.statuses).toEqual(["thinking", "checking_memory", "thinking", null]);
    expect(recording.typing).toEqual([true, false, false]);
    expect([...recording.messages.values()].map(m => m.text)).toEqual(["记住了"]);
    expect(llm.requests[0]?.pin).toBeUndefined();
    expect(llm.requests[1]?.pin).toEqual(pin);
    expect(llm.requests[1]?.thinking).toBe(true);
    expect(llm.requests[1]?.messages[1]?.content[0]?.type).toBe("thinking");
  });

  test("throttles a bubble to 125 ms and always writes its full final text", async () => {
    const { input, recording } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([Array.from({ length: 100 }, () => text("中"))]);
    expect((await runtime(llm).runTurn(input)).status).toBe("completed");
    expect(recording.messages.size).toBe(1);
    expect(recording.updates.length).toBeLessThan(5);
    expect(recording.updates.at(-1)?.draft).toMatchObject({ text: "中".repeat(100) });
    for (let i = 1; i < recording.updates.length; i++) expect(recording.updates[i]!.at - recording.updates[i - 1]!.at).toBeGreaterThanOrEqual(123);
  });

  test("splits long paragraphs into bubbles without splitting code or tables", async () => {
    const recording = recordingSink();
    const bubbles = new TextBubbles(recording.sink);
    const paragraph = "介绍".repeat(320) + "\n\n";
    const code = "```ts\n" + "const x = 1;\n\n".repeat(80) + "```\n\n";
    const table = "| Item | Value |\n| --- | --- |\n" + "| 中文 | 内容 |\n".repeat(90) + "\n";
    const value = paragraph + code + paragraph + table + "结尾";
    for (let i = 0; i < value.length; i += 97) await bubbles.append(value.slice(i, i + 97));
    await bubbles.finish();
    const parts = [...recording.messages.values()].map(message => message.text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join("")).toBe(value);
    expect(parts.some(part => part.includes(code))).toBe(true);
    expect(parts.some(part => part.includes(table))).toBe(true);
  });

  test("LlmError keeps partial output and returns the exact phrase without invented replies", async () => {
    const { input, recording } = await turnFixture(database.db);
    const error = new LlmError({ kind: "http", status: 401, providerId: "test", modelId: "test", attempts: 1 });
    const llm = new RegisteredScriptedModel([[text("partial"), text(" output"), error]]);
    expect(await runtime(llm).runTurn(input)).toMatchObject({ status: "failed", error: error.toPhrase(), model: null });
    expect([...recording.messages.values()].map(m => m.text)).toEqual(["partial output"]);
    expect(recording.statuses.at(-1)).toBeNull(); expect(recording.typing.at(-1)).toBe(false);
  });

  test("no output is invented for a pre-stream or internal failure", async () => {
    for (const failure of [new LlmError({ kind: "timeout", providerId: "test", modelId: "test", attempts: 1 }), new Error("secret internal detail")]) {
      const { input, recording } = await turnFixture(database.db);
      const llm = new RegisteredScriptedModel([() => { throw failure; }]);
      const result = await runtime(llm).runTurn(input);
      expect(result.status).toBe("failed"); expect(recording.messages.size).toBe(0);
      expect(result.error).toEqual(failure instanceof LlmError ? failure.toPhrase() : { key: "system.model_unreachable", params: { reason: { type: "text", value: "internal" } } });
    }
  });

  test("vision and thinking gates, named text attachments", async () => {
    for (const vision of [true, false]) {
      const { input } = await turnFixture(database.db);
      input.attachments = [{ type: "image", fileId: "image", name: "图片.png", mime: "image/png", mediaType: "image/png", data: "eA==" }, { type: "text", fileId: "text", name: "文档.txt", mime: "text/plain", text: "发布说明", truncated: true }];
      const llm = new RegisteredScriptedModel([[text("好")]], { vision });
      expect((await runtime(llm).runTurn(input)).status).toBe("completed");
      const request = llm.requests[0]!;
      expect(request.messages.at(-1)?.content.some(block => block.type === "image")).toBe(vision);
      expect(JSON.stringify(request.messages)).toContain("文档.txt");
      expect(JSON.stringify(request.messages)).toContain("发布说明");
      if (!vision) expect(JSON.stringify(request.messages)).toContain("图片.png");
      expect(request.thinking).toBeUndefined();
    }
  });

  test("context has memory, local clock, language and only the recent matching thread", async () => {
    const { input } = await turnFixture(database.db, true);
    await database.db.memory.createMany({ data: [{ userId: input.userId, kind: "document", text: "用户记忆文档" }, { userId: input.userId, kind: "fact", text: "记忆事实" }] });
    await database.db.message.createMany({ data: [
      { userId: input.userId, channelId: input.channelId, taskId: null, role: "user", text: "other thread" },
      { userId: input.userId, channelId: input.channelId, taskId: input.taskId, role: "system", text: "skip system" },
      ...Array.from({ length: 35 }, (_, i) => ({ userId: input.userId, channelId: input.channelId, taskId: input.taskId, role: i % 2 ? "assistant" : "user", text: `history ${i}`, createdAt: new Date(now().getTime() - (36 - i) * 1000) })),
    ] });
    const llm = new RegisteredScriptedModel([[text("收到")]]);
    await runtime(llm).runTurn(input);
    const request = llm.requests[0]!;
    expect(request.role).toBe("task");
    for (const value of ["用户记忆文档", "记忆事实", "发布", "准备发布评审", "zh-Hans", "Asia/Shanghai", "16:00:00", "星期五", "早上好"]) expect(request.system).toContain(value);
    // 29 stored rows (history 6..34) + the current message; history 34 is the user's, so it
    // merges with the current message into one user turn.
    expect(request.messages).toHaveLength(29);
    expect(JSON.stringify(request.messages)).not.toContain("other thread");
    expect(JSON.stringify(request.messages)).not.toContain("skip system");
    expect(request.messages[0]?.content).toEqual([{ type: "text", text: "history 6" }]);
    expect(request.messages.at(-1)?.content).toEqual([{ type: "text", text: "history 34" }, { type: "text", text: "帮我看看" }]);
  });

  test("history starts with the user, alternates roles and never sends empty text", async () => {
    const { input } = await turnFixture(database.db);
    const at = (s: number) => new Date(now().getTime() - (10 - s) * 1000);
    await database.db.message.createMany({ data: [
      { userId: input.userId, channelId: input.channelId, taskId: null, role: "assistant", kind: "text", text: "Morning brief", createdAt: at(1) },
      { userId: input.userId, channelId: input.channelId, taskId: null, role: "assistant", kind: "task_spawn", text: "", createdAt: at(2) },
      { userId: input.userId, channelId: input.channelId, taskId: null, role: "user", kind: "text", text: "", createdAt: at(3) },
    ] });
    const llm = new RegisteredScriptedModel([[text("ok")]]);
    await runtime(llm).runTurn(input);
    const messages = llm.requests[0]!.messages;
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "Morning brief" }, { type: "text", text: "[task_spawn]" }]);
    for (const m of messages) for (const b of m.content) if (b.type === "text") expect(b.text.trim().length).toBeGreaterThan(0);
  });

  test("native web tools replace functions; key-less search is otherwise offered", async () => {
    for (const native of [true, false]) {
      const { input } = await turnFixture(database.db);
      const llm = new RegisteredScriptedModel([[text("收到")]], { serverWebTools: native });
      await runtime(llm).runTurn(input);
      const request = llm.requests[0]!;
      expect(request.tools?.some(tool => tool.name === "web_search")).toBe(!native);
      expect(request.tools?.some(tool => tool.name === "web_fetch")).toBe(!native);
      expect(request.serverTools).toEqual(native ? ["web_search", "web_fetch"] : undefined);
      expect(request.system).not.toContain("Web search isn't set up yet");
    }
  });

  describe("a reply cut off by the output limit", () => {
    const cut = { type: "stop", stopReason: "max_tokens" } as const;
    const lastUserText = (request: { messages: { role: string; content: { type: string; text?: string }[] }[] } | undefined) =>
      request?.messages.at(-1)?.role === "user" ? request.messages.at(-1)!.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
    test("reasoning only: the model is told and goes again; the run completes", async () => {
      const { input, recording } = await turnFixture(database.db);
      const llm = new RegisteredScriptedModel([
        [{ type: "thinking_delta", text: "long reasoning" }, cut],
        [text("短一点的回答")],
      ], { thinking: true });
      const result = await runtime(llm).runTurn(input);
      expect(result.status).toBe("completed");
      expect(llm.requests).toHaveLength(2);
      expect(lastUserText(llm.requests[1] as never)).toContain("output limit");
      expect(llm.requests[1]!.messages.at(-1)!.role).toBe("user");
      expect([...recording.messages.values()].map(m => m.text)).toEqual(["短一点的回答"]);
    });
    test("a dropped tool call: finished calls still run and the note follows their results", async () => {
      const { input } = await turnFixture(database.db);
      const use = call("remember", { fact: "喜欢简洁回复" }, "kept");
      const llm = new RegisteredScriptedModel([
        [use, { type: "done", stopReason: "max_tokens", droppedTools: 1, model: { providerId: "scripted-test-only", modelId: "scripted-test-only" }, message: { role: "assistant", content: [{ type: "tool_use", id: "kept", name: "remember", input: { fact: "喜欢简洁回复" } }] } }],
        [text("好的")],
      ]);
      const result = await runtime(llm).runTurn(input);
      expect(result.status).toBe("completed");
      const last = llm.requests[1]!.messages.at(-1)!;
      expect(last.role).toBe("user");
      expect(last.content.map(b => b.type)).toEqual(["tool_result", "text"]);
      expect(lastUserText(llm.requests[1] as never)).toContain("output limit");
    });
    test("cut off three times in a row: failed with the output-limit phrase, nothing invented", async () => {
      const { input, recording } = await turnFixture(database.db);
      const llm = new RegisteredScriptedModel([
        [{ type: "thinking_delta", text: "a" }, cut],
        [{ type: "thinking_delta", text: "b" }, cut],
        [{ type: "thinking_delta", text: "c" }, cut],
        [text("never reached")],
      ], { thinking: true });
      const result = await runtime(llm).runTurn(input);
      expect(result).toMatchObject({ status: "failed", error: { key: "system.model_output_limit" } });
      expect(llm.requests).toHaveLength(3);
      expect([...recording.messages.values()].map(m => m.text)).toEqual([]);
    });
    test("text that ran to the limit is kept and the run completes as before", async () => {
      const { input, recording } = await turnFixture(database.db);
      const llm = new RegisteredScriptedModel([[text("一段被截断的长回答"), cut]]);
      const result = await runtime(llm).runTurn(input);
      expect(result.status).toBe("completed");
      expect(llm.requests).toHaveLength(1);
      expect([...recording.messages.values()].map(m => m.text)).toEqual(["一段被截断的长回答"]);
    });
  });
  // M14a B3: 12 tool rounds, then one tool-less wrap-up call (was: failed with "Tool loop limit reached").
  test("loop is bounded at 12 tool rounds plus one tool-less wrap-up call; abort is cancelled and idle", async () => {
    const { input, recording } = await turnFixture(database.db);
    const script: LlmEvent[][] = Array.from({ length: 14 }, (_, i) => [call("remember", { fact: `fact ${i}` })]);
    const llm = new RegisteredScriptedModel(script);
    expect((await runtime(llm).runTurn(input)).status).toBe("completed"); expect(llm.requests).toHaveLength(13);
    expect(llm.requests[12]!.tools).toEqual([]);
    expect(JSON.stringify(llm.requests[12]!.messages.at(-1))).toContain("You have reached the maximum number of steps for this turn");
    const controller = new AbortController(); controller.abort(); input.signal = controller.signal;
    expect((await runtime(llm).runTurn(input)).status).toBe("cancelled");
    expect(recording.statuses.at(-1)).toBeNull();
  });
});
