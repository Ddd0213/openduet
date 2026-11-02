// The run host (L73, L79, L166): stores the user's message, checks usage, queues one run at a
// time per queue (a channel's chat, or one task's own session), binds a TurnSink to the run and
// writes everything through the event log. The agent never touches Event, Run or SSE; it only
// calls the sink. Any RunKind can run here: chat turns come from send(), background turns
// (tasks now, brief/checkin/scan in M4) from submit() with hooks around the turn.
import type { ChannelFile as FileRow, Run as RunRow } from "@prisma/client";
import type { AgentRuntime, MessageDraft, RunKind, SteeringItem, SteeringNote, TurnInput, TurnResult, TurnSink } from "../agent/types.ts";
import { SteeringInbox } from "../agent/steering.ts";
import type { Phrase, StatusKey } from "../contract/common.ts";
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { FileStore } from "../files/store.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import type { UsageMeter } from "../usage/meter.ts";
import type { RunNotices, RunRef } from "../notify/run-end.ts";
import { checkAnswers, parseForm, type Answer, type FormNote } from "../cards/forms.ts";
import { slashSkill } from "../skills/service.ts";
import { resolveAttachments } from "./attachments.ts";
import { quoteExcerpt } from "./quote.ts";
import { chatTitle, runTitle } from "./records.ts";
import { loadMessage, payloadSchemaFor } from "./serialize.ts";
import { RunRecorder, type StepRecorder } from "./steps.ts";
import { actedInRun, BACKGROUND_KINDS, BACKGROUND_RETRY_MS, retryableFailure } from "./background.ts";
import { answeredMessage, bindAnsweredMessages, didNothingYet, INTERRUPTED_PHRASE } from "./recover.ts";
import { RESTART_NOTE, takeoverNote, type TakeoverReason } from "./takeover.ts";

export interface RunHostDeps {
  db: Db; events: EventBus; usage: UsageMeter; files: FileStore; agent: AgentRuntime;
  /** the run records (M8); a recorder without the server's secrets (pattern redaction only) when omitted */
  recorder?: RunRecorder;
  /** M14 A5: delays before a failed background run's automatic retries (default +1 / +5 / +15 min; tests pass ms) */
  backgroundRetryMs?: readonly number[];
  /** M29: what each run posts and how it ends, for the pushes (notify/run-end.ts; the Notifier) */
  notices?: RunNotices;
}

export interface SendInput {
  userId: string;
  channelId: string;
  /** set for a reply in a task's own session: the message and run belong to the task */
  taskId?: string | null;
  /** defaults to "task" when taskId is set, otherwise "chat" */
  kind?: RunKind;
  hooks?: TurnHooks;
  text: string;
  clientId: string;
  fileIds: string[];
  skill: string | null;
  quickReply: { messageId: string; option: string } | null;
  /** quote reply: one of the assistant's messages in this thread (M8) */
  replyTo?: string | null;
  /** M9: submitting a form card of this thread (checked, then the card turns "submitted") */
  form?: { messageId: string; answers: Answer[] } | null;
  /**
   * M13: a voice call's hand-off: the user message and the assistant's text bubbles of this turn carry the
   * call's id (hidden in the chat, still in the agent's context). Cards and the rest don't.
   */
  callId?: string | null;
  /** M18: tell_task passed the user's words on from the chat (stored on the message's payload) */
  forwarded?: "chat" | null;
}

/** runId is null when the message was already answered (a retry of a finished send). */
export interface Accepted { runId: string | null; message: Message }

/**
 * What happened to a queued turn, as seen by its hooks. `stopped` (M10): the user pressed Stop and
 * the turn ended cancelled because of it (not a delete or a shutdown).
 */
export type TurnOutcome = { runId: string; skipped: true } | { runId: string; skipped: false; result: TurnResult; stopped?: boolean };

/** Module hooks around one queued turn (the task runner uses them; chat turns have none). */
export interface TurnHooks {
  /** A user correction consumed by the same run invalidates its previous completion decision. */
  steered?(runId: string): void;
  /** right before the turn starts; false = skip it (the Run is marked "skipped") */
  before?(runId: string): Promise<boolean>;
  /** after the Run row and usage are written, before `done` is emitted */
  after?(outcome: TurnOutcome): Promise<void>;
  /**
   * Wraps the agent call (M4 proactive turns): may pass a different input (e.g. a filtering sink)
   * to `next`, or answer without calling it. A throw counts as a failed turn, like the agent's.
   */
  around?(input: TurnInput, next: (input: TurnInput) => Promise<TurnResult>): Promise<TurnResult>;
}

/**
 * A turn that doesn't answer a stored user message (a task's first turn, a resume after an
 * approval): `prompt` is shown to the model as this turn's user message but never stored.
 */
export interface SubmitInput {
  userId: string;
  channelId: string;
  taskId: string | null;
  kind: RunKind;
  prompt: string;
  hooks?: TurnHooks;
  /**
   * The scheduled slot (brief / check-in) this run claims. Run's unique (userId, kind, scheduledFor)
   * makes a second claim of the same slot throw Prisma's P2002 before anything is queued.
   */
  scheduledFor?: Date | null;
  /**
   * Its own queue instead of the channel's (or task's): a Make build ("artifact:<id>") runs next
   * to the channel's chat instead of holding it up for minutes, and builds of one artifact still
   * run one at a time.
   */
  queue?: string;
  /** the run record's title; default: the task's title, the thread's last user message, or run.title.<kind> */
  title?: Phrase;
  /**
   * M9 routines: the task the Run row belongs to (its history, title and cancel-on-delete) while the
   * turn itself runs in the channel (taskId null), and the slot it claims (Run.slotKey, unique:
   * a second claim throws P2002 before anything is queued).
   */
  recordTaskId?: string | null;
  slotKey?: string | null;
}

interface Job {
  userId: string;
  channelId: string;
  taskId: string | null;
  /** the task the Run row belongs to: taskId, or a routine's id for its channel turns */
  recordTaskId: string | null;
  kind: RunKind;
  runId: string;
  /** the stored user message this turn answers, or null for a submitted turn */
  messageId: string | null;
  prompt: string;
  skill: string | null;
  files: FileRow[];
  hooks: TurnHooks;
  /** aborted on shutdown, when its task / channel is deleted, or by Stop (M10) */
  controller: AbortController;
  /** it reached the front of its queue (execute() began) */
  started: boolean;
  /** M10: the user pressed Stop for this turn */
  stopped: boolean;
  /** the newest assistant text bubble this turn wrote (the one a Stop marks `stopped`) */
  lastTextId: string | null;
  /** M12: a retry with modelId runs on that ModelEntry */
  pinModelId: string | null;
  /** M12: its model_error card can't resubmit it (a build on its own queue) */
  noRetry?: boolean;
  /** M13: the voice call this turn was handed by (its assistant text bubbles carry it) */
  callId?: string | null;
  /** M14: a retry / resumed turn: what the earlier attempt did (TurnInput.takeover) */
  takeover?: string;
  /** M14 A2: queued again by the restart recovery */
  recovered?: boolean;
  /** M14 A2: the status boot recovery's claim left its Run in; it starts only if the row still is (else another process took it) */
  claimed?: string;
  /** M14 A1: the queue it was put on (set by enqueue) */
  queue?: string;
  /** M14 A1: a plain user message (no files, form, quick reply, skill, call, hooks): may fold or be folded */
  foldable?: boolean;
  /** M14 A1: the run of the earlier turn that answered this message with its own */
  foldedInto?: string;
  /** M14 A1: the messages this turn answers, oldest first (its own, then the folded ones) */
  folded?: string[];
  /** M14 A5: the assistant posted something in this turn (a bubble or a card reached the thread) */
  posted?: boolean;
  /** M14 A5: how many automatic retries came before this attempt (0 / absent = the first) */
  autoRetry?: number;
  /** A joined user message, or the server's note for this turn (steerNote). */
  steering?: SteeringInbox<{ messageId: string; files: FileRow[] } | SteeringNote>;
  steeringIds?: string[];
  /** What each accepted steering message needs to run as its own turn after Stop (rerunUnseen). */
  steeringTurns?: Map<string, { hooks: TurnHooks; title: unknown; foldable: boolean }>;
}

/**
 * M14 A5: one scheduled automatic retry (its timer, and a promise idle() can wait on). `fired`: its
 * timer went off and the resubmit is running (shutdown() waits for it instead of dropping it).
 */
interface PendingRetry { timer: ReturnType<typeof setTimeout> | undefined; settle: () => void; done: Promise<void>; fired: boolean }

/** M14 A2: the stored user message a recovered chat turn answers (recover.ts answeredMessage). */
type StoredMessage = { id: string; text: string; payload: string; callId: string | null };

/** M14 A1: may this job fold the plain messages behind it, or be folded into the turn ahead? */
const isFoldable = (job: Job): boolean =>
  job.foldable === true && job.kind === "chat" && job.taskId === null && job.messageId !== null
  && !job.foldedInto && !job.takeover && !job.pinModelId && !job.recovered && !job.stopped && !job.controller.signal.aborted;

/**
 * M12: what a model_error card keeps (in its stored payload, never sent to the app) to resubmit the
 * failed turn: the run's kind and thread, and the stored user message it answered (its text, skill
 * and files are read from that row) or, for a submitted turn, the prompt the model saw.
 */
export interface RetryOf {
  kind: RunKind;
  channelId: string;
  taskId: string | null;
  recordTaskId: string | null;
  messageId: string | null;
  prompt: string | null;
  skill: string | null;
  /**
   * M14 A1: a folded turn's burst, oldest first (`messageId` is the newest): a Retry marks them all
   * seen. Optional: a caller whose schema drops it (models/cards.ts) gets it read from the card.
   */
  folded?: string[];
}

/** M12: a retried turn of a kind, for the module that owns that kind's hooks. */
export interface RetryTurn { userId: string; channelId: string; taskId: string | null; recordTaskId: string | null; kind: RunKind; messageId: string | null }
/**
 * Rebuilds the hooks of a retried turn (the task runner's status, a routine's lastRunStatus, a
 * check-in's filter). Kinds without one (build, scan) aren't retried: their card says retry false.
 */
export type RetryHooks = (turn: RetryTurn) => TurnHooks;

/**
 * Which queued or running turns to cancel. A task: its session and a routine's runs (DELETE of a
 * task). A channel: everything in it (DELETE of a channel), or with `chatOnly` (M10) only the
 * channel's own chat turns (kind chat, taskId null), not its tasks, builds, routines or briefs.
 * A task with `sessionOnly` (M21): only its own session's turns (taskId), not a routine's runs.
 */
export type CancelScope = { userId: string; taskId: string; sessionOnly?: boolean } | { userId: string; channelId: string; chatOnly?: boolean };

/**
 * M10 Stop: a channel's own chat turn (kind chat, taskId null) or a task's own session (kind task;
 * a routine's runs aren't its session).
 */
export type StopScope = { userId: string; channelId: string } | { userId: string; taskId: string };

function inScope(job: Job, scope: CancelScope): boolean {
  if (job.userId !== scope.userId) return false;
  // M21: `sessionOnly` (a task marked done) cancels only the task's own session turns.
  if ("taskId" in scope) return job.taskId === scope.taskId || (!scope.sessionOnly && job.recordTaskId === scope.taskId);
  if (job.channelId !== scope.channelId) return false;
  return !scope.chatOnly || (job.kind === "chat" && job.taskId === null);
}

function inStopScope(job: Job, scope: StopScope): boolean {
  if (job.userId !== scope.userId) return false;
  if ("taskId" in scope) return job.taskId === scope.taskId;
  return inScope(job, { ...scope, chatOnly: true });
}

/** M29: the run as the pushes see it (notify/run-end.ts); the call id is read now (a hang-up clears it). */
const runRef = (job: Job): RunRef => ({
  userId: job.userId, channelId: job.channelId, taskId: job.taskId, recordTaskId: job.recordTaskId, runId: job.runId, kind: job.kind, callId: job.callId ?? null,
});

/** One queue per channel for chat; a task's own session has its own queue. */
export const queueKey = (job: { channelId: string; taskId: string | null }): string => (job.taskId ? `task:${job.taskId}` : job.channelId);

/** Waits until every promise settled, or `timeoutMs` passed. */
async function settleWithin(promises: Promise<void>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([Promise.allSettled(promises), timeout]);
  clearTimeout(timer);
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0, estimated: false } as const;
const internalFailure = (): Phrase => ({ key: "system.model_unreachable", params: { reason: { type: "text", value: "internal" } } });

/** Used when no agent is wired (tests that don't chat): every turn fails honestly. */
export const unavailableAgent: AgentRuntime = {
  runTurn: async () => ({ status: "failed", error: internalFailure(), usage: { ...NO_USAGE }, model: null }),
};

/** M12: the turn had no usable model (agent/runtime.ts NO_MODEL_KEY); its card has no retry. */
const NO_MODEL_PHRASE = "system.no_model";
/** M14: a refused key, no credit, a model not set up: a retry won't help, the card offers the settings. */
const SETUP_PHRASES: ReadonlySet<string> = new Set(["system.model_auth", "system.model_quota", "system.model_config"]);

/** A stored JSON object payload, or {} when it isn't one. */
function parseObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);
const staleForm = () => new HttpError(409, "stale_version", "form: this form isn't open any more", "form");
/** M21: quick replies already chosen, or an older turn's (the user wrote after them): they can't start a turn. */
const staleQuickReply = () => new HttpError(409, "conflict", "quickReply: these options aren't current any more", "quickReply");

export class RunHost {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly stopping = new AbortController();
  /** sends being accepted right now, by user + clientId, so a parallel retry joins the first */
  private readonly accepting = new Map<string, Promise<Accepted>>();
  /** user message id -> its run while that run is queued or running */
  private readonly activeRuns = new Map<string, string>();
  /** queue key -> runs queued there that haven't started yet */
  private readonly waiting = new Map<string, number>();
  /** run id -> its job and a promise that settles when the job has finished (queued or running) */
  private readonly live = new Map<string, { job: Job; settled: Promise<void> }>();
  /** M14 (A1): queue key -> its jobs that haven't started yet, in enqueue order */
  private readonly pending = new Map<string, Job[]>();
  /** M14 (A5): automatic retries of failed background runs waiting for their time */
  private readonly retries = new Set<PendingRetry>();
  /** M14 (F1): chat runs a graceful shutdown left queued / running for the next boot (recoverStaleRuns) */
  private readonly leftRuns = new Set<string>();
  private readonly recorder: RunRecorder;
  /** M12: kind -> the hooks a retried turn of that kind runs with (chat: none) */
  private readonly retryHooks = new Map<RunKind, RetryHooks>([["chat", () => ({})]]);

  constructor(private readonly deps: RunHostDeps) {
    this.recorder = deps.recorder ?? new RunRecorder({ db: deps.db });
  }

  /**
   * Validates, checks usage, stores the user's message and queues the run (L73). Idempotent per
   * (user, clientId): a retry after a dropped stream gets the stored message back, never a copy.
   */
  send(input: SendInput): Promise<Accepted> {
    if (this.stopping.signal.aborted) return Promise.reject(new HttpError(503, "internal", "The server is restarting."));
    const key = `${input.userId}\u0000${input.clientId}`;
    const pending = this.accepting.get(key);
    if (pending) return pending;
    const work = this.accept(input).finally(() => this.accepting.delete(key));
    this.accepting.set(key, work);
    return work;
  }

  private async accept(input: SendInput): Promise<Accepted> {
    const { db, usage } = this.deps;
    const taskId = input.taskId ?? null;
    const kind: RunKind = input.kind ?? (taskId ? "task" : "chat");
    const requestedSkill = input.skill ?? slashSkill(input.text);
    const existing = await db.message.findFirst({ where: { userId: input.userId, channelId: input.channelId, taskId, role: "user", clientId: input.clientId } });
    if (existing) {
      const message = await this.emitMessage(input.userId, existing.id);
      return { runId: this.activeRuns.get(existing.id) ?? null, message };
    }
    const files = await this.pendingFiles(input);
    const chip = input.quickReply ? await this.checkQuickReply(input.userId, input.channelId, input.quickReply) : null;
    const replyTo = input.replyTo ? await this.quoted(input.userId, input.channelId, taskId, input.replyTo) : null;
    const form = input.form ? await this.formSubmission(input.userId, input.channelId, taskId, input.form) : null;
    await this.ensureUsage(input.userId, input.channelId, taskId);
    const title = taskId ? await this.titleFor({ userId: input.userId, kind, channelId: input.channelId, taskId }) : chatTitle(input.text, files[0]?.name);
    // Reserve against the actual owner after validation. A closing/closed run refuses admission
    // synchronously and this send becomes a normal next turn. Explicit skills and voice keep
    // their own configuration/ownership rather than silently changing a running turn.
    const key = queueKey({ channelId: input.channelId, taskId });
    const queuedAhead = (this.pending.get(key) ?? []).some((job) => !job.foldedInto && !job.controller.signal.aborted);
    const target = !requestedSkill && !input.callId && !input.forwarded && !queuedAhead
      ? [...this.live.values()].map((entry) => entry.job).find((job) =>
          job.userId === input.userId && job.channelId === input.channelId && job.taskId === taskId
          && job.kind === kind && job.started && !job.callId && !job.controller.signal.aborted)
      : undefined;
    const settleSteering = target?.steering?.reserve();
    let committedSteering: { messageId: string; files: FileRow[] } | undefined;
    try {
      const { message, run } = await db.$transaction(async (tx) => {
        const message = await tx.message.create({ data: {
          userId: input.userId, channelId: input.channelId, taskId, role: "user", kind: "text", text: input.text,
          payload: JSON.stringify({ skill: requestedSkill, ...(settleSteering ? { steeringRunId: target!.runId } : {}), ...(replyTo ? { replyTo } : {}), ...(form ? { form: form.note } : {}), ...(input.forwarded ? { forwarded: input.forwarded } : {}) }), status: "sent", clientId: input.clientId,
          callId: input.callId ?? null,
        } });
        if (files.length > 0) {
          const bound = await tx.channelFile.updateMany({ where: { id: { in: files.map((f) => f.id) }, messageId: null, deletedAt: null }, data: { messageId: message.id } });
          if (bound.count !== files.length) throw invalid("fileIds", "a file was already sent or removed");
        }
        // The card is claimed only if it is still exactly as checked: a second submit (or a Skip) racing this one loses with 409.
        if (form) {
          const claimed = await tx.message.updateMany({ where: { id: form.cardId, payload: form.was }, data: { payload: form.next } });
          if (claimed.count !== 1) throw staleForm();
        }
        // M21: the same for a quick reply: a second tap (or another option) racing this one loses with 409, and nothing is stored.
        if (chip) {
          const claimed = await tx.message.updateMany({ where: { id: chip.cardId, payload: chip.was, kind: "quick_replies" }, data: { payload: chip.next } });
          if (claimed.count !== 1) throw staleQuickReply();
        }
        const run = settleSteering ? null : await tx.run.create({ data: { userId: input.userId, kind, status: "queued", channelId: input.channelId, taskId, title: title ? JSON.stringify(title) : null } });
        return { message, run };
      });
      if (settleSteering) {
        const owner = target!;
        committedSteering = { messageId: message.id, files };
        this.activeRuns.set(message.id, owner.runId);
        (owner.steeringIds ??= []).push(message.id);
        // Kept for Stop: a correction the model never started on runs as its own turn then.
        (owner.steeringTurns ??= new Map()).set(message.id, {
          hooks: input.hooks ?? {}, title,
          foldable: kind === "chat" && taskId === null && files.length === 0 && !input.quickReply && !input.form && !input.hooks,
        });
        owner.folded = [...(owner.folded ?? (owner.messageId ? [owner.messageId] : [])), message.id];
        owner.messageId = message.id;
      }
      await usage.touch(input.userId);
      const shaped = await this.emitMessage(input.userId, message.id);
      if (form) await this.emitMessage(input.userId, form.cardId);
      if (chip) await this.emitMessage(input.userId, chip.cardId);
      if (settleSteering) {
        return { runId: target!.runId, message: shaped };
      }
      if (!run) throw new Error("Missing run for a new turn");

      const job: Job = {
        userId: input.userId, channelId: input.channelId, taskId, recordTaskId: taskId, kind, runId: run.id, messageId: message.id,
        prompt: input.text, skill: requestedSkill, files, hooks: input.hooks ?? {}, controller: new AbortController(),
        started: false, stopped: false, lastTextId: null, pinModelId: null, callId: input.callId ?? null,
        // A1: only plain typed messages fold (a quote reply too: its excerpt stays in the stored payload).
        foldable: kind === "chat" && taskId === null && files.length === 0 && !requestedSkill && !input.quickReply && !input.form && !input.callId && !input.hooks,
      };
      this.activeRuns.set(message.id, run.id);
      this.enqueue(queueKey(job), this.track(job, () => this.activeRuns.delete(message.id)), job);
      return { runId: run.id, message: shaped };
    } finally { settleSteering?.(committedSteering); }
  }

  /**
   * M9 form submit (contract §2): the card is a form of this thread and still open (else 409
   * stale_version), and the answers fit its fields (else 400 validation_failed, field form).
   * Returns the card's payload as stored and as it becomes, and the note the user message keeps.
   */
  private async formSubmission(userId: string, channelId: string, taskId: string | null, submit: { messageId: string; answers: Answer[] }) {
    const row = await this.deps.db.message.findFirst({ where: { id: submit.messageId, userId, channelId, taskId, kind: "form", role: "assistant" } });
    const card = row ? parseForm(row.payload) : null;
    if (!row || !card) throw invalid("form", "not a form card in this thread");
    if (card.state !== "open") throw staleForm();
    const check = checkAnswers(card, submit.answers);
    if (!check.ok) throw invalid("form", check.message);
    const next = { ...card, state: "submitted" as const, answers: check.answers };
    payloadSchemaFor("form").parse(next);
    const note: FormNote = { messageId: row.id, title: card.title, summary: check.summary };
    return { cardId: row.id, was: row.payload, next: JSON.stringify(next), note };
  }

  /**
   * Queues a background turn (any RunKind) that answers no stored user message. Returns the run
   * id, or null while shutting down (the work stays to be picked up after the restart).
   */
  async submit(input: SubmitInput): Promise<string | null> {
    if (this.stopping.signal.aborted) return null;
    const recordTaskId = input.recordTaskId ?? input.taskId;
    const title = input.title ?? (await this.titleFor({ ...input, taskId: recordTaskId }));
    const run = await this.deps.db.run.create({ data: {
      userId: input.userId, kind: input.kind, status: "queued", channelId: input.channelId, taskId: recordTaskId, scheduledFor: input.scheduledFor ?? null,
      slotKey: input.slotKey ?? null, title: title ? JSON.stringify(title) : null,
    } });
    const job: Job = {
      userId: input.userId, channelId: input.channelId, taskId: input.taskId, recordTaskId, kind: input.kind, runId: run.id, messageId: null,
      prompt: input.prompt, skill: null, files: [], hooks: input.hooks ?? {}, controller: new AbortController(),
      started: false, stopped: false, lastTextId: null, pinModelId: null,
      // A build runs on its own queue next to the chat: it's never resubmitted from a card.
      ...(input.queue ? { noRetry: true } : {}),
    };
    this.enqueue(input.queue ? `queue:${input.queue}` : queueKey(job), this.track(job), job);
    return run.id;
  }

  /**
   * M12: kinds whose failed turns a model_error card can resubmit, with the hooks their module
   * needs (chat has none). Registered by the task runner, routines and proactive turns.
   */
  retryable(kind: RunKind, hooks: RetryHooks): void {
    this.retryHooks.set(kind, hooks);
  }

  /**
   * M12 `retry` on a model_error card: resubmits the failed run's turn (same kind, channel, task and
   * stored user message, or the same prompt for a submitted turn) as a new run, on `pinModelId` when
   * given. 409 conflict when the turn is running again already or its message is gone; 429 over the
   * usage limit. Returns the new run's id.
   */
  async retry(userId: string, runId: string, of: RetryOf, pinModelId: string | null): Promise<string> {
    if (this.stopping.signal.aborted) throw new HttpError(503, "internal", "The server is restarting.");
    const { db } = this.deps;
    const failed = await db.run.findFirst({ where: { id: runId, userId } });
    const hooksFor = this.retryHooks.get(of.kind);
    if (!failed || !hooksFor) throw invalid("action", "this turn can't be retried");
    let files: FileRow[] = [];
    let prompt = of.prompt ?? "";
    let skill = of.skill;
    if (of.messageId) {
      const message = await db.message.findFirst({ where: { id: of.messageId, userId, channelId: of.channelId, taskId: of.taskId, role: "user" } });
      if (!message) throw new HttpError(409, "conflict", "The message this turn answered is gone.");
      if (this.activeRuns.has(message.id)) throw new HttpError(409, "conflict", "This turn is running again already.");
      prompt = message.text;
      const payload = parseObject(message.payload);
      skill = of.skill ?? (typeof payload.skill === "string" ? payload.skill : null);
      files = await db.channelFile.findMany({ where: { messageId: message.id, userId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    }
    await this.ensureUsage(userId, of.channelId, of.taskId);
    // M14 (A1): a folded turn's retry answers the whole burst again; each message turns seen with it.
    const folded = of.messageId ? await this.burstOf(userId, runId, of) : [];
    // M14 (A3): the retry starts with what the failed attempt already did (its steps and bubbles).
    const takeover = await this.takeoverFor(failed.id, failed.status === "cancelled" ? "restart" : "failed");
    const run = await db.$transaction(async (tx) => {
      const created = await tx.run.create({ data: { userId, kind: of.kind, status: "queued", channelId: of.channelId, taskId: of.recordTaskId, title: failed.title } });
      await bindAnsweredMessages(tx, userId, created.id, folded.length ? folded : of.messageId ? [of.messageId] : []);
      return created;
    });
    const job: Job = {
      userId, channelId: of.channelId, taskId: of.taskId, recordTaskId: of.recordTaskId, kind: of.kind, runId: run.id, messageId: of.messageId,
      prompt, skill, files, hooks: hooksFor({ userId, channelId: of.channelId, taskId: of.taskId, recordTaskId: of.recordTaskId, kind: of.kind, messageId: of.messageId }),
      controller: new AbortController(), started: false, stopped: false, lastTextId: null, pinModelId,
      ...(takeover ? { takeover } : {}),
      ...(folded.length > 1 ? { folded } : {}),
      // M14 (A5): a retry the user tapped isn't retried on its own: if it fails, its card shows at once.
      autoRetry: (this.deps.backgroundRetryMs ?? BACKGROUND_RETRY_MS).length,
    };
    const messageId = of.messageId;
    if (messageId) this.activeRuns.set(messageId, run.id);
    this.enqueue(queueKey(job), this.track(job, messageId ? () => this.activeRuns.delete(messageId) : undefined), job);
    return run.id;
  }

  /**
   * M14 A1: the burst a failed folded turn answered (oldest first, `of.messageId` last): `of.folded`,
   * else what the run's model_error card keeps (the card handler's schema drops the field). Only
   * user messages of the same thread count; [] when it wasn't a folded turn.
   */
  private async burstOf(userId: string, runId: string, of: RetryOf): Promise<string[]> {
    const { db } = this.deps;
    let ids = of.folded;
    if (!ids) {
      const card = await db.message.findFirst({
        where: { userId, channelId: of.channelId, taskId: of.taskId, kind: "model_error", payload: { contains: runId } },
        orderBy: { createdAt: "desc" }, select: { payload: true },
      });
      const stored = card ? parseObject(card.payload) : {};
      const retryOf = stored.runId === runId && stored.retryOf && typeof stored.retryOf === "object" ? (stored.retryOf as Record<string, unknown>) : {};
      ids = Array.isArray(retryOf.folded) && retryOf.messageId === of.messageId ? retryOf.folded.filter((id): id is string => typeof id === "string") : [];
    }
    const wanted = [...new Set(ids)].filter((id) => id !== of.messageId);
    if (!wanted.length) return [];
    const rows = await db.message.findMany({ where: { id: { in: wanted }, userId, channelId: of.channelId, taskId: of.taskId, role: "user" }, select: { id: true } });
    const known = new Set(rows.map((r) => r.id));
    return [...wanted.filter((id) => known.has(id)), of.messageId!];
  }

  /** Runs queued on a task's own queue that haven't started yet (the running one isn't counted). */
  waitingFor(taskId: string): number {
    return this.waiting.get(queueKey({ channelId: "", taskId })) ?? 0;
  }

  /**
   * M21: chat turns queued in a channel's own thread that haven't started yet (the running one
   * isn't counted). A resume after an approval is left out when one waits: that turn reads the
   * decided cards anyway.
   */
  pendingChat(userId: string, channelId: string): number {
    return (this.pending.get(queueKey({ channelId, taskId: null })) ?? [])
      .filter((job) => job.userId === userId && job.kind === "chat" && !job.started && !job.foldedInto && !job.controller.signal.aborted).length;
  }

  /**
   * A server note for the chat turn running in this thread, but only while a user message that
   * joined it (steering) still waits to be read: the turn reads the note with that message, as a
   * turn queued behind would read it in its context (an approval decided meanwhile). False = no
   * such turn; the caller queues its own.
   */
  steerNote(userId: string, channelId: string, note: string): boolean {
    const job = [...this.live.values()].map((entry) => entry.job).find((candidate) =>
      candidate.userId === userId && candidate.channelId === channelId && candidate.taskId === null && candidate.kind === "chat"
      && candidate.started && !candidate.controller.signal.aborted && !!candidate.steering?.waiting());
    const settle = job?.steering?.reserve();
    if (!settle) return false;
    settle({ note });
    return true;
  }

  /**
   * M9 deletes: cancels every queued or running turn of a task (its session, and a routine's runs)
   * or of a channel (its chat, its tasks, builds and routines), then waits up to `timeoutMs` for
   * them to write their results. A queued turn never reaches the model; a running one stops at its
   * next step. Returns how many were cancelled.
   */
  async cancel(scope: CancelScope, timeoutMs = 10_000): Promise<number> {
    const matches = [...this.live.values()].filter(({ job }) => inScope(job, scope));
    if (!matches.length) return 0;
    for (const { job } of matches) job.controller.abort();
    await settleWithin(matches.map((m) => m.settled), timeoutMs);
    return matches.length;
  }

  /**
   * M10 Stop: cancels the current turn of a channel's own chat (kind chat, taskId null) or of a
   * task's own session: the running one, else the first queued one. Turns queued behind it still
   * run. The text the assistant already streamed stays, marked `stopped` (finish()); nothing streamed =
   * nothing posted; the run ends `cancelled` with the usual `done`. Waits up to `timeoutMs` for a
   * running turn to write its result, so the app sees typing off and the `done` before the answer.
   * Returns how many turns it stopped (0 = nothing running or queued there).
   */
  async stop(scope: StopScope, timeoutMs = 10_000): Promise<number> {
    // Jobs are kept in enqueue order and a queue runs in that order, so the first match is the current turn.
    const current = [...this.live.values()].find(({ job }) => inStopScope(job, scope));
    if (!current) return 0;
    current.job.stopped = true;
    current.job.controller.abort();
    // A queued turn ends (cancelled, without reaching the model) when its queue reaches it; don't hold the request for that.
    if (current.job.started) await settleWithin([current.settled], timeoutMs);
    return 1;
  }

  /**
   * M13: the call hung up: turns it handed over that are still queued or running post the rest of
   * their reply in the chat as usual (no callId), so nothing the assistant says after the call is hidden.
   */
  releaseCall(callId: string): void {
    for (const { job } of this.live.values()) if (job.callId === callId) job.callId = null;
  }

  /** M13: whether Stop on this scope would stop something (a turn of it is running or queued). */
  busy(scope: StopScope): boolean {
    return [...this.live.values()].some(({ job }) => inStopScope(job, scope));
  }

  /** M13: the kind of a queued or running run (null once it has finished, or never ran here). */
  kindOf(runId: string): RunKind | null {
    return this.live.get(runId)?.job.kind ?? null;
  }

  /** The queued work for a job, kept in `live` (for cancel) until it has finished. */
  private track(job: Job, done?: () => void): () => Promise<void> {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.live.set(job.runId, { job, settled });
    return () => this.execute(job).finally(() => {
      this.live.delete(job.runId);
      for (const id of job.steeringIds ?? []) this.activeRuns.delete(id);
      done?.();
      settle();
    });
  }

  /** Waits until every queued run has finished, and every pending automatic retry (A5) has run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.retries.size > 0) {
      await Promise.allSettled([...this.queues.values(), ...[...this.retries].map((r) => r.done)]);
    }
  }

  /**
   * On shutdown: tell running turns to stop, drop the automatic retries still waiting for their time,
   * then wait for the results (and for a retry whose timer already fired: its resubmit sees
   * `stopping` before it creates a Run, so it ends without one).
   */
  async shutdown(): Promise<void> {
    this.stopping.abort();
    for (const entry of this.retries) {
      if (entry.fired) continue;
      clearTimeout(entry.timer);
      entry.settle();
      this.retries.delete(entry);
    }
    await this.idle();
  }

  /**
   * At startup: runs of any kind left queued or running by a previous process are cancelled (no
   * process is running them any more), and their status/typing are cleared so a reconnecting app
   * doesn't show a pill forever. Tasks those runs belonged to are paused by the task runner
   * (TaskService.recoverAfterRestart), which index.ts must call BEFORE this: it finds the tasks
   * by their runs that are still queued/running.
   */
  async recoverStaleRuns(now: Date = new Date()): Promise<number> {
    const { db, events } = this.deps;
    const stale = await db.run.findMany({ where: { status: { in: ["queued", "running"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    let handled = 0;
    /** runs this pass already settled as part of a left turn's burst (A1 + F1) */
    const taken = new Set<string>();
    for (const run of stale) {
      // Already picked up by this process (a second call): never enqueued twice.
      if (this.live.has(run.id) || taken.has(run.id)) continue;
      // M14 (A2): a channel's own chat turn that never reached the model is queued again as it was.
      const message = run.kind === "chat" && run.channelId && !run.taskId ? await answeredMessage(db, run) : null;
      if (message && !run.startedAt) {
        // Claimed with a real transition (queued → running, running → queued; startedAt stays null,
        // which boot reads as "never started"), so of two calls or two booting processes only one
        // enqueues it.
        const next = run.status === "queued" ? "running" : "queued";
        const claimed = await db.run.updateMany({ where: { id: run.id, status: run.status, startedAt: null }, data: { status: next } });
        if (claimed.count !== 1) continue;
        handled++;
        await this.requeue(run, await this.boundInputs(run, message), null, next);
        continue;
      }
      const cancelled = await db.run.updateMany({ where: { id: run.id, status: run.status }, data: { status: "cancelled", finishedAt: new Date() } });
      if (cancelled.count !== 1) continue;
      handled++;
      if (!run.channelId) continue;
      // A routine's run belongs to its task (Run.taskId) but ran in the channel's timeline.
      const ref = { runId: run.id, taskId: run.kind === "routine" ? null : run.taskId, kind: run.kind as RunKind };
      await events.emit(run.userId, run.channelId, "status", { ...ref, status: null });
      await events.emit(run.userId, run.channelId, "typing", { ...ref, typing: false });
      await events.emit(run.userId, run.channelId, "done", { ...ref, status: "cancelled", error: null });
      if (!message) continue;
      // A2: a chat turn cut off before it did anything (< 1 h) runs again with the restart note;
      // one that already did something (or ran long) gets the retry card, whose retry carries the
      // A3 note of what it did.
      try {
        // A1 + F1: the plain messages it folded are answered by its re-run or card, not one by one.
        const previouslyTaken = taken.size;
        const burst = await this.leftBurst(run, message, stale, taken);
        handled += taken.size - previouslyTaken;
        if (await didNothingYet(db, run, now)) {
          const fresh = await db.$transaction(async (tx) => {
            const created = await tx.run.create({ data: { userId: run.userId, kind: "chat", status: "queued", channelId: run.channelId, taskId: null, title: run.title } });
            await bindAnsweredMessages(tx, run.userId, created.id, burst.map((row) => row.id));
            return created;
          });
          await this.requeue(fresh, burst, (await this.takeoverFor(run.id, "restart")) ?? RESTART_NOTE, "queued");
        } else {
          await this.interruptedCard(run, burst.map((m) => m.id));
        }
      } catch (error) {
        log.error("restart recovery failed", { runId: run.id, error: { name: (error as Error).name } });
      }
    }
    return handled;
  }

  /**
   * A2: queues a stored chat message's turn again on `run` (the same Run when it never started, a
   * new one for a resumed turn). A call's hand-off turn posts its reply visibly: the call is over.
   */
  private async requeue(run: { id: string; userId: string; channelId: string | null }, burst: StoredMessage[], takeover: string | null, claimed: string): Promise<void> {
    const { db } = this.deps;
    // A1 + F1: a left folding turn's burst (oldest first) is answered as one turn on its newest message.
    const message = burst.at(-1)!;
    const payload = parseObject(burst[0]!.payload);
    const files = await db.channelFile.findMany({ where: { messageId: message.id, userId: run.userId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const job: Job = {
      userId: run.userId, channelId: run.channelId!, taskId: null, recordTaskId: null, kind: "chat", runId: run.id, messageId: message.id,
      prompt: message.text, skill: typeof payload.skill === "string" ? payload.skill : null, files, hooks: {}, controller: new AbortController(),
      started: false, stopped: false, lastTextId: null, pinModelId: null, callId: null,
      ...(takeover ? { takeover } : {}),
      ...(burst.length > 1 ? { folded: burst.map((m) => m.id) } : {}),
      // Its own form / quick reply / quote stays in the stored message; it is never folded (A1).
      recovered: true, claimed,
    };
    this.activeRuns.set(message.id, run.id);
    this.enqueue(queueKey(job), this.track(job, () => this.activeRuns.delete(message.id)), job);
  }

  /**
   * M14 (A1 + F1): a chat turn the shutdown (or a crash) left running may have folded the plain
   * messages queued right behind it when it started: their Runs stay queued, never started, made
   * after its message and before its startedAt, next on the channel's queue. Those are claimed
   * (queued → skipped, with their done) so boot doesn't answer them one by one; the turn's re-run or
   * card covers the burst. Returns the burst, oldest first (`message` alone when there's none). A
   * row another process claimed first ends it.
   */
  private async leftBurst(left: RunRow, message: StoredMessage, stale: RunRow[], taken: Set<string>): Promise<StoredMessage[]> {
    const { db, events } = this.deps;
    const burst = await this.boundInputs(left, message);
    // Steering has no independent Run to replay. Its durable link keeps it attached to the
    // interrupted turn's recovery/retry, including input accepted just before shutdown.
    const steering = await db.message.findMany({
      where: { userId: left.userId, channelId: left.channelId!, taskId: left.taskId, role: "user", id: { notIn: burst.map((row) => row.id) }, payload: { contains: `"steeringRunId":${JSON.stringify(left.id)}` } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, text: true, payload: true, callId: true },
    });
    if (!left.startedAt || !(await this.plainMessage(message))) return [...burst, ...steering];
    for (const run of stale) {
      if (run.createdAt.getTime() <= left.createdAt.getTime() || run.id === left.id) continue;
      if (run.createdAt.getTime() > left.startedAt.getTime()) break;
      // Only the channel's own queue (its chat, briefs, check-ins, routines); tasks and builds have theirs.
      if (run.userId !== left.userId || run.channelId !== left.channelId || run.kind === "build" || (run.taskId !== null && run.kind !== "routine")) continue;
      if (run.kind !== "chat" || run.status !== "queued" || run.startedAt || taken.has(run.id) || this.live.has(run.id)) break;
      const next = await answeredMessage(db, run);
      if (!next || !(await this.plainMessage(next))) break;
      const claimed = await db.run.updateMany({ where: { id: run.id, status: "queued", startedAt: null }, data: { status: "skipped", finishedAt: new Date() } });
      if (claimed.count !== 1) break;
      taken.add(run.id);
      await events.emit(run.userId, run.channelId, "done", { runId: run.id, taskId: null, kind: run.kind as RunKind, status: "cancelled", error: null });
      burst.push(next);
    }
    if (burst.length > 1) log.info("left chat burst recovered", { runId: left.id, messages: burst.length });
    return [...burst, ...steering];
  }

  /** A persisted retry/resume binding preserves all input receipts, not just the latest row. */
  private async boundInputs(run: RunRow, message: StoredMessage): Promise<StoredMessage[]> {
    if (!run.channelId) return [message];
    const payload = parseObject(message.payload);
    const ids = payload.answeringRunId === run.id && Array.isArray(payload.answeringMessageIds)
      ? payload.answeringMessageIds.filter((id): id is string => typeof id === "string" && id !== message.id) : [];
    if (!ids.length) return [message];
    const rows = await this.deps.db.message.findMany({
      where: { id: { in: ids }, userId: run.userId, channelId: run.channelId, taskId: run.taskId, role: "user" },
      select: { id: true, text: true, payload: true, callId: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return [...new Set(ids)].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []).concat(message);
  }

  /** A1: a stored message that could fold (no files, /skill, form or call; a quote reply folds). */
  private async plainMessage(message: StoredMessage): Promise<boolean> {
    const payload = parseObject(message.payload);
    if (message.callId || (typeof payload.skill === "string" && payload.skill) || payload.form) return false;
    return (await this.deps.db.channelFile.count({ where: { messageId: message.id } })) === 0;
  }

  /** A2: the model_error card of a chat turn the restart cut off after it had done something. */
  private async interruptedCard(run: RunRow, burst: string[]): Promise<void> {
    const { db } = this.deps;
    const messageId = burst.at(-1)!;
    const original = await db.message.findFirst({ where: { id: burst[0], userId: run.userId }, select: { payload: true, text: true } });
    const storedSkill = original ? parseObject(original.payload).skill : null;
    const skill = typeof storedSkill === "string" ? storedSkill : original ? slashSkill(original.text) : null;
    const retryOf: RetryOf = {
      kind: "chat", channelId: run.channelId!, taskId: null, recordTaskId: null, messageId, prompt: null, skill,
      ...(burst.length > 1 ? { folded: burst } : {}),
    };
    const payload = { phrase: { key: INTERRUPTED_PHRASE }, modelId: null, modelLabel: null, runId: run.id, retry: true, state: "open", retryOf };
    payloadSchemaFor("model_error").parse(payload);
    const row = await db.message.create({ data: {
      userId: run.userId, channelId: run.channelId!, taskId: null, role: "system", kind: "model_error", text: "", payload: JSON.stringify(payload), status: "sent",
    } });
    await this.emitMessage(run.userId, row.id);
  }

  /** Old usage-limit lines collapse to "Usage limit lifted" once usage is available again (L166). */
  async liftIfAvailable(userId: string): Promise<void> {
    if ((await this.deps.usage.state(userId)).limited) return;
    const { db } = this.deps;
    const rows = await db.message.findMany({ where: { userId, kind: "usage_limit" }, select: { id: true } });
    for (const row of rows) {
      await db.message.update({ where: { id: row.id }, data: { role: "system", kind: "system", payload: JSON.stringify({ phrase: { key: "system.usage_limit_lifted" } }) } });
      await this.emitMessage(userId, row.id);
    }
  }

  private async pendingFiles(input: SendInput): Promise<FileRow[]> {
    const ids = [...new Set(input.fileIds)];
    if (ids.length === 0) return [];
    const rows = await this.deps.db.channelFile.findMany({ where: { id: { in: ids }, userId: input.userId, channelId: input.channelId, messageId: null, deletedAt: null }, orderBy: { createdAt: "asc" } });
    if (rows.length !== ids.length) throw invalid("fileIds", "unknown or already sent file");
    return rows;
  }

  /** A run record's title; a lookup that fails leaves it unset (the list derives one) instead of failing the send. */
  private async titleFor(run: { userId: string; kind: RunKind; channelId: string | null; taskId: string | null }): Promise<Phrase | null> {
    try {
      return await runTitle(this.deps.db, run);
    } catch (error) {
      log.warn("run title failed", { error: { name: (error as Error).name } });
      return null;
    }
  }

  /** Quote reply: only one of the assistant's messages in the same thread (the channel's timeline or this task's session). */
  private async quoted(userId: string, channelId: string, taskId: string | null, messageId: string) {
    const row = await this.deps.db.message.findFirst({ where: { id: messageId, userId, channelId, taskId }, select: { id: true, role: true, kind: true, text: true } });
    if (!row || row.role !== "assistant") throw invalid("replyTo", "not one of OpenDuet's messages in this thread");
    return { messageId: row.id, role: "assistant" as const, excerpt: quoteExcerpt(row.text, row.kind) };
  }

  /**
   * A quick reply names one of the user's own quick_replies cards in this channel and one of its
   * options (else 400 validation_failed). M21 server-side CAS: a card already chosen, or one the
   * user has written after in its thread (an older turn's options), is refused with 409 conflict
   * before anything is stored. Returns the card's payload as stored and as it becomes (`chosen`
   * set); accept() claims it inside the send's transaction only if it is still exactly as checked.
   */
  private async checkQuickReply(userId: string, channelId: string, reply: { messageId: string; option: string }): Promise<{ cardId: string; was: string; next: string }> {
    const { db } = this.deps;
    const row = await db.message.findFirst({ where: { id: reply.messageId, userId, channelId, kind: "quick_replies" } });
    let raw: unknown = null;
    try {
      raw = row ? JSON.parse(row.payload) : null;
    } catch {
      raw = null;
    }
    const parsed = raw === null ? null : payloadSchemaFor("quick_replies").safeParse(raw);
    const payload = parsed?.success ? (parsed.data as { options: string[]; chosen: string | null }) : null;
    if (!row || !payload || !payload.options.includes(reply.option)) throw invalid("quickReply", "unknown quick reply");
    if (payload.chosen !== null) throw staleQuickReply();
    const newer = await db.message.findFirst({
      where: { userId, channelId, taskId: row.taskId, role: "user", id: { not: row.id }, createdAt: { gt: row.createdAt } },
      select: { id: true },
    });
    if (newer) throw staleQuickReply();
    return { cardId: row.id, was: row.payload, next: JSON.stringify({ ...payload, chosen: reply.option }) };
  }

  /**
   * Checks the user's limits for a turn in this thread (a channel's timeline, or a task's own
   * session when taskId is set). Over a limit: one usage_limit line per thread (updated, never
   * duplicated) and the ISO time usage resumes. Otherwise old lines are lifted and null returned.
   */
  async usageLimit(userId: string, channelId: string, taskId: string | null = null): Promise<string | null> {
    const state = await this.deps.usage.state(userId);
    if (!state.limited || !state.resumesAt) {
      await this.liftIfAvailable(userId);
      return null;
    }
    const { db } = this.deps;
    const payload = JSON.stringify({ resumesAt: state.resumesAt });
    const active = await db.message.findFirst({ where: { userId, channelId, taskId, kind: "usage_limit" }, orderBy: { createdAt: "desc" } });
    if (!active) {
      const row = await db.message.create({ data: { userId, channelId, taskId, role: "system", kind: "usage_limit", text: "", payload } });
      await this.emitMessage(userId, row.id);
    } else if (active.payload !== payload) {
      await db.message.update({ where: { id: active.id }, data: { payload } });
      await this.emitMessage(userId, active.id);
    }
    return state.resumesAt;
  }

  /** Over a limit: the thread's usage_limit line (see usageLimit), then 429. */
  private async ensureUsage(userId: string, channelId: string, taskId: string | null): Promise<void> {
    if (await this.usageLimit(userId, channelId, taskId)) throw new HttpError(429, "usage_limited", "Usage limit reached.");
  }

  private enqueue(key: string, job: () => Promise<void>, of?: Job): void {
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    // M14 (A1): the jobs on this queue that haven't started yet, in order (what a chat turn may fold).
    if (of) {
      of.queue = key;
      this.pending.set(key, [...(this.pending.get(key) ?? []), of]);
    }
    const started = () => {
      const left = (this.waiting.get(key) ?? 1) - 1;
      if (left > 0) this.waiting.set(key, left);
      else this.waiting.delete(key);
      if (of) {
        const rest = (this.pending.get(key) ?? []).filter((j) => j !== of);
        if (rest.length) this.pending.set(key, rest);
        else this.pending.delete(key);
      }
    };
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => { started(); return job(); }).catch((error: unknown) => {
      log.error(key.startsWith("task:") ? "task run crashed" : "chat run crashed", { queue: key, error: { name: (error as Error).name } });
    });
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async execute(job: Job): Promise<void> {
    const { db, agent, files } = this.deps;
    job.started = true;
    // Shutdown, a delete of this turn's task / channel (cancel()), or Stop (stop()).
    const signal = AbortSignal.any([this.stopping.signal, job.controller.signal]);
    // M14 (F1): a graceful shutdown reached this queued chat turn: its Run stays queued (startedAt
    // null), with no done, for the next boot to answer (recoverStaleRuns). One folded into a turn
    // the shutdown also left stays too (that boot ends it skipped and answers the burst with that
    // turn's re-run or card: leftBurst); else it's absorbed.
    if (this.leavesAtShutdown(job) && (!job.foldedInto || this.leftRuns.has(job.foldedInto))) {
      this.leftRuns.add(job.runId);
      return;
    }
    // M14 (A1): a message an earlier turn already answered (folded into it) ends without a turn of its own.
    if (job.foldedInto) return this.absorbed(job);
    if (job.hooks.before && !signal.aborted && !(await this.allowed(job))) return this.skip(job);
    // M14 (A1): plain messages still waiting right behind this one are answered by this turn.
    if (!signal.aborted) this.fold(job);
    // A run that never reached the model keeps startedAt null, so the scheduler can tell an
    // interrupted-before-start slot (safe to run again) from one that already ran (never again).
    const start = signal.aborted ? { status: "running" } : { status: "running", startedAt: new Date() };
    if (job.claimed !== undefined) {
      // M14 (A2): a turn boot recovery queued starts only if its Run is still as that claim left it;
      // a second booting process that claimed it since runs it instead (never both).
      const mine = await db.run.updateMany({ where: { id: job.runId, status: job.claimed, startedAt: null }, data: start });
      if (mine.count !== 1) {
        log.info("recovered chat turn taken by another process", { runId: job.runId });
        return;
      }
    } else {
      await db.run.update({ where: { id: job.runId }, data: start });
    }
    let userMessage: Message;
    if (job.messageId) {
      // Still "Delivered": it turns "Seen" only when the model starts answering (onFirstEvent, M9).
      const stored = await loadMessage(db, job.messageId);
      if (!stored) throw new Error("stored message does not match the contract");
      userMessage = stored;
    } else {
      userMessage = turnMessage(job);
    }
    const sink = this.sink(job);
    if ((job.kind === "chat" || job.kind === "task") && !job.callId) job.steering = new SteeringInbox();
    let result: TurnResult;
    let steps: StepRecorder | undefined;
    if (signal.aborted) {
      result = { status: "cancelled", error: null, usage: { ...NO_USAGE }, model: null };
    } else {
      steps = this.openSteps(job);
      try {
        const input: TurnInput = {
          userId: job.userId, channelId: job.channelId, taskId: job.taskId, kind: job.kind, runId: job.runId, userMessage,
          attachments: await resolveAttachments(files, job.files), skill: job.skill, sink, signal,
          ...(steps ? { steps } : {}),
          ...(job.messageId ? { onFirstEvent: this.seenOnce(job.userId, job.folded ?? [job.messageId]) } : {}),
          ...(job.pinModelId ? { pinModelId: job.pinModelId } : {}),
          ...(job.takeover ? { takeover: job.takeover } : {}),
          ...(job.steering ? { steering: {
            open: () => job.steering!.open(),
            take: async (closeIfEmpty = false): Promise<SteeringItem[]> => {
              const batch = await job.steering!.take(closeIfEmpty);
              const items: SteeringItem[] = [];
              let joined = false;
              for (const item of batch) {
                if ("note" in item) { items.push(item); continue; }
                const message = await loadMessage(db, item.messageId);
                if (!message) throw new Error("Accepted steering message is missing");
                items.push({ userMessage: message, attachments: await resolveAttachments(files, item.files), onFirstEvent: this.seenOnce(job.userId, [message.id]) });
                joined = true;
              }
              if (joined) job.hooks.steered?.(job.runId);
              return items;
            },
            close: () => job.steering!.close(),
          } } : {}),
        };
        result = job.hooks.around ? await job.hooks.around(input, (next) => agent.runTurn(next)) : await agent.runTurn(input);
      } catch (error) {
        log.error("agent turn threw", { runId: job.runId, error: { name: (error as Error).name } });
        result = { status: "failed", error: internalFailure(), usage: { ...NO_USAGE }, model: null };
      }
    }
    await job.steering?.close();
    // Before `done`, so a correction's own POST stream follows it to its new turn (runOf).
    if (result.status === "cancelled") await this.rerunUnseen(job);
    await this.finish(job, sink, result, steps);
  }

  /**
   * Stop ends the turn the model was working on, not the user's corrections it never read: each
   * accepted steering message still unseen (the model hadn't started on it) runs as its own turn
   * after this one, as if it had been queued behind it (M10). One the model started answering is
   * part of the stopped turn and stays answered by it. A delete (cancel) or a shutdown runs none:
   * the thread is going away, or boot recovery answers them with the interrupted turn.
   */
  private async rerunUnseen(job: Job): Promise<void> {
    if (!job.stopped || this.stopping.signal.aborted || !job.steeringIds?.length) return;
    const { db } = this.deps;
    try {
      const unseen = await db.message.findMany({
        where: { id: { in: job.steeringIds }, userId: job.userId, status: { not: "seen" } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, text: true },
      });
      for (const message of unseen) {
        const turn = job.steeringTurns?.get(message.id);
        if (!turn) continue;
        const files = await db.channelFile.findMany({ where: { messageId: message.id, userId: job.userId, deletedAt: null }, orderBy: { createdAt: "asc" } });
        const run = await db.$transaction(async (tx) => {
          const created = await tx.run.create({ data: { userId: job.userId, kind: job.kind, status: "queued", channelId: job.channelId, taskId: job.taskId, title: turn.title ? JSON.stringify(turn.title) : null } });
          // Recovery after a restart finds this message as the one its turn answers.
          await bindAnsweredMessages(tx, job.userId, created.id, [message.id]);
          return created;
        });
        const next: Job = {
          userId: job.userId, channelId: job.channelId, taskId: job.taskId, recordTaskId: job.taskId, kind: job.kind, runId: run.id, messageId: message.id,
          prompt: message.text, skill: null, files, hooks: turn.hooks, controller: new AbortController(),
          started: false, stopped: false, lastTextId: null, pinModelId: null, callId: null, foldable: turn.foldable,
        };
        // The stopped turn's cleanup no longer owns it; its own turn does.
        job.steeringIds = job.steeringIds.filter((id) => id !== message.id);
        this.activeRuns.set(message.id, run.id);
        this.enqueue(queueKey(next), this.track(next, () => this.activeRuns.delete(message.id)), next);
      }
    } catch (error) {
      log.error("steering rerun after Stop failed", { runId: job.runId, error: { name: (error as Error).name } });
    }
  }

  /** The run answering a stored user message right now (a POST stream follows it), if any. */
  runOf(messageId: string): string | null {
    return this.activeRuns.get(messageId) ?? null;
  }

  /**
   * The seen receipt (M9, contract §1): the user's message turns "seen" (with a `message` update)
   * the first time the model starts answering its turn. Once per turn; a turn whose model call
   * fails before any event leaves it "sent" (Delivered).
   */
  private seenOnce(userId: string, messageIds: string[]): () => Promise<void> {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      // A1: a folded turn answers every message of the burst; each turns seen, oldest first.
      for (const messageId of messageIds) {
        const marked = await this.deps.db.message.updateMany({ where: { id: messageId, status: { not: "seen" } }, data: { status: "seen" } });
        if (marked.count === 1) await this.emitMessage(userId, messageId);
      }
    };
  }

  /**
   * M14 (A1): when a plain chat message's turn starts, the plain messages queued right behind it
   * on the same queue (none started yet) join it: the turn answers the newest (its history holds
   * the earlier ones), each turns seen with the turn's first event, and their own jobs end without
   * a turn (absorbed()). The first job that can't fold (files, a form, a quick reply, a /skill, a
   * call, a retry, a brief / routine / build...) ends the burst, so the queue's order is kept.
   */
  private fold(job: Job): void {
    if (!isFoldable(job) || !job.queue) return;
    const taken: Job[] = [];
    for (const next of this.pending.get(job.queue) ?? []) {
      if (!isFoldable(next) || next.userId !== job.userId || next.channelId !== job.channelId) break;
      taken.push(next);
    }
    if (!taken.length) return;
    for (const next of taken) next.foldedInto = job.runId;
    job.folded = [job.messageId!, ...taken.map((next) => next.messageId!)];
    job.messageId = job.folded.at(-1)!;
    log.info("chat burst folded", { runId: job.runId, messages: job.folded.length });
  }

  /**
   * M14 (A1): a message folded into an earlier turn: that turn answered it, so its own Run ends
   * "skipped" (never shows a card; no reply, no usage) with the usual done, right after that turn.
   */
  private async absorbed(job: Job): Promise<void> {
    await this.deps.db.run.update({ where: { id: job.runId }, data: { status: "skipped", finishedAt: new Date() } });
    await this.deps.events.emit(job.userId, job.channelId, "done", { runId: job.runId, taskId: job.taskId, kind: job.kind, status: "cancelled", error: null });
  }

  /** M14: the takeover note of an earlier attempt; reading its record never fails the retry. */
  private async takeoverFor(runId: string, reason: TakeoverReason): Promise<string | null> {
    try {
      return await takeoverNote(this.deps.db, runId, reason);
    } catch (error) {
      log.warn("takeover note unavailable", { runId, error: { name: (error as Error).name } });
      return reason === "restart" ? RESTART_NOTE : null;
    }
  }

  /** The run's record; a recorder that can't open just leaves this run without steps. */
  private openSteps(job: Job): StepRecorder | undefined {
    try {
      return this.recorder.open(job.runId, job.userId);
    } catch (error) {
      log.warn("run steps unavailable", { runId: job.runId, error: { name: (error as Error).name } });
      return undefined;
    }
  }

  /** A before hook that throws declines the turn rather than running it unchecked. */
  private async allowed(job: Job): Promise<boolean> {
    try {
      return await job.hooks.before!(job.runId);
    } catch (error) {
      log.error("turn hook failed", { runId: job.runId, hook: "before", error: { name: (error as Error).name } });
      return false;
    }
  }

  /** A hook declined the turn (e.g. over the usage limit): nothing ran, the Run is "skipped". */
  private async skip(job: Job): Promise<void> {
    await this.deps.db.run.update({ where: { id: job.runId }, data: { status: "skipped", finishedAt: new Date() } });
    await this.runAfter(job, { runId: job.runId, skipped: true });
    await this.deps.events.emit(job.userId, job.channelId, "done", { runId: job.runId, taskId: job.taskId, kind: job.kind, status: "cancelled", error: null });
  }

  private async runAfter(job: Job, outcome: TurnOutcome): Promise<void> {
    if (!job.hooks.after) return;
    try {
      await job.hooks.after(outcome);
    } catch (error) {
      log.error("turn hook failed", { runId: job.runId, hook: "after", error: { name: (error as Error).name } });
    }
  }

  /**
   * M14 (F1): a graceful shutdown (a deploy), not Stop or a delete, aborted this channel chat turn
   * that answers a stored message: it isn't finished here; boot's recoverStaleRuns re-queues /
   * re-runs it or gives it the retry card. Other kinds and submitted turns end cancelled as before
   * (their own boot recovery reads that).
   */
  private leavesAtShutdown(job: Job): boolean {
    return this.stopping.signal.aborted && !job.controller.signal.aborted && !job.stopped
      && job.kind === "chat" && job.taskId === null && job.messageId !== null && Object.keys(job.hooks).length === 0;
  }

  /**
   * F1: the shutdown cut this chat turn off: its record and usage are written, the Run row stays
   * as it is (running, or queued if it never reached the model), no card, no done; the text it
   * posted stays. The next boot decides (A2).
   */
  private async leave(job: Job, result: TurnResult, steps?: StepRecorder): Promise<void> {
    const { events, usage } = this.deps;
    this.leftRuns.add(job.runId);
    if (steps) await steps.finish();
    const { inputTokens, outputTokens } = result.usage;
    if (inputTokens + outputTokens > 0) {
      await usage.record(job.userId, inputTokens + outputTokens);
      await events.emit(job.userId, null, "usage", { usage: await usage.state(job.userId) });
    }
    log.info("chat turn left for the next boot", { runId: job.runId });
  }

  private async finish(job: Job, sink: TurnSink, result: TurnResult, steps?: StepRecorder): Promise<void> {
    const { db, events, usage } = this.deps;
    if (result.status === "cancelled" && this.leavesAtShutdown(job)) return this.leave(job, result, steps);
    const error = result.status === "failed" ? (result.error ?? internalFailure()) : null;
    // The record is complete before the run reads as finished (the app stops polling then).
    if (steps) {
      if (error) steps.error(error);
      await steps.finish();
    }
    const { inputTokens, outputTokens, estimated } = result.usage;
    await db.run.update({ where: { id: job.runId }, data: {
      status: result.status, finishedAt: new Date(), providerId: result.model?.providerId ?? null, model: result.model?.modelId ?? null,
      inputTokens, outputTokens, tokensEstimated: estimated, error: error ? JSON.stringify(error) : null,
    } });
    await sink.status(null);
    await sink.typing(false);
    // M14 (A5): a background run that failed on an error a later try can fix, and posted and did
    // nothing, is tried again in 1 / 5 / 15 min; only its last failure shows the card.
    const retryInMs = error ? await this.backgroundRetry(job, error) : null;
    // M12: a failed turn shows a model_error card (instead of the grey line) with Retry / Switch
    // model; the model's reply is never invented. No model set up: no retry (the app offers setup).
    if (error && retryInMs === null) await sink.upsertMessage({ role: "system", kind: "model_error", payload: this.errorCard(job, result, error) });
    // M10 Stop: the reply streamed so far (the agent flushed it on abort) stays, marked stopped.
    const stopped = job.stopped && result.status === "cancelled";
    if (stopped) await this.markStopped(job);
    await usage.record(job.userId, inputTokens + outputTokens);
    await events.emit(job.userId, null, "usage", { usage: await usage.state(job.userId) });
    // Hooks (e.g. the task's new status) land before `done`, so a stream that ends on done has them.
    await this.runAfter(job, { runId: job.runId, skipped: false, result, ...(stopped ? { stopped } : {}) });
    await events.emit(job.userId, job.channelId, "done", { runId: job.runId, taskId: job.taskId, kind: job.kind, status: result.status, error });
    // M29: the push for how it ended (or none), decided by the Notifier.
    this.deps.notices?.ended(runRef(job), result.status);
    if (retryInMs !== null) this.scheduleRetry(job, retryInMs);
  }

  /** A5: the delay before this failed run's automatic retry, or null (no retry: the card shows). */
  private async backgroundRetry(job: Job, error: Phrase): Promise<number | null> {
    const delays = this.deps.backgroundRetryMs ?? BACKGROUND_RETRY_MS;
    const attempt = job.autoRetry ?? 0;
    if (!BACKGROUND_KINDS.has(job.kind) || attempt >= delays.length || job.posted || job.stopped || job.noRetry) return null;
    if (this.stopping.signal.aborted || !this.retryHooks.has(job.kind) || !retryableFailure(error)) return null;
    try {
      if (await actedInRun(this.deps.db, job.runId)) return null;
    } catch (failure) {
      log.warn("background retry check failed", { runId: job.runId, error: { name: (failure as Error).name } });
      return null;
    }
    return delays[attempt] ?? null;
  }

  /** A5: an in-memory timer (a restart drops it); idle() waits for it, shutdown() clears it. */
  private scheduleRetry(job: Job, delayMs: number): void {
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const entry: PendingRetry = { timer: undefined, settle, done, fired: false };
    entry.timer = setTimeout(() => {
      // From here shutdown() waits for the resubmit instead of dropping it.
      entry.fired = true;
      void this.resubmitBackground(job)
        .catch((error: unknown) => log.error("background retry failed", { runId: job.runId, error: { name: (error as Error).name } }))
        .finally(() => { this.retries.delete(entry); settle(); });
    }, delayMs);
    entry.timer.unref?.();
    this.retries.add(entry);
    log.info("background run retry scheduled", { runId: job.runId, kind: job.kind, attempt: (job.autoRetry ?? 0) + 1, inMs: delayMs });
  }

  /**
   * A5: the failed background run's turn again (same kind, channel, record task and prompt, the
   * failed run's title), unless its channel is gone or the same routine / kind is queued or running
   * again already (a Run now meanwhile). It keeps the failed job's own hooks, so it's gated like
   * the original: a scheduled brief / check-in passes the gate again (quiet hours, daily cap, don't
   * interrupt) and a scheduled routine paused since doesn't run. The hooks keep no per-run state
   * outside their runId-keyed maps, so they can run a second turn. (A Retry the user tapped is
   * never retried automatically: retry() sets autoRetry to the limit.)
   */
  private async resubmitBackground(failed: Job): Promise<void> {
    if (this.stopping.signal.aborted || !this.retryHooks.has(failed.kind)) return;
    const { db } = this.deps;
    if (!(await db.channel.findFirst({ where: { id: failed.channelId, userId: failed.userId }, select: { id: true } }))) return;
    const busy = await db.run.count({ where: {
      userId: failed.userId, kind: failed.kind, status: { in: ["queued", "running"] },
      ...(failed.recordTaskId ? { taskId: failed.recordTaskId } : { channelId: failed.channelId }),
    } });
    if (busy > 0) return;
    const row = await db.run.findUnique({ where: { id: failed.runId }, select: { title: true } });
    const takeover = await this.takeoverFor(failed.runId, "failed");
    // The lookups above awaited: a shutdown that began meanwhile gets no new Run (shutdown() waits for this).
    if (this.stopping.signal.aborted) return;
    const run = await db.run.create({ data: {
      userId: failed.userId, kind: failed.kind, status: "queued", channelId: failed.channelId, taskId: failed.recordTaskId, title: row?.title ?? null,
    } });
    const job: Job = {
      userId: failed.userId, channelId: failed.channelId, taskId: failed.taskId, recordTaskId: failed.recordTaskId, kind: failed.kind, runId: run.id,
      messageId: null, prompt: failed.prompt, skill: null, files: [], hooks: failed.hooks, controller: new AbortController(),
      started: false, stopped: false, lastTextId: null, pinModelId: null, autoRetry: (failed.autoRetry ?? 0) + 1,
      ...(takeover ? { takeover } : {}),
    };
    this.enqueue(queueKey(job), this.track(job), job);
  }

  /**
   * M12: the model_error card of a failed turn: the phrase, the ModelEntry the turn ran on (null
   * when none was usable), the run, whether it can be retried and its state. The stored payload
   * also keeps `retryOf` (what retry() resubmits); the contract's schema strips it from every
   * message the app or the event log sees, and system rows never reach the model's context.
   */
  private errorCard(job: Job, result: TurnResult, error: Phrase): Record<string, unknown> {
    const retry = error.key !== NO_MODEL_PHRASE && !SETUP_PHRASES.has(error.key ?? "") && !job.noRetry && this.retryHooks.has(job.kind);
    const retryOf: RetryOf = {
      kind: job.kind, channelId: job.channelId, taskId: job.taskId, recordTaskId: job.recordTaskId, messageId: job.messageId,
      prompt: job.messageId ? null : job.prompt, skill: job.skill,
      // A1: a folded turn's card keeps the whole burst, so its Retry marks every message seen.
      ...(job.messageId && job.folded && job.folded.length > 1 ? { folded: job.folded } : {}),
    };
    return {
      phrase: error, modelId: result.modelEntry?.id ?? null, modelLabel: result.modelEntry?.label ?? null, runId: job.runId,
      retry, state: "open", ...(retry ? { retryOf } : {}),
    };
  }

  private sink(job: Job): TurnSink {
    const { events } = this.deps;
    let status: StatusKey | null = null;
    let typing = false;
    const ref = { runId: job.runId, taskId: job.taskId, kind: job.kind };
    return {
      status: async (next) => {
        if (next === status) return;
        status = next;
        await events.emit(job.userId, job.channelId, "status", { ...ref, status: next });
      },
      typing: async (on) => {
        if (on === typing) return;
        typing = on;
        await events.emit(job.userId, job.channelId, "typing", { ...ref, typing: on });
      },
      upsertMessage: (draft) => this.upsert(job, draft),
    };
  }

  private async upsert(job: Job, draft: MessageDraft): Promise<Message> {
    const { db } = this.deps;
    const shaped = draftPayload(draft);
    // Validate before writing: a malformed card must never reach the thread.
    payloadSchemaFor(draft.kind).parse(shaped);
    const stored = JSON.stringify(draft.kind === "text" ? { skill: null } : shaped);
    const data = { role: draft.role, kind: draft.kind, text: "text" in draft && draft.text !== undefined ? draft.text : "", payload: stored };
    // M13: the assistant's text bubbles of a turn a voice call handed over carry the call's id. Updates
    // write it too: a bubble still streaming when the call hangs up (releaseCall) turns visible.
    const text = draft.role === "assistant" && draft.kind === "text";
    const callId = text && job.callId ? job.callId : null;
    let id = draft.id;
    const created = !id;
    if (id) {
      const updated = await db.message.updateMany({ where: { id, userId: job.userId, channelId: job.channelId, role: { not: "user" } }, data: text ? { ...data, callId } : data });
      if (updated.count === 0) throw new Error("upsertMessage: unknown message id");
    } else {
      // A task turn writes into the task's own session (task detail), never the channel timeline.
      id = (await db.message.create({ data: { ...data, userId: job.userId, channelId: job.channelId, taskId: job.taskId, status: "sent", callId } })).id;
    }
    if (text) job.lastTextId = id;
    if (draft.role === "assistant") job.posted = true;
    const message = await this.emitMessage(job.userId, id);
    // M29: what the run left in its thread (a new message, not a streaming update), for its push.
    if (created) this.deps.notices?.posted(runRef(job), message);
    return message;
  }

  /**
   * M10 Stop: the turn's newest assistant text bubble (the reply it was streaming) keeps its text and
   * gets `stopped: true` (a `message` update with the same id). No bubble, nothing to mark; a bubble
   * deleted meanwhile (a channel delete racing the stop) is skipped.
   */
  private async markStopped(job: Job): Promise<void> {
    if (!job.lastTextId) return;
    const { db } = this.deps;
    try {
      const row = await db.message.findFirst({ where: { id: job.lastTextId, userId: job.userId, role: "assistant", kind: "text" } });
      if (!row) return;
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        // an unreadable payload is replaced by a fresh text payload
      }
      await db.message.update({ where: { id: row.id }, data: { payload: JSON.stringify({ skill: null, ...payload, stopped: true }) } });
      await this.emitMessage(job.userId, row.id);
    } catch (error) {
      log.warn("stopped reply could not be marked", { runId: job.runId, error: { name: (error as Error).name } });
    }
  }

  private async emitMessage(userId: string, id: string): Promise<Message> {
    const message = await loadMessage(this.deps.db, id);
    if (!message) throw new Error("stored message does not match the contract");
    await this.deps.events.emit(userId, message.channelId, "message", { message });
    return message;
  }
}

/** The model-facing user message of a submitted turn; never stored or sent to the app. */
function turnMessage(job: Job): Message {
  const at = new Date().toISOString();
  return {
    id: `turn_${job.runId}`, channelId: job.channelId, taskId: job.taskId, role: "user", kind: "text", text: job.prompt,
    status: "seen", clientId: null, reactions: [], stopped: false, callId: null, createdAt: at, updatedAt: at, payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null },
  };
}

function draftPayload(draft: MessageDraft): Record<string, unknown> {
  switch (draft.kind) {
    case "text": return { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null };
    case "quick_replies": return { options: draft.payload.options, chosen: null };
    default: return draft.payload;
  }
}
