import type { Fetch } from "../llm/index.ts";

export class WebError extends Error {}
/** Safe to expose: no request URL, credentials or provider body is retained. */
export class ServiceUnavailable extends WebError {}
export class HttpStatusError extends WebError {
  constructor(readonly status: number) { super(`Service returned HTTP ${status}`); }
}
export interface HttpDeps { fetch?: Fetch; signal?: AbortSignal }

/** Includes DNS, connection, redirects and a stalled/non-cooperative body reader. */
export async function withDeadline<T>(signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 15_000);
  try { return await abortable(fn(controller.signal), controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ServiceUnavailable("Request timed out or cancelled"));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readBody(response: Response, signal: AbortSignal, limit = 2 * 1024 * 1024): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new WebError("Response exceeds 2 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) { complete = true; break; }
      size += part.value.byteLength;
      if (size > limit) throw new WebError("Response exceeds 2 MB");
      chunks.push(part.value);
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Fixed operator-configured services only; user URLs must use fetchPublic in fetch.ts. */
export async function serviceJson(url: URL, deps: HttpDeps, signal: AbortSignal): Promise<unknown> {
  const response = await abortable((deps.fetch ?? fetch)(url, { signal, redirect: "error", headers: { accept: "application/json" } }), signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new HttpStatusError(response.status);
  }
  return JSON.parse(new TextDecoder().decode(await readBody(response, signal)));
}
