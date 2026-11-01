// M21 "Environment" section of the system prompt (plan 「环境和能力」, .pi/plans/openduet-review/
// environment.md): facts about where the assistant runs, generated from this server's real configuration
// for this turn, placed right after the capability brief and before the soul (context.ts). Not the
// name or tone (the soul has those). Model-facing English like the rest of the prompt.
//  - chat, task and background turns get the whole section (<= ~600 tokens);
//  - a Make build gets only the three computer lines (<= ~150 tokens), or nothing without a computer.
// environmentLines() is a pure function of EnvironmentFacts; the runtime gathers the facts (model
// label, tools offered, search) and the computer provider its own (deployed, state, programs from a
// probe through its exec, approval modes from ToolPolicy).
import type { RunKind, ToolProvider, TurnInput } from "./types.ts";

/** What the computer provider knows for this turn (null: no computer for this account). */
export interface ComputerFacts {
  /** the computer answered its last health check */
  reachable: boolean;
  /** the user is driving its browser (Take over) */
  userInControl: boolean;
  /** programs found on the computer by the startup probe; null = not probed yet (or it failed) */
  programs: string[] | null;
  /** the computer's memory limit in bytes from the probe; null = unknown or none */
  memoryBytes: number | null;
  /** computer tools that run without a card for this user (ToolPolicy, defaults from computer/tools.ts) */
  always: string[];
  /** computer tools that ask first */
  ask: string[];
}

/** A provider that can tell the runtime about OpenDuet's computer (the computer provider). */
export interface EnvironmentSource {
  environment(input: TurnInput): Promise<ComputerFacts | null>;
}

export function isEnvironmentSource(provider: ToolProvider): provider is ToolProvider & EnvironmentSource {
  return typeof (provider as Partial<EnvironmentSource>).environment === "function";
}

export interface EnvironmentFacts {
  kind: RunKind;
  /** this turn's model as the user's model list names it (never a hard-coded id); null = unknown */
  modelLabel: string | null;
  /** the names of the tools offered on this turn (function tools, provider tools, the model's own server tools) */
  tools: string[];
  /**
   * M29 (agent/loading.ts): the ones sent in full from the start when the others wait under "More
   * tools" for load_tools; absent = all of `tools`. The web and computer lines still go by `tools`.
   */
  ready?: string[];
  /** a search tool is offered (web_search) */
  search: boolean;
  computer: ComputerFacts | null;
  browserMode: "headless" | "headed";
  /** the browser closes after this long idle; 0 = never */
  browserIdleMs: number;
}

/** computer_exec's own limits (computer/provider.ts execNow default, computer/client.ts EXEC_MAX_TIMEOUT_MS). */
const EXEC_DEFAULT_S = 120;
const EXEC_MAX_S = 600;
/** How many tool names the "offered" line lists before "and N more". */
const TOOLS_LISTED = 14;
/** Named first in the "offered" line when offered: the ones the tool-choice rules are about. */
const KEY_TOOLS = ["web_fetch", "web_search", "weather", "exchange_rate", "read_feed", "computer_*", "request_sign_in", "send_file", "search_app_tools", "execute_app_tools", "make_artifact", "start_task", "schedule_task", "set_reminder", "remember"];

/** The section, one string per line (empty for a build without a computer). */
export function environmentLines(facts: EnvironmentFacts): string[] {
  const { computer } = facts;
  if (facts.kind === "build") return computer ? computerCore(computer, false) : [];
  const model = facts.modelLabel ? JSON.stringify(facts.modelLabel) : "not known here (don't guess a name)";
  const lines = [
    "Environment (facts about this server and this turn):",
    `- A server the user hosts for themselves alone; work goes on while their phone is off. This turn's model: ${model} (the user picks it in the app). You reach the user only through this app (messages, cards, notifications): not their phone, other computers or the server's host.`,
    // M23 W4: how to read the web comes before the computer's lines (web_fetch before the browser).
    webLine(facts),
  ];
  const builtins = ["weather", "exchange_rate", "read_feed"].filter(name => facts.tools.includes(name));
  if (builtins.length) lines.push(`- Built-in read-only tools: ${builtins.join(", ")}. Never send private data to them. If a service can't be reached, tell the user and don't guess.`);
  if (computer) {
    lines.push(...computerCore(computer, true));
    const sleep = facts.browserIdleMs > 0
      ? `sleeps after ${Math.round(facts.browserIdleMs / 60_000)} idle minutes and wakes on the next browser call ("off" in its state = asleep, not reset)`
      : "stays open";
    const now = !computer.reachable ? " Right now the computer isn't answering: its tools may fail." : computer.userInControl ? " Right now the user is driving it." : "";
    lines.push(`- Browser: ${facts.browserMode}, signed in only where the user signed in through it; it ${sleep}. The user can watch and take over.${now}`);
  } else {
    lines.push("- No computer for this account on this server: no browser, shell or files of yours. Say so if asked.");
  }
  lines.push(approvalLine(computer));
  lines.push(facts.ready
    ? `- Tools ready now: ${offeredList(facts.ready)}. The others are listed under "More tools" below: load them with load_tools.`
    : `- Tools this turn: ${offeredList(facts.tools)}.`);
  return lines;
}

/**
 * The three computer lines (a build gets only these): what lasts, how commands run, what it can
 * reach. `full` (not a build) adds what to offer instead of a service that stays up.
 */
function computerCore(computer: ComputerFacts, full: boolean): string[] {
  const programs = computer.programs?.length
    ? `Programs: ${computer.programs.join(", ")}.`
    : "Programs not checked yet: try `command -v` first.";
  const memory = computer.memoryBytes ? ` ${formatBytes(computer.memoryBytes)} memory, shared with the browser.` : "";
  return [
    `- OpenDuet's computer: a Linux container here, not a throwaway sandbox. /workspace and browser logins persist across sleep and restarts; other files may go on a rebuild. ${programs}${memory}`,
    `- computer_exec: ${EXEC_DEFAULT_S} s default, ${EXEC_MAX_S} s max, then its process group is killed. nohup processes run unsupervised until a restart; no port is reachable from outside, so no long-running services${full ? " (offer schedule_task instead)" : ""}.`,
    "- Network only via the server's proxy; no access to the server's host or the user's devices.",
  ];
}

/** How to read the web with the tools of this turn (a given URL: web_fetch before the browser). */
function webLine(facts: EnvironmentFacts): string {
  const fetch = facts.tools.includes("web_fetch");
  const browser = facts.tools.includes("computer_navigate");
  if (!fetch && !browser && !facts.search) return "- Web: no web tools this turn.";
  const parts: string[] = [];
  if (fetch) parts.push(browser ? "For a URL the user gives, web_fetch first; the browser only for logins, JavaScript or clicks, or if web_fetch can't read it." : "For a URL the user gives, use web_fetch.");
  else if (browser) parts.push("Open pages with the browser.");
  parts.push(facts.search ? "web_search finds sources; opening a page is not a web search." : "There's no web search on this server; opening a page is not a web search.");
  return `- Web: ${parts.join(" ")}`;
}

/** What waits for the user's OK, from the real ToolPolicy settings of the computer tools. */
function approvalLine(computer: ComputerFacts | null): string {
  const parts: string[] = [];
  if (computer) {
    const writes = computer.always.filter((tool) => WRITE_TOOLS.has(tool));
    parts.push(`On the computer, ${[
      writes.length ? `${short(writes)} run without a card (Always)` : "",
      computer.ask.length ? `${short(computer.ask)} ${computer.ask.length === 1 ? "asks" : "ask"} first` : "",
      "a click or Enter that buys, pays, sends, posts, deletes or changes an account always asks",
    ].filter(Boolean).join("; ")}.`);
  }
  parts.push("In connected apps, reads run and writes ask unless set to Always; payments, passwords and sends to others always ask. The tool result says whether something ran or waits.");
  return `- Approvals: ${parts.join(" ")}`;
}

/** ["computer_click", "computer_type"] -> "computer_click/type". */
function short(tools: string[]): string {
  return tools.map((tool, i) => (i === 0 ? tool : tool.replace(/^computer_/, ""))).join("/");
}

/** The computer tools that change something (TOOL_INFO access "write"), for the approval line. */
const WRITE_TOOLS = new Set(["computer_click", "computer_type", "computer_key", "computer_files_write", "computer_exec"]);

/**
 * The offered tools, the computer's (computer_*) and each custom connector's (mcp_<id>_*) grouped;
 * KEY_TOOLS first, then the rest in order, at most TOOLS_LISTED entries ("and N more").
 */
export function offeredList(tools: string[]): string {
  const entries: string[] = [];
  const groups = new Map<string, number>();
  for (const name of new Set(tools)) {
    const group = name.startsWith("computer_") ? "computer_*" : /^mcp_[0-9a-f]{6}_/.test(name) ? `${name.slice(0, 10)}_*` : null;
    if (!group) { entries.push(name); continue; }
    if (!groups.has(group)) entries.push(group);
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const rank = (entry: string) => { const i = KEY_TOOLS.indexOf(entry); return i < 0 ? KEY_TOOLS.length : i; };
  const ordered = entries.map((entry, i) => ({ entry, i })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.i - b.i).map(({ entry }) => entry);
  const named = ordered.map((entry) => (groups.has(entry) ? `${entry} (${groups.get(entry)})` : entry));
  if (!named.length) return "none";
  const more = named.length > TOOLS_LISTED ? ` and ${named.length - TOOLS_LISTED} more` : "";
  return named.slice(0, TOOLS_LISTED).join(", ") + more;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** The programs the probe looks for (none hard-coded as present: only what `command -v` finds is told). */
export const PROBE_PROGRAMS = ["bash", "node", "bun", "npm", "curl", "git", "python3", "pip3", "officecli", "ffmpeg", "jq", "sqlite3", "unzip"] as const;

/**
 * One shell line, run once through the computer's exec (not ToolPolicy: it's the server's own
 * check, like workspace-impl.ts's internal calls): which programs exist, the Node package unpdf
 * (M20b links shell packages at /node_modules) and the container's memory limit (cgroup v2, v1).
 */
export const PROBE_COMMAND = [
  `for p in ${PROBE_PROGRAMS.join(" ")}; do command -v "$p" >/dev/null 2>&1 && echo "has $p"; done`,
  "[ -d /node_modules/unpdf ] && echo 'has unpdf (Node package)'",
  "cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null",
  "true",
].join("; ");

/** cgroup v1 reports "no limit" as a huge number; anything at or above this is no limit. */
const NO_LIMIT_BYTES = 2 ** 60;

/** The probe's stdout: "has <program>" lines and one memory line ("max" or bytes). */
export function parseProbe(stdout: string): { programs: string[]; memoryBytes: number | null } {
  const programs: string[] = [];
  let memoryBytes: number | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("has ")) programs.push(line.slice(4));
    else if (/^\d+$/.test(line)) {
      const bytes = Number(line);
      memoryBytes = bytes > 0 && bytes < NO_LIMIT_BYTES ? bytes : null;
    }
  }
  return { programs, memoryBytes };
}

export type ProbeExec = (command: string, opts: { timeoutMs: number; signal: AbortSignal }) => Promise<{ exitCode: number; stdout: string }>;

const PROBE_TIMEOUT_MS = 10_000;
/** A failed probe (computer asleep, unreachable, the user driving) is tried again at most this often. */
const PROBE_RETRY_MS = 60_000;

/**
 * The computer's programs and memory, probed once (at startup, and again after a failure at most
 * every PROBE_RETRY_MS) and cached. A turn waits for it only up to a short limit; until it has an
 * answer the section says the programs weren't checked yet.
 */
export class ProgramProbe {
  private result: { programs: string[]; memoryBytes: number | null } | null = null;
  private running: Promise<void> | null = null;
  private failedAt = -Infinity;

  constructor(private readonly exec: ProbeExec, private readonly now: () => number = Date.now, private readonly onError?: (error: unknown) => void) {}

  /** Starts the probe if it has no answer and isn't running (or failed less than a minute ago). */
  start(): void {
    if (this.result || this.running || this.now() - this.failedAt < PROBE_RETRY_MS) return;
    // .finally runs after this assignment even when exec fails at once.
    this.running = this.probe().finally(() => { this.running = null; });
  }

  /** The cached answer, without starting or waiting for a probe. */
  peek(): { programs: string[]; memoryBytes: number | null } | null {
    return this.result;
  }

  private async probe(): Promise<void> {
    try {
      const out = await this.exec(PROBE_COMMAND, { timeoutMs: PROBE_TIMEOUT_MS, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS + 5_000) });
      const parsed = parseProbe(out.stdout);
      if (out.exitCode !== 0 || parsed.programs.length === 0) throw new Error("probe found nothing");
      this.result = parsed;
    } catch (error) {
      this.failedAt = this.now();
      this.onError?.(error);
    }
  }

  /** The answer, waiting for a running probe at most `waitMs`; null = none (yet). */
  async get(waitMs: number): Promise<{ programs: string[]; memoryBytes: number | null } | null> {
    this.start();
    const running = this.running;
    if (running && !this.result) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([running, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]).finally(() => clearTimeout(timer));
    }
    return this.result;
  }
}
