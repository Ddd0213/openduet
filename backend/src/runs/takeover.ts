// M14: what a run already did, read back from its record (runs/steps.ts) for the model.
// - takeoverNote: a retry, or a turn the server restart cut off, starts with a bracketed note that
//   lists the failed attempt's tool calls (a short argument and how each ended) and what it already
//   wrote to the user, so the new attempt checks before it redoes a step (codync-harness #5; wording
//   after Codync's agent/fallback/carry.rs `takeover()`). Model-facing English, never shown.
// - toolDigests: one summary per earlier assistant turn (A4), from that run's tool steps. Context
//   supplies these as separate server records, not as text the assistant previously wrote.
// Both read what the recorder stored, which is already redacted and capped (redact.ts).
import type { RunKind } from "../agent/types.ts";
import { MESSAGE_KINDS } from "../contract/messages.ts";
import type { Db } from "../db.ts";

export type TakeoverReason = "failed" | "restart";

/** The fields of a RunStep row these summaries read. */
export interface StepRow { kind: string; tool: string | null; detail: string; status: string; input: string | null; output: string | null }

/** The whole note stays under this many characters. */
export const TAKEOVER_MAX_CHARS = 1500;
/** Each text the failed attempt wrote is quoted up to this many characters. */
export const TAKEOVER_TEXT_CHARS = 200;
/** One history turn's digest line stays under this many characters. */
export const DIGEST_MAX_CHARS = 200;
/** Steps read per run (the oldest first). */
const STEP_TAKE = 300;
const DIGEST_STEP_TAKE = 20;
const ARG_CHARS = 60;

/** A2: the note of a chat turn the restart interrupted before it did anything. */
export const RESTART_NOTE = "[The server restarted and interrupted this turn. Continue from where it stopped; don't repeat anything already done.]";

/** Kinds whose plain text never reaches the thread (a check-in's or a scan's filter mutes it). */
const MUTED_TEXT: ReadonlySet<string> = new Set<RunKind>(["checkin", "scan"]);

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();
const cut = (value: string, max: number): string => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ID_KEYS = ["artifactId", "taskId", "approvalId", "id", "messageId", "reminderId", "routineId"];

/** How a tool step ended, in a few words (and the id it made, when its result names one). */
export function stepOutcome(step: Pick<StepRow, "status" | "output">): string {
  switch (step.status) {
    case "error": return "failed";
    case "denied": return "declined";
    case "awaiting_approval": return "waiting for the user's approval";
    case "running": return "didn't finish";
  }
  const data = parseObject(step.output);
  if (!data) return "ok";
  const state = [data.status, data.state].find((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 40);
  const id = ID_KEYS.map((k) => data[k]).find((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64);
  if (data.error !== undefined && !state) return "failed";
  return [state, id].filter(Boolean).join(" ") || "ok";
}

/** Consecutive identical calls (same tool, argument and outcome) collapse into one line "×n". */
function toolLines(steps: StepRow[], withArgs: boolean): string[] {
  const lines: { text: string; count: number }[] = [];
  for (const step of steps) {
    // M29: loading tools did nothing to tell (redoing it costs nothing).
    if (step.kind !== "tool" || !step.tool || step.tool === "load_tools") continue;
    const arg = withArgs && step.detail ? ` (${cut(oneLine(step.detail), ARG_CHARS)})` : "";
    const text = `${step.tool}${arg} → ${stepOutcome(step)}`;
    const last = lines.at(-1);
    if (last && last.text === text) last.count++;
    else lines.push({ text, count: 1 });
  }
  return lines.map((l) => (l.count > 1 ? `${l.text} ×${l.count}` : l.text));
}

/** What the attempt wrote to the user: each text segment's start (never `(pass)`). */
function textLines(steps: StepRow[], kind: string): string[] {
  if (MUTED_TEXT.has(kind)) return [];
  return steps.flatMap((step) => {
    if (step.kind !== "text") return [];
    const body = oneLine(stripDigests(step.input ?? step.detail ?? ""));
    if (!body || body === "(pass)") return [];
    return [`"${cut(body, TAKEOVER_TEXT_CHARS)}"`];
  });
}

/**
 * The takeover note for a run's steps, or null when there's nothing to say (a failed attempt that
 * did and wrote nothing: a plain retry is enough). A restart always gets at least RESTART_NOTE.
 */
export function composeTakeover(steps: StepRow[], kind: string, reason: TakeoverReason): string | null {
  const tools = toolLines(steps, true);
  const texts = textLines(steps, kind);
  if (!tools.length && !texts.length) return reason === "restart" ? RESTART_NOTE : null;
  const head = reason === "restart"
    ? "[The server restarted and interrupted the previous attempt at this turn, so you're taking over."
    : "[The previous attempt at this turn failed partway through, so you're taking over.";
  const tail = "Check what's already done before you redo any step, and don't repeat what the user was already told.]";
  const toolsTitle = "What was already done:";
  const textsTitle = "What the user was already told:";
  let budget = TAKEOVER_MAX_CHARS - head.length - tail.length - 2;
  const out: string[] = [head];
  if (tools.length) {
    // With texts to quote too, the tool list keeps at most ~60% of the room.
    const share = texts.length ? Math.floor(budget * 0.6) : budget;
    const lines = fit(tools, share - toolsTitle.length - 1);
    out.push(toolsTitle, ...lines);
    budget -= toolsTitle.length + 1 + lines.reduce((n, l) => n + l.length + 1, 0);
  }
  if (texts.length) out.push(textsTitle, ...fit(texts, budget - textsTitle.length - 1));
  out.push(tail);
  return out.join("\n");
}

/** As many "- item" lines as fit in `budget` characters, then "- …and N more". */
function fit(items: string[], budget: number): string[] {
  const reserve = 20;
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const line = `- ${items[i]}`;
    const last = i === items.length - 1;
    if (used + line.length + 1 + (last ? 0 : reserve) > budget) {
      lines.push(`- …and ${items.length - i} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

/** The takeover note of a run, read from its record (null when the run did nothing worth naming). */
export async function takeoverNote(db: Db, runId: string, reason: TakeoverReason): Promise<string | null> {
  const run = await db.run.findUnique({ where: { id: runId }, select: { kind: true } });
  if (!run) return reason === "restart" ? RESTART_NOTE : null;
  const steps = await db.runStep.findMany({
    where: { runId, kind: { in: ["tool", "text"] } }, orderBy: { index: "asc" }, take: STEP_TAKE,
    select: { kind: true, tool: true, detail: true, status: true, input: true, output: true },
  });
  return composeTakeover(steps, run.kind, reason);
}

/** One history turn's digest line from its run's tool steps, or null without any. */
export function digestLine(steps: StepRow[]): string | null {
  const lines = toolLines(steps, false);
  if (!lines.length) return null;
  return `[tools: ${cut(lines.join("; "), DIGEST_MAX_CHARS - 9)}]`;
}

/** Only history-note heads count; ordinary brackets and Markdown stay user text. */
const NOTE_WORDS = ["attachment", ...MESSAGE_KINDS];
const NOTE_OPENERS = ["[tools:", "[Attached:", "[stopped by the user:", ...NOTE_WORDS.map((kind) => `[${kind}`)];
const NOTE_HEAD = new RegExp(`^\\[(?:tools:|Attached:|stopped by the user:|(?:${NOTE_WORDS.join("|")})(?=[ \\t\\]]))`);
/**
 * An unclosed head that can only be a cut-off server note, so the final flush drops it: the
 * server's own prefixes, or a card kind followed by its quoted title / options. Prose like
 * "[file 名称 那一栏" or "[text in brackets" never closes and stays as written.
 */
const CUT_NOTE = new RegExp(`^\\[(?:tools:|Attached:|stopped by the user:|attachment|(?:${MESSAGE_KINDS.join("|")}) (?:"|options:))`);
/** A weak (card-kind) head is held back while streaming at most this long; server labels are shorter. */
const HELD_TAIL_MAX = 300;

/** Find the outer closing bracket, including JSON-quoted names containing brackets. */
function noteEnd(line: string, start: number): number | null {
  let depth = 0, quoted = false;
  for (let i = start; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") { i++; continue; }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "[") depth++;
    if (char === "]" && --depth === 0) return i + 1;
  }
  return null;
}

/**
 * Remove copied history notes at line ends, including a chain of notes while its last one is
 * still streaming. Code, escaped brackets, links and mentions followed by prose stay intact.
 * This also cleans stored assistant prose before it becomes another example for the model.
 */
export function stripDigests(text: string, streaming = false): string {
  if (!text.includes("[")) return text;
  const lines = text.split("\n");
  let dropped = false, fence: string | null = null, ticks = 0;
  const kept = lines.flatMap((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      return [line];
    }
    if (marker && !ticks) { fence = marker[1]!; return [line]; }
    if (/^(?: {4}|\t)/.test(line)) return [line];

    const notes: { start: number; end: number }[] = [];
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "\\" && !ticks) { i++; continue; }
      if (char === "`") {
        const start = i;
        while (line[i + 1] === "`") i++;
        const size = i - start + 1;
        if (!ticks) ticks = size;
        else if (ticks === size) ticks = 0;
        continue;
      }
      if (ticks || char !== "[") continue;
      // The second bracket of a reference link is not a card label.
      if (line[i - 1] === "]" && notes.at(-1)?.end !== i) continue;
      const tail = line.slice(i);
      const head = NOTE_HEAD.test(tail);
      const partial = streaming && index === lines.length - 1;
      if (!head && !(partial && NOTE_OPENERS.some((opener) => opener.startsWith(tail)))) continue;
      const end = noteEnd(line, i);
      if (end === null) {
        // Unclosed: only the reply's last line can still be a note in the making. While streaming
        // it waits (a card-kind head only so long); on the final flush only a head that can't be
        // prose is dropped, so a stopped or cut-off reply never reveals one.
        const last = index === lines.length - 1;
        const cutNote = CUT_NOTE.test(tail);
        const held = partial && (cutNote || tail.length <= HELD_TAIL_MAX);
        if (last && (held || cutNote)) notes.push({ start: i, end: line.length });
        break;
      }
      // Inline tool digests have an outcome arrow; keep ordinary references to "[tools: …]".
      const digest = tail.startsWith("[tools:");
      if (!digest || line.slice(i, end).includes("→") || !line.slice(0, i).trim()) notes.push({ start: i, end });
      i = end - 1;
    }
    let cut = line.length;
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]!;
      if (line.slice(note.end, cut).trim()) break;
      cut = note.start;
    }
    if (cut === line.length) return [line];
    dropped = true;
    const rest = line.slice(0, cut).trimEnd();
    return rest ? [rest] : [];
  });
  return dropped ? kept.join("\n").trimEnd() : text;
}

/** A thread: a channel's own timeline (taskId null) or a task's session. */
export interface ThreadScope { userId: string; channelId: string; taskId: string | null }

/**
 * A4: message id -> the `[tools: …]` line for the last assistant message each earlier run wrote in
 * this window. The runs and their tool steps are read in one query; a message is matched to the
 * run that was running when it was written (runs of one thread are serialized by its queue).
 * Builds run on their own queue next to the chat and are left out.
 */
export async function toolDigests(
  db: Db, scope: ThreadScope, rows: { id: string; role: string; createdAt: Date }[], currentRunId?: string,
): Promise<Map<string, string>> {
  return digestsOf(rows, await windowRuns(db, scope, rows, currentRunId));
}

/** An earlier run of the history window with its first tool steps. */
export type WindowRun = Awaited<ReturnType<typeof windowRuns>>[number];

/**
 * The runs that wrote the assistant messages of this window (one query; empty without any), with
 * their first DIGEST_STEP_TAKE tool steps. M29: the digests and the tools that stay loaded
 * (runs/tool-history.ts) both read them.
 */
export async function windowRuns(db: Db, scope: ThreadScope, rows: { id: string; role: string; createdAt: Date }[], currentRunId?: string) {
  const assistant = rows.filter((r) => r.role === "assistant");
  if (!assistant.length) return [];
  const from = assistant.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), assistant[0]!.createdAt);
  const to = assistant.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), assistant[0]!.createdAt);
  return db.run.findMany({
    where: {
      userId: scope.userId, channelId: scope.channelId, startedAt: { not: null, lte: to },
      ...(currentRunId ? { id: { not: currentRunId } } : {}),
      AND: [
        scope.taskId !== null ? { taskId: scope.taskId, kind: "task" } : { kind: { not: "build" }, OR: [{ taskId: null }, { kind: "routine" }] },
        { OR: [{ finishedAt: null }, { finishedAt: { gte: from } }] },
      ],
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true, startedAt: true, finishedAt: true,
      steps: { where: { kind: "tool" }, orderBy: { index: "asc" }, take: DIGEST_STEP_TAKE, select: { kind: true, tool: true, detail: true, status: true, input: true, output: true } },
    },
  });
}

/** The digest lines of a window's runs, by the message each one goes under. */
export function digestsOf(rows: { id: string; role: string; createdAt: Date }[], runs: WindowRun[]): Map<string, string> {
  const digests = new Map<string, string>();
  const assistant = rows.filter((r) => r.role === "assistant");
  const withTools = runs.filter((r) => r.steps.length > 0);
  if (!assistant.length || !withTools.length) return digests;
  // The last assistant message of each run gets the line (a user message mid-run doesn't split it).
  const lastOf = new Map<string, string>();
  for (const row of assistant) {
    const at = row.createdAt.getTime();
    let match: (typeof withTools)[number] | undefined;
    for (const run of withTools) {
      const start = run.startedAt!.getTime();
      const end = run.finishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (start <= at && at <= end) match = run; // the latest-started run that holds it
    }
    if (match) lastOf.set(match.id, row.id);
  }
  for (const run of withTools) {
    const messageId = lastOf.get(run.id);
    const line = messageId ? digestLine(run.steps) : null;
    if (messageId && line) digests.set(messageId, line);
  }
  return digests;
}
