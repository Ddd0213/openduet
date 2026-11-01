// call_api (M11): one HTTP request with a domain-bound API key. The URL must be https and its host
// the connector's domain or a subdomain, resolving to public addresses only; the server adds
// `<headerName>: <valuePrefix><key>` itself (the model can't set or see that header); redirects are
// followed only inside the domain (<= 3 hops); the key is redacted from the answer, then it's cut
// at 24 KB (in that order, so a key crossing the cut can't show through as a prefix).
import { z } from "zod";
import { checkHttpsUrl, NetError, readUpTo, send, withinDomain, type NetDeps } from "./net.ts";
import { redactClip, redactText } from "./redact.ts";
import { textOf } from "../skills/folder.ts";

export const ANSWER_MAX = 24 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_HOPS = 3;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/**
 * Never forwarded from the model (compared lower-case): transport headers, anything that could
 * re-route the request, and method overrides (a GET runs without approval, so it can't be turned
 * into a write on the server's side).
 */
const DROPPED = new Set([
  "host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive", "proxy-authorization", "proxy-connection", "cookie", "expect",
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
  "x-http-method-override", "x-http-method", "x-method-override",
]);
const SHOWN_HEADERS = ["content-type", "location", "retry-after", "x-ratelimit-remaining", "ratelimit-remaining"];

export const ApiCall = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1).max(4000),
  headers: z.record(z.string().regex(HEADER_NAME, "a header name"), z.string().max(4000).regex(/^[^\r\n\0]*$/, "one line")).optional(),
  body: z.union([z.string().max(200_000), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
}).strict();
export type ApiCall = z.infer<typeof ApiCall>;

export interface ApiKeyBinding { domain: string; headerName: string; valuePrefix: string; key: string }

export type ApiOutcome =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated: boolean }
  | { ok: false; error: string };

export const isRead = (method: string) => method === "GET" || method === "HEAD";

/** The URL is allowed for this binding (https, host inside the domain). */
export function checkBound(raw: string, domain: string): URL | string {
  let url: URL;
  try {
    url = checkHttpsUrl(raw);
  } catch (error) {
    return error instanceof NetError ? error.message : "That isn't a valid URL.";
  }
  if (!withinDomain(url.hostname.toLowerCase(), domain)) return `This key only works for ${domain} and its subdomains, not ${url.hostname}.`;
  return url;
}

/**
 * What of the model's request leaves the server: the url, the headers that are forwarded (the
 * key's own header and transport headers are dropped) and a body (never for GET / HEAD). M20: the
 * credential check (agent/outbound-credentials.ts) scans exactly this, before the key is added.
 */
export function outboundParts(call: ApiCall, headerName: string): { url: string; headers: Record<string, string>; body?: ApiCall["body"] } {
  const auth = headerName.toLowerCase();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(call.headers ?? {})) {
    const lower = name.toLowerCase();
    // The key's header is the server's alone; transport headers are never forwarded.
    if (lower === auth || DROPPED.has(lower)) continue;
    headers[lower] = value;
  }
  return { url: call.url, headers, ...(call.body !== undefined && !isRead(call.method) ? { body: call.body } : {}) };
}

export async function callApi(binding: ApiKeyBinding, call: ApiCall, net: NetDeps = {}, signal?: AbortSignal): Promise<ApiOutcome> {
  const secrets = [binding.key, `${binding.valuePrefix}${binding.key}`];
  const first = checkBound(call.url, binding.domain);
  if (typeof first === "string") return { ok: false, error: first };
  const auth = binding.headerName.toLowerCase();
  const sent = outboundParts(call, binding.headerName);
  const headers = sent.headers;
  let body: string | undefined;
  if (sent.body !== undefined) {
    if (typeof sent.body === "string") body = sent.body;
    else {
      body = JSON.stringify(sent.body);
      headers["content-type"] ??= "application/json";
    }
  }
  headers[auth] = `${binding.valuePrefix}${binding.key}`;
  let url = first;
  let method: string = call.method;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let sent;
    try {
      sent = await send(url, { method, headers, ...(body !== undefined ? { body } : {}), timeoutMs: TIMEOUT_MS, ...(signal ? { signal } : {}) }, net);
    } catch (error) {
      return { ok: false, error: redactText(error instanceof NetError ? error.message : "The request failed.", secrets) };
    }
    const { response, done, signal: read } = sent;
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || hop === MAX_HOPS) return { ok: false, error: hop === MAX_HOPS ? "Too many redirects." : "A redirect without a destination." };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { ok: false, error: "A redirect to an invalid address." };
        }
        const bound = checkBound(next.href, binding.domain);
        if (typeof bound === "string") return { ok: false, error: `The API redirected to another host (${redactText(next.hostname, secrets)}); not followed, the key only goes to ${binding.domain}.` };
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          delete headers["content-type"];
        }
        url = bound;
        continue;
      }
      // The longest secret's length past the cut, so a key crossing it is read whole and redacted.
      const { bytes, truncated } = await readUpTo(response, ANSWER_MAX + Math.max(...secrets.map((s) => Buffer.byteLength(s))), read);
      const type = response.headers.get("content-type") ?? "";
      // A cut answer may end inside a character: decode leniently then (NUL bytes still mean binary).
      let text = textOf(bytes) ?? (truncated && !bytes.includes(0) ? new TextDecoder().decode(bytes).replace(/\uFFFD+$/, "") : null);
      if (text === null) text = `[${bytes.length} bytes of ${type || "binary data"}, not shown]`;
      const shown: Record<string, string> = {};
      for (const name of SHOWN_HEADERS) {
        const value = response.headers.get(name);
        // Redacted whole, then cut.
        if (value) shown[name] = redactText(value, secrets).slice(0, 500);
      }
      const clipped = redactClip(text, secrets, ANSWER_MAX, truncated);
      return { ok: true, status: response.status, headers: shown, body: clipped.text, truncated: truncated || clipped.truncated };
    } catch (error) {
      return { ok: false, error: redactText(error instanceof NetError ? error.message : "The answer couldn't be read.", secrets) };
    } finally {
      done();
    }
  }
  return { ok: false, error: "Too many redirects." };
}
