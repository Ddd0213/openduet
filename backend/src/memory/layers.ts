// M11: the two memory layers. `channelId` null = "About you" (shared by the main thread and every
// channel with useSharedMemory on); a channel id = that channel's own memory, read only there.
// Each layer has at most one document row (kind "document") and dated facts (kind "fact").
// Archived facts (forgotten, undone, dreaming) stay for undo and provenance but are never read
// into a prompt, a list or an overview. Rows of another user are never read.
import type { Channel as ChannelRow, Memory as MemoryRow } from "@prisma/client";
import type { z } from "zod";
import { MemoryFact, MemorySource } from "../contract/m11.ts";
import type { SourceRef } from "../contract/m23.ts";
import type { Db } from "../db.ts";
import { quoteExcerpt } from "../runs/quote.ts";
import { publicSourceRef } from "../suggestions/source.ts";

/** null = "About you"; else the channel whose own memory it is. */
export type LayerId = string | null;
export type MemoryFactShape = z.infer<typeof MemoryFact>;

/** At most this many facts of a layer go into a prompt (the newest). */
export const PROMPT_FACTS = 200;
/** At most this many other channels are summarised on the main thread. */
export const PROMPT_CHANNELS = 20;

export function toFact(row: MemoryRow): MemoryFactShape {
  const source = MemorySource.safeParse(row.source);
  return MemoryFact.parse({
    id: row.id, text: row.text, source: source.success ? source.data : "assistant",
    // M23: where a fact saved in the background was read (the public part; never the email / event id)
    sourceMessageId: row.sourceMessageId, sourceRef: publicSourceRef(row.sourceRef), createdAt: row.createdAt.toISOString(),
  });
}

/** The layer's document row (the newest when stray duplicates exist). */
export function layerDocument(db: Db, userId: string, channelId: LayerId) {
  return db.memory.findFirst({ where: { userId, channelId, kind: "document" }, orderBy: { updatedAt: "desc" } });
}

/** The layer's active facts, newest first (`take` caps them). */
export function activeFacts(db: Db, userId: string, channelId: LayerId, take?: number) {
  return db.memory.findMany({
    where: { userId, channelId, kind: "fact", archivedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(take !== undefined ? { take } : {}),
  });
}

/** Document + active facts (newest first) + when either last changed. */
export async function layerState(db: Db, userId: string, channelId: LayerId) {
  const [document, facts] = await Promise.all([layerDocument(db, userId, channelId), activeFacts(db, userId, channelId)]);
  const times = [document?.updatedAt, ...facts.map((f) => f.updatedAt)].filter((t): t is Date => t !== undefined).map((t) => t.getTime());
  return {
    document: document?.text ?? "",
    facts: facts.map(toFact),
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

/** Replaces the layer's document (one row per layer; a stray duplicate is dropped). */
export async function putDocument(db: Db, userId: string, channelId: LayerId, text: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const current = await tx.memory.findFirst({ where: { userId, channelId, kind: "document" }, orderBy: { updatedAt: "desc" } });
    const kept = current
      ? await tx.memory.update({ where: { id: current.id }, data: { text, archivedAt: null } })
      : await tx.memory.create({ data: { userId, channelId, kind: "document", text, source: "user" } });
    await tx.memory.deleteMany({ where: { userId, channelId, kind: "document", id: { not: kept.id } } });
  });
}

/** Whether a turn in this channel reads "About you". The main thread always does. */
export function readsShared(channel: Pick<ChannelRow, "isMain" | "useSharedMemory">): boolean {
  return channel.isMain || channel.useSharedMemory;
}

/** Whether a turn in `channel` may read (and so forget) a fact of layer `factChannelId`. */
export function canRead(channel: Pick<ChannelRow, "id" | "isMain" | "useSharedMemory">, factChannelId: LayerId): boolean {
  return factChannelId === null ? readsShared(channel) : !channel.isMain && factChannelId === channel.id;
}

export interface ChannelSummary {
  channelId: string;
  name: string;
  purpose: string;
  useSharedMemory: boolean;
  factCount: number;
  lastMessageAt: string | null;
  /** the first 160 characters of the assistant's latest text message there, markdown stripped */
  recent: string | null;
}

/**
 * Every non-main, non-archived channel of the user, oldest first: name, purpose, how many active
 * facts its own memory has, its last message and the start of the assistant's latest reply. Never the
 * memory's text (GET /api/memory/overview and the main thread's prompt). M15: messages of a voice
 * call (callId set) count like the rest: they show in the chat.
 */
export async function channelSummaries(db: Db, userId: string): Promise<ChannelSummary[]> {
  const channels = await db.channel.findMany({ where: { userId, isMain: false, archived: false }, orderBy: { createdAt: "asc" } });
  return Promise.all(channels.map(async (channel) => {
    const [factCount, last, reply] = await Promise.all([
      db.memory.count({ where: { userId, channelId: channel.id, kind: "fact", archivedAt: null } }),
      db.message.findFirst({ where: { channelId: channel.id, taskId: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      db.message.findFirst({ where: { channelId: channel.id, taskId: null, role: "assistant", kind: "text", text: { not: "" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { text: true } }),
    ]);
    const recent = reply ? quoteExcerpt(reply.text) : "";
    return {
      channelId: channel.id, name: channel.name, purpose: channel.purpose, useSharedMemory: channel.useSharedMemory,
      factCount, lastMessageAt: last?.createdAt.toISOString() ?? null, recent: recent || null,
    };
  }));
}

/**
 * Facts as the prompt carries them: `{id, text, at}` (oldest first), so forget can name them.
 * M18c: a fact with a follow-up time adds `dueAt` (when to bring it up).
 * M23: a fact saved from something the assistant read adds `from` (app, kind, title, at).
 */
export function promptFacts(rows: MemoryRow[]): { id: string; text: string; at: string; dueAt?: string; from?: SourceRef }[] {
  return [...rows].reverse().map((row) => {
    const from = publicSourceRef(row.sourceRef);
    return { id: row.id, text: row.text, at: row.createdAt.toISOString(), ...(row.dueAt ? { dueAt: row.dueAt.toISOString() } : {}), ...(from ? { from } : {}) };
  });
}

/** M18c: a follow-up not brought up within this long after its dueAt lapses silently. */
export const FOLLOW_UP_LAPSE_MS = 3 * 24 * 60 * 60 * 1000;

export interface DueFollowUp { id: string; text: string; dueAt: string }

/**
 * M18c: the user's active facts whose follow-up is due (dueAt <= now and not older than 3 days),
 * oldest due first. `layers` limits them to the given layers (null = "About you").
 */
export async function dueFollowUps(db: Db, userId: string, now: Date, layers: LayerId[], take = 10): Promise<DueFollowUp[]> {
  if (!layers.length) return [];
  const ids = layers.filter((l): l is string => l !== null);
  const rows = await db.memory.findMany({
    where: {
      userId, kind: "fact", archivedAt: null, dueAt: { lte: now, gt: new Date(now.getTime() - FOLLOW_UP_LAPSE_MS) },
      OR: [...(layers.includes(null) ? [{ channelId: null }] : []), ...(ids.length ? [{ channelId: { in: ids } }] : [])],
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }], take,
  });
  return rows.map((row) => ({ id: row.id, text: row.text, dueAt: row.dueAt!.toISOString() }));
}
