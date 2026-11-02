// M14 A2: chat turns a restart cut off (codync-harness #2). At boot, RunHost.recoverStaleRuns asks:
// which stored user message did this chat run answer (runs keep no message id, so it's the newest
// user message of the thread written just before the run, whose chat title matches the run's), and
// did a running attempt do anything yet (a tool step or a text step in its record)? Pure lookups;
// the host decides what to re-run.
import type { Run as RunRow } from "@prisma/client";
import { Phrase } from "../contract/common.ts";
import type { Db } from "../db.ts";
import { chatTitle } from "./records.ts";

/** A running chat turn younger than this is re-run after a restart (when it did nothing yet). */
export const RESUME_WINDOW_MS = 60 * 60_000;
/** A send stores its message and run in one transaction: the message is at most this much older. */
const SEND_GAP_MS = 5_000;

/** M14: the card a long or busy chat turn the restart cut off gets (key for B / the lead to add). */
export const INTERRUPTED_PHRASE = "system.turn_interrupted";

/** Bind a retry/resume to its input in the same transaction that creates its Run. Unlike the
 * legacy title/time heuristic, this also works for old messages and the latest steering input. */
export async function bindAnsweredMessages(db: Pick<Db, "message">, userId: string, runId: string, ids: string[]): Promise<void> {
  const id = ids.at(-1);
  if (!id) return;
  const row = await db.message.findFirstOrThrow({ where: { id, userId, role: "user" }, select: { payload: true } });
  let payload: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(row.payload);
    if (value && typeof value === "object" && !Array.isArray(value)) payload = value as Record<string, unknown>;
  } catch { /* Older malformed payloads still have usable user text. */ }
  await db.message.update({ where: { id }, data: { payload: JSON.stringify({ ...payload, answeringRunId: runId, answeringMessageIds: ids }) } });
}

function titleOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = Phrase.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.text !== undefined ? parsed.data.text : null;
  } catch {
    return null;
  }
}

/**
 * A retry/resume uses its explicit durable input binding. Legacy/new-send runs fall back to
 * the message written in the same send (≤ 5 s before the run), in its thread with a matching
 * chat title. null when neither identifies a message (or the message was deleted).
 */
export async function answeredMessage(db: Db, run: RunRow): Promise<{ id: string; text: string; payload: string; callId: string | null } | null> {
  if (!run.channelId) return null;
  const bound = await db.message.findFirst({
    where: { userId: run.userId, channelId: run.channelId, taskId: run.taskId, role: "user", payload: { contains: `"answeringRunId":${JSON.stringify(run.id)}` } },
    select: { id: true, text: true, payload: true, callId: true },
  });
  if (bound) return bound;
  const title = titleOf(run.title);
  if (title === null || !run.channelId) return null;
  const candidates = await db.message.findMany({
    where: {
      userId: run.userId, channelId: run.channelId, taskId: run.taskId, role: "user",
      createdAt: { lte: run.createdAt, gte: new Date(run.createdAt.getTime() - SEND_GAP_MS) },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5,
    select: { id: true, text: true, payload: true, callId: true },
  });
  for (const message of candidates) {
    if (chatTitle(message.text).text === title) return message;
    // A message with no text is titled by its first file's name.
    if (!message.text.trim()) {
      const file = await db.channelFile.findFirst({ where: { messageId: message.id }, orderBy: { createdAt: "asc" }, select: { name: true } });
      if (chatTitle("", file?.name).text === title) return message;
    }
  }
  return null;
}

/**
 * A running attempt that did nothing visible yet: started < 1 h ago, no tool step and no text
 * step. Every assistant bubble a turn posts is streamed text (a text step) and every card comes from
 * a tool (a tool step), so the run's own record answers "posted no bubble" exactly; messages have
 * no run id, and other writers in the channel (a build's card) would only blur it.
 */
export async function didNothingYet(db: Db, run: RunRow, now: Date): Promise<boolean> {
  if (!run.startedAt || now.getTime() - run.startedAt.getTime() >= RESUME_WINDOW_MS) return false;
  const done = await db.runStep.count({ where: { runId: run.id, OR: [{ kind: "tool" }, { kind: "text", NOT: { input: null } }] } });
  return done === 0;
}
