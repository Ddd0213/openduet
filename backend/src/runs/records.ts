// Run records (M8) as the contract's RunSummary / RunDetail, and the title a run gets when it is
// created (Run.title): chat = the user's message (first 120 chars), task = the task's title,
// brief / checkin / scan / build = the key run.title.<kind>.
import type { Run as RunRow, RunStep as StepRow } from "@prisma/client";
import type { z } from "zod";
import type { RunKind } from "../agent/types.ts";
import { Phrase } from "../contract/common.ts";
import { RunDetail, RunKind as RunKindSchema, RunStatus, RunStep, RunSummary } from "../contract/runs.ts";
import type { Db } from "../db.ts";

export const CHAT_TITLE_MAX = 120;
/** GET /api/runs/:id returns at most this many steps (the newest ones). */
export const STEP_LIMIT = 300;

/** A chat run's title: the user's message, whitespace collapsed, its first 120 characters (or the first file's name). */
export function chatTitle(text: string, fileName?: string | null): Phrase {
  const flat = text.replace(/\s+/g, " ").trim() || (fileName ?? "").trim();
  return { text: [...flat].slice(0, CHAT_TITLE_MAX).join("") };
}

/**
 * The title of a run being created. A task's runs take its title; a chat turn that answers no
 * stored message (a carry-on after Take over) takes the thread's latest user message.
 */
export async function runTitle(db: Db, run: { userId: string; kind: RunKind; channelId: string | null; taskId: string | null }): Promise<Phrase> {
  if (run.taskId) {
    const task = await db.task.findFirst({ where: { id: run.taskId, userId: run.userId }, select: { title: true } });
    if (task) return { text: task.title };
  }
  if (run.kind === "chat" || run.kind === "task") {
    if (!run.channelId) return { text: "" };
    const last = await db.message.findFirst({ where: { userId: run.userId, channelId: run.channelId, taskId: run.taskId, role: "user" }, orderBy: { createdAt: "desc" }, select: { text: true } });
    return chatTitle(last?.text ?? "");
  }
  return { key: `run.title.${run.kind}` };
}

function phraseOf(raw: string | null): Phrase | null {
  if (!raw) return null;
  try {
    const parsed = Phrase.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stored statuses outside the contract: a run a restart cancelled shows as skipped. */
function statusOf(status: string): z.infer<typeof RunStatus> {
  if (status === "cancelled") return "skipped";
  const parsed = RunStatus.safeParse(status);
  return parsed.success ? parsed.data : "failed";
}

export function toRunStep(row: StepRow): z.infer<typeof RunStep> | null {
  const parsed = RunStep.safeParse({
    id: row.id, index: row.index, kind: row.kind, tool: row.tool, app: row.app || null,
    title: phraseOf(row.title) ?? { key: "run.step.tool" }, detail: row.detail, status: row.status,
    input: row.input, output: row.output, approvalId: row.approvalId,
    startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
  });
  return parsed.success ? parsed.data : null;
}

export type ListedRun = RunRow & { _count: { steps: number }; steps: Pick<StepRow, "title" | "detail">[] };

/** What GET /api/runs selects per run: its step count and its latest step. */
export const RUN_INCLUDE = {
  _count: { select: { steps: true } },
  steps: { orderBy: { index: "desc" as const }, take: 1, select: { title: true, detail: true } },
};

/**
 * Rows -> RunSummary, in order. Task runs show the task's current title; runs from before M8
 * (no stored title) get one from their task, their kind, or the user message they answered.
 */
export async function toRunSummaries(db: Db, rows: ListedRun[]): Promise<z.infer<typeof RunSummary>[]> {
  const taskIds = [...new Set(rows.flatMap((r) => (r.taskId ? [r.taskId] : [])))];
  const tasks = taskIds.length ? await db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }) : [];
  const taskTitles = new Map(tasks.map((t) => [t.id, t.title]));
  const out: z.infer<typeof RunSummary>[] = [];
  for (const row of rows) {
    const kind = RunKindSchema.safeParse(row.kind);
    if (!kind.success) continue;
    const taskTitle = row.taskId ? taskTitles.get(row.taskId) : undefined;
    const title = taskTitle !== undefined ? { text: taskTitle } : phraseOf(row.title) ?? (await legacyTitle(db, row, kind.data));
    const latest = row.steps[0];
    const parsed = RunSummary.safeParse({
      id: row.id, kind: kind.data, channelId: row.channelId, taskId: row.taskId, title, status: statusOf(row.status),
      stepCount: row._count.steps, latest: latest ? { title: phraseOf(latest.title) ?? { key: "run.step.tool" }, detail: latest.detail } : null,
      error: phraseOf(row.error), createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** A run stored before titles: chat = the user's message it answered (created just before it). */
async function legacyTitle(db: Db, row: RunRow, kind: RunKind): Promise<Phrase> {
  if (kind !== "chat" && kind !== "task") return { key: `run.title.${kind}` };
  if (!row.channelId) return { text: "" };
  const message = await db.message.findFirst({
    where: { userId: row.userId, channelId: row.channelId, taskId: row.taskId, role: "user", createdAt: { lte: new Date(row.createdAt.getTime() + 1000) } },
    orderBy: { createdAt: "desc" }, select: { text: true },
  });
  return chatTitle(message?.text ?? "");
}

/** One run with its steps (oldest first, the newest STEP_LIMIT). */
export async function toRunDetail(db: Db, row: ListedRun): Promise<z.infer<typeof RunDetail> | null> {
  const [summary] = await toRunSummaries(db, [row]);
  if (!summary) return null;
  const rows = await db.runStep.findMany({ where: { runId: row.id }, orderBy: { index: "desc" }, take: STEP_LIMIT });
  const steps = rows.reverse().flatMap((s) => {
    const step = toRunStep(s);
    return step ? [step] : [];
  });
  return RunDetail.parse({ ...summary, steps });
}
