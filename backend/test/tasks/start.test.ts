// start_task from a chat turn (L70, L102) and the task's own turns: "On it" + the spawn chip under
// the user's message, the chat turn ends at once and the task runs on its own queue; steps,
// updates and resources go into the task with events and the chip follows; finish_task, ask_user,
// a pending approval, a failure, and resumeAfterApproval. Route -> host -> real runtime -> scripted model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { phrase } from "../../src/agent/phrase.ts";
import { MessagePage } from "../../src/contract/messages.ts";
import { TaskDetail } from "../../src/contract/tasks.ts";
import { LlmError } from "../../src/llm/index.ts";
import { offeredNames } from "../helpers/offered.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, lastEventId, messagesOf, ofType, startApp, storedEvents, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

const chat = (body: string, clientId: string) => t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: body, clientId }));
const reply = (taskId: string, body: string, clientId: string) => t.fixture.app.request(`/api/tasks/${taskId}/messages`, json(t.alex, "POST", { text: body, clientId }));
const detail = async (taskId: string) => TaskDetail.parse(await (await t.fixture.app.request(`/api/tasks/${taskId}`, { headers: t.alex.headers })).json());
const gmailPreview = JSON.stringify({ kind: "email", app: "Gmail", to: ["sam@example.com"], cc: [], subject: "Offsite dates", body: "May 19-20 works for us.", attachments: [] });

let taskId = "";
let anchorId = "";
let chipId = "";

describe("start_task", () => {
  test("creates the task, posts the chip under the user's message and \"On it\", and ends the chat turn at once", async () => {
    const reached = deferred();
    const gate = deferred();
    t.llm.script("chat", [call("start_task", { title: "Plan the offsite", prompt: "Plan a two-day team offsite in Lisbon in May" })]);
    t.llm.script("task", async () => { reached.resolve(); await gate.promise; return [text("Looking at venues.")]; });

    const frames = await readSse(await chat("Can you plan our team offsite in Lisbon?", "s-1"));
    // The chat stream ended on the chat run's done while the task's first turn is still held.
    const done = ofType(frames, "done");
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ taskId: null, status: "completed" });
    expect(t.llm.sent("chat")).toHaveLength(1);

    const all = messagesOf(frames);
    const echo = all.find((m) => m.role === "user")!;
    const chip = all.find((m) => m.kind === "task_spawn")!;
    const onIt = all.find((m) => m.role === "assistant" && m.kind === "text")!;
    expect(chip.kind === "task_spawn" && chip.payload.anchorMessageId).toBe(echo.id);
    expect(chip.taskId).toBeNull();
    expect(onIt).toMatchObject({ text: phrase("agent.on_it", "en"), taskId: null });
    if (chip.kind !== "task_spawn") throw new Error("no chip");
    taskId = chip.payload.task.id;
    anchorId = echo.id;
    chipId = chip.id;
    expect(chip.payload.task).toMatchObject({ status: "working", title: "Plan the offsite", source: "user" });

    const row = await t.fixture.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row).toMatchObject({ status: "working", source: "user", title: "Plan the offsite", prompt: "Plan a two-day team offsite in Lisbon in May", channelId: t.alex.mainChannelId, spawnMessageId: chip.id });
    const chatStatuses = ofType(frames, "status").filter((e) => e.payload.taskId === null).map((e) => e.payload.status);
    expect(chatStatuses).toEqual(["thinking", "starting_task", "thinking", null]);

    const chatTools = offeredNames(t.llm.sent("chat")[0]);
    expect(chatTools).toEqual(expect.arrayContaining(["start_task", "propose_tasks", "propose_task"]));
    expect(chatTools).not.toContain("set_steps");
    expect(t.llm.sent("chat")[0]!.system).toContain("duet://tasks/<id>");

    // The task's own session: kind "task", the prompt as its request, task tools only.
    await reached.promise;
    const request = t.llm.sent("task")[0]!;
    expect(request.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Plan a two-day team offsite in Lisbon in May" }] });
    const taskTools = request.tools!.map((x) => x.name);
    expect(taskTools).toEqual(expect.arrayContaining(["set_steps", "add_update", "add_resource", "update_task", "ask_user", "finish_task"]));
    expect(taskTools.filter((name) => name === "start_task" || name.includes("resolve"))).toEqual([]);
    expect(request.system).toContain("Plan the offsite");
    const running = await t.fixture.db.run.findMany({ where: { taskId } });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ kind: "task", status: "running", channelId: t.alex.mainChannelId });

    gate.resolve();
    await t.fixture.runs.idle();
    expect(await t.fixture.db.message.findFirstOrThrow({ where: { text: "Looking at venues." } })).toMatchObject({ taskId, role: "assistant" });
    const timeline = MessagePage.parse(await (await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, { headers: t.alex.headers })).json());
    // The task's own bubble stays in its session; the main timeline only gets the result (M18).
    const bubble = await t.fixture.db.message.findFirstOrThrow({ where: { text: "Looking at venues.", taskId } });
    expect(timeline.messages.some((m) => m.id === bubble.id)).toBe(false);
    // M18: the turn ended with nothing open and no question: the task is done (resolved: nothing
    // of the user's was touched) and its last text is the result in the chat.
    expect((await detail(taskId)).status).toBe("resolved");
    expect(timeline.messages.find((m) => m.kind === "text" && m.payload.taskResult?.taskId === taskId)).toMatchObject({ text: "Looking at venues.", taskId: null });
    const chipRow = await t.fixture.db.message.findUniqueOrThrow({ where: { id: chip.id } });
    expect(JSON.parse(chipRow.payload).task.status).toBe("resolved");
  });

  test("the chat stays free while the task works; the task's stream carries only the task", async () => {
    const reached = deferred();
    const gate = deferred();
    t.llm.script("task", async () => { reached.resolve(); await gate.promise; return [text("Still on it.")]; });
    const pendingReply = reply(taskId, "Keep the budget under 5k", "r-1");
    await reached.promise;
    expect((await detail(taskId)).status).toBe("working");

    t.llm.script("chat", [text("It's 18°C in Lisbon.")]);
    const frames = await readSse(await chat("What's the weather there?", "s-2"));
    expect(ofType(frames, "done").at(-1)!.payload).toMatchObject({ taskId: null, status: "completed" });

    gate.resolve();
    const replyFrames = await readSse(await pendingReply);
    expect(messagesOf(replyFrames).every((m) => m.taskId === taskId)).toBe(true);
    expect(messagesOf(replyFrames).map((m) => m.text)).toContain("Still on it.");
    expect(ofType(replyFrames, "done").map((e) => e.payload)).toEqual([expect.objectContaining({ taskId, status: "completed" })]);
    expect(ofType(replyFrames, "status").every((e) => e.payload.taskId === taskId)).toBe(true);
    // The task's new status arrives before its done (M18: a reply reopened it; no question, so done again).
    expect(ofType(replyFrames, "task").at(-1)!.payload.task.status).toBe("resolved");
    expect(replyFrames.events.at(-1)!.type).toBe("done");
  });
});

describe("a task's own turns", () => {
  test("steps, updates and resources go into the task with events, the chip follows, finish_task -> ready_for_review", async () => {
    const before = await lastEventId(t.fixture);
    t.llm.script("task",
      [
        call("set_steps", { steps: [{ text: "Shortlist venues", state: "done" }, { text: "Draft the agenda", state: "current" }, { text: "Book flights", state: "planned" }] }),
        call("add_update", { text: "Picked LX Factory: it fits 12 and has a terrace.", source: "Google Maps" }),
        call("add_resource", { title: "Offsite agenda", type: "doc", link: "https://docs.example.com/agenda", app: "Google Docs" }),
        call("update_task", { title: "Lisbon offsite in May", description: "Two days in Lisbon for 12 people, under 5k." }),
      ],
      // M14: finish_task refuses while a step is planned / current, so the checklist is closed first.
      [
        call("set_steps", { steps: [{ text: "Shortlist venues", state: "done" }, { text: "Draft the agenda", state: "done" }, { text: "Book flights", state: "done" }] }),
        call("finish_task", { summary: "Venue and agenda are ready for you to look over." }),
      ],
    );
    const frames = await readSse(await reply(taskId, "Go ahead and draft it", "r-2"));
    expect(ofType(frames, "done").at(-1)!.payload).toMatchObject({ taskId, status: "completed" });

    const d = await detail(taskId);
    // M18: no approval and no write in the user's apps, so finish_task resolves it.
    expect(d).toMatchObject({ status: "resolved", title: "Lisbon offsite in May", description: "Two days in Lisbon for 12 people, under 5k." });
    expect(d.steps.map((s) => [s.text, s.state])).toEqual([["Shortlist venues", "done"], ["Draft the agenda", "done"], ["Book flights", "done"]]);
    // No connected app is called "Google Maps" in this rig, so the label falls back to Claude (M8).
    expect(d.updates.find((u) => u.text.text?.startsWith("Picked"))).toMatchObject({ source: "OpenDuet" });
    expect(d.latestUpdate).toMatchObject({ text: { text: "Venue and agenda are ready for you to look over." }, source: "OpenDuet" });
    // M18: the first move into done posted the result on the main timeline (taskResult on the payload).
    // These later turns answered the user's replies in a task that was already done: the user reads
    // them in the task, so the chat gets no second or third result.
    const notices = await t.fixture.db.message.findMany({ where: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: null, role: "assistant", kind: "text", payload: { contains: `"taskId":"${taskId}"` } }, orderBy: { createdAt: "asc" } });
    expect(notices.map((n) => n.text)).toEqual(["Looking at venues."]);
    expect(JSON.parse(notices[0]!.payload).taskResult).toEqual({ taskId, title: "Plan the offsite", status: "resolved", sourceCount: 0 });
    // No catalog in this rig, so "Google Docs" isn't a known app and the resource keeps no app (M9).
    expect(d.resources).toEqual([{ title: "Offsite agenda", type: "doc", link: "https://docs.example.com/agenda", app: null }]);
    expect(ofType(frames, "status").map((e) => e.payload.status)).toContain("working_tasks");

    const events = await storedEvents(t.fixture, t.alex.userId, before);
    const taskEvents = ofType(events, "task").filter((e) => e.payload.task.id === taskId);
    // working, steps, update, resource, title, steps (all done), summary, resolved
    expect(taskEvents).toHaveLength(8);
    expect(taskEvents.every((e) => e.channelId === t.alex.mainChannelId)).toBe(true);
    expect(taskEvents.at(-1)!.payload.task).toMatchObject({ status: "resolved", title: "Lisbon offsite in May", updateCount: d.updates.length });
    const chips = ofType(events, "message").filter((e) => e.payload.message.id === chipId);
    expect(chips).toHaveLength(taskEvents.length);
    const lastChip = chips.at(-1)!.payload.message;
    expect(lastChip.kind === "task_spawn" && lastChip.payload).toMatchObject({ anchorMessageId: anchorId, task: { status: "resolved", title: "Lisbon offsite in May" } });
  });

  test("ask_user -> needs_input with the question in the task's thread; steps keep their ids", async () => {
    const ids = (await detail(taskId)).steps.map((s) => s.id);
    t.llm.script("task", [
      call("set_steps", { steps: [{ text: "Shortlist venues", state: "done" }, { text: "Draft the agenda", state: "done" }, { text: "Book flights", state: "current" }] }),
      call("ask_user", { question: "Which dates work: May 12-13 or May 19-20?" }),
    ]);
    const frames = await readSse(await reply(taskId, "Also book the flights", "r-3"));
    const d = await detail(taskId);
    expect(d.status).toBe("needs_input");
    expect(d.steps.map((s) => s.id)).toEqual(ids);
    expect(d.steps.map((s) => s.state)).toEqual(["done", "done", "current"]);
    expect(messagesOf(frames).find((m) => m.text.startsWith("Which dates"))).toMatchObject({ role: "assistant", taskId });
  });

  test("a pending approval of the task keeps it at needs_input, and finish_task waits for it", async () => {
    t.llm.script("task",
      async () => {
        // Stands in for the approvals provider asking before it sends (Approval row written by the test).
        await t.fixture.db.approval.create({ data: { userId: t.alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", taskId, preview: gmailPreview } });
        return [call("finish_task", {}, "finish-1")];
      },
      [text("The email to Sam is waiting for your approval; everything else is ready.")],
    );
    await readSse(await reply(taskId, "May 19-20", "r-4"));
    const refused = t.llm.sent("task").at(-1)!.messages.at(-1)!.content[0];
    expect(refused).toMatchObject({ type: "tool_result", toolUseId: "finish-1", isError: true });
    expect((await detail(taskId)).status).toBe("needs_input");
  });

  test("resumeAfterApproval puts the task back to work (no outcome update row) and the session carries on", async () => {
    const approval = await t.fixture.db.approval.findFirstOrThrow({ where: { taskId } });
    await t.fixture.db.approval.update({ where: { id: approval.id }, data: { status: "approved", result: JSON.stringify({ ok: true, error: null }) } });
    const updatesBefore = (await detail(taskId)).updates.length;
    const reached = deferred();
    const gate = deferred();
    const allDone = { steps: [{ text: "Shortlist venues", state: "done" }, { text: "Draft the agenda", state: "done" }, { text: "Book flights", state: "done" }] };
    t.llm.script("task", async () => { reached.resolve(); await gate.promise; return [call("set_steps", allDone), call("finish_task", { summary: "Sent the dates to Sam." })]; });
    await t.tasks.service.resumeAfterApproval(taskId, { approvalId: approval.id, status: "approved", ok: true, summary: "Sent to sam@example.com" });
    await reached.promise;

    const d = await detail(taskId);
    expect(d.status).toBe("working");
    // The run record's approval step shows the outcome now (M8), not a "Decisions and updates" row.
    expect(d.updates).toHaveLength(updatesBefore);
    expect(d.updates.some((u) => u.text.key?.startsWith("task.approval_"))).toBe(false);
    const request = t.llm.sent("task").at(-1)!;
    const note = JSON.stringify(request.messages.at(-1));
    expect(note).toContain("[Server note");
    expect(note).toContain(approval.id);
    expect(request.system).toContain(approval.id);
    expect(request.system).toContain("\"status\":\"approved\"");

    gate.resolve();
    await t.fixture.runs.idle();
    expect((await detail(taskId)).status).toBe("ready_for_review");
  });

  test("an approval decided after the user resolved the task doesn't run it again or change it", async () => {
    const resolved = await t.fixture.app.request(`/api/tasks/${taskId}`, json(t.alex, "PATCH", { status: "resolved" }));
    expect(TaskDetail.parse(await resolved.json()).status).toBe("resolved");
    const runs = await t.fixture.db.run.count({ where: { taskId } });
    const before = await detail(taskId);
    const approval = await t.fixture.db.approval.create({ data: { userId: t.alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", taskId, status: "declined", preview: gmailPreview } });
    await t.tasks.service.resumeAfterApproval(taskId, { approvalId: approval.id, status: "declined", ok: false, summary: "Offsite dates" });
    await t.fixture.runs.idle();
    const d = await detail(taskId);
    expect(d.status).toBe("resolved");
    expect(d.updates).toEqual(before.updates);
    expect(await t.fixture.db.run.count({ where: { taskId } })).toBe(runs);
  });

  test("a reply reopens a resolved task; a failed turn -> needs_input with the error as an update and a model_error card", async () => {
    t.llm.script("task", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }));
    const frames = await readSse(await reply(taskId, "One more thing: add a dinner", "r-5"));
    expect(ofType(frames, "task").map((e) => e.payload.task.status)).toEqual(["working", "needs_input"]);
    expect(ofType(frames, "done").at(-1)!.payload).toMatchObject({ taskId, status: "failed", error: { key: "system.model_error" } });
    const card = messagesOf(frames).find((m) => m.kind === "model_error");
    expect(card).toMatchObject({ taskId, role: "system", payload: { phrase: { key: "system.model_error" }, retry: true, state: "open" } });
    const d = await detail(taskId);
    expect(d.status).toBe("needs_input");
    expect(d.latestUpdate).toMatchObject({ text: { key: "system.model_error" }, source: "OpenDuet" });
  });

  test("continueTask (after a hand back on Claude's computer) runs the session with the task's bookkeeping", async () => {
    expect((await detail(taskId)).status).toBe("needs_input");
    t.llm.script("task", [call("finish_task", { summary: "Booked after the hand back." })]);
    await t.tasks.service.continueTask(taskId, "(Claude's computer) The user handed the browser back to you.");
    await t.fixture.runs.idle();
    expect((await detail(taskId)).status).toBe("ready_for_review");
    expect(JSON.stringify(t.llm.sent("task").at(-1)!.messages.at(-1))).toContain("handed the browser back");

    // a resolved task isn't run again
    await t.fixture.app.request(`/api/tasks/${taskId}`, json(t.alex, "PATCH", { status: "resolved" }));
    const runs = await t.fixture.db.run.count({ where: { taskId } });
    await t.tasks.service.continueTask(taskId, "carry on");
    await t.fixture.runs.idle();
    expect(await t.fixture.db.run.count({ where: { taskId } })).toBe(runs);
  });
});
