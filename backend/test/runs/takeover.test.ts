// M14 A3: a retry knows what the failed attempt did. The note is built from the failed run's
// record (tool calls with a short argument and how they ended, the text it already wrote), capped,
// and reaches the agent as TurnInput.takeover; a first attempt has none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import type { RetryOf } from "../../src/runs/host.ts";
import { composeTakeover, digestLine, RESTART_NOTE, stepOutcome, TAKEOVER_MAX_CHARS, type StepRow } from "../../src/runs/takeover.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

const tool = (name: string, detail: string, status: string, output: unknown = null): StepRow => ({
  kind: "tool", tool: name, detail, status, input: null, output: output === null ? null : JSON.stringify(output),
});
const text = (body: string): StepRow => ({ kind: "text", tool: null, detail: body, status: "ok", input: body, output: null });

describe("composeTakeover", () => {
  test("lists tool calls with argument and outcome, then the texts, in codync's wording", () => {
    const note = composeTakeover([
      tool("make_artifact", "Trip planner", "ok", { status: "building", artifactId: "art_1" }),
      text("I'm building your trip planner now."),
      tool("GMAIL_SEND_EMAIL", "Dinner on Friday", "awaiting_approval"),
      tool("web_search", "night train vienna", "error"),
    ], "chat", "failed")!;
    expect(note.startsWith("[The previous attempt at this turn failed partway through, so you're taking over.")).toBe(true);
    expect(note).toContain("What was already done:\n- make_artifact (Trip planner) → building art_1\n- GMAIL_SEND_EMAIL (Dinner on Friday) → waiting for the user's approval\n- web_search (night train vienna) → failed");
    expect(note).toContain("What the user was already told:\n- \"I'm building your trip planner now.\"");
    expect(note.endsWith("Check what's already done before you redo any step, and don't repeat what the user was already told.]")).toBe(true);
  });

  test("nothing done: no note for a failed attempt, the restart note for an interrupted one", () => {
    expect(composeTakeover([], "chat", "failed")).toBeNull();
    expect(composeTakeover([text("(pass)")], "chat", "failed")).toBeNull();
    expect(composeTakeover([], "chat", "restart")).toBe(RESTART_NOTE);
  });

  test("capped at ~1500 chars, texts cut at 200, repeats collapse, check-in text isn't 'told'", () => {
    const steps = [
      ...Array.from({ length: 80 }, (_, i) => tool(`tool_${i}`, "x".repeat(100), "ok")),
      ...Array.from({ length: 3 }, () => tool("computer_click", "e12", "ok")),
      text("y".repeat(500)),
    ];
    const note = composeTakeover(steps, "chat", "restart")!;
    expect(note.length).toBeLessThanOrEqual(TAKEOVER_MAX_CHARS);
    expect(note).toMatch(/- …and \d+ more/);
    expect(note).toContain(`"${"y".repeat(199)}…"`);
    expect(composeTakeover(Array.from({ length: 3 }, () => tool("computer_click", "e12", "ok")), "chat", "failed")).toContain("computer_click (e12) → ok ×3");
    const checkin = composeTakeover([text("muted text"), tool("post_message", "Your 3pm moved", "ok")], "checkin", "failed")!;
    expect(checkin).not.toContain("muted text");
    expect(checkin).toContain("post_message (Your 3pm moved) → ok");
  });

  test("outcomes and the digest line", () => {
    expect(stepOutcome({ status: "ok", output: JSON.stringify({ taskId: "task_9", status: "working" }) })).toBe("working task_9");
    expect(stepOutcome({ status: "ok", output: "plain text result" })).toBe("ok");
    expect(stepOutcome({ status: "denied", output: null })).toBe("declined");
    expect(digestLine([tool("make_artifact", "Plan", "ok", { status: "building", artifactId: "art_x" }), tool("start_task", "Book", "ok", { taskId: "task_y" })]))
      .toBe("[tools: make_artifact → building art_x; start_task → task_y]");
    expect(digestLine([text("only text")])).toBeNull();
    expect(digestLine(Array.from({ length: 40 }, (_, i) => tool(`a_long_tool_name_${i}`, "", "ok")))!.length).toBeLessThanOrEqual(200);
  });
});

let script: (input: TurnInput) => Promise<TurnResult>;
const agent = stubAgent((input) => script(input));
let fixture: TestApp;
let alex: SignedIn;
beforeAll(async () => {
  fixture = await createTestApp({}, { agent, heartbeatMs: 1000 });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const failed = (): TurnResult => ({ status: "failed", error: { key: "system.model_error", params: { status: { type: "number", value: 502 } } }, usage: usage(1, 1), model: MODEL });
const completed = (): TurnResult => ({ status: "completed", error: null, usage: usage(1, 1), model: MODEL });

describe("RunHost.retry", () => {
  test("the retried turn gets the failed run's steps and bubbles as takeover; the first attempt has none", async () => {
    script = async ({ sink, steps }) => {
      const handle = steps!.toolStart({ type: "tool_use", id: "t1", name: "make_artifact", input: { title: "Trip planner", type: "page", prompt: "x" } });
      steps!.toolEnd(handle, { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: JSON.stringify({ status: "building", artifactId: "art_42" }) }] });
      steps!.text("I'm building your trip planner.");
      steps!.endRound();
      await sink.upsertMessage({ role: "assistant", kind: "text", text: "I'm building your trip planner." });
      return failed();
    };
    const sent = await fixture.runs.send({ userId: alex.userId, channelId: alex.mainChannelId, text: "Make me a trip planner", clientId: "tk-1", fileIds: [], skill: null, quickReply: null });
    await fixture.runs.idle();
    const first = agent.turns.at(-1)!;
    expect(first.takeover).toBeUndefined();

    const card = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "model_error" }, orderBy: { createdAt: "desc" } });
    const stored = JSON.parse(card.payload) as { runId: string; retryOf: RetryOf };
    expect(stored.runId).toBe(sent.runId!);
    script = async () => completed();
    await fixture.runs.retry(alex.userId, stored.runId, stored.retryOf, null);
    await fixture.runs.idle();
    const retried = agent.turns.at(-1)!;
    expect(retried.userMessage.id).toBe(first.userMessage.id);
    expect(retried.takeover).toContain("make_artifact (Trip planner) → building art_42");
    expect(retried.takeover).toContain("\"I'm building your trip planner.\"");
    expect(retried.takeover).toContain("Check what's already done before you redo any step");
  });

  test("a failed attempt that did nothing retries without a note", async () => {
    script = async () => failed();
    await fixture.runs.send({ userId: alex.userId, channelId: alex.mainChannelId, text: "Hello?", clientId: "tk-2", fileIds: [], skill: null, quickReply: null });
    await fixture.runs.idle();
    const card = await fixture.db.message.findFirstOrThrow({ where: { userId: alex.userId, kind: "model_error" }, orderBy: { createdAt: "desc" } });
    const stored = JSON.parse(card.payload) as { runId: string; retryOf: RetryOf };
    script = async () => completed();
    await fixture.runs.retry(alex.userId, stored.runId, stored.retryOf, null);
    await fixture.runs.idle();
    expect(agent.turns.at(-1)!.takeover).toBeUndefined();
  });
});
