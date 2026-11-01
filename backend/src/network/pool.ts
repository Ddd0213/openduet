// Pooled outbound HTTP(S) for user-chosen hosts (M29 net). Requests go to the hostname, so a
// keep-alive socket is reused instead of a new TCP + TLS handshake per request (Bun's fetch never
// reuses a connection made to a pinned IP). The SSRF check moved to the connection: every new
// socket resolves its hostname in `connect.lookup` and connects only if every answer passes the
// address policy (public, fake-IP per fakeIpPolicy); a pooled socket is already connected to a
// checked address. TLS verifies the certificate for the hostname; redirects are never followed.
//
// Real undici is loaded from its file: `import "undici"` in Bun is a built-in stand-in that ignores
// `connect.lookup` (no check at all), and undici's own fetch stalls under Bun 1.3 once a body spans
// more than one socket read (SSE, large answers). So requests use the dispatcher API
// (Agent.request) and the Response is built here from Bun's own classes (instanceof keeps working).
import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import { constants, createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type * as Undici from "undici";
import { fakeIpPolicy, isPublicAddress } from "./address-policy.ts";

const load = createRequire(import.meta.url);
const undici = load(load.resolve("undici/index.js")) as typeof Undici;

export type Lookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;

/** A new connection was refused: `blocked` (an address outside the policy) or `not_found` (no DNS answer). */
export class AddressError extends Error {
  readonly code = "EADDRBLOCKED";
  constructor(readonly kind: "blocked" | "not_found", readonly host: string, readonly literal = false) {
    super(kind === "blocked" ? "address not allowed" : "host not found");
    this.name = "AddressError";
  }
}

/** The AddressError behind a failed request (fetch wraps it as the cause), if any. */
export function addressErrorOf(error: unknown): AddressError | null {
  for (let at = error, depth = 0; at && typeof at === "object" && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof AddressError) return at;
  }
  return null;
}

export interface PoolOptions {
  /** resolver (default: the system's); tests inject one */
  lookup?: Lookup;
  /** address policy (default: isPublicAddress with fakeIpPolicy); tests allow a loopback server */
  allow?: (address: string) => boolean;
  /** extra trusted CA (tests only) */
  ca?: string;
  /** idle keep-alive socket lifetime (default 30 s; a shorter Keep-Alive hint from the server wins) */
  keepAliveMs?: number;
}

export interface Pool {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const systemLookup: Lookup = (hostname, options) => dnsLookup(hostname, options);
// undici computes these itself or refuses them (it throws on transfer-encoding / keep-alive / upgrade / expect).
const DROPPED = ["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "expect"];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([204, 205, 304]);
// Same defaults Bun's fetch sends (zstd left out: not decoded here).
const DEFAULTS: [string, string][] = [["user-agent", `Bun/${Bun.version}`], ["accept", "*/*"], ["accept-encoding", "gzip, deflate, br"]];
const FLUSH = { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH };
const DECODERS: Record<string, () => NodeJS.ReadWriteStream> = {
  gzip: () => createGunzip(FLUSH), "x-gzip": () => createGunzip(FLUSH), deflate: () => createInflate(FLUSH),
  br: () => createBrotliDecompress({ flush: constants.BROTLI_OPERATION_FLUSH, finishFlush: constants.BROTLI_OPERATION_FLUSH }),
};

/** Every answer must pass (one private answer refuses the host, as before); IP literals are checked as they are. */
async function resolveChecked(hostname: string, lookup: Lookup, allow: (address: string) => boolean): Promise<{ address: string; family: number }[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!allow(host)) throw new AddressError("blocked", host, true);
    return [{ address: host, family: isIP(host) }];
  }
  let answers: { address: string; family: number }[];
  try { answers = await lookup(host, { all: true }); } catch { throw new AddressError("not_found", host); }
  const checked = (answers ?? []).map(entry => ({ address: entry.address, family: isIP(entry.address) }));
  if (!checked.length) throw new AddressError("not_found", host);
  if (checked.some(entry => !entry.family || !allow(entry.address))) throw new AddressError("blocked", host);
  return checked;
}
/**
 * undici's connector with the check in front: `lookup` (net.connect calls it for every new socket,
 * Bun also for IP literals) resolves and checks; literals are also checked before connecting; the
 * peer certificate is checked for the hostname once more (Bun skips the name check for IP literals).
 */
function guardedConnector(options: PoolOptions): Undici.buildConnector.connector {
  const lookup = options.lookup ?? systemLookup;
  const allow = options.allow ?? ((address: string) => isPublicAddress(address));
  const checkedLookup = ((hostname: string, opts: { all?: boolean; family?: number | string }, callback: (...args: unknown[]) => void) => {
    resolveChecked(hostname, lookup, allow).then(addresses => {
      if (opts?.all) return callback(null, addresses);
      const pick = addresses.find(entry => entry.family === Number(opts?.family)) ?? addresses[0]!;
      callback(null, pick.address, pick.family);
    }, error => callback(error, opts?.all ? [] : "", 0));
  }) as unknown as LookupFunction;
  const base = undici.buildConnector({ lookup: checkedLookup, timeout: 30_000, rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) });
  return (connect, callback) => {
    void (async () => {
      if (!options.allow) await fakeIpPolicy.ensure();
      const host = connect.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && !allow(host)) throw new AddressError("blocked", host, true);
      base(connect, (error, socket) => {
        if (error || !socket) return callback(error ?? new Error("connect failed"), null);
        if (connect.protocol === "https:") {
          let identity: Error | undefined;
          try { identity = checkServerIdentity(host, (socket as TLSSocket).getPeerCertificate()); } catch (failed) { identity = failed instanceof Error ? failed : new Error("certificate check failed"); }
          if (identity) { socket.destroy(); return callback(identity, null); }
        }
        callback(null, socket as Socket);
      });
    })().catch(error => callback(error instanceof Error ? error : new Error(String(error)), null));
  };
}

export function createPool(options: PoolOptions = {}): Pool {
  const agent = new undici.Agent({
    connect: guardedConnector(options),
    // 120 s: an approval card is usually tapped a minute or two after it's posted, and the MCP
    // connection warmed then (custom-connectors/mcp.ts mcpWarmUp) should still be there. Notion's
    // edge kept an idle connection for 200 s in tests; a shorter Keep-Alive hint from a server wins.
    keepAliveTimeout: options.keepAliveMs ?? 120_000,
    keepAliveMaxTimeout: 120_000,
    // Every caller has its own deadline (AbortSignal); an SSE stream may sit idle for minutes.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return { fetch: (input, init) => poolFetch(agent, input, init), close: () => agent.close() };
}

let shared: Pool | undefined;
const byLookup = new WeakMap<Lookup, Pool>();
/** The process-wide pool (the system resolver), or one per injected resolver (tests). */
export function sharedPool(lookup?: Lookup): Pool {
  if (!lookup) return shared ??= createPool();
  let pool = byLookup.get(lookup);
  if (!pool) byLookup.set(lookup, pool = createPool({ lookup }));
  return pool;
}
/** Bytes or text for undici (a FormData / Blob / stream body is serialized as Bun's fetch would). */
async function bodyOf(body: RequestInit["body"], headers: Headers): Promise<string | Uint8Array | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const packed = new Response(body);
  const type = packed.headers.get("content-type");
  if (type && !headers.has("content-type")) headers.set("content-type", type);
  return new Uint8Array(await packed.arrayBuffer());
}

async function poolFetch(agent: Undici.Agent, input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("fetch failed", { cause: new Error("unsupported protocol") });
  const headers = new Headers(request?.headers);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const body = init.body !== undefined ? await bodyOf(init.body, headers) : request?.body ? new Uint8Array(await request.arrayBuffer()) : null;
  for (const name of DROPPED) headers.delete(name);
  for (const [name, value] of DEFAULTS) if (!headers.has(name)) headers.set(name, value);
  const method = (init.method ?? request?.method ?? "GET").toUpperCase();
  const signal = init.signal ?? request?.signal ?? undefined;
  const redirect = init.redirect ?? request?.redirect ?? "error";
  if (signal?.aborted) throw signal.reason;
  // undici hands a finished keep-alive socket back to its pool one setImmediate later
  // (client-h1.js onMessageComplete); dispatching before that opens a second connection.
  await new Promise<void>(resolve => setImmediate(resolve));
  let result: Undici.Dispatcher.ResponseData;
  try {
    result = await agent.request({
      origin: url.origin, path: `${url.pathname}${url.search}`, method,
      headers: Object.fromEntries(headers), body, ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new TypeError("fetch failed", { cause: error });
  }
  const { statusCode: status, body: source } = result;
  source.on("error", () => {});
  if (redirect !== "manual" && REDIRECTS.has(status)) {
    void source.dump({ limit: 65_536 }).catch(() => {});
    throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
  }
  try {
    const out = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) out.append(name, one);
    }
    if (method === "HEAD" || NULL_BODY.has(status)) {
      void source.dump({ limit: 65_536 }).catch(() => {});
      return new Response(null, { status, statusText: result.statusText ?? "", headers: out });
    }
    return new Response(webStream(decoded(source, out)), { status, statusText: result.statusText ?? "", headers: out });
  } catch (error) {
    source.destroy();
    throw new TypeError("fetch failed", { cause: error });
  }
}

/** The body decoded like fetch does (gzip / deflate / br; anything else as it came). */
function decoded(source: Readable, headers: Headers): Readable {
  const coding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  const make = DECODERS[coding];
  if (!make || headers.get("content-length") === "0") return source;
  const decoder = make();
  return pipeline(source, decoder, () => {}) as unknown as Readable;
}

/** A web stream over a Node stream: cancel destroys it (undici aborts an unfinished body). */
function webStream(source: Readable): ReadableStream<Uint8Array> {
  const chunks = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value as Uint8Array);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { source.destroy(); },
  });
}
