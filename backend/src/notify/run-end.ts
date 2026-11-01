// M29: a push when a run stops (it finished, it waits for the user, it failed) and the user isn't
// looking. RunHost reports what a run posts (posted) and how it ends (ended); the rest is decided
// here. At most one push per run, the most specific one:
// - A form, connection request or sign-in card is pushed the moment it's posted (a sign-in can keep
//   the run waiting), like an approval; such a run, and one that posted an approval, spend request
//   or alert card (pushed by triggers.ts), gets nothing more when it ends.
// - A final failure (the model_error card is posted; a background run that will retry posts none):
//   notify.failed on that card; a routine's: notify.routine_failed, or notify.routine_paused when this
//   run's failure paused it (ROUTINE_FAIL_LIMIT in a row).
// - Otherwise the run's newest assistant message: notify.reply for a chat turn (a reply to the user,
//   also the turn after an approval, form or quick reply), notify.message for a check-in, scan or
//   routine. Nothing posted (a quiet check-in): no push. The brief pushes its first line itself.
// Never: a task's own session (the task's status pushes, triggers.ts), a Make build (artifacts push
// ready / failed), a turn a voice call is still on (Job.callId), a run that ended cancelled (Stop,
// a delete, a shutdown). Only what this process saw its runs do pushes, never a replayed or
// re-emitted message, so a restart can't push the same thing again.
// Quiet hours (NotifyInput.quiet): proactive runs (check-in, scan, routine, brief) follow them; a
// chat turn's replies, cards and failures ring.
import type { RunKind } from "../agent/types.ts";
import type { Message } from "../contract/messages.ts";
import { ROUTINE_FAIL_LIMIT } from "../contract/m22.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { updatesOf } from "../tasks/serialize.ts";
import type { NotifyInput } from "./notifier.ts";
import { NOTIFY_CONNECT, NOTIFY_FAILED, NOTIFY_FORM, NOTIFY_MESSAGE, NOTIFY_REPLY, NOTIFY_ROUTINE_FAILED, NOTIFY_ROUTINE_PAUSED, NOTIFY_SIGN_IN, textParam } from "./phrases.ts";
import { collapseIdFor, deepLink } from "./triggers.ts";

/** The run a notice is about, as RunHost knows it. */
export interface RunRef {
  userId: string;
  channelId: string;
  /** a task's own session; null for the channel's timeline */
  taskId: string | null;
  /** the task the Run row belongs to (a routine's id for its channel turns) */
  recordTaskId: string | null;
  runId: string;
  kind: RunKind;
  /** the voice call the turn is still handed to (cleared when the call hangs up) */
  callId: string | null;
}

/** What RunHost tells the Notifier (index.ts wires it; tests may leave it out). */
export interface RunNotices {
  /** a message this run just created in its thread */
  posted(run: RunRef, message: Message): void;
  /** the run's Run row and `done` are written */
  ended(run: RunRef, status: "completed" | "failed" | "cancelled"): void;
}

/** Cards pushed elsewhere (triggers.ts, computer/service.ts) when posted: the run waits on the user. */
const PUSHED_ELSEWHERE: ReadonlySet<string> = new Set(["approval", "spend_request", "alert"]);
/** Runs whose end isn't remembered past this many (a run that never ends: shutdown, absorbed). */
const TRACKED = 1000;
const ROUTINE_PAUSED_KEY = "task.routine_paused_failures";

interface RunState { messages: string[]; errorCard: string | null; waited: boolean }

export interface RunEndDeps {
  db: Db;
  notify: (input: NotifyInput) => Promise<unknown>;
  /** keeps the decision in the Notifier's in-flight set (idle(), stop()) */
  track: <T>(work: Promise<T>) => Promise<T>;
}

/** A form / connection request / sign-in card that's still open, as the push's body. */
function waitingBody(message: Message): NotifyInput["body"] | null {
  switch (message.kind) {
    case "form": return message.payload.state === "open" ? { key: NOTIFY_FORM } : null;
    case "connection_request": return message.payload.state === "open" ? { key: NOTIFY_CONNECT, params: { name: textParam(message.payload.name) } } : null;
    case "sign_in": return message.payload.state === "pending" ? { key: NOTIFY_SIGN_IN, params: { name: textParam(message.payload.domain) } } : null;
    default: return null;
  }
}

export class RunEndNotices implements RunNotices {
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly deps: RunEndDeps) {}

  /** Never pushed from here: a task's session, a Make build, a turn a call is on. */
  private static silent(run: RunRef): boolean {
    return run.taskId !== null || run.kind === "build" || run.callId !== null;
  }

  /** Proactive runs follow quiet hours; what the user started (a chat turn) rings. */
  private static quiet(run: RunRef): boolean {
    return run.kind !== "chat";
  }

  posted(run: RunRef, message: Message): void {
    const state = this.state(run.runId);
    if (message.kind === "model_error") state.errorCard = message.id;
    if (message.role !== "assistant") return;
    state.messages.push(message.id);
    if (PUSHED_ELSEWHERE.has(message.kind)) {
      state.waited = true;
      return;
    }
    const body = waitingBody(message);
    if (!body) return;
    state.waited = true;
    if (RunEndNotices.silent(run)) return;
    void this.deps.notify({
      userId: run.userId, channelId: run.channelId, body, route: deepLink("channels", run.channelId, message.id),
      collapseId: collapseIdFor.message(message.id), quiet: RunEndNotices.quiet(run),
    }).catch(() => undefined);
  }

  ended(run: RunRef, status: "completed" | "failed" | "cancelled"): void {
    const state = this.runs.get(run.runId);
    this.runs.delete(run.runId);
    if (!state || status === "cancelled" || state.waited || RunEndNotices.silent(run)) return;
    void this.deps.track(this.decide(run, status, state).then((input) => (input ? this.deps.notify(input) : null)).catch((error: unknown) => {
      log.error("run end notification failed", { runId: run.runId, error: { name: (error as Error).name } });
    }));
  }

  private async decide(run: RunRef, status: "completed" | "failed", state: RunState): Promise<NotifyInput | null> {
    const base = { userId: run.userId, channelId: run.channelId, quiet: RunEndNotices.quiet(run) };
    if (status === "failed") {
      // No card: the run will be tried again (A5) and only its last failure says so.
      if (!state.errorCard) return null;
      const route = deepLink("channels", run.channelId, state.errorCard);
      const collapseId = collapseIdFor.message(state.errorCard);
      if (run.kind === "routine" && run.recordTaskId) {
        const routine = await this.routine(run.recordTaskId, run.runId);
        if (routine?.paused) return { ...base, body: { key: NOTIFY_ROUTINE_PAUSED, params: { title: textParam(routine.title) } }, route: deepLink("tasks", run.recordTaskId), collapseId };
        if (routine) return { ...base, body: { key: NOTIFY_ROUTINE_FAILED, params: { title: textParam(routine.title) } }, route, collapseId };
      }
      return { ...base, body: { key: NOTIFY_FAILED }, route, collapseId };
    }
    // The brief pushes its first line itself (proactive/service.ts).
    if (run.kind === "brief" || state.messages.length === 0) return null;
    // Still there and visible (not deleted, not a call's hidden bubble); the newest in posting order.
    const rows = await this.deps.db.message.findMany({
      where: { id: { in: state.messages }, userId: run.userId, channelId: run.channelId, taskId: null, callId: null, role: "assistant" },
      select: { id: true },
    });
    const found = new Set(rows.map((row) => row.id));
    const last = state.messages.findLast((id) => found.has(id));
    if (!last) return null;
    return {
      ...base, body: { key: run.kind === "chat" ? NOTIFY_REPLY : NOTIFY_MESSAGE },
      route: deepLink("channels", run.channelId, last), collapseId: collapseIdFor.message(last),
    };
  }

  /**
   * A routine's title, and whether this run's failure paused it: the routine is paused by failures
   * and its newest update (routines/service.ts afterTurn) is the pause, written after this run started.
   */
  private async routine(taskId: string, runId: string): Promise<{ title: string; paused: boolean } | null> {
    const { db } = this.deps;
    const [task, row] = await Promise.all([
      db.task.findUnique({ where: { id: taskId } }),
      db.run.findUnique({ where: { id: runId }, select: { startedAt: true, createdAt: true } }),
    ]);
    if (!task) return null;
    const last = updatesOf(task).at(-1);
    const started = (row?.startedAt ?? row?.createdAt ?? new Date(0)).getTime();
    const paused = task.routinePaused && task.routinePausedBy === "failures" && task.routineFailStreak >= ROUTINE_FAIL_LIMIT
      && last?.text.key === ROUTINE_PAUSED_KEY && Date.parse(last.at) >= started;
    return { title: task.title, paused };
  }

  private state(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      state = { messages: [], errorCard: null, waited: false };
      this.runs.set(runId, state);
      if (this.runs.size > TRACKED) this.runs.delete(this.runs.keys().next().value as string);
    }
    return state;
  }
}
