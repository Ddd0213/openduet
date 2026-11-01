// Card buttons (POST /api/messages/:id/action, L103-L104): Start / Hide on task suggestion and
// proactive suggestion cards, Done on a plate row. Each card is handled under a lock, so a
// double tap starts one task. Other modules add their cards with handle() (M6: skill_proposal ->
// Save skill / Not now, see src/skills/).
// M23 (one item, one answer): a suggestion card or item with a suggestionId answers for its Up next
// row too. Start makes the task once per row (a row already added returns its task, wherever it was
// started), marks the row added and points it at the task; Hide hides the row (hiddenAt). The other
// cards of the same row then follow (suggestions/cards.ts), each with a `message` event.
import type { Message as MessageRow, Suggestion as SuggestionRow } from "@prisma/client";
import { z } from "zod";
import type { Message } from "../contract/messages.ts";
import { CardMessage, FormMessage, MessageActionRequest, PlateMessage, ProactiveSuggestionMessage, TaskSuggestionsMessage } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { loadMessage } from "../runs/serialize.ts";
import { cardLock, hideSuggestion, suggestionLock, syncLinkedCards } from "../suggestions/cards.ts";
import type { TaskService } from "./service.ts";
import { emitStored, postMessage, storedPayload, updatePayload } from "./thread.ts";

export type Action = z.output<typeof MessageActionRequest>;
/** A module's card: gets the user's own row (already locked) and answers the updated card. */
export type CardHandler = (row: MessageRow, action: Action) => Promise<Message>;

const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);

/** A suggestion card's answer: the updated card, and the Up next row it changed (its other cards follow). */
type Answer = { message: Message; linked: string | null };

export class CardActions {
  private readonly handlers = new Map<string, CardHandler>();

  constructor(private readonly deps: { db: Db; events: EventBus; tasks: TaskService }) {
    this.handle("card", (row, action) => this.checklist(row, action));
  }

  /** Registers the buttons of another module's card kind (e.g. skill_proposal). */
  handle(kind: Message["kind"], handler: CardHandler): void {
    this.handlers.set(kind, handler);
  }

  /** The updated card. Someone else's message is 404; an action the card doesn't have is 400. */
  async act(userId: string, messageId: string, action: Action): Promise<Message> {
    // M23: the lock is shared with suggestions/cards.ts, which updates linked cards from Up next.
    const answer = await cardLock.run(messageId, async (): Promise<Answer> => {
      const row = await this.deps.db.message.findFirst({ where: { id: messageId, userId } });
      if (!row) throw new HttpError(404, "not_found", "Not found.");
      switch (row.kind) {
        case "task_suggestions": return this.suggestions(row, action);
        case "proactive_suggestion": return this.proactive(row, action);
        case "plate": return { message: await this.plate(row, action), linked: null };
        case "form": return { message: await this.form(row, action), linked: null };
        default: {
          const handler = this.handlers.get(row.kind);
          if (handler) return { message: await handler(row, action), linked: null };
          throw invalid("action", `this card has no ${action.action} action`);
        }
      }
    });
    // Outside the card's lock: the row's other cards (and a twin item on this one) follow.
    if (!answer.linked) return answer.message;
    await syncLinkedCards(this.deps, userId, answer.linked);
    return this.current(messageId);
  }

  /** The user's linked Up next row (null when the card has none or it's gone). */
  private linkedRow(userId: string, suggestionId: string | null): Promise<SuggestionRow | null> {
    return suggestionId ? this.deps.db.suggestion.findFirst({ where: { id: suggestionId, userId } }) : Promise.resolve(null);
  }

  /** The task a linked row already made (Up next Add or another card's Start), if it still exists. */
  private async startedTask(userId: string, suggestionId: string) {
    const row = await this.deps.db.suggestion.findFirst({ where: { id: suggestionId, userId }, select: { taskId: true } });
    return row?.taskId ? this.deps.tasks.own(userId, row.taskId) : null;
  }

  /** Start sends the item's prompt as the user and starts the task under it; Hide drops the item. */
  private async suggestions(row: MessageRow, action: Action): Promise<Answer> {
    const { db, events, tasks } = this.deps;
    if (action.action !== "start" && action.action !== "hide") throw invalid("action", `this card has no ${action.action} action`);
    const payload = TaskSuggestionsMessage.shape.payload.parse(storedPayload(row.payload));
    const item = payload.items.find((i) => i.id === action.itemId);
    if (!action.itemId || !item) throw invalid("itemId", "unknown item");
    const linked = (await this.linkedRow(row.userId, item.suggestionId))?.id ?? null;
    if (action.action === "hide") {
      const hid = linked && !item.taskId ? await suggestionLock.run(linked, () => hideSuggestion(db, row.userId, linked)) : false;
      const message = await updatePayload(db, events, row.userId, row.id, "task_suggestions", { items: payload.items.filter((i) => i.id !== item.id) });
      return { message, linked: hid ? linked : null };
    }
    if (item.taskId) return { message: await this.current(row.id), linked: null };
    const start = async () => {
      // A row already added (from Up next, or another card) keeps its one task: no second one.
      const existing = linked ? await this.startedTask(row.userId, linked) : null;
      if (existing) return existing;
      // Tapping sends the prompt (L103): it shows as the user's message, with the chip under it.
      const sent = await postMessage(db, events, {
        userId: row.userId, channelId: row.channelId, taskId: null, role: "user", kind: "text",
        text: item.prompt, payload: { skill: null, attachments: [] }, status: "seen",
      });
      const task = await tasks.create({
        userId: row.userId, channelId: row.channelId, title: item.title, prompt: item.prompt, sourceApp: item.app,
        spawn: { channelId: row.channelId, anchorMessageId: sent.id },
      });
      if (linked) await db.suggestion.updateMany({ where: { id: linked, userId: row.userId }, data: { status: "added", taskId: task.id } });
      return task;
    };
    const task = linked ? await suggestionLock.run(linked, start) : await start();
    const items = payload.items.map((i) => (i.id === item.id ? { ...i, taskId: task.id } : i));
    return { message: await updatePayload(db, events, row.userId, row.id, "task_suggestions", { items }), linked };
  }

  /** Start: a proactive task from the card (it collapses to "◯ <title> See all tasks ›"); Hide. */
  private async proactive(row: MessageRow, action: Action): Promise<Answer> {
    const { db, events, tasks } = this.deps;
    if (action.action !== "start" && action.action !== "hide") throw invalid("action", `this card has no ${action.action} action`);
    const payload = ProactiveSuggestionMessage.shape.payload.parse(storedPayload(row.payload));
    if (payload.state === "started") return { message: await this.current(row.id), linked: null };
    const suggestion = await this.linkedRow(row.userId, payload.suggestionId);
    const linked = suggestion?.id ?? null;
    if (action.action === "hide") {
      if (payload.state === "hidden") return { message: await this.current(row.id), linked: null };
      if (linked) {
        // Already started from Up next: the card shows that task instead of hiding.
        const existing = await suggestionLock.run(linked, async () => (await hideSuggestion(db, row.userId, linked)) ? null : this.startedTask(row.userId, linked));
        if (existing) return { message: await updatePayload(db, events, row.userId, row.id, "proactive_suggestion", { ...payload, state: "started", taskId: existing.id }), linked: null };
      }
      return { message: await updatePayload(db, events, row.userId, row.id, "proactive_suggestion", { ...payload, state: "hidden" }), linked };
    }
    const start = async () => {
      const existing = linked ? await this.startedTask(row.userId, linked) : null;
      if (existing) return existing;
      const task = await tasks.create({
        userId: row.userId, channelId: row.channelId, title: payload.title, prompt: payload.prompt,
        description: payload.body, source: "proactive", noticedAt: row.createdAt, ...(suggestion?.app ? { sourceApp: suggestion.app } : {}),
      });
      if (linked) await db.suggestion.updateMany({ where: { id: linked, userId: row.userId }, data: { status: "added", taskId: task.id } });
      return task;
    };
    const task = linked ? await suggestionLock.run(linked, start) : await start();
    return { message: await updatePayload(db, events, row.userId, row.id, "proactive_suggestion", { ...payload, state: "started", taskId: task.id }), linked };
  }

  /** A tap that changes nothing (already started, hidden or done) answers the card as it is. */
  private async current(id: string): Promise<Message> {
    const message = await loadMessage(this.deps.db, id);
    if (!message) throw new Error("stored card does not match the contract");
    return message;
  }

  /**
   * Skip on a form card (M9): an open form turns "dismissed"; no turn runs and nothing is posted.
   * Skipping it again answers it as it is; a submitted form is 409 stale_version. The update is
   * claimed against the stored payload, so a submit racing the Skip leaves exactly one winner.
   */
  private async form(row: MessageRow, action: Action): Promise<Message> {
    const { db, events } = this.deps;
    if (action.action !== "dismiss") throw invalid("action", `this card has no ${action.action} action`);
    const payload = FormMessage.shape.payload.parse(storedPayload(row.payload));
    if (payload.state === "dismissed") return this.current(row.id);
    if (payload.state !== "open") throw new HttpError(409, "stale_version", "form: this form isn't open any more", "form");
    const next = { ...payload, state: "dismissed" as const };
    FormMessage.shape.payload.parse(next);
    const claimed = await db.message.updateMany({ where: { id: row.id, payload: row.payload }, data: { payload: JSON.stringify(next) } });
    if (claimed.count !== 1) throw new HttpError(409, "stale_version", "form: this form isn't open any more", "form");
    const message = await emitStored(db, events, row.userId, row.id);
    // M22: a skipped form of a task no longer waits on the user (its nextStep moves on).
    if (row.taskId) await this.deps.tasks.refresh(row.taskId);
    return message;
  }

  /** M24: set a checklist item's state under the card lock; never start a turn or wake its task. */
  private async checklist(row: MessageRow, action: Action): Promise<Message> {
    const { db, events } = this.deps;
    if (action.action !== "check" && action.action !== "uncheck") throw invalid("action", `this card has no ${action.action} action`);
    const payload = CardMessage.shape.payload.parse(storedPayload(row.payload));
    const item = action.itemId && payload.blocks.flatMap((block) => block.type === "checklist" ? block.items : []).find((item) => item.id === action.itemId);
    if (!item) throw new HttpError(404, "not_found", "Not found.", "itemId");
    const done = action.action === "check";
    // A retry still sends the current message to the app, without rewriting the stored card.
    if (item.done === done) return emitStored(db, events, row.userId, row.id);
    item.done = done;
    return updatePayload(db, events, row.userId, row.id, "card", payload);
  }

  /** Done on a "Your plate today" row. */
  private async plate(row: MessageRow, action: Action): Promise<Message> {
    const { db, events } = this.deps;
    if (action.action !== "done") throw invalid("action", `this card has no ${action.action} action`);
    const payload = PlateMessage.shape.payload.parse(storedPayload(row.payload));
    const item = payload.items.find((i) => i.id === action.itemId);
    if (!action.itemId || !item) throw invalid("itemId", "unknown item");
    if (item.done) return this.current(row.id);
    return updatePayload(db, events, row.userId, row.id, "plate", { items: payload.items.map((i) => (i.id === item.id ? { ...i, done: true } : i)) });
  }
}
