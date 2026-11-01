// Retry only before the first canonical event. Deadlines cover connection AND SSE
// reads (SDK timeout alone only covers the initial response on some transports).
import { streamAnthropic } from "./adapters/anthropic.ts";
import { streamOpenai } from "./adapters/openai.ts";
import { classifyHttp, InvalidModelResponse, LlmError, NO_RETRY, UnsupportedRequest, type LlmErrorCode, type LlmErrorKind } from "./errors.ts";
import { log } from "../log.ts";
import type { LlmEvent, LlmOptions, LlmRequest, ModelConfig, ModelIdentity, RegisteredLlm } from "./types.ts";
// Diagnostics for a failed attempt: class names and protocol codes only (an SSE `error` event's
// type, a socket code, InvalidModelResponse.where). Never the SDK message, body, headers or URL,
// which can echo the prompt or the key; anything that isn't a short identifier is dropped.
const SAFE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
function describe(error: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || depth > 1) return undefined;
  const out: Record<string, unknown> = {};
  const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof ctor === "string" && SAFE.test(ctor)) out.class = ctor;
  for (const key of ["name", "type", "code", "where"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && SAFE.test(value)) out[key] = value;
  }
  const inner = (error as { error?: { error?: { type?: unknown } } }).error?.error?.type;
  if (typeof inner === "string" && SAFE.test(inner)) out.errorType = inner;
  const cause = describe((error as { cause?: unknown }).cause, depth + 1);
  if (cause && Object.keys(cause).length) out.cause = cause;
  return out;
}
function details(error: unknown, timedOut: boolean): { kind: LlmErrorKind; code: LlmErrorCode; status?: number; headers?: Headers } {
  if (timedOut) return { kind: "timeout", code: "timeout" };
  if (error instanceof UnsupportedRequest) return { kind: "config", code: "config" };
  if (error instanceof LlmError) return { kind: error.kind, code: error.code, status: error.status };
  // M14: a gateway answer that broke the protocol is not a network fault (kind stays "network" so
  // it is still retried before any output, as before).
  if (error instanceof InvalidModelResponse) return { kind: "network", code: "invalid_response" };
  if (error && typeof error === "object") {
    const status = "status" in error && typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
    // The code is read from the SDK error here, before it (and its body) is dropped.
    if (status !== undefined) return { kind: "http", code: classifyHttp(status, error), status, headers: "headers" in error && error.headers instanceof Headers ? error.headers : undefined };
    if ("name" in error && error.name === "APIConnectionTimeoutError") return { kind: "timeout", code: "timeout" };
  }
  // Includes truncated SSE and transport failures, but never the raw model payload.
  return { kind: "network", code: "network" };
}
/** M12: gateways are URLs users pick, so a Retry-After never holds a turn (and its channel) longer. */
export const RETRY_AFTER_MAX_MS = 60_000;
export function retryDelay(headers: Headers | undefined, retry: number, clock: () => number, random: () => number): number {
  const after = headers?.get("retry-after");
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - clock()), RETRY_AFTER_MAX_MS);
  }
  return Math.round(500 * 2 ** retry * (0.5 + random()));
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Aborted")); return; }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { void promise.catch(() => {}); reject(new Error("Aborted")); return; }
    const abort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    const settle = (fn: () => void) => { signal.removeEventListener("abort", abort); fn(); };
    promise.then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
  });
}
export function createLlm(models: ModelConfig, opts: LlmOptions = {}): RegisteredLlm {
  const env = opts.env ?? process.env;
  // M12: database providers read their key from the vault; models.json ones from env[apiKeyEnv].
  const keyOf = (provider: ModelConfig["providers"][number]): string | undefined =>
    (opts.apiKey ? opts.apiKey(provider) : provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined)?.trim() || undefined;
  const wait = opts.sleep ?? sleep, clock = opts.clock ?? Date.now, random = opts.random ?? Math.random;
  const report = opts.report ?? ((fields: Record<string, unknown>) => log.warn("model attempt failed", fields));
  const roleModels: RegisteredLlm["roleModels"] = role => (models.roles[role] ?? []).flatMap(id => {
    const model = models.models.find(m => m.id === id);
    return model ? [model] : [];
  });
  return { models, roleModels, stream: request => run(request) };
  async function* run(request: LlmRequest): AsyncIterable<LlmEvent> {
    const chain = request.pin ? models.models.filter(m => m.id === request.pin?.modelId && m.provider === request.pin.providerId) : roleModels(request.role);
    if (!chain.length) throw new LlmError({ kind: "config", providerId: request.pin?.providerId ?? "", modelId: request.pin?.modelId ?? "", attempts: 0 });
    let attempts = 0, last: LlmError | undefined;
    for (const model of chain) {
      const provider = models.providers.find(p => p.id === model.provider);
      const modelIdentity: ModelIdentity = { providerId: model.provider, modelId: model.id };
      const apiKey = provider ? keyOf(provider) : undefined;
      if (!provider || !apiKey) {
        last = new LlmError({ kind: "config", ...modelIdentity, attempts });
        continue;
      }
      for (let retry = 0; retry <= 2; retry++) {
        if (request.signal?.aborted) throw new LlmError({ kind: "network", ...modelIdentity, attempts });
        attempts++;
        const began = clock();
        let emitted = false, timedOut = false, paused = false;
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.signal?.addEventListener("abort", abort, { once: true });
        // Idle deadline: time to the response and between body chunks. A whole-stream
        // cap would cut long, healthy outputs (a Make build) that can't be retried.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, models.timeoutMs); };
        arm();
        let iterator: AsyncIterator<LlmEvent> | undefined;
        let failure: ReturnType<typeof details> | undefined;
        try {
          const context = { provider, model, apiKey, timeoutMs: models.timeoutMs, fetch: opts.fetch, onActivity: () => { if (!paused) arm(); } };
          const adapter = provider.protocol === "anthropic" ? streamAnthropic : streamOpenai;
          iterator = adapter({ ...request, signal: controller.signal }, context)[Symbol.asyncIterator]();
          while (true) {
            const event = await abortable(iterator.next(), controller.signal);
            if (event.done) throw new InvalidModelResponse("no_done");
            emitted = true;
            // A slow consumer is not a stalled gateway.
            paused = true; clearTimeout(timer);
            yield event.value;
            paused = false; arm();
            if (event.value.type === "done") return;
          }
        } catch (error) {
          failure = details(error, timedOut);
          last = new LlmError({ kind: failure.kind, code: failure.code, status: failure.status, ...modelIdentity, attempts });
          const fields: Record<string, unknown> = {
            provider: model.provider, model: model.id, role: request.role ?? null, attempt: attempts,
            kind: failure.kind, code: failure.code, status: failure.status ?? null, afterOutput: emitted, aborted: request.signal?.aborted === true,
            ms: Math.max(0, Math.round(clock() - began)), cause: describe(error) ?? null,
          };
          try { report(JSON.stringify(fields).includes(apiKey) ? { ...fields, cause: null } : fields); } catch { /* never let logging fail a run */ }
          if (emitted || request.signal?.aborted) throw last;
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", abort);
          controller.abort();
          // Do not let a non-cooperative transport defeat the deadline on cleanup.
          if (iterator?.return) void iterator.return().catch(() => {});
        }
        // M14: a bad key, no credit, a too long context or a content check fails the same way again.
        const retryable = failure && !NO_RETRY.has(failure.code) && (failure.status === 429 || (failure.status !== undefined && failure.status >= 500) || failure.kind === "network" || failure.kind === "timeout");
        if (!retryable || retry === 2) break;
        try { await abortable(wait(retryDelay(failure?.headers, retry, clock, random), request.signal), request.signal ?? new AbortController().signal); }
        catch { throw new LlmError({ kind: "network", ...modelIdentity, attempts }); }
      }
    }
    throw last ?? new LlmError({ kind: "config", providerId: "", modelId: "", attempts });
  }
}
