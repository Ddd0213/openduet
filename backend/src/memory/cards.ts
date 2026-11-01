// M11: the buttons of the memory_note chip (Undo) and the soul_proposal card (Apply / Not now),
// M22: and the soul_setup card's (Apply / Not now),
// registered with tasks.cards.handle(...) from index.ts. CardActions.act has already loaded the
// row as the caller's own (someone else's message is 404) and holds the card's lock, so a double
// tap applies once. A decided card answers as it is.
import type { Message as MessageRow } from "@prisma/client";
import type { z } from "zod";
import { UpdateSoulRequest } from "../contract/m11.ts";
import type { Message } from "../contract/messages.ts";
import { MemoryNoteMessage, SoulProposalMessage, SoulSetupMessage } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { loadMessage, toChannel } from "../runs/serialize.ts";
import type { SoulService } from "../soul/service.ts";
import type { Action } from "../tasks/cards.ts";
import { emitStored, storedPayload, updatePayload } from "../tasks/thread.ts";

const noAction = (action: string) => new HttpError(400, "validation_failed", `action: this card has no ${action} action`, "action");

async function current(db: Db, id: string): Promise<Message> {
  const message = await loadMessage(db, id);
  if (!message) throw new Error("stored card does not match the contract");
  return message;
}

/**
 * Undo on a memory_note: "remembered" archives the fact, "forgot" restores it; the chip turns
 * `undone`. Idempotent (an undone chip answers as it is). The fact must belong to the card's own
 * user and to the layer the chip names (this channel's memory, or "About you").
 */
export async function undoMemoryNote(deps: { db: Db; events: EventBus }, row: MessageRow, action: Action): Promise<Message> {
  const { db, events } = deps;
  if (action.action !== "undo") throw noAction(action.action);
  const payload = MemoryNoteMessage.shape.payload.parse(storedPayload(row.payload));
  if (payload.state === "undone") return current(db, row.id);
  const layer = payload.scope === "shared" ? null : row.channelId;
  const fact = await db.memory.findFirst({ where: { id: payload.factId, userId: row.userId, kind: "fact", channelId: layer } });
  if (fact) {
    await db.memory.update({ where: { id: fact.id }, data: { archivedAt: payload.op === "remembered" ? (fact.archivedAt ?? new Date()) : null } });
  }
  return updatePayload(db, events, row.userId, row.id, "memory_note", { ...payload, state: "undone" });
}

/**
 * Apply / Not now on a soul_proposal. Apply writes `proposed` into the soul field (creating the
 * soul row when there is none), or into the card's channel's soulExtra; Not now leaves it.
 */
export async function actOnSoulProposal(deps: { db: Db; events: EventBus; soul: SoulService }, row: MessageRow, action: Action): Promise<Message> {
  const { db, events, soul } = deps;
  if (action.action !== "apply" && action.action !== "dismiss") throw noAction(action.action);
  const payload = SoulProposalMessage.shape.payload.parse(storedPayload(row.payload));
  if (payload.state !== "open") return current(db, row.id);
  if (action.action === "dismiss") return updatePayload(db, events, row.userId, row.id, "soul_proposal", { ...payload, state: "dismissed" });

  if (payload.field === "soulExtra") {
    const channel = await db.channel.findFirst({ where: { id: row.channelId, userId: row.userId } });
    if (!channel || channel.isMain) throw new HttpError(400, "validation_failed", "field: soulExtra applies to a channel, not the main thread", "field");
    const updated = await db.channel.update({ where: { id: channel.id }, data: { soulExtra: payload.proposed.trim() } });
    await events.emit(row.userId, channel.id, "channel", { channel: await toChannel(db, updated) });
  } else {
    const input = UpdateSoulRequest.safeParse({ [payload.field]: payload.proposed });
    if (!input.success) throw new HttpError(400, "validation_failed", `${payload.field}: ${input.error.issues[0]?.message ?? "invalid"}`, payload.field);
    await soul.update(row.userId, input.data);
  }
  return updatePayload(db, events, row.userId, row.id, "soul_proposal", { ...payload, state: "applied" });
}

/**
 * M22: Apply / Not now on a soul_setup card. Apply writes every field at once, checked like
 * PUT /api/soul; Not now changes nothing. The card is claimed (open → applied / dismissed) only if
 * its stored payload is still the one read, in the same transaction as the soul write, so a newer
 * card superseding it (memory/provider.ts) and an Apply never both win. A decided card answers as it is.
 */
export async function actOnSoulSetup(deps: { db: Db; events: EventBus; soul: SoulService }, row: MessageRow, action: Action): Promise<Message> {
  const { db, events, soul } = deps;
  if (action.action !== "apply" && action.action !== "dismiss") throw noAction(action.action);
  const payload = SoulSetupMessage.shape.payload.parse(storedPayload(row.payload));
  if (payload.state !== "open") return current(db, row.id);
  let input: z.infer<typeof UpdateSoulRequest> | null = null;
  if (action.action === "apply") {
    const checked = UpdateSoulRequest.safeParse(Object.fromEntries(payload.fields.map((f) => [f.field, f.proposed])));
    if (!checked.success) {
      const field = String(checked.error.issues[0]?.path[0] ?? "fields");
      throw new HttpError(400, "validation_failed", `${field}: ${checked.error.issues[0]?.message ?? "invalid"}`, field);
    }
    input = checked.data;
  }
  const next = { ...payload, state: action.action === "apply" ? ("applied" as const) : ("dismissed" as const) };
  const won = await db.$transaction(async (tx) => {
    const claimed = await tx.message.updateMany({ where: { id: row.id, payload: row.payload }, data: { payload: JSON.stringify(next) } });
    if (claimed.count !== 1) return false;
    if (input) await soul.update(row.userId, input, tx);
    return true;
  });
  if (!won) return current(db, row.id);
  return emitStored(db, events, row.userId, row.id);
}
