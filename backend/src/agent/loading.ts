// Tools on demand (M29, chat and task turns). Every tool definition used to go to the model on
// every call (~14k tokens of built-in tools, plus a custom MCP connector's whole catalogue: Notion's
// 68 tools were ~51k more), whether the turn needed them or not. Now a call carries:
//  - the core tools in full: used often, or called on the assistant's own initiative (a reaction,
//    quick replies, remembering a fact), or the way into something else (use_skill, the app tools);
//  - load_tools;
//  - the tools loaded in this turn, and the ones used or loaded in this thread's history window
//    (they stay while the conversation that used them is in context).
// Everything else is listed under "More tools" in the system prompt (name and one sentence), and
// load_tools adds named tools (or a small group) to the next calls. The index never changes within
// a turn, and the tools list only grows, appended at the end, so a cached prefix stays valid.
// No extra model call: a connector named in the user's message gets the tools the user called
// most from it preloaded (no history: nothing guessed), so an everyday "add this to Notion" costs
// no load round at all.
// Not a boundary: what may run is still the provider's own check, ToolPolicy and Approval. A call
// to a deferred tool the model didn't load runs like any other and is loaded from then on.
// After OpenBot's server/src/plugins/selection.ts (narrowing is an accuracy and cost device; when
// unsure, offer more) and Claude Code's deferred MCP tools (names first, schemas on request).
import { z } from "zod";
import type { Tool } from "../llm/index.ts";
import type { RunKind } from "./types.ts";

export const LOAD_TOOLS = "load_tools";

/** Only these kinds load on demand; briefs, check-ins, scans, routines and builds offer as before. */
const DEFERRING_KINDS: ReadonlySet<RunKind> = new Set(["chat", "task"]);
export const defersTools = (kind: RunKind): boolean => DEFERRING_KINDS.has(kind);

/**
 * Sent in full whenever the turn offers them (M29 tool counts over 86 chat turns: quick_replies
 * 12.8%, show_tasks 8.1%, read_artifact 7.0%, set_reminder 3.5%; the rest at most 2.3%). Also the
 * ones the assistant calls on its own without the user asking (react, remember, the soul and skill
 * proposals), the entries to other mechanisms, and the cards the server offers only for a moment
 * (propose_soul_setup, followed_up). A task turn adds its own step tools.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "quick_replies", "react", "remember", "propose_soul_change", "propose_soul_setup", "followed_up",
  "show_tasks", "read_artifact", "web_search", "web_fetch", "search_past_chats", "set_reminder",
  "use_skill", "read_skill_file", "propose_skill",
  // Composio (only when it's set up): the four ways into the user's apps, and editing a waiting card;
  // call_api: the way into an API-key connector (only with one).
  "search_app_tools", "get_app_tool_schemas", "execute_app_tools", "manage_app_connections", "update_approval", "call_api",
  // a task's own session
  "set_steps", "add_update", "add_resource", "update_task", "ask_user", "finish_task",
]);

/** Below this many characters of deferrable definitions there is nothing worth saving: all go in full. */
export const DEFER_MIN_CHARS = 6_000;
/** At most this many deferred tools are loaded in one turn (calls the model made directly add to it). */
export const MAX_LOADED = 60;
/** At most this many tools carry over from the thread's history window. */
export const MAX_STICKY = 30;
/** A group name loads the whole group only up to this size; past it the model names the tools. */
export const MAX_GROUP_LOAD = 16;
/** A connector named in the message gets at most this many of the user's most-used tools preloaded. */
export const PRELOAD_PER_CONNECTOR = 6;
const SUMMARY_MAX = 100;

/** Where a deferred tool sits in the "More tools" index. `connector`: a connector the user added. */
export interface ToolIndexEntry { group: string; summary: string; connector?: boolean }

/** Built-in tools (agent/tools.ts) by index group. */
const BUILTIN_GROUP: Record<string, string> = {
  search_past_chats: "Lookups", web_search: "Lookups", web_fetch: "Lookups", weather: "Lookups", exchange_rate: "Lookups", read_feed: "Lookups",
  quick_replies: "Replies", set_reminder: "Reminders", cancel_reminder: "Reminders", send_feedback: "Feedback",
};
/** Provider tools by the provider's name (ToolProvider.name), unless the provider says otherwise. */
const PROVIDER_GROUP: Record<string, string> = {
  computer: "Computer", cards: "Cards", tasks: "Tasks", needs: "Tasks", make: "Make", routines: "Scheduled tasks",
  memory: "Memory", skills: "Skills", proactive: "Proactivity", approvals: "Approvals", connectors: "Apps",
  "custom-connectors": "Connections", reactions: "Replies",
};

/** A tool's description up to its first sentence, at most 100 characters (cut at a word). */
export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // A sentence ends at . ! ? before a space or the end ("e.g. ", "i.e. ", "etc. " don't end one).
  const end = flat.search(/(?<!\b(?:e\.g|i\.e|etc|vs|incl|approx|no|cf))[.!?](?=\s|$)|[。！？]/i);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  if ([...sentence].length <= max) return sentence;
  const cut = [...sentence].slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** The index entry of a tool nobody described: built-ins by name, provider tools by provider. */
export function defaultEntry(tool: Tool, provider: string | null): ToolIndexEntry {
  const group = provider === null
    ? BUILTIN_GROUP[tool.name] ?? "Built-in"
    : PROVIDER_GROUP[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  return { group, summary: firstSentence(tool.description) };
}

/** The approximate size of a definition on the wire. */
const sizeOf = (tool: Tool): number => tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length;

/** One turn's split of its tools: what goes in full, what waits in the index. */
export interface LoadPlan {
  /** false: everything is offered in full, as before (other kinds, few tools, a model without tools) */
  on: boolean;
  /** names sent in full on every call of the turn (the turn's own order) */
  core: ReadonlySet<string>;
  /** the deferred tools by name, in the turn's order */
  deferred: ReadonlyMap<string, Tool>;
  /** their index entries */
  entries: ReadonlyMap<string, ToolIndexEntry>;
}

const OFF: LoadPlan = { on: false, core: new Set(), deferred: new Map(), entries: new Map() };

/**
 * The plan for a turn from what it offers (built-ins and providers, after their own filters).
 * Off for kinds that don't defer, for a model without tool calls, and when the deferrable part is
 * too small to matter (under `minChars`).
 */
export function planLoading(input: {
  kind: RunKind;
  modelTools: boolean;
  tools: readonly Tool[];
  entry: (tool: Tool) => ToolIndexEntry;
  minChars?: number;
}): LoadPlan {
  if (!defersTools(input.kind) || !input.modelTools) return OFF;
  const core = new Set<string>();
  const deferred = new Map<string, Tool>();
  let size = 0;
  for (const tool of input.tools) {
    if (tool.name === LOAD_TOOLS) continue;
    if (CORE_TOOLS.has(tool.name)) core.add(tool.name);
    else if (!deferred.has(tool.name)) { deferred.set(tool.name, tool); size += sizeOf(tool); }
  }
  if (!deferred.size || size < (input.minChars ?? DEFER_MIN_CHARS)) return OFF;
  const entries = new Map<string, ToolIndexEntry>();
  for (const [name, tool] of deferred) entries.set(name, input.entry(tool));
  return { on: true, core, deferred, entries };
}
/** What load_tools did with the names it was given. */
export interface LoadOutcome {
  /** newly loaded, in order */
  loaded: string[];
  /** loaded before or always sent */
  already: string[];
  /** neither a tool nor a group of this turn */
  unknown: string[];
  /** groups too big to load whole: the model names the tools it needs */
  tooMany: { group: string; count: number }[];
  /** left out: the turn's cap was reached */
  capped: string[];
}

/** The deferred tools of these groups (any case), in the turn's order. */
export function toolsOfGroups(plan: LoadPlan, groups: readonly string[]): string[] {
  const wanted = new Set(groups.map((group) => group.toLowerCase()));
  return [...plan.entries].filter(([, entry]) => wanted.has(entry.group.toLowerCase())).map(([name]) => name);
}

/**
 * load_tools' names against the turn's plan: a tool's exact name, else a group's name (any case)
 * up to MAX_GROUP_LOAD tools. `loaded`: what the turn has loaded so far (the cap counts them).
 */
export function resolveLoad(names: readonly string[], plan: LoadPlan, loaded: readonly string[], cap = MAX_LOADED): LoadOutcome {
  const out: LoadOutcome = { loaded: [], already: [], unknown: [], tooMany: [], capped: [] };
  const have = new Set(loaded);
  const add = (name: string) => {
    if (have.has(name) || plan.core.has(name)) {
      if (!out.already.includes(name)) out.already.push(name);
    } else if (have.size >= cap) {
      out.capped.push(name);
    } else {
      have.add(name);
      out.loaded.push(name);
    }
  };
  for (const raw of names) {
    const name = raw.trim();
    if (!name || name === LOAD_TOOLS) continue;
    if (plan.deferred.has(name) || plan.core.has(name)) { add(name); continue; }
    const members = toolsOfGroups(plan, [name]);
    if (!members.length) out.unknown.push(name);
    else if (members.length > MAX_GROUP_LOAD) out.tooMany.push({ group: plan.entries.get(members[0]!)!.group, count: members.length });
    else members.forEach(add);
  }
  return out;
}

/** load_tools' answer to the model (the run record keeps `loaded` / `alreadyAvailable` for later turns). */
export function loadAnswer(outcome: LoadOutcome): { data: Record<string, unknown>; isError: boolean } {
  const notes: string[] = [];
  if (outcome.unknown.length) notes.push(`Not tools or groups of this turn: ${outcome.unknown.join(", ")}. Use the exact names under "More tools".`);
  for (const group of outcome.tooMany) notes.push(`${group.group} has ${group.count} tools: name the ones you need instead of the group.`);
  if (outcome.capped.length) notes.push(`${MAX_LOADED} tools are loaded already, so these weren't: ${outcome.capped.join(", ")}.`);
  const data: Record<string, unknown> = { loaded: outcome.loaded };
  if (outcome.already.length) data.alreadyAvailable = outcome.already;
  if (outcome.loaded.length || outcome.already.length) data.ready = "Call them now.";
  if (notes.length) data.note = notes.join(" ");
  return { data, isError: !outcome.loaded.length && !outcome.already.length };
}

/**
 * The "More tools" section of the system prompt: each deferred tool under its group, connectors last.
 * `loaded`: the ones the turn starts with (history, preload) are named as ready instead, so the model
 * doesn't spend a round loading what it already has.
 */
export function indexLines(plan: LoadPlan, loaded: readonly string[] = []): string[] {
  if (!plan.on) return [];
  const ready = new Set(loaded.filter((name) => plan.deferred.has(name)));
  const groups = new Map<string, { connector: boolean; lines: string[] }>();
  for (const [name, entry] of plan.entries) {
    if (ready.has(name)) continue;
    const group = groups.get(entry.group) ?? { connector: !!entry.connector, lines: [] };
    group.lines.push(entry.summary ? `- ${name}: ${entry.summary}` : `- ${name}`);
    groups.set(entry.group, group);
  }
  const ordered = [...groups].sort((a, b) => Number(a[1].connector) - Number(b[1].connector));
  return [
    `More tools (offered on this turn, not loaded yet). Before using any of them, call ${LOAD_TOOLS} once with every name this request may need; a small group loads by its group name, a connector's tools by their own names. Loaded tools stay for this conversation.`,
    ...(ready.size ? [`Already loaded for this turn, call them directly: ${[...ready].join(", ")}.`] : []),
    ...ordered.flatMap(([group, { connector, lines }]) => [`${group}${connector ? " (connector)" : ""}:`, ...lines]),
  ];
}

const LoadArgs = z.object({ tools: z.array(z.string().trim().min(1).max(128)).min(1).max(40) }).strict();
export const parseLoadArgs = (input: unknown) => LoadArgs.safeParse(input);

export const LOAD_TOOL: Tool = {
  name: LOAD_TOOLS,
  description: `Load tools listed under "More tools" in your instructions so you can call them. Name every tool this request may need (say, the search and the write) in one call, before you use any of them: a missing one costs another round. A small group (Computer, Cards, Tasks, Make...) loads by its group name; a connector's tools by their own names. Loaded tools can be called from your next step and stay for this conversation. Not needed for tools you already have.`,
  inputSchema: z.toJSONSchema(LoadArgs, { io: "input" }) as Record<string, unknown>,
};

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The connector groups the user's message names ("Notion", "add it to notion"): whole words, any case. */
export function mentionedConnectors(text: string, plan: LoadPlan): string[] {
  if (!plan.on || !text.trim()) return [];
  const lower = text.toLowerCase();
  const groups = new Set([...plan.entries.values()].filter((entry) => entry.connector).map((entry) => entry.group));
  return [...groups].filter((group) => {
    const name = group.toLowerCase().trim();
    return name.length >= 3 && new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}($|[^a-z0-9])`).test(lower);
  });
}

/** The names a call's tools list starts with: the core ones (the turn's order) and load_tools. */
export function readyNames(base: readonly Tool[], plan: LoadPlan): string[] {
  return plan.on ? [...base.filter((tool) => plan.core.has(tool.name)).map((tool) => tool.name), LOAD_TOOLS] : base.map((tool) => tool.name);
}

/** One call's tools: the core ones (the turn's order), load_tools, then what's loaded (load order). */
export function toolsForCall(base: readonly Tool[], plan: LoadPlan, loaded: readonly string[]): Tool[] {
  if (!plan.on) return [...base];
  const byName = new Map(base.map((tool) => [tool.name, tool]));
  const extra = [...new Set(loaded)].filter((name) => !plan.core.has(name) && name !== LOAD_TOOLS);
  return [
    ...base.filter((tool) => plan.core.has(tool.name)),
    LOAD_TOOL,
    ...extra.flatMap((name) => { const tool = byName.get(name) ?? plan.deferred.get(name); return tool ? [tool] : []; }),
  ];
}
