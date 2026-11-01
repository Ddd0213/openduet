// Files that come out of OpenDuet's computer (L140, L142, L180): typed from their real bytes, stored
// under a generated name by the FileStore, recorded as a ChannelFile with source "assistant" and posted
// as a file or image card. Also rewrites cards that belong to other runs (live browser, sign-in).
import type { ChannelFile as FileRow } from "@prisma/client";
import { fileTypeFromBuffer } from "file-type";
import type { MessageDraft } from "../agent/types.ts";
import type { Message } from "../contract/messages.ts";
import type { FileOrigin } from "../contract/m26.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { FileStore } from "../files/store.ts";
import { sniff } from "../files/sniff.ts";
import { loadMessage, payloadSchemaFor, toChannelFiles } from "../runs/serialize.ts";

/** Text formats the assistant writes that the upload sniffer doesn't take (it only knows .txt/.md/.csv). */
const TEXT_TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  ts: "text/plain", tsx: "text/plain", jsx: "text/plain", json: "application/json", xml: "application/xml",
  svg: "image/svg+xml", yaml: "text/yaml", yml: "text/yaml", toml: "text/plain", ini: "text/plain",
  py: "text/x-python", sh: "text/x-shellscript", rb: "text/plain", go: "text/plain", rs: "text/plain",
  java: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain", sql: "text/plain", tsv: "text/tab-separated-values",
};
/** Binary formats detected from magic bytes that we keep their real type for. */
const BINARY_OK = /^(image\/(png|jpeg|gif|webp|heic|heif|bmp|tiff)|application\/(pdf|zip|gzip|x-tar|x-7z-compressed|epub\+zip|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.oasis\.opendocument\.[a-z.]+|vnd\.ms-excel|msword|vnd\.ms-powerpoint)|audio\/[a-z0-9.+-]+|video\/(mp4|quicktime|webm))$/;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isUtf8(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The real type of a file from OpenDuet's computer: magic bytes first, then text by extension. */
export async function detectMime(bytes: Uint8Array, name: string): Promise<string> {
  const upload = await sniff(bytes, "", name);
  if (upload.ok) return upload.mime;
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (detected) return BINARY_OK.test(detected.mime) ? detected.mime : "application/octet-stream";
  if (isUtf8(bytes)) return TEXT_TYPES[extensionOf(name)] ?? "text/plain";
  return "application/octet-stream";
}

export interface SavedFile { row: FileRow; message: Message }

export interface AssistantFileDeps { db: Db; files: FileStore }

/** Stores the bytes and the ChannelFile row (not yet bound to a message). */
export async function storeAssistantFile(deps: AssistantFileDeps, input: { userId: string; channelId: string; name: string; bytes: Uint8Array; mime?: string; origin: FileOrigin; workspacePath: string | null; taskId: string | null }): Promise<FileRow> {
  const mime = input.mime ?? (await detectMime(input.bytes, input.name));
  const path = await deps.files.save(input.userId, mime, input.bytes);
  try {
    return await deps.db.channelFile.create({
      data: { userId: input.userId, channelId: input.channelId, path, name: input.name.slice(0, 255) || "file", mime, size: input.bytes.byteLength, source: "assistant", origin: input.origin, workspacePath: input.workspacePath, taskId: input.taskId },
    });
  } catch (error) {
    await deps.files.remove(path).catch(() => undefined);
    throw error;
  }
}

/** Posts a file / image card for a stored row and binds the row to it (so it shows in Files lists). */
export async function postFileCard(
  deps: AssistantFileDeps,
  sink: { upsertMessage(draft: MessageDraft): Promise<Message> },
  row: FileRow, kind: "file" | "image", caption: string, messageId?: string,
): Promise<SavedFile> {
  const [file] = await toChannelFiles(deps.db, row.userId, [row]);
  const first = await sink.upsertMessage({ ...(messageId ? { id: messageId } : {}), role: "assistant", kind, payload: { file, caption } });
  const bound = await deps.db.channelFile.update({ where: { id: row.id }, data: { messageId: first.id } });
  let message = await sink.upsertMessage({ id: first.id, role: "assistant", kind, payload: { file: { ...file, messageId: first.id, deletedAt: bound.deletedAt?.toISOString() ?? null }, caption } });
  // A DELETE may have claimed this row while the sink was posting. Its tombstone wins even
  // when our payload write finished after the delete's message event.
  const latest = await deps.db.channelFile.findUnique({ where: { id: row.id } });
  if (latest?.deletedAt && (message.kind === "file" || message.kind === "image") && !message.payload.file.deletedAt) {
    message = await sink.upsertMessage({ id: first.id, role: "assistant", kind, payload: { file: { ...file, messageId: first.id, deletedAt: latest.deletedAt.toISOString() }, caption } });
  }
  return { row: latest ?? bound, message };
}

/**
 * Posts a file / image card outside a turn (a computer call the user approved on its card): the
 * message goes into the approval card's thread and `message` is emitted there.
 */
export async function postFileDetached(
  deps: AssistantFileDeps & { events: EventBus },
  scope: { userId: string; channelId: string; taskId: string | null },
  row: FileRow, kind: "file" | "image", caption: string,
): Promise<Message | null> {
  const message = await deps.db.message.create({ data: { userId: scope.userId, channelId: scope.channelId, taskId: scope.taskId, role: "assistant", kind, text: "", payload: "{}", status: "sent" } });
  const bound = await deps.db.channelFile.update({ where: { id: row.id }, data: { messageId: message.id } });
  const [file] = await toChannelFiles(deps.db, scope.userId, [bound]);
  const payload = { file, caption };
  payloadSchemaFor(kind).parse(payload);
  await deps.db.message.update({ where: { id: message.id }, data: { payload: JSON.stringify(payload) } });
  const shaped = await loadMessage(deps.db, message.id);
  if (shaped) await deps.events.emit(scope.userId, scope.channelId, "message", { message: shaped });
  return shaped;
}

/** Replaces the bytes of a row the assistant already posted (a second write to the same path in a run). */
export async function replaceAssistantFile(deps: AssistantFileDeps, row: FileRow, bytes: Uint8Array): Promise<FileRow | null> {
  const mime = await detectMime(bytes, row.name);
  const path = await deps.files.save(row.userId, mime, bytes);
  try {
    const updated = await deps.db.channelFile.updateMany({ where: { id: row.id, deletedAt: null }, data: { path, mime, size: bytes.byteLength } });
    if (updated.count === 0) { await deps.files.remove(path); return null; }
    await deps.files.remove(row.path).catch(() => undefined);
    return await deps.db.channelFile.findFirst({ where: { id: row.id, deletedAt: null } });
  } catch (error) {
    await deps.files.remove(path).catch(() => undefined);
    throw error;
  }
}

/**
 * Rewrites the payload of a card outside the run that posted it (live browser "ended", sign-in
 * state) and emits `message` on its channel. Returns false when the message is gone.
 */
export async function rewriteMessage(deps: { db: Db; events: EventBus }, userId: string, messageId: string, kind: Message["kind"], payload: Record<string, unknown>): Promise<boolean> {
  const row = await deps.db.message.findFirst({ where: { id: messageId, userId, kind } });
  if (!row) return false;
  payloadSchemaFor(kind).parse(payload);
  // Text attachments come from rows, not payload; keep private history/retry metadata intact.
  if (kind === "text") {
    let stored: Record<string, unknown> = {};
    try { stored = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* older malformed payload */ }
    payload = { ...stored, ...payload };
  }
  await deps.db.message.update({ where: { id: row.id }, data: { payload: JSON.stringify(payload) } });
  const shaped = await loadMessage(deps.db, row.id);
  if (shaped) await deps.events.emit(userId, row.channelId, "message", { message: shaped });
  return true;
}
