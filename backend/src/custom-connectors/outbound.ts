// M17: small JSON requests for the MCP Registry and OAuth discovery / registration / tokens, all
// through net.ts's guard: https only, a public host name that resolves to public addresses only
// (the connection goes to the checked address), a byte cap and a deadline. GETs follow at most 3
// redirects, each new address checked again; POSTs never follow one (a token request is never
// re-sent anywhere else). Bodies the far side sends are parsed, never logged or returned as text.
import { checkHttpsUrl, NetError, readCapped, send, type NetDeps } from "./net.ts";

const MAX_HOPS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

export interface JsonAnswer { status: number; headers: Headers; json: unknown; url: URL }

export interface JsonInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** a form (application/x-www-form-urlencoded) or a JSON body (POST only) */
  form?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
}

/** A URL from metadata, the registry or the user: https + a public host name (NetError otherwise). */
export function guardUrl(raw: string | URL): URL {
  return checkHttpsUrl(typeof raw === "string" ? raw : raw.href);
}

/**
 * One JSON request. The answer's JSON is `null` when the body isn't JSON (or is empty). Throws
 * NetError: blocked / invalid for a refused address, unreachable / timeout / too_large otherwise.
 */
export async function requestJson(raw: string | URL, init: JsonInit, net: NetDeps): Promise<JsonAnswer> {
  let url = guardUrl(raw);
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  let body: string | undefined;
  if (method === "POST") {
    if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
  }
  for (let hop = 0; ; hop++) {
    const { response, done, signal } = await send(url, { method, headers, ...(body !== undefined ? { body } : {}), timeoutMs: init.timeoutMs ?? DEFAULT_TIMEOUT_MS }, net);
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (method !== "GET" || !location || hop >= MAX_HOPS) throw new NetError(method !== "GET" ? "The server redirected the request." : "Too many redirects.", "invalid");
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new NetError("A redirect to an invalid address.", "invalid");
        }
        // Checked like the first address (https, public host); DNS is checked again by send().
        url = guardUrl(next);
        continue;
      }
      const bytes = await readCapped(response, init.maxBytes ?? DEFAULT_MAX_BYTES, signal);
      let json: unknown = null;
      if (bytes.length) {
        try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { json = null; }
      }
      return { status: response.status, headers: response.headers, json, url };
    } finally {
      done();
    }
  }
}

/** Capped binary GET for metadata images, with a shared deadline across manual redirects. */
export async function requestBytes(raw: string | URL, init: Pick<JsonInit, "headers" | "timeoutMs" | "maxBytes">, net: NetDeps = {}): Promise<{ status: number; headers: Headers; bytes: Uint8Array; url: URL }> {
  let url = guardUrl(raw);
  const expires = Date.now() + (init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const remaining = expires - Date.now();
    if (remaining <= 0) throw new NetError("The server took too long to answer.", "timeout");
    const { response, done, signal } = await send(url, { method: "GET", headers: init.headers ?? {}, timeoutMs: remaining }, net);
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || hop >= MAX_HOPS) throw new NetError("Too many redirects.", "invalid");
        url = guardUrl(new URL(location, url));
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, headers: response.headers, bytes: new Uint8Array(), url };
      }
      const bytes = await readCapped(response, init.maxBytes ?? DEFAULT_MAX_BYTES, signal);
      return { status: response.status, headers: response.headers, bytes, url };
    } finally { done(); }
  }
}

/** A JSON object, or null. */
export const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A trimmed non-empty string, or null. */
export const textOf = (value: unknown, max = 2000): string | null =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
