// M12 (contract §4): which model a turn runs on. chat / task / proactive roles: the channel's own
// model (a non-main channel, still usable), else the user's default; utility: the background model,
// else the default; a retry's pin: exactly that model. One model, never a chain: there's no silent
// fallback to another model when the chosen one fails. The provider's key is decrypted from the
// vault for this call and joins the redaction set; createLlm reads it through `apiKey`.
import type { ModelEntry as EntryRow, ModelProvider as ProviderRow } from "@prisma/client";
import type { Db } from "../db.ts";
import { createLlm, nearestSupportedThinkingLevel, type Fetch, type LlmOptions, type Model, type ModelConfig, type ModelResolver, type Provider, type RegisteredLlm, type ResolveQuery, type ResolvedModel, type ThinkingLevel } from "../llm/index.ts";
import type { Vault } from "../vault/index.ts";
import type { LegacyImporter } from "./import.ts";
import { presetOf } from "./presets.ts";
import { formatOf, headersOf, KEY_NAME, keyedProviders, levelOrNull, levelsOf, OWNER_KIND, usableChat } from "./rows.ts";

/** When neither the channel, the user nor the model sets a level. */
export const FALLBACK_THINKING: ThinkingLevel = "medium";

export interface ResolverDeps {
  db: Db;
  vault: Vault;
  importer: LegacyImporter;
  /** LLM_TIMEOUT_SECONDS * 1000 */
  timeoutMs: number;
  /** tests: a fake model layer over the one-model config (default: createLlm) */
  buildLlm?: (config: ModelConfig, opts: LlmOptions) => RegisteredLlm;
  fetch?: Fetch;
  sleep?: LlmOptions["sleep"];
  onSecret?: (secret: string) => void;
}

/** The llm/types.ts Provider of a database provider (its key comes from the vault, not env). */
export function providerOf(row: ProviderRow): Provider {
  const headers = Object.fromEntries(headersOf(row).map((h) => [h.name, h.value]));
  return {
    id: row.id, protocol: row.protocol === "anthropic" ? "anthropic" : "openai", baseUrl: row.baseUrl,
    ...(row.protocol === "anthropic" ? { auth: row.auth === "bearer" ? "bearer" as const : "x-api-key" as const } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(presetOf(row.kind)?.reasoningOff === "none" ? { reasoningOff: "none" as const } : {}),
  };
}

/** The llm/types.ts Model of a ModelEntry (id = the id sent to the provider). */
export function modelOf(row: EntryRow): Model {
  const levels = levelsOf(row);
  return {
    id: row.modelId, provider: row.providerId, label: row.label, contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens,
    capabilities: { tools: row.tools, vision: row.vision, thinking: levels.some((l) => l !== "off"), serverWebTools: row.serverWebTools, promptCaching: row.promptCaching },
    thinkingLevels: levels, thinkingFormat: formatOf(row),
  };
}

export class DbModelResolver implements ModelResolver {
  constructor(private readonly deps: ResolverDeps) {}

  async resolve(query: ResolveQuery): Promise<ResolvedModel | null> {
    const { db, vault } = this.deps;
    await this.deps.importer.ensure(query.userId);
    const user = await db.user.findUnique({ where: { id: query.userId }, select: { defaultModelId: true, defaultThinking: true, utilityModelId: true } });
    if (!user) return null;
    const keyed = await keyedProviders(db, query.userId);
    const usable = async (id: string | null | undefined): Promise<EntryRow | null> => {
      if (!id) return null;
      const row = await db.modelEntry.findFirst({ where: { id, userId: query.userId } });
      return row && usableChat(row, keyed) ? row : null;
    };
    const channel = query.channelId
      ? await db.channel.findFirst({ where: { id: query.channelId, userId: query.userId }, select: { isMain: true, modelId: true, thinkingLevel: true } })
      : null;
    const own = channel && !channel.isMain ? channel : null;
    let entry: EntryRow | null;
    if (query.pinModelId) entry = await usable(query.pinModelId);
    else if (query.role === "utility") entry = (await this.utility(query.userId, user.utilityModelId, keyed)) ?? (await usable(user.defaultModelId));
    else entry = (await usable(own?.modelId)) ?? (await usable(user.defaultModelId));
    if (!entry) return null;
    const providerRow = await db.modelProvider.findFirst({ where: { id: entry.providerId, userId: query.userId } });
    const key = providerRow ? (await vault.get(query.userId, OWNER_KIND, providerRow.id, KEY_NAME))?.trim() : undefined;
    if (!providerRow || !key) return null;
    this.deps.onSecret?.(key);
    const model = modelOf(entry);
    const asked: ThinkingLevel = query.role === "utility"
      ? "off"
      : levelOrNull(own?.thinkingLevel) ?? levelOrNull(user.defaultThinking) ?? levelOrNull(entry.defaultThinking) ?? FALLBACK_THINKING;
    const thinkingLevel = nearestSupportedThinkingLevel(asked, model.thinkingLevels);
    const config: ModelConfig = {
      providers: [providerOf(providerRow)], models: [model],
      roles: { chat: [model.id], task: [model.id], proactive: [model.id], utility: [model.id] }, timeoutMs: this.deps.timeoutMs,
    };
    const build = this.deps.buildLlm ?? createLlm;
    const llm = build(config, {
      apiKey: () => key,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    return { llm, model, thinkingLevel, entryId: entry.id, label: entry.label };
  }

  /** The background model: any of the user's chat models (tools not needed) whose provider has a key. */
  private async utility(userId: string, id: string | null, keyed: ReadonlySet<string>): Promise<EntryRow | null> {
    if (!id) return null;
    const row = await this.deps.db.modelEntry.findFirst({ where: { id, userId, purpose: "chat" } });
    return row && keyed.has(row.providerId) ? row : null;
  }
}
