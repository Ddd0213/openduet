// M14 A5: background runs retry on their own (codync-harness #7, after Codync's routines.md and
// store/entries.rs `acted_in_turn`). A routine / brief / check-in run that failed with a model error
// a second try can fix (rate limit, 5xx, network, timeout, invalid response) and that posted nothing
// and did nothing beyond reading is run again after 1, 5 and 15 minutes (at most 3 times); only the
// last failure shows the model_error card. The retries are kept in memory (timers in RunHost): a
// restart drops them (no schema change), and the slot isn't claimed again.
import type { RunKind } from "../agent/types.ts";
import type { Phrase } from "../contract/common.ts";
import type { Db } from "../db.ts";

/** +1, +5, +15 min after each failure. */
export const BACKGROUND_RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const BACKGROUND_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(["routine", "brief", "checkin"]);

/** Phrase keys of failures a later try can fix (llm/errors.ts LLM_ERROR_PHRASE: rate_limit, network, timeout, invalid_response). */
const RETRYABLE_KEYS: ReadonlySet<string> = new Set([
  "system.model_rate_limit", "system.model_network", "system.model_timeout", "system.model_invalid_response",
]);

/**
 * A model failure worth trying again later: the keys above, a gateway status 408 / 429 / 5xx on
 * `system.model_error`, or `system.model_unreachable` for a network error or a timeout. Never a
 * bad key, no credit, a too long context, a content check, no model, the output limit or an
 * internal error.
 */
export function retryableFailure(error: Phrase | null): boolean {
  const key = error?.key;
  if (!key) return false;
  if (RETRYABLE_KEYS.has(key)) return true;
  if (key === "system.model_error") {
    const status = error.params?.status;
    const value = status && "value" in status ? Number(status.value) : NaN;
    return value === 408 || value === 429 || (value >= 500 && value <= 599);
  }
  if (key === "system.model_unreachable") {
    const reason = error.params?.reason;
    const value = reason && "value" in reason ? String(reason.value) : "";
    return value === "network error" || value === "timeout";
  }
  return false;
}

/**
 * Tools that only look (a failed run that called just these did nothing): web and past-chat search,
 * reading pages, files, memory, skills and the app catalogue.
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "web_search", "web_fetch", "check_memory", "search_past_chats", "search_app_tools", "get_app_tool_schemas",
  "weather", "exchange_rate", "read_feed",
  "computer_read", "computer_snapshot", "computer_screenshot", "computer_files_list", "computer_files_read", "computer_files_search",
  "use_skill", "read_skill_file", "think",
]);

/** Did the run call a tool that may have changed something (anything but READ_TOOLS)? */
export async function actedInRun(db: Db, runId: string): Promise<boolean> {
  const tools = await db.runStep.findMany({ where: { runId, kind: "tool" }, select: { tool: true }, distinct: ["tool"] });
  return tools.some((step) => !step.tool || !READ_TOOLS.has(step.tool));
}
