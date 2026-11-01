// M3 end to end, wired like src/index.ts: a background task asks to send an email, the card lands
// in the task's own thread and the task waits on it (needs_input); Approve runs exactly the stored
// arguments once, and the real ApprovalService -> TaskService resumer chain puts the task back to
// work, its next turn sees the outcome, and it ends ready for review. Decline resumes it too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConnectorsModule } from "../../src/connectors/module.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { call, json, rig, RoleScriptedLlm, text } from "../tasks/harness.ts";

let fixture: TestApp;
let llm: RoleScriptedLlm;
let fake: FakeComposio;
let alex: SignedIn;
let stopSweep = () => {};

beforeAll(async () => {
  llm = new RoleScriptedLlm();
  fake = new FakeComposio();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const built = rig(core, llm);
      const connectors = createConnectorsModule({ db: core.db, events: core.events, config: core.config, gateway: fake });
      built.providers.push(...connectors.providers);
      connectors.setResumer(built.tasks.service);
      stopSweep = () => connectors.stop();
      return { agent: built.agent, runs: built.runs, routes: [...built.tasks.routes, ...connectors.routes] };
    },
  });
  alex = await signUp(fixture, "alex");
  fake.connect(alex.userId, "gmail", "ca_alex");
});
afterAll(async () => { stopSweep(); await fixture.cleanup(); });

const EMAIL = { recipient_email: "sam@example.com", subject: "Launch review", body: "Hi Sam, the deck is ready." };

/** Waits until the task leaves `working` (its queued turns are done). */
async function settled(taskId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const row = await fixture.db.task.findUniqueOrThrow({ where: { id: taskId } });
    if (row.status === status && fixture.runs.waitingFor(taskId) === 0) {
      await fixture.runs.idle();
      return fixture.db.task.findUniqueOrThrow({ where: { id: taskId } });
    }
    await Bun.sleep(25);
  }
  throw new Error(`task ${taskId} never reached ${status}`);
}

async function taskWithEmailCard(): Promise<{ taskId: string; approvalId: string }> {
  llm.script("task", [call("execute_app_tools", { calls: [{ tool: "GMAIL_SEND_EMAIL", arguments: EMAIL }] })], [text("Waiting for your OK on the email.")]);
  const created = await fixture.app.request("/api/tasks", json(alex, "POST", { prompt: "Send Sam the launch review deck", channelId: alex.mainChannelId }));
  expect(created.status).toBe(200);
  const task = await created.json() as { id: string };
  const paused = await settled(task.id, "needs_input");
  expect(paused.status).toBe("needs_input");
  const approval = await fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId, taskId: task.id } });
  expect(approval).toMatchObject({ status: "pending", version: 1, toolSlug: "GMAIL_SEND_EMAIL" });
  // The card is in the task's own session, not on the main timeline.
  const card = await fixture.db.message.findUniqueOrThrow({ where: { id: approval.messageId! } });
  expect(card).toMatchObject({ kind: "approval", taskId: task.id });
  return { taskId: task.id, approvalId: approval.id };
}

describe("task + approval, wired like index.ts", () => {
  test("Approve runs the stored call once and resumes the task to ready for review", async () => {
    const { taskId, approvalId } = await taskWithEmailCard();
    // The run record: the call that posted the card waits on it.
    const waiting = await fixture.db.runStep.findFirstOrThrow({ where: { approvalId } });
    expect(waiting).toMatchObject({ kind: "tool", tool: "GMAIL_SEND_EMAIL", status: "awaiting_approval", finishedAt: null });
    const before = fake.executions.length;
    llm.script("task", [call("finish_task", { summary: "Sent the deck to Sam." })]);
    const approved = await fixture.app.request(`/api/approvals/${approvalId}/approve`, json(alex, "POST", { version: 1 }));
    expect(approved.status).toBe(200);
    expect(fake.executions.slice(before)).toEqual([{ userId: alex.userId, slug: "GMAIL_SEND_EMAIL", args: EMAIL }]);
    const step = await fixture.db.runStep.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(step.status).toBe("ok");
    expect(step.finishedAt).not.toBeNull();

    const done = await settled(taskId, "ready_for_review");
    // No outcome update row any more (M8): the step above shows it.
    const updates = JSON.parse(done.updates) as { text: { key?: string } }[];
    expect(updates.some((u) => u.text.key?.startsWith("task.approval_"))).toBe(false);
    // The result (M18: taskResult on the payload, finish_task's summary as the text) landed on the main timeline.
    expect(await fixture.db.message.count({ where: { userId: alex.userId, taskId: null, role: "assistant", payload: { contains: `"taskResult":{"taskId":"${taskId}","title":` } } })).toBe(1);
    // The resumed turn was told what happened (server note, never stored as a message).
    const resumed = llm.sent("task").at(-1)!;
    expect(JSON.stringify(resumed.messages)).toContain(`Approval ${approvalId}: the user approved it and it was carried out`);
    expect(await fixture.db.message.count({ where: { taskId, text: { contains: "[Server note" } } })).toBe(0);
  });

  test("Not now declines without running anything and the task carries on", async () => {
    const { taskId, approvalId } = await taskWithEmailCard();
    const before = fake.executions.length;
    llm.script("task", [call("ask_user", { question: "Want me to send it later instead?" })]);
    const sentBefore = llm.sent("task").length;
    const declined = await fixture.app.request(`/api/approvals/${approvalId}/decline`, json(alex, "POST", { version: 1 }));
    expect(declined.status).toBe(200);
    expect(fake.executions.length).toBe(before);
    // The task was already needs_input, so wait for the resumed turn itself (the resumer runs
    // after the route answers), then for the task to settle again.
    for (let i = 0; i < 200 && llm.sent("task").length === sentBefore; i++) await Bun.sleep(25);
    const waiting = await settled(taskId, "needs_input");
    const updates = JSON.parse(waiting.updates) as { text: { key?: string } }[];
    expect(updates.some((u) => u.text.key?.startsWith("task.approval_"))).toBe(false);
    // The step that posted the card shows the decline.
    const step = await fixture.db.runStep.findFirstOrThrow({ where: { approvalId } });
    expect(step.status).toBe("denied");
    expect(step.finishedAt).not.toBeNull();
    expect(JSON.stringify(llm.sent("task").at(-1)!.messages)).toContain("declined it, so it was not carried out");
  });
});
