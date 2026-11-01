// M22 (#20, #21): what a task waits on the user for (TaskSummary.nextStep) and why its last run
// failed (TaskSummary.failure). The server derives nextStep from the row and the task's thread on
// every change of the row (TaskService.apply), in this order: a failure -> retry; the question
// The assistant asked (ask_user, a question it ended on, open quick replies) -> answer; an open form ->
// form; a pending approval -> approve; a pending sign-in card -> sign_in; an open connection
// request -> connect; ready_for_review -> review; reopened -> reply; else null. `messageId` is the
// card in the task's thread (null for review / retry / reply). Routines (their runs post in the
// channel), archived and resolved tasks wait on nothing.
import type { Task as TaskRow } from "@prisma/client";
import { ApprovalPreview } from "../contract/approvals.ts";
import type { Phrase } from "../contract/common.ts";
import { TaskFailure, TaskNextStep } from "../contract/m22.ts";
import type { Db } from "../db.ts";
import { clipLine, QUESTION_MAX } from "./notices.ts";
import { parseObject, updatesOf } from "./serialize.ts";
import { storedPayload } from "./thread.ts";

/** What the code that changes the row knows and the row doesn't: the assistant asked (answer), the user reopened it (reply). */
export interface NextHint { ask?: { question: string; messageId: string | null }; reopened?: boolean }

export const REOPENED_KEY = "task.reopened";
/** Failures a second run the same way can't fix: no model, its setup, a refused key, no credit, a too long context. */
const NOT_RETRYABLE: ReadonlySet<string> = new Set([
  "system.no_model", "system.model_config", "system.model_auth", "system.model_quota", "system.model_context_length",
]);
const CARD_KINDS = ["form", "sign_in", "connection_request", "quick_replies"] as const;

/** The failure column for a failed turn: the same phrase as its update row. */
export function failureFor(reason: Phrase, at: Date): TaskFailure {
  return { reason, retryable: !NOT_RETRYABLE.has(reason.key ?? ""), at: at.toISOString() };
}

export const failureOf = (row: TaskRow): TaskFailure | null => parseObject(row.failure, TaskFailure, { taskId: row.id, column: "failure" });
export const nextStepOf = (row: TaskRow): TaskNextStep | null => parseObject(row.nextStep, TaskNextStep, { taskId: row.id, column: "nextStep" });

function step(kind: TaskNextStep["kind"], params: Record<string, string> | null, messageId: string | null): TaskNextStep | null {
  const text: Phrase = params
    ? { key: `task.next.${kind}`, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { type: "text" as const, value: v }])) }
    : { key: `task.next.${kind}` };
  const parsed = TaskNextStep.safeParse({ kind, text, messageId });
  return parsed.success ? parsed.data : null;
}

/**
 * The task's next step after a change: `row` as it becomes, `before` as it was (an `answer` or
 * `reply` stays while the task keeps waiting and the user hasn't written since).
 */
export async function deriveNextStep(db: Db, input: { row: TaskRow; before: TaskRow | null; hint?: NextHint; now: Date }): Promise<TaskNextStep | null> {
  const { row, before, hint = {}, now } = input;
  if (row.routine || row.archivedAt || row.status === "resolved") return null;
  if (failureOf(row)) return step("retry", null, null);
  const waiting = row.status === "needs_input";
  const question = hint.ask?.question.trim();
  if (waiting && question) return step("answer", { question: clipLine(question, QUESTION_MAX) }, hint.ask?.messageId ?? null);
  const kept = waiting && before?.status === "needs_input" ? nextStepOf(before) : null;
  if (kept?.kind === "answer" && !(await answeredSince(db, row, kept.messageId))) return kept;
  const card = await openCard(db, row, now);
  if (card) return card;
  if (row.status === "ready_for_review") return step("review", null, null);
  if (waiting && (hint.reopened || kept?.kind === "reply" || updatesOf(row).at(-1)?.text.key === REOPENED_KEY)) return step("reply", null, null);
  return null;
}

/** The user wrote in the task after the question (or the question is gone). */
async function answeredSince(db: Db, row: TaskRow, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const asked = await db.message.findFirst({ where: { id: messageId, taskId: row.id }, select: { createdAt: true } });
  if (!asked) return true;
  return (await db.message.count({ where: { taskId: row.id, role: "user", createdAt: { gt: asked.createdAt } } })) > 0;
}

/** The open card of the task's thread the user has to act on (newest of each kind), by the order above. */
async function openCard(db: Db, row: TaskRow, now: Date): Promise<TaskNextStep | null> {
  const cards = await db.message.findMany({
    where: { taskId: row.id, userId: row.userId, role: "assistant", kind: { in: [...CARD_KINDS] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: { id: true, kind: true, text: true, payload: true, createdAt: true },
  });
  const lastUser = cards.length
    ? await db.message.findFirst({ where: { taskId: row.id, role: "user" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } })
    : null;
  const found = new Map<string, TaskNextStep | null>();
  for (const card of cards) {
    if (found.has(card.kind)) continue;
    const payload = storedPayload(card.payload);
    const str = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
    if (card.kind === "form" && payload.state === "open" && str("title")) found.set("form", step("form", { title: str("title") }, card.id));
    else if (card.kind === "sign_in" && payload.state === "pending" && str("domain")) found.set("sign_in", step("sign_in", { site: str("domain") }, card.id));
    else if (card.kind === "connection_request" && payload.state === "open" && str("name")) found.set("connection_request", step("connect", { app: str("name") }, card.id));
    else if (card.kind === "quick_replies" && payload.chosen == null && card.text.trim() && !(lastUser && lastUser.createdAt > card.createdAt)) {
      found.set("quick_replies", step("answer", { question: clipLine(card.text.trim(), QUESTION_MAX) }, card.id));
    }
  }
  const approval = await db.approval.findFirst({
    where: { taskId: row.id, userId: row.userId, status: "pending", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { preview: true, toolSlug: true, messageId: true },
  });
  const approve = approval ? step("approve", { summary: approvalSummary(approval.preview, approval.toolSlug) }, approval.messageId) : null;
  return found.get("quick_replies") ?? found.get("form") ?? approve ?? found.get("sign_in") ?? found.get("connection_request") ?? null;
}

/** Shared by task nextStep and Needs you; same trimming, fallback and length in both places. */
export function approvalSummary(raw: string, toolSlug: string): string {
  let preview: ReturnType<typeof ApprovalPreview.parse> | null = null;
  try {
    const parsed = ApprovalPreview.safeParse(JSON.parse(raw));
    if (parsed.success) preview = parsed.data;
  } catch { /* unreadable preview: use the tool name */ }
  let summary = "";
  switch (preview?.kind) {
    case "email": summary = preview.subject.trim() || preview.to.join(", "); break;
    case "payment": summary = preview.description.trim() || preview.merchant; break;
    case "sign": case "delete": summary = preview.title; break;
    case "action": summary = preview.toolName; break;
  }
  return clipLine(summary.trim() || humanSlug(toolSlug), 120);
}

const humanSlug = (slug: string) => slug.toLowerCase().replace(/_+/g, " ").trim() || "action";
