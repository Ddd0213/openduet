// M20 (#3, review-harness P0-2): background turns (morning brief, check-in, scans; agent/background.ts)
// can only read, enforced here and never by telling the model. The runtime builds one guard per
// background turn: it filters the tools offered (after providerTurn) to the whitelist below and
// checks every call again right before it runs; a call outside it gets backgroundRefusal(name) as
// its result and runs nothing (no Approval row either). Anything not clearly a read is refused.
// Routines (kind "routine") are the user's own scheduled tasks and aren't guarded.
//
// The idea and the fail-closed rule follow CopilotKit/OpenDuet (MIT) openbot/server/src/proactive/restriction.ts.
import type { Tool, ToolUseBlock } from "../llm/index.ts";
import { classify } from "../policy/classify.ts";
import { backgroundRefusal } from "./background.ts";
import { READ_ONLY_TOOLS } from "./harness.ts";
import type { ToolProvider, TurnInput } from "./types.ts";

/**
 * Built-in read tools a background turn keeps: READ_ONLY_TOOLS (harness.ts) minus every computer_*
 * tool (the browser and shell can send data out, computer_navigate included). web_fetch is further
 * limited to hosts this turn's web_search returned (see check()).
 */
const READS = [...READ_ONLY_TOOLS].filter((name) => !name.startsWith("computer_"));

/**
 * Connector discovery and execute_app_tools: the connectors provider (W3, connectors/provider.ts)
 * runs only the nested calls classify() calls "read" there; the runtime also refuses a call whose
 * nested slugs name a write (nestedWrites), so nothing depends on one check alone.
 */
const CONNECTORS = ["search_app_tools", "get_app_tool_schemas", "execute_app_tools"];

/**
 * Duet's own tools these turns are for. They write only into the user's own thread, lists and
 * memory, which the user sees (and can undo), and reach no one else:
 *  - proactive/provider.ts: post_message, share_finding, add_up_next, finish_checkin, skip_brief,
 *    start_first_step (a background task, itself a normal task turn whose writes ask as usual),
 *    ask_weekends, set_weekends (the user's own brief schedule), check_memory, confirm_profile;
 *  - tasks/tools.ts: propose_tasks, propose_task (cards the user taps to start);
 *  - memory/provider.ts: remember (a visible "Remembered · Undo" chip; its own filter refuses
 *    instructions and secrets), followed_up (clears a follow-up's date);
 *  - cards/tools.ts: show_card, ask_form (the brief's cards); skills: use_skill (reads a skill).
 * Left out on purpose: set_reminder, cancel_reminder, send_feedback, set_proactivity, propose_soul_change, forget,
 * request_payment, update_approval, manage_app_connections, start_task, schedule_task /
 * manage_scheduled_task, make_artifact / edit_artifact, run_skill_script, propose_skill,
 * request_sign_in, send_file, every computer_* tool and the connection cards.
 */
const DUET = [
  "post_message", "share_finding", "add_up_next", "finish_checkin", "skip_brief", "start_first_step", "ask_weekends", "set_weekends",
  "check_memory", "confirm_profile", "propose_tasks", "propose_task", "remember", "followed_up", "show_card", "ask_form", "use_skill",
];

/** Every tool name a background turn may call (custom connector tools are decided by their provider). */
export const BACKGROUND_TOOLS: ReadonlySet<string> = new Set([...READS, ...CONNECTORS, ...DUET]);

/**
 * A provider whose tool names aren't fixed (custom connectors: mcp_<id>_<tool>, call_api) says
 * itself which are reads. Unknown or unclear = false. readCall is asked again right before each call.
 */
export interface BackgroundReads {
  /** offered in a background turn: only a tool that can be a read (an MCP tool with readOnlyHint, call_api) */
  readTool(name: string, input: TurnInput): Promise<boolean>;
  /** this exact call is a read (call_api: GET / HEAD only); re-checked against fresh state */
  readCall(call: ToolUseBlock, input: TurnInput): Promise<boolean>;
}

export const hasBackgroundReads = (provider: ToolProvider | undefined): provider is ToolProvider & BackgroundReads =>
  !!provider && typeof (provider as Partial<BackgroundReads>).readTool === "function" && typeof (provider as Partial<BackgroundReads>).readCall === "function";

/** execute_app_tools: the nested calls whose slug names a write (classify by slug alone). */
export function nestedWrites(input: Record<string, unknown>): { index: number; tool: string }[] {
  const calls = Array.isArray(input.calls) ? input.calls : [];
  const out: { index: number; tool: string }[] = [];
  for (const [index, raw] of calls.entries()) {
    const slug = raw && typeof raw === "object" && typeof (raw as { tool?: unknown }).tool === "string" ? (raw as { tool: string }).tool.toUpperCase() : "";
    if (slug && classify({ slug, toolkit: null }) === "write") out.push({ index, tool: slug });
  }
  return out;
}

/** A host as compared for web_fetch: lower case, without a leading "www.". */
export function hostKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The hosts of a web_search result's URLs (an error or anything else gives none). */
function searchHosts(text: string): string[] {
  try {
    const data = JSON.parse(text) as { results?: unknown };
    if (!Array.isArray(data.results)) return [];
    return data.results.flatMap((hit) => {
      const url = hit && typeof hit === "object" ? (hit as { url?: unknown }).url : undefined;
      const host = typeof url === "string" ? hostKey(url) : null;
      return host ? [host] : [];
    });
  } catch {
    return [];
  }
}

export const WEB_FETCH_UNSEEN = "In a background turn web_fetch reads only pages whose site appeared in this turn's web_search results. Search first, then read one of the results.";

export interface BackgroundGuard {
  /** the tools offered this round: built-ins and provider tools, filtered */
  offer(builtins: Tool[], extra: Tool[]): Tool[];
  /** right before a call runs: null = run it; otherwise the refusal it gets instead (nothing runs) */
  check(call: ToolUseBlock, owner: ToolProvider | undefined): Promise<Record<string, unknown> | null>;
  /** after a call ran (web_search hosts unlock web_fetch for them) */
  saw(call: ToolUseBlock, resultText: string, ok: boolean): void;
}

/**
 * The guard of one background turn. `owners`: providerTurn's tool -> provider map (built-ins have
 * no owner). Provider tools that say they are reads are collected once here; each call is checked
 * again with readCall.
 */
export async function backgroundGuard(input: TurnInput, extra: { tools: Tool[]; owners: Map<string, ToolProvider> }): Promise<BackgroundGuard> {
  const readable = new Set<string>();
  for (const tool of extra.tools) {
    const owner = extra.owners.get(tool.name);
    if (!hasBackgroundReads(owner)) continue;
    if (await owner.readTool(tool.name, input).catch(() => false)) readable.add(tool.name);
  }
  const seenHosts = new Set<string>();
  const allowed = (name: string, owner: ToolProvider | undefined) => (hasBackgroundReads(owner) ? readable.has(name) : BACKGROUND_TOOLS.has(name));
  return {
    offer(builtins, offered) {
      return [
        ...builtins.filter((tool) => BACKGROUND_TOOLS.has(tool.name)),
        ...offered.filter((tool) => allowed(tool.name, extra.owners.get(tool.name))),
      ];
    },
    async check(call, owner) {
      if (!allowed(call.name, owner)) return backgroundRefusal(call.name);
      if (hasBackgroundReads(owner) && !(await owner.readCall(call, input).catch(() => false))) return backgroundRefusal(call.name);
      if (!owner && (call.name === "web_fetch" || call.name === "read_feed")) {
        const host = typeof call.input.url === "string" ? hostKey(call.input.url) : null;
        if (!host || !seenHosts.has(host)) return { ...backgroundRefusal(call.name), detail: WEB_FETCH_UNSEEN.replace("web_fetch", call.name) };
      }
      if (call.name === "execute_app_tools") {
        const writes = nestedWrites(call.input);
        if (writes.length) return { ...backgroundRefusal(call.name), writes, detail: "These calls would write. Send only the reads again; offer the rest with add_up_next or propose_task." };
      }
      return null;
    },
    saw(call, resultText, ok) {
      if (call.name !== "web_search" || !ok) return;
      for (const host of searchHosts(resultText)) seenHosts.add(host);
    },
  };
}
