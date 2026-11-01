// Health probe for OpenDuet's computer (OpenBot agent-computer). `/health` is the computer's only
// unauthenticated route: it reports that the process is up and whether a browser is running, and
// needs no COMPUTER_TOKEN. The full computer client lives alongside this file (M6).
import { z } from "zod";

const HealthBody = z.object({
  status: z.literal("ok"),
  browser: z.boolean().optional(),
});

export type ComputerHealth =
  | { ok: true; browser: boolean }
  | { ok: false; reason: "unreachable" | "timeout" | "bad_status" | "bad_body"; status?: number };

/** GETs `<baseUrl>/health` once. Never throws; the reason says what went wrong. */
export async function probeComputer(
  baseUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<ComputerHealth> {
  const doFetch = options.fetch ?? fetch;
  const url = new URL("/health", baseUrl);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "bad_status", status: response.status };
  }
  const body = HealthBody.safeParse(await response.json().catch(() => null));
  if (!body.success) return { ok: false, reason: "bad_body", status: response.status };
  return { ok: true, browser: body.data.browser ?? false };
}
