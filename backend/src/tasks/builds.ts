// M14 deliverables are grounded (plan M14 交付核查; nanomuse-findings G1; nanomuse-harness-2 N4):
// which Make builds a task's session started and are still running (finish_task refuses while
// one is), and what a build's outcome does to its task: a failed build adds an update to the task
// and moves it back to needs_input; a build that succeeds after the task finished adds the page as
// a resource. A build that settles while the task is still open (working / needs_input) gives the
// task's session a carry-on turn, so make_artifact then finish_task ends without anyone calling
// continueTask (M14a review #1). In-process like ArtifactService's own job maps: a restart fails
// running builds (ArtifactService.recoverAfterRestart), so nothing here needs to survive one. No
// schema change.
import type { Phrase } from "../contract/common.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import en from "../i18n/en.json";
import zh from "../i18n/zh-Hans.json";
import { KeyedLock } from "./lock.ts";
import { mergeUpdate, resourcesOf, toTaskSummary, updatesOf, type Resource } from "./serialize.ts";
import { storedPayload, updatePayload } from "./thread.ts";
import type { Task as TaskRow } from "@prisma/client";
import { deriveNextStep } from "./next-step.ts";
import type { TaskService } from "./service.ts";

/** task id -> artifact id -> builds of it this task started that haven't settled */
const running = new Map<string, Map<string, number>>();
/**
 * M18: task id -> builds that settled but whose outcome (taskBuildOutcome: the failure update or
 * the carry-on turn) hasn't been delivered yet. A task turn ending in that gap isn't done on its own.
 */
const delivering = new Map<string, number>();

export const taskBuilds = {
  /** A build of `artifactId` started from the task's session was queued. */
  started(taskId: string, artifactId: string): void {
    const builds = running.get(taskId) ?? new Map<string, number>();
    builds.set(artifactId, (builds.get(artifactId) ?? 0) + 1);
    running.set(taskId, builds);
  },
  /** One such build settled (finished, failed, never ran); `outcome`: taskBuildOutcome follows for it. */
  settled(taskId: string, artifactId: string, outcome = false): void {
    if (outcome) delivering.set(taskId, (delivering.get(taskId) ?? 0) + 1);
    const builds = running.get(taskId);
    if (!builds) return;
    const left = (builds.get(artifactId) ?? 0) - 1;
    if (left > 0) builds.set(artifactId, left);
    else builds.delete(artifactId);
    if (!builds.size) running.delete(taskId);
  },
  /** Artifact ids this task started that are still building. */
  building(taskId: string): string[] {
    return [...(running.get(taskId)?.keys() ?? [])];
  },
  /** M18: one settled build's outcome was delivered (or never will be). */
  delivered(taskId: string): void {
    const left = (delivering.get(taskId) ?? 0) - 1;
    if (left > 0) delivering.set(taskId, left);
    else delivering.delete(taskId);
  },
  /** M18: settled builds of this task whose outcome is still on its way. */
  undelivered(taskId: string): number {
    return delivering.get(taskId) ?? 0;
  },
};

/** A phrase as text in the user's language (for a param of another phrase). */
export function phraseText(phrase: Phrase, language: string): string {
  if (phrase.text !== undefined) return phrase.text;
  const table = (language === "zh-Hans" ? zh : en).phrases as Record<string, string>;
  const template = table[phrase.key ?? ""] ?? (en.phrases as Record<string, string>)[phrase.key ?? ""];
  if (!template) return phrase.key ?? "";
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const param = phrase.params?.[name];
    if (!param) return match;
    return "value" in param ? String(param.value) : `${param.seconds} s`;
  });
}

export const BUILD_FAILED_KEY = "task.build_failed";

export type BuildOutcome =
  | { ok: false; title: string; reason: Phrase }
  | { ok: true; title: string; artifactType: string };

/** One settled build of a task, as its carry-on turn reports it. */
export type SettledBuild = { artifactId: string } & BuildOutcome;

type OutcomeInput = { userId: string; taskId: string } & SettledBuild;

/** Carries a task's session on after its builds settled (TaskService.carryOnAfterBuild). */
export type BuildCarryOn = (taskId: string, builds: SettledBuild[]) => Promise<void>;

/** M14a review #1: the carry-on of the TaskService that shares this run host with ArtifactService. */
const carriers = new WeakMap<object, BuildCarryOn>();
const mutations = new WeakMap<object, TaskService["mutate"]>();
/** task id -> builds that settled while another build of the task was still running */
const parked = new Map<string, SettledBuild[]>();

/**
 * TaskService registers its carry-on for its run host. ArtifactService passes the same host in its
 * deps, so a settled build finds the task runner without a wiring change in index.ts.
 */
export function onBuildSettled(runs: object, carryOn: BuildCarryOn, mutate?: TaskService["mutate"]): void {
  carriers.set(runs, carryOn);
  if (mutate) mutations.set(runs, mutate);
}

/**
 * The carry-on turn's request (server-written, model-facing English, never shown in the app): what
 * was built (finish the task now) or what failed and why (tell the user, or try again).
 */
export function buildsNote(builds: SettledBuild[]): string {
  const lines = builds.map((b) => {
    const page = `${JSON.stringify(b.title)} (duet://artifacts/${b.artifactId})`;
    return b.ok ? `- ${page} is built; its card is in this task's thread.` : `- ${page} couldn't be built: ${phraseText(b.reason, "en")}`;
  });
  const failed = builds.some((b) => !b.ok);
  return [
    `[Server note, not from the user] ${builds.length === 1 ? "The Make build this task started has settled" : "The Make builds this task started have settled"}:`,
    ...lines,
    failed
      ? "Tell the user in User.language what couldn't be built and why, then try again (make_artifact or edit_artifact) if that's likely to help, or call ask_user. Don't call finish_task until the task's deliverables are built."
      : "If that was the last of the work, call finish_task now with a short summary; otherwise carry on with what's left.",
  ].join("\n");
}

/**
 * A build the task's session started settled. Failed: the task gets the update "<title> couldn't be
 * built: <reason>" and goes back to needs_input (unless the user resolved it). Succeeded after the
 * task already finished (ready for review / resolved): the page is added as a resource. Then (M14a
 * review #1), once no other build of the task is running and the task was working or needs_input,
 * its session gets one carry-on turn for the builds that settled (see TaskService.carryOnAfterBuild).
 * Never throws.
 */
export async function taskBuildOutcome(deps: { db: Db; events: EventBus; runs?: object; now?: () => Date }, input: OutcomeInput): Promise<void> {
  let before: string | null = null;
  try {
    try {
      before = await applyOutcome(deps, input);
    } catch (error) {
      log.warn("task build outcome failed", { taskId: input.taskId, error: { name: (error as Error).name } });
    }
    await carryOn(deps, input, before);
  } finally {
    taskBuilds.delivered(input.taskId);
  }
}

/** The outcome's row change; returns the task's status before it (null: no such task). */
async function applyOutcome(deps: { db: Db; events: EventBus; runs?: object; now?: () => Date }, input: OutcomeInput): Promise<string | null> {
  const { db, events } = deps;
  let before: string | null = null;
  const change = async (current: TaskRow) => {
    if (current.userId !== input.userId) return null;
    before = current.status;
    let patch: Partial<Pick<TaskRow, "status" | "updates" | "resources">> | null = null;
    if (!input.ok) {
      if (current.status === "resolved") return null;
      const user = await db.user.findUnique({ where: { id: input.userId }, select: { language: true } });
      const update = {
        text: { key: BUILD_FAILED_KEY, params: { title: { type: "text" as const, value: input.title }, reason: { type: "text" as const, value: phraseText(input.reason, user?.language ?? "en") } } },
        source: "OpenDuet",
        at: (deps.now ?? (() => new Date()))().toISOString(),
      };
      patch = { status: "needs_input", updates: JSON.stringify(mergeUpdate(updatesOf(current), update)) };
    } else if (current.status === "ready_for_review" || current.status === "resolved") {
      const link = `duet://artifacts/${input.artifactId}`;
      const list = resourcesOf(current);
      if (list.some(r => r.link === link)) return null;
      const resource: Resource = { title: input.title, type: "artifact", link, app: null };
      patch = { resources: JSON.stringify([...list, resource]) };
    }
    return patch;
  };
  const mutate = deps.runs ? mutations.get(deps.runs) : undefined;
  if (mutate) await mutate(input.taskId, change);
  else await KeyedLock.tasks.run(input.taskId, async () => {
    // Compatibility for standalone callers without a TaskService. The production registration
    // can pass mutate as onBuildSettled's third argument; both paths derive the same nextStep.
    const current = await db.task.findFirst({ where: { id: input.taskId, userId: input.userId } });
    if (!current) return;
    const patch = await change(current);
    if (!patch) return;
    const next = await deriveNextStep(db, { row: { ...current, ...patch }, before: current, now: (deps.now ?? (() => new Date()))() });
    const row = await db.task.update({ where: { id: current.id }, data: { ...patch, nextStep: next ? JSON.stringify(next) : null } });
    await taskChanged(db, events, row);
  });
  return before;
}

/**
 * M14a review #1: once per settled build, and only when it was the task's last running build, the
 * task's session carries on with every build that settled meanwhile. Only a task that was working or
 * needs_input (before this outcome) carries on: one already ready for review / resolved got the
 * resource or the failure update above and waits for the user. Never throws.
 */
async function carryOn(deps: { runs?: object }, input: OutcomeInput, before: string | null): Promise<void> {
  const { taskId } = input;
  const build: SettledBuild = input.ok
    ? { artifactId: input.artifactId, ok: true, title: input.title, artifactType: input.artifactType }
    : { artifactId: input.artifactId, ok: false, title: input.title, reason: input.reason };
  const settled = [...(parked.get(taskId) ?? []), build];
  if (taskBuilds.building(taskId).length) {
    parked.set(taskId, settled);
    return;
  }
  parked.delete(taskId);
  const carry = deps.runs ? carriers.get(deps.runs) : undefined;
  if (!carry || (before !== "working" && before !== "needs_input")) return;
  try {
    await carry(taskId, settled);
  } catch (error) {
    log.warn("task carry-on after a build failed", { taskId, error: { name: (error as Error).name } });
  }
}

/** The `task` event, and the channel's task_spawn chip (payload + `message` event) kept in sync. */
export async function taskChanged(db: Db, events: EventBus, row: TaskRow): Promise<void> {
  const summary = toTaskSummary(row);
  if (!summary) return;
  await events.emit(row.userId, row.channelId, "task", { task: summary });
  if (!row.spawnMessageId) return;
  const chip = await db.message.findFirst({ where: { id: row.spawnMessageId, userId: row.userId, kind: "task_spawn" } });
  if (!chip) return;
  const anchor = storedPayload(chip.payload).anchorMessageId;
  try {
    await updatePayload(db, events, row.userId, chip.id, "task_spawn", { task: summary, anchorMessageId: typeof anchor === "string" ? anchor : null });
  } catch (error) {
    log.warn("task spawn chip could not be refreshed", { taskId: row.id, error: { name: (error as Error).name } });
  }
}
