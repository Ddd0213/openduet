// M12: model configuration on the phone. Providers (OpenAI, Anthropic, Gemini, StepFun or a custom
// OpenAI / Anthropic compatible URL) with their key in the server's vault, the models picked from
// each provider's own list (enriched by models.dev), the defaults (default model + thinking level,
// background model) and a channel's own model. Semantics: .pi/handoff/m12-contract.md.
// Names avoid llm/types.ts's Provider / Model: ModelProvider, ModelEntry, ModelDefaults.
import { z } from "zod";
import { Id, IsoDate } from "./common.ts";
import { SecretInfo } from "./m11.ts";
import { ProviderRegion } from "./m27voice.ts";

// ---------------------------------------------------------------- thinking

/** PI-Desktop's ladder. A model publishes the subset it supports (in this order); off = no thinking. */
export const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;
export const THINKING_LEVELS = ThinkingLevel.options;
/**
 * How a level goes on the wire (the adapter's job):
 * - anthropic `effort`: thinking {type: adaptive} + output_config {effort};
 * - anthropic `budget`: thinking {type: enabled, budget_tokens};
 * - openai `effort`: reasoning_effort (gemini: "none" for off);
 * - `none`: the model doesn't think (thinkingLevels is []).
 */
export const ThinkingFormat = z.enum(["effort", "budget", "none"]);

// ---------------------------------------------------------------- providers

/**
 * The preset a provider was added from. `custom` is any OpenAI or Anthropic compatible URL.
 * gemini and stepfun speak the OpenAI protocol for chat; M13 also uses them for realtime voice.
 */
export const ProviderKind = z.enum(["openai", "anthropic", "gemini", "stepfun", "custom"]);
/** The wire protocol for chat: anthropic = Messages API, openai = Chat Completions. */
export const ProviderProtocol = z.enum(["openai", "anthropic"]);
const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
/** Extra non-secret request headers (credentials go in the key; names like Authorization are refused). */
export const ProviderHeader = z.object({ name: HeaderName, value: z.string().max(2000) });

export const ModelProvider = z.object({
  id: Id,
  kind: ProviderKind,
  protocol: ProviderProtocol,
  /** shown in the app; unique per user */
  name: z.string().trim().min(1).max(60),
  /** https (http only for hosts in LLM_ALLOW_INSECURE_HOSTS); no credentials, query or fragment */
  baseUrl: z.string(),
  /** anthropic protocol only: how the key is sent (x-api-key, or Authorization: Bearer for gateways) */
  auth: z.enum(["x-api-key", "bearer"]).nullable(),
  /** never the key itself: whether it's set and its last 4 characters */
  key: SecretInfo,
  headers: z.array(ProviderHeader),
  /** the last check (create, PATCH with a new key or URL, POST /test) */
  status: z.enum(["active", "failed"]),
  error: z.string().nullable(),
  /** imported from models.json / LLM_* on first use (the app can edit or delete it like any other) */
  imported: z.boolean(),
  modelCount: z.number().int().min(0),
  createdAt: IsoDate,
  /**
   * M27 (m27voice.ts): the site of a kind that has regions (stepfun: cn | intl; rows from before
   * M27 are cn); null for the other kinds. The realtime address follows it; `baseUrl` (chat) is the
   * region's unless the user set their own.
   */
  region: ProviderRegion.nullable().default(null),
});
export type ModelProvider = z.infer<typeof ModelProvider>;

/** POST /api/providers: checked (GET /models with the key) before it's saved; 400 with the reason. */
export const CreateModelProviderRequest = z.object({
  kind: ProviderKind,
  /** custom only (presets have a fixed protocol) */
  protocol: ProviderProtocol.optional(),
  name: z.string().trim().min(1).max(60).optional(),
  /** presets: optional (their default URL); custom: required */
  baseUrl: z.string().trim().max(500).optional(),
  auth: z.enum(["x-api-key", "bearer"]).optional(),
  key: z.string().trim().min(1).max(500),
  headers: z.array(ProviderHeader).max(10).optional(),
  /**
   * M27: kinds with regions only (stepfun; others 400 field `region`). Default from User.region
   * (defaultProviderRegion). Without baseUrl the provider gets the region's chat URL, and the key
   * is checked against that host.
   */
  region: ProviderRegion.optional(),
}).strict();
/** PATCH /api/providers/:id. A new key or URL is checked again (400 with the reason, nothing saved). */
export const UpdateModelProviderRequest = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().max(500),
  auth: z.enum(["x-api-key", "bearer"]),
  key: z.string().trim().min(1).max(500),
  headers: z.array(ProviderHeader).max(10),
  /**
   * M27: a new site (stepfun only, else 400 `region`). A baseUrl still at the old region's chat URL
   * moves to the new one's; the key (stored, or sent with it) is checked against the new host.
   */
  region: ProviderRegion,
}).partial().strict();
export const ModelProviderResponse = z.object({ provider: ModelProvider });

/**
 * GET /api/providers/:id/remote-models: the provider's own GET /models, each row enriched from
 * models.dev (cached for a day; without it the defaults below). Nothing is saved.
 */
export const RemoteModel = z.object({
  /** the id sent to the provider ("claude-opus-4-6", "gemini-2.5-pro") */
  modelId: z.string().min(1).max(200),
  label: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** supported levels in ladder order; [] = no thinking */
  thinkingLevels: z.array(ThinkingLevel),
  thinkingFormat: ThinkingFormat,
  tools: z.boolean(),
  vision: z.boolean(),
  /** a realtime voice model (M13); can't be a chat model */
  realtime: z.boolean(),
  /** where the numbers came from: models.dev, or defaults (128k / 8k, tools on, no thinking) */
  source: z.enum(["models.dev", "default"]),
  /** already in the list: its ModelEntry.id, else null */
  addedAs: Id.nullable(),
  /**
   * M27: can serve cloud dictation (audio in, text out, not realtime per models.dev; or an id that
   * names a speech recognizer: asr / transcribe / whisper / stt). Only a hint for the Voice page's
   * picker, which also takes a typed model id.
   */
  transcription: z.boolean().default(false),
});
export const RemoteModelList = z.object({ models: z.array(RemoteModel) });

// ---------------------------------------------------------------- models

export const ModelPurpose = z.enum(["chat", "realtime"]);
/** A model in the user's list. Every field can be changed by hand (PATCH); `edited` lists which. */
export const ModelEntry = z.object({
  id: Id,
  providerId: Id,
  purpose: ModelPurpose,
  /** the id sent to the provider */
  modelId: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(80),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  thinkingLevels: z.array(ThinkingLevel),
  thinkingFormat: ThinkingFormat,
  /** the level used when neither the channel nor the default sets one (null = the highest supported) */
  defaultThinking: ThinkingLevel.nullable(),
  tools: z.boolean(),
  vision: z.boolean(),
  /** native web search / fetch (Anthropic server tools) */
  serverWebTools: z.boolean(),
  promptCaching: z.boolean(),
  source: z.enum(["models.dev", "default", "imported", "manual"]),
  /** fields the user changed by hand (a models.dev refresh never overwrites them) */
  edited: z.array(z.string()),
  createdAt: IsoDate,
});
export type ModelEntry = z.infer<typeof ModelEntry>;

/** POST /api/models: add one by id. Missing numbers come from the remote list / models.dev. */
export const CreateModelEntryRequest = z.object({
  providerId: Id,
  modelId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(80).optional(),
  purpose: ModelPurpose.optional(),
}).strict();
/** POST /api/models/batch: the remote-models picker ("Add 3 models") -> ModelsState. */
export const CreateModelEntriesRequest = z.object({
  providerId: Id,
  modelIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
}).strict();
/** PATCH /api/models/:id */
export const UpdateModelEntryRequest = z.object({
  label: z.string().trim().min(1).max(80),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  thinkingLevels: z.array(ThinkingLevel),
  thinkingFormat: ThinkingFormat,
  defaultThinking: ThinkingLevel.nullable(),
  tools: z.boolean(),
  vision: z.boolean(),
  serverWebTools: z.boolean(),
  promptCaching: z.boolean(),
}).partial().strict();
export const ModelEntryResponse = z.object({ model: ModelEntry });

// ---------------------------------------------------------------- the defaults

export const ModelDefaults = z.object({
  /** chat, tasks and routines (a channel can override it); null only when there's no usable chat model */
  defaultModelId: Id.nullable(),
  defaultThinking: ThinkingLevel.nullable(),
  /** memory curation, titles, summaries; null = the default model */
  utilityModelId: Id.nullable(),
});
/** PUT /api/model-defaults (only the fields that change) -> ModelsState. A chat model needs tools (400). */
export const UpdateModelDefaultsRequest = ModelDefaults.partial().strict();

/** GET /api/models: the whole configuration page in one answer. */
export const ModelsState = z.object({
  providers: z.array(ModelProvider),
  models: z.array(ModelEntry),
  defaults: ModelDefaults,
  /** there's a default chat model whose provider has a key (also Me.features.models) */
  configured: z.boolean(),
});
