// M12 models (contract §2-§3): adding one by id or a batch from the remote list (the numbers copied
// from models.dev or the defaults), PATCH (only the given fields; their names go into `edited`), the
// defaults (PUT /api/model-defaults) and the auto default (the first usable chat model added
// becomes the default while there is none).
import type { ModelEntry as EntryRow, ModelProvider as ProviderRow, Prisma } from "@prisma/client";
import type { z } from "zod";
import type { CreateModelEntriesRequest, CreateModelEntryRequest, ModelEntry, UpdateModelDefaultsRequest, UpdateModelEntryRequest } from "../contract/m12.ts";
import { ladder } from "../llm/index.ts";
import type { Enriched } from "./catalog.ts";
import { conflict, invalid, isUniqueViolation, notFound, type ModelsCtx } from "./context.ts";
import { presetOf } from "./presets.ts";
import { editedOf, keyedProviders, toEntry, usableChat } from "./rows.ts";

type Tx = Prisma.TransactionClient;
type AddInput = z.infer<typeof CreateModelEntryRequest>;
type BatchInput = z.infer<typeof CreateModelEntriesRequest>;
type PatchInput = z.infer<typeof UpdateModelEntryRequest>;
type DefaultsInput = z.infer<typeof UpdateModelDefaultsRequest>;

const duplicate = () => conflict("This provider already has that model.");

/** The row a new model gets from its enriched numbers. */
function entryData(userId: string, provider: ProviderRow, modelId: string, e: Enriched, extra: { label?: string; purpose?: "chat" | "realtime" } = {}) {
  return {
    userId, providerId: provider.id, modelId,
    purpose: extra.purpose ?? (e.realtime ? "realtime" : "chat"),
    label: extra.label ?? e.label, contextWindow: e.contextWindow, maxOutputTokens: e.maxOutputTokens,
    thinkingLevels: JSON.stringify(e.thinkingLevels), thinkingFormat: e.thinkingLevels.length ? e.thinkingFormat : "none",
    tools: e.tools, vision: e.vision, serverWebTools: false, promptCaching: presetOf(provider.kind)?.promptCaching ?? false,
    source: e.source, edited: JSON.stringify(extra.label !== undefined ? ["label"] : []),
  };
}

/**
 * The auto default (contract §3): while the user has no usable default, the first usable chat model
 * of `added` (in the order given) becomes it. Runs inside the change's transaction.
 */
export async function autoDefault(tx: Tx, userId: string, added: readonly EntryRow[]): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true } });
  const keyed = await keyedProviders(tx, userId);
  if (user.defaultModelId) {
    const current = await tx.modelEntry.findFirst({ where: { id: user.defaultModelId, userId } });
    if (current && usableChat(current, keyed)) return;
  }
  const first = added.find((row) => usableChat(row, keyed));
  if (first) await tx.user.update({ where: { id: userId }, data: { defaultModelId: first.id } });
}

export class Entries {
  constructor(private readonly ctx: ModelsCtx) {}

  /** A provider named in a body: someone else's (or none) is 400 field providerId. */
  private async provider(userId: string, id: string): Promise<ProviderRow> {
    const row = await this.ctx.db.modelProvider.findFirst({ where: { id, userId } });
    if (!row) throw invalid("providerId", "not one of your providers");
    return row;
  }

  private enrich(provider: ProviderRow, ids: readonly string[]) {
    return this.ctx.catalog.enrich(ids.map((id) => ({ id })), presetOf(provider.kind)?.catalogKey ?? null, provider.protocol === "anthropic" ? "anthropic" : "openai");
  }

  /** POST /api/models: 409 when the provider has that modelId already. */
  async add(userId: string, input: AddInput): Promise<ModelEntry> {
    const provider = await this.provider(userId, input.providerId);
    const enriched = (await this.enrich(provider, [input.modelId])).get(input.modelId)!;
    try {
      const row = await this.ctx.lock.run(userId, () => this.ctx.db.$transaction(async (tx) => {
        if (!(await tx.modelProvider.findFirst({ where: { id: provider.id, userId }, select: { id: true } }))) throw invalid("providerId", "not one of your providers");
        if (await tx.modelEntry.findFirst({ where: { providerId: provider.id, modelId: input.modelId }, select: { id: true } })) throw duplicate();
        const created = await tx.modelEntry.create({ data: entryData(userId, provider, input.modelId, enriched, { ...(input.label !== undefined ? { label: input.label } : {}), ...(input.purpose ? { purpose: input.purpose } : {}) }) });
        await autoDefault(tx, userId, [created]);
        return created;
      }));
      return toEntry(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
  }

  /** POST /api/models/batch: ids already added are skipped. */
  async addMany(userId: string, input: BatchInput): Promise<void> {
    const provider = await this.provider(userId, input.providerId);
    const ids = [...new Set(input.modelIds)];
    const enriched = await this.enrich(provider, ids);
    await this.ctx.lock.run(userId, () => this.ctx.db.$transaction(async (tx) => {
      if (!(await tx.modelProvider.findFirst({ where: { id: provider.id, userId }, select: { id: true } }))) throw invalid("providerId", "not one of your providers");
      const existing = new Set((await tx.modelEntry.findMany({ where: { providerId: provider.id, modelId: { in: ids } }, select: { modelId: true } })).map((e) => e.modelId));
      const created: EntryRow[] = [];
      for (const id of ids) {
        if (existing.has(id)) continue;
        created.push(await tx.modelEntry.create({ data: entryData(userId, provider, id, enriched.get(id)!) }));
      }
      await autoDefault(tx, userId, created);
    }));
  }

  /** PATCH /api/models/:id: only the given fields, their names added to `edited`. */
  async update(userId: string, id: string, input: PatchInput): Promise<ModelEntry> {
    const { db, lock } = this.ctx;
    const row = await lock.run(userId, async () => {
      const current = await db.modelEntry.findFirst({ where: { id, userId } });
      if (!current) throw notFound();
      const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true } });
      if (input.tools === false && user.defaultModelId === current.id) throw invalid("tools", "this is the default model; choose another default first");
      const context = input.contextWindow ?? current.contextWindow;
      const output = input.maxOutputTokens ?? current.maxOutputTokens;
      if ((input.contextWindow !== undefined || input.maxOutputTokens !== undefined) && output > context) throw invalid("maxOutputTokens", "must not exceed contextWindow");
      const changed = Object.keys(input).filter((k) => input[k as keyof PatchInput] !== undefined);
      const data: Prisma.ModelEntryUpdateInput = { edited: JSON.stringify([...new Set([...editedOf(current), ...changed])]) };
      if (input.label !== undefined) data.label = input.label;
      if (input.contextWindow !== undefined) data.contextWindow = input.contextWindow;
      if (input.maxOutputTokens !== undefined) data.maxOutputTokens = input.maxOutputTokens;
      if (input.thinkingLevels !== undefined) data.thinkingLevels = JSON.stringify(ladder(input.thinkingLevels));
      if (input.thinkingFormat !== undefined) data.thinkingFormat = input.thinkingFormat;
      if (input.defaultThinking !== undefined) data.defaultThinking = input.defaultThinking;
      if (input.tools !== undefined) data.tools = input.tools;
      if (input.vision !== undefined) data.vision = input.vision;
      if (input.serverWebTools !== undefined) data.serverWebTools = input.serverWebTools;
      if (input.promptCaching !== undefined) data.promptCaching = input.promptCaching;
      return db.$transaction(async (tx) => {
        const next = await tx.modelEntry.update({ where: { id }, data });
        if (input.tools === true) await autoDefault(tx, userId, [next]);
        return next;
      });
    });
    return toEntry(row);
  }

  /**
   * PUT /api/model-defaults: defaultModelId must be a usable chat model (null only while there is
   * none); utilityModelId any of the user's chat models or null; defaultThinking any level or null.
   */
  async putDefaults(userId: string, input: DefaultsInput): Promise<void> {
    const { db, lock } = this.ctx;
    await lock.run(userId, async () => {
      const keyed = await keyedProviders(db, userId);
      const data: Prisma.UserUpdateInput = {};
      if (input.defaultModelId !== undefined) {
        if (input.defaultModelId === null) {
          const rows = await db.modelEntry.findMany({ where: { userId, purpose: "chat", tools: true } });
          if (rows.some((r) => usableChat(r, keyed))) throw invalid("defaultModelId", "choose a default model (there are usable chat models)");
        } else {
          const row = await db.modelEntry.findFirst({ where: { id: input.defaultModelId, userId } });
          if (!row || !usableChat(row, keyed)) throw invalid("defaultModelId", "must be a chat model with tools whose provider has a key");
        }
        data.defaultModelId = input.defaultModelId;
      }
      if (input.utilityModelId !== undefined) {
        if (input.utilityModelId !== null) {
          const row = await db.modelEntry.findFirst({ where: { id: input.utilityModelId, userId, purpose: "chat" } });
          if (!row) throw invalid("utilityModelId", "must be one of your chat models");
        }
        data.utilityModelId = input.utilityModelId;
      }
      if (input.defaultThinking !== undefined) data.defaultThinking = input.defaultThinking;
      if (Object.keys(data).length) await db.user.update({ where: { id: userId }, data });
    });
  }
}
