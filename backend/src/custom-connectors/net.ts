// Outbound HTTP for M11 (MCP servers, domain-bound API keys, GitHub skill imports): https only,
// every hostname must resolve to public addresses only (the private / reserved ranges of
// web/fetch.ts), redirects are never followed automatically, and bodies are read with a byte cap
// and a deadline. The real request goes through network/pool.ts: each new connection resolves the
// hostname and connects only to checked addresses (SNI + certificate for the hostname), and a
// kept-alive connection is reused. Tests inject `fetch` and `lookup` (checked here, then `fetch`).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fakeIpPolicy, isPublicAddress } from "../network/address-policy.ts";
import { addressErrorOf, sharedPool, type AddressError } from "../network/pool.ts";
export { isPublicAddress } from "../network/address-policy.ts";

export type Lookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;
export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
export interface NetDeps { fetch?: Fetch; lookup?: Lookup }

export class NetError extends Error {
  constructor(message: string, readonly kind: "blocked" | "unreachable" | "timeout" | "too_large" | "invalid" = "unreachable") {
    super(message);
    this.name = "NetError";
  }
}


const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOCAL_SUFFIX = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/;

/** A public DNS name: lowercase, dotted, no IP literal, no local-only suffix. */
export function normalizeDomain(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host) || isIP(host) || LOCAL_SUFFIX.test(host)) return null;
  return host;
}

/** host is the domain itself or one of its subdomains. */
export const withinDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The first public address of a hostname; throws NetError("blocked") if any address is private. */
export async function resolvePublic(hostname: string, lookup: Lookup = dnsLookup): Promise<string> {
  await fakeIpPolicy.ensure();
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new NetError("That address is private or reserved.", "blocked");
    return host;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new NetError(`${host} couldn't be found.`, "unreachable");
  }
  if (!addresses.length) throw new NetError(`${host} couldn't be found.`, "unreachable");
  for (const entry of addresses) {
    if (!isPublicAddress(entry.address)) throw new NetError(`${host} points to a private or reserved address.`, "blocked");
  }
  return addresses[0]!.address;
}

/** The pool's refusal of a new connection, in resolvePublic's words. */
export function netErrorOf(error: AddressError): NetError {
  if (error.kind === "not_found") return new NetError(`${error.host} couldn't be found.`, "unreachable");
  return new NetError(error.literal ? "That address is private or reserved." : `${error.host} points to a private or reserved address.`, "blocked");
}

/** A URL we may call: https, no credentials in it, a hostname (not an IP literal). */
export function checkHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetError("That isn't a valid URL.", "invalid");
  }
  if (url.protocol !== "https:") throw new NetError("Only https addresses are allowed.", "invalid");
  if (url.username || url.password) throw new NetError("Credentials in the URL aren't allowed.", "invalid");
  if (!normalizeDomain(url.hostname)) throw new NetError("Use a public host name.", "blocked");
  return url;
}

export interface SendInit { method: string; headers: Record<string, string>; body?: string | Uint8Array | null; timeoutMs: number; signal?: AbortSignal }

/**
 * One request (no redirect following) over the pool: a new connection resolves the hostname and
 * goes only to checked public addresses; a kept-alive one is reused. Returns the response and a
 * deadline-bound signal for reading it. `done()` (after reading) also drops a body left unread.
 */
export async function send(url: URL, init: SendInit, deps: NetDeps = {}): Promise<{ response: Response; done: () => void; signal: AbortSignal }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, init.timeoutMs);
  let response: Response | undefined;
  const done = () => {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
    if (response?.body && !response.bodyUsed && !response.body.locked) void response.body.cancel().catch(() => {});
  };
  try {
    const body = init.body ?? undefined;
    const base = { method: init.method, headers: init.headers, redirect: "manual" as const, signal: controller.signal, ...(body !== undefined ? { body: body as NonNullable<RequestInit["body"]> } : {}) };
    if (deps.fetch) {
      await resolvePublic(url.hostname, deps.lookup);
      response = await deps.fetch(url, base);
    } else response = await sharedPool(deps.lookup).fetch(url, base);
    return { response, done, signal: controller.signal };
  } catch (error) {
    done();
    if (error instanceof NetError) throw error;
    const refused = addressErrorOf(error);
    if (refused) throw netErrorOf(refused);
    if (controller.signal.aborted) throw new NetError("The server took too long to answer.", "timeout");
    throw new NetError("The server couldn't be reached.", "unreachable");
  }
}

/** The first `limit` bytes of the body (the rest is dropped), before the deadline. */
export async function readUpTo(response: Response, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new NetError("The server took too long to answer.", "timeout");
      if (part.done) break;
      const room = limit - size;
      if (part.value.byteLength > room) {
        if (room > 0) chunks.push(part.value.subarray(0, room));
        size = limit;
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
      chunks.push(part.value);
      size += part.value.byteLength;
    }
  } catch (error) {
    if (error instanceof NetError) throw error;
    throw new NetError(signal.aborted ? "The server took too long to answer." : "The connection was cut.", signal.aborted ? "timeout" : "unreachable");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return { bytes: out, truncated };
}

/** The body, at most `limit` bytes (else NetError too_large), before the deadline. */
export async function readCapped(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new NetError(`The answer is larger than ${Math.round(limit / 1024)} KB.`, "too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new NetError("The server took too long to answer.", "timeout");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new NetError(`The answer is larger than ${Math.round(limit / 1024)} KB.`, "too_large");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof NetError) throw error;
    throw new NetError(signal.aborted ? "The server took too long to answer." : "The connection was cut.", signal.aborted ? "timeout" : "unreachable");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
