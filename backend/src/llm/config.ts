// models.json is strict JSON (no comments). providers: unique id, protocol,
// baseUrl, apiKeyEnv (an environment variable NAME, never a key), optional
// anthropic auth (x-api-key by default, or bearer), and non-secret headers.
// models: globally unique gateway id, provider id, display label, positive
// contextWindow/maxOutputTokens, and five boolean capabilities. MODEL_* values
// select model ids in preference order. Relative MODELS_FILE paths use backend/.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Config } from "../config.ts";
import { MODEL_ROLES, type ModelConfig, type Capabilities } from "./types.ts";

const nonempty = z.string().trim().min(1);
// Gateway identifiers are exact: reject surrounding whitespace rather than rewriting it.
const gatewayId = z.string().min(1).refine(value => value === value.trim(), "must not have surrounding whitespace");
const capabilities = z.object({ tools: z.boolean(), vision: z.boolean(), thinking: z.boolean(), serverWebTools: z.boolean(), promptCaching: z.boolean() }).strict();
const schema = z.object({
  providers: z.array(z.object({
    id: nonempty, protocol: z.enum(["anthropic", "openai"]), baseUrl: nonempty,
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    auth: z.enum(["x-api-key", "bearer"]).optional(), headers: z.record(z.string(), z.string()).optional(),
  }).strict()).min(1),
  models: z.array(z.object({
    id: gatewayId, provider: nonempty, label: nonempty,
    contextWindow: z.number().int().positive(), maxOutputTokens: z.number().int().positive(), capabilities,
  }).strict()).min(1),
}).strict();
export type ModelSettings = Pick<Config, "MODELS_FILE" | "LLM_PROTOCOL" | "LLM_BASE_URL" | "LLM_MODEL" | "LLM_AUTH_HEADER" | "LLM_CAPABILITIES" | "MODEL_CHAT" | "MODEL_TASK" | "MODEL_PROACTIVE" | "MODEL_UTILITY" | "LLM_TIMEOUT_SECONDS" | "LLM_ALLOW_INSECURE_HOSTS">;
export class ModelConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid model configuration:\n${problems.map(p => `  - ${p}`).join("\n")}`);
    this.name = "ModelConfigError";
  }
}
function fieldPath(path: PropertyKey[]): string {
  return path.map((v, i) => typeof v === "number" ? `[${v}]` : `${i ? "." : ""}${String(v)}`).join("");
}
/** No credentials, queries, or fragments are permitted in a gateway URL. */
export function normalizeBaseUrl(value: string, protocol: "anthropic" | "openai", allowedHosts: readonly string[] = []): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("must be an absolute URL"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("must not contain credentials, query parameters, or a fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(host) || allowedHosts.some(h => h.toLowerCase().replace(/^\[|\]$/g, "") === host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`must be https (host ${host} is not localhost or in LLM_ALLOW_INSECURE_HOSTS)`);
  }
  const normalized = url.toString().replace(/\/+$/, "");
  return protocol === "anthropic" ? normalized.replace(/\/v1$/, "") : normalized;
}
const backendDir = fileURLToPath(new URL("../../", import.meta.url));
export function loadModelConfig(
  config: ModelSettings,
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = path => readFileSync(path, "utf8"),
): ModelConfig {
  const problems: string[] = [];
  let raw: unknown;
  let shortcut = false;
  let text: string;
  try { text = readFile(resolve(backendDir, config.MODELS_FILE)); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new ModelConfigError(["MODELS_FILE could not be read"]);
    }
    shortcut = true;
    text = "";
  }
  if (shortcut) {
    const names = config.LLM_CAPABILITIES.length ? config.LLM_CAPABILITIES : ["tools"];
    const caps: Capabilities = { tools: false, vision: false, thinking: false, serverWebTools: false, promptCaching: false };
    for (const name of names) caps[name as keyof Capabilities] = true;
    raw = {
      providers: [{ id: "gateway", protocol: config.LLM_PROTOCOL, baseUrl: config.LLM_BASE_URL, apiKeyEnv: "LLM_API_KEY", ...(config.LLM_AUTH_HEADER ? { auth: config.LLM_AUTH_HEADER } : {}) }],
      models: [{ id: config.LLM_MODEL, provider: "gateway", label: config.LLM_MODEL, contextWindow: 128000, maxOutputTokens: 8192, capabilities: caps }],
    };
  } else {
    try { raw = JSON.parse(text); } catch { throw new ModelConfigError(["models.json must contain valid JSON (MODELS_FILE)"]); }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const shortcutFields: Record<string, string> = { "providers[0].protocol": "LLM_PROTOCOL", "providers[0].baseUrl": "LLM_BASE_URL", "models[0].id": "LLM_MODEL", "models[0].label": "LLM_MODEL" };
    // Zod issue messages can contain external property names; never include raw input.
    throw new ModelConfigError(result.error.issues.map(issue => {
      const path = fieldPath(issue.path);
      return `${shortcut ? shortcutFields[path] ?? path : `models.json ${path}`} ${issue.code === "unrecognized_keys" ? "contains unsupported fields" : issue.message}`;
    }));
  }
  const { providers, models } = result.data;
  const seenProviders = new Set<string>();
  providers.forEach((provider, i) => {
    const path = `models.json providers[${i}]`;
    if (seenProviders.has(provider.id)) problems.push(`${path}.id is duplicated`);
    seenProviders.add(provider.id);
    if (provider.protocol === "openai" && provider.auth) problems.push(`${path}.auth is only valid for anthropic`);
    if (provider.protocol === "anthropic") provider.auth ??= "x-api-key";
    try { provider.baseUrl = normalizeBaseUrl(provider.baseUrl, provider.protocol, config.LLM_ALLOW_INSECURE_HOSTS); }
    catch (error) { problems.push(`${shortcut ? "LLM_BASE_URL" : `${path}.baseUrl`} ${(error as Error).message}`); }
    if (!env[provider.apiKeyEnv]?.trim()) problems.push(`env var ${provider.apiKeyEnv} (providers[${i}].apiKeyEnv) is empty`);
    for (const [key, value] of Object.entries(provider.headers ?? {})) {
      if (/(authorization|cookie|secret|token|api[-_]?key|credential)/i.test(key)) problems.push(`${path}.headers.${key} must not contain credentials; use apiKeyEnv`);
      else if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)) problems.push(`${path}.headers contains an invalid HTTP header`);
    }
  });
  const byId = new Map(models.map(model => [model.id, model]));
  const seenModels = new Set<string>();
  models.forEach((model, i) => {
    if (seenModels.has(model.id)) problems.push(`models.json models[${i}].id is duplicated`);
    seenModels.add(model.id);
    if (!seenProviders.has(model.provider)) problems.push(`models.json models[${i}].provider: unknown provider "${model.provider}"`);
    if (model.maxOutputTokens > model.contextWindow) problems.push(`models.json models[${i}].maxOutputTokens must not exceed contextWindow`);
  });
  const chat = config.MODEL_CHAT?.trim() || (shortcut ? config.LLM_MODEL : undefined);
  const roles = {} as ModelConfig["roles"];
  for (const role of MODEL_ROLES) {
    const key = `MODEL_${role.toUpperCase()}` as "MODEL_CHAT" | "MODEL_TASK" | "MODEL_PROACTIVE" | "MODEL_UTILITY";
    const chain = config[key]?.trim() || chat;
    roles[role] = chain?.split(",").map(id => id.trim()) ?? [];
    if (!chain) problems.push(`${key} is required (unset roles fall back to MODEL_CHAT)`);
    for (const id of roles[role]) {
      const model = byId.get(id);
      if (!model) problems.push(`${key}: unknown model "${id}"`);
      else if (role !== "utility" && !model.capabilities.tools) problems.push(`${key} model "${id}" lacks the tools capability`);
    }
  }
  if (problems.length) throw new ModelConfigError(problems);
  return { providers, models, roles, timeoutMs: config.LLM_TIMEOUT_SECONDS * 1000 };
}
