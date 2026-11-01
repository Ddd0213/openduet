// The seam between OpenDuet's computer (M6 backend A: src/computer/) and the modules that use its
// /workspace without driving the browser (M6 backend B: Make builds read the finished HTML; chat
// attachments are copied in). Backend A implements it on top of the computer client; tests use
// an in-memory fake. Paths are relative to /workspace; implementations refuse absolute paths,
// "..", and anything outside /workspace.

export interface WorkspaceExecResult {
  exitCode: number;
  /** truncated to a few KB; never logged or audited */
  stdout: string;
  stderr: string;
}

export interface Workspace {
  /** false when COMPUTER_URL / COMPUTER_TOKEN aren't set: callers say "isn't set up yet" */
  readonly configured: boolean;
  /** Whether this user may use the computer (it has one owner); false for everyone when not configured. */
  allows?(userId: string): Promise<boolean>;
  /** The file's bytes; rejects files above maxBytes (default 25 MB). Audited as computer_files_read. */
  readFile(userId: string, path: string, opts?: { maxBytes?: number; runId?: string }): Promise<Uint8Array>;
  /** Creates parent directories. Audited as computer_files_write (path only, never contents). */
  writeFile(userId: string, path: string, bytes: Uint8Array, opts?: { runId?: string }): Promise<void>;
  /** bash in /workspace. Audited as computer_exec (never the full command). No ToolPolicy check here:
   * callers that run on the model's behalf go through the computer_exec tool instead. */
  exec(userId: string, command: string, opts?: { cwd?: string; timeoutMs?: number; runId?: string }): Promise<WorkspaceExecResult>;
}

/** M26: explicit user deletion only; model writes still go through ToolPolicy + Approval. */
export interface WorkspaceFileDelete {
  deleteFileAs(userId: string, path: string, opts: { actor: "user"; audit?: boolean }): Promise<"deleted" | "missing">;
}
