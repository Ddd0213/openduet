// M12 one-time import (contract §6): the legacy models.json / LLM_* configuration loaded at startup
// becomes the user's own providers (kind custom, imported) and models (source imported) the first
// time their model configuration is needed. Keys come from the environment (injectable) and go
// straight into the vault; providers without a key are skipped. One transaction, claimed by
// `modelsImportedAt IS NULL`: two parallel first requests import once, a second run changes nothing,
// and after the user deletes everything nothing comes back.
import { LEGACY_THINKING_LEVELS, type ModelConfig } from "../llm/index.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import type { Vault } from "../vault/index.ts";
import { KEY_NAME, OWNER_KIND } from "./rows.ts";

export interface ImporterDeps {
  db: Db;
  vault: Vault;
  /** null: no legacy configuration (a fresh server set up from the phone) */
  legacy: ModelConfig | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** a key read from the environment joins the run records' redaction set */
  onSecret?: (secret: string) => void;
}

/** A unique name among `taken` ("gateway", "gateway 2", ...), at most 60 characters. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const root = base.trim().slice(0, 60) || "Provider";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${root.slice(0, 60 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

export class LegacyImporter {
  private readonly inflight = new Map<string, Promise<void>>();
  /** users known to be imported (or with nothing to import) in this process */
  private readonly done = new Set<string>();
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;

  constructor(private readonly deps: ImporterDeps) {
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
  }

  /** Runs the import for this user unless it ran already (or there's nothing to import). */
  ensure(userId: string): Promise<void> {
    if (!this.deps.legacy || this.done.has(userId)) return Promise.resolve();
    const pending = this.inflight.get(userId);
    if (pending) return pending;
    const work = this.run(userId).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, work);
    return work;
  }

  private async run(userId: string): Promise<void> {
    const legacy = this.deps.legacy!;
    const { db, vault } = this.deps;
    const user = await db.user.findUnique({ where: { id: userId }, select: { modelsImportedAt: true } });
    if (!user || user.modelsImportedAt) {
      if (user) this.done.add(userId);
      return;
    }
    const keys: string[] = [];
    const counts = await db.$transaction(async (tx) => {
      // The claim: a parallel import (another request, another process) finds it taken and stops.
      const claimed = await tx.user.updateMany({ where: { id: userId, modelsImportedAt: null }, data: { modelsImportedAt: this.now() } });
      if (claimed.count !== 1) return null;
      const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true, utilityModelId: true } });
      // Names are unique per user (an upsert of an existing import keeps its name).
      const taken = new Set((await tx.modelProvider.findMany({ where: { userId }, select: { name: true } })).map((p) => p.name));
      /** legacy model id -> its ModelEntry (purpose chat; tools as configured) */
      const entries = new Map<string, { id: string; tools: boolean }>();
      let providers = 0;
      for (const provider of legacy.providers) {
        const key = provider.apiKeyEnv ? this.env[provider.apiKeyEnv]?.trim() : undefined;
        if (!key) continue;
        const headers = Object.entries(provider.headers ?? {}).map(([name, value]) => ({ name, value }));
        const name = uniqueName(provider.id, taken);
        const data = {
          kind: "custom", protocol: provider.protocol, baseUrl: provider.baseUrl,
          auth: provider.protocol === "anthropic" ? (provider.auth ?? "x-api-key") : null,
          headers: JSON.stringify(headers), status: "active", error: null,
        };
        const row = await tx.modelProvider.upsert({
          where: { userId_importKey: { userId, importKey: provider.id } },
          create: { userId, importKey: provider.id, name, ...data },
          update: data,
        });
        taken.add(row.name);
        await vault.put(userId, OWNER_KIND, row.id, KEY_NAME, key, tx);
        keys.push(key);
        providers++;
        for (const model of legacy.models.filter((m) => m.provider === provider.id)) {
          if (model.id.length > 200) continue;
          const thinking = model.capabilities.thinking;
          const fields = {
            purpose: "chat", label: (model.label.trim() || model.id).slice(0, 80), contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens, thinkingLevels: JSON.stringify(thinking ? LEGACY_THINKING_LEVELS : []),
            thinkingFormat: thinking ? "effort" : "none", tools: model.capabilities.tools, vision: model.capabilities.vision,
            serverWebTools: model.capabilities.serverWebTools, promptCaching: model.capabilities.promptCaching, source: "imported",
          };
          const entry = await tx.modelEntry.upsert({
            where: { providerId_modelId: { providerId: row.id, modelId: model.id } },
            create: { userId, providerId: row.id, modelId: model.id, ...fields },
            update: fields,
          });
          entries.set(model.id, { id: entry.id, tools: entry.tools });
        }
      }
      // The defaults: MODEL_CHAT's first model, else the first imported model with tools (the auto
      // default); MODEL_UTILITY's first when it differs. A default the user set already stays.
      const chat = entries.get(legacy.roles.chat[0] ?? "");
      const defaultModelId = current.defaultModelId ?? (chat?.tools ? chat.id : [...entries.values()].find((e) => e.tools)?.id ?? null);
      const utility = entries.get(legacy.roles.utility[0] ?? "");
      const utilityModelId = current.utilityModelId ?? (utility && utility.id !== defaultModelId ? utility.id : null);
      await tx.user.update({ where: { id: userId }, data: { defaultModelId, utilityModelId } });
      return { providers, models: entries.size };
    });
    for (const key of keys) this.deps.onSecret?.(key);
    this.done.add(userId);
    if (counts) log.info("legacy models imported", { userId, ...counts });
  }
}
