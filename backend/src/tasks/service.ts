// The task runner (L70): a Task runs as its own agent session on its own queue in the run host
// (the chat stays free), with kind "task" and TurnInput.taskId set. After every turn the task's
// status is decided here; every change emits a `task` event and refreshes the channel's
// task_spawn chip so a reload shows the same thing. Implements TaskResumer for the approval
// service, and pauses tasks interrupted by a restart.
import type { Task as TaskRow } from "@prisma/client";
import { z } from "zod";
import { phrase } from "../agent/phrase.ts";
import type { TaskResumer } from "../agent/types.ts";
import { chatResumeNote, type ChatResumer } from "../approvals/service.ts";
import { Schedule, type Phrase } from "../contract/common.ts";
import type { TaskStatus } from "../contract/tasks.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { HttpError } from "../http.ts";
import { nextRoutineSlot, normalizeSchedule, type RoutineSchedule, type ScheduleInput } from "../routines/schedule.ts";
import type { RunHost, SendInput, TurnOutcome } from "../runs/host.ts";
import { renderPhrase as renderForUser } from "../notify/phrases.ts";
import { buildsNote, onBuildSettled, taskBuilds, taskChanged, type SettledBuild } from "./builds.ts";
import { derivedResources } from "./derived.ts";
import { KeyedLock } from "./lock.ts";
import { deriveNextStep, failureFor, failureOf, nextStepOf, REOPENED_KEY, type NextHint } from "./next-step.ts";
import { clipResult, endsWithQuestion, fillTemplate, lastSentence, noticeExcerpt, QUESTION_MAX, REASON_MAX } from "./notices.ts";
import { finishTextAfter } from "./result-text.ts";
import { TASK_PHRASE } from "./phrases.ts";
import { mergeUpdate, resourcesOf, stepsOf, toTaskSummary, updatesOf, type Update } from "./serialize.ts";
import { emitStored, postMessage, storedPayload } from "./thread.ts";
import { touchedUserThings } from "./touched.ts";

/** A connected app or a toolkit the catalog knows, by display name or slug: its display name, else null. */
export type KnownApp = (userId: string, name: string) => Promise<string | null>;

export interface TaskServiceDeps { db: Db; events: EventBus; runs: RunHost; now?: () => Date; apps?: KnownApp }

export type ApprovalOutcome = Parameters<TaskResumer["resumeAfterApproval"]>[1];

export interface NewTask {
  userId: string;
  channelId: string;
  title: string;
  prompt: string;
  description?: string;
  source?: "user" | "proactive";
  noticedAt?: Date | null;
  /** M22: the app of the suggestion it was started from ("From Gmail" on the row) */
  sourceApp?: string | null;
  /** post the "On it" line and a task_spawn chip under this user message, in this channel */
  spawn?: { channelId: string; anchorMessageId: string | null };
}

/** What the model asked for in this turn (finish_task / ask_user), read when the turn ends. */
type Signal = "finish" | "ask";
/** note: finish_task's summary, or ask_user's question; messageId (M22): the question's bubble */
interface Signalled { value: Signal; at: Date; note?: string; messageId?: string; afterText?: string }
/**
 * submitted: a server-queued turn (first turn, carry-on, resume); reply: the user wrote in the task;
 * forwarded (M18): tell_task passed the user's words on from the chat (reopens like a reply, but
 * the user isn't in the task, so its notices still go to the chat).
 */
type Origin = "submitted" | "reply" | "forwarded";
/** M18: a task turn as its before hook saw it (read when it ends). */
interface TurnStart { startedAt: Date; before: TaskStatus | null; origin: Origin }
export type TaskPatch = Patch;
type Patch = Partial<Pick<TaskRow,
  "title" | "description" | "status" | "steps" | "updates" | "resources" | "archivedAt" | "prompt"
  | "pinnedAt" | "schedule" | "routinePaused" | "routineQuiet" | "nextRunAt" | "lastRunAt" | "lastRunStatus"
  // M22: nextStep and resolvedAt are kept by apply(); failure by the turn hooks and retry
  | "failure" | "routineFailStreak" | "routinePausedBy" | "routineState" | "nextStep" | "resolvedAt">>;

/** M22: what a model_error card keeps to resubmit its turn (models/cards.ts reads it the same way). */
const RetryOfSchema = z.object({
  kind: z.enum(["chat", "task", "brief", "checkin", "scan", "build", "routine"]),
  channelId: z.string(), taskId: z.string().nullable(), recordTaskId: z.string().nullable(),
  messageId: z.string().nullable(), prompt: z.string().nullable(), skill: z.string().nullable(),
});
/** M22: cards whose change can end the task's nextStep without a turn (dismissed, expired, connected). */
const STEP_CARDS: ReadonlySet<string> = new Set(["form", "sign_in", "connection_request", "approval", "quick_replies"]);

/** PATCH /api/tasks/:id (M9: pinned for any task; paused, schedule and title only on routines). */
export interface TaskChange {
  status?: "resolved";
  archived?: boolean;
  pinned?: boolean;
  paused?: boolean;
  schedule?: ScheduleInput;
  title?: string;
  /** manage_scheduled_task only (not in the API) */
  prompt?: string;
  quiet?: boolean;
}

const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);

/** M18: cards that wait for the user's answer; a turn that posted one isn't done on its own. */
const WAITING_CARDS = ["form", "quick_replies", "connection_request", "sign_in"] as const;

/** M14a review #1: carry-on turns in a row for builds that only failed, at most. */
export const FAILED_CARRY_ONS = 2;

/** M29: labels meaning the assistant or its computer, under the new name and the old one. */
const ASSISTANT_NAME = /^(open\s*duet|claude)$/i;
const COMPUTER_NAME = /^(open\s*duet|claude)['’]?s computer$/i;

export class TaskService implements TaskResumer, ChatResumer {
  /** M14: shared with the build outcome hook (tasks/builds.ts), so their row updates never interleave. */
  private readonly lock = KeyedLock.tasks;
  private readonly signals = new Map<string, Signalled>();
  /** the task module's clock (M22: routes read it for resolvedAt windows) */
  readonly now: () => Date;
  /** M22: nextStep refreshes started by a card change outside a turn (idle() waits for them) */
  private readonly refreshing = new Set<Promise<void>>();
  /** M14a review #1: task id -> run id of its session's turn that is running now (from its before hook) */
  private readonly turns = new Map<string, string>();
  /** builds that settled while the task's turn was running: its carry-on waits for the turn to end */
  private readonly afterTurnBuilds = new Map<string, SettledBuild[]>();
  /** tasks whose carry-on turn is being queued right now */
  private readonly queuing = new Set<string>();
  /** carry-on turns in a row that answered only failed builds (a build that keeps failing stops at FAILED_CARRY_ONS) */
  private readonly failedCarryOns = new Map<string, number>();
  /** M18: run id -> when its turn started and the task's status before it (the notices compare against it) */
  private readonly starts = new Map<string, TurnStart>();
  /** M18: tasks whose latest carry-on answered only failed builds: not done on their own until a turn of theirs ends well */
  private readonly failedBuildTasks = new Set<string>();
  /**
   * M18 review: tasks the user is replying to after they were done ("thanks", a follow-up). Set when
   * such a reply turn starts and kept across replies queued behind it, so the turn that settles the
   * task back to done posts no second result in the chat; cleared once the task settles.
   */
  private readonly quietReplies = new Set<string>();

  constructor(private readonly deps: TaskServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    // M12: a model_error card's retry of a task turn runs with the task's hooks (a reply or a submitted turn).
    // M18 review: a retried tell_task turn keeps its "forwarded" origin (read from its stored message).
    deps.runs.retryable?.("task", (turn) => this.hooks(turn.taskId ?? "", turn.messageId ? () => this.originOf(turn.messageId!) : "submitted"));
    // M14a review #1: a Make build this task started settled -> the session carries on (tasks/builds.ts).
    if (deps.runs) onBuildSettled(deps.runs, (taskId, builds) => this.carryOnAfterBuild(taskId, builds), this.mutate.bind(this));
    // M22: a card the task's nextStep points at changed outside a turn (a sign-in that expired, a
    // connection request connected or dismissed): its nextStep is derived again.
    deps.events.onPublish?.(({ event }) => {
      if (event.type !== "message") return;
      const message = event.payload.message;
      if (message.taskId && STEP_CARDS.has(message.kind)) this.track(this.refreshIfPointed(message.taskId, message.id));
    });
  }

  private track(work: Promise<void>): void {
    const done = work.catch((error: unknown) => log.warn("task next step refresh failed", { error: { name: (error as Error).name } }))
      .finally(() => this.refreshing.delete(done));
    this.refreshing.add(done);
  }

  /** M22: the nextStep refreshes still running (tests wait for them). */
  async idle(): Promise<void> {
    while (this.refreshing.size) await Promise.all([...this.refreshing]);
  }

  private async refreshIfPointed(taskId: string, messageId: string): Promise<void> {
    const row = await this.deps.db.task.findUnique({ where: { id: taskId } });
    if (row && nextStepOf(row)?.messageId === messageId) await this.refresh(taskId);
  }

  /** M22: derives the task's nextStep again (a card of its thread changed); emits only when it changed. */
  async refresh(taskId: string): Promise<void> {
    if (!(await this.deps.db.task.findUnique({ where: { id: taskId }, select: { id: true } }))) return;
    await this.mutate(taskId, () => null);
  }

  /** The user's own task, or null (someone else's is the same as missing). */
  own(userId: string, taskId: string): Promise<TaskRow | null> {
    return this.deps.db.task.findFirst({ where: { id: taskId, userId } });
  }

  /** The user's main thread (where tasks without a channel of their own live). */
  async mainChannelId(userId: string): Promise<string> {
    return (await this.deps.db.channel.findFirstOrThrow({ where: { userId, isMain: true }, select: { id: true } })).id;
  }

  /**
   * Creates a working task, optionally posts the spawn chip and "On it" in the channel the
   * request came from, and queues the task's first turn (the prompt is that turn's request).
   */
  async create(input: NewTask): Promise<TaskRow> {
    const { db, events } = this.deps;
    let row = await db.task.create({ data: {
      userId: input.userId, channelId: input.channelId, title: input.title, prompt: input.prompt,
      description: input.description ?? "", source: input.source ?? "user", noticedAt: input.noticedAt ?? null, status: "working",
      sourceApp: input.sourceApp?.trim() || null,
    } });
    const summary = toTaskSummary(row);
    if (!summary) throw new Error("new task does not match the contract");
    if (input.spawn) {
      const user = await db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { language: true } });
      const chip = await postMessage(db, events, {
        userId: input.userId, channelId: input.spawn.channelId, taskId: null, role: "assistant", kind: "task_spawn", text: "",
        payload: { task: summary, anchorMessageId: input.spawn.anchorMessageId },
      });
      await postMessage(db, events, {
        userId: input.userId, channelId: input.spawn.channelId, taskId: null, role: "assistant", kind: "text",
        text: phrase("agent.on_it", user.language), payload: { skill: null, attachments: [] },
      });
      row = await db.task.update({ where: { id: row.id }, data: { spawnMessageId: chip.id } });
    }
    await events.emit(row.userId, row.channelId, "task", { task: toTaskSummary(row) ?? summary });
    await this.queueTurn(row, row.prompt);
    return row;
  }

  /** A reply in the task's own session (POST /api/tasks/:id/messages): resumes its session. */
  reply(task: TaskRow, body: Pick<SendInput, "text" | "clientId" | "fileIds" | "skill" | "quickReply" | "replyTo" | "form">) {
    return this.deps.runs.send({ userId: task.userId, channelId: task.channelId, taskId: task.id, kind: "task", hooks: this.hooks(task.id, "reply"), ...body });
  }

  /**
   * M18 tell_task: the user's words from the chat go into the task's session as a user message
   * marked forwarded "chat", on the task's own queue like a reply (a waiting or done task wakes up,
   * a running one gets it as its next turn).
   */
  tell(task: TaskRow, text: string) {
    return this.deps.runs.send({
      userId: task.userId, channelId: task.channelId, taskId: task.id, kind: "task", hooks: this.hooks(task.id, "forwarded"),
      text, clientId: `tell-${crypto.randomUUID()}`, fileIds: [], skill: null, quickReply: null, forwarded: "chat",
    });
  }

  /**
   * Only the user resolves; archiving hides the task from the lists. M9: pinned works on any task
   * (newest pin first); paused and schedule only on a routine (else 400 validation_failed), and a
   * routine is never "resolved" (pause or delete it instead). M10: title on any task. A new
   * schedule or a resume moves nextRunAt to the next slot from now; a pause clears it.
   */
  async update(task: TaskRow, change: TaskChange): Promise<TaskRow> {
    // M10: title (Rename) works on any task; the chip follows through changed().
    const routineOnly = (["paused", "schedule", "prompt", "quiet"] as const).find((key) => change[key] !== undefined);
    if (!task.routine && routineOnly) throw invalid(routineOnly, "only a scheduled task can change this");
    if (task.routine && change.status === "resolved") throw invalid("status", "a scheduled task can't be completed; pause or delete it");
    let schedule: RoutineSchedule | undefined;
    const zone = task.routine ? await this.zoneOf(task.userId) : "UTC";
    if (change.schedule) {
      const normalized = normalizeSchedule(change.schedule, zone, this.now());
      if (!normalized.ok) throw invalid("schedule", normalized.message);
      schedule = normalized.schedule;
    }
    const row = await this.mutate(task.id, (current) => {
      const patch: Patch = {};
      if (change.status === "resolved") patch.status = "resolved";
      if (change.archived !== undefined) patch.archivedAt = change.archived ? (current.archivedAt ?? this.now()) : null;
      if (change.pinned !== undefined) patch.pinnedAt = change.pinned ? (current.pinnedAt ?? this.now()) : null;
      if (change.title !== undefined && change.title !== current.title) patch.title = change.title;
      if (change.prompt !== undefined && change.prompt !== current.prompt) patch.prompt = change.prompt;
      if (change.quiet !== undefined && change.quiet !== current.routineQuiet) patch.routineQuiet = change.quiet;
      if (schedule) patch.schedule = JSON.stringify(schedule);
      const paused = change.paused ?? current.routinePaused;
      if (change.paused !== undefined && change.paused !== current.routinePaused) patch.routinePaused = change.paused;
      // M22 fatigue rule: a pause from the user (app or chat) says so; a resume starts the count again.
      if (change.paused === true && current.routinePausedBy !== "user") patch.routinePausedBy = "user";
      if (change.paused === false && (current.routinePausedBy !== null || current.routineFailStreak !== 0)) {
        patch.routinePausedBy = null;
        patch.routineFailStreak = 0;
      }
      if (current.routine && (schedule || patch.routinePaused !== undefined)) {
        const next = schedule ?? scheduleFrom(current.schedule);
        patch.nextRunAt = paused || !next ? null : nextRoutineSlot(next, zone, this.now());
      }
      return patch;
    });
    // M21 (C14): marked done while its session still works: that turn (running, or queued) is
    // cancelled, so it spends nothing more and calls no more tools. After the row is resolved and
    // outside its lock (the turn's after hook takes the same lock; it skips a cancelled turn).
    if (change.status === "resolved") await this.deps.runs.cancel({ userId: row.userId, taskId: row.id, sessionOnly: true });
    return row;
  }

  /** The user's timezone (UTC when unknown). */
  async zoneOf(userId: string): Promise<string> {
    return (await this.deps.db.user.findUnique({ where: { id: userId }, select: { timezone: true } }))?.timezone ?? "UTC";
  }

  /**
   * M10 Stop (POST /api/tasks/:id/stop): the current turn of the task's own session (running, else
   * the first queued). Turns queued behind it still run. Returns how many were stopped (0 or 1).
   */
  stop(task: TaskRow): Promise<number> {
    return this.deps.runs.stop({ userId: task.userId, taskId: task.id });
  }

  /**
   * M22 POST /api/tasks/:id/retry: the failed turn runs again through the model_error card's own
   * resubmit (RunHost.retry: same turn, same user message or prompt; the card turns retrying), or,
   * without a usable card, as a carry-on turn. Failure cleared, status working. 409 task_running
   * while a turn of it runs or waits; 409 not_retryable without a failure or when it can't help.
   */
  async retry(task: TaskRow): Promise<TaskRow> {
    return this.lock.run(task.id, async () => {
      const current = await this.deps.db.task.findUniqueOrThrow({ where: { id: task.id } });
      if (this.turns.has(task.id) || this.deps.runs.waitingFor(task.id) > 0) throw new HttpError(409, "task_running", "This task is running.");
      const failure = failureOf(current);
      if (!failure?.retryable) throw new HttpError(409, "not_retryable", failure ? "Running it again the same way can't help." : "This task didn't fail.");
      await this.resubmitFailed(current);
      return this.apply(current, { status: "working", failure: null });
    });
  }

  /** The newest model_error card of the task's thread resubmits its turn; else a carry-on turn. */
  private async resubmitFailed(task: TaskRow): Promise<void> {
    const { db, events, runs } = this.deps;
    const card = await db.message.findFirst({ where: { taskId: task.id, userId: task.userId, kind: "model_error" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const stored = card ? storedPayload(card.payload) : {};
    const of = RetryOfSchema.safeParse(stored.retryOf);
    if (card && stored.retry === true && typeof stored.runId === "string" && of.success && of.data.taskId === task.id) {
      await runs.retry(task.userId, stored.runId, of.data, null);
      if (stored.state === "open") {
        await db.message.updateMany({ where: { id: card.id, payload: card.payload }, data: { payload: JSON.stringify({ ...stored, state: "retrying" }) } });
        await emitStoredSafe(db, events, task.userId, card.id);
      }
      return;
    }
    if (!(await this.queueTurn(task, RETRY_NOTE))) throw new HttpError(503, "internal", "The server is restarting.");
  }

  /**
   * M22 POST /api/tasks/:id/reopen: a resolved task waits for the user again (needs_input, update
   * task.reopened, nextStep reply); nothing runs until they write. 409 not_resolved otherwise
   * (a routine never counts as resolved here).
   */
  async reopen(task: TaskRow): Promise<TaskRow> {
    return this.mutate(task.id, (current) => {
      if (current.routine || current.status !== "resolved") throw new HttpError(409, "not_resolved", "This task isn't done.");
      return { status: "needs_input", updates: appendUpdate(current, this.entry({ key: REOPENED_KEY }, "OpenDuet")) };
    }, { reopened: true });
  }

  /** The `task` event for a row created outside create() (a routine). */
  async announce(row: TaskRow): Promise<void> {
    await this.changed(row);
  }

  /**
   * DELETE /api/tasks/:id (M9, contract §4): cancels a queued or running turn of the task (its
   * session, a routine's runs), then deletes the task with its thread (cascade), its approvals and
   * their cards, its Up next suggestions and its task_spawn chip; emits message_deleted for each
   * card outside the task's thread and task_deleted. Run rows stay (usage history).
   */
  async remove(task: TaskRow): Promise<void> {
    const { db, events, runs } = this.deps;
    await runs.cancel({ userId: task.userId, taskId: task.id });
    await this.lock.run(task.id, async () => {
      const approvals = await db.approval.findMany({ where: { taskId: task.id, userId: task.userId }, select: { id: true, messageId: true } });
      const cardIds = [...new Set([task.spawnMessageId, ...approvals.map((a) => a.messageId)].filter((id): id is string => !!id))];
      const outside = cardIds.length
        ? await db.message.findMany({ where: { id: { in: cardIds }, userId: task.userId, OR: [{ taskId: null }, { taskId: { not: task.id } }] }, select: { id: true, channelId: true } })
        : [];
      await db.$transaction([
        db.message.deleteMany({ where: { id: { in: outside.map((m) => m.id) }, userId: task.userId } }),
        db.approval.deleteMany({ where: { taskId: task.id, userId: task.userId } }),
        db.suggestion.deleteMany({ where: { taskId: task.id, userId: task.userId } }),
        db.task.deleteMany({ where: { id: task.id, userId: task.userId } }),
      ]);
      for (const message of outside) await events.emit(task.userId, message.channelId, "message_deleted", { messageId: message.id });
      await events.emit(task.userId, task.channelId, "task_deleted", { taskId: task.id });
    });
  }

  /**
   * TaskResumer: an approval of this task was decided. Unless the user already resolved the task
   * it goes back to working and the session gets a turn with the outcome (a turn already waiting
   * in the queue sees it through the instructions instead). The outcome is no update row: the run
   * record's approval step shows it (M8).
   */
  async resumeAfterApproval(taskId: string, outcome: ApprovalOutcome): Promise<void> {
    const task = await this.deps.db.task.findUnique({ where: { id: taskId } });
    if (!task) return;
    const row = await this.mutate(taskId, (current) => (current.status === "resolved" || current.status === "working" ? null : { status: "working" }));
    if (row.status === "resolved" || this.deps.runs.waitingFor(taskId) > 0) return;
    await this.queueTurn(row, resumeNote(outcome));
  }

  /**
   * ChatResumer (M21 #12): the approval cards a chat turn posted (no task) were all decided. Like a
   * task's session, the chat carries on: one chat turn in the card's channel whose request says
   * what became of each card. A chat turn already waiting in that thread reads the decided cards
   * itself (the approvals instructions), so none is added then; a user message waiting to join the
   * running turn (steering) gets the note with it instead; a deleted channel gets none.
   */
  async resumeChatAfterApproval(input: { userId: string; channelId: string; outcomes: ApprovalOutcome[] }): Promise<void> {
    if (!input.outcomes.length || this.deps.runs.pendingChat(input.userId, input.channelId) > 0) return;
    const note = chatResumeNote(input.outcomes);
    if (this.deps.runs.steerNote(input.userId, input.channelId, note)) return;
    const channel = await this.deps.db.channel.findFirst({ where: { id: input.channelId, userId: input.userId }, select: { id: true } });
    if (!channel) return;
    await this.deps.runs.submit({ userId: input.userId, channelId: input.channelId, taskId: null, kind: "chat", prompt: note });
  }

  /**
   * At startup, BEFORE RunHost.recoverStaleRuns(): every task still working, or with a task run
   * a previous process left queued/running, becomes needs_input with the update "Paused by a
   * server restart. Reply to continue." (L70). Replying resumes its session.
   */
  async recoverAfterRestart(): Promise<number> {
    const { db } = this.deps;
    // A routine's runs (kind "routine") belong to the routine but aren't its session: it stays scheduled.
    const stale = await db.run.findMany({ where: { taskId: { not: null }, kind: { not: "routine" }, status: { in: ["queued", "running"] } }, select: { taskId: true } });
    const ids = new Set(stale.flatMap((run) => (run.taskId ? [run.taskId] : [])));
    const working = await db.task.findMany({ where: { OR: [{ status: "working" }, { id: { in: [...ids] } }], NOT: { status: "resolved" }, routine: false }, select: { id: true } });
    for (const { id } of working) {
      await this.mutate(id, (current) => ({
        status: "needs_input",
        updates: appendUpdate(current, this.entry({ key: TASK_PHRASE.pausedRestart }, "OpenDuet")),
      }));
    }
    return working.length;
  }

  /**
   * Another module carries a task's session on (OpenDuet's computer after a hand back or a sign-in
   * card): one more turn with the task's own before/after bookkeeping. A resolved task, or one with
   * a turn already waiting, is left alone.
   */
  async continueTask(taskId: string, prompt: string): Promise<void> {
    const task = await this.deps.db.task.findUnique({ where: { id: taskId } });
    if (!task || task.status === "resolved" || this.deps.runs.waitingFor(taskId) > 0) return;
    await this.queueTurn(task, prompt);
  }

  /**
   * M14a review #1: Make builds this task's session started have settled (the last running one just
   * did). The session gets one carry-on turn whose request says what was built (finish the task now)
   * or what failed and why (tell the user / try again), so make_artifact then a refused finish_task
   * doesn't leave the task parked. While a turn of the task is running, it waits for that turn to end
   * (its context was read before the card existed); a turn already queued sees the card in its
   * history instead, and a resolved or ready-for-review task is left alone.
   */
  async carryOnAfterBuild(taskId: string, builds: SettledBuild[]): Promise<void> {
    if (!builds.length) return;
    if (this.turns.has(taskId)) {
      this.afterTurnBuilds.set(taskId, [...(this.afterTurnBuilds.get(taskId) ?? []), ...builds]);
      return;
    }
    // Synchronous checks first: a second build settling meanwhile mustn't queue a second turn.
    if (this.queuing.has(taskId) || this.deps.runs.waitingFor(taskId) > 0) return;
    // A build that keeps failing: after FAILED_CARRY_ONS carry-ons in a row the task waits for the
    // user (it's needs_input with the failure update), so a retry loop can't run on its own.
    const failedOnly = builds.every((b) => !b.ok);
    const streak = failedOnly ? (this.failedCarryOns.get(taskId) ?? 0) + 1 : 0;
    if (failedOnly && streak > FAILED_CARRY_ONS) return;
    this.queuing.add(taskId);
    try {
      const task = await this.deps.db.task.findUnique({ where: { id: taskId } });
      if (!task || (task.status !== "working" && task.status !== "needs_input")) return;
      if (streak) this.failedCarryOns.set(taskId, streak);
      else this.failedCarryOns.delete(taskId);
      const runId = await this.queueTurn(task, buildsNote(builds));
      if (runId && failedOnly) this.failedBuildTasks.add(taskId);
      else if (runId) this.failedBuildTasks.delete(taskId);
    } finally {
      this.queuing.delete(taskId);
    }
  }

  /** Called by the task tools: what the model asked for in this run (finish_task's summary, ask_user's question). */
  signal(runId: string, value: Signal, note?: string, messageId?: string, callId?: string): void {
    this.signals.set(runId, { value, at: this.now(), ...(note ? { note } : {}), ...(messageId ? { messageId } : {}), ...(value === "finish" ? { afterText: finishTextAfter(runId, callId) } : {}) });
  }

  /**
   * add_update's source label: "OpenDuet", "OpenDuet's computer", or the display name of an app the
   * user connected or the catalog knows; anything else (a model-made label) becomes "OpenDuet".
   */
  async updateSource(userId: string, source: string | undefined): Promise<string> {
    const value = source?.trim() ?? "";
    if (!value || ASSISTANT_NAME.test(value)) return "OpenDuet";
    if (COMPUTER_NAME.test(value)) return "OpenDuet's computer";
    if (!this.deps.apps) return "OpenDuet";
    try {
      return (await this.deps.apps(userId, value)) ?? "OpenDuet";
    } catch {
      return "OpenDuet";
    }
  }

  /**
   * A resource's app (M9, contract §6): "OpenDuet's computer", or the display name of an app the user
   * connected or the catalog knows; anything else ("OpenDuet", a made-up label, a file name) is null,
   * so the app never draws a monogram for a name that isn't an app.
   */
  async resourceApp(userId: string, app: string | undefined | null): Promise<string | null> {
    const value = app?.trim() ?? "";
    if (!value) return null;
    if (COMPUTER_NAME.test(value)) return "OpenDuet's computer";
    if (!this.deps.apps) return null;
    try {
      return (await this.deps.apps(userId, value)) ?? null;
    } catch {
      return null;
    }
  }

  /** Read-only: approvals of this task still waiting for the user. */
  pendingApprovals(taskId: string): Promise<number> {
    return this.deps.db.approval.count({ where: { taskId, status: "pending" } });
  }

  /**
   * Serialized read-modify-write of one task; emits the `task` event and refreshes the spawn
   * chip when something changed. `change` gets the current row and returns the columns to set.
   */
  mutate(taskId: string, change: (current: TaskRow) => Patch | null | Promise<Patch | null>, hint: NextHint = {}): Promise<TaskRow> {
    return this.lock.run(taskId, async () => {
      const current = await this.deps.db.task.findUniqueOrThrow({ where: { id: taskId } });
      return this.apply(current, await change(current), hint);
    });
  }

  /**
   * Writes `patch` (inside the task's lock). M22: every change also keeps resolvedAt (set when it
   * becomes resolved, cleared when it leaves), drops a failure once resolved, and derives nextStep
   * again (tasks/next-step.ts; `hint` is what the caller knows that the row doesn't). Emits the
   * `task` event only when a column changed.
   */
  private async apply(current: TaskRow, patch: Patch | null, hint: NextHint = {}): Promise<TaskRow> {
    const data: Partial<TaskRow> = { ...(patch ?? {}) };
    const status = data.status ?? current.status;
    if (status === "resolved" && (current.status !== "resolved" || !current.resolvedAt)) data.resolvedAt = this.now();
    if (status !== "resolved" && current.resolvedAt) data.resolvedAt = null;
    if (status === "resolved" && current.failure) data.failure = null;
    const draft = { ...current, ...data } as TaskRow;
    const next = await deriveNextStep(this.deps.db, { row: draft, before: current, hint, now: this.now() });
    const stored = next ? JSON.stringify(next) : null;
    if (stored !== current.nextStep) data.nextStep = stored;
    if (Object.keys(data).length === 0) return current;
    const row = await this.deps.db.task.update({ where: { id: current.id }, data });
    await this.changed(row);
    return row;
  }

  /** A "Decisions and updates" row written now. */
  entry(text: Phrase, source: string): Update {
    return { text, source, at: this.now().toISOString() };
  }

  /** Queues a turn of the task's session; `prompt` is what the model sees as this turn's request. */
  private async queueTurn(task: TaskRow, prompt: string): Promise<string | null> {
    return this.deps.runs.submit({ userId: task.userId, channelId: task.channelId, taskId: task.id, kind: "task", prompt, hooks: this.hooks(task.id, "submitted") });
  }

  /** A stored user message's origin: forwarded when tell_task passed it on from the chat, else a reply. */
  private async originOf(messageId: string): Promise<Origin> {
    const row = await this.deps.db.message.findUnique({ where: { id: messageId }, select: { payload: true } });
    try {
      return row && (JSON.parse(row.payload) as Record<string, unknown>).forwarded === "chat" ? "forwarded" : "reply";
    } catch {
      return "reply";
    }
  }

  private hooks(taskId: string, origin: Origin | (() => Promise<Origin>)) {
    return {
      steered: (runId: string) => {
        this.signals.delete(runId);
        const start = this.starts.get(runId);
        if (start) start.origin = "reply";
      },
      before: async (runId: string) => {
        // Marked before any await, so a build settling while this turn runs waits for its end.
        this.turns.set(taskId, runId);
        // M18: messages of this turn are the ones created from here on (its result, its question).
        const start: TurnStart = { startedAt: new Date(), before: null, origin: typeof origin === "string" ? origin : "reply" };
        this.starts.set(runId, start);
        if (typeof origin !== "string") start.origin = await origin();
        return this.beforeTurn(taskId, start.origin, runId);
      },
      after: async (outcome: TurnOutcome) => {
        try {
          await this.afterTurn(taskId, outcome);
        } finally {
          await this.turnEnded(taskId, outcome.runId);
        }
      },
    };
  }

  /**
   * M14a review #1: the task's turn ended (or was skipped), after its status was decided: builds
   * that settled while it ran now get their carry-on turn (carryOnAfterBuild checks the status).
   */
  private async turnEnded(taskId: string, runId: string): Promise<void> {
    if (this.turns.get(taskId) === runId) this.turns.delete(taskId);
    if (this.turns.has(taskId)) return;
    const builds = this.afterTurnBuilds.get(taskId);
    if (!builds) return;
    this.afterTurnBuilds.delete(taskId);
    try {
      await this.carryOnAfterBuild(taskId, builds);
    } catch (error) {
      log.warn("task carry-on after a build failed", { taskId, error: { name: (error as Error).name } });
    }
  }

  /**
   * Right before a turn: a resolved task only runs again when the user replies; over the usage
   * limit the turn is skipped and the task waits for the user (needs_input + an update + the
   * usage_limit line in its thread). Otherwise the task is working.
   */
  private async beforeTurn(taskId: string, origin: Origin, runId: string): Promise<boolean> {
    const task = await this.deps.db.task.findUnique({ where: { id: taskId } });
    if (!task) return false;
    const start = this.starts.get(runId);
    if (start) start.before = task.status as TaskStatus;
    // M18 review: a reply to a done task stays quiet (and so do replies queued behind it); words
    // passed on from the chat aren't seen in the task, so their result goes to the chat.
    if (origin === "reply" && (task.status === "resolved" || task.status === "ready_for_review")) this.quietReplies.add(taskId);
    else if (origin === "forwarded") this.quietReplies.delete(taskId);
    if (origin === "submitted" && task.status === "resolved") return false;
    const resumesAt = await this.deps.runs.usageLimit(task.userId, task.channelId, task.id);
    // M22: a new turn (a reply, Retry, a carry-on) ends the failure it would have retried.
    if (resumesAt) {
      await this.mutate(taskId, (current) => {
        const last = updatesOf(current).at(-1);
        const already = last?.text.key === TASK_PHRASE.pausedUsageLimit && current.status === "needs_input";
        if (already) return current.failure ? { failure: null } : null;
        return {
          status: "needs_input", failure: null,
          updates: appendUpdate(current, this.entry({ key: TASK_PHRASE.pausedUsageLimit, params: { at: { type: "datetime", value: resumesAt } } }, "OpenDuet")),
        };
      });
      return false;
    }
    await this.mutate(taskId, (current) => (current.status === "working" && !current.failure ? null : { status: "working", failure: null }));
    return true;
  }

  /**
   * After a turn (L70, M18). A failed turn -> needs_input with the error as an update. Otherwise
   * ask_user, or a pending approval of this task -> needs_input; finish_task -> done; a turn that
   * ends with every checklist step done (an empty checklist counts), no build of the task still
   * running or just settled, and a last text of this turn that doesn't end with a question mark
   * -> done too (the assistant finished without calling finish_task); anything else (a question, open
   * steps, Stop) -> needs_input. Done is resolved, or ready_for_review when the task touched the
   * user's things (tasks/touched.ts); a routine keeps ready_for_review. A resolved task stays
   * resolved, a task with another turn queued stays working, and shutdown leaves it working for
   * recoverAfterRestart. The chat gets the result on a real move into done, and one line when the
   * task moved into needs_input because the turn failed or the assistant asked (not for a reply the user
   * is watching, a pending approval alone, or a routine).
   */
  private async afterTurn(taskId: string, outcome: TurnOutcome): Promise<void> {
    const signal = this.signals.get(outcome.runId);
    this.signals.delete(outcome.runId);
    const start = this.starts.get(outcome.runId);
    this.starts.delete(outcome.runId);
    if (outcome.skipped || (outcome.result.status === "cancelled" && !outcome.stopped)) return;
    const result = outcome.result;
    // A carry-on that only answered a failed build (or its retry): the deliverable is missing, so
    // not done by itself. A turn that ended without failing clears it.
    const afterFailedBuild = this.failedBuildTasks.has(taskId);
    if (result.status !== "failed") this.failedBuildTasks.delete(taskId);
    const quiet = this.quietReplies.has(taskId);
    const pending = await this.pendingApprovals(taskId);
    const last = await this.lastText(taskId, start?.startedAt ?? null);
    const said = last?.text ?? null;
    const carded = await this.postedUserCard(taskId, start?.startedAt ?? null);
    const before = start?.before ?? null;
    // Filled inside the mutation (a holder object: TS doesn't track assignments made in callbacks).
    const post: { done?: "resolved" | "ready_for_review"; failed?: Phrase; asked?: boolean } = {};
    // M22: the question this turn ends on, for the task's nextStep (read by apply() after the callback).
    const hint: NextHint = {};
    const decide = async (current: TaskRow): Promise<Patch | null> => {
      if (current.status === "resolved" || this.deps.runs.waitingFor(taskId) > 0) return null;
      if (result.status === "failed") {
        const error: Phrase = result.error ?? { key: "system.model_unreachable", params: { reason: { type: "text", value: "internal" } } };
        // Only a real move into needs_input gets the chat line (a task already waiting doesn't).
        if (before !== "needs_input") post.failed = error;
        // M22 (#21): the failure on its own too (status stays needs_input for older apps).
        return { status: "needs_input", failure: JSON.stringify(failureFor(error, this.now())), updates: appendUpdate(current, this.entry(error, "OpenDuet")) };
      }
      let status: TaskStatus;
      let asked = false;
      if (signal?.value === "ask" || pending > 0) {
        status = "needs_input";
        asked = signal?.value === "ask" || endsWithQuestion(said);
      } else if (signal?.value === "finish" || (!current.routine && !outcome.stopped && !afterFailedBuild && !carded && this.finishedOnItsOwn(current, said))) {
        status = await this.doneStatus(current);
      } else {
        status = "needs_input";
        asked = !outcome.stopped && endsWithQuestion(said);
      }
      if (status === "resolved" || status === "ready_for_review") {
        // Already done (ready for review, set meanwhile): it stays as it is, and nothing is posted again.
        if (current.status === "ready_for_review") return null;
        // Only a real move into done posts the result. A reply in a task that was already done
        // (a "thanks", a follow-up question; quietReplies) settles back to done without a new result
        // in the chat: the user is in the task and sees the answer there.
        if (!quiet) post.done = status;
      } else if (asked && before !== "needs_input") {
        post.asked = true;
      }
      if (status === "needs_input" && asked) {
        const explicit = signal?.value === "ask" && signal.note ? signal.note : null;
        const question = explicit ?? lastSentence(said);
        if (question) hint.ask = { question, messageId: explicit ? (signal?.messageId ?? null) : (last?.id ?? null) };
      }
      const patch: Patch = status === current.status ? {} : { status };
      if (current.failure) patch.failure = null;
      return Object.keys(patch).length ? patch : null;
    };
    const row = await this.mutate(taskId, async (current) => {
      const patch = await decide(current);
      // M22 (A P2-8): files, pages and write-tool links of the task's records become resources.
      const found = await derivedResources(this.deps.db, current).catch(() => []);
      return found.length ? { ...(patch ?? {}), resources: JSON.stringify([...resourcesOf(current), ...found]) } : patch;
    }, hint);
    // Settled (not still working behind queued replies): the next reply starts afresh.
    if (row.status !== "working") this.quietReplies.delete(taskId);
    if (post.done && row.status === post.done) {
      // Prefer actual final text, not an opening bubble before finish_task. With no summary,
      // preserve M18/M22's last-text fallback (models were told to write the result then finish).
      const final = signal?.value === "finish"
        ? signal.afterText?.trim() || (last && last.createdAt > signal.at ? said : null) || signal.note || said
        : said ?? signal?.note;
      await this.postResult(row, post.done, final);
      return;
    }
    // The user is in the task (a reply): they see it there. Routines keep their old behavior.
    if (start?.origin === "reply" || row.routine || row.status !== "needs_input") return;
    if (post.failed) await this.postNotice(row, "agent.task_failed", { reason: post.failed });
    else if (post.asked) await this.postNotice(row, "agent.task_waiting", { question: signal?.value === "ask" && signal.note ? signal.note : lastSentence(said) });
  }

  /**
   * M18: the turn ended without finish_task but the work looks done: every step done (or none),
   * no build of the task still running or settled during the turn (its carry-on decides), and the
   * last text isn't a question.
   */
  private finishedOnItsOwn(task: TaskRow, said: string | null): boolean {
    if (stepsOf(task).some((s) => s.state !== "done")) return false;
    // A build that settled but whose outcome is still on its way gets its carry-on turn first.
    if (taskBuilds.building(task.id).length || taskBuilds.undelivered(task.id) > 0 || this.afterTurnBuilds.has(task.id)) return false;
    return !endsWithQuestion(said);
  }

  /** Done: resolved, or ready_for_review when it touched the user's things (when unsure, ready_for_review). */
  private async doneStatus(task: TaskRow): Promise<"resolved" | "ready_for_review"> {
    if (task.routine) return "ready_for_review";
    try {
      return (await touchedUserThings(this.deps.db, task.userId, task.id)) ? "ready_for_review" : "resolved";
    } catch (error) {
      log.warn("task touch check failed", { taskId: task.id, error: { name: (error as Error).name } });
      return "ready_for_review";
    }
  }

  /**
   * M18: this turn posted a card that waits for the user in the task's thread (a form, quick replies,
   * a connection request, a sign-in): its answer continues the task, so the turn isn't done by itself.
   */
  private async postedUserCard(taskId: string, since: Date | null): Promise<boolean> {
    if (!since) return false;
    return (await this.deps.db.message.count({ where: { taskId, kind: { in: [...WAITING_CARDS] }, createdAt: { gte: since } } })) > 0;
  }

  /** The newest assistant text of the task's thread written since the turn started (null when none). */
  private async lastText(taskId: string, since: Date | null): Promise<{ id: string; text: string; createdAt: Date } | null> {
    if (!since) return null;
    const row = await this.deps.db.message.findFirst({
      where: { taskId, role: "assistant", kind: "text", createdAt: { gte: since }, NOT: { text: "" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, text: true, createdAt: true },
    });
    const text = row?.text.trim();
    return row && text ? { id: row.id, text, createdAt: row.createdAt } : null;
  }

  /**
   * M18 result (replaces the M8 done notice): an assistant text message in the task's channel, on the
   * main timeline (taskId null), whose text is the task's final result (text after finish_task,
   * else its summary, else this turn's last text / the agent.task_done line) and whose payload
   * carries taskResult. A failure is logged and never undoes the transition.
   */
  private async postResult(task: TaskRow, status: "resolved" | "ready_for_review", result: string | null | undefined): Promise<void> {
    const { db, events } = this.deps;
    try {
      const user = await db.user.findUniqueOrThrow({ where: { id: task.userId }, select: { language: true } });
      const text = result?.trim() ? clipResult(result.trim()) : doneText(phrase("agent.task_done", user.language), task);
      await postMessage(db, events, {
        userId: task.userId, channelId: task.channelId, taskId: null, role: "assistant", kind: "text", text,
        payload: {
          skill: null, attachments: [], replyTo: null, forwarded: null,
          taskResult: { taskId: task.id, title: task.title, status, sourceCount: resourcesOf(task).length },
        },
      });
    } catch (error) {
      log.warn("task result could not be posted", { taskId: task.id, error: { name: (error as Error).name } });
    }
  }

  /** M18: the failed / waiting line with the task's link, in the user's language. Logged on failure. */
  private async postNotice(task: TaskRow, key: "agent.task_failed" | "agent.task_waiting", what: { reason?: Phrase; question?: string }): Promise<void> {
    const { db, events } = this.deps;
    try {
      const user = await db.user.findUniqueOrThrow({ where: { id: task.userId }, select: { language: true, timezone: true } });
      const extra: Record<string, string> = what.reason
        ? { reason: noticeExcerpt(renderForUser(what.reason, user.language, user.timezone), REASON_MAX) }
        : { question: noticeExcerpt(what.question ?? "", QUESTION_MAX) };
      if (!Object.values(extra)[0]) return;
      await postMessage(db, events, {
        userId: task.userId, channelId: task.channelId, taskId: null, role: "assistant", kind: "text",
        text: fillTemplate(phrase(key, user.language), task, extra), payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null },
      });
    } catch (error) {
      log.warn("task notice could not be posted", { taskId: task.id, error: { name: (error as Error).name } });
    }
  }

  /** The `task` event, and the channel's task_spawn chip (payload + `message` event) kept in sync. */
  private async changed(row: TaskRow): Promise<void> {
    await taskChanged(this.deps.db, this.deps.events, row);
  }
}

/** A stored schedule column as a Schedule, or null. */
export function scheduleFrom(raw: string | null): RoutineSchedule | null {
  if (!raw) return null;
  try {
    const parsed = Schedule.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function appendUpdate(row: TaskRow, update: Update): string {
  return JSON.stringify(mergeUpdate(updatesOf(row), update));
}

/**
 * The done notice's text: the phrase with the task link filled in ({title} with markdown link
 * brackets escaped), then the summary after a blank line. Function replacements, so a "$" in a
 * title is kept as written.
 */
export function doneText(template: string, task: Pick<TaskRow, "id" | "title">, summary?: string): string {
  // One pass, so a literal "{id}" inside the title is never taken for the link's placeholder.
  const line = fillTemplate(template, task);
  const more = summary?.trim();
  return more ? `${line}\n\n${more}` : line;
}

/** M22: the carry-on turn of a Retry without a model_error card to resubmit (server-written, never shown). */
export const RETRY_NOTE = "[Server note, not from the user] The previous turn of this task failed before it finished, and the user tapped Try again. Carry on from where it stopped.";

/** The card's `message` event; a card deleted meanwhile is only logged. */
async function emitStoredSafe(db: Db, events: EventBus, userId: string, id: string): Promise<void> {
  try {
    await emitStored(db, events, userId, id);
  } catch (error) {
    log.warn("retried card could not be emitted", { messageId: id, error: { name: (error as Error).name } });
  }
}

/** What the resumed session sees as its turn's request (server-written, never shown in the app). */
export function resumeNote(outcome: ApprovalOutcome): string {
  const what = outcome.status === "approved"
    ? (outcome.ok ? "approved it and it was carried out" : "approved it, but carrying it out failed")
    : outcome.status === "declined" ? "declined it, so it was not carried out" : "didn't decide in time; it expired and was not carried out";
  return [
    `[Server note, not from the user] Approval ${outcome.approvalId}: the user ${what}.`,
    outcome.summary.trim() ? `Outcome: ${outcome.summary.trim()}` : "",
    "Continue this task from where it stopped, taking this outcome into account.",
  ].filter(Boolean).join("\n");
}
