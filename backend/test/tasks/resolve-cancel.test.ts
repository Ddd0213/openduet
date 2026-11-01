// M21 (C14): marking a task done (PATCH status resolved) cancels the turn its session is running,
// so it spends nothing more and calls no more tools; the task stays resolved after the turn ends.
// A turn of another task, or of the chat, is not touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TaskDetail } from "../../src/contract/tasks.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { deferred, json, startApp, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

/** One model call that waits until released or until its turn is aborted (then records that). */
function held(reply = "Still working.") {
  const reached = deferred();
  const release = deferred();
  let aborted = false;
  const turn: ScriptTurn = async (request: LlmRequest) => {
    reached.resolve();
    const abort = new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([release.promise, abort]);
    if (request.signal?.aborted) {
      aborted = true;
      throw new Error("aborted");
    }
    return [text(reply)];
  };
  return { turn, reached: reached.promise, release: () => release.resolve(), wasAborted: () => aborted };
}

const start = async (prompt: string) => {
  const response = await t.fixture.app.request("/api/tasks", json(t.alex, "POST", { prompt, channelId: t.alex.mainChannelId }));
  expect(response.status).toBe(200);
  return TaskDetail.parse(await response.json());
};

describe("a task marked done", () => {
  test("cancels its running turn; the task stays resolved and the model isn't called again", async () => {
    const turn = held();
    t.llm.script("task", turn.turn);
    const task = await start("Compare three flights to Lisbon");
    await turn.reached;
    const running = await t.fixture.db.run.findFirstOrThrow({ where: { taskId: task.id, status: "running" } });
    const calls = t.llm.sent("task").length;

    const response = await t.fixture.app.request(`/api/tasks/${task.id}`, json(t.alex, "PATCH", { status: "resolved" }));
    expect(response.status).toBe(200);
    expect(TaskDetail.parse(await response.json()).status).toBe("resolved");
    // cancel() waits for the turn to write its result, so it's over by the time PATCH answers.
    expect(turn.wasAborted()).toBe(true);
    await t.fixture.runs.idle();

    expect((await t.fixture.db.run.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("cancelled");
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("resolved");
    expect(t.llm.sent("task")).toHaveLength(calls);
  });

  test("another task's turn keeps running", async () => {
    const other = held("Other done.");
    t.llm.script("task", other.turn);
    const busy = await start("Draft the newsletter");
    await other.reached;
    const idle = await t.fixture.db.task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Already idle", status: "needs_input" } });

    const response = await t.fixture.app.request(`/api/tasks/${idle.id}`, json(t.alex, "PATCH", { status: "resolved" }));
    expect(response.status).toBe(200);
    expect(other.wasAborted()).toBe(false);
    expect(await t.fixture.db.run.count({ where: { taskId: busy.id, status: "running" } })).toBe(1);
    other.release();
    await t.fixture.runs.idle();
    expect(other.wasAborted()).toBe(false);
    expect(await t.fixture.db.run.count({ where: { taskId: busy.id, status: "completed" } })).toBe(1);
  });
});
