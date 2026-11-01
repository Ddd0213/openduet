// Composer uploads and file bytes (L179, L172). Uploads go only through the signed-in session,
// the real type is sniffed from the bytes, each file is capped at 25 MB, and the bytes are only
// ever served to their owner, with nosniff and a private cache policy.
import type { Context, Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app.ts";
import { ChannelFileList, MAX_UPLOAD_BYTES } from "../contract/channels.ts";
import { DeleteFileResponse, UploadFileResponse } from "../contract/messages.ts";
import { DeleteFileQuery, DeleteFileRequest, isProtectedWorkspacePath, type WorkspaceDeleteResult } from "../contract/m26.ts";
import { Audit, type AuditOutcome } from "../computer/audit.ts";
import { ComputerError } from "../computer/client.ts";
import { rewriteMessage } from "../computer/files.ts";
import { workspacePath } from "../computer/paths.ts";
import { WorkspaceError } from "../computer/workspace-impl.ts";
import type { WorkspaceFileDelete } from "../computer/workspace.ts";
import { sniff } from "../files/sniff.ts";
import { errorBody, HttpError } from "../http.ts";
import { log } from "../log.ts";
import { loadMessage, toChannelFile, toChannelFiles } from "../runs/serialize.ts";
import { ownChannel } from "./channels.ts";

/** Multipart framing around one file is small; anything far above the cap is refused early. */
const MULTIPART_SLACK = 64 * 1024;

export const uploadLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + MULTIPART_SLACK,
  onError: (c) => c.json(errorBody("too_large", "Files can be up to 25 MB."), 413),
});

/** Display name only (never a path): no directories, control characters or overlong names. */
export function displayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return clean.length > 0 ? clean : "file";
}

export const uploadFile: Handler<AppEnv> = async (c) => {
  const channel = await ownChannel(c);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new HttpError(400, "validation_failed", "file: expected multipart/form-data", "file");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "validation_failed", "file: missing", "file");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "too_large", "Files can be up to 25 MB.");
  if (file.size === 0) throw new HttpError(400, "validation_failed", "file: empty", "file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = displayName(file.name);
  const type = await sniff(bytes, file.type, name);
  if (!type.ok) throw new HttpError(415, "unsupported_type", "This file type isn't supported.", "file");

  const { db, files } = c.get("deps");
  const userId = c.get("user").id;
  const path = await files.save(userId, type.mime, bytes);
  const row = await db.channelFile.create({ data: { userId, channelId: channel.id, path, name, mime: type.mime, size: bytes.byteLength, source: "user", origin: "upload" } });
  return c.json(UploadFileResponse.parse({ file: toChannelFile(row) }));
};

/** Files shared in the channel, newest first. Uploads still waiting in the composer aren't listed. */
export const listFiles: Handler<AppEnv> = async (c) => {
  const channel = await ownChannel(c);
  const { db } = c.get("deps");
  const rows = await db.channelFile.findMany({ where: { channelId: channel.id, userId: channel.userId, messageId: { not: null }, deletedAt: null }, orderBy: { createdAt: "desc" } });
  return c.json(ChannelFileList.parse({ files: await toChannelFiles(db, channel.userId, rows) }));
};

async function ownFile(c: Context<AppEnv>) {
  const { db } = c.get("deps");
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  const row = await db.channelFile.findFirst({ where: { id, userId: c.get("user").id, deletedAt: null } });
  if (!row) throw new HttpError(404, "not_found", "Not found.");
  return row;
}

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 name, so Chinese file names survive. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Types a browser would run as a page. */
const ACTIVE_TYPES = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"]);

export const fileContent: Handler<AppEnv> = async (c) => {
  const row = await ownFile(c);
  let bytes: Uint8Array;
  try {
    bytes = await c.get("deps").files.read(row.path);
  } catch (error) {
    log.warn("file bytes missing", { fileId: row.id, error: { name: (error as Error).name } });
    throw new HttpError(404, "not_found", "Not found.");
  }
  return new Response(bytes, { headers: {
    "Content-Type": row.mime.startsWith("text/") ? `${row.mime}; charset=utf-8` : row.mime,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": contentDisposition(row.name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
    // HTML / SVG that the assistant wrote keep their real type; opened anywhere, they run sandboxed and
    // load nothing (the app previews them in its own WKWebView from the downloaded bytes).
    ...(ACTIVE_TYPES.has(row.mime) ? { "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}),
  } });
};

/** Inject the computer module's owner-gated workspace; absent means not configured. */
export interface FileDeleteDeps { fileWorkspace?: WorkspaceFileDelete }

const invalidDelete = (message: string) => new HttpError(400, "validation_failed", message, "alsoWorkspace");

async function deleteOption(c: Context<AppEnv>): Promise<boolean> {
  const query = DeleteFileQuery.safeParse(c.req.query());
  if (!query.success) throw invalidDelete("alsoWorkspace: expected true, false, 1 or 0.");
  const raw = await c.req.text();
  let body: boolean | undefined;
  if (raw.trim()) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw invalidDelete("Request body must be JSON."); }
    const parsed = DeleteFileRequest.safeParse(json);
    if (!parsed.success) throw invalidDelete("alsoWorkspace: expected a boolean in a JSON object.");
    body = parsed.data.alsoWorkspace;
  }
  const option = query.data.alsoWorkspace;
  const value = option === undefined ? undefined : option === "true" || option === "1";
  if (value !== undefined && body !== undefined && value !== body) throw invalidDelete("alsoWorkspace: query and body disagree.");
  return value ?? body ?? false;
}

function workspaceDeleteError(error: unknown): never {
  if (error instanceof ComputerError) {
    if (error.kind === "unreachable" || error.kind === "timeout") throw new HttpError(503, "computer_unreachable", "OpenDuet's computer couldn't be reached.");
    if (error.kind === "human_in_control") throw new HttpError(409, "computer_busy", "The computer is under your control.");
  }
  if (error instanceof WorkspaceError) {
    if (error.reason === "not_configured") throw new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");
    if (error.reason === "invalid_path" || error.reason === "escape") throw invalidDelete("That isn't a regular file in /workspace.");
  }
  throw error;
}

/** M26: explicit user action; sent files keep tombstones and update their existing cards. */
export const deleteFile: Handler<AppEnv> = async (c) => {
  const alsoWorkspace = await deleteOption(c);
  const row = await ownFile(c);
  const deps = c.get("deps");
  const { db, files, events } = deps;
  const { fileWorkspace } = deps as typeof deps & FileDeleteDeps;
  const audit = new Audit(db);
  let workspace: WorkspaceDeleteResult = "not_asked";
  if (alsoWorkspace) {
    let outcome: AuditOutcome = "error";
    try {
      if (!row.workspacePath) throw invalidDelete("This file has no original on OpenDuet's computer.");
      // Stored paths are normalized; also recognize old absolute /workspace paths defensively.
      let rel = row.workspacePath;
      try { rel = workspacePath(rel); } catch { /* the workspace performs the final path check */ }
      if (isProtectedWorkspacePath(rel)) {
        outcome = "denied";
        throw new HttpError(409, "protected_path", "This file belongs to an artifact or skill.");
      }
      if (!fileWorkspace) throw new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");
      workspace = await fileWorkspace.deleteFileAs(row.userId, rel, { actor: "user", audit: false });
      outcome = "ok";
    } catch (error) {
      workspaceDeleteError(error);
    } finally {
      await audit.record({ userId: row.userId, action: "computer_files_delete", actor: "user", target: row.workspacePath, outcome });
    }
  }
  // Claim after all workspace checks/deletion, before removing stored bytes. Re-read under the
  // same transaction: a concurrent composer send may have bound the upload since ownFile().
  const deleted = await db.$transaction(async (tx) => {
    const claimed = await tx.channelFile.updateMany({ where: { id: row.id, userId: row.userId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (claimed.count === 0) throw new HttpError(404, "not_found", "Not found.");
    return tx.channelFile.findUniqueOrThrow({ where: { id: row.id } });
  });
  await files.remove(deleted.path);
  const [file] = await toChannelFiles(db, deleted.userId, [deleted]);
  let message = deleted.messageId ? await loadMessage(db, deleted.messageId) : null;
  if (!deleted.messageId && deleted.source === "user") {
    await db.channelFile.deleteMany({ where: { id: deleted.id, messageId: null, deletedAt: deleted.deletedAt } });
  } else if (message) {
    const payload = message.kind === "file" || message.kind === "image" ? { ...message.payload, file } : message.payload;
    await rewriteMessage({ db, events }, deleted.userId, message.id, message.kind, payload);
    // Text attachments are re-read from ChannelFile rows, including tombstones.
    message = await loadMessage(db, message.id);
  }
  await audit.record({ userId: deleted.userId, action: "file_delete", actor: "user", target: deleted.name, outcome: "ok" });
  return c.json(DeleteFileResponse.parse({ file, message, workspace }));
};
