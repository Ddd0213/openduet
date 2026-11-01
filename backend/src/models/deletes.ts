// M12 deletes (contract §3): a model, or a provider with all of its models at once.
// - The default model: 409 conflict while another usable chat model exists (choose it first); the
//   user's last one is deleted and the default becomes null (not configured).
// - The utility model: utilityModelId becomes null (= the default model).
// - Channels using it: modelId and thinkingLevel become null, and each gets a system line
//   system.channel_model_removed {model} plus a `channel` event.
// The rows change in one transaction; the system lines and events come after it.
import type { Prisma } from "@prisma/client";
import { toChannel } from "../runs/serialize.ts";
import { log } from "../log.ts";
import { postMessage } from "../tasks/thread.ts";
import { conflict, notFound, type ModelsCtx } from "./context.ts";
import { keyedProviders, OWNER_KIND, usableChat } from "./rows.ts";

type Tx = Prisma.TransactionClient;
const CHOOSE_ANOTHER = "Choose another default model first.";
export const CHANNEL_MODEL_REMOVED = "system.channel_model_removed";

interface Fallen { channelId: string; label: string }

/** 409 when the default is among `ids` and a usable chat model outside them exists. */
async function guardDefault(tx: Tx, userId: string, ids: ReadonlySet<string>): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true } });
  if (!user.defaultModelId || !ids.has(user.defaultModelId)) return;
  const keyed = await keyedProviders(tx, userId);
  const others = await tx.modelEntry.findMany({ where: { userId, id: { notIn: [...ids] }, purpose: "chat", tools: true } });
  if (others.some((row) => usableChat(row, keyed))) throw conflict(CHOOSE_ANOTHER);
}

/** The default / utility pointers and the channels that used these models fall back. */
async function unlink(tx: Tx, userId: string, ids: ReadonlySet<string>, labels: ReadonlyMap<string, string>): Promise<Fallen[]> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true, utilityModelId: true } });
  const data: Prisma.UserUpdateInput = {};
  if (user.defaultModelId && ids.has(user.defaultModelId)) data.defaultModelId = null;
  if (user.utilityModelId && ids.has(user.utilityModelId)) data.utilityModelId = null;
  if (Object.keys(data).length) await tx.user.update({ where: { id: userId }, data });
  const channels = await tx.channel.findMany({ where: { userId, modelId: { in: [...ids] } }, select: { id: true, modelId: true } });
  if (channels.length) await tx.channel.updateMany({ where: { id: { in: channels.map((c) => c.id) } }, data: { modelId: null, thinkingLevel: null } });
  return channels.map((c) => ({ channelId: c.id, label: labels.get(c.modelId!) ?? "The model" }));
}

export class Deletes {
  constructor(private readonly ctx: ModelsCtx) {}

  /** DELETE /api/models/:id */
  async model(userId: string, id: string): Promise<void> {
    const { db, lock } = this.ctx;
    const fallen = await lock.run(userId, () => db.$transaction(async (tx) => {
      const row = await tx.modelEntry.findFirst({ where: { id, userId } });
      if (!row) throw notFound();
      const ids = new Set([row.id]);
      await guardDefault(tx, userId, ids);
      const out = await unlink(tx, userId, ids, new Map([[row.id, row.label]]));
      await tx.modelEntry.delete({ where: { id: row.id } });
      return out;
    }));
    await this.announce(userId, fallen);
  }

  /** DELETE /api/providers/:id: its models (the same rules at once), its vault rows, the provider. */
  async provider(userId: string, id: string): Promise<void> {
    const { db, lock, vault } = this.ctx;
    const fallen = await lock.run(userId, () => db.$transaction(async (tx) => {
      const row = await tx.modelProvider.findFirst({ where: { id, userId } });
      if (!row) throw notFound();
      const models = await tx.modelEntry.findMany({ where: { providerId: row.id }, select: { id: true, label: true } });
      const ids = new Set(models.map((m) => m.id));
      await guardDefault(tx, userId, ids);
      const out = await unlink(tx, userId, ids, new Map(models.map((m) => [m.id, m.label])));
      await tx.modelEntry.deleteMany({ where: { providerId: row.id } });
      await vault.deleteOwner(userId, OWNER_KIND, row.id, tx);
      await tx.modelProvider.delete({ where: { id: row.id } });
      return out;
    }));
    await this.announce(userId, fallen);
  }

  /** After the transaction: the system line in each channel that fell back, and its `channel` event. */
  private async announce(userId: string, fallen: readonly Fallen[]): Promise<void> {
    const { db, events } = this.ctx;
    for (const { channelId, label } of fallen) {
      try {
        await postMessage(db, events, {
          userId, channelId, taskId: null, role: "system", kind: "system", text: "",
          payload: { phrase: { key: CHANNEL_MODEL_REMOVED, params: { model: { type: "text", value: label } } } },
        });
        const channel = await db.channel.findUnique({ where: { id: channelId } });
        if (channel) await events.emit(userId, channelId, "channel", { channel: await toChannel(db, channel) });
      } catch (error) {
        log.warn("channel model fallback line failed", { channelId, error: { name: (error as Error).name } });
      }
    }
  }
}
