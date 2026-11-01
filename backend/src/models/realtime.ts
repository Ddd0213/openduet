// M13: the realtime voice models (contract .pi/handoff/m13-contract.md "Which model"). Usable = a
// ModelEntry with purpose "realtime" whose provider is a gemini or stepfun one, isn't `failed` and
// has its key in the vault. The calls module reads the key only through here (never the vault
// directly); every decrypted key joins the run records' redaction set (onSecret).
import type { ModelEntry as EntryRow, ModelProvider as ProviderRow } from "@prisma/client";
import type { Db } from "../db.ts";
import { realtimeVoicesOf, type VoiceProvider } from "../contract/m27voice.ts";
import type { Vault } from "../vault/index.ts";
import type { LegacyImporter } from "./import.ts";
import { KEY_NAME, keyedProviders, OWNER_KIND } from "./rows.ts";

export type VoiceEngineKind = "gemini" | "stepfun";
export const VOICE_PROVIDER_KINDS: readonly VoiceEngineKind[] = ["gemini", "stepfun"];

export interface RealtimeModel {
  entry: EntryRow;
  provider: ProviderRow;
  engine: VoiceEngineKind;
}

export interface RealtimeDeps {
  db: Db;
  vault: Vault;
  importer?: Pick<LegacyImporter, "ensure">;
  onSecret?: (secret: string) => void;
}

const engineOf = (kind: string): VoiceEngineKind | null => (VOICE_PROVIDER_KINDS as readonly string[]).includes(kind) ? (kind as VoiceEngineKind) : null;

export class RealtimeModels {
  constructor(private readonly deps: RealtimeDeps) {}

  /** The entry `id` when it's one of the user's realtime models on a gemini / stepfun provider (usable or not). */
  async realtimeEntry(userId: string, id: string): Promise<RealtimeModel | null> {
    const { db } = this.deps;
    const entry = await db.modelEntry.findFirst({ where: { id, userId, purpose: "realtime" } });
    if (!entry) return null;
    const provider = await db.modelProvider.findFirst({ where: { id: entry.providerId, userId } });
    const engine = provider ? engineOf(provider.kind) : null;
    return provider && engine ? { entry, provider, engine } : null;
  }

  /** Usable: a realtime entry of a gemini / stepfun provider that isn't failed and has a key. */
  async usable(userId: string, id: string | null | undefined): Promise<RealtimeModel | null> {
    if (!id) return null;
    const found = await this.realtimeEntry(userId, id);
    if (!found || found.provider.status === "failed") return null;
    const keyed = await keyedProviders(this.deps.db, userId);
    return keyed.has(found.provider.id) ? found : null;
  }

  /** The user's first usable realtime model (oldest entry first), or null. */
  async first(userId: string): Promise<RealtimeModel | null> {
    const { db } = this.deps;
    const [entries, providers, keyed] = await Promise.all([
      db.modelEntry.findMany({ where: { userId, purpose: "realtime" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      db.modelProvider.findMany({ where: { userId, kind: { in: [...VOICE_PROVIDER_KINDS] }, status: { not: "failed" } } }),
      keyedProviders(db, userId),
    ]);
    const byId = new Map(providers.map((p) => [p.id, p]));
    for (const entry of entries) {
      const provider = byId.get(entry.providerId);
      const engine = provider ? engineOf(provider.kind) : null;
      if (provider && engine && keyed.has(provider.id)) return { entry, provider, engine };
    }
    return null;
  }

  /**
   * Which model a call uses: `requested` (must be usable: null when it isn't), else the voice
   * settings' model, else the first usable one. Runs the one-time import first.
   */
  async pick(userId: string, requested?: string | null): Promise<RealtimeModel | null> {
    await this.deps.importer?.ensure(userId);
    if (requested) return this.usable(userId, requested);
    const user = await this.deps.db.user.findUnique({ where: { id: userId }, select: { voiceModelId: true } });
    return (await this.usable(userId, user?.voiceModelId)) ?? (await this.first(userId));
  }

  /** Features.voice / VoiceSettings.configured: the settings' model or the first realtime model is usable. */
  async configured(userId: string): Promise<boolean> {
    return !!(await this.pick(userId));
  }

  /** Voice-page rows: only key metadata is read; no secrets are decrypted for settings. */
  async providers(userId: string): Promise<VoiceProvider[]> {
    await this.deps.importer?.ensure(userId);
    const rows = await this.deps.db.modelProvider.findMany({ where: { userId, kind: { in: [...VOICE_PROVIDER_KINDS] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const [infos, entries] = await Promise.all([
      this.deps.vault.infos(userId, OWNER_KIND, rows.map((r) => r.id)),
      this.deps.db.modelEntry.findMany({ where: { userId, providerId: { in: rows.map((r) => r.id) }, purpose: "realtime" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    ]);
    return rows.map((row) => {
      const kind = engineOf(row.kind)!;
      const region = kind === "stepfun" ? (row.region === "intl" ? "intl" : "cn") : null;
      return {
        id: row.id, kind, name: row.name, region,
        key: infos.get(row.id)?.get(KEY_NAME) ?? { set: false, last4: null },
        status: row.status === "failed" ? "failed" : "active", error: row.error, voices: [...realtimeVoicesOf(kind, region)],
        realtimeModels: entries.filter((e) => e.providerId === row.id).map(({ id, modelId, label }) => ({ id, modelId, label })),
      };
    });
  }

  /** Dictation needs no realtime ModelEntry, but may only decrypt its owner's voice-provider key. */
  async providerKey(userId: string, providerId: string): Promise<string | null> {
    const provider = await this.deps.db.modelProvider.findFirst({ where: { id: providerId, userId, kind: { in: [...VOICE_PROVIDER_KINDS] } } });
    if (!provider) return null;
    const value = (await this.deps.vault.get(userId, OWNER_KIND, providerId, KEY_NAME))?.trim();
    if (!value) return null;
    this.deps.onSecret?.(value);
    return value;
  }

  /** The provider's key, decrypted for this call (it joins the redaction set); null when missing. */
  async key(userId: string, model: RealtimeModel): Promise<string | null> {
    return this.providerKey(userId, model.provider.id);
  }
}
