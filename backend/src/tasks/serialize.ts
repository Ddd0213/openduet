// Task rows -> contract shapes (TaskSummary / TaskDetail) and the JSON columns they hold. A bad
// JSON column or a single malformed item is dropped and logged, never fails a whole list.
import type { Task as TaskRow } from "@prisma/client";
import { z } from "zod";
import { Schedule } from "../contract/common.ts";
import { RoutinePausedBy, TaskFailure, TaskNextStep } from "../contract/m22.ts";
import { Routine, TaskDetail, TaskResource, TaskStatus, TaskStep, TaskSummary, TaskUpdate } from "../contract/tasks.ts";
import { log } from "../log.ts";

export type Step = z.infer<typeof TaskStep>;
export type Update = z.infer<typeof TaskUpdate>;
export type Resource = z.infer<typeof TaskResource>;

/** Parses a JSON array column, keeping the items that match the schema. */
export function parseList<S extends z.ZodTypeAny>(raw: string, schema: S, ctx: { taskId: string; column: string }): z.output<S>[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    log.warn("task column is not JSON", ctx);
    return [];
  }
  if (!Array.isArray(value)) {
    log.warn("task column is not a list", ctx);
    return [];
  }
  const out: z.output<S>[] = [];
  for (const item of value) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else log.warn("task column item does not match the contract", ctx);
  }
  return out;
}

export const stepsOf = (row: TaskRow): Step[] => parseList(row.steps, TaskStep, { taskId: row.id, column: "steps" });
export const updatesOf = (row: TaskRow): Update[] => parseList(row.updates, TaskUpdate, { taskId: row.id, column: "updates" });

/** Same server-built row (a phrase key with the same params and source)? Model-written text is
 * never merged: two equal lines from the assistant are two updates. */
function sameServerRow(a: Update, b: Update): boolean {
  if (!a.text.key || a.text.key !== b.text.key || a.text.text !== undefined || b.text.text !== undefined) return false;
  return a.source === b.source && JSON.stringify(a.text.params ?? {}) === JSON.stringify(b.text.params ?? {});
}

/**
 * M16: the list with `update` added. The same server-built row right after itself (a retry that
 * failed the same way, "Can't reach the model ×10") becomes one row with a count, the first
 * time in `since` and the latest in `at`; anything in between keeps them apart.
 */
export function mergeUpdate(list: Update[], update: Update): Update[] {
  const last = list.at(-1);
  if (!last || !sameServerRow(last, update)) return [...list, update];
  const merged: Update = { ...update, count: (last.count ?? 1) + (update.count ?? 1), since: last.since ?? last.at };
  return [...list.slice(0, -1), merged];
}
export const resourcesOf = (row: TaskRow): Resource[] => parseList(row.resources, TaskResource, { taskId: row.id, column: "resources" });

function scheduleOf(row: TaskRow): z.infer<typeof Schedule> | null {
  if (!row.schedule) return null;
  try {
    const parsed = Schedule.safeParse(JSON.parse(row.schedule));
    if (parsed.success) return parsed.data;
  } catch { /* fall through */ }
  log.warn("task schedule does not match the contract", { taskId: row.id });
  return null;
}

/** M22: a JSON object column (nextStep, failure): null when empty, not JSON or off-contract (logged). */
export function parseObject<S extends z.ZodTypeAny>(raw: string | null, schema: S, ctx: { taskId: string; column: string }): z.output<S> | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* fall through */ }
  log.warn("task column does not match the contract", ctx);
  return null;
}

/** M9: a routine's state (TaskSummary.routine); null for every other task. */
function routineOf(row: TaskRow): z.infer<typeof Routine> | null {
  if (!row.routine) return null;
  const last = Routine.shape.lastRunStatus.safeParse(row.lastRunStatus);
  return {
    paused: row.routinePaused, quiet: row.routineQuiet,
    nextRunAt: row.routinePaused ? null : (row.nextRunAt?.toISOString() ?? null),
    lastRunAt: row.lastRunAt?.toISOString() ?? null, lastRunStatus: last.success ? last.data : null,
    // M22: the fatigue rule's count and who paused it
    failStreak: row.routineFailStreak,
    pausedBy: row.routinePaused ? (RoutinePausedBy.safeParse(row.routinePausedBy).data ?? "user") : null,
  };
}

function summaryFields(row: TaskRow, updates: Update[]) {
  return {
    id: row.id, channelId: row.channelId, title: row.title, status: row.status,
    source: row.source === "proactive" ? "proactive" : "user",
    // M16: counted as the app shows them (stored rows from before the merge are merged here).
    latestUpdate: updates.at(-1) ?? null, updateCount: updates.reduce(mergeUpdate, [] as Update[]).length, schedule: scheduleOf(row),
    archived: row.archivedAt !== null, pinned: row.pinnedAt !== null, routine: routineOf(row),
    // M22: what the task waits on the user for, why it failed, when it was resolved
    nextStep: parseObject(row.nextStep, TaskNextStep, { taskId: row.id, column: "nextStep" }),
    failure: parseObject(row.failure, TaskFailure, { taskId: row.id, column: "failure" }),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    app: row.sourceApp,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** null when the row itself is unusable (e.g. an unknown status): lists skip it. */
export function toTaskSummary(row: TaskRow): TaskSummary | null {
  if (!TaskStatus.safeParse(row.status).success) {
    log.warn("task status does not match the contract", { taskId: row.id });
    return null;
  }
  const parsed = TaskSummary.safeParse(summaryFields(row, updatesOf(row)));
  if (!parsed.success) {
    log.warn("task does not match the contract", { taskId: row.id });
    return null;
  }
  return parsed.data;
}

export function toTaskSummaries(rows: TaskRow[]): TaskSummary[] {
  return rows.flatMap((row) => toTaskSummary(row) ?? []);
}

/** Throws when the row can't be shown at all (a single task's route answers 500, not a guess). */
export function toTaskDetail(row: TaskRow): TaskDetail {
  const updates = updatesOf(row);
  return TaskDetail.parse({
    ...summaryFields(row, updates),
    prompt: row.prompt, description: row.description, noticedAt: row.noticedAt?.toISOString() ?? null,
    steps: stepsOf(row), updates, resources: resourcesOf(row),
  });
}

/** The first non-empty line of a prompt, at most 80 characters: the title until the assistant renames it. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const chars = [...line];
  return chars.length <= 80 ? line : `${chars.slice(0, 79).join("").trimEnd()}…`;
}
