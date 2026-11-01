// M26: the Files page (grouped by origin, delete, the task working folder). New leaf shapes only;
// what M26 adds to older shapes (ChannelFile.origin / workspacePath / taskId / taskTitle /
// artifactId / deletedAt in channels.ts, DeleteFileResponse in messages.ts) is declared next to
// those shapes and points back here.
//
// Additive, so an app built before M26 keeps decoding: every new ChannelFile field is nullable with
// a null default, and DELETE /api/files/:id with no options deletes as before (it now also takes
// files that were sent, and answers 200 with a body the old app ignores). Semantics: docs/API.md
// "## M26".
import { z } from "zod";

/**
 * How a file got into the chat. send = send_file; write = computer_files_write shared it (L140);
 * screenshot = a computer screenshot posted in the chat; upload = the composer. Rows from before
 * M26 that couldn't be matched have none (null): the Files page's "Other". An app reads a value it
 * doesn't know as null too.
 */
export const FileOrigin = z.enum(["send", "write", "screenshot", "upload"]);
export type FileOrigin = z.infer<typeof FileOrigin>;

/**
 * Folders of /workspace whose files "also delete from OpenDuet's computer" refuses (409
 * protected_path): a Make artifact's page (artifacts/<id>/, deleted from the Make page) and the
 * copies of the user's skills (.skills/<name>/, managed by the skills page). Relative to /workspace.
 */
export const PROTECTED_WORKSPACE_DIRS = ["artifacts", ".skills"] as const;

/** True when a /workspace-relative path (computer/paths.ts workspacePath form) is in a protected folder. */
export function isProtectedWorkspacePath(path: string): boolean {
  const first = path.split("/")[0] ?? "";
  return (PROTECTED_WORKSPACE_DIRS as readonly string[]).includes(first);
}

/**
 * DELETE /api/files/:id body (optional; JSON). `alsoWorkspace` = also delete the original in
 * /workspace (the file's workspacePath). Default false: only the chat's copy goes.
 */
export const DeleteFileRequest = z.object({ alsoWorkspace: z.boolean().default(false) }).strict();
export type DeleteFileRequest = z.infer<typeof DeleteFileRequest>;

/**
 * DELETE /api/files/:id?alsoWorkspace=true|false: the same option as a query parameter (some
 * proxies drop a DELETE's body). With both, they must agree (else 400 validation_failed, field
 * alsoWorkspace).
 */
export const DeleteFileQuery = z.object({ alsoWorkspace: z.enum(["true", "false", "1", "0"]).optional() });

/**
 * What became of the original in /workspace. not_asked = alsoWorkspace was false; deleted = it was
 * removed; missing = nothing was at that path any more (the chat's copy was still deleted).
 */
export const WorkspaceDeleteResult = z.enum(["not_asked", "deleted", "missing"]);
export type WorkspaceDeleteResult = z.infer<typeof WorkspaceDeleteResult>;

/**
 * Stable error codes of DELETE /api/files/:id (ApiError.code; backend/src/http.ts ApiErrorCode).
 * Nothing is deleted when one of them is returned. Also: 404 not_found, 400 validation_failed
 * (field alsoWorkspace), 503 not_configured.
 */
export const FileDeleteErrorCode = z.enum([
  /** 409: alsoWorkspace on a file under artifacts/ or .skills/ (PROTECTED_WORKSPACE_DIRS) */
  "protected_path",
  /** 503: OpenDuet's computer couldn't be reached (or timed out) to delete the original */
  "computer_unreachable",
  /** 409 (M20's code): the computer refused because the user is driving its browser */
  "computer_busy",
]);
export type FileDeleteErrorCode = z.infer<typeof FileDeleteErrorCode>;
