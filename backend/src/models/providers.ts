// M12 providers (contract §1): create (verified before anything is saved), PATCH (a new key / URL /
// auth / headers is verified again), POST /test (re-check, status stored) and the remote model list
// (the provider's own list, enriched from models.dev). The key goes into the vault and is only ever
// answered as { set, last4 }; it joins the redaction set the moment it's typed or decrypted.
import type { ModelProvider as ProviderRow } from "@prisma/client";
import type { z } from "zod";
import type { CreateModelProviderRequest, ModelProvider, RemoteModelList, UpdateModelProviderRequest } from "../contract/m12.ts";
import { defaultProviderRegion, REGIONS_OF, voiceEndpointsOf, type ProviderRegion } from "../contract/m27voice.ts";
import { checkBaseUrl, checkHeaders, invalid, notFound, type ModelsCtx } from "./context.ts";
import { uniqueName } from "./import.ts";
import { fetchModelList, getCapped, hostOf, LIST_BYTES, VERIFY_TIMEOUT_MS, type ListTarget, type ListVerdict } from "./net.ts";
import { authHeaders, modelListUrl, presetOf, type AuthStyle, type Protocol } from "./presets.ts";
import { headersOf, KEY_NAME, OWNER_KIND, toProvider } from "./rows.ts";

type CreateInput = z.infer<typeof CreateModelProviderRequest>;
type UpdateInput = z.infer<typeof UpdateModelProviderRequest>;

const targetOf = (row: ProviderRow): ListTarget => ({
  kind: row.kind, protocol: row.protocol === "anthropic" ? "anthropic" : "openai", baseUrl: row.baseUrl,
  auth: row.protocol === "anthropic" ? (row.auth === "bearer" ? "bearer" : "x-api-key") : null, headers: headersOf(row),
});

/** custom: the URL's host (≤ 60); presets: their display name. */
const defaultName = (kind: string, baseUrl: string): string => presetOf(kind)?.name ?? hostOf(baseUrl).slice(0, 60);

export class Providers {
  constructor(private readonly ctx: ModelsCtx) {}

  /** The user's own provider; another user's is 404. */
  async own(userId: string, id: string): Promise<ProviderRow> {
    const row = await this.ctx.db.modelProvider.findFirst({ where: { id, userId } });
    if (!row) throw notFound();
    return row;
  }

  async shaped(row: ProviderRow): Promise<ModelProvider> {
    const [key, modelCount] = await Promise.all([
      this.ctx.vault.info(row.userId, OWNER_KIND, row.id, KEY_NAME),
      this.ctx.db.modelEntry.count({ where: { providerId: row.id } }),
    ]);
    return toProvider(row, key, modelCount);
  }

  private verify(target: ListTarget, key: string): Promise<ListVerdict> {
    return fetchModelList(target, key, this.ctx.fetch, this.ctx.verifyTimeoutMs);
  }

  /** A refused StepFun key may belong to its other site; both requests share one deadline. */
  private async verifyRegion(target: ListTarget, key: string, region: ProviderRegion | null): Promise<ListVerdict> {
    if (target.kind !== "stepfun") return this.verify(target, key);
    const timeout = this.ctx.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeout);
    const verdict = await fetchModelList(target, key, this.ctx.fetch, timeout, signal);
    if (!verdict.ok && verdict.field === "key") {
      const other = region === "intl" ? "cn" : "intl";
      const baseUrl = voiceEndpointsOf("stepfun", other)!.chatBaseUrl;
      const probe = await getCapped(this.ctx.fetch, modelListUrl("openai", baseUrl), authHeaders("openai", null, key), timeout, LIST_BYTES, signal);
      if (probe.ok && probe.status >= 200 && probe.status < 300) {
        throw invalid("region", `this key belongs to StepFun's ${other === "intl" ? "international" : "mainland"} site (${hostOf(baseUrl)})`);
      }
    }
    return verdict;
  }

  /** A name unique among the user's providers (a clash gets " 2", " 3" ...). */
  private async nameFor(userId: string, wanted: string, except?: string): Promise<string> {
    const rows = await this.ctx.db.modelProvider.findMany({ where: { userId, ...(except ? { id: { not: except } } : {}) }, select: { name: true } });
    return uniqueName(wanted, new Set(rows.map((r) => r.name)));
  }

  async create(userId: string, input: CreateInput): Promise<ModelProvider> {
    const { db, vault, lock } = this.ctx;
    const preset = presetOf(input.kind);
    if (input.region !== undefined && !REGIONS_OF[input.kind]) throw invalid("region", "only StepFun providers have a region");
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { region: true } });
    const region = input.region ?? defaultProviderRegion(input.kind, user.region);
    const protocol: Protocol | undefined = preset ? preset.protocol : input.protocol;
    if (!protocol) throw invalid("protocol", "required for a custom provider (openai or anthropic)");
    const rawUrl = input.baseUrl || voiceEndpointsOf(input.kind, region)?.chatBaseUrl || preset?.baseUrl;
    if (!rawUrl) throw invalid("baseUrl", "required for a custom provider");
    const baseUrl = await checkBaseUrl(rawUrl, protocol, this.ctx.insecureHosts, this.ctx.privateHosts, this.ctx.lookup);
    if (input.auth && protocol !== "anthropic") throw invalid("auth", "only for the anthropic protocol");
    const auth: AuthStyle | null = protocol === "anthropic" ? (input.auth ?? "x-api-key") : null;
    const headers = checkHeaders(input.headers ?? []);
    // From here on the typed key is redacted from every run record, whatever the check says.
    this.ctx.onSecret(input.key);
    const verdict = await this.verifyRegion({ kind: input.kind, protocol, baseUrl, auth, headers }, input.key, region);
    if (!verdict.ok) throw invalid(verdict.field, verdict.reason);
    const row = await lock.run(userId, async () => {
      const name = await this.nameFor(userId, input.name ?? defaultName(input.kind, baseUrl));
      return db.$transaction(async (tx) => {
        const created = await tx.modelProvider.create({ data: {
          userId, kind: input.kind, region, protocol, name, baseUrl, auth, headers: JSON.stringify(headers), status: "active", error: null,
        } });
        await vault.put(userId, OWNER_KIND, created.id, KEY_NAME, input.key, tx);
        return created;
      });
    });
    return this.shaped(row);
  }

  async update(userId: string, id: string, input: UpdateInput): Promise<ModelProvider> {
    const { db, vault, lock } = this.ctx;
    const row = await this.own(userId, id);
    const protocol: Protocol = row.protocol === "anthropic" ? "anthropic" : "openai";
    if (input.region !== undefined && !REGIONS_OF[row.kind]) throw invalid("region", "only StepFun providers have a region");
    const oldRegion = row.region === "intl" ? "intl" : "cn";
    const region = input.region ?? (REGIONS_OF[row.kind] ? oldRegion : null);
    const regionChanged = input.region !== undefined && input.region !== oldRegion;
    if (input.auth !== undefined && protocol !== "anthropic") throw invalid("auth", "only for the anthropic protocol");
    let baseUrl = row.baseUrl;
    if (regionChanged && baseUrl === voiceEndpointsOf(row.kind, oldRegion)?.chatBaseUrl) baseUrl = voiceEndpointsOf(row.kind, region)!.chatBaseUrl;
    if (input.baseUrl !== undefined) {
      const rawUrl = input.baseUrl || voiceEndpointsOf(row.kind, region)?.chatBaseUrl || presetOf(row.kind)?.baseUrl;
      if (!rawUrl) throw invalid("baseUrl", "required for a custom provider");
      baseUrl = await checkBaseUrl(rawUrl, protocol, this.ctx.insecureHosts, this.ctx.privateHosts, this.ctx.lookup);
    }
    await checkBaseUrl(baseUrl, protocol, this.ctx.insecureHosts, this.ctx.privateHosts, this.ctx.lookup);
    const auth: AuthStyle | null = protocol === "anthropic" ? (input.auth ?? (row.auth === "bearer" ? "bearer" : "x-api-key")) : null;
    const headers = input.headers !== undefined ? checkHeaders(input.headers) : headersOf(row);
    // A new address gets the key only when the request sends it: the stored key (possibly the
    // operator's, from the import) never goes to a URL it wasn't typed for.
    if (input.baseUrl !== undefined && baseUrl !== row.baseUrl && input.key === undefined) throw invalid("key", "send the key again when the address changes");
    const recheck = regionChanged || input.key !== undefined || (input.baseUrl !== undefined && baseUrl !== row.baseUrl) || input.auth !== undefined || input.headers !== undefined;
    let status: { status: "active" | "failed"; error: string | null } | null = null;
    if (recheck) {
      if (input.key !== undefined) this.ctx.onSecret(input.key);
      const key = input.key ?? (await vault.get(userId, OWNER_KIND, row.id, KEY_NAME));
      if (!key) throw invalid("key", "no key is stored; send one");
      if (input.key === undefined) this.ctx.onSecret(key);
      const target = { kind: row.kind, protocol, baseUrl, auth, headers };
      const verdict = await (regionChanged ? this.verifyRegion(target, key, region) : this.verify(target, key));
      if (!verdict.ok) throw invalid(verdict.field, verdict.reason);
      status = { status: "active", error: null };
    }
    const updated = await lock.run(userId, async () => {
      if (!(await db.modelProvider.findFirst({ where: { id, userId }, select: { id: true } }))) throw notFound();
      const name = input.name !== undefined ? await this.nameFor(userId, input.name, id) : row.name;
      return db.$transaction(async (tx) => {
        // Only what this request changed: a concurrent PATCH of other fields isn't written back.
        const data = {
          ...(input.name !== undefined ? { name } : {}),
          ...(input.baseUrl !== undefined || regionChanged ? { baseUrl } : {}),
          ...(input.region !== undefined ? { region } : {}),
          ...(input.auth !== undefined ? { auth } : {}),
          ...(input.headers !== undefined ? { headers: JSON.stringify(headers) } : {}),
          ...(status ?? {}),
        };
        const next = await tx.modelProvider.update({ where: { id }, data });
        if (input.key !== undefined) await vault.put(userId, OWNER_KIND, id, KEY_NAME, input.key, tx);
        return next;
      });
    });
    return this.shaped(updated);
  }

  /** POST /api/providers/:id/test: the same check; status and error are stored (200 either way). */
  async test(userId: string, id: string): Promise<ModelProvider> {
    const row = await this.own(userId, id);
    const key = await this.ctx.vault.get(userId, OWNER_KIND, row.id, KEY_NAME);
    let next: { status: "active" | "failed"; error: string | null };
    if (!key) next = { status: "failed", error: "no key is stored" };
    else {
      this.ctx.onSecret(key);
      const verdict = await this.verify(targetOf(row), key);
      next = verdict.ok ? { status: "active", error: null } : { status: "failed", error: verdict.reason };
    }
    const updated = await this.ctx.db.modelProvider.update({ where: { id: row.id }, data: next });
    return this.shaped(updated);
  }

  /** GET /api/providers/:id/remote-models: the provider's list, enriched; nothing is saved. */
  async remote(userId: string, id: string): Promise<z.infer<typeof RemoteModelList>> {
    const { db, vault, catalog } = this.ctx;
    const row = await this.own(userId, id);
    const key = await vault.get(userId, OWNER_KIND, row.id, KEY_NAME);
    if (!key) throw invalid("key", "no key is stored");
    this.ctx.onSecret(key);
    const verdict = await this.verify(targetOf(row), key);
    if (!verdict.ok) throw invalid(verdict.field, verdict.reason);
    const protocol = row.protocol === "anthropic" ? "anthropic" : "openai";
    const enriched = await catalog.enrich(verdict.models, presetOf(row.kind)?.catalogKey ?? null, protocol);
    const added = new Map((await db.modelEntry.findMany({ where: { providerId: row.id }, select: { id: true, modelId: true } })).map((e) => [e.modelId, e.id]));
    const models = verdict.models
      .map(({ id: modelId }) => {
        const e = enriched.get(modelId)!;
        return {
          modelId, label: e.label, contextWindow: e.contextWindow, maxOutputTokens: e.maxOutputTokens, thinkingLevels: e.thinkingLevels,
          thinkingFormat: e.thinkingFormat, tools: e.tools, vision: e.vision, realtime: e.realtime, source: e.source, addedAs: added.get(modelId) ?? null,
          transcription: e.transcription,
        };
      })
      .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
    return { models };
  }
}
