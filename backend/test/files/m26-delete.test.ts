// M26: real HTTP/auth, SQLite, file store and computer shell; no network or model calls.
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { ComputerError } from "../../src/computer/client.ts";
import { postFileDetached, storeAssistantFile } from "../../src/computer/files.ts";
import { ChannelFileList } from "../../src/contract/channels.ts";
import { DeleteFileResponse, UploadFileResponse } from "../../src/contract/messages.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { loadMessage, toChannelFiles } from "../../src/runs/serialize.ts";
import { derivedResources } from "../../src/tasks/derived.ts";
import { computerRig, type ComputerRig } from "../computer/harness.ts";
import { PNG, uploadForm } from "../helpers/files.ts";
import { signUp } from "../helpers/session.ts";

let rig: ComputerRig;
afterEach(async () => { await rig?.cleanup(); });
const scope = () => ({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null });
async function card(path: string | null = "report.txt", kind: "file" | "image" = "file", taskId: string | null = null) {
  const row = await storeAssistantFile(rig.fixture, { ...scope(), taskId, name: path?.split("/").at(-1) ?? "shot.png", bytes: kind === "image" ? PNG : new TextEncoder().encode("saved copy"), origin: kind === "image" ? "screenshot" : "send", workspacePath: path });
  await postFileDetached(rig.fixture, { ...scope(), taskId }, row, kind, "Keep this caption");
  return rig.fixture.db.channelFile.findUniqueOrThrow({ where: { id: row.id } });
}
const remove = (id: string, query = "", body?: unknown) => rig.api(rig.alex, `/api/files/${id}${query}`, { method: "DELETE", body });
async function deleted(id: string, query = "", body?: unknown) {
  const response = await remove(id, query, body);
  expect(response.status).toBe(200);
  return DeleteFileResponse.parse(await response.json());
}
async function intact(id: string, path: string) {
  expect((await rig.fixture.db.channelFile.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  expect(existsSync(join(rig.fixture.files.root, path))).toBe(true);
}

test("unsent upload is hard-deleted, answers a deleted file and null message, and audits", async () => {
  rig = await computerRig();
  const upload = await rig.fixture.app.request(`/api/channels/${rig.alex.mainChannelId}/files`, { method: "POST", headers: rig.alex.headers, body: uploadForm(PNG, "draft.png", "image/png") });
  const file = UploadFileResponse.parse(await upload.json()).file;
  const response = await deleted(file.id);
  expect(response).toMatchObject({ message: null, workspace: "not_asked", file: { id: file.id, origin: "upload", messageId: null } });
  expect(response.file.deletedAt).toBeString();
  expect(await rig.fixture.db.channelFile.findUnique({ where: { id: file.id } })).toBeNull();
  expect((await remove(file.id)).status).toBe(404);
  expect(await rig.fixture.db.auditLog.findMany({ where: { action: "file_delete" } })).toMatchObject([{ actor: "user", target: "draft.png", outcome: "ok" }]);
});

for (const kind of ["file", "image"] as const) test(`${kind} deletion keeps its card and emits a tombstone; list/content exclude it`, async () => {
  rig = await computerRig();
  const row = await card(kind === "image" ? null : "report.txt", kind);
  // The default deletes only the backend copy, even when the computer is unavailable.
  writeFileSync(join(rig.fake.root, "report.txt"), "original");
  rig.fake.down = true;
  const events: DuetEvent[] = [];
  const stop = rig.fixture.events.subscribe(rig.alex.userId, (event) => events.push(event));
  const response = await deleted(row.id);
  stop();
  expect(response.message).toMatchObject({ id: row.messageId, kind, payload: { caption: "Keep this caption", file: { id: row.id, deletedAt: response.file.deletedAt } } });
  expect((await rig.fixture.db.channelFile.findUniqueOrThrow({ where: { id: row.id } })).deletedAt?.toISOString()).toBe(response.file.deletedAt!);
  expect(events.filter((event) => event.type === "message")).toHaveLength(1);
  expect(events.find((event) => event.type === "message")?.payload).toEqual({ message: response.message! });
  expect(existsSync(join(rig.fixture.files.root, row.path))).toBe(false);
  expect(readFileSync(join(rig.fake.root, "report.txt"), "utf8")).toBe("original");
  expect((await rig.api(rig.alex, `/api/files/${row.id}/content`)).status).toBe(404);
  expect(ChannelFileList.parse(await (await rig.api(rig.alex, `/api/channels/${rig.alex.mainChannelId}/files`)).json()).files).toEqual([]);
  expect((await remove(row.id)).status).toBe(404);
});

test("text attachments are re-read with deletedAt and preserve siblings and payload fields", async () => {
  rig = await computerRig();
  const message = await rig.fixture.db.message.create({ data: { ...scope(), role: "user", text: "Use these", payload: JSON.stringify({ skill: "some-skill", stopped: true }) } });
  const first = await card();
  const second = await card("keep.txt");
  await rig.fixture.db.channelFile.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { messageId: message.id } });
  const response = await deleted(first.id);
  expect(response.message).toMatchObject({ id: message.id, kind: "text", text: "Use these", stopped: true, payload: { skill: "some-skill" } });
  if (response.message?.kind !== "text") throw new Error("missing text message");
  expect(response.message.payload.attachments).toHaveLength(2);
  expect(response.message.payload.attachments.find((file) => file.id === first.id)?.deletedAt).toBeString();
  expect(response.message.payload.attachments.find((file) => file.id === second.id)?.deletedAt).toBeNull();
  // rewriteMessage must not drop non-contract fields in the stored text payload.
  expect(JSON.parse((await rig.fixture.db.message.findUniqueOrThrow({ where: { id: message.id } })).payload).stopped).toBe(true);
});

for (const present of [true, false]) test(`alsoWorkspace returns ${present ? "deleted" : "missing"} and leaves earlier copies alone`, async () => {
  rig = await computerRig();
  const row = await card("-quoted' file.txt");
  const previous = await card(row.workspacePath);
  if (present) writeFileSync(join(rig.fake.root, row.workspacePath!), "original");
  const response = await deleted(row.id, "?alsoWorkspace=1", { alsoWorkspace: true });
  expect(response.workspace).toBe(present ? "deleted" : "missing");
  expect(existsSync(join(rig.fake.root, row.workspacePath!))).toBe(false);
  await intact(previous.id, previous.path);
  const audits = await rig.fixture.db.auditLog.findMany({ where: { action: { in: ["computer_files_delete", "file_delete"] } }, orderBy: { createdAt: "asc" } });
  expect(audits.map((a) => [a.action, a.actor, a.target, a.outcome])).toEqual([["computer_files_delete", "user", row.workspacePath!, "ok"], ["file_delete", "user", row.name, "ok"]]);
});

for (const path of ["artifacts/a/index.html", ".skills/a/SKILL.md"]) test(`${path}: protected_path before configuration and remote calls; local-only deletion allowed`, async () => {
  rig = await computerRig({ configured: false });
  const row = await card(path);
  const response = await remove(row.id, "?alsoWorkspace=true");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "protected_path" } });
  await intact(row.id, row.path);
  expect(rig.fake.calls).toHaveLength(0);
  expect(await rig.fixture.db.auditLog.findMany({ where: { action: "computer_files_delete" } })).toMatchObject([{ actor: "user", target: path, outcome: "denied" }]);
  await deleted(row.id);
});

test("no path, missing row, wrong owner and no session fail before computer access", async () => {
  rig = await computerRig({ configured: false });
  const row = await card(null, "image");
  const noPath = await remove(row.id, "?alsoWorkspace=true");
  expect(noPath.status).toBe(400);
  expect(await noPath.json()).toMatchObject({ error: { code: "validation_failed", field: "alsoWorkspace" } });
  expect((await remove("missing", "?alsoWorkspace=true")).status).toBe(404);
  const sam = await signUp(rig.fixture, "sam");
  expect((await rig.api(sam, `/api/files/${row.id}?alsoWorkspace=true`, { method: "DELETE" })).status).toBe(404);
  expect((await rig.api(null, `/api/files/${row.id}`, { method: "DELETE" })).status).toBe(401);
  await intact(row.id, row.path);
});

for (const reason of ["not_configured", "unreachable", "busy", "timeout"] as const) test(`${reason}: refuses with no local deletion and an error audit`, async () => {
  rig = await computerRig({ configured: reason !== "not_configured" });
  const row = await card();
  if (reason === "unreachable") rig.fake.down = true;
  if (reason === "busy") rig.fake.takeOver();
  const timeout = reason === "timeout" ? spyOn(rig.computer.workspace, "deleteFileAs").mockRejectedValue(new ComputerError("timeout", null, "")) : null;
  const response = await remove(row.id, "?alsoWorkspace=true");
  timeout?.mockRestore();
  expect(response.status).toBe(reason === "busy" ? 409 : 503);
  expect(await response.json()).toMatchObject({ error: { code: reason === "busy" ? "computer_busy" : reason === "not_configured" ? reason : "computer_unreachable" } });
  await intact(row.id, row.path);
  expect(await rig.fixture.db.auditLog.count({ where: { action: "file_delete" } })).toBe(0);
  expect(await rig.fixture.db.auditLog.findMany({ where: { action: "computer_files_delete" } })).toMatchObject([{ outcome: "error", actor: "user" }]);
});

test("missing injected workspace fails safely instead of bypassing the owner gate", async () => {
  rig = await computerRig();
  rig.fixture.app = createApp({ ...rig.fixture });
  const row = await card();
  expect((await remove(row.id, "?alsoWorkspace=true")).status).toBe(503);
  await intact(row.id, row.path);
});

test("directories, every symlink component, dangling links and escapes are refused", async () => {
  rig = await computerRig();
  mkdirSync(join(rig.fake.root, "dir"));
  writeFileSync(join(rig.fake.root, "dir/keep.txt"), "keep");
  symlinkSync("dir/keep.txt", join(rig.fake.root, "link"));
  symlinkSync("dir", join(rig.fake.root, "parent"));
  symlinkSync("missing", join(rig.fake.root, "dangling"));
  symlinkSync(rig.fixture.files.root, join(rig.fake.root, "outside"));
  for (const path of ["dir", "link", "parent/keep.txt", "dangling", "outside/missing", "../escape", "/etc/passwd"]) {
    const row = await card(path);
    const response = await remove(row.id, "?alsoWorkspace=true");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { field: "alsoWorkspace" } });
    await intact(row.id, row.path);
  }
  expect(readFileSync(join(rig.fake.root, "dir/keep.txt"), "utf8")).toBe("keep");
});

test("DELETE options validate query/body before mutation; empty and agreeing bodies work", async () => {
  rig = await computerRig();
  const row = await card();
  for (const [query, body] of [["?alsoWorkspace=true", { alsoWorkspace: false }], ["?alsoWorkspace=false", { alsoWorkspace: true }], ["?alsoWorkspace=yes", undefined], ["", "{"], ["", null], ["", []], ["", { extra: true }], ["", { alsoWorkspace: "true" }]] as const) {
    const response = await remove(row.id, query, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed", field: "alsoWorkspace" } });
    await intact(row.id, row.path);
  }
  expect((await deleted(row.id, "?alsoWorkspace=0", {})).workspace).toBe("not_asked");
  expect((await deleted((await card()).id, "", "")).workspace).toBe("not_asked");
  expect((await deleted((await card()).id, "", { alsoWorkspace: true })).workspace).toBe("missing");
});

test("concurrent DELETE claims one row; only one file_delete and one card event", async () => {
  rig = await computerRig();
  const row = await card();
  const responses = await Promise.all([remove(row.id), remove(row.id)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
  expect(await rig.fixture.db.auditLog.count({ where: { action: "file_delete" } })).toBe(1);
});

test("task/artifact enrichment is batched and owner-scoped; cards keep their posted snapshot", async () => {
  rig = await computerRig();
  const db = rig.fixture.db;
  const task = await db.task.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, title: "Original title" } });
  const artifact = await db.artifact.create({ data: { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, type: "web_page", title: "Page" } });
  const row = await card(`artifacts/${artifact.id}/index.html`, "file", task.id);
  expect((await loadMessage(db, row.messageId!))?.payload).toMatchObject({ file: { taskTitle: "Original title", artifactId: artifact.id } });
  await db.task.update({ where: { id: task.id }, data: { title: "Current title" } });
  let taskQueries = 0, artifactQueries = 0;
  const counted = db.$extends({ query: {
    task: { findMany: ({ args, query }) => { taskQueries++; return query(args); } },
    artifact: { findMany: ({ args, query }) => { artifactQueries++; return query(args); } },
  } }) as unknown as typeof db;
  const list = await toChannelFiles(counted, rig.alex.userId, [row, row, row]);
  expect(taskQueries).toBe(1);
  expect(artifactQueries).toBe(1);
  expect(list.every((file) => file.taskTitle === "Current title" && file.artifactId === artifact.id)).toBe(true);
  const listed = ChannelFileList.parse(await (await rig.api(rig.alex, `/api/channels/${rig.alex.mainChannelId}/files`)).json());
  expect(listed.files[0]).toMatchObject({ taskTitle: "Current title", artifactId: artifact.id });
  expect((await toChannelFiles(db, "another-owner", [row]))[0]).toMatchObject({ taskTitle: null, artifactId: null });
  expect((await loadMessage(db, row.messageId!))?.payload).toMatchObject({ file: { taskTitle: "Original title" } });
  expect((await deleted(row.id)).file).toMatchObject({ taskTitle: "Current title", artifactId: artifact.id });
  expect(await derivedResources(db, task)).toEqual([]);
  const orphan = await card(`artifacts/${artifact.id}/data.csv`, "file", task.id);
  await db.task.delete({ where: { id: task.id } });
  await db.artifact.delete({ where: { id: artifact.id } });
  expect((await toChannelFiles(db, rig.alex.userId, [orphan]))[0]).toMatchObject({ taskId: task.id, taskTitle: null, artifactId: null });
  const orphanList = ChannelFileList.parse(await (await rig.api(rig.alex, `/api/channels/${rig.alex.mainChannelId}/files`)).json());
  expect(orphanList.files[0]).toMatchObject({ id: orphan.id, taskTitle: null, artifactId: null });
});

test("deleted rows are hidden even if their bytes still exist", async () => {
  rig = await computerRig();
  const row = await card();
  await rig.fixture.db.channelFile.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  expect(existsSync(join(rig.fixture.files.root, row.path))).toBe(true);
  expect((await rig.api(rig.alex, `/api/files/${row.id}/content`)).status).toBe(404);
  const list = ChannelFileList.parse(await (await rig.api(rig.alex, `/api/channels/${rig.alex.mainChannelId}/files`)).json());
  expect(list.files).toEqual([]);
  expect((await remove(row.id)).status).toBe(404);
});

test("a delete racing the final card post cannot replace the tombstone with an active card", async () => {
  rig = await computerRig();
  const { postFileCard } = await import("../../src/computer/files.ts");
  const row = await card();
  let posts = 0;
  const saved = await postFileCard(rig.fixture, { async upsertMessage(draft) {
    if (++posts === 2) await deleted(row.id);
    if (!("payload" in draft)) throw new Error("expected a file card");
    await rig.fixture.db.message.update({ where: { id: row.messageId! }, data: { payload: JSON.stringify(draft.payload) } });
    return (await loadMessage(rig.fixture.db, row.messageId!))!;
  } }, row, "file", "updated", row.messageId!);
  expect(posts).toBe(3);
  expect(saved.row.deletedAt).not.toBeNull();
  expect(saved.message.payload).toMatchObject({ file: { deletedAt: saved.row.deletedAt!.toISOString() } });
});
