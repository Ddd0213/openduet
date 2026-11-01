// M12: the models module's service: GET /api/models (ModelsState), and what other modules ask
// (Features.models / webSearch, a channel's model check). Every entry point runs the
// one-time import first (import.ts), so a turn, GET /api/models and /api/me see the same rows.
import type { ModelsState } from "../contract/m12.ts";
import type { z } from "zod";
import type { Db } from "../db.ts";
import type { ModelsCtx } from "./context.ts";
import { Deletes } from "./deletes.ts";
import { Entries } from "./entries.ts";
import type { LegacyImporter } from "./import.ts";
import { Providers } from "./providers.ts";
import { KEY_NAME, keyedProviders, levelOrNull, OWNER_KIND, toEntry, toProvider, usableChat, usableChatEntry } from "./rows.ts";

export class ModelService {
  readonly providers: Providers;
  readonly entries: Entries;
  readonly deletes: Deletes;

  constructor(private readonly ctx: ModelsCtx, private readonly importer: LegacyImporter) {
    this.providers = new Providers(ctx);
    this.entries = new Entries(ctx);
    this.deletes = new Deletes(ctx);
  }

  get db(): Db {
    return this.ctx.db;
  }

  /** The one-time import for this user (a no-op once it ran, or without a legacy config). */
  ready(userId: string): Promise<void> {
    return this.importer.ensure(userId);
  }

  /** GET /api/models: providers and models (oldest first), the defaults and `configured`. */
  async state(userId: string): Promise<z.infer<typeof ModelsState>> {
    const { db, vault } = this.ctx;
    await this.ready(userId);
    const [providers, models, user, keyed] = await Promise.all([
      db.modelProvider.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      db.modelEntry.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      db.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultModelId: true, defaultThinking: true, utilityModelId: true } }),
      keyedProviders(db, userId),
    ]);
    const keys = await vault.infos(userId, OWNER_KIND, providers.map((p) => p.id));
    const counts = new Map<string, number>();
    for (const m of models) counts.set(m.providerId, (counts.get(m.providerId) ?? 0) + 1);
    const byId = new Map(models.map((m) => [m.id, m]));
    const current = user.defaultModelId ? byId.get(user.defaultModelId) : undefined;
    return {
      providers: providers.map((p) => toProvider(p, keys.get(p.id)?.get(KEY_NAME) ?? { set: false, last4: null }, counts.get(p.id) ?? 0)),
      models: models.map(toEntry),
      defaults: {
        defaultModelId: current ? current.id : null,
        defaultThinking: levelOrNull(user.defaultThinking),
        utilityModelId: user.utilityModelId && byId.has(user.utilityModelId) ? user.utilityModelId : null,
      },
      configured: !!current && usableChat(current, keyed),
    };
  }

  /** Features.models (a usable default) and whether that default has native web tools. */
  async features(userId: string): Promise<{ models: boolean; serverWebTools: boolean }> {
    await this.ready(userId);
    const user = await this.ctx.db.user.findUnique({ where: { id: userId }, select: { defaultModelId: true } });
    const entry = user?.defaultModelId ? await usableChatEntry(this.ctx.db, userId, user.defaultModelId) : null;
    return { models: !!entry, serverWebTools: !!entry?.serverWebTools };
  }

  /** A channel's own model must be one of the user's usable chat models (400 field modelId). */
  async usableChat(userId: string, modelId: string): Promise<boolean> {
    await this.ready(userId);
    return !!(await usableChatEntry(this.ctx.db, userId, modelId));
  }
}
