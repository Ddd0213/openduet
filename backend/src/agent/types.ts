// The seam between the agent runtime (backend/src/agent/, which talks to the model layer and
// runs tools) and the run host (backend/src/runs/, which owns HTTP, the Run row, usage, the
// Event log and SSE). Owned by the main agent: change it only through a handoff request.
//
// One chat turn:
//   1. the host stores the user's message, creates a Run (kind "chat"), checks usage limits;
//   2. the host calls AgentRuntime.runTurn(input) with a TurnSink bound to that run;
//   3. the agent streams: sink.status / sink.typing / sink.upsertMessage (the assistant's bubbles,
//      quick replies, system lines from tools), never touching Event or SSE directly;
//   4. the agent returns a TurnResult; the host writes usage onto the Run, and on "failed"
//      posts the grey system line from result.error (the agent never invents a reply);
//   5. the host emits `done`.
import type { LlmEvent, ModelIdentity, RegisteredLlm, Tool, ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import type { Phrase, StatusKey } from "../contract/common.ts";
import type { Message } from "../contract/messages.ts";
import type { ToolIndexEntry } from "./loading.ts";

/**
 * Run.kind. chat -> MODEL_CHAT; task, build -> MODEL_TASK; brief, checkin, scan, routine ->
 * MODEL_PROACTIVE. M9: "routine" = a scheduled task's run (schedule_task), in the routine's channel.
 */
export type RunKind = "chat" | "task" | "brief" | "checkin" | "scan" | "build" | "routine";

/** What a turn may write to the thread. Every call is persisted and becomes an Event. */
export interface TurnSink {
  /** Header pill + mascot; null = idle. Repeated identical values are dropped by the host. */
  status(status: StatusKey | null): Promise<void>;
  typing(on: boolean): Promise<void>;
  /**
   * Create (no id) or update (same id) a message in this turn's channel/task and return it as the
   * contract shape. Streaming text calls this repeatedly with the growing text; callers throttle
   * (at most ~8 updates/s per bubble) and always send a final update with the full text.
   */
  upsertMessage(draft: MessageDraft): Promise<Message>;
}

/** A message the agent writes. role "assistant" for replies/cards, "system" for grey lines. */
export type MessageDraft =
  | { id?: string; role: "assistant"; kind: "text"; text: string }
  | { id?: string; role: "assistant"; kind: "quick_replies"; text: string; payload: { options: string[] } }
  | { id?: string; role: "system"; kind: "system"; payload: { phrase: Phrase } }
  /** Later milestones add kinds here (task_spawn, approval, ...) in the contract's payload shapes. */
  | { id?: string; role: "assistant" | "system"; kind: Exclude<Message["kind"], "text" | "quick_replies" | "system">; text?: string; payload: Record<string, unknown> };

/** A composer attachment, already resolved by the host (L179). */
export type Attachment =
  | { fileId: string; name: string; mime: string; type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }
  | { fileId: string; name: string; mime: string; type: "text"; text: string; truncated: boolean };

export interface TurnInput {
  userId: string;
  channelId: string;
  /** set when the turn belongs to a task's own session (M3) */
  taskId: string | null;
  /** defaults to "task" when taskId is set, otherwise "chat"; picks the model role and round limit */
  kind?: RunKind;
  runId: string;
  /** the user's message as stored (already echoed to the app) */
  userMessage: Message;
  attachments: Attachment[];
  /** /skill invoked from the composer, if any (instructions injected in M6) */
  skill: string | null;
  sink: TurnSink;
  /** aborted only on shutdown; closing the app's SSE stream never cancels a run */
  signal: AbortSignal;
  /**
   * The run's record (M8, set by the run host): the agent reports each text / thinking segment and
   * tool call. Never throws and never slows the turn down; absent in tests that call runTurn directly.
   */
  steps?: RunSteps;
  /**
   * M9 seen receipt: called once, at the first streamed event of the turn's first model call that
   * shows the model is answering (a text delta, thinking or a tool call). The run host marks the
   * user's message "seen" here; a call that fails before any event never calls it. Never throws.
   */
  onFirstEvent?: () => Promise<void>;
  /** M12: a `retry` with modelId pins this one turn to that ModelEntry (the resolver checks it's usable). */
  pinModelId?: string | null;
  /**
   * M12: the model this turn runs on, set by the runtime (with a resolver) before any provider sees
   * the input; providers read it instead of the legacy role chain (e.g. vision for screenshots).
   */
  model?: TurnModel;
  /**
   * M14: a retry or a resumed turn: what the failed / interrupted attempt already did (its tool
   * calls and the bubbles it posted), so the model checks before redoing anything. Model-facing
   * English, set by the run host; buildContext puts it in front of the turn.
   */
  takeover?: string;
}

/** M12: what providers may know about the turn's model. */
export interface TurnModel { entryId: string; label: string; vision: boolean; serverWebTools: boolean }

/** A tool call's row in the run record, from toolStart until toolEnd. */
export type StepHandle = string;

/** What the agent tells the run record (src/runs/steps.ts redacts and stores it). */
export interface RunSteps {
  /** a streamed piece of the assistant's reply text */
  text(delta: string): void;
  /** a streamed piece of the model's thinking */
  thinking(delta: string): void;
  /** the model call ended: the open text / thinking segment is complete */
  endRound(): void;
  toolStart(call: ToolUseBlock): StepHandle;
  /** the result the model gets; "cancelled" (shutdown) or "failed" (threw) when there is none */
  toolEnd(handle: StepHandle, outcome: ToolResultBlock | "cancelled" | "failed"): void;
}

export interface TurnUsage { inputTokens: number; outputTokens: number; estimated: boolean }

export interface TurnResult {
  status: "completed" | "failed" | "cancelled";
  /** set when failed: the grey system line, e.g. { key: "system.model_error", params: { status } } */
  error: Phrase | null;
  /** summed over every model call in the turn */
  usage: TurnUsage;
  /** the model the run was pinned to (first done event), null if no call succeeded */
  model: ModelIdentity | null;
  /** M12: the ModelEntry the resolver chose (for the model_error card); null / absent without one */
  modelEntry?: { id: string; label: string } | null;
}

export interface AgentRuntime {
  runTurn(input: TurnInput): Promise<TurnResult>;
}

/**
 * A module that adds tools to the agent loop (M3+: connectors/approvals, tasks; M6: computer,
 * Make). The runtime offers the built-in tools first, then every provider's tools; a call goes
 * to the provider whose tools() offered that name this turn. Providers never touch Event/SSE:
 * they write to the thread through input.sink like the built-ins.
 */
export interface ToolProvider {
  /** short id for logs */
  readonly name: string;
  /** tools offered on this turn (may depend on the user, channel, task or configuration) */
  tools(input: TurnInput): Promise<Tool[]>;
  /** extra system-prompt lines for this turn (connected apps, pending approvals, task state) */
  instructions?(input: TurnInput): Promise<string[]>;
  /** the status pill while this call runs; undefined = "checking" */
  status?(call: ToolUseBlock): StatusKey | undefined;
  /** endTurn = stop the loop after this round (e.g. waiting for the user's choice) */
  execute(call: ToolUseBlock, input: TurnInput): Promise<{ result: ToolResultBlock; endTurn: boolean }>;
  /** the turn ended (completed, failed, stopped): let go of what it held (the computer's browser) */
  turnEnded?(input: TurnInput): void;
  /**
   * M29 (agent/loading.ts): where one of this provider's tools sits in the "More tools" index when
   * it isn't sent in full (its group and one sentence); null / absent = by the provider's name.
   */
  indexEntry?(tool: Tool): ToolIndexEntry | null;
}

/**
 * Called when an approval that belongs to a task is decided (approved and executed, declined or
 * expired), so the task's session can carry on with the outcome. Implemented by the task runner,
 * called by the approval service; index.ts wires the two together.
 */
export interface TaskResumer {
  resumeAfterApproval(taskId: string, outcome: { approvalId: string; status: "approved" | "declined" | "expired"; ok: boolean; summary: string }): Promise<void>;
}

/** Re-exported so the host can type its dependency without importing the llm internals. */
export type { LlmEvent, RegisteredLlm };
