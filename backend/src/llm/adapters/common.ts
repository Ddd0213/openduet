// Shared boundary checks and transport security for the official SDK adapters.
import { z } from "zod";
import { createModelFetch } from "../net.ts";
import { InvalidModelResponse, UnsupportedRequest } from "../errors.ts";
import { requestedLevel, thinkingOf, type ThinkingLevel } from "../thinking.ts";
import type { AdapterContext, JsonObject, LlmRequest, Model, ModelIdentity, Provider, StopReason } from "../types.ts";

type OnLevel = Exclude<ThinkingLevel, "off">;
/** anthropic `effort` format: output_config.effort per level (the API has no "minimal"). */
export const ANTHROPIC_EFFORT: Record<OnLevel, "low" | "medium" | "high" | "xhigh" | "max"> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
/** anthropic `budget` format: budget_tokens per level, capped at maxOutputTokens - MIN_BUDGET. */
export const BUDGET_TOKENS: Record<OnLevel, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 63999 };
/** The API's smallest budget; also the room kept for the answer above the budget. */
export const MIN_BUDGET = 1024;

export type AnthropicThinking =
  | { thinking?: undefined; output_config?: undefined }
  | { thinking: { type: "adaptive" }; output_config?: { effort: (typeof ANTHROPIC_EFFORT)[OnLevel] } }
  | { thinking: { type: "enabled"; budget_tokens: number }; output_config?: undefined };

/**
 * The anthropic thinking fields and max_tokens for a request. models.json models (no thinkingFormat)
 * keep the pre-M12 shape: `thinking: true` + capabilities.thinking = adaptive thinking, nothing else.
 * effort: off = nothing; else adaptive + output_config.effort. budget: off = nothing; else enabled +
 * budget_tokens (capped at maxOutputTokens - 1024; below 1024 = no thinking) and max_tokens above it.
 */
export function anthropicThinking(request: LlmRequest, model: Model, maxTokens: number): { fields: AnthropicThinking; maxTokens: number } {
  const t = thinkingOf(model);
  if (t.legacy) return { fields: request.thinking && model.capabilities.thinking ? { thinking: { type: "adaptive" } } : {}, maxTokens };
  if (t.format === "none") return { fields: {}, maxTokens };
  const level = requestedLevel(request, t.levels);
  if (level === "off") return { fields: {}, maxTokens };
  if (t.format === "budget") {
    const budget = Math.min(BUDGET_TOKENS[level], model.maxOutputTokens - MIN_BUDGET);
    if (budget < MIN_BUDGET) return { fields: {}, maxTokens };
    return { fields: { thinking: { type: "enabled", budget_tokens: budget } }, maxTokens: Math.min(model.maxOutputTokens, Math.max(maxTokens, budget + MIN_BUDGET)) };
  }
  return { fields: { thinking: { type: "adaptive" }, output_config: { effort: ANTHROPIC_EFFORT[level] } }, maxTokens };
}

/**
 * The openai protocol's reasoning_effort. models.json models keep the pre-M12 "medium" for
 * `thinking: true`. effort (and budget, which this protocol can't express): the level's name; off =
 * left out, unless the provider says "none" (provider.reasoningOff, the gemini preset). none = nothing.
 */
export function openaiReasoning(request: LlmRequest, provider: Provider, model: Model): { reasoning_effort?: OnLevel | "none" } {
  const t = thinkingOf(model);
  if (t.legacy) return request.thinking && model.capabilities.thinking ? { reasoning_effort: "medium" } : {};
  if (t.format === "none") return {};
  const level = requestedLevel(request, t.levels);
  if (level === "off") return provider.reasoningOff === "none" ? { reasoning_effort: "none" } : {};
  return { reasoning_effort: level };
}
export const record = z.record(z.string(), z.unknown());
export const sameModel = (a: ModelIdentity, ctx: AdapterContext): boolean => a.providerId === ctx.provider.id && a.modelId === ctx.model.id;
export const identity = (ctx: AdapterContext): ModelIdentity => ({ providerId: ctx.provider.id, modelId: ctx.model.id });
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidModelResponse("schema");
  return result.data;
}
export function toolInput(value: unknown): JsonObject { return parse(record, value); }
export function parseArguments(value: string): JsonObject {
  let json: unknown;
  try { json = JSON.parse(value); } catch { throw new InvalidModelResponse("tool_json"); }
  return toolInput(json);
}
/**
 * M14 gateway tolerance: a tool call's streamed arguments. Empty (or only whitespace) = `{}`; JSON
 * that doesn't parse, or isn't one object, = undefined (the call is kept, flagged invalid, and the
 * runtime answers it with an error result instead of failing the turn).
 */
export function argumentsOf(value: string): JsonObject | undefined {
  if (!value.trim()) return {};
  try { return parseArguments(value); } catch { return undefined; }
}
/** A tool call that arrived with a name but no id gets one of ours. */
export const mintCallId = (): string => `call_${crypto.randomUUID().replaceAll("-", "")}`;
export function stopReason(value: unknown): StopReason {
  switch (value) {
    case "stop": case "end_turn": case "stop_sequence": return "end_turn";
    case "tool_calls": case "tool_use": return "tool_use";
    case "length": case "max_tokens": return "max_tokens";
    case "refusal": case "content_filter": return "refusal";
    default: return "other";
  }
}
export function checkRequest(request: LlmRequest, ctx: AdapterContext): void {
  if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || request.maxTokens < 1)) throw new UnsupportedRequest();
  if (request.messages.some(m => m.content.some(b => b.type === "audio" && (m.role !== "user" || b.format !== "wav")))) throw new UnsupportedRequest();
  if (!ctx.model.capabilities.vision && request.messages.some(m => m.content.some(b => b.type === "image" || (b.type === "tool_result" && b.content.some(c => c.type === "image"))))) throw new UnsupportedRequest();
}
// Disable SDK logging even if *_LOG is set; no raw SDK errors are logged either.
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
export function secureFetch(ctx: AdapterContext): (input: string | Request | URL, init?: RequestInit) => Promise<Response> {
  const transport = createModelFetch({ fetch: ctx.fetch });
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    for (const [name, value] of Object.entries(ctx.provider.headers ?? {})) headers.set(name, value);
    // SDK 1.3 uses Bearer for apiKey; force the explicitly configured wire auth.
    headers.delete("authorization");
    headers.delete("x-api-key");
    if (ctx.provider.protocol === "anthropic" && ctx.provider.auth !== "bearer") headers.set("x-api-key", ctx.apiKey);
    else headers.set("authorization", `Bearer ${ctx.apiKey}`);
    const response = await transport(input, { ...init, headers, redirect: "error" });
    const touch = ctx.onActivity;
    if (!touch || !response.body) return response;
    // Bytes, not canonical events, prove the gateway is alive: a long tool argument
    // streams for minutes before it becomes a single tool_call event.
    touch();
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, out) { touch(); out.enqueue(chunk); } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
