// M12: the provider's own model list (verify, GET /remote-models) and the models.dev fetch. One
// request, no redirects followed, a deadline, a capped body. The key goes only into the request
// headers; every failure reason is plain words built here (status code, "the key was refused",
// "couldn't reach <host>"), never a provider's body, and never the URL's path.
import { NetError, readCapped } from "../custom-connectors/net.ts";
import type { Fetch } from "../llm/index.ts";
import { authHeaders, modelListUrl, type AuthStyle, type Protocol } from "./presets.ts";

/** A provider's list answer: at most 5 MB. */
export const LIST_BYTES = 5 * 1024 * 1024;
export const VERIFY_TIMEOUT_MS = 15_000;

export type GetResult =
  | { ok: true; status: number; body: Uint8Array }
  | { ok: false; kind: "unreachable" | "timeout" | "too_large" };

/** GET with a deadline (headers and body), `redirect: manual` (a 3xx is answered as its status). */
export async function getCapped(fetchImpl: Fetch, url: string, headers: Record<string, string>, timeoutMs: number, limit: number, signal?: AbortSignal): Promise<GetResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: deadline });
    } catch {
      return { ok: false, kind: controller.signal.aborted ? "timeout" : "unreachable" };
    }
    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => {});
      return { ok: true, status: response.status, body: new Uint8Array() };
    }
    try {
      return { ok: true, status: response.status, body: await readCapped(response, limit, deadline) };
    } catch (error) {
      const kind = error instanceof NetError && error.kind === "too_large" ? "too_large" : controller.signal.aborted ? "timeout" : "unreachable";
      return { ok: false, kind };
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface ListedModel { id: string; label: string | null }

/**
 * The ids of an OpenAI-style `{data:[{id}]}` / Anthropic `{data:[{id, display_name}]}` list (also a
 * bare array, or `{models:[{id|name}]}` of some gateways). `models/` prefixes (Gemini) are dropped.
 * null = not a model list.
 */
export function parseModelList(body: Uint8Array): ListedModel[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : Array.isArray((raw as { models?: unknown }).models) ? (raw as { models: unknown[] }).models : null)
      : null;
  if (!list) return null;
  const seen = new Map<string, ListedModel>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawId = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : null;
    const id = rawId?.trim().replace(/^models\//, "");
    if (!id || id.length > 200 || seen.has(id)) continue;
    const display = typeof record.display_name === "string" ? record.display_name.trim() : "";
    seen.set(id, { id, label: display ? display.slice(0, 80) : null });
  }
  return [...seen.values()];
}

export interface ListTarget { kind: string; protocol: Protocol; baseUrl: string; auth: AuthStyle | null; headers: { name: string; value: string }[] }

/**
 * The verdict of one model-list request (contract §1): `list` (2xx and a parseable list; a custom
 * gateway answering 404 / 405 / 501 has no list: empty), or a failure with the field it's about and
 * the reason in plain words.
 */
export type ListVerdict =
  | { ok: true; models: ListedModel[]; noList: boolean }
  | { ok: false; field: "key" | "baseUrl"; reason: string };

export const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "the provider";
  }
};

export async function fetchModelList(target: ListTarget, key: string, fetchImpl: Fetch, timeoutMs = VERIFY_TIMEOUT_MS, signal?: AbortSignal): Promise<ListVerdict> {
  const host = hostOf(target.baseUrl);
  const result = await getCapped(fetchImpl, modelListUrl(target.protocol, target.baseUrl), authHeaders(target.protocol, target.auth, key, target.headers), timeoutMs, LIST_BYTES, signal);
  if (!result.ok) {
    if (result.kind === "too_large") return { ok: false, field: "baseUrl", reason: `${host} answered with a model list over 5 MB` };
    return { ok: false, field: "baseUrl", reason: `couldn't reach ${host}` };
  }
  if (result.status === 401 || result.status === 403) return { ok: false, field: "key", reason: "the key was refused" };
  if (target.kind === "custom" && [404, 405, 501].includes(result.status)) return { ok: true, models: [], noList: true };
  if (result.status < 200 || result.status >= 300) return { ok: false, field: "baseUrl", reason: `${host} answered ${result.status}` };
  const models = parseModelList(result.body);
  if (!models) return { ok: false, field: "baseUrl", reason: `${host} answered without a model list` };
  return { ok: true, models, noList: false };
}
