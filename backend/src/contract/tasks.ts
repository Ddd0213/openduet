// Tasks tab, task detail, the Scheduled group (morning brief, check-ins) and Up next.
import { z } from "zod";
import { AppName, Id, IsoDate, LocalTime, Phrase, Schedule } from "./common.ts";
import { RoutinePausedBy, TaskFailure, TaskNextStep } from "./m22.ts";
import { SourceRef } from "./m23.ts";

export const TaskStatus = z.enum(["working", "needs_input", "ready_for_review", "scheduled", "resolved"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * M9: a scheduled task ("every day at 9:00 send me a morning brief"), made by schedule_task in
 * chat. At each slot OpenDuet runs the task's prompt in its channel and posts the result there
 * (quiet routines post only when something needs the user). Its status stays "scheduled".
 */
export const Routine = z.object({
  paused: z.boolean(),
  quiet: z.boolean(),
  /** null while paused, or after a "once" routine ran */
  nextRunAt: IsoDate.nullable(),
  lastRunAt: IsoDate.nullable(),
  lastRunStatus: z.enum(["completed", "resolved", "skipped", "failed"]).nullable(),
  /** M22 (m22.ts): failed runs in a row; at ROUTINE_FAIL_LIMIT the routine pauses itself */
  failStreak: z.number().int().nonnegative().default(0),
  /** M22 (m22.ts RoutinePausedBy): who paused it; null while it runs */
  pausedBy: RoutinePausedBy.nullable().default(null),
});

export const TaskStep = z.object({
  id: Id,
  text: z.string(),
  state: z.enum(["planned", "current", "done"]),
});

/** A "Decisions and updates" row. Server-built updates (e.g. the restart pause) use a key. */
export const TaskUpdate = z.object({
  text: Phrase,
  /** source label, e.g. "Gmail" or "OpenDuet" */
  source: z.string(),
  /** the latest time (for a merged row, when it last happened) */
  at: IsoDate,
  /** M16: the same server-built row written again right after itself (a retry that failed the
   * same way) is merged: how many times, and when the first one was. Absent means once. */
  count: z.number().int().min(2).optional(),
  since: IsoDate.optional(),
});

export const TaskResource = z.object({
  title: z.string(),
  type: z.enum(["doc", "email", "event", "link", "file", "artifact", "browser"]),
  /** https URL, or an in-app route: duet://files/<id>, duet://artifacts/<id>, duet://computer */
  link: z.string(),
  app: AppName.nullable(),
});

export const TaskSummary = z.object({
  id: Id,
  channelId: Id,
  title: z.string(),
  status: TaskStatus,
  source: z.enum(["user", "proactive"]),
  /** the latest update, shown after the status word ("Working · Just started") */
  latestUpdate: TaskUpdate.nullable(),
  updateCount: z.number().int().nonnegative(),
  schedule: Schedule.nullable(),
  archived: z.boolean(),
  /** M9: pinned tasks sort first in Active ("Pinned" group); older payloads parse as false */
  pinned: z.boolean().default(false),
  /** M9: set for a scheduled task (a routine OpenDuet runs on `schedule`); null for every other task */
  routine: Routine.nullable().default(null),
  /** M22 (m22.ts TaskNextStep): what the task waits on the user for; null when nothing */
  nextStep: TaskNextStep.nullable().default(null),
  /** M22 (m22.ts TaskFailure): why the last run failed; null when it didn't */
  failure: TaskFailure.nullable().default(null),
  /** M22: when it was last resolved (Active shows resolved tasks for RESOLVED_KEEP_DAYS); null otherwise */
  resolvedAt: IsoDate.nullable().default(null),
  /** M22: the app of the suggestion it came from ("From Gmail" on the row); null when none */
  app: AppName.nullable().default(null),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskDetail = TaskSummary.extend({
  prompt: z.string(),
  description: z.string(),
  noticedAt: IsoDate.nullable(),
  steps: z.array(TaskStep),
  updates: z.array(TaskUpdate),
  resources: z.array(TaskResource),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/**
 * GET /api/tasks?channelId=<id>|everything. M22: every unfinished task plus the ones resolved in
 * the last RESOLVED_KEEP_DAYS (m22.ts); `olderResolved` counts the rest (not archived).
 * ?resolved=older[&cursor=<nextCursor>][&limit=1-100, default 30]: only those older resolved tasks,
 * newest resolvedAt first, one page at a time. ?q=<text>: every unarchived task whose title or
 * prompt contains the text (case-insensitive), any age, newest first, at most 100.
 * The channelId scope applies to all three.
 */
export const TaskList = z.object({
  tasks: z.array(TaskSummary),
  /** M22: resolved tasks older than the window (0 on a ?resolved=older or ?q= page) */
  olderResolved: z.number().int().nonnegative().default(0),
  /** M22: ?resolved=older only: pass as ?cursor= for the next page; null on the last page */
  nextCursor: z.string().nullable().default(null),
});

/** POST /api/tasks (the + FAB sheet: one text field and Start) */
export const CreateTaskRequest = z
  .object({
    prompt: z.string().trim().min(1).max(8000),
    channelId: Id,
  })
  .strict();

/**
 * PATCH /api/tasks/:id (Mark complete = status resolved; ⋯ Archive). Only the user can resolve.
 * M9: pinned (long-press Pin / Unpin); routines only: paused, schedule (else 400
 * validation_failed). M10: title (Rename) works on any task. -> TaskDetail
 */
export const UpdateTaskRequest = z
  .object({
    status: z.literal("resolved"),
    archived: z.boolean(),
    pinned: z.boolean(),
    paused: z.boolean(),
    schedule: Schedule,
    title: z.string().trim().min(1).max(200),
  })
  .partial()
  .strict();

/**
 * M9: DELETE /api/tasks/:id -> 204. Deletes the task with its thread, approvals and suggestions
 * (a running turn is cancelled first; a pending approval card goes with it). Emits task_deleted;
 * the task_spawn chip in the channel goes too (message_deleted).
 */

/**
 * M22: POST /api/tasks/:id/retry -> TaskDetail. Runs the failed turn again (failure cleared,
 * status working). 409 not_retryable when the task has no failure or it isn't retryable; 409
 * task_running while a turn of it runs.
 * M22: POST /api/tasks/:id/reopen -> TaskDetail. A resolved task goes back to needs_input with
 * nextStep "reply" ("Tell OpenDuet what's left"); nothing runs until the user writes. 409 not_resolved
 * otherwise. A routine can't be reopened (409 not_resolved: it never resolves).
 */

/**
 * M22: GET /api/needs-you: everything waiting on the user, newest first. Tasks whose nextStep is
 * set (their questions, approvals and sign-ins count once, as the task), plus the cards outside any
 * task: open approvals, forms, sign-in and connection requests in the chat and channels.
 * `count` is items.length and is the Tasks tab badge.
 */
export const NeedsYouItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: TaskSummary }),
  z.object({
    kind: z.enum(["approval", "form", "sign_in", "connection"]),
    messageId: Id,
    channelId: Id,
    /** the card's own title (the approval's summary, the form's title, the site, the app) */
    title: z.string(),
    /** task.next.* phrase, the same wording a task row uses */
    detail: Phrase,
    /** duet://channels/<channelId>?message=<messageId> */
    route: z.string().min(1),
    at: IsoDate,
  }),
]);
export const NeedsYou = z.object({ count: z.number().int().nonnegative(), items: z.array(NeedsYouItem) });
export type NeedsYou = z.infer<typeof NeedsYou>;

/** One past run of a scheduled job. M9: "routine" for a scheduled task's runs. */
export const RunRecord = z.object({
  id: Id,
  kind: z.enum(["brief", "checkin", "scan", "routine"]),
  scheduledFor: IsoDate.nullable(),
  startedAt: IsoDate.nullable(),
  status: z.enum(["queued", "running", "completed", "resolved", "skipped", "failed"]),
});

/**
 * GET /api/schedule: the Scheduled group's Morning brief and Check-in rows.
 * M9: `builtins` false (the default, PROACTIVE_BUILTINS unset) = the server doesn't run the
 * built-in brief and check-ins; the app hides both rows and shows only routines (scheduled tasks).
 */
export const ScheduleInfo = z.object({
  builtins: z.boolean().default(false),
  weekendsOn: z.boolean(),
  brief: z.object({
    time: LocalTime,
    nextRunAt: IsoDate,
    history: z.array(RunRecord),
  }),
  checkin: z.object({
    times: z.array(LocalTime),
    nextRunAt: IsoDate,
    history: z.array(RunRecord),
  }),
});

/** POST /api/schedule/run { kind } ("Run now"); the result arrives as events. */
export const RunNowRequest = z.object({ kind: z.enum(["brief", "checkin"]) }).strict();
export const RunNowResponse = z.object({ run: RunRecord });

/** M9: GET /api/tasks/:id/runs: a routine's run history, newest first (at most 30). */
export const RoutineRuns = z.object({ runs: z.array(RunRecord) });
/** M9: POST /api/tasks/:id/run: a routine's "Run now" -> RunNowResponse (409 when one is running). */

/** An "Up next" item ("From your connectors"). */
export const Suggestion = z.object({
  id: Id,
  channelId: Id.nullable(),
  title: z.string(),
  body: z.string(),
  app: AppName.nullable(),
  origin: z.enum(["checkin", "scan", "brief", "chat"]),
  /** M22: the user kept it with "Save for Up next" (origin "chat"); scans never hide or replace it */
  fromUser: z.boolean().default(false),
  /** M23 (m23.ts SourceRef): the email / event it came from ("From Gmail · Re: Q4 budget"); null when none */
  sourceRef: SourceRef.nullable().default(null),
  createdAt: IsoDate,
});

/** GET /api/up-next */
export const UpNext = z.object({ suggestions: z.array(Suggestion), scanning: z.boolean() });
/** POST /api/up-next/:id/add -> the new task */
export const AddSuggestionResponse = z.object({ task: TaskSummary });
/**
 * M22: POST /api/up-next (the + sheet's "Save for Up next") -> 201: keeps the request as an Up next
 * suggestion instead of starting it. Title: its first line, shortened to 80 characters; body: the
 * whole request; origin "chat" (older apps know it) with fromUser true. Start it later with
 * POST /api/up-next/:id/add. Emits nothing new: the app adds it to Up next from the response.
 */
export const SaveForLaterRequest = CreateTaskRequest;
export const SaveForLaterResponse = z.object({ suggestion: Suggestion });
