// Safe public errors: no SDK message, cause, headers, URL, or response body escapes.
import type { Phrase } from "../contract/common.ts";
import type { ModelIdentity } from "./types.ts";
export type LlmErrorKind = "http" | "network" | "timeout" | "config";
/**
 * M14 (nanomuse-harness-2 N6): a fixed code per failure, decided before the SDK error (and its body)
 * is dropped. Only the code survives on the LlmError; each one has its own phrase key.
 */
export type LlmErrorCode = "auth" | "quota" | "rate_limit" | "context_length" | "content_filter" | "invalid_response" | "network" | "timeout" | "http" | "config";
export const LLM_ERROR_CODES: readonly LlmErrorCode[] = ["auth", "quota", "rate_limit", "context_length", "content_filter", "invalid_response", "network", "timeout", "http", "config"];
/** Retrying the same request can't help: a bad key, no credit, a too long context, a content check. */
export const NO_RETRY: ReadonlySet<LlmErrorCode> = new Set(["auth", "quota", "context_length", "content_filter"]);
export interface LlmErrorDetails extends ModelIdentity { kind: LlmErrorKind; status?: number; attempts: number; code?: LlmErrorCode }
/** The phrase key for each code (backend/src/i18n/*.json). */
export const LLM_ERROR_PHRASE: Record<LlmErrorCode, string> = {
  auth: "system.model_auth",
  quota: "system.model_quota",
  rate_limit: "system.model_rate_limit",
  context_length: "system.model_context_length",
  content_filter: "system.model_content_filter",
  invalid_response: "system.model_invalid_response",
  network: "system.model_network",
  timeout: "system.model_timeout",
  http: "system.model_error",
  config: "system.model_config",
};
/** The code an error has when nothing more specific was found (old call sites pass only kind/status). */
export function defaultCode(kind: LlmErrorKind, status?: number): LlmErrorCode {
  if (kind !== "http") return kind;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 413) return "context_length";
  return "http";
}
export class LlmError extends Error implements LlmErrorDetails {
  readonly kind: LlmErrorKind;
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly attempts: number;
  constructor(details: LlmErrorDetails) {
    super(`Model request failed (${details.status !== undefined ? `HTTP ${details.status}` : details.kind}; attempts ${details.attempts})`);
    this.name = "LlmError";
    this.kind = details.kind;
    this.code = details.code ?? defaultCode(details.kind, details.status);
    this.status = details.status;
    this.providerId = details.providerId;
    this.modelId = details.modelId;
    this.attempts = details.attempts;
  }
  /** The grey line / model_error card text: one key per code, the HTTP status as a number param when there is one. */
  toPhrase(): Phrase {
    const key = LLM_ERROR_PHRASE[this.code];
    return this.status !== undefined ? { key, params: { status: { type: "number", value: this.status } } } : { key };
  }
}
/** Internal validation errors are deliberately constant, not model-supplied text. `where` is a
 *  fixed code for the check that failed (logged to tell gateway faults apart). */
export class InvalidModelResponse extends Error {
  readonly where: string;
  constructor(where = "response") { super("Invalid model response"); this.name = "InvalidModelResponse"; this.where = where; }
}
export class UnsupportedRequest extends Error {
  constructor() { super("Unsupported model request"); this.name = "UnsupportedRequest"; }
}

// Fixed patterns matched against the SDK error's code / type and its message. The message (which can
// echo the body, and through it the prompt) is only tested here and never kept, logged or shown.
// Only content-check codes and phrases: a bare "sensitive" / "safety" / "moderation" also names
// unrelated bad requests ("case sensitive", a `safety_settings` parameter), which must stay `http`.
const CONTENT_FILTER = /content[\s_-]?(filter|polic|management|moderation|check|rejected|risk)|content exists risk|data[\s_-]?inspection|\bflagged\b|inappropriate[\s_-]?content|sensitive[\s_-]?(content|words?)|safety[\s_-]?system|敏感(词|内容|信息)|违规|内容(安全|审核)|审核(未|不)通过/i;
// Narrower than "any length": a bare "length" or "tokens" also names unrelated bad requests.
const CONTEXT_LENGTH = /context[\s_-]?(length|window|limit)|maximum context|context.{0,40}(exceed|too)|too[\s_-]?(long|large)|(prompt|input|request|message)s?.{0,20}(is|are) too|tokens?.{0,30}(exceed|limit|maximum)|(exceed|over).{0,30}tokens?|上下文|过长|超长|超出.{0,10}(长度|限制)/i;
const QUOTA = /quota|billing|insufficient|balance|credit|payment|余额|欠费|额度/i;
function texts(error: object): { codes: string[]; message: string } {
  const codes: string[] = [];
  const messages: string[] = [];
  const take = (value: unknown, into: string[]) => { if (typeof value === "string" && value.length <= 2000) into.push(value); };
  const record = error as Record<string, unknown>;
  take(record.code, codes); take(record.type, codes); take(record.message, messages);
  // SDK shapes: openai APIError { code, type, error: { code, type, message } };
  // anthropic APIError { error: { type, error: { type, message } } }.
  const body = record.error;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    take(b.code, codes); take(b.type, codes); take(b.message, messages);
    const inner = b.error;
    if (inner && typeof inner === "object") {
      const i = inner as Record<string, unknown>;
      take(i.code, codes); take(i.type, codes); take(i.message, messages);
    }
  }
  return { codes, message: messages.join("\n") };
}
/**
 * The code for an HTTP failure from the SDK error: auth (401/403), quota (402, or a 429 whose code /
 * type names quota or billing), rate_limit (other 429), content_filter (a 400 that names a content
 * check), context_length (a 400 that names the context / length / tokens, or any 413), else http.
 */
export function classifyHttp(status: number, error: unknown): LlmErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  const { codes, message } = error && typeof error === "object" ? texts(error) : { codes: [], message: "" };
  const code = codes.join(" ");
  if (status === 429) return QUOTA.test(code) ? "quota" : "rate_limit";
  if (status === 413) return "context_length";
  if (status === 400) {
    if (CONTENT_FILTER.test(code) || CONTENT_FILTER.test(message)) return "content_filter";
    if (CONTEXT_LENGTH.test(code) || CONTEXT_LENGTH.test(message)) return "context_length";
  }
  return "http";
}
