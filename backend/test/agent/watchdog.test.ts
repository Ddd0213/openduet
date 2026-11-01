// M21 (#13) tool-call watchdog: a call past its limit is abandoned with an error result for the
// model (the turn goes on) and whatever it writes later is dropped; Stop on a turn whose tool hangs
// returns at once and the message queued behind it runs (no waiting for the hung tool). The limits
// stay above the tools' own timeouts (computer_exec up to 600 s). Real run host + runtime, scripted model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentRuntime, TOOL_LIMIT_MS, toolLimitMs } from "../../src/agent/runtime.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { StopResponse } from "../../src/contract/messages.ts";
import type { ToolUseBlock } from "../../src/llm/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, RoleScriptedLlm, text } from "../tasks/harness.ts";

let fixture: TestApp;
let llm: RoleScriptedLlm;
let alex: SignedIn;
let reached = deferred();
let lateWrites = 0;

/** hang: never answers (and ignores its signal). slow: answers after 600 ms and then posts a bubble. */
const tools: ToolProvider = {
  name: "watchdog-test",
  tools: async () => [
    { name: "hang_app", description: "Never answers", inputSchema: { type: "object", properties: {} } },
    { name: "slow_app", description: "Answers late", inputSchema: { type: "object", properties: {} } },
  ],
  async execute(use, input) {
    reached.resolve();
    if (use.name === "hang_app") return new Promise(() => {});
    await Bun.sleep(600);
    try {
      await input.sink.upsertMessage({ role: "assistant", kind: "text", text: "late bubble" });
    } catch {
      lateWrites++;
    }
    return { result: { type: "tool_result", toolUseId: use.id, content: [{ type: "text", text: "{\"ok\":true}" }] }, endTurn: false };
  },
};

beforeAll(async () => {
  llm = new RoleScriptedLlm();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const agent = createAgentRuntime({
        db: core.db, llm, config: core.config, providers: [tools],
        toolLimitMs: (use: ToolUseBlock) => (use.name === "slow_app" ? 300 : 10 * 60_000),
      });
      return { agent, runs: new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent }) };
    },
  });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const send = (channelId: string, body: string, clientId: string) => fixture.app.request(`/api/channels/${channelId}/messages`, json(alex, "POST", { text: body, clientId }));
const newChannel = async (name: string) => (await fixture.db.channel.create({ data: { userId: alex.userId, name, purpose: "" } })).id;

describe("tool-call watchdog", () => {
  test("Stop while a tool hangs: answered at once, the run ends cancelled, the next message runs", async () => {
    const channelId = await newChannel("Hung tool");
    reached = deferred();
    llm.script("chat", [call("hang_app", {})], [text("Second answer")]);
    const first = await send(channelId, "Use the app", "wd-1");
    await reached.promise;
    const second = await send(channelId, "Are you there?", "wd-2");
    const started = Date.now();
    const stop = await fixture.app.request(`/api/channels/${channelId}/stop`, json(alex, "POST"));
    expect(StopResponse.parse(await stop.json())).toEqual({ stopped: 1 });
    expect(Date.now() - started).toBeLessThan(3000);
    const [a, b] = await Promise.all([readSse(first, { timeoutMs: 5000 }), readSse(second, { timeoutMs: 5000 })]);
    expect(a.events.filter((e) => e.type === "done").at(-1)?.payload).toMatchObject({ status: "cancelled" });
    expect(b.events.filter((e) => e.type === "done").at(-1)?.payload).toMatchObject({ status: "completed" });
    await fixture.runs.idle();
    const runs = await fixture.db.run.findMany({ where: { channelId }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["cancelled", "completed"]);
    const replies = await fixture.db.message.findMany({ where: { channelId, role: "assistant" }, orderBy: { createdAt: "asc" } });
    expect(replies.map((m) => m.text)).toEqual(["Second answer"]);
    // The run record shows the hung call as stopped.
    const step = await fixture.db.runStep.findFirstOrThrow({ where: { runId: runs[0]!.id, tool: "hang_app" } });
    expect(step.status).toBe("error");
  });

  test("past its limit: the model gets an error result that says it may have happened, the turn goes on, a late write is dropped", async () => {
    const channelId = await newChannel("Slow tool");
    reached = deferred();
    lateWrites = 0;
    llm.script("chat", [call("slow_app", {})], [text("The app didn't answer in time.")]);
    const frames = await readSse(await send(channelId, "Use the slow app", "wd-3"), { timeoutMs: 5000 });
    expect(frames.events.filter((e) => e.type === "done").at(-1)?.payload).toMatchObject({ status: "completed" });
    const results = llm.sent("chat").at(-1)!.messages.at(-1)!.content.filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(1);
    const data = JSON.parse(results[0]!.type === "tool_result" && results[0]!.content[0]?.type === "text" ? results[0]!.content[0].text : "{}") as { error: string; reason: string };
    expect(data.reason).toBe("timeout");
    expect(data.error).toContain("may still have done some or all of its work");
    expect(results[0]).toMatchObject({ isError: true });
    // The tool wakes up after the turn: its bubble never reaches the thread.
    await Bun.sleep(500);
    expect(lateWrites).toBe(1);
    const texts = (await fixture.db.message.findMany({ where: { channelId, role: "assistant" } })).map((m) => m.text);
    expect(texts).toEqual(["The app didn't answer in time."]);
  });

  test("the limits stay above each tool's own timeout", () => {
    const use = (name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id: "x", name, input });
    // computer_exec: its own timeout (default 120 s, at most 600 s) plus the grace.
    expect(toolLimitMs(use("computer_exec", {}))).toBe(120_000 + TOOL_LIMIT_MS.execGrace);
    expect(toolLimitMs(use("computer_exec", { timeoutSeconds: 600 }))).toBe(600_000 + TOOL_LIMIT_MS.execGrace);
    expect(toolLimitMs(use("computer_exec", { timeoutSeconds: 9999 }))).toBe(600_000 + TOOL_LIMIT_MS.execGrace);
    expect(toolLimitMs(use("computer_navigate"))).toBeGreaterThan(10 * 60_000 + 60_000);
    expect(toolLimitMs(use("run_skill_script"))).toBeGreaterThan(300_000 + 15_000);
    expect(toolLimitMs(use("execute_app_tools", { calls: Array.from({ length: 10 }, () => ({})) }))).toBe(TOOL_LIMIT_MS.appTools);
    expect(toolLimitMs(use("web_fetch"))).toBe(TOOL_LIMIT_MS.default);
  });
});
