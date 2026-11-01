import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComputerClient } from "../../src/computer/client.ts";
import { editFileText } from "../../src/computer/file-tools.ts";
import { schemas, TOOL_INFO } from "../../src/computer/tools.ts";
import { describeCall } from "../../src/runs/describe.ts";
import { Redactor } from "../../src/runs/redact.ts";
import { FAKE_TOKEN, FAKE_URL, FakeComputer } from "./fake-computer.ts";
import { call, computerRig, messagesOf, text, type ComputerRig } from "./harness.ts";

let fake: FakeComputer | undefined, rig: ComputerRig | undefined;
afterEach(async () => { fake?.cleanup(); fake = undefined; await rig?.cleanup(); rig = undefined; });
function local() {
  fake = new FakeComputer();
  const client = new ComputerClient({ baseUrl: FAKE_URL, token: FAKE_TOKEN, botId: "test", fetch: fake.fetch });
  const path = join(fake.root, "notes.md");
  return { client, path };
}

describe("M27 file edit", () => {
  test("unique replacement preserves BOM, CRLF and literal dollars", async () => {
    const { client, path } = local(); writeFileSync(path, "\uFEFFone\r\ntwo\r\n");
    const edited = await editFileText(client, { path: "notes.md", old_string: "two", new_string: "$& three" });
    expect(readFileSync(path, "utf8")).toBe("\uFEFFone\r\n$& three\r\n");
    expect(edited.replacements).toBe(1);
    expect(edited.bytes.byteLength).toBe(Buffer.byteLength("\uFEFFone\r\n$& three\r\n"));
  });
  test("nonunique gives count; replace_all changes each occurrence", async () => {
    const { client, path } = local(); writeFileSync(path, "one one");
    await expect(editFileText(client, { path: "notes.md", old_string: "one", new_string: "two" })).rejects.toThrow("appears 2 times in the file");
    expect(fake!.calls.some(c => c.path === "/files/write")).toBe(false);
    expect((await editFileText(client, { path: "notes.md", old_string: "one", new_string: "two", replace_all: true })).replacements).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("two two");
  });
  test("not found and whitespace hint refuse without writing", async () => {
    const { client, path } = local(); writeFileSync(path, "one\n  two");
    await expect(editFileText(client, { path: "notes.md", old_string: "absent", new_string: "x" })).rejects.toThrow("not found in the file");
    await expect(editFileText(client, { path: "notes.md", old_string: "one two", new_string: "x" })).rejects.toThrow("different spaces or line breaks");
    await expect(editFileText(client, { path: "notes.md", old_string: "one", new_string: "one" })).rejects.toThrow("nothing would change");
    expect(fake!.calls.some(c => c.path === "/files/write")).toBe(false);
  });
  test("missing file, invalid UTF-8 and input above 1,000,000 bytes refuse", async () => {
    const { client, path } = local();
    await expect(editFileText(client, { path: "notes.md", old_string: "x", new_string: "y" })).rejects.toThrow("not_found");
    writeFileSync(path, new Uint8Array([0xff]));
    await expect(editFileText(client, { path: "notes.md", old_string: "x", new_string: "y" })).rejects.toThrow("not valid UTF-8");
    truncateSync(path, 1_000_001);
    await expect(editFileText(client, { path: "notes.md", old_string: "x", new_string: "y" })).rejects.toThrow("too_large");
    expect(fake!.calls.some(c => c.path === "/files/write")).toBe(false);
  });
  test("output byte limit checked before write, including multibyte text; exactly 1 MB works", async () => {
    const { client, path } = local(); writeFileSync(path, "x".repeat(1_000_000));
    await expect(editFileText(client, { path: "notes.md", old_string: "x", new_string: "中", replace_all: true })).rejects.toThrow("write limit");
    expect(fake!.calls.some(c => c.path === "/files/write")).toBe(false);
    const edited = await editFileText(client, { path: "notes.md", old_string: "x", new_string: "y", replace_all: true });
    expect(edited.bytes.byteLength).toBe(1_000_000);
  });
  test("schema forbids empty old_string; run input and detail have path, not contents", () => {
    expect(schemas.computer_files_edit.safeParse({ path: "notes", old_string: "", new_string: "x" }).success).toBe(false);
    expect(TOOL_INFO.computer_files_edit).toMatchObject({ name: "Edit files", access: "write", defaultMode: "always" });
    const view = describeCall({ type: "tool_use", id: "edit", name: "computer_files_edit", input: { path: "notes", old_string: "private old", new_string: "private new" } }, new Redactor());
    expect(view).toMatchObject({ detail: "notes", title: { key: "run.step.files_edit" } });
    expect(JSON.parse(view.input!)).toEqual({ path: "notes" });
  });
  test("Always write/edit/send in a turn update the same shared card; audit has only the path", async () => {
    rig = await computerRig();
    rig.llm.script("chat", [call("computer_files_write", { path: "notes.md", contents: "private old" })],
      [call("computer_files_edit", { path: "/workspace/notes.md", old_string: "private old", new_string: "private new" })],
      [call("send_file", { path: "notes.md" })], [text("Edited.")]);
    const frames = await rig.send(rig.alex, "Edit the note");
    expect(await rig.fixture.db.approval.count()).toBe(0);
    expect(rig.results[1]!.data.sharedFileId).toBe(rig.results[0]!.data.sharedFileId);
    expect(new Set(messagesOf(frames).filter(m => m.kind === "file").map(m => m.id)).size).toBe(1);
    const rows = await rig.fixture.db.channelFile.findMany();
    expect(rows.length).toBe(1); expect(rows[0]).toMatchObject({ workspacePath: "notes.md", origin: "send" });
    expect(await (await rig.api(rig.alex, `/api/files/${rows[0]!.id}/content`)).text()).toBe("private new");
    const audits = await rig.fixture.db.auditLog.findMany({ where: { action: "computer_files_edit" } });
    expect(audits.map(a => [a.target, a.outcome])).toEqual([["notes.md", "ok"]]);
    expect(JSON.stringify(audits)).not.toContain("private");
  });
  test("Ask posts a path-only approval and changes nothing before approval; approved edit shares a card", async () => {
    rig = await computerRig(); writeFileSync(join(rig.fake.root, "notes.md"), "private old");
    await rig.api(rig.alex, "/api/computer/policy", { method: "PUT", body: { tool: "computer_files_edit", mode: "ask" } });
    rig.llm.script("chat", [call("computer_files_edit", { path: "notes.md", old_string: "private old", new_string: "private new" })], [text("Waiting.")]);
    const frames = await rig.send(rig.alex, "Edit");
    const card = messagesOf(frames).find(m => m.kind === "approval")!;
    const approval = (card.payload as { approval: { id: string; version: number; preview: unknown } }).approval;
    expect(JSON.stringify(approval.preview)).not.toContain("private");
    expect(rig.fake.calls.some(c => c.path === "/files/download" || c.path === "/files/write")).toBe(false);
    expect((await rig.api(rig.alex, `/api/approvals/${approval.id}/approve`, { method: "POST", body: { version: approval.version } })).status).toBe(200);
    expect(readFileSync(join(rig.fake.root, "notes.md"), "utf8")).toBe("private new");
    expect(await rig.fixture.db.channelFile.count()).toBe(1);
  });
  test("untrusted Make build refuses Ask edit; Always edits artifacts paths like write, without a card", async () => {
    rig = await computerRig();
    await rig.api(rig.alex, "/api/computer/policy", { method: "PUT", body: { tool: "computer_files_edit", mode: "ask" } });
    rig.llm.script("task", [call("computer_files_edit", { path: "artifacts/a/index.html", old_string: "old", new_string: "new" })], [text("Cannot.")]);
    let runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, kind: "build", prompt: "Edit" });
    await rig.waitFor(rig.alex.userId, e => e.type === "done" && e.payload.runId === runId);
    expect(rig.results[0]).toMatchObject({ isError: true }); expect(String(rig.results[0]!.data.error)).toContain("nobody is here");
    await rig.api(rig.alex, "/api/computer/policy", { method: "PUT", body: { tool: "computer_files_edit", mode: "always" } });
    rig.llm.script("task", [call("computer_files_write", { path: "artifacts/a/index.html", contents: "old" })], [call("computer_files_edit", { path: "artifacts/a/index.html", old_string: "old", new_string: "new" })], [text("Edited.")]);
    runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, kind: "build", prompt: "Edit" });
    await rig.waitFor(rig.alex.userId, e => e.type === "done" && e.payload.runId === runId);
    expect(rig.results.at(-1)).toMatchObject({ name: "computer_files_edit", isError: false });
    expect(await rig.fixture.db.approval.count()).toBe(0); expect(await rig.fixture.db.channelFile.count()).toBe(0);
    expect(readFileSync(join(rig.fake.root, "artifacts/a/index.html"), "utf8")).toBe("new");
  });
});
