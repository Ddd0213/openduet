// M22 (#22): everything waiting on the user, in one list (GET /api/needs-you, the Tasks tab badge
// and the show_tasks card's "Needs you" group all use needsYou(), so the numbers agree).
//   - Tasks whose nextStep is set (TaskService derives it; not archived, not resolved, not a
//     routine). Their own questions, approvals, sign-ins and connection cards count once, as the task.
//   - Cards outside any task (Message.taskId null) in the main thread and the channels: a pending,
//     unexpired approval or spend request, an open form, a pending sign-in, an open connection
//     request. Read the way the cards' own code reads them: the Approval row's status, the payload's
//     `state` for the rest. Cards of a voice call (callId) aren't in the chat, so they don't count.
// Newest first (a task by updatedAt, a card by createdAt); count = items.length.
import type { z } from "zod";
import { approvalSummary } from "../tasks/next-step.ts";
export { approvalSummary } from "../tasks/next-step.ts";
import type { Phrase } from "../contract/common.ts";
import { NeedsYou, NeedsYouItem, type TaskSummary } from "../contract/tasks.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { clipLine } from "../tasks/notices.ts";
import { toTaskSummary } from "../tasks/serialize.ts";
import { storedPayload } from "../tasks/thread.ts";

type Item = z.infer<typeof NeedsYouItem>;
type CardKind = Exclude<Item["kind"], "task">;

/** A card's title on its row (the form's title, the site, the app, the approval's summary). */
const TITLE_MAX = 120;
/** Cards of these kinds are scanned (newest first); old closed cards are filtered out in the query. */
const CARD_SCAN = 200;

export interface NeedsYouOptions {
  /** only this channel's tasks and cards (show_tasks in a channel); default: everything */
  channelId?: string | null;
  now?: Date;
}

const text = (value: string) => ({ type: "text" as const, value });
const phrase = (key: string, params: Record<string, string>): Phrase => ({ key, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, text(v)])) });
const cardRoute = (channelId: string, messageId: string) => `duet://channels/${channelId}?message=${messageId}`;


/** Everything waiting on the user, newest first. */
export async function needsYou(db: Db, userId: string, options: NeedsYouOptions = {}): Promise<NeedsYou> {
  const now = options.now ?? new Date();
  const scope = options.channelId ? { channelId: options.channelId } : {};
  const [tasks, cards] = await Promise.all([waitingTasks(db, userId, scope), openCards(db, userId, scope, now)]);
  const dated: { at: number; id: string; item: Item }[] = [
    ...tasks.map((task) => ({ at: Date.parse(task.updatedAt), id: task.id, item: { kind: "task" as const, task } })),
    ...cards.map((card) => ({ at: Date.parse(card.at), id: card.messageId, item: card })),
  ];
  dated.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const items = dated.flatMap(({ item }) => {
    const parsed = NeedsYouItem.safeParse(item);
    if (!parsed.success) log.warn("needs-you item does not match the contract", { kind: item.kind });
    return parsed.success ? [parsed.data] : [];
  });
  return NeedsYou.parse({ count: items.length, items });
}

/** Tasks with a nextStep (TaskService keeps it null for routines, archived and resolved tasks). */
async function waitingTasks(db: Db, userId: string, scope: { channelId?: string }): Promise<TaskSummary[]> {
  const rows = await db.task.findMany({
    where: { userId, ...scope, archivedAt: null, routine: false, status: { not: "resolved" }, nextStep: { not: null } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return rows.flatMap((row) => {
    const summary = toTaskSummary(row);
    return summary?.nextStep ? [summary] : [];
  });
}

type CardItem = Extract<Item, { kind: CardKind }>;

/** The open cards outside any task: approvals (by their Approval row) and forms, sign-ins and connection requests (by payload state). */
async function openCards(db: Db, userId: string, scope: { channelId?: string }, now: Date): Promise<CardItem[]> {
  const outside = { userId, ...scope, taskId: null, callId: null };
  const [messages, approvals] = await Promise.all([
    db.message.findMany({
      where: {
        ...outside, role: "assistant",
        // A cheap pre-filter on the stored JSON; the exact state is checked below.
        OR: [
          { kind: "form", payload: { contains: "\"state\":\"open\"" } },
          { kind: "sign_in", payload: { contains: "\"state\":\"pending\"" } },
          { kind: "connection_request", payload: { contains: "\"state\":\"open\"" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: CARD_SCAN,
      select: { id: true, channelId: true, kind: true, payload: true, createdAt: true },
    }),
    db.approval.findMany({
      where: { userId, status: "pending", messageId: { not: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: CARD_SCAN,
      select: { messageId: true, preview: true, toolSlug: true },
    }),
  ]);
  const items: CardItem[] = [];
  for (const card of messages) {
    const payload = storedPayload(card.payload);
    const str = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
    const base = { messageId: card.id, channelId: card.channelId, route: cardRoute(card.channelId, card.id), at: card.createdAt.toISOString() };
    if (card.kind === "form" && payload.state === "open" && str("title")) {
      const title = clipLine(str("title"), TITLE_MAX);
      items.push({ kind: "form", ...base, title, detail: phrase("task.next.form", { title }) });
    } else if (card.kind === "sign_in" && payload.state === "pending" && str("domain")) {
      const site = clipLine(str("domain"), TITLE_MAX);
      items.push({ kind: "sign_in", ...base, title: site, detail: phrase("task.next.sign_in", { site }) });
    } else if (card.kind === "connection_request" && payload.state === "open" && str("name")) {
      const app = clipLine(str("name"), TITLE_MAX);
      items.push({ kind: "connection", ...base, title: app, detail: phrase("task.next.connect", { app }) });
    }
  }
  // An approval counts where its card is: outside any task, in scope, in the chat (not a call).
  const ids = approvals.flatMap((a) => (a.messageId ? [a.messageId] : []));
  const holders = ids.length
    ? await db.message.findMany({ where: { id: { in: ids }, ...outside }, select: { id: true, channelId: true, createdAt: true } })
    : [];
  const byId = new Map(holders.map((m) => [m.id, m]));
  for (const approval of approvals) {
    const card = approval.messageId ? byId.get(approval.messageId) : undefined;
    if (!card) continue;
    const summary = approvalSummary(approval.preview, approval.toolSlug);
    items.push({
      kind: "approval", messageId: card.id, channelId: card.channelId, title: summary, detail: phrase("task.next.approve", { summary }),
      route: cardRoute(card.channelId, card.id), at: card.createdAt.toISOString(),
    });
  }
  return items;
}
