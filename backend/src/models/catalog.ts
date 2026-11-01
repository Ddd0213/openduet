// M12: models.dev (https://models.dev/api.json) for the numbers a provider's own list doesn't give:
// limits, tool calls, vision, realtime, thinking levels. Kept in memory for 24 h; a failed refresh
// keeps the stale copy (and waits 5 min before trying again); with none every row gets the
// defaults. A lookup never waits longer than the fetch timeout (10 s). Injectable fetch and clock.
import type { Fetch } from "../llm/index.ts";
import { thinkingFormatFromModelsDev, thinkingLevelsFromModelsDev, type ThinkingLevel } from "../llm/index.ts";
import { log } from "../log.ts";
import type { ThinkingFormat } from "../llm/types.ts";
import { getCapped } from "./net.ts";
import type { Protocol } from "./presets.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_TIMEOUT_MS = 10_000;
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const MODELS_DEV_BYTES = 30 * 1024 * 1024;

/** The numbers of one model, from models.dev or the defaults. */
export interface Enriched {
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  thinkingLevels: ThinkingLevel[];
  thinkingFormat: ThinkingFormat;
  tools: boolean;
  vision: boolean;
  realtime: boolean;
  transcription: boolean;
  source: "models.dev" | "default";
}

export const DEFAULT_CONTEXT = 128_000;
export const DEFAULT_OUTPUT = 8192;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null);
const positiveInt = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** `realtime`: audio out, or an id that names a realtime / live model (those can't chat). */
export const looksRealtime = (modelId: string): boolean => /realtime|live/i.test(modelId);
export const looksTranscription = (modelId: string): boolean => /(^|[-_.\/])(asr|transcribe|transcription|whisper|stt)([-_.\/]|$)/i.test(modelId);

/** The defaults for a model models.dev doesn't know (128k / 8k, tools on, no thinking). */
export function defaults(modelId: string, label?: string | null): Enriched {
  return {
    label: (label?.trim() || modelId).slice(0, 80), contextWindow: DEFAULT_CONTEXT, maxOutputTokens: DEFAULT_OUTPUT,
    thinkingLevels: [], thinkingFormat: "none", tools: true, vision: false, realtime: looksRealtime(modelId), source: "default",
    transcription: !looksRealtime(modelId) && looksTranscription(modelId),
  };
}

/** Maps one models.dev model record (contract §2). */
export function fromModelsDev(modelId: string, raw: Raw, protocol: Protocol, listLabel?: string | null): Enriched {
  const limit = record(raw.limit);
  const modalities = record(raw.modalities);
  const input = strings(modalities?.input);
  const output = strings(modalities?.output);
  const levels = thinkingLevelsFromModelsDev(raw.reasoning === true, raw.reasoning_options);
  const contextWindow = positiveInt(limit?.context) ?? DEFAULT_CONTEXT;
  // An output limit above the context (some records) is cut to it.
  const maxOutputTokens = Math.min(positiveInt(limit?.output) ?? DEFAULT_OUTPUT, contextWindow);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const realtime = output.includes("audio") || looksRealtime(modelId);
  return {
    label: (name || listLabel?.trim() || modelId).slice(0, 80), contextWindow, maxOutputTokens,
    thinkingLevels: levels, thinkingFormat: thinkingFormatFromModelsDev(levels, raw.reasoning_options, protocol),
    tools: raw.tool_call !== false, vision: input.includes("image"),
    realtime, transcription: !realtime && ((input.includes("audio") && output.includes("text")) || looksTranscription(modelId)), source: "models.dev",
  };
}

/** provider key -> model id -> record, in document order. */
type Index = Map<string, Map<string, Raw>>;

function indexOf(body: unknown): Index | null {
  const root = record(body);
  if (!root) return null;
  const index: Index = new Map();
  for (const [providerKey, value] of Object.entries(root)) {
    const models = record(record(value)?.models);
    if (!models) continue;
    const byId = new Map<string, Raw>();
    for (const [key, model] of Object.entries(models)) {
      const raw = record(model);
      if (!raw) continue;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : key.trim();
      if (id && !byId.has(id)) byId.set(id, raw);
    }
    if (byId.size) index.set(providerKey, byId);
  }
  return index;
}

export interface CatalogDeps { fetch?: Fetch; now?: () => number; timeoutMs?: number; url?: string }

export class ModelsDevCatalog {
  private index: Index | null = null;
  /** when the copy in memory was fetched (ms) */
  private fetchedAt = 0;
  private failedAt = 0;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(deps: CatalogDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? MODELS_DEV_TIMEOUT_MS;
    this.url = deps.url ?? MODELS_DEV_URL;
  }

  /** When the copy in use was fetched (null: none yet). */
  get loadedAt(): Date | null {
    return this.index ? new Date(this.fetchedAt) : null;
  }

  /** The document, refreshed when older than 24 h (stale on failure; null without any copy). */
  private async load(): Promise<Index | null> {
    const now = this.now();
    const fresh = this.index && now - this.fetchedAt < MODELS_DEV_TTL_MS;
    const backingOff = this.failedAt && now - this.failedAt < RETRY_AFTER_FAILURE_MS;
    if (!fresh && !backingOff) {
      this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
      await this.inflight;
    }
    return this.index;
  }

  private async refresh(): Promise<void> {
    const result = await getCapped(this.fetchImpl, this.url, { Accept: "application/json" }, this.timeoutMs, MODELS_DEV_BYTES);
    let index: Index | null = null;
    if (result.ok && result.status >= 200 && result.status < 300) {
      try {
        index = indexOf(JSON.parse(new TextDecoder().decode(result.body)));
      } catch {
        index = null;
      }
    }
    if (index) {
      this.index = index;
      this.fetchedAt = this.now();
      this.failedAt = 0;
      return;
    }
    this.failedAt = this.now();
    log.warn("models.dev refresh failed", { kept: this.index ? "stale copy" : "none", ...(result.ok ? { status: result.status } : { kind: result.kind }) });
  }

  /**
   * The record for a model id: under the preset's provider key; for custom (catalogKey null) the
   * exact id in any provider first, then the id without a `vendor/` prefix.
   */
  private find(index: Index, catalogKey: string | null, modelId: string): Raw | null {
    if (catalogKey) return index.get(catalogKey)?.get(modelId) ?? null;
    for (const models of index.values()) {
      const hit = models.get(modelId);
      if (hit) return hit;
    }
    const slash = modelId.indexOf("/");
    if (slash > 0 && slash < modelId.length - 1) {
      const vendor = modelId.slice(0, slash);
      const bare = modelId.slice(slash + 1);
      const own = index.get(vendor)?.get(bare);
      if (own) return own;
      for (const models of index.values()) {
        const hit = models.get(bare);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Every id enriched (models.dev, else the defaults). */
  async enrich(ids: readonly { id: string; label?: string | null }[], catalogKey: string | null, protocol: Protocol): Promise<Map<string, Enriched>> {
    const index = await this.load();
    const out = new Map<string, Enriched>();
    for (const { id, label } of ids) {
      const raw = index ? this.find(index, catalogKey, id) : null;
      out.set(id, raw ? fromModelsDev(id, raw, protocol, label) : defaults(id, label));
    }
    return out;
  }
}
