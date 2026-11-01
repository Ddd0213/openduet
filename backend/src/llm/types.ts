// Vendor-neutral model API. provider_data preserves opaque native server-tool blocks
// for same-model replay; these are never executable client tool_call events.
import type { ThinkingLevel } from "../contract/m12.ts";
export type { ThinkingLevel } from "../contract/m12.ts";
export type ModelRole = "chat" | "task" | "proactive" | "utility";
export const MODEL_ROLES: readonly ModelRole[] = ["chat", "task", "proactive", "utility"];
export type JsonObject = Record<string, unknown>;
export interface ModelIdentity { providerId: string; modelId: string }
export interface TextBlock { type: "text"; text: string }
export interface ImageBlock { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }
export interface AudioBlock { type: "audio"; format: "wav"; data: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: JsonObject }
export interface ToolResultBlock { type: "tool_result"; toolUseId: string; content: (TextBlock | ImageBlock)[]; isError?: boolean }
export interface ThinkingBlock { type: "thinking"; text: string; signature?: string; redacted?: string; origin: ModelIdentity }
export interface ProviderDataBlock { type: "provider_data"; data: JsonObject; origin: ModelIdentity }
export type ContentBlock = TextBlock | ImageBlock | AudioBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ProviderDataBlock;
export interface Message { role: "user" | "assistant"; content: ContentBlock[] }
export interface Tool { name: string; description: string; inputSchema: JsonObject }
export interface LlmRequest {
  role: ModelRole;
  system: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  /** legacy switch: true = "medium" (clamped onto the model's levels); thinkingLevel wins when set */
  thinking?: boolean;
  /** M12: the level for this call, clamped onto the model's thinkingLevels by the adapter */
  thinkingLevel?: ThinkingLevel;
  serverTools?: ("web_search" | "web_fetch")[];
  pin?: ModelIdentity;
  signal?: AbortSignal;
}
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
export interface Usage { inputTokens: number; outputTokens: number; estimated: boolean }
export type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  // invalid "arguments" (M14): the call's arguments weren't one JSON object; input is {} and the
  // runtime answers it with an error result instead of running it.
  | { type: "tool_call"; id: string; name: string; input: JsonObject; invalid?: "arguments" }
  | ({ type: "usage" } & Usage)
  // droppedTools: tool calls cut off by max_tokens and left out of `message` (adapters set it only when > 0).
  | { type: "done"; stopReason: StopReason; message: Message; model: ModelIdentity; droppedTools?: number };
/** The small interface consumed by agents, including test-only scripted models. */
export interface Llm { stream(request: LlmRequest): AsyncIterable<LlmEvent> }
export interface Capabilities { tools: boolean; vision: boolean; thinking: boolean; serverWebTools: boolean; promptCaching: boolean }
/**
 * apiKeyEnv: the environment variable holding the key (models.json / LLM_*). M12 providers from the
 * database have none: createLlm's `apiKey` option reads their key from the vault.
 * reasoningOff: how the openai protocol says "no thinking" for a model that has levels: leave
 * reasoning_effort out (default) or send "none" (set by the provider preset, e.g. gemini).
 */
export interface Provider { id: string; protocol: "anthropic" | "openai"; baseUrl: string; apiKeyEnv?: string; auth?: "x-api-key" | "bearer"; headers?: Record<string, string>; reasoningOff?: "omit" | "none" }
/** The wire format of a thinking level (see contract/m12.ts ThinkingFormat). */
export type ThinkingFormat = "effort" | "budget" | "none";
/**
 * thinkingLevels / thinkingFormat (M12): the levels the model supports and how they go on the wire.
 * Left out (models.json, scripted test models): derived from capabilities.thinking, and the adapters
 * keep their pre-M12 request shape.
 */
export interface Model { id: string; provider: string; label: string; contextWindow: number; maxOutputTokens: number; capabilities: Capabilities; thinkingLevels?: ThinkingLevel[]; thinkingFormat?: ThinkingFormat }
/** This registry contains references to environment variables, never their values. */
export interface ModelConfig { providers: Provider[]; models: Model[]; roles: Record<ModelRole, string[]>; timeoutMs: number }
export type Fetch = ((input: string | Request | URL, init?: RequestInit) => Promise<Response>) & { lookup?: import("../custom-connectors/net.ts").Lookup };
export interface LlmOptions {
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
  /** the provider's key (default: env[provider.apiKeyEnv]); M12 database providers read the vault */
  apiKey?: (provider: Provider) => string | undefined;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
  random?: () => number;
  /** One line per failed attempt (default: log.warn). Only fixed, pattern-checked fields. */
  report?: (fields: Record<string, unknown>) => void;
}
export interface RegisteredLlm extends Llm { models: ModelConfig; roleModels(role: ModelRole): Model[] }
/** onActivity fires on the response and on every body chunk; it re-arms the idle deadline. */
export interface AdapterContext { provider: Provider; model: Model; apiKey: string; timeoutMs: number; fetch?: Fetch; onActivity?: () => void }

/** M12: which model a turn (or a background call) runs on. */
export interface ResolveQuery {
  userId: string;
  /** the turn's channel (a task's session: its task's channel); null = no channel (utility calls) */
  channelId: string | null;
  role: ModelRole;
  /** a `retry` with modelId: this ModelEntry for this one turn (it must be usable) */
  pinModelId?: string | null;
}
/** One model, never a chain: the turn has no silent fallback to another model. */
export interface ResolvedModel {
  /** createLlm over this one model (its roles all point at it) */
  llm: RegisteredLlm;
  model: Model;
  /** already clamped onto the model's levels */
  thinkingLevel: ThinkingLevel;
  /** the ModelEntry (id + label) for the model_error card */
  entryId: string;
  label: string;
}
export interface ModelResolver {
  /** null = nothing usable for this role (system.no_model) */
  resolve(query: ResolveQuery): Promise<ResolvedModel | null>;
}
