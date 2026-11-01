// M26: task metadata on real tool/approval paths; deletion never resurrects a shared card.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DeleteFileResponse, UploadFileResponse } from "../../src/contract/messages.ts";
import { loadMessage } from "../../src/runs/serialize.ts";
import { PNG, uploadForm } from "../helpers/files.ts";
import { call, computerRig, messagesOf, text, type ComputerRig } from "./harness.ts";

let rig: ComputerRig;
afterEach(async () => { await rig?.cleanup(); });
const makeTask = () => rig.fixture.db.task.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, title: "Task report" } });
async function taskTurn(taskId: string) {
  const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId, kind: "task", prompt: "Prepare a report" });
  await rig.waitFor(rig.alex.userId, (event) => event.type === "done" && event.payload.runId === runId);
}

test("task writes, same-turn sends and screenshots record the task and posted title", async () => {
  rig = await computerRig();
  const task = await makeTask();
  const path = `tasks/${task.id}/report.txt`;
  rig.llm.script("task",
    [call("computer_files_write", { path, contents: "draft" })],
    [call("computer_files_write", { path: `tasks/${task.id}/notes.txt`, contents: "notes" })],
    [call("send_file", { path })],
    [call("computer_screenshot", {})],
    [text("Done.")],
  );
  await taskTurn(task.id);
  const rows = await rig.fixture.db.channelFile.findMany({ orderBy: { createdAt: "asc" } });
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => [row.origin, row.workspacePath, row.taskId])).toEqual([
    ["send", path, task.id], ["write", `tasks/${task.id}/notes.txt`, task.id], ["screenshot", null, task.id],
  ]);
  for (const row of rows) expect((await loadMessage(rig.fixture.db, row.messageId!))?.payload).toMatchObject({ file: { taskId: task.id, taskTitle: task.title } });
});

for (const slug of ["computer_files_write", "computer_screenshot"] as const) test(`approved ${slug} records origin/path/task and posts a snapshot`, async () => {
  rig = await computerRig();
  const task = await makeTask();
  const path = `tasks/${task.id}/approved.txt`;
  await rig.connectors.policy.setTool(rig.alex.userId, slug, "ask");
  rig.llm.script("task", [call(slug, slug === "computer_files_write" ? { path, contents: "approved" } : {})], [text("Waiting for approval.")]);
  await taskTurn(task.id);
  expect(await rig.fixture.db.channelFile.count()).toBe(0);
  const approval = await rig.fixture.db.approval.findFirstOrThrow({ where: { userId: rig.alex.userId } });
  const response = await rig.api(rig.alex, `/api/approvals/${approval.id}/approve`, { method: "POST", body: { version: approval.version } });
  expect(response.status).toBe(200);
  const row = await rig.fixture.db.channelFile.findFirstOrThrow();
  expect(row).toMatchObject({ origin: slug === "computer_files_write" ? "write" : "screenshot", workspacePath: slug === "computer_files_write" ? path : null, taskId: task.id });
  expect((await loadMessage(rig.fixture.db, row.messageId!))?.payload).toMatchObject({ file: { taskTitle: task.title } });
});

for (const next of ["send_file", "computer_files_write"] as const) test(`a same-turn ${next} after deletion creates a new card, not a revived tombstone`, async () => {
  rig = await computerRig();
  let tombstone: DeleteFileResponse | null = null;
  rig.llm.script("chat",
    [call("computer_files_write", { path: "report.txt", contents: "first version" })],
    async () => {
      const row = await rig.fixture.db.channelFile.findFirstOrThrow();
      const response = await rig.api(rig.alex, `/api/files/${row.id}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      tombstone = DeleteFileResponse.parse(await response.json());
      return [call(next, next === "send_file" ? { path: "report.txt" } : { path: "report.txt", contents: "second version" })];
    },
    [text("Sent again.")],
  );
  await rig.send(rig.alex, "Write a report");
  const rows = await rig.fixture.db.channelFile.findMany({ orderBy: { createdAt: "asc" } });
  expect(rows).toHaveLength(2);
  expect(rows[0]!.deletedAt).not.toBeNull();
  expect(rows[1]).toMatchObject({ origin: next === "send_file" ? "send" : "write", deletedAt: null, workspacePath: "report.txt" });
  expect(rows[0]!.messageId).not.toBe(rows[1]!.messageId);
  expect(await loadMessage(rig.fixture.db, rows[0]!.messageId!)).toEqual(tombstone!.message);
  expect(existsSync(join(rig.fixture.files.root, rows[0]!.path))).toBe(false);
});

test("retry excludes deleted attachment bytes and workspace copies while retaining the history label", async () => {
  rig = await computerRig();
  const upload = await rig.fixture.app.request(`/api/channels/${rig.alex.mainChannelId}/files`, { method: "POST", headers: rig.alex.headers, body: uploadForm(PNG, "chart.png", "image/png") });
  const file = UploadFileResponse.parse(await upload.json()).file;
  rig.llm.script("chat", [text("Got it.")]);
  const frames = await rig.send(rig.alex, "Read this chart", { fileIds: [file.id] });
  const message = messagesOf(frames).find((m) => m.role === "user")!;
  const run = await rig.fixture.db.run.findFirstOrThrow({ where: { userId: rig.alex.userId, kind: "chat" } });
  expect((await rig.api(rig.alex, `/api/files/${file.id}`, { method: "DELETE" })).status).toBe(200);
  const copies = rig.fake.calls.filter((c) => c.path === "/files/write").length;
  rig.llm.script("chat", [text("The chart was deleted.")]);
  const retry = await rig.fixture.runs.retry(rig.alex.userId, run.id, { kind: "chat", channelId: rig.alex.mainChannelId, taskId: null, recordTaskId: null, messageId: message.id, prompt: null, skill: null }, null);
  const event = await rig.waitFor(rig.alex.userId, (e) => e.type === "done" && e.payload.runId === retry);
  expect(event.payload).toMatchObject({ status: "completed" });
  expect(rig.fake.calls.filter((c) => c.path === "/files/write")).toHaveLength(copies);
  const request = rig.llm.sent("chat").at(-1)!;
  expect(request.system).not.toContain("uploads/");
  expect(JSON.stringify(request.messages)).not.toContain(Buffer.from(PNG).toString("base64"));
});
