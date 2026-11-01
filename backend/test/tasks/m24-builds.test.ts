import { afterAll, beforeAll, expect, test } from "bun:test";
import { onBuildSettled, taskBuildOutcome } from "../../src/tasks/builds.ts";
import { approvalSummary } from "../../src/tasks/next-step.ts";
import { approvalSummary as needsSummary } from "../../src/needs/service.ts";
import { startMake, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); });
afterAll(() => m.fixture.cleanup());

for (const registered of [false, true]) test(`failed build clears stale review nextStep (mutate registered: ${registered})`, async () => {
  const task = await m.fixture.db.task.create({ data: { userId: m.alex.userId, channelId: m.alex.mainChannelId, title: "Review", prompt: "Review", status: "ready_for_review", nextStep: JSON.stringify({ kind: "review", messageId: null, text: { key: "task.next.review" } }) } });
  let mutations = 0;
  const host = {};
  if (registered) onBuildSettled(host, async () => {}, async (...args) => { mutations++; return m.tasks.service.mutate(...args); });
  await taskBuildOutcome({ db: m.fixture.db, events: m.fixture.events, runs: host }, { userId: m.alex.userId, taskId: task.id, artifactId: "failed-page", title: "Brief", ok: false, reason: { key: "artifact.not_finished" } });
  const row = await m.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } });
  expect(row.status).toBe("needs_input"); expect(row.nextStep).toBeNull();
  expect(row.updates).toContain("task.build_failed");
  expect(mutations).toBe(registered ? 1 : 0);
  const event = await m.fixture.db.event.findFirstOrThrow({ where: { type: "task", payload: { contains: task.id } }, orderBy: { id: "desc" } });
  expect(JSON.parse(event.payload).task.nextStep).toBeNull();
});

test("one shared approval helper handles every preview, trimming, fallback and clipping", () => {
  expect(needsSummary).toBe(approvalSummary);
  for (const [preview, expected] of [
    [{ kind: "email", app: "Gmail", to: ["sam@example.com"], cc: [], attachments: [], subject: " Subject ", body: "Body" }, "Subject"],
    [{ kind: "email", app: "Gmail", to: ["sam@example.com"], cc: [], attachments: [], subject: " ", body: "Body" }, "sam@example.com"],
    [{ kind: "action", app: "Gmail", toolName: " Read record ", rows: [] }, "Read record"],
    [{ kind: "sign", app: "Sign", title: "Contract", rows: [] }, "Contract"],
    [{ kind: "delete", app: "Drive", title: "Old file", rows: [] }, "Old file"],
    [{ kind: "payment", amount: 1200, currency: "USD", merchant: "Shop", description: "Receipt", testMode: true }, "Receipt"],
    [{ kind: "payment", amount: 1200, currency: "USD", merchant: "Shop", description: " ", testMode: true }, "Shop"],
  ] as const) expect(approvalSummary(JSON.stringify(preview), "FALLBACK_TOOL")).toBe(expected);
  expect(approvalSummary("bad json", "GMAIL_SEND_MESSAGE")).toBe("gmail send message");
  expect(approvalSummary("null", "___")).toBe("action");
  expect(approvalSummary("bad", "x".repeat(300)).length).toBeLessThanOrEqual(120);
});
