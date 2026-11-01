// M14: what a run already did, read back from its record (runs/steps.ts) for the model.
// - takeoverNote: a retry, or a turn the server restart cut off, starts with a bracketed note that
//   lists the failed attempt's tool calls (a short argument and how each ended) and what it already
//   wrote to the user, so the new attempt checks before it redoes a step (codync-harness #5; wording
//   after Codync's agent/fallback/carry.rs `takeover()`). Model-facing English, never shown.
// - toolDigests: one `[tools: …]` line per earlier assistant turn in the history window (A4), from the
//   tool steps of the run that wrote it.
// Both read what the recorder stored, which is already redacted and capped (redact.ts).
import type { RunKind } from "../agent/types.ts";
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

/** A whole line in the digest's own format; a model reading its history sometimes writes one too. */
const DIGEST_LINE = /^[ \t]*\[tools:.*\][ \t]*$/;
const DIGEST_START = "[tools:";

/**
 * A text without the lines that copy the digest format (the user never sees the server's digest,
 * so the assistant's own copy of it is dropped too). A mention inside a sentence stays. With `streaming`,
 * a last line that could still become one is held back until it is complete.
 */
export function stripDigests(text: string, streaming = false): string {
  if (!text.includes("[")) return text;
  const lines = text.split("\n");
  let dropped = false;
  const kept = lines.filter((line, i) => {
    const last = i === lines.length - 1;
    const lead = line.trimStart();
    const partial = streaming && last && (DIGEST_START.startsWith(lead) || lead.startsWith(DIGEST_START)) && lead !== "";
    if (!DIGEST_LINE.test(line) && !partial) return true;
    dropped = true;
    return false;
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
