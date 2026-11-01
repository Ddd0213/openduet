// One POST with at most one retry (network error, 429 or 5xx). Logs only the provider and the
// status: URLs can hold the ntfy topic or the Bark device key, bodies hold user text.
import { log } from "../../log.ts";
import type { FetchLike, PushOutcome } from "./types.ts";

export const PUSH_TIMEOUT_MS = 10_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function postWithRetry(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  init: { headers: Record<string, string>; body: string },
  retryDelayMs: number,
): Promise<PushOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let status = 0;
    try {
      status = (await fetchFn(url, { method: "POST", ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })).status;
    } catch (error) {
      log.warn("push request failed", { provider, attempt, error: { name: (error as Error).name } });
    }
    if (status >= 200 && status < 300) return "sent";
    const retryable = status === 0 || status === 429 || status >= 500;
    if (status !== 0) log.warn("push rejected", { provider, attempt, status });
    if (!retryable || attempt === 1) return "failed";
    await sleep(retryDelayMs);
  }
  return "failed";
}
