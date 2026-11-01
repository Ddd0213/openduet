// M22: tasks say what they need from you, "Needs you", Setup, and setting up "who OpenDuet is" in
// the chat. New leaf shapes only; the fields they add to older shapes (TaskSummary, Routine,
// TaskList, CardBlock, the soul_setup message) are declared next to those shapes and point back here.
//
// Additive, so an app built before M22 keeps decoding: every new TaskSummary / Routine / TaskList
// field has a null or 0 default, the card's `group` block is skipped by older apps
// (Models/M9Models.swift CardBlock.unsupported) and `soul_setup` is a kind they show as unsupported.
// Semantics: docs/API.md "## M22".
import { z } from "zod";
import { Id, IsoDate, Phrase } from "./common.ts";

// ---------------------------------------------------------------- what a task needs from you (#20, #21)

/**
 * TaskSummary.nextStep: the one thing the task waits on the user for, written on the row in place
 * of the latest update ("Answer: Which hotel?"). The server derives it from the task's open
 * question (ask_user / ask_form), pending approval, sign-in or connection card, its failure, or a
 * finished task that touched your things (review); null when nothing waits on the user.
 * `messageId`: the card in the task's thread to scroll to (null for review / retry / reply).
 */
export const TaskNextStepKind = z.enum(["answer", "form", "approve", "sign_in", "connect", "review", "retry", "reply"]);
export const TaskNextStep = z.object({
  kind: TaskNextStepKind,
  /** task.next.* phrases, e.g. { key: "task.next.answer", params: { question } } */
  text: Phrase,
  messageId: Id.nullable(),
});
export type TaskNextStep = z.infer<typeof TaskNextStep>;

/**
 * TaskSummary.failure: why the task's last run failed. Set together with the existing behaviour
 * (status needs_input plus the failure as an update), so an older app still shows it under
 * "Waiting on you"; an M22 app shows it in its own Failed group with Try again when `retryable`
 * (POST /api/tasks/:id/retry). Cleared by Retry, a new message in the task, or a run that ends well.
 */
export const TaskFailure = z.object({
  /** the same phrase as the update row (system.model_* / task.failed.*) */
  reason: Phrase,
  /** false: running it again the same way can't help (e.g. no model set up) */
  retryable: z.boolean(),
  at: IsoDate,
});
export type TaskFailure = z.infer<typeof TaskFailure>;

/**
 * Routine.pausedBy: who paused a scheduled task. "failures": the fatigue rule paused it after
 * ROUTINE_FAIL_LIMIT failed runs in a row (counted across days, separate from a single run's
 * retries); the user resumes it with PATCH { paused: false }, which resets the count.
 */
export const RoutinePausedBy = z.enum(["user", "failures"]);
export type RoutinePausedBy = z.infer<typeof RoutinePausedBy>;
export const ROUTINE_FAIL_LIMIT = 3;

/** Active keeps resolved tasks this long after `resolvedAt`; older ones page in with ?resolved=older. */
export const RESOLVED_KEEP_DAYS = 7;

// ---------------------------------------------------------------- Setup (#47)

/**
 * GET /api/setup: what this server has set up, one row per dependency. The server never sends a
 * secret's value, only whether it is there. Notifications on this phone are the app's own row
 * (only the phone knows its permission); `push` is whether the server can send at all.
 */
export const SetupItemId = z.enum(["model", "search", "apps", "computer", "push", "voice"]);
/**
 * ready: works as far as the server can tell. not_checked: set up, but not tried since it changed
 * (POST /api/setup/check tries it). needs_setup: doesn't work; `detail` says why.
 */
export const SetupStatus = z.enum(["ready", "not_checked", "needs_setup"]);
/**
 * How to fix a row. route: an in-app page (duet://settings/models, duet://settings/apps,
 * duet://settings/voice, duet://computer). env: a server setting the app can't change; `names` are
 * the backend/.env variables and `hint` says what to do (set them and re-run scripts/setup.sh).
 */
export const SetupFix = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("route"), route: z.string().min(1) }),
  z.object({ kind: z.literal("env"), names: z.array(z.string().min(1)).min(1), hint: Phrase }),
]);
export const SetupItem = z.object({
  id: SetupItemId,
  status: SetupStatus,
  /** true where OpenDuet can't answer at all without it (only the model) */
  required: z.boolean(),
  title: Phrase,
  /** what it gives you when ready, or what is missing */
  detail: Phrase,
  /** null when ready */
  fix: SetupFix.nullable(),
  /** when POST /api/setup/check last tried it; null when never */
  checkedAt: IsoDate.nullable(),
});
/** GET /api/setup and POST /api/setup/check (tries each set-up row, then answers the same shape) */
export const SetupInfo = z.object({ items: z.array(SetupItem) });
export type SetupInfo = z.infer<typeof SetupInfo>;

// ---------------------------------------------------------------- "who OpenDuet is" in the chat

/** One row of a soul_setup card: what the field is now and what the user chose in the chat. */
export const SoulSetupField = z.object({
  field: z.enum(["name", "addressAs", "identity", "persona", "tone"]),
  current: z.string().max(4000),
  proposed: z.string().max(4000),
});
export type SoulSetupField = z.infer<typeof SoulSetupField>;

/**
 * POST /api/soul/intro (Everything → Who OpenDuet is → "Set up in chat") -> 202: starts the same
 * chat setup in the main thread (queued behind a turn already running there). Sets
 * User.soulIntroAt when it was still empty.
 */
export const SoulIntroResponse = z.object({ channelId: Id, runId: Id });
export type SoulIntroResponse = z.infer<typeof SoulIntroResponse>;
