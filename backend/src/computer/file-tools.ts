// M27: local file operations, on the computer's confined byte download (never the shell for reads).
import { replaceText } from "../artifacts/page-edit.ts";
import { ComputerError, type ComputerClient } from "./client.ts";
import { shellQuote, workspacePath } from "./paths.ts";
import { WorkspaceError } from "./workspace-impl.ts";

export const FILE_TEXT_MAX = 60_000;
const READ_MAX_BYTES = 10 * 1024 * 1024;

// A router 404, not a missing file; same distinction as workspace-impl.ts.
const missingRoute = (error: unknown) => error instanceof ComputerError && error.kind === "not_found"
  && (error.detail === "" || error.detail === "Not found.");

function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new WorkspaceError("failed", "The file is not valid UTF-8 text; it can't be read or edited as text."); }
}

/** A trailing newline ends its line, rather than creating a phantom extra line. Empty files have zero lines. */
function lineRange(body: string, offset = 1, limit?: number) {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join("");
  const text = selected.slice(0, FILE_TEXT_MAX);
  const shown = text.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
  return {
    text, fromLine: offset, toLine: shown ? offset + shown - 1 : lines.length,
    totalLines: lines.length, truncated: selected.length > text.length || offset - 1 + shown < lines.length,
  };
}

export async function readFileText(client: ComputerClient, args: { path: string; offset?: number; limit?: number }, signal?: AbortSignal) {
  const path = workspacePath(args.path);
  try {
    const bytes = await client.download(path, { maxBytes: READ_MAX_BYTES, signal });
    return { path, ...lineRange(utf8(bytes), args.offset, args.limit), bytes: bytes.byteLength };
  } catch (error) {
    if (!missingRoute(error)) throw error;
  }
  if (args.offset !== undefined) throw new WorkspaceError("failed", "This older computer can't read a line range with offset; it can only read the beginning of a file.");
  const read = await client.readText(path, signal);
  const range = lineRange(read.text, 1, args.limit);
  return { path, ...range, totalLines: read.truncated ? null : range.totalLines, truncated: !!read.truncated || range.truncated, bytes: read.bytes ?? null };
}

/** Exact, whole-file replacement; the input and the rewritten file must both fit the computer's write limit. */
export async function editFileText(client: ComputerClient, args: { path: string; old_string: string; new_string: string; replace_all?: boolean }, signal?: AbortSignal) {
  const path = workspacePath(args.path);
  const source = await client.download(path, { maxBytes: 1_000_000, signal });
  const replaced = replaceText(utf8(source), args.old_string, args.new_string, args.replace_all);
  if (!replaced.ok) throw new WorkspaceError("failed", replaced.error.replace(/\bpage\b/g, "file"));
  const bytes = new TextEncoder().encode(replaced.html);
  if (bytes.byteLength > 1_000_000) throw new WorkspaceError("too_large", `The edited file is ${bytes.byteLength} bytes; the write limit is 1000000.`);
  await client.writeText(path, replaced.html, {}, signal);
  return { path, bytes, replacements: replaced.replacements };
}

export interface FileSearchArgs { query: string; regex?: boolean; path?: string; glob?: string; ignore_case?: boolean }
const SEARCH_CAPPED = "__DUET_SEARCH_CAPPED__";
/** awk's mark on a line it cut at 300 bytes (a control character grep -I text lines don't end in). */
const CUT = "\u0001";

/** A fixed read-only grep pipeline. No user text can become shell syntax; recursive grep does not follow nested links. */
export async function searchFiles(client: ComputerClient, args: FileSearchArgs, signal?: AbortSignal) {
  const path = workspacePath(args.path ?? ".", { allowRoot: true });
  const grep = ["grep", "-rIn", args.regex ? "-E" : "-F", ...(args.ignore_case ? ["-i"] : []),
    ...(args.glob ? [`--include=${args.glob}`] : []), "--exclude-dir=.git", "--exclude-dir=node_modules", "-e", args.query, "--"].map(shellQuote).join(" ");
  // Cap before /exec's 64 KiB tail limit, keeping the FIRST matches. LC_ALL=C gives a conservative
  // 300-byte (at most 300-character) line cap, including path and number, even for multibyte text.
  // A cut line ends in CUT, so the half character a byte cut can leave is dropped below.
  const format = `NR > 200 { capped=1; exit } { line=substr($0,length(root)+2); sub(/:[0-9]+:/,"& ",line); if(length(line)>300) { line=substr(line,1,300) "\\001"; capped=1 } print line } END { if(capped) print "${SEARCH_CAPPED}" }`;
  const command = [
    `ROOT="$(pwd -P)"`,
    `DIR="$(cd -P -- ${shellQuote(path)} 2>/dev/null && pwd -P)" || exit 3`,
    `case "$DIR/" in "$ROOT"/*) ;; *) exit 5 ;; esac`,
    `${grep} "$DIR" | LC_ALL=C awk -v "root=$ROOT" ${shellQuote(format)}`,
    `codes=("\${PIPESTATUS[@]}")`,
    `[ "\${codes[1]}" = 0 ] || exit 6`,
    `case "\${codes[0]}" in 0|1|141) exit 0 ;; *) exit 2 ;; esac`,
  ].join("\n");
  let result;
  try { result = await client.exec(command, { timeoutMs: 20_000, signal }); }
  catch (error) {
    if (missingRoute(error) || (error instanceof ComputerError && error.kind === "forbidden")) {
      throw new WorkspaceError("failed", "Search files is unavailable: this computer needs an enabled /exec route for read-only search.");
    }
    throw error;
  }
  if (result.timedOut) throw new ComputerError("timeout", null, "File search timed out after 20 seconds.");
  if (result.exitCode === 3) throw new WorkspaceError("not_found", "There is no readable folder at that path in /workspace.");
  if (result.exitCode === 5) throw new WorkspaceError("escape", "The search folder resolves outside /workspace.");
  if (result.exitCode !== 0) throw new WorkspaceError("failed", "File search failed; check the regular expression and that the folder can be read.");
  const lines = result.stdout.split("\n").filter(Boolean);
  const capped = result.truncated || lines.includes(SEARCH_CAPPED) || lines.length > 200;
  const matches = lines.filter(line => line !== SEARCH_CAPPED).slice(0, 200)
    .map(line => line.endsWith(CUT) ? line.slice(0, -CUT.length).replace(/\uFFFD+$/, "") : line)
    .map(line => Array.from(line).slice(0, 300).join(""));
  return { path, matches, truncated: capped, ...(capped ? { note: "Search capped at 200 matches or 300 characters per line (300 bytes for multibyte text). Narrow the folder, query or glob." } : {}) };
}
