// M29 tools on demand (agent/loading.ts): a chat or task turn sends its core tools in full and lists
// the rest under "More tools" in the system prompt. "Offered this turn" is either.
import type { LlmRequest } from "../../src/llm/index.ts";

const INDEX = "\nMore tools (offered on this turn";

/** The tools a request sent in full, then the ones its "More tools" index lists (load_tools loads them). */
export function offeredNames(request: LlmRequest | undefined): string[] {
  const sent = (request?.tools ?? []).map((tool) => tool.name);
  const system = request?.system ?? "";
  const at = system.indexOf(INDEX);
  if (at < 0) return sent;
  const listed = [...system.slice(at).matchAll(/^- ([A-Za-z0-9_-]+)(?::|$)/gm)].map((match) => match[1]!);
  return [...sent, ...listed.filter((name) => !sent.includes(name))];
}
