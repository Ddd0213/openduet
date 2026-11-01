// M18a: a task's turn that ends done without finish_task, resolved vs ready_for_review from the
// records, the result in the chat (taskResult), and the failed / waiting lines (once per move).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessagePage } from "../../src/contract/messages.ts";
import { LlmError } from "../../src/llm/index.ts";
import { clipResult, endsWithQuestion, lastSentence } from "../../src/tasks/notices.ts";
import { touchedUserThings } from "../../src/tasks/touched.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, startApp, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

const status = async (taskId: string) => (await t.fixture.db.task.findUniqueOrThrow({ where: { id: taskId } })).status;
const newTask = (title: string) => t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title, prompt: title });
/** Claude's text lines on the main timeline (taskId null) that link this task or carry its result. */
const chatLines = (taskId: string) => t.fixture.db.message.findMany({
  where: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: null, role: "assistant", kind: "text", OR: [{ text: { contains: `duet://tasks/${taskId}` } }, { payload: { contains: `"taskResult":{"taskId":"${taskId}"` } }] },
  orderBy: { createdAt: "asc" },
});
/** A connector step recorded on the task's running turn (stands in for execute_app_tools / an MCP tool). */
async function recordStep(tool: string, input: string | null = null): Promise<void> {
  const run = await t.fixture.db.run.findFirstOrThrow({ where: { userId: t.alex.userId, kind: "task", status: "running" }, orderBy: { createdAt: "desc" } });
  await t.fixture.db.runStep.create({ data: { id: crypto.randomUUID(), runId: run.id, index: 90, kind: "tool", tool, app: "Gmail", title: JSON.stringify({ key: "run.step.tool" }), status: "ok", input, finishedAt: new Date() } });
}

describe("done without finish_task", () => {
  test("every step done and a last text that isn't a question: resolved, the last text is the result with taskResult", async () => {
    t.llm.script("task",
      [
        text("Looking at prices."),
        call("set_steps", { steps: [{ text: "Compare prices", state: "done" }] }),
        call("add_resource", { title: "JD", type: "link", link: "https://jd.example.com/deal" }),
        call("add_resource", { title: "Tmall", type: "link", link: "https://tmall.example.com/deal" }),
      ],
      [text("**Stage**: the first wave is over.\n\n- JD stacks coupons.")],
    );
    const task = await newTask("Singles' Day watch");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("resolved");
    const page = MessagePage.parse(await (await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages?limit=100`, { headers: t.alex.headers })).json());
    const result = page.messages.find((m) => m.kind === "text" && m.payload.taskResult?.taskId === task.id);
    expect(result).toMatchObject({ role: "assistant", taskId: null, text: "**Stage**: the first wave is over.\n\n- JD stacks coupons." });
    expect(result?.kind === "text" && result.payload).toMatchObject({ taskResult: { taskId: task.id, title: "Singles' Day watch", status: "resolved", sourceCount: 2 }, forwarded: null, replyTo: null });
  });

  test("finish_task with an approval of the task (any status): ready_for_review", async () => {
    t.llm.script("task", async () => {
      const task = await t.fixture.db.task.findFirstOrThrow({ where: { userId: t.alex.userId, title: "Reply to Dana" } });
      await t.fixture.db.approval.create({ data: { userId: t.alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", taskId: task.id, status: "approved" } });
      return [text("Sent the reply to Dana."), call("finish_task", {})];
    });
    const task = await newTask("Reply to Dana");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("ready_for_review");
    const lines = await chatLines(task.id);
    expect(lines.map((m) => m.text)).toEqual(["Sent the reply to Dana."]);
    expect(JSON.parse(lines[0]!.payload).taskResult).toMatchObject({ status: "ready_for_review", sourceCount: 0 });
  });

  test("a connector write step in one of its runs: ready_for_review; a read-only one: resolved", async () => {
    t.llm.script("task", async () => { await recordStep("GOOGLECALENDAR_CREATE_EVENT"); return [text("Put it on your calendar.")]; });
    const writes = await newTask("Add the dentist");
    await t.fixture.runs.idle();
    expect(await status(writes.id)).toBe("ready_for_review");

    t.llm.script("task", async () => { await recordStep("GMAIL_FETCH_EMAILS"); return [text("You have 3 unread emails from Dana.")]; });
    const reads = await newTask("Check Dana's emails");
    await t.fixture.runs.idle();
    expect(await status(reads.id)).toBe("resolved");
  });

  test("touchedUserThings: Claude's own tools don't count; unclassifiable connector calls, call_api writes and unknown MCP tools do", async () => {
    const task = await t.fixture.db.task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Steps", status: "working" } });
    const run = await t.fixture.db.run.create({ data: { userId: t.alex.userId, kind: "task", status: "completed", channelId: t.alex.mainChannelId, taskId: task.id } });
    const step = (tool: string, input: string | null = null) => t.fixture.db.runStep.create({ data: { id: crypto.randomUUID(), runId: run.id, index: 0, kind: "tool", tool, title: "{}", status: "ok", input } });
    const reset = () => t.fixture.db.runStep.deleteMany({ where: { runId: run.id } });
    const touched = () => touchedUserThings(t.fixture.db, t.alex.userId, task.id);
    for (const tool of ["computer_exec", "make_artifact", "web_search", "web_fetch", "set_steps", "remember", "search_app_tools", "get_app_tool_schemas", "manage_app_connections"]) await step(tool);
    await step("call_api", JSON.stringify({ connector: "c1", method: "GET", url: "https://api.example.com/x" }));
    expect(await touched()).toBe(false);
    for (const [tool, input] of [["SLACK_CHANNEL_MESSAGE", null], ["call_api", JSON.stringify({ method: "POST" })], ["call_api", "not json"], ["mcp_abcdef_create_page", null], ["execute_app_tools", null]] as const) {
      await reset();
      await step(tool, input);
      expect({ tool, touched: await touched() }).toEqual({ tool, touched: true });
    }
  });
});

describe("waiting and failed lines", () => {
  test("a last text ending with a question: needs_input and one waiting line; asking again while waiting posts nothing", async () => {
    t.llm.script("task", [text("I found two venues. Which one do you prefer, LX Factory or Village Underground?")]);
    const task = await newTask("Pick [a] venue");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("needs_input");
    expect((await chatLines(task.id)).map((m) => m.text)).toEqual([`[Pick \\[a\\] venue](duet://tasks/${task.id}) is waiting for you: Which one do you prefer, LX Factory or Village Underground?`]);

    t.llm.script("task", [call("ask_user", { question: "Still: which one?" })]);
    await t.tasks.service.continueTask(task.id, "carry on");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("needs_input");
    expect(await chatLines(task.id)).toHaveLength(1);
  });

  test("ask_user's question is the waiting line's question, in the user's language", async () => {
    await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "zh-Hans" } });
    try {
      t.llm.script("task", [call("ask_user", { question: "预算是多少？" })]);
      const task = await newTask("Budget");
      await t.fixture.runs.idle();
      expect((await chatLines(task.id)).map((m) => m.text)).toEqual([`「[Budget](duet://tasks/${task.id})」在等你：预算是多少？`]);
    } finally {
      await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "en" } });
    }
  });

  test("a reply the user is watching posts no line; a failed turn posts one, and not again while it's waiting", async () => {
    t.llm.script("task", [text("Done with the list.")]);
    const task = await newTask("Packing list");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("resolved");
    const before = (await chatLines(task.id)).length;
    t.llm.script("task", [text("Should I add sunscreen?")]);
    await readSse(await t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "Add more", clientId: "m18-r1" })));
    expect(await status(task.id)).toBe("needs_input");
    expect(await chatLines(task.id)).toHaveLength(before);

    const failing = await newTask("Flaky [one]");
    t.llm.script("task", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }));
    await t.fixture.runs.idle();
    expect(await status(failing.id)).toBe("needs_input");
    const lines = (await chatLines(failing.id)).map((m) => m.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`[Flaky \\[one\\]](duet://tasks/${failing.id}) hit a problem: Couldn't reach the model (gateway returned 502).`);

    t.llm.script("task", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }));
    await t.tasks.service.continueTask(failing.id, "try again");
    await t.fixture.runs.idle();
    expect(await chatLines(failing.id)).toHaveLength(1);
  });

  test("a reply in a task that's already done settles back to done without a second result in the chat", async () => {
    t.llm.script("task", [text("Here's the summary.")]);
    const task = await newTask("Weekly summary");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("resolved");
    expect(await chatLines(task.id)).toHaveLength(1);
    t.llm.script("task", [text("You're welcome.")]);
    await readSse(await t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "Thanks", clientId: "m18-thanks" })));
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("resolved");
    expect(await chatLines(task.id)).toHaveLength(1);
  });

  test("two replies queued on a done task: still one result in the chat", async () => {
    t.llm.script("task", [text("Here's the plan.")]);
    const task = await newTask("Trip plan");
    await t.fixture.runs.idle();
    expect(await chatLines(task.id)).toHaveLength(1);
    t.llm.script("task", [text("Glad it helps.")], [text("Sure, noted.")]);
    const first = t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "Thanks", clientId: "m18-q1" }));
    const second = t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "And book the hotel later", clientId: "m18-q2" }));
    await Promise.all([readSse(await first), readSse(await second)]);
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("resolved");
    expect(await chatLines(task.id)).toHaveLength(1);
  });

  test("a turn that posts a card for the user (quick replies) and stops waits for the answer", async () => {
    t.llm.script("task", [call("quick_replies", { text: "Which airline", options: ["TAP", "Ryanair"] })]);
    const task = await newTask("Airline");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("needs_input");
  });

  test("open steps and no question: needs_input without a line", async () => {
    t.llm.script("task", [call("set_steps", { steps: [{ text: "Call the venue", state: "current" }] })], [text("Working through the list.")]);
    const task = await newTask("Venue calls");
    await t.fixture.runs.idle();
    expect(await status(task.id)).toBe("needs_input");
    expect(await chatLines(task.id)).toHaveLength(0);
  });
});

describe("text helpers", () => {
  test("endsWithQuestion, lastSentence and clipResult", () => {
    for (const yes of ["Which one?", "Which one?  ", "**Which one?**", "要哪个？", "Is it \"A?\""]) expect(endsWithQuestion(yes)).toBe(true);
    for (const no of ["Done.", "", "Why? Because.", null]) expect(endsWithQuestion(no)).toBe(false);
    expect(lastSentence("I found two. **Which** one do you want?")).toBe("Which one do you want?");
    expect(lastSentence("找到了两个。你要哪个？")).toBe("你要哪个？");
    expect(lastSentence("x".repeat(300))).toHaveLength(140);
    const long = `${"a".repeat(20_000)}\n\n${"b".repeat(20_000)}`;
    const clipped = clipResult(long);
    expect(clipped.length).toBeLessThanOrEqual(32_000);
    expect(clipped).toBe(`${"a".repeat(20_000)}\n\n…`);
    expect(clipResult("short")).toBe("short");
  });
});
