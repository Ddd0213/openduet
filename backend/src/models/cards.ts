// M12 model_error card buttons (contract §5), through CardActions.handle("model_error"):
// - retry (+ optional modelId = "Switch model"): only on an open card with retry: true. The same
//   turn is resubmitted (same kind, channel, task and stored user message, from the card's hidden
//   `retryOf`) as a new run; with modelId that one turn runs on that model (a usable chat model, else
//   400 field modelId). The card turns `retrying` and stays as history; a new failure posts a new card.
// - dismiss: the card turns `dismissed`.
// Anything but an open card is 409 conflict.
import type { Message as MessageRow } from "@prisma/client";
import { z } from "zod";
import type { Message } from "../contract/messages.ts";
import { ModelErrorMessage } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import type { RetryOf, RunHost } from "../runs/host.ts";
import type { Action, CardHandler } from "../tasks/cards.ts";
import { emitStored, storedPayload } from "../tasks/thread.ts";
import { invalid } from "./context.ts";
import { usableChatEntry } from "./rows.ts";

const RetryOfSchema = z.object({
  kind: z.enum(["chat", "task", "brief", "checkin", "scan", "build", "routine"]),
  channelId: z.string(), taskId: z.string().nullable(), recordTaskId: z.string().nullable(),
  messageId: z.string().nullable(), prompt: z.string().nullable(), skill: z.string().nullable(),
});

const notOpen = () => new HttpError(409, "conflict", "This card isn't open any more.");

export interface ModelErrorDeps {
  db: Db;
  events: EventBus;
  runs: Pick<RunHost, "retry">;
  /** the one-time import before a pin is checked */
  ready?: (userId: string) => Promise<void>;
}

export function modelErrorCard(deps: ModelErrorDeps): CardHandler {
  const { db, events } = deps;
  /** The new state, claimed against the stored payload (a racing tap loses with 409). */
  const claim = async (row: MessageRow, stored: Record<string, unknown>, state: "retrying" | "dismissed"): Promise<Message> => {
    const next = { ...stored, state };
    ModelErrorMessage.shape.payload.parse(next);
    const claimed = await db.message.updateMany({ where: { id: row.id, payload: row.payload }, data: { payload: JSON.stringify(next) } });
    if (claimed.count !== 1) throw notOpen();
    return emitStored(db, events, row.userId, row.id);
  };

  return async (row: MessageRow, action: Action): Promise<Message> => {
    if (action.action !== "retry" && action.action !== "dismiss") throw invalid("action", `this card has no ${action.action} action`);
    if (action.modelId !== undefined && action.action !== "retry") throw invalid("modelId", "only with retry");
    const stored = storedPayload(row.payload);
    const card = ModelErrorMessage.shape.payload.parse(stored);
    if (card.state !== "open") throw notOpen();
    if (action.action === "dismiss") return claim(row, stored, "dismissed");
    if (!card.retry) throw invalid("action", "this turn can't be retried");
    const of = RetryOfSchema.safeParse(stored.retryOf);
    if (!of.success || of.data.channelId !== row.channelId || of.data.taskId !== row.taskId) throw invalid("action", "this turn can't be retried");
    let pin: string | null = null;
    if (action.modelId !== undefined) {
      await deps.ready?.(row.userId);
      if (!(await usableChatEntry(db, row.userId, action.modelId))) throw invalid("modelId", "must be a chat model with tools whose provider has a key");
      pin = action.modelId;
    }
    await deps.runs.retry(row.userId, card.runId, of.data as RetryOf, pin);
    return claim(row, stored, "retrying");
  };
}
