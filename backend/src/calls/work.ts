// M13: what the assistant is up to in a channel, for the voice (instructions' "current work" and the
// assistant_status tool): pending approval cards, tasks working / needing input, the newest reply.
import type { Db } from "../db.ts";
import { toApproval } from "../approvals/serialize.ts";
import { approvalTitle, clip, spoken } from "./text.ts";

/** Pending approvals whose card is in this channel (its chat or one of its tasks), newest first. */
export async function pendingApprovals(db: Db, userId: string, channelId: string, take = 5): Promise<{ id: string; title: string | null }[]> {
  const rows = await db.approval.findMany({ where: { userId, status: "pending" }, orderBy: { createdAt: "desc" }, take: 50 });
  if (!rows.length) return [];
  const messageIds = rows.flatMap((r) => (r.messageId ? [r.messageId] : []));
  const taskIds = rows.flatMap((r) => (r.taskId ? [r.taskId] : []));
  const [messages, tasks] = await Promise.all([
    messageIds.length ? db.message.findMany({ where: { id: { in: messageIds }, userId }, select: { id: true, channelId: true } }) : [],
    taskIds.length ? db.task.findMany({ where: { id: { in: taskIds }, userId }, select: { id: true, channelId: true } }) : [],
  ]);
  const messageChannel = new Map(messages.map((m) => [m.id, m.channelId]));
  const taskChannel = new Map(tasks.map((t) => [t.id, t.channelId]));
  const out: { id: string; title: string | null }[] = [];
  for (const row of rows) {
    const where = (row.messageId ? messageChannel.get(row.messageId) : undefined) ?? (row.taskId ? taskChannel.get(row.taskId) : undefined);
    if (where !== channelId) continue;
    let title: string | null = null;
    try {
      title = approvalTitle(toApproval(row));
    } catch {
      // an unreadable preview still counts as a card waiting
    }
    out.push({ id: row.id, title });
    if (out.length >= take) break;
  }
  return out;
}

/** Tasks of this channel that are working or need the user's input (newest first). */
export async function openTasks(db: Db, userId: string, channelId: string, take = 10) {
  return db.task.findMany({
    where: { userId, channelId, status: { in: ["working", "needs_input"] }, archivedAt: null },
    orderBy: { updatedAt: "desc" }, take, select: { id: true, title: true, status: true },
  });
}

/** The start of the assistant's newest text reply in the channel's chat (hidden call replies too). */
export async function newestReply(db: Db, userId: string, channelId: string, max: number): Promise<string | null> {
  const row = await db.message.findFirst({
    where: { userId, channelId, taskId: null, role: "assistant", kind: "text", text: { not: "" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { text: true },
  });
  const text = row ? spoken(row.text) : "";
  return text ? clip(text, max) : null;
}
