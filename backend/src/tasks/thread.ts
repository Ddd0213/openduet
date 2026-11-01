// Writing to a thread outside an agent turn (card actions, task chips): the same validation and
// events as the run host's sink, for code that has no TurnSink.
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { loadMessage, payloadSchemaFor } from "../runs/serialize.ts";

export interface StoredDraft {
  userId: string;
  channelId: string;
  taskId: string | null;
  role: "user" | "assistant" | "system";
  kind: Message["kind"];
  text: string;
  /** the contract payload; text messages pass { skill, attachments: [] } (M18: and taskResult / forwarded) */
  payload: Record<string, unknown>;
  status?: "sent" | "seen";
}

/** Validates against the contract, stores the row and emits its `message` event. */
export async function postMessage(db: Db, events: EventBus, draft: StoredDraft): Promise<Message> {
  payloadSchemaFor(draft.kind).parse(draft.payload);
  // Text: attachments come from ChannelFile rows; M18 taskResult / forwarded are kept when set.
  const stored = draft.kind === "text"
    ? { skill: draft.payload.skill ?? null, ...(draft.payload.taskResult ? { taskResult: draft.payload.taskResult } : {}), ...(draft.payload.forwarded ? { forwarded: draft.payload.forwarded } : {}) }
    : draft.payload;
  const row = await db.message.create({ data: {
    userId: draft.userId, channelId: draft.channelId, taskId: draft.taskId, role: draft.role, kind: draft.kind,
    text: draft.text, payload: JSON.stringify(stored), status: draft.status ?? "sent",
  } });
  return emitStored(db, events, draft.userId, row.id);
}

/** Replaces a card's payload (validated) and emits the updated message. */
export async function updatePayload(db: Db, events: EventBus, userId: string, id: string, kind: Message["kind"], payload: Record<string, unknown>): Promise<Message> {
  payloadSchemaFor(kind).parse(payload);
  await db.message.update({ where: { id }, data: { payload: JSON.stringify(payload) } });
  return emitStored(db, events, userId, id);
}

export async function emitStored(db: Db, events: EventBus, userId: string, id: string): Promise<Message> {
  const message = await loadMessage(db, id);
  if (!message) throw new Error("stored message does not match the contract");
  await events.emit(userId, message.channelId, "message", { message });
  return message;
}

/** A card's stored payload as an object ({} when unreadable). */
export function storedPayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
