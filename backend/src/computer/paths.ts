// Local checks on /workspace paths and other small helpers. The computer confines paths itself
// (including symlink escapes); these checks refuse the obvious cases before anything is sent.

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

const MAX_PATH = 1024;

/**
 * A path relative to /workspace in normal form ("a/b.txt"). Refuses absolute paths, "..", empty
 * segments after normalisation, control characters and backslashes. "." / "" mean the root only
 * where allowRoot is set (listing).
 */
export function workspacePath(input: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof input !== "string") throw new WorkspacePathError("The path must be text.");
  const raw = input.trim();
  if (raw.length > MAX_PATH) throw new WorkspacePathError("The path is too long.");
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new WorkspacePathError("The path has characters that aren't allowed.");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) {
    // "/workspace/x" is how the model sometimes names a file; anything else absolute is refused.
    if (raw === "/workspace" || raw.startsWith("/workspace/")) return workspacePath(raw.slice("/workspace".length).replace(/^\/+/, "") || ".", opts);
    throw new WorkspacePathError("Use a path relative to /workspace.");
  }
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new WorkspacePathError("The path can't leave /workspace.");
    parts.push(segment);
  }
  if (parts.length === 0) {
    if (opts.allowRoot) return ".";
    throw new WorkspacePathError("Name a file inside /workspace.");
  }
  return parts.join("/");
}

/** Single-quoted for bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The host of an http(s) URL, or null (about:blank, data: ...). */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Full web address for the assistant, with credentials removed; blank pages remain recognizable. */
export function modelPageUrl(raw: string | null | undefined): string | null {
  if (raw === "about:blank") return raw;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Page state for storage, broadcast and logs: origin + path, without query or fragment. */
export function publicPageUrl(raw: string | null | undefined): string | null {
  const full = modelPageUrl(raw);
  if (!full || full === "about:blank") return null;
  const url = new URL(full);
  return `${url.origin}${url.pathname}`;
}

/**
 * The audit target of a shell command: the program name only (git, python3, node ...), never the
 * arguments, which can carry secrets or file contents.
 */
export function execTarget(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  return /^[A-Za-z0-9._+-]{1,40}$/.test(base) ? base : "shell";
}

/** A file name safe on any filesystem and in a shell (letters, digits, . _ -), keeping the extension. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-120);
  return cleaned.length > 0 ? cleaned : "file";
}

/** The file name part of a workspace path. */
export function baseName(path: string): string {
  return path.split("/").pop() || path;
}
