// DB rows -> contract shapes. The one place that turns Message/Channel/ChannelFile rows into
// what the API and the event log send, so every route and the run host agree.
import type { Channel as ChannelRow, ChannelFile as FileRow, Message as MessageRow, Reaction as ReactionRow } from "@prisma/client";
import type { z } from "zod";
import { chatTitle } from "../calls/title.ts";
import { normalizeAssistantProtocol } from "../contract/common.ts";
import type { Channel } from "../contract/channels.ts";
import { Channel as ChannelSchema } from "../contract/channels.ts";
import { BriefInfo } from "../contract/m23.ts";
import type { ChannelFile } from "../contract/channels.ts";
import { FileOrigin } from "../contract/m26.ts";
import { Forwarded, TaskResult } from "../contract/m18.ts";
import type { ActiveRun } from "../contract/m21.ts";
import { RunKind } from "../contract/runs.ts";
import { Message as MessageSchema, ReplyTo, type Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

/**
 * M26 contract: the stored origin / workspacePath / taskId / deletedAt as they are. taskTitle and
 * artifactId need lookups (M26 W1b fills them in for lists, the DELETE answer and new cards).
 */
export function toChannelFile(row: FileRow): ChannelFile {
  const origin = FileOrigin.safeParse(row.origin);
  return {
    id: row.id, channelId: row.channelId, messageId: row.messageId, name: row.name, mime: row.mime,
    size: row.size, source: row.source === "assistant" || row.source === "claude" ? "assistant" : "user", url: `/api/files/${row.id}/content`,
    createdAt: row.createdAt.toISOString(),
    origin: origin.success ? origin.data : null, workspacePath: row.workspacePath || null, taskId: row.taskId,
    taskTitle: null, artifactId: null, deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** M26: enrich a list in at most one Task and one Artifact query, scoped to the owner. */
export async function toChannelFiles(db: Db, userId: string, rows: FileRow[]): Promise<ChannelFile[]> {
  const taskIds = [...new Set(rows.flatMap((row) => row.taskId ? [row.taskId] : []))];
  const artifactOf = (row: FileRow) => /^artifacts\/([^/]+)\/.+/.exec(row.workspacePath ?? "")?.[1] ?? null;
  const artifactIds = [...new Set(rows.flatMap((row) => artifactOf(row) ? [artifactOf(row)!] : []))];
  const [tasks, artifacts] = await Promise.all([
    taskIds.length ? db.task.findMany({ where: { userId, id: { in: taskIds } }, select: { id: true, title: true } }) : [],
    artifactIds.length ? db.artifact.findMany({ where: { userId, id: { in: artifactIds } }, select: { id: true } }) : [],
  ]);
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const existing = new Set(artifacts.map((artifact) => artifact.id));
  return rows.map((row) => ({
    ...toChannelFile(row), taskTitle: row.taskId ? titles.get(row.taskId) ?? null : null,
    artifactId: existing.has(artifactOf(row) ?? "") ? artifactOf(row) : null,
  }));
}

function parsePayload(row: MessageRow): Record<string, unknown> {
  try {
    const value: unknown = normalizeAssistantProtocol(JSON.parse(row.payload));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A stored quote reference, or null (older rows have none; a malformed one never hides the message). */
export function replyToOf(payload: Record<string, unknown>): z.infer<typeof ReplyTo> | null {
  const parsed = ReplyTo.safeParse(payload.replyTo);
  return parsed.success ? parsed.data : null;
}

/** M18: a stored text payload's taskResult / forwarded, or null (older rows; a malformed one never hides the message). */
function m18Of(payload: Record<string, unknown>) {
  const taskResult = TaskResult.safeParse(payload.taskResult);
  const forwarded = Forwarded.safeParse(payload.forwarded);
  return { taskResult: taskResult.success ? taskResult.data : null, forwarded: forwarded.success ? forwarded.data : null };
}

/**
 * Text messages carry their attachments from ChannelFile rows, never from the stored payload.
 * M10: `stopped` is kept in the stored payload (`"stopped": true`, set by the run host when Stop cut
 * the reply short) and sent on the message itself; anything else reads as false.
 */
export function toMessage(row: MessageRow, reactions: ReactionRow[], files: FileRow[]): Message | null {
  const payload = parsePayload(row);
  // Old call messages already stored the localized fallback; normalize every API/event serialization.
  if (row.kind === "call" && typeof payload.title === "string") payload.title = chatTitle(payload.title);
  const text = row.callId && row.role === "user" ? handOffText(row.text) : row.text;
  // M23: the morning brief's unchecked sources (TextPayload.brief), only when the stored one is valid
  const brief = row.kind === "text" && BriefInfo.safeParse(payload.brief).success ? { brief: payload.brief } : {};
  const shaped = row.kind === "text" ? { skill: payload.skill ?? null, attachments: files.map(toChannelFile), replyTo: replyToOf(payload), ...m18Of(payload), ...brief } : payload;
  const parsed = MessageSchema.safeParse({
    id: row.id, channelId: row.channelId, taskId: row.taskId, role: row.role === "claude" ? "assistant" : row.role, kind: row.kind, text,
    status: row.status, clientId: row.clientId, reactions: reactions.map((r) => ({ emoji: r.emoji, by: r.by === "claude" ? "assistant" : r.by })),
    stopped: payload.stopped === true,
    // M13: a voice call's hand-off and the assistant's text bubbles in that turn (M15: shown, the hand-off
    // labelled as passed on during a call)
    callId: row.callId ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), payload: shaped,
  });
  if (!parsed.success) {
    // Rows are validated on write; a mismatch means old data, so skip it instead of failing the page.
    log.warn("message does not match the contract", { messageId: row.id, kind: row.kind });
    return null;
  }
  return parsed.data;
}

/**
 * M15: what a voice hand-off shows in the chat: the voice's words for the assistant, without the quote
 * of the user's own words on the call (calls/tools.ts MARKER) that only the model reads.
 */
export function handOffText(text: string): string {
  const at = text.lastIndexOf("\n\n[The user's own words on the call: «");
  return at > 0 && text.endsWith("»]") ? text.slice(0, at) : text;
}

/** Loads reactions and files for these rows in two queries and keeps the input order. */
export async function toMessages(db: Db, rows: MessageRow[]): Promise<Message[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [reactions, files] = await Promise.all([
    db.reaction.findMany({ where: { messageId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    db.channelFile.findMany({ where: { messageId: { in: ids } }, orderBy: { createdAt: "asc" } }),
  ]);
  const out: Message[] = [];
  for (const row of rows) {
    const message = toMessage(row, reactions.filter((r) => r.messageId === row.id), files.filter((f) => f.messageId === row.id));
    if (message) out.push(message);
  }
  return out;
}

/** The contract's payload schema for a kind; writers validate before storing a row. */
export function payloadSchemaFor(kind: Message["kind"]) {
  const option = MessageSchema.options.find((o) => o.shape.kind.value === kind);
  if (!option) throw new Error(`unknown message kind ${kind}`);
  return option.shape.payload;
}

export async function loadMessage(db: Db, id: string): Promise<Message | null> {
  const row = await db.message.findUnique({ where: { id } });
  return row ? ((await toMessages(db, [row]))[0] ?? null) : null;
}

/**
 * M21 (contract m21.ts ActiveRun): the turn running in a channel's own thread, else the first one
 * queued there; null when none. The thread's own turns are everything on the channel's queue: chat,
 * briefs, check-ins, scans (taskId null) and a routine's channel turns (kind routine, Run.taskId =
 * the routine). Not a task's session (its own queue) and not a build (the artifact's queue). One
 * query: "running" sorts after "queued", so descending puts a running row first, then by age.
 * startedAt is the run's start, or its queue time while it waits.
 */
export async function activeRunOf(db: Db, channelId: string): Promise<ActiveRun | null> {
  const run = await db.run.findFirst({
    where: {
      // Only the thread's own conversation: chat, and a routine's turns in its channel (M21 contract).
      // A brief / check-in / scan isn't one: the app's Stop (chat only) couldn't stop it.
      channelId, status: { in: ["queued", "running"] }, kind: { in: ["chat", "routine"] },
      OR: [{ taskId: null }, { kind: "routine" }],
    },
    orderBy: [{ status: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, startedAt: true, createdAt: true },
  });
  if (!run) return null;
  const kind = RunKind.safeParse(run.kind);
  if (!kind.success) return null;
  return { runId: run.id, kind: kind.data, startedAt: (run.startedAt ?? run.createdAt).toISOString() };
}

/**
 * Unread = the assistant's and system lines after lastReadAt (the user's own never count). M11: the main
 * thread always answers soulExtra "" and useSharedMemory true. M21: activeRun (activeRunOf).
 */
export async function toChannel(db: Db, row: ChannelRow): Promise<Channel> {
  const [unreadCount, last, activeRun] = await Promise.all([
    // M15: a voice call's hand-offs and replies (callId set) count like any other message.
    db.message.count({ where: { channelId: row.id, taskId: null, role: { not: "user" }, ...(row.lastReadAt ? { createdAt: { gt: row.lastReadAt } } : {}) } }),
    db.message.findFirst({ where: { channelId: row.id, taskId: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    activeRunOf(db, row.id),
  ]);
  return ChannelSchema.parse({
    id: row.id, isMain: row.isMain, name: row.name, icon: row.icon, colorHex: row.colorHex, purpose: row.purpose,
    archived: row.archived, unreadCount, lastReadAt: row.lastReadAt?.toISOString() ?? null,
    lastMessageAt: last?.createdAt.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    soulExtra: row.isMain ? "" : row.soulExtra, useSharedMemory: row.isMain ? true : row.useSharedMemory,
    // M12: a channel's own model and thinking level (the main thread always uses the defaults).
    modelId: row.isMain ? null : row.modelId, thinkingLevel: row.isMain ? null : row.thinkingLevel,
    activeRun,
  });
}
