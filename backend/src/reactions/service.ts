// Reactions (L157): small badges off a bubble's bottom-left. The user reacts to messages in their
// own threads (PUT / DELETE /api/messages/:id/reactions/:emoji, by "user"); the assistant reacts only to
// the user's messages (react tool, by "assistant"). Every change re-emits the message (`message`
// event, upsert by id) with its reactions, which toMessage already serializes.
import { z } from "zod";
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { emitStored } from "../tasks/thread.ts";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

/** One emoji (a single grapheme: 👍, ❤️, ⭐, 👍🏽, a flag, a keycap), at most 16 UTF-16 units. */
export const Emoji = z
  .string()
  .min(1)
  .max(16)
  .refine((s) => [...segmenter.segment(s)].length === 1 && EMOJI.test(s), { message: "must be a single emoji" });

export type ReactionBy = "user" | "assistant";

/** M14b: the assistant reacts at most once among a thread's latest this-many messages. */
export const REACTION_SPACING = 6;
export type AssistantReaction = { status: "reacted"; message: Message } | { status: "not_allowed" } | { status: "too_soon" };

/**
 * One stored form per emoji: a single pictograph is kept in its emoji presentation, so "❤" and "❤️"
 * (U+FE0F) are the same reaction and "👍" never carries a stray U+FE0F. Sequences (skin tones,
 * flags, keycaps, ZWJ) are kept as they are.
 */
export function canonicalEmoji(emoji: string): string {
  const points = [...emoji.replace(/\uFE0F$/u, "")];
  if (points.length !== 1) return emoji;
  const base = points[0]!;
  if (/\p{Emoji_Presentation}/u.test(base)) return base;
  return /\p{Extended_Pictographic}/u.test(base) ? `${base}\uFE0F` : emoji;
}

export class ReactionService {
  constructor(private readonly deps: { db: Db; events: EventBus }) {}

  /** The user's own reaction on a message in one of their threads. */
  async set(userId: string, messageId: string, emoji: string, on: boolean): Promise<Message> {
    const row = await this.deps.db.message.findFirst({ where: { id: messageId, userId }, select: { id: true } });
    if (!row) throw new HttpError(404, "not_found", "Not found.");
    return this.write(userId, row.id, emoji, "user", on);
  }

  /**
   * The assistant's reaction: only on a user message in this channel. One reaction per message (a new emoji
   * replaces the assistant's earlier one). M14b (Codync chat/reactions.rs): reactions stay rare whatever
   * the model makes of its instructions, so the assistant may react at most once among the thread's latest
   * REACTION_SPACING messages; changing the emoji on the same message is fine.
   */
  async assistant(userId: string, channelId: string, messageId: string, emoji: string): Promise<AssistantReaction> {
    const { db } = this.deps;
    const row = await db.message.findFirst({ where: { id: messageId, userId, channelId, role: "user" }, select: { id: true, taskId: true } });
    if (!row) return { status: "not_allowed" };
    const recent = await db.message.findMany({
      where: { userId, channelId, taskId: row.taskId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: REACTION_SPACING,
      select: { id: true, reactions: { where: { by: "assistant" }, select: { id: true } } },
    });
    if (recent.some((m) => m.id !== row.id && m.reactions.length > 0)) return { status: "too_soon" };
    await db.reaction.deleteMany({ where: { messageId: row.id, by: "assistant", emoji: { not: canonicalEmoji(emoji) } } });
    return { status: "reacted", message: await this.write(userId, row.id, emoji, "assistant", true) };
  }

  private async write(userId: string, messageId: string, raw: string, by: ReactionBy, on: boolean): Promise<Message> {
    const { db, events } = this.deps;
    const emoji = canonicalEmoji(raw);
    if (on) {
      await db.reaction.upsert({
        where: { messageId_emoji_by: { messageId, emoji, by } },
        create: { messageId, emoji, by },
        update: {},
      });
    } else {
      await db.reaction.deleteMany({ where: { messageId, emoji, by } });
    }
    return emitStored(db, events, userId, messageId);
  }
}
