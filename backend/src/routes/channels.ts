// Channel list, create (with the assistant's greeting), edit, read marker and the paged thread
// (docs/API.md). Someone else's channel is always 404.
import type { Context, Handler } from "hono";
import { z } from "zod";
import { AccessService } from "../access/service.ts";
import type { AppEnv } from "../app.ts";
import { channelHooks } from "../channels/hooks.ts";
import { queueGreeting } from "../channels/greet.ts";
import { ChannelList, CreateChannelRequest, MarkReadRequest, UpdateChannelRequest } from "../contract/channels.ts";
import { Id } from "../contract/common.ts";
import { MessagePage, StopResponse } from "../contract/messages.ts";
import { toSummary as toArtifactSummary } from "../artifacts/serialize.ts";
import { HttpError, readJson } from "../http.ts";
import { log } from "../log.ts";
import { modelHooks } from "../models/hooks.ts";
import { usableChatEntry } from "../models/rows.ts";
import { activeRunOf, toChannel, toMessages } from "../runs/serialize.ts";

export async function ownChannel(c: Context<AppEnv>) {
  const { db } = c.get("deps");
  // Guard explicitly: Prisma treats `id: undefined` as "any id".
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  const row = await db.channel.findFirst({ where: { id, userId: c.get("user").id } });
  if (!row) throw new HttpError(404, "not_found", "Not found.");
  return row;
}

export const listChannels: Handler<AppEnv> = async (c) => {
  const { db } = c.get("deps");
  const archived = c.req.query("archived") === "true";
  const rows = await db.channel.findMany({ where: { userId: c.get("user").id, archived }, orderBy: [{ isMain: "desc" }, { createdAt: "asc" }] });
  return c.json(ChannelList.parse({ channels: await Promise.all(rows.map((row) => toChannel(db, row))) }));
};

/**
 * POST /api/channels (L125, M11): the channel, the skills / connectors / apps it starts with
 * (`access`: unknown or foreign refs are 400 field access; each becomes an enabled ChannelAccess
 * row) and, with `greet` (default), the assistant's greeting as a background chat turn in the user's
 * language (channels/greet.ts). Names aren't deduplicated, same as PATCH.
 */
export const createChannel: Handler<AppEnv> = async (c) => {
  const input = await readJson(c, CreateChannelRequest);
  const { db, events, runs } = c.get("deps");
  const user = c.get("user");
  const refs = [...new Map(input.access.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
  if (refs.length) {
    const bad = await new AccessService(db).invalid(user.id, refs, channelHooks(db).appKnown);
    if (bad.length) throw new HttpError(400, "validation_failed", `access: unknown ${bad[0]!.kind} ${bad[0]!.id}`, "access");
  }
  const row = await db.$transaction(async (tx) => {
    const created = await tx.channel.create({ data: { userId: user.id, isMain: false, name: input.name, icon: input.icon, colorHex: input.colorHex, purpose: input.purpose } });
    if (refs.length) {
      await tx.channelAccess.createMany({ data: refs.map((ref) => ({ userId: user.id, channelId: created.id, kind: ref.kind, refId: ref.id, enabled: true })) });
    }
    return created;
  });
  const channel = await toChannel(db, row);
  await events.emit(user.id, row.id, "channel", { channel });
  if (input.greet) {
    try {
      await queueGreeting({ db, runs }, { userId: user.id, channelId: row.id, name: row.name, purpose: row.purpose, language: user.language });
    } catch (error) {
      // The channel exists either way; a greeting that couldn't be queued is only logged.
      log.warn("channel greeting not queued", { channelId: row.id, error: { name: (error as Error)?.name ?? "Error" } });
    }
  }
  return c.json(channel);
};

export const updateChannel: Handler<AppEnv> = async (c) => {
  const row = await ownChannel(c);
  const input = await readJson(c, UpdateChannelRequest);
  // The main thread has no name and can't be archived.
  if (row.isMain && (input.name !== undefined || input.archived === true)) {
    const field = input.name !== undefined ? "name" : "archived";
    throw new HttpError(400, "validation_failed", `${field}: the main thread can't be renamed or archived`, field);
  }
  // M11: the soul addendum and the "About you" switch are per channel; the main thread is the soul itself.
  if (row.isMain && (input.soulExtra !== undefined || input.useSharedMemory !== undefined)) {
    const field = input.soulExtra !== undefined ? "soulExtra" : "useSharedMemory";
    throw new HttpError(400, "validation_failed", `${field}: not on the main thread`, field);
  }
  // M12: a channel's own model and thinking level; the main thread always uses the defaults.
  if (row.isMain && (input.modelId !== undefined || input.thinkingLevel !== undefined)) {
    const field = input.modelId !== undefined ? "modelId" : "thinkingLevel";
    throw new HttpError(400, "validation_failed", `${field}: not on the main thread`, field);
  }
  const { db, events } = c.get("deps");
  if (input.modelId) {
    await modelHooks(db)?.ready(row.userId);
    if (!(await usableChatEntry(db, row.userId, input.modelId))) {
      throw new HttpError(400, "validation_failed", "modelId: must be a chat model with tools whose provider has a key", "modelId");
    }
  }
  const channel = await toChannel(db, await db.channel.update({ where: { id: row.id }, data: input }));
  await events.emit(row.userId, row.id, "channel", { channel });
  return c.json(channel);
};

/**
 * DELETE /api/channels/:id (M9, contract §4) -> 204; the main thread is 400. Cancels a queued or
 * running turn of the channel (its chat, tasks, builds, routines), moves its Make artifacts to the
 * main thread (an artifact event each), then hard-deletes the channel with its messages, tasks,
 * approvals, suggestions, reminders, spend requests and files (rows and bytes), and emits
 * channel_deleted (envelope channelId = the deleted channel). Run rows stay (usage history).
 * M11: its own memory (facts, document, dreaming passes) and its access rows go with it.
 */
export const deleteChannel: Handler<AppEnv> = async (c) => {
  const row = await ownChannel(c);
  if (row.isMain) throw new HttpError(400, "validation_failed", "id: the main thread can't be deleted", "id");
  const { db, events, runs, files } = c.get("deps");
  const userId = row.userId;
  await runs.cancel({ userId, channelId: row.id });
  const main = await db.channel.findFirstOrThrow({ where: { userId, isMain: true }, select: { id: true } });
  const [tasks, messages, stored, artifacts] = await Promise.all([
    db.task.findMany({ where: { userId, channelId: row.id }, select: { id: true } }),
    db.message.findMany({ where: { userId, channelId: row.id }, select: { id: true } }),
    db.channelFile.findMany({ where: { userId, channelId: row.id }, select: { id: true, path: true } }),
    db.artifact.findMany({ where: { userId, channelId: row.id }, select: { id: true } }),
  ]);
  const taskIds = tasks.map((t) => t.id);
  const messageIds = messages.map((m) => m.id);
  await db.$transaction([
    db.artifact.updateMany({ where: { userId, channelId: row.id }, data: { channelId: main.id } }),
    db.approval.deleteMany({ where: { userId, OR: [{ taskId: { in: taskIds } }, { messageId: { in: messageIds } }] } }),
    db.suggestion.deleteMany({ where: { userId, OR: [{ channelId: row.id }, { taskId: { in: taskIds } }] } }),
    db.reminder.deleteMany({ where: { userId, channelId: row.id } }),
    db.spendRequest.deleteMany({ where: { userId, channelId: row.id } }),
    db.channelFile.deleteMany({ where: { userId, channelId: row.id } }),
    db.memory.deleteMany({ where: { userId, channelId: row.id } }),
    db.memoryCuration.deleteMany({ where: { userId, channelId: row.id } }),
    db.channelAccess.deleteMany({ where: { userId, channelId: row.id } }),
    // Messages and tasks go with the channel (cascade).
    db.channel.deleteMany({ where: { id: row.id, userId } }),
  ]);
  for (const file of stored) {
    try {
      await files.remove(file.path);
    } catch (error) {
      log.warn("channel file bytes could not be removed", { fileId: file.id, error: { name: (error as Error).name } });
    }
  }
  for (const { id } of artifacts) {
    const artifact = await db.artifact.findUnique({ where: { id } });
    if (artifact) await events.emit(userId, main.id, "artifact", { artifact: toArtifactSummary(artifact), buildStatus: null });
  }
  for (const id of taskIds) await events.emit(userId, row.id, "task_deleted", { taskId: id });
  await events.emit(userId, row.id, "channel_deleted", { channelId: row.id });
  return c.body(null, 204);
};

/**
 * POST /api/channels/:id/stop (M10, contract §1) -> StopResponse. Stops the current turn of the
 * channel's own chat (kind chat, taskId null; the running one, else the first queued); its tasks,
 * builds and routines are left alone, and messages queued behind it still run. 409 conflict when
 * nothing is running or queued there; someone else's channel 404.
 */
export const stopChannel: Handler<AppEnv> = async (c) => {
  const row = await ownChannel(c);
  const stopped = await c.get("deps").runs.stop({ userId: row.userId, channelId: row.id });
  if (stopped === 0) throw new HttpError(409, "conflict", "Nothing is running in this channel.");
  return c.json(StopResponse.parse({ stopped }));
};

/**
 * POST /api/channels/:id/read. M21: with `messageId` the marker is that message's own createdAt
 * (a time the app re-encodes can lose its last millisecond, and the newest line then stayed
 * unread forever); `at` alone (older apps) gets 1 ms of tolerance for the same reason.
 */
export const markRead: Handler<AppEnv> = async (c) => {
  const row = await ownChannel(c);
  const input = await readJson(c, MarkReadRequest);
  const { db, events } = c.get("deps");
  let read: number;
  if (input.messageId) {
    const message = await db.message.findFirst({ where: { id: input.messageId, channelId: row.id, taskId: null }, select: { createdAt: true } });
    if (!message) throw new HttpError(400, "validation_failed", "messageId: unknown message", "messageId");
    read = message.createdAt.getTime();
  } else {
    read = new Date(input.at!).getTime() + 1;
  }
  const at = new Date(Math.min(read, Date.now()));
  // The marker only moves forward, so an older device can't bring back read badges.
  if (!row.lastReadAt || at > row.lastReadAt) {
    const channel = await toChannel(db, await db.channel.update({ where: { id: row.id }, data: { lastReadAt: at } }));
    await events.emit(row.userId, row.id, "channel", { channel });
  }
  return c.body(null, 204);
};

const PageQuery = z.object({
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listMessages: Handler<AppEnv> = async (c) => {
  const row = await ownChannel(c);
  const query = PageQuery.safeParse({ before: c.req.query("before"), limit: c.req.query("limit") });
  if (!query.success) {
    const field = query.error.issues[0]?.path.join(".") ?? "query";
    throw new HttpError(400, "validation_failed", `${field}: invalid`, field);
  }
  const { db, runs } = c.get("deps");
  const { before, limit } = query.data;
  let cursor = {};
  if (before) {
    const anchor = await db.message.findFirst({ where: { id: before, channelId: row.id, taskId: null } });
    if (!anchor) throw new HttpError(400, "validation_failed", "before: unknown message", "before");
    cursor = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] };
  }
  if (!before && (await db.message.count({ where: { userId: row.userId, kind: "usage_limit" } })) > 0) {
    // Opening a thread after the limit passed shows the old lines as "Usage limit lifted" (L166).
    await runs.liftIfAvailable(row.userId);
  }
  // M15: a voice call's hand-offs and the assistant's replies in those turns (callId set) are listed too.
  const rows = await db.message.findMany({
    where: { channelId: row.id, taskId: null, ...cursor },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  // M21: the turn running (or queued first) in this thread, so a cold start shows typing and Stop again.
  const [messages, activeRun] = await Promise.all([toMessages(db, page), activeRunOf(db, row.id)]);
  return c.json(MessagePage.parse({ messages, hasMore, activeRun }));
};
