// Pauses and approved results belong to a thread (a task's own session, or a channel's thread),
// not to the user: two tasks stopped by one Take over are both carried on at the hand back, another
// thread's computer call doesn't drop them, and an approved call's result is told only to the next
// turn of its card's thread. Real run host, agent runtime and approval service on the fake computer.
import { afterEach, describe, expect, test } from "bun:test";
import type { TurnInput } from "../../src/agent/types.ts";
import { RESUME_PROMPT } from "../../src/computer/service.ts";
import { call, computerRig, text, type ComputerRig } from "./harness.ts";

let rig: ComputerRig;
afterEach(async () => { await rig?.cleanup(); });

const makeTask = (title: string) => rig.fixture.db.task.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, title } });
async function taskTurn(taskId: string) {
  const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId, kind: "task", prompt: "Carry on" });
  await rig.waitFor(rig.alex.userId, (event) => event.type === "done" && event.payload.runId === runId);
}
/** What the computer tells a turn of this thread (the "approved since your last turn" line among it). */
const told = async (taskId: string | null) => {
  const input = { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId, kind: taskId ? "task" : "chat", runId: `probe-${Math.random()}`, attachments: [] } as unknown as TurnInput;
  return (await rig.computer.provider.instructions!(input)).join("\n");
};
const APPROVED_LINE = "Computer calls the user approved since your last turn";

describe("pauses per thread", () => {
  test("a task and the chat both stopped by Take over are both carried on; another task's computer call keeps them", async () => {
    rig = await computerRig({ waitMs: { chat: 200, background: 200 } });
    rig.llm.script("chat", [call("computer_navigate", { url: "https://example.com/" })], [text("ok")]);
    await rig.send(rig.alex, "open it");
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);

    // Task A stops for the user.
    const a = await makeTask("Compare prices");
    rig.llm.script("task", [call("computer_scroll", {})]);
    await taskTurn(a.id);
    expect(rig.results.at(-1)).toMatchObject({ name: "computer_scroll", endTurn: true, data: { status: "user_in_control" } });

    // The chat stops too (one pause per user used to keep only this one).
    rig.llm.script("chat", [call("computer_scroll", {})]);
    await rig.send(rig.alex, "keep going");
    expect(rig.results.at(-1)).toMatchObject({ name: "computer_scroll", endTurn: true, data: { status: "user_in_control" } });

    // Task B reads files meanwhile (any computer call used to drop every pause of the user).
    const b = await makeTask("Tidy files");
    rig.llm.script("task", [call("computer_files_list", {})], [text("Listed.")]);
    await taskTurn(b.id);
    expect(rig.results.at(-1)).toMatchObject({ name: "computer_files_list", isError: false });
    expect(rig.continued).toEqual([]);

    // The hand back carries both on, in the order they stopped; B wasn't stopped.
    rig.llm.script("task", [text("Back on the prices.")]);
    rig.llm.script("chat", [text("Back on it.")]);
    expect((await rig.api(rig.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    expect(rig.continued.map((c) => [c.kind, c.channelId, c.prompt])).toEqual([
      ["task", rig.alex.mainChannelId, RESUME_PROMPT],
      ["chat", rig.alex.mainChannelId, RESUME_PROMPT],
    ]);
    await rig.fixture.runs.idle();
    expect(rig.llm.remaining("task")).toBe(0);
    expect(rig.llm.remaining("chat")).toBe(0);
    // Nothing left paused: a second take / release carries nothing on.
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    expect((await rig.api(rig.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    expect(rig.continued.length).toBe(2);
  });
});

describe("approved results per thread", () => {
  test("a task's approved call is told to that task's next turn only, once", async () => {
    rig = await computerRig();
    const task = await makeTask("Run the script");
    const outcome = await rig.computer.provider.executeApproved({
      userId: rig.alex.userId, approvalId: "appr-task", taskId: task.id, slug: "computer_exec", args: { command: "echo approved-in-task" },
    });
    expect(outcome.ok).toBe(true);
    // The chat's next turn isn't told; the task's is, once.
    expect(await told(null)).not.toContain(APPROVED_LINE);
    const inTask = await told(task.id);
    expect(inTask).toContain(APPROVED_LINE);
    expect(inTask).toContain("approved-in-task");
    expect(await told(task.id)).not.toContain(APPROVED_LINE);
  });

  test("a chat card's approved call goes to its channel's thread, not to a task", async () => {
    rig = await computerRig();
    const task = await makeTask("Something else");
    const card = await rig.fixture.db.message.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, role: "assistant", kind: "approval" } });
    const row = await rig.fixture.db.approval.create({ data: { userId: rig.alex.userId, kind: "action", toolSlug: "computer_exec", messageId: card.id } });
    const outcome = await rig.computer.provider.executeApproved({
      userId: rig.alex.userId, approvalId: row.id, taskId: null, slug: "computer_exec", args: { command: "echo approved-in-chat" },
    });
    expect(outcome.ok).toBe(true);
    expect(await told(task.id)).not.toContain(APPROVED_LINE);
    const inChat = await told(null);
    expect(inChat).toContain(APPROVED_LINE);
    expect(inChat).toContain("approved-in-chat");
  });
});
