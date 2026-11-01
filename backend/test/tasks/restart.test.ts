// L70 restart: a task still working when the server stops (or crashes) becomes needs_input with
// "Paused by a server restart. Reply to continue."; its runs are cancelled with the task's RunRef;
// replying on the next process resumes the task's session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TaskDetail } from "../../src/contract/tasks.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, lastEventId, ofType, RoleScriptedLlm, restarted, startApp, storedEvents, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
let next: ReturnType<typeof restarted> | undefined;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => {
  await next?.runs.shutdown();
  await t.fixture.cleanup();
});

describe("server restart", () => {
  test("a working task is paused by the restart, its runs are cancelled, and a reply resumes its session", async () => {
    // First process: the task is mid-turn when the server shuts down.
    const reached = deferred();
    const gate = deferred();
    t.llm.script("chat", [call("start_task", { title: "Compare flights", prompt: "Compare flights to Lisbon for May 19" })]);
    t.llm.script("task", async (request) => {
      reached.resolve();
      await gate.promise;
      if (request.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return [text("Found three options.")];
    });
    await readSse(await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: "Compare flights to Lisbon", clientId: "x-1" })));
    await reached.promise;
    const task = await t.fixture.db.task.findFirstOrThrow({ where: { userId: t.alex.userId, title: "Compare flights" } });
    const stopping = t.fixture.runs.shutdown();
    gate.resolve();
    await stopping;
    // Shutdown leaves the task as it was; the cancelled run says so.
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("working");
    expect((await t.fixture.db.run.findFirstOrThrow({ where: { taskId: task.id } })).status).toBe("cancelled");

    // A crash instead leaves a run "running" that nobody runs any more.
    const crashed = await t.fixture.db.task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Crashed", status: "needs_input" } });
    const stale = await t.fixture.db.run.create({ data: { userId: t.alex.userId, kind: "task", status: "running", channelId: t.alex.mainChannelId, taskId: crashed.id, startedAt: new Date() } });

    // Second process on the same database.
    const before = await lastEventId(t.fixture);
    const llm = new RoleScriptedLlm();
    next = restarted(t.fixture, llm);
    expect(await next.tasks.service.recoverAfterRestart()).toBe(2);
    expect(await next.runs.recoverStaleRuns()).toBe(1);
    expect((await t.fixture.db.run.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("cancelled");

    for (const id of [task.id, crashed.id]) {
      const d = TaskDetail.parse(await (await next.app.request(`/api/tasks/${id}`, { headers: t.alex.headers })).json());
      expect(d.status).toBe("needs_input");
      expect(d.latestUpdate).toMatchObject({ text: { key: "task.paused_restart" }, source: "OpenDuet" });
    }
    const events = await storedEvents(t.fixture, t.alex.userId, before);
    expect(ofType(events, "task").map((e) => e.payload.task.id).sort()).toEqual([task.id, crashed.id].sort());
    expect(ofType(events, "done").map((e) => e.payload)).toEqual([{ runId: stale.id, taskId: crashed.id, kind: "task", status: "cancelled", error: null }]);
    expect(ofType(events, "status").every((e) => e.payload.taskId === crashed.id && e.payload.status === null)).toBe(true);
    const chip = await t.fixture.db.message.findUniqueOrThrow({ where: { id: task.spawnMessageId! } });
    expect(JSON.parse(chip.payload).task).toMatchObject({ status: "needs_input", updateCount: 1 });

    // Replying resumes the task's session on the new process.
    llm.script("task", [call("finish_task", { summary: "Three options compared." })]);
    const frames = await readSse(await next.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "Please continue", clientId: "x-2" })));
    // back to work, the finish summary (an update), then done (M18: resolved, nothing of the user's touched)
    expect(ofType(frames, "task").map((e) => e.payload.task.status)).toEqual(["working", "working", "resolved"]);
    expect(ofType(frames, "done").at(-1)!.payload).toMatchObject({ taskId: task.id, status: "completed" });
    const request = llm.sent("task")[0]!;
    expect(request.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Please continue" }] });
    expect(request.system).toContain("Paused by a server restart");
    expect(request.system).toContain("Compare flights to Lisbon for May 19");
  });
});
