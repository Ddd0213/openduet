// M23 "one item, one answer" (docs/API.md "## M23"): a proactive_suggestion card, a task_suggestions
// item and an Up next row for the same thing share one suggestionId. Whichever is answered first
// (card Start / Hide, Up next Add / Hide), the others follow:
//   row added (taskId)  -> proactive_suggestion state "started" + taskId; the item gets taskId;
//   row hidden          -> proactive_suggestion state "hidden"; the item is dropped (as the card's Hide).
// A card already started keeps its state. Each card changes under `cardLock` (the lock CardActions
// uses too) and is re-read there, so a tap on it at the same moment loses nothing; each change goes
// out as a `message` event.
//
// Lock order: the card lock, then (inside it) `suggestionLock`; syncLinkedCards takes card locks
// only, so call it with no lock held.
import type { Message as MessageRow, Suggestion } from "@prisma/client";
import { ProactiveSuggestionMessage, TaskSuggestionsMessage } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { KeyedLock } from "../tasks/lock.ts";
import { storedPayload, updatePayload } from "../tasks/thread.ts";

/** Card actions per message id (tasks/cards.ts CardActions and this module). */
export const cardLock = new KeyedLock();
/** Starting or hiding an Up next row (card Start / Hide, Up next Add / Hide), per suggestion id. */
export const suggestionLock = new KeyedLock();

const CARD_KINDS = ["proactive_suggestion", "task_suggestions"];
/** How many cards one row is looked up in (a row is offered on a card or two). */
const LINKED_CARDS = 20;

/** The user's suggestion cards that name this row (newest first). */
export async function linkedCards(db: Db, userId: string, suggestionId: string): Promise<MessageRow[]> {
  const rows = await db.message.findMany({
    where: { userId, kind: { in: CARD_KINDS }, payload: { contains: `"suggestionId":${JSON.stringify(suggestionId)}` } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: LINKED_CARDS,
  });
  return rows.filter((row) => cardNames(row, suggestionId));
}

function cardNames(row: MessageRow, suggestionId: string): boolean {
  const payload = storedPayload(row.payload);
  if (row.kind === "proactive_suggestion") return payload.suggestionId === suggestionId;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items.some((item) => item !== null && typeof item === "object" && (item as Record<string, unknown>).suggestionId === suggestionId);
}

/** The card's payload once it follows the row; null = nothing to change. */
export function followRow(row: MessageRow, suggestion: Pick<Suggestion, "id" | "status" | "taskId">): Record<string, unknown> | null {
  if (row.kind === "proactive_suggestion") {
    const parsed = ProactiveSuggestionMessage.shape.payload.safeParse(storedPayload(row.payload));
    if (!parsed.success || parsed.data.suggestionId !== suggestion.id || parsed.data.state === "started") return null;
    if (suggestion.status === "added" && suggestion.taskId) return { ...parsed.data, state: "started", taskId: suggestion.taskId };
    if (suggestion.status === "hidden" && parsed.data.state === "open") return { ...parsed.data, state: "hidden" };
    return null;
  }
  if (row.kind === "task_suggestions") {
    const parsed = TaskSuggestionsMessage.shape.payload.safeParse(storedPayload(row.payload));
    if (!parsed.success) return null;
    const items = parsed.data.items;
    const mine = (i: (typeof items)[number]) => i.suggestionId === suggestion.id && !i.taskId;
    if (!items.some(mine)) return null;
    if (suggestion.status === "added" && suggestion.taskId) return { items: items.map((i) => (mine(i) ? { ...i, taskId: suggestion.taskId } : i)) };
    if (suggestion.status === "hidden") return { items: items.filter((i) => !mine(i)) };
  }
  return null;
}

/**
 * Brings every card linked to the row in line with it (except `skip`, the card just answered). Takes
 * card locks, so it is called with no lock held. Never throws: a card that can't follow is logged.
 */
export async function syncLinkedCards(deps: { db: Db; events: EventBus }, userId: string, suggestionId: string, skip?: string): Promise<void> {
  const { db, events } = deps;
  try {
    const suggestion = await db.suggestion.findFirst({ where: { id: suggestionId, userId }, select: { id: true, status: true, taskId: true } });
    if (!suggestion || suggestion.status === "open") return;
    for (const card of await linkedCards(db, userId, suggestionId)) {
      if (card.id === skip) continue;
      await cardLock.run(card.id, async () => {
        const fresh = await db.message.findFirst({ where: { id: card.id, userId } });
        const next = fresh ? followRow(fresh, suggestion) : null;
        if (fresh && next) await updatePayload(db, events, userId, fresh.id, fresh.kind as "proactive_suggestion" | "task_suggestions", next);
      });
    }
  } catch (error) {
    log.warn("suggestion cards did not follow their row", { suggestionId, error: { name: (error as Error)?.name ?? "Error" } });
  }
}

/** Hides an open row (status hidden, hiddenAt now); an added or hidden one stays as it is. True when it changed. */
export async function hideSuggestion(db: Db, userId: string, suggestionId: string, now = new Date()): Promise<boolean> {
  const { count } = await db.suggestion.updateMany({ where: { id: suggestionId, userId, status: "open" }, data: { status: "hidden", hiddenAt: now } });
  return count > 0;
}
