// M26 W1a: same-turn file-card updates and the task-only working-folder instruction.
// Real runtime, run host, database and SSE events; only the computer and LLM are fakes.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, computerRig, messagesOf, text, type ComputerRig } from "./harness.ts";

let rig: ComputerRig;
afterEach(async () => { await rig?.cleanup(); });

describe("M26 one file card per path per turn", () => {
  test("write then send updates the same card, replaces captions, refreshes bytes and emits message events", async () => {
    rig = await computerRig();
    const contents = "console.log('revised deliverable');\n";
    rig.llm.script("chat",
      [call("computer_files_write", { path: "out/calc.js", contents: "// draft\n" })],
      [call("send_file", { path: "/workspace/out/calc.js", caption: "The calculation" })],
      async () => {
        // A shell or another writer may change the file without auto-sharing it.
        writeFileSync(join(rig.fake.root, "out/calc.js"), contents);
        return [call("send_file", { path: "./out//calc.js", caption: "The revised calculation" })];
      },
      [text("Sent the calculation.")],
    );
    const frames = await rig.send(rig.alex, "Write and send the calculation");
    const cards = messagesOf(frames).filter((m) => m.kind === "file");
    const [row] = await rig.fixture.db.channelFile.findMany();
    expect(await rig.fixture.db.channelFile.count()).toBe(1);
    expect(row).toMatchObject({ origin: "send", workspacePath: "out/calc.js", taskId: null });
    expect(cards[0]!.payload).toMatchObject({ file: { origin: "write", workspacePath: "out/calc.js", taskId: null } });
    expect(cards.at(-1)!.payload).toMatchObject({ file: { origin: "send" } });
    expect(await rig.fixture.db.message.count({ where: { kind: "file" } })).toBe(1);
    expect(new Set(cards.map((m) => m.id))).toEqual(new Set([row!.messageId!]));
    expect(cards[0]!.payload).toMatchObject({ caption: "" });
    expect(cards.some((m) => m.payload.caption === "The calculation")).toBe(true);
    expect(cards.at(-1)!.payload).toMatchObject({
      caption: "The revised calculation",
      file: { id: row!.id, messageId: row!.messageId, name: "calc.js", mime: "text/javascript", size: Buffer.byteLength(contents) },
    });
    const message = await rig.fixture.db.message.findUniqueOrThrow({ where: { id: row!.messageId! } });
    expect(JSON.parse(message.payload)).toEqual(cards.at(-1)!.payload);
    expect(rig.results[0]!.data.sharedFileId).toBe(row!.id);
    for (const sent of rig.results.filter((r) => r.name === "send_file")) {
      expect(sent).toMatchObject({ isError: false, data: { sent: true, updated: true, fileId: row!.id } });
      expect(sent.data.note).toContain("Updated the existing file card");
    }
    expect(await (await rig.api(rig.alex, `/api/files/${row!.id}/content`)).text()).toBe(contents);
    const audits = await rig.fixture.db.auditLog.findMany({ where: { action: "send_file" } });
    expect(audits).toHaveLength(2);
    expect(audits.every((r) => r.target === "out/calc.js" && r.outcome === "ok" && r.actor === "assistant")).toBe(true);
  });

  test("sending the same path in the next turn creates a new card without changing the earlier one", async () => {
    rig = await computerRig();
    rig.llm.script("chat",
      [call("computer_files_write", { path: "report.txt", contents: "first turn" })],
      [call("send_file", { path: "report.txt", caption: "First report" })],
      [text("Sent.")],
    );
    const first = await rig.send(rig.alex, "Write and send a report");
    const firstCard = messagesOf(first).filter((m) => m.kind === "file").at(-1)!;
    const firstRow = await rig.fixture.db.channelFile.findFirstOrThrow();
    writeFileSync(join(rig.fake.root, "report.txt"), "second turn");
    rig.llm.script("chat", [call("send_file", { path: "/workspace/report.txt", caption: "Second report" })], [text("Sent again.")]);
    const second = await rig.send(rig.alex, "Send it again");
    const secondCard = messagesOf(second).filter((m) => m.kind === "file").at(-1)!;
    expect(secondCard.id).not.toBe(firstCard.id);
    expect(secondCard.payload).toMatchObject({ caption: "Second report" });
    expect(await rig.fixture.db.channelFile.count()).toBe(2);
    expect(await rig.fixture.db.message.count({ where: { kind: "file" } })).toBe(2);
    expect(rig.results.at(-1)!.data.fileId).not.toBe(firstRow.id);
    expect(rig.results.at(-1)!.data.updated).toBeUndefined();
    expect(await (await rig.api(rig.alex, `/api/files/${firstRow.id}/content`)).text()).toBe("first turn");
    const oldMessage = await rig.fixture.db.message.findUniqueOrThrow({ where: { id: firstCard.id } });
    expect(JSON.parse(oldMessage.payload)).toEqual(firstCard.payload);
  });

  test("sending a path written twice keeps the single row and the latest bytes", async () => {
    rig = await computerRig();
    rig.llm.script("chat",
      [call("computer_files_write", { path: "notes/plan.md", contents: "# Plan v1\n" })],
      [call("computer_files_write", { path: "/workspace/notes/plan.md", contents: "# Plan v2\nMore.\n" })],
      [call("send_file", { path: "notes/plan.md", caption: "Final plan" })],
      [text("Sent.")],
    );
    const frames = await rig.send(rig.alex, "Revise and send the plan");
    const cards = messagesOf(frames).filter((m) => m.kind === "file");
    expect(new Set(cards.map((m) => m.id)).size).toBe(1);
    expect(cards.at(-1)!.payload).toMatchObject({ caption: "Final plan" });
    const [first, second, sent] = rig.results;
    expect(second!.data.sharedFileId).toBe(first!.data.sharedFileId);
    expect(sent).toMatchObject({ isError: false, data: { updated: true, fileId: first!.data.sharedFileId } });
    expect(await rig.fixture.db.channelFile.count()).toBe(1);
    expect(await (await rig.api(rig.alex, `/api/files/${sent!.data.fileId}/content`)).text()).toBe("# Plan v2\nMore.\n");
  });

  test("an explicit send also registers the path for later sends in the same turn", async () => {
    rig = await computerRig();
    writeFileSync(join(rig.fake.root, "report.csv"), "a,b\n1,2\n");
    rig.llm.script("chat",
      [call("send_file", { path: "report.csv", caption: "Initial caption" })],
      [call("send_file", { path: "/workspace/report.csv", caption: "Final caption" })],
      [text("Sent.")],
    );
    const frames = await rig.send(rig.alex, "Send the report");
    expect(rig.results[0]!.data.updated).toBeUndefined();
    expect(rig.results[1]!.data).toMatchObject({ updated: true, fileId: rig.results[0]!.data.fileId });
    expect(await rig.fixture.db.channelFile.count()).toBe(1);
    const cards = messagesOf(frames).filter((m) => m.kind === "file");
    expect(new Set(cards.map((m) => m.id)).size).toBe(1);
    expect(cards.at(-1)!.payload).toMatchObject({ caption: "Final caption" });
  });

  test("a shared path still enforces size and path limits without changing its card", async () => {
    rig = await computerRig();
    rig.llm.script("chat",
      [call("computer_files_write", { path: "report.txt", contents: "safe original" })],
      async () => {
        truncateSync(join(rig.fake.root, "report.txt"), 26 * 1024 * 1024);
        return [call("send_file", { path: "report.txt", caption: "Must not replace" })];
      },
      [call("send_file", { path: "../report.txt", caption: "Must not replace" })],
      [text("Can't send that file.")],
    );
    const frames = await rig.send(rig.alex, "Send the updated report");
    expect(rig.results[1]).toMatchObject({ isError: true, data: { reason: "too_large" } });
    expect(rig.results[2]).toMatchObject({ isError: true, data: { reason: "invalid_path" } });
    expect(await rig.fixture.db.channelFile.count()).toBe(1);
    const card = messagesOf(frames).filter((m) => m.kind === "file").at(-1)!;
    expect(card.payload).toMatchObject({ caption: "", file: { size: 13 } });
    expect(await (await rig.api(rig.alex, `/api/files/${rig.results[0]!.data.sharedFileId}/content`)).text()).toBe("safe original");
    const audits = await rig.fixture.db.auditLog.findMany({ where: { action: "send_file" } });
    expect(audits).toHaveLength(2);
    expect(audits.every((r) => r.outcome === "error")).toBe(true);
  });
});

describe("M26 task working-folder instruction", () => {
  test("task turns get one line with the real task id, without moving files", async () => {
    rig = await computerRig();
    const task = await rig.fixture.db.task.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, title: "Write a report" } });
    writeFileSync(join(rig.fake.root, "existing.txt"), "leave here");
    rig.llm.script("task", [text("Working on the report.")]);
    const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: task.id, kind: "task", prompt: "Write a report" });
    await rig.waitFor(rig.alex.userId, (e) => e.type === "done" && e.payload.runId === runId);
    const lines = rig.llm.sent("task")[0]!.system!.split("\n");
    expect(lines.filter((line) => line.includes("/workspace/tasks/"))).toEqual([
      `Keep this task's working files in /workspace/tasks/${task.id}/; hand deliverables to the user with send_file.`,
    ]);
    expect(existsSync(join(rig.fake.root, "existing.txt"))).toBe(true);
    expect(existsSync(join(rig.fake.root, "tasks"))).toBe(false);
  });

  test("chat turns don't get a task working-folder instruction", async () => {
    rig = await computerRig();
    rig.llm.script("chat", [text("Hello.")]);
    await rig.send(rig.alex, "Hello");
    expect(rig.llm.sent("chat")[0]!.system).not.toContain("/workspace/tasks/");
  });

  test("routines run in the channel with taskId null, not in a task session", async () => {
    rig = await computerRig();
    const task = await rig.fixture.db.task.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, title: "Daily report", routine: true } });
    rig.llm.script("proactive", [text("Today's report.")]);
    // Match routines/service.ts: the record belongs to the task, but the turn belongs to the channel.
    const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, recordTaskId: task.id, kind: "routine", prompt: "Write the daily report" });
    await rig.waitFor(rig.alex.userId, (e) => e.type === "done" && e.payload.runId === runId);
    expect(rig.llm.sent("proactive")[0]!.system).not.toContain("/workspace/tasks/");
  });
});
