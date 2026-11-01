// The Workspace seam (workspace.ts) on top of the computer client. Reads take the exact bytes from
// the computer's /files/download (M20, da9a3ca; confined to /workspace, and it works while the user
// drives the browser); an older computer without it falls back to /files/read and the shell. Writes
// go through the computer's own confined /files/write; binary bytes, and files above its limit, go
// through the shell in chunks (base64), after a check that the real path stays inside /workspace (no
// symlink anywhere on the way out). Every read and write is audited by path, never by contents.
import { randomUUID } from "node:crypto";
import type { Workspace, WorkspaceExecResult, WorkspaceFileDelete } from "./workspace.ts";
import type { AuditActor, AuditSink } from "./audit.ts";
import { ComputerError, type ComputerClient } from "./client.ts";
import { execTarget, shellQuote, workspacePath, WorkspacePathError } from "./paths.ts";

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** the computer's /files/read limit (agent-computer DEFAULT_WORKSPACE_LIMITS.readBytes) */
const TEXT_READ_LIMIT = 64_000;
/** the computer's /files/write limit is 1 MB of UTF-8; stay below it */
const TEXT_WRITE_LIMIT = 900_000;
/** raw bytes per read chunk: base64 of it stays under the shell's 64 KiB output cap */
const READ_CHUNK = 45_000;
/** raw bytes per binary write chunk: base64 of it stays under the 1 MB write limit */
const WRITE_CHUNK = 600_000;
const EXEC_OUTPUT_MAX = 8_000;

export type WorkspaceFailure = "not_configured" | "invalid_path" | "not_found" | "too_large" | "escape" | "failed";

export class WorkspaceError extends Error {
  constructor(readonly reason: WorkspaceFailure, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** The seam plus what the computer module itself needs (who acted, a size probe). */
export interface ComputerWorkspace extends Workspace, WorkspaceFileDelete {
  readFileAs(userId: string, path: string, opts: { actor: AuditActor; maxBytes?: number; runId?: string | null; audit?: boolean }): Promise<Uint8Array>;
  writeFileAs(userId: string, path: string, bytes: Uint8Array, opts: { actor: AuditActor; runId?: string | null; audit?: boolean }): Promise<void>;
  /** size in bytes of a regular file inside /workspace (no symlinks), or null if there is none */
  sizeOf(path: string): Promise<number | null>;
}

export interface CreateWorkspaceOptions {
  audit?: AuditSink | null;
  /** the owner gate (ComputerService.allows); unset = every user */
  allows?: (userId: string) => Promise<boolean>;
}

const notConfigured = () => new WorkspaceError("not_configured", "OpenDuet's computer isn't set up on this server.");

/**
 * A 404 from the computer's router itself ("Not found." for a route it doesn't have: an image
 * older than da9a3ca), not from /files/download ("There is no file at ...").
 */
const missingRoute = (error: ComputerError) => error.detail === "" || error.detail === "Not found.";

/**
 * bash that prints the size of a regular file at $P inside the working directory (/workspace), or
 * exits 3 (missing), 4 (not a regular file / a symlink) or 5 (outside /workspace).
 */
function sizeScript(path: string): string {
  return [
    `P=${shellQuote(path)}`,
    `ROOT="$(pwd -P)"`,
    `[ -L "$P" ] && exit 4`,
    `[ -e "$P" ] || exit 3`,
    `[ -f "$P" ] || exit 4`,
    `DIR="$(cd -P -- "$(dirname -- "$P")" 2>/dev/null && pwd -P)" || exit 3`,
    `case "$DIR/" in "$ROOT"/*) ;; *) exit 5 ;; esac`,
    `wc -c < "$P" | tr -d ' '`,
  ].join("\n");
}

function utf8Exact(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function toPathError(error: unknown): never {
  if (error instanceof WorkspacePathError) throw new WorkspaceError("invalid_path", error.message);
  throw error;
}

function clipTail(text: string): string {
  return text.length <= EXEC_OUTPUT_MAX ? text : `…${text.slice(-EXEC_OUTPUT_MAX)}`;
}

/**
 * `client` null = COMPUTER_URL / COMPUTER_TOKEN aren't set: `configured` is false and every call
 * rejects with WorkspaceError("not_configured").
 */
export function createWorkspace(client: ComputerClient | null, options: CreateWorkspaceOptions = {}): ComputerWorkspace {
  const audit = options.audit ?? null;
  const allows = async (userId: string) => !!client && (options.allows ? await options.allows(userId) : true);
  /** Not configured, or not this deployment's owner: the same "isn't set up" for both. */
  const gate = async (userId: string) => { if (!(await allows(userId))) throw notConfigured(); };

  const record = async (userId: string, action: string, actor: AuditActor, target: string, ok: boolean, runId?: string | null) => {
    await audit?.record({ userId, action, actor, target, outcome: ok ? "ok" : "error", runId: runId ?? null });
  };

  async function sizeOf(path: string): Promise<number | null> {
    if (!client) throw notConfigured();
    const rel = (() => { try { return workspacePath(path); } catch (error) { return toPathError(error); } })();
    const result = await client.exec(sizeScript(rel), { timeoutMs: 15_000 });
    if (result.exitCode === 3) return null;
    if (result.exitCode === 4) throw new WorkspaceError("invalid_path", "That isn't a regular file.");
    if (result.exitCode === 5) throw new WorkspaceError("escape", "The path leaves /workspace.");
    const size = Number.parseInt(result.stdout.trim(), 10);
    if (result.exitCode !== 0 || !Number.isFinite(size)) throw new WorkspaceError("failed", "The file couldn't be checked.");
    return size;
  }

  async function readBinary(rel: string, maxBytes: number): Promise<Uint8Array> {
    const size = await sizeOf(rel);
    if (size === null) throw new WorkspaceError("not_found", "There's no such file in /workspace.");
    if (size > maxBytes) throw new WorkspaceError("too_large", `The file is ${size} bytes; the limit is ${maxBytes}.`);
    const out = new Uint8Array(size);
    let offset = 0;
    for (let index = 0; offset < size; index++) {
      const command = `dd if=${shellQuote(rel)} bs=${READ_CHUNK} skip=${index} count=1 2>/dev/null | base64 | tr -d '\\n'`;
      const result = await client!.exec(command, { timeoutMs: 30_000 });
      if (result.exitCode !== 0 || result.truncated) throw new WorkspaceError("failed", "The file couldn't be read.");
      const chunk = Buffer.from(result.stdout.trim(), "base64");
      if (chunk.byteLength === 0) break;
      if (offset + chunk.byteLength > size) throw new WorkspaceError("failed", "The file changed while it was read.");
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== size) throw new WorkspaceError("failed", "The file changed while it was read.");
    return out;
  }

  /** The b6932d3 way: the computer's text read when the file is small UTF-8, else the shell in chunks. */
  async function legacyRead(rel: string, maxBytes: number): Promise<Uint8Array> {
    let bytes: Uint8Array | null = null;
    try {
      const text = await client!.readText(rel);
      const encoded = new TextEncoder().encode(text.text);
      const exact = !text.truncated && !text.text.includes("\uFFFD") && (text.bytes === undefined || text.bytes === encoded.byteLength) && encoded.byteLength <= TEXT_READ_LIMIT;
      if (exact) bytes = encoded;
    } catch (error) {
      if (error instanceof ComputerError && error.kind === "not_found") throw new WorkspaceError("not_found", "There's no such file in /workspace.");
      if (!(error instanceof ComputerError) || (error.kind !== "bad_request" && error.kind !== "failed" && error.kind !== "conflict")) throw error;
    }
    if (bytes && bytes.byteLength > maxBytes) throw new WorkspaceError("too_large", `The file is ${bytes.byteLength} bytes; the limit is ${maxBytes}.`);
    return bytes ?? readBinary(rel, maxBytes);
  }

  async function readFileAs(userId: string, path: string, opts: { actor: AuditActor; maxBytes?: number; runId?: string | null; audit?: boolean }): Promise<Uint8Array> {
    if (!client) throw notConfigured();
    await gate(userId);
    const rel = (() => { try { return workspacePath(path); } catch (error) { return toPathError(error); } })();
    const maxBytes = Math.max(0, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    let ok = false;
    try {
      let bytes: Uint8Array | null = null;
      try {
        // da9a3ca: the exact bytes in one call, confined to /workspace by the computer (symlinks
        // resolved), and not an acting route, so it also works while the user drives the browser.
        bytes = await client.download(rel, { maxBytes });
      } catch (error) {
        if (!(error instanceof ComputerError)) throw error;
        if (error.kind === "too_large") throw new WorkspaceError("too_large", error.detail || `The file is larger than ${maxBytes} bytes.`);
        if (error.kind === "forbidden") throw new WorkspaceError("escape", "The path leaves /workspace.");
        if (error.kind === "bad_request") throw new WorkspaceError("invalid_path", "That isn't a regular file in /workspace.");
        if (error.kind === "not_found" && !missingRoute(error)) throw new WorkspaceError("not_found", "There's no such file in /workspace.");
        if (error.kind !== "not_found") throw error;
      }
      // An older computer without /files/download (rolled back): its text read, then the shell.
      bytes ??= await legacyRead(rel, maxBytes);
      ok = true;
      return bytes;
    } finally {
      if (opts.audit !== false) await record(userId, "computer_files_read", opts.actor, rel, ok, opts.runId);
    }
  }

  async function writeBinary(rel: string, bytes: Uint8Array): Promise<void> {
    // Creates the parent folders through the computer's confined write (it refuses escapes).
    await client!.writeText(rel, "");
    const tmp = `.duet-upload-${randomUUID()}`;
    try {
      const parts: string[] = [];
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += WRITE_CHUNK, index++) {
        const part = `${tmp}/${String(index).padStart(5, "0")}.b64`;
        await client!.writeText(part, Buffer.from(bytes.subarray(offset, offset + WRITE_CHUNK)).toString("base64"));
        parts.push(part);
      }
      const decode = parts.map((part) => `base64 -d < ${shellQuote(part)} >> "$T" || exit 6`);
      const script = [
        `P=${shellQuote(rel)}`, `T=${shellQuote(`${tmp}/out.bin`)}`, `ROOT="$(pwd -P)"`,
        `: > "$T" || exit 6`, ...decode,
        `[ -L "$P" ] && exit 4`,
        `DIR="$(cd -P -- "$(dirname -- "$P")" 2>/dev/null && pwd -P)" || exit 3`,
        `case "$DIR/" in "$ROOT"/*) ;; *) exit 5 ;; esac`,
        `mv -f -- "$T" "$P" || exit 6`,
      ].join("\n");
      const result = await client!.exec(script, { timeoutMs: 120_000 });
      if (result.exitCode === 4 || result.exitCode === 5) throw new WorkspaceError("escape", "The path leaves /workspace.");
      if (result.exitCode !== 0) throw new WorkspaceError("failed", "The file couldn't be written.");
    } finally {
      await client!.exec(`rm -rf -- ${shellQuote(tmp)}`, { timeoutMs: 15_000 }).catch(() => undefined);
    }
  }

  async function writeFileAs(userId: string, path: string, bytes: Uint8Array, opts: { actor: AuditActor; runId?: string | null; audit?: boolean }): Promise<void> {
    if (!client) throw notConfigured();
    await gate(userId);
    const rel = (() => { try { return workspacePath(path); } catch (error) { return toPathError(error); } })();
    let ok = false;
    try {
      if (bytes.byteLength > DEFAULT_MAX_BYTES) throw new WorkspaceError("too_large", `Files can be up to ${DEFAULT_MAX_BYTES} bytes.`);
      const text = bytes.byteLength <= TEXT_WRITE_LIMIT ? utf8Exact(bytes) : null;
      if (text !== null) {
        try {
          await client.writeText(rel, text);
        } catch (error) {
          if (error instanceof ComputerError && (error.kind === "bad_request" || error.kind === "forbidden")) throw new WorkspaceError("invalid_path", error.detail || "The computer refused that path.");
          throw error;
        }
      } else {
        await writeBinary(rel, bytes);
      }
      ok = true;
    } finally {
      if (opts.audit !== false) await record(userId, "computer_files_write", opts.actor, rel, ok, opts.runId);
    }
  }

  const deleteFileAs: WorkspaceFileDelete["deleteFileAs"] = async (userId, path, opts) => {
    let ok = false;
    let rel = path;
    try {
      await gate(userId);
      try { rel = workspacePath(path); } catch (error) { toPathError(error); }
      // Check every component, including dangling links and links pointing back into /workspace.
      // Run the checks and rm together: no separate probe followed by an unchecked delete.
      const parts = rel.split("/");
      const links = parts.map((_, i) => `[ -L ${shellQuote(parts.slice(0, i + 1).join("/"))} ] && exit 4`);
      const script = [
        ...links, sizeScript(rel),
        `rm -f -- "$P" || exit 6`,
      ].join("\n");
      const result = await client!.exec(script, { timeoutMs: 15_000 });
      if (result.timedOut) throw new ComputerError("timeout", null, "The computer timed out.");
      if (result.exitCode === 4) throw new WorkspaceError("invalid_path", "That isn't a regular file.");
      if (result.exitCode === 5) throw new WorkspaceError("escape", "The path leaves /workspace.");
      if (result.exitCode !== 0 && result.exitCode !== 3) throw new WorkspaceError("failed", "The file couldn't be deleted.");
      ok = true;
      return result.exitCode === 3 ? "missing" : "deleted";
    } finally {
      if (opts.audit !== false) await record(userId, "computer_files_delete", opts.actor, rel, ok);
    }
  };

  return {
    configured: !!client,
    allows,
    readFileAs,
    writeFileAs,
    deleteFileAs,
    sizeOf,
    readFile: (userId, path, opts) => readFileAs(userId, path, { actor: "assistant", maxBytes: opts?.maxBytes, runId: opts?.runId }),
    writeFile: (userId, path, bytes, opts) => writeFileAs(userId, path, bytes, { actor: "assistant", runId: opts?.runId }),
    async exec(userId, command, opts): Promise<WorkspaceExecResult> {
      if (!client) throw notConfigured();
      await gate(userId);
      let cwd: string | null = null;
      if (opts?.cwd !== undefined) {
        try { cwd = workspacePath(opts.cwd, { allowRoot: true }); } catch (error) { toPathError(error); }
      }
      const full = cwd && cwd !== "." ? `cd -- ${shellQuote(cwd)} && ${command}` : command;
      let ok = false;
      try {
        const result = await client.exec(full, { timeoutMs: opts?.timeoutMs });
        ok = true;
        return { exitCode: result.exitCode, stdout: clipTail(result.stdout), stderr: clipTail(result.stderr) };
      } finally {
        await audit?.record({ userId, action: "computer_exec", actor: "assistant", target: execTarget(command), outcome: ok ? "ok" : "error", runId: opts?.runId ?? null });
      }
    },
  };
}
