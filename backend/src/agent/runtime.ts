import { z } from "zod";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { isBuiltin, searchOffered, type BuiltinConfig } from "../builtins/config.ts";
import { LlmError, type Fetch, type LlmEvent, type Model, type ModelIdentity, type ModelResolver, type ModelRole, type RegisteredLlm, type ThinkingLevel, type Tool, type ToolResultBlock, type ToolUseBlock } from "../llm/index.ts";
import { log } from "../log.ts";
import type { Lookup } from "../web/fetch.ts";
import { isBackgroundTurn } from "./background.ts";
import { buildContext, withAttachments } from "./context.ts";
import { environmentLines, isEnvironmentSource, type ComputerFacts } from "./environment.ts";
import { TextBubbles } from "./bubbles.ts";
import { CLAIM_NOTE, capOlderResults, claimsDeliverable, EMPTY_REPLY_NOTE, isPass, pushNote, READ_ONLY_TOOLS, REPEAT_LIMIT, repeatNote, stable, TOOL_THREW, trimImages, VISIBLE_TOOLS, WRAP_UP_NOTE } from "./harness.ts";
import { backgroundGuard, type BackgroundGuard } from "./read-only.ts";
import { defaultEntry, indexLines, LOAD_TOOLS, loadAnswer, MAX_STICKY, mentionedConnectors, parseLoadArgs, planLoading, PRELOAD_PER_CONNECTOR, readyNames, resolveLoad, toolsForCall, toolsOfGroups, type LoadPlan } from "./loading.ts";
import { frequentTools } from "../runs/tool-history.ts";
import { pendingApproval, usedNativeSearch, waitsForApproval, type ReplyTurn } from "./replies.ts";
import { MISSING_SETUP_CHIPS_NOTE, postInvitation } from "../soul/setup.ts";
import { createToolExecutor, functionTools, TOOL_STATUS } from "./tools.ts";
import type { AgentRuntime, RunKind, ToolProvider, TurnInput, TurnResult, TurnSink } from "./types.ts";
import { wrapToolResult } from "./untrusted.ts";
import { clearFinishText, noteFinishText } from "../tasks/result-text.ts";

export { TOOL_STATUS } from "./tools.ts";
export { phrase } from "./phrase.ts";

/** M12: nothing usable for this turn's role; the turn fails with system.no_model (its card has no retry). */
export class NoModelError extends Error {
  constructor() { super("No model is set up"); this.name = "NoModelError"; }
}
export const NO_MODEL_KEY = "system.no_model";

export interface AgentRuntimeDeps {
  db: Db;
  /** the legacy registry (models.json, scripted test models); used when there's no resolver */
  llm?: RegisteredLlm | null;
  /**
   * M12: the user's own model per turn from the database (channel model, else the default; a
   * retry's pin), one model with its thinking level. When set, `llm` is not used.
   */
  resolver?: ModelResolver | null;
  /** M21: the browser settings are told in the Environment section (defaults as in config.ts). */
  config: Pick<Config, "DATABASE_URL"> & BuiltinConfig & Partial<Pick<Config, "COMPUTER_BROWSER_MODE" | "COMPUTER_BROWSER_IDLE_MS">>;
  now?: () => Date;
  fetch?: Fetch;
  lookup?: Lookup;
  /**
   * Extra tools (connectors, approvals, tasks ...). Read on every turn, not copied, so index.ts
   * can push a provider that itself needs this runtime (the task runner) after creating it.
   */
  providers?: ToolProvider[];
  /** M21 tests: the watchdog's limit per call (default toolLimitMs) */
  toolLimitMs?: (call: ToolUseBlock) => number;
  /** M29 tests: below this many characters of deferrable tools all go in full (agent/loading.ts DEFER_MIN_CHARS) */
  deferMinChars?: number;
}

export const ROLE: Record<RunKind, ModelRole> = { chat: "chat", task: "task", build: "task", brief: "proactive", checkin: "proactive", scan: "proactive", routine: "proactive" };
/** Background sessions (tasks, builds, proactive runs, routines) get more tool rounds than a chat turn. */
const MAX_ROUNDS: Record<RunKind, number> = { chat: 12, task: 40, build: 40, brief: 24, checkin: 24, scan: 24, routine: 24 };
// A reply cut off by the model's output limit is retried this many times in a row (with CUT_OFF_NOTE).
const MAX_CUTOFFS = 2;
const CUT_OFF_NOTE = "[Your last reply hit the model's output limit and was cut off; an unfinished tool call was dropped and did not run. "
  + "Keep each reply and each tool call smaller: think briefly, and split long content into several smaller writes or steps.]";
class OutputLimitReached extends Error {
  constructor() { super("Model output limit reached"); this.name = "OutputLimitReached"; }
}

const ToolCall = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
/** M14: a call the gateway sent with arguments that aren't one JSON object is answered, never run. */
function invalidArguments(call: ToolUseBlock): ToolResultBlock {
  return { type: "tool_result", toolUseId: call.id, isError: true, content: [{ type: "text", text: JSON.stringify({ error: `Your arguments for ${call.name} were not valid JSON. Send the call again with one JSON object.` }) }] };
}
/** M20: a background turn's call outside its read-only boundary (agent/read-only.ts); nothing ran. */
function refused(call: ToolUseBlock, refusal: Record<string, unknown>): ToolResultBlock {
  return { type: "tool_result", toolUseId: call.id, isError: true, content: [{ type: "text", text: JSON.stringify(refusal) }] };
}
const Usage = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimated: z.boolean() });
const Identity = z.object({ providerId: z.string(), modelId: z.string() });

/**
 * M21 (#13) tool-call watchdog: how long one tool call may run before the turn stops waiting for
 * it. Each limit sits above the tool's own timeouts, so a tool that keeps its own limits always
 * answers first and the watchdog only catches one that hangs:
 *  - computer_exec: its own timeout (timeoutSeconds, default 120 s, at most 600 s; the computer
 *    kills the process group then, and the HTTP call waits 15 s more) + 90 s;
 *  - run_skill_script: its exec timeout (300 s, skills/scripts.ts) + 90 s;
 *  - the other computer tools, request_sign_in and send_file: 15 min (a call may first wait for the
 *    user to hand the browser back, up to 10 min in a background turn, then navigate for 60 s);
 *  - execute_app_tools: 2 min per nested call (each Composio call is bounded at 90 s,
 *    composio/sdk.ts), at least 5 min, at most 20 min;
 *  - everything else: 5 min (web_fetch / web_search, MCP and API connectors answer within 60 s).
 * A call past its limit is abandoned: a logged reason, an error result for the model that says it
 * may still have happened, and nothing it writes to the thread afterwards is kept. Stop (the turn's
 * signal) abandons the call at once, so the queue moves on without waiting for a hung tool.
 */
export const TOOL_LIMIT_MS = {
  default: 5 * 60_000,
  computer: 15 * 60_000,
  execGrace: 90_000,
  skillScript: 300_000 + 90_000,
  appCall: 2 * 60_000,
  appTools: 20 * 60_000,
} as const;

export function toolLimitMs(call: ToolUseBlock): number {
  const { name, input } = call;
  if (name === "computer_exec") {
    const seconds = typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds) ? Math.min(600, Math.max(1, input.timeoutSeconds)) : 120;
    return seconds * 1000 + TOOL_LIMIT_MS.execGrace;
  }
  if (name === "run_skill_script") return TOOL_LIMIT_MS.skillScript;
  if (name.startsWith("computer_") || name === "request_sign_in" || name === "send_file") return TOOL_LIMIT_MS.computer;
  if (name === "execute_app_tools") {
    const count = Array.isArray(input.calls) ? input.calls.length : 1;
    return Math.min(TOOL_LIMIT_MS.appTools, Math.max(TOOL_LIMIT_MS.default, count * TOOL_LIMIT_MS.appCall));
  }
  return TOOL_LIMIT_MS.default;
}

/** M21: what the model gets for a call the watchdog abandoned (it may have done its work anyway). */
function timedOut(call: ToolUseBlock, limitMs: number): ToolResultBlock {
  const minutes = Math.max(1, Math.round(limitMs / 60_000));
  const error = `${call.name} didn't finish within ${minutes} min, so this turn stopped waiting for it. It may still have done some or all of its work: check before trying it again, and tell the user if it matters.`;
  return { type: "tool_result", toolUseId: call.id, isError: true, content: [{ type: "text", text: JSON.stringify({ error, reason: "timeout" }) }] };
}

class ToolAbandoned extends Error {
  constructor() { super("Tool call abandoned"); this.name = "AbortError"; }
}

/**
 * M21: one tool call under the watchdog. The call gets its own input: a signal that also aborts at
 * its limit (tools that take a signal stop there) and a sink that drops what it writes once it is
 * abandoned (a hung tool that wakes up later can't post into a finished turn). Resolves with the
 * call's result, "timeout" at the limit, or rejects with an AbortError when the turn is stopped.
 */
async function watched<T>(input: TurnInput, limitMs: number, run: (input: TurnInput) => Promise<T>): Promise<T | "timeout"> {
  if (input.signal.aborted) throw new ToolAbandoned();
  const own = new AbortController();
  let abandoned = false;
  const guard = <A extends unknown[], R>(write: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (abandoned) throw new ToolAbandoned();
    return write(...args);
  };
  const sink: TurnSink = { status: guard((s) => input.sink.status(s)), typing: guard((on) => input.sink.typing(on)), upsertMessage: guard((d) => input.sink.upsertMessage(d)) };
  const call: TurnInput = { ...input, sink, signal: AbortSignal.any([input.signal, own.signal]) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ToolAbandoned());
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
  const expired = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), limitMs); });
  let finished = false;
  const running = run(call).finally(() => { finished = true; });
  try {
    return await Promise.race([running, stopped, expired]);
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
    stopped.catch(() => undefined);
    // Still running (timed out or stopped): it's abandoned, told to stop, and whatever it does later is ignored.
    if (!finished) {
      abandoned = true;
      own.abort();
      running.catch(() => undefined);
    }
  }
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const now = deps.now ?? (() => new Date());
  const execute = createToolExecutor({ ...deps, now });
  return { runTurn };

  /**
   * Tools and instructions every provider offers on this turn; a provider that fails is skipped.
   * M21: and what the computer provider tells the Environment section (null: no computer here).
   */
  async function providerTurn(input: TurnInput): Promise<{ tools: Tool[]; owners: Map<string, ToolProvider>; instructions: string; computer: ComputerFacts | null }> {
    const tools: Tool[] = [];
    const owners = new Map<string, ToolProvider>();
    const lines: string[] = [];
    let computer: ComputerFacts | null = null;
    for (const provider of deps.providers ?? []) {
      try {
        for (const tool of await provider.tools(input)) {
          if (owners.has(tool.name)) {
            log.warn("duplicate provider tool", { tool: tool.name, provider: provider.name });
            continue;
          }
          owners.set(tool.name, provider);
          tools.push(tool);
        }
        if (provider.instructions) lines.push(...(await provider.instructions(input)));
      } catch (error) {
        log.error("tool provider failed", { provider: provider.name, error: { name: (error as Error).name } });
      }
      if (!computer && isEnvironmentSource(provider)) {
        try {
          computer = await provider.environment(input);
        } catch (error) {
          log.warn("environment facts unavailable", { provider: provider.name, error: { name: (error as Error)?.name ?? "Error" } });
        }
      }
    }
    return { tools, owners, instructions: lines.length ? `\n${lines.join("\n")}` : "", computer };
  }

  /**
   * M21: the Environment section of this turn (agent/environment.ts) from what is known before the
   * first model call: the model (its label in the user's list), the tools it is offered, search and
   * the computer. A failure here leaves the section out and never fails the turn.
   */
  async function environmentFor(turn: TurnInput, kind: RunKind, model: Model | undefined, offer: { nativeWeb: boolean; tools: Tool[]; serverTools: string[]; ready?: string[] }, computer: ComputerFacts | null): Promise<string[]> {
    try {
      const server = offer.nativeWeb ? offer.serverTools : [];
      const names = [...offer.tools.map((tool) => tool.name), ...server];
      return environmentLines({
        kind,
        modelLabel: turn.model?.label ?? model?.label ?? null,
        tools: names,
        ...(offer.ready ? { ready: [...offer.ready, ...server] } : {}),
        search: names.includes("web_search"),
        computer,
        browserMode: deps.config.COMPUTER_BROWSER_MODE ?? "headless",
        browserIdleMs: deps.config.COMPUTER_BROWSER_IDLE_MS ?? 30 * 60_000,
      });
    } catch (error) {
      log.warn("environment section failed", { runId: turn.runId, error: { name: (error as Error)?.name ?? "Error" } });
      return [];
    }
  }

  /**
   * M12: the turn's model. A task's session uses its task's channel (input.channelId already is).
   * A resolver failure (e.g. a vault row that doesn't open) is logged by class and fails the turn.
   */
  async function resolveTurnModel(input: TurnInput, role: ModelRole) {
    try {
      return await deps.resolver!.resolve({ userId: input.userId, channelId: input.channelId, role, pinModelId: input.pinModelId ?? null });
    } catch (error) {
      log.error("model resolution failed", { runId: input.runId, error: { name: (error as Error).name } });
      throw error;
    }
  }

  /** The seen receipt hook; a failure there is logged and never touches the turn. */
  async function firstEvent(input: TurnInput): Promise<void> {
    if (!input.onFirstEvent) return;
    try {
      await input.onFirstEvent();
    } catch (error) {
      log.warn("first event hook failed", { runId: input.runId, error: { name: (error as Error).name } });
    }
  }

  /** M29: a deferred tool's line in "More tools": its provider's own entry, else by name or provider. */
  function entryOf(tool: Tool, builtins: Tool[], owners: Map<string, ToolProvider>) {
    if (builtins.some((b) => b.name === tool.name)) return defaultEntry(tool, null);
    const owner = owners.get(tool.name);
    try {
      const own = owner?.indexEntry?.(tool);
      if (own) return own;
    } catch (error) {
      log.warn("tool index entry failed", { provider: owner?.name ?? null, error: { name: (error as Error)?.name ?? "Error" } });
    }
    return defaultEntry(tool, owner?.name ?? null);
  }

  /**
   * M29: the deferred tools loaded before the first call: the ones this thread's history window
   * used or loaded (newest first, at most MAX_STICKY), then, for each connector the message names,
   * the ones the user called most from it in the last 30 days. A failed read loads nothing extra.
   */
  async function startingTools(turn: TurnInput, plan: LoadPlan, recent: readonly string[]): Promise<string[]> {
    if (!plan.on) return [];
    const loaded = resolveLoad(recent.filter((name) => plan.deferred.has(name)), plan, [], MAX_STICKY).loaded;
    const connectors = mentionedConnectors(turn.userMessage.text, plan);
    for (const group of connectors) {
      try {
        const used = await frequentTools(deps.db, turn.userId, toolsOfGroups(plan, [group]), now());
        loaded.push(...resolveLoad(used.slice(0, PRELOAD_PER_CONNECTOR), plan, loaded).loaded);
      } catch (error) {
        log.warn("connector tools not preloaded", { runId: turn.runId, error: { name: (error as Error)?.name ?? "Error" } });
      }
    }
    return loaded;
  }

  /** M29: load_tools: adds the named tools (or a small group) to the next calls of this turn. */
  function loadTools(call: ToolUseBlock, plan: LoadPlan, loaded: string[]): ToolResultBlock {
    const args = parseLoadArgs(call.input);
    const reply = (data: unknown, isError: boolean): ToolResultBlock => ({ type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });
    if (!args.success) return reply({ error: "Invalid tool arguments: give tools, a list of tool or group names from \"More tools\"." }, true);
    const outcome = resolveLoad(args.data.tools, plan, loaded);
    loaded.push(...outcome.loaded);
    const answer = loadAnswer(outcome);
    return reply(answer.data, answer.isError);
  }

  /** A provider's own failures become an error result the model can report, never a crashed turn. */
  async function executeProvided(owner: ToolProvider, call: ToolUseBlock, input: TurnInput): Promise<{ result: ToolResultBlock; endTurn: boolean }> {
    try {
      return await owner.execute(call, input);
    } catch (error) {
      if (input.signal.aborted) throw error;
      log.error("provider tool threw", { provider: owner.name, tool: call.name, error: { name: (error as Error).name } });
      // codync-harness #17: say the write may have happened, so the model checks before a retry.
      return { result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify({ error: TOOL_THREW }) }], isError: true }, endTurn: false };
    }
  }

  async function runTurn(input: TurnInput): Promise<TurnResult> {
    const result: TurnResult = {
      status: "completed",
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, estimated: false },
      model: null,
    };
    let bubbles: TextBubbles | undefined;
    let visible = false;
    let typingActive = false;
    let cutOffs = 0;
    let answering = false;
    // M14 (B3/B5): how the turn has gone so far, for the empty-reply nudge and the claim check.
    let passed = false;
    let reacted = false;
    let nudged = false;
    let claimChecked = false;
    let setupChipsNudged = false;
    // M23 W4: for the server's setup invitation (posted only after a reply, in a turn no other card ended).
    let said = false;
    let endedBy: string | null = null;
    const turnTools: { name: string; ok: boolean }[] = [];
    const repeats = new Map<string, number>();
    try {
      if (input.signal.aborted) {
        result.status = "cancelled";
        return result;
      }
      const kind: RunKind = input.kind ?? (input.taskId === null ? "chat" : "task");
      const role = ROLE[kind];
      const maxRounds = MAX_ROUNDS[kind];
      // M12: one model for this turn (channel model / default / the retry's pin) with its level;
      // without a resolver the legacy registry and its role chain.
      let llm: RegisteredLlm;
      let thinkingLevel: ThinkingLevel | undefined;
      let turn: TurnInput = input;
      if (deps.resolver) {
        const resolved = await resolveTurnModel(input, role);
        if (!resolved) throw new NoModelError();
        llm = resolved.llm;
        thinkingLevel = resolved.thinkingLevel;
        result.modelEntry = { id: resolved.entryId, label: resolved.label };
        turn = { ...input, model: { entryId: resolved.entryId, label: resolved.label, vision: resolved.model.capabilities.vision, serverWebTools: resolved.model.capabilities.serverWebTools } };
      } else if (deps.llm) {
        llm = deps.llm;
      } else {
        throw new NoModelError();
      }
      // M21: tools and model are known before the context, so its Environment section can name them.
      const extra = await providerTurn(turn);
      // M20: a brief / check-in / scan can only read (agent/read-only.ts): its tools are filtered
      // and every call is checked again right before it runs. Routines aren't background turns.
      const guard: BackgroundGuard | null = isBackgroundTurn(turn) ? await backgroundGuard(turn, extra) : null;
      const candidates = llm.roleModels(role);
      if (!candidates.length) throw deps.resolver ? new NoModelError() : new Error("No model configured for role");
      /** The tools a call to this model offers (its own web tools replace the function ones). */
      const offered = (model: Model | undefined) => {
        const nativeWeb = !!model?.capabilities.serverWebTools;
        // M23 W4: no quick replies in the morning brief (its cards carry the actions).
        const builtins = functionTools(nativeWeb, deps.config).filter(tool => !(kind === "brief" && tool.name === "quick_replies") && !(kind === "build" && isBuiltin(tool.name)));
        const others = extra.tools.filter(tool => !builtins.some(other => other.name === tool.name));
        // The provider's own server tools can't be checked call by call: a background turn gets its
        // web search only (a server-side web_fetch could reach any URL).
        const serverTools: ("web_search" | "web_fetch")[] = guard ? ["web_search"] : ["web_search", "web_fetch"];
        return { nativeWeb, builtins, tools: guard ? guard.offer(builtins, others) : [...builtins, ...others], serverTools };
      };
      // M29 (agent/loading.ts): chat and task turns send the core tools in full and list the rest
      // under "More tools"; decided once per turn from what its first model would be offered.
      const first = offered(candidates[0]);
      // (Off for background turns: they aren't chat or task turns, and their guard filters the offer.)
      const plan = planLoading({
        kind,
        modelTools: !!candidates[0]?.capabilities.tools,
        tools: first.tools,
        entry: (tool) => entryOf(tool, first.builtins, extra.owners),
        ...(deps.deferMinChars !== undefined ? { minChars: deps.deferMinChars } : {}),
      });
      const environment = await environmentFor(turn, kind, candidates[0], plan.on ? { ...first, ready: readyNames(first.tools, plan) } : first, extra.computer);
      const context = await buildContext(deps.db, turn, now(), { environment });
      // Loaded from the start: what this thread's history window used or loaded, then the tools of
      // a connector the message names that the user calls most (no extra model call, no load round).
      const loaded = await startingTools(turn, plan, context.recentTools);
      const index = indexLines(plan, loaded);
      // The model layer can fall back before its first event, so image blocks are safe only when every candidate supports vision.
      const messages = withAttachments(context.messages, context.attachments, candidates.every(model => model.capabilities.vision));
      // M23 W4: what the quick-reply rules need to know about this turn so far (agent/replies.ts).
      const replyTurn: ReplyTurn = { rules: context.replies, searched: false, approvalWaiting: false };

      await input.sink.status("thinking");
      await input.sink.typing(true);
      typingActive = true;

      // Rounds 0..maxRounds-1 may call tools; round maxRounds (reached only after tool calls in the
      // last one) is the tool-less wrap-up call (nanomuse-findings G2) instead of a failed turn.
      for (let round = 0; round <= maxRounds; round++) {
        if (input.signal.aborted) {
          result.status = "cancelled";
          break;
        }
        const wrapUp = round === maxRounds;
        const model = result.model
          ? llm.models.models.find(candidate => candidate.id === result.model!.modelId && candidate.provider === result.model!.providerId)
          : candidates[0];
        const { nativeWeb, builtins, tools: available, serverTools } = offered(model);
        // M29: the core tools, load_tools and what's loaded (only grows, appended at the end).
        const tools = toolsForCall(available, plan, loaded);
        const system = context.system + extra.instructions + (!nativeWeb && !searchOffered(deps.config)
          ? `\nWeb search isn't set up yet on this server. There is no web_search tool; tell the user honestly when search is needed.${guard ? "" : " You may still read a supplied URL with web_fetch."}`
          : "") + (index.length ? `\n${index.join("\n")}` : "");
        const calls: ToolUseBlock[] = [];
        // M14: calls whose arguments weren't one JSON object (the adapter flags them); never run.
        const invalidCalls = new Set<string>();
        let done: Extract<LlmEvent, { type: "done" }> | undefined;
        let roundText = false;
        bubbles = new TextBubbles(input.sink, undefined, reacted);
        // B4: only the newest image-bearing messages keep their images.
        trimImages(messages);

        for await (const event of llm.stream({
          role,
          system,
          messages,
          tools: wrapUp ? [] : tools,
          ...(model?.capabilities.thinking ? { thinking: true } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(nativeWeb && !wrapUp ? { serverTools } : {}),
          ...(result.model ? { pin: result.model } : {}),
          signal: input.signal,
        })) {
          // Seen receipt (M9): the model has started answering this turn.
          if (!answering && ((event.type === "text_delta" && typeof event.text === "string" && event.text !== "") || event.type === "thinking_delta" || event.type === "tool_call")) {
            answering = true;
            await firstEvent(input);
          }
          if (event.type === "text_delta") {
            const text = z.string().parse(event.text);
            if (text) {
              if (text.trim()) roundText = true;
              input.steps?.text(text);
              if (typingActive) {
                await input.sink.typing(false);
                typingActive = false;
              }
              await bubbles.append(text);
            }
          } else if (event.type === "tool_call") {
            const call = ToolCall.parse({ type: "tool_use", id: event.id, name: event.name, input: event.input });
            if (event.invalid === "arguments") invalidCalls.add(call.id);
            if (!calls.some(other => other.id === call.id)) calls.push(call);
          } else if (event.type === "usage") {
            const usage = Usage.parse(event);
            result.usage.inputTokens += usage.inputTokens;
            result.usage.outputTokens += usage.outputTokens;
            result.usage.estimated ||= usage.estimated;
          } else if (event.type === "done") {
            const identity: ModelIdentity = Identity.parse(event.model);
            if (result.model && (result.model.providerId !== identity.providerId || result.model.modelId !== identity.modelId)) {
              throw new Error("Model changed within a pinned run");
            }
            result.model ??= identity;
            done = event;
            break;
          } else if (event.type === "thinking_delta" && typeof event.text === "string") {
            // Thinking is never written to the thread; the run record keeps it (capped).
            input.steps?.thinking(event.text);
          }
          // Opaque provider data is never written to the thread.
        }
        input.steps?.endRound();
        await bubbles.finish();
        bubbles = undefined;
        if (!done) throw new Error("Model stream ended without done");
        if (input.taskId) noteFinishText(input.runId, done.message.content);
        // M23 W4: the user saw words from the assistant this turn; the provider's own web search ran.
        if (roundText && !isPass(done.message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""), reacted)) said = true;
        if (usedNativeSearch(done.message.content)) replyTurn.searched = true;

        // Cut off by max_tokens with nothing usable (a dropped tool call, or only reasoning): tell the
        // model and let it go again in smaller steps instead of ending the run on a broken reply.
        const cutOff = done.stopReason === "max_tokens" && ((done.droppedTools ?? 0) > 0 || (!roundText && !calls.length));
        if (cutOff) {
          cutOffs++;
          if (cutOffs > MAX_CUTOFFS) throw new OutputLimitReached();
        } else if (roundText || calls.length) cutOffs = 0;
        const usable = done.message.content.some(block => block.type !== "thinking");
        if (usable || !cutOff) messages.push(done.message);
        if (cutOff && !calls.length) {
          const last = messages.at(-1);
          if (last?.role === "user") messages[messages.length - 1] = { ...last, content: [...last.content, { type: "text", text: CUT_OFF_NOTE }] };
          else messages.push({ role: "user", content: [{ type: "text", text: CUT_OFF_NOTE }] });
          if (round >= maxRounds - 1) throw new OutputLimitReached();
          continue;
        }
        // The wrap-up call had no tools: whatever it said ends the turn.
        if (wrapUp) break;
        for (const block of done.message.content) {
          if (block.type !== "tool_use") continue;
          const call = ToolCall.parse(block);
          if (!calls.some(other => other.id === call.id)) calls.push(call);
        }
        const reply = done.message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
        const silent = isPass(reply, reacted);
        if (!calls.length) {
          // Native server tools are opaque provider blocks. Their results are already in the assistant message;
          // replay that message to the pinned model so it can produce the visible answer.
          if (done.stopReason === "tool_use" && done.message.content.some(block => block.type === "provider_data")) continue;
          const replies = kind === "chat" || kind === "task";
          // B3: an empty reply (no text, no tool call, not "(pass)") gets one nudge, also after tools
          // such as web_search ran; a turn that passed, already said something, or posted something
          // visible with a successful react / quick_replies / card tool is complete. A second empty
          // reply ends quietly.
          const posted = turnTools.some(tool => tool.ok && VISIBLE_TOOLS.has(tool.name));
          if (replies && !roundText && !silent && !visible && !passed && !posted && !nudged && round < maxRounds - 1) {
            nudged = true;
            pushNote(messages, EMPTY_REPLY_NOTE);
            continue;
          }
          // A setup question is incomplete without its chips. Ask the model once to finish the
          // tool call, without rewriting/cutting its question or making up options server-side.
          if (context.replies.setup?.kind === "question" && context.replies.setup.required
            && !context.replies.open && roundText && /[?？]/.test(reply) && !silent && !posted
            && !setupChipsNudged && !replyTurn.searched && !replyTurn.approvalWaiting && round < maxRounds - 1
            && !(await pendingApproval(deps.db, input, now()))) {
            setupChipsNudged = true;
            pushNote(messages, MISSING_SETUP_CHIPS_NOTE);
            continue;
          }
          // B5: a final text that claims something was made / done / set up while no tool in this
          // turn that does things succeeded gets one corrective round; its text is a follow-up bubble.
          if (replies && roundText && !silent && !claimChecked && round < maxRounds - 1 && claimsDeliverable(reply)
            && !turnTools.some(tool => tool.ok && !READ_ONLY_TOOLS.has(tool.name))) {
            claimChecked = true;
            pushNote(messages, CLAIM_NOTE);
            continue;
          }
          break;
        }
        if (silent) passed = true;
        else if (roundText) visible = true;

        const results = [];
        let endTurn = false;
        // M23 W4: web_search anywhere in this round counts for its quick_replies too, whatever the order.
        if (calls.some(call => call.name === "web_search")) replyTurn.searched = true;
        for (const call of calls) {
          if (input.signal.aborted) {
            result.status = "cancelled";
            endTurn = true;
            break;
          }
          // M29: load_tools is the runtime's own (no status pill of its own: the turn stays "Thinking").
          const loading = plan.on && call.name === LOAD_TOOLS;
          const owner = loading || builtins.some(tool => tool.name === call.name) ? undefined : extra.owners.get(call.name);
          // A deferred tool called without load_tools runs as usual and stays in the list from now on.
          if (plan.on && plan.deferred.has(call.name) && !loaded.includes(call.name)) loaded.push(call.name);
          const step = input.steps?.toolStart(call);
          let recorded = false;
          await input.sink.status(loading ? "thinking" : owner ? (owner.status?.(call) ?? "checking") : (TOOL_STATUS[call.name as keyof typeof TOOL_STATUS] ?? "checking"));
          try {
            const invalid = invalidCalls.has(call.id);
            // M20: in a background turn, checked again right before it runs; a refused call runs nothing.
            const refusal = !invalid && guard ? await guard.check(call, owner) : null;
            // M21: the watchdog (TOOL_LIMIT_MS): past its limit the call is abandoned with an error result;
            // Stop abandons it at once (an AbortError, the turn ends cancelled).
            let expired = false;
            const execution = invalid
              ? { result: invalidArguments(call), endTurn: false }
              : refusal
                ? { result: refused(call, refusal), endTurn: false }
                : loading
                  ? { result: loadTools(call, plan, loaded), endTurn: false }
                  : await (async () => {
                  const limitMs = deps.toolLimitMs?.(call) ?? toolLimitMs(call);
                  const outcome = await watched(turn, limitMs, (watchedInput) => (owner ? executeProvided(owner, call, watchedInput) : execute(call, watchedInput, builtins, replyTurn)));
                  if (outcome !== "timeout") return outcome;
                  expired = true;
                  log.warn("tool call abandoned: past its time limit", { runId: input.runId, tool: call.name, limitMs });
                  return { result: timedOut(call, limitMs), endTurn: false };
                })();
            // M20: outside content (pages, search results, connector data, files, command output) is
            // marked as data, once, here (agent/untrusted.ts); our own refusals carry none.
            let block = refusal || invalid || expired ? execution.result : wrapToolResult(call.name, execution.result);
            const rawText = execution.result.content.map(part => (part.type === "text" ? part.text : "")).join("");
            if (!invalid && !refusal && !expired) guard?.saw(call, rawText, !execution.result.isError);
            // A spacing refusal is successful but not a reaction: only a stored emoji enables the safety net.
            if (call.name === "react" && !invalid && !refusal && !expired && !execution.result.isError) {
              try { reacted ||= JSON.parse(rawText).status === "reacted"; } catch { /* Not a stored reaction. */ }
            }
            // M23 W4: a call that now waits on an approval card (no quick replies under it, no invitation).
            if (!invalid && !refusal && !expired && !execution.result.isError && waitsForApproval(rawText)) replyTurn.approvalWaiting = true;
            // B3: the same call (name + input) a third time in this turn gets a note with its result.
            if (!invalid) {
              const key = `${call.name}\u0000${stable(call.input)}`;
              const count = (repeats.get(key) ?? 0) + 1;
              repeats.set(key, count);
              if (count >= REPEAT_LIMIT) block = { ...block, content: [...block.content, { type: "text", text: repeatNote(call.name) }] };
            }
            if (step !== undefined) input.steps?.toolEnd(step, block);
            recorded = true;
            results.push(block);
            turnTools.push({ name: call.name, ok: !invalid && !block.isError });
            if (execution.endTurn) {
              endTurn = true;
              endedBy = call.name;
              break;
            }
          } finally {
            if (!recorded && step !== undefined) input.steps?.toolEnd(step, input.signal.aborted ? "cancelled" : "failed");
            await input.sink.status("thinking");
          }
        }
        if (endTurn) break;
        // B4: earlier results over ~20k chars keep only their head and tail from now on; this round's
        // results go to the next call whole.
        capOlderResults(messages);
        messages.push({ role: "user", content: cutOff ? [...results, { type: "text", text: CUT_OFF_NOTE }] : results });
        // B3: the step budget is used up: one more call without tools to sum up (was a failed turn).
        if (round === maxRounds - 1) pushNote(messages, WRAP_UP_NOTE);
      }
      // M23 W4: the soul setup's invitation is the server's (soul/setup.ts postInvitation): after a
      // reply the user saw, in a turn no other card ended, no web_search ran and no approval waits.
      // Otherwise it is left for a later turn (soulIntroAt stays unset).
      if (context.replies.setup?.kind === "invite" && result.status === "completed" && !input.signal.aborted
        && said && endedBy === null && !replyTurn.searched && !replyTurn.approvalWaiting) {
        try {
          await postInvitation(deps.db, input.sink, input.userId, context.replies.language);
        } catch (error) {
          log.warn("soul setup invitation not posted", { runId: input.runId, error: { name: (error as Error)?.name ?? "Error" } });
        }
      }
    } catch (error) {
      result.status = input.signal.aborted ? "cancelled" : "failed";
      result.error = result.status === "cancelled"
        ? null
        : error instanceof LlmError
          ? error.toPhrase()
          : error instanceof OutputLimitReached
            ? { key: "system.model_output_limit" }
            : error instanceof NoModelError
              ? { key: NO_MODEL_KEY }
              : { key: "system.model_unreachable", params: { reason: { type: "text", value: "internal" } } };
    } finally {
      clearFinishText(input.runId);
      try {
        await bubbles?.finish();
      } finally {
        // Always end a turn with an explicit idle typing event.
        await input.sink.typing(false);
        await input.sink.status(null);
      }
    }
    return result;
  }
}
