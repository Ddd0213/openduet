// M12 provider presets (contract §1): the protocol, default URL, model-list request and auth of each
// kind. `custom` takes the request's protocol and URL. Only non-secret data lives here.

import { VOICE_ENDPOINTS } from "../contract/m27voice.ts";

export type ProviderKind = "openai" | "anthropic" | "gemini" | "stepfun" | "custom";
export type Protocol = "openai" | "anthropic";
export type AuthStyle = "x-api-key" | "bearer";

export interface Preset {
  kind: Exclude<ProviderKind, "custom">;
  protocol: Protocol;
  baseUrl: string;
  /** the display name a new provider gets */
  name: string;
  /** the models.dev provider key its model ids are looked up under */
  catalogKey: string;
  /** how "no thinking" goes on the openai wire for a model that has levels (gemini: "none") */
  reasoningOff: "omit" | "none";
  /** the anthropic preset's models get promptCaching on when added */
  promptCaching: boolean;
}

export const PRESETS: Record<Preset["kind"], Preset> = {
  openai: { kind: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", name: "OpenAI", catalogKey: "openai", reasoningOff: "omit", promptCaching: false },
  anthropic: { kind: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", name: "Anthropic", catalogKey: "anthropic", reasoningOff: "omit", promptCaching: true },
  gemini: { kind: "gemini", protocol: "openai", baseUrl: VOICE_ENDPOINTS.gemini.chatBaseUrl, name: "Google Gemini", catalogKey: "google", reasoningOff: "none", promptCaching: false },
  stepfun: { kind: "stepfun", protocol: "openai", baseUrl: VOICE_ENDPOINTS["stepfun:cn"].chatBaseUrl, name: "StepFun", catalogKey: "stepfun", reasoningOff: "omit", promptCaching: false },
};

export const presetOf = (kind: string): Preset | null => (kind in PRESETS ? PRESETS[kind as Preset["kind"]] : null);

/** The model-list URL: openai protocol `{base}/models`, anthropic `{base}/v1/models?limit=1000`. */
export function modelListUrl(protocol: Protocol, baseUrl: string): string {
  return protocol === "anthropic" ? `${baseUrl}/v1/models?limit=1000` : `${baseUrl}/models`;
}

/**
 * The request headers for a provider, in the order chat uses (llm/adapters/common.ts secureFetch):
 * the defaults (Accept; anthropic-version), then the extra headers (which win over a default of the
 * same name in any case), then the auth header, which always wins. anthropic: x-api-key or Bearer.
 */
export function authHeaders(protocol: Protocol, auth: AuthStyle | null, key: string, extra: readonly { name: string; value: string }[] = []): Record<string, string> {
  const headers = new Headers({ Accept: "application/json" });
  if (protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
  for (const header of extra) headers.set(header.name, header.value);
  headers.delete("authorization");
  headers.delete("x-api-key");
  if (protocol === "anthropic" && (auth ?? "x-api-key") !== "bearer") headers.set("x-api-key", key);
  else headers.set("authorization", `Bearer ${key}`);
  return Object.fromEntries(headers.entries());
}

/** Same rule as llm/config.ts: credentials go in the key, never in a header. */
export const CREDENTIAL_HEADER = /(authorization|cookie|secret|token|api[-_]?key|credential)/i;
/** Transport headers the HTTP client owns (an extra header with one of these names is refused). */
export const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);
