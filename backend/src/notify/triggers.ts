// Which stored events become notifications (L78): a task reaching Ready for review / Needs input
// (once per transition), a new pending approval (version 1, once), the assistant's one-off alert
// cards (once per message) and (M18) the result of a task that finished on its own (resolved;
// once per message, opening the chat it's in). The brief (scheduler) and reminders call notify() directly.
//
// M21:
// - "Once per transition" for tasks is Task.lastNotifiedStatus (claimed with a conditional update),
//   not an in-memory map: after a restart a needs_input task that is re-emitted (pinned, renamed)
//   isn't pushed again. A status that doesn't notify clears it, so the next transition pushes.
//   follow-ups.ts writes "<status>:reminded" when it reminded once more.
// - collapseId per thing (task-<id>, approval-<id>, message-<id>) and the message anchor in the
//   deep link (duet://channels/<id>?message=<messageId>; a task's card: duet://tasks/<id>?message=).
// - Task pushes, alert cards and task results follow the user's quiet hours (quiet: true);
//   approvals don't.
//
// M29: a failed task's push is notify.task_failed, one skipped at the usage limit
// notify.usage_limit (not quiet); a human check's alert card is pushed by the computer, not here.
// What a run leaves when it ends (replies, forms, failures) is run-end.ts.
import type { Approval } from "../contract/approvals.ts";
import type { DuetEvent } from "../contract/events.ts";
import type { Phrase } from "../contract/common.ts";
import type { Db } from "../db.ts";
import { TASK_PHRASE } from "../tasks/phrases.ts";
import { NOTIFY_APPROVAL, NOTIFY_APPROVAL_GENERIC, NOTIFY_TASK_DONE, NOTIFY_TASK_FAILED, NOTIFY_TASK_NEEDS_INPUT, NOTIFY_TASK_READY, NOTIFY_USAGE_LIMIT, textParam } from "./phrases.ts";
import type { NotifyInput } from "./notifier.ts";

/** Insertion-ordered set that forgets its oldest entries past `limit`. */
export class Recent {
  private readonly items = new Set<string>();
  constructor(private readonly limit = 5000) {}
  /** true the first time an id is seen */
  add(id: string): boolean {
    if (this.items.has(id)) return false;
    this.items.add(id);
    if (this.items.size > this.limit) this.items.delete(this.items.values().next().value as string);
    return true;
  }
}

/** Task statuses that push ("needs you"). */
export const NOTIFYING_STATUSES = ["ready_for_review", "needs_input"] as const;
export type NotifyingStatus = (typeof NOTIFYING_STATUSES)[number];
export const isNotifying = (status: string): status is NotifyingStatus => (NOTIFYING_STATUSES as readonly string[]).includes(status);
/** lastNotifiedStatus once the follow-up went out too (follow-ups.ts). */
export const remindedMark = (status: string) => `${status}:reminded`;

export const collapseIdFor = {
  task: (id: string) => `task-${id}`,
  approval: (id: string) => `approval-${id}`,
  message: (id: string) => `message-${id}`,
  /** M29: a Make build's ready / failed push (it has no message of its own) */
  artifact: (id: string) => `artifact-${id}`,
};

/** duet://channels/<id> or duet://tasks/<id>, with the message to scroll to (M21; a free duet:// string). */
export function deepLink(kind: "channels" | "tasks", id: string, messageId?: string | null): string {
  const base = `duet://${kind}/${encodeURIComponent(id)}`;
  return messageId ? `${base}?message=${encodeURIComponent(messageId)}` : base;
}

/** M29: `failed` = a needs_input task whose last run failed (Task.failure set): notify.task_failed instead. */
export function taskBody(status: NotifyingStatus, title: string, failed = false): Phrase {
  const key = status === "ready_for_review" ? NOTIFY_TASK_READY : failed ? NOTIFY_TASK_FAILED : NOTIFY_TASK_NEEDS_INPUT;
  return { key, params: { title: textParam(title) } };
}

/** M29: the task waits because its turn was skipped at the usage limit (tasks/service.ts beforeTurn). */
const pausedAtLimit = (task: { status: string; failure: unknown; latestUpdate: { text: Phrase } | null }) =>
  task.status === "needs_input" && !task.failure && task.latestUpdate?.text.key === TASK_PHRASE.pausedUsageLimit;

function approvalTitle(approval: Approval): string | null {
  const p = approval.preview;
  switch (p.kind) {
    case "email": return p.subject.trim() || p.to.join(", ") || null;
    case "payment": return p.merchant.trim() || null;
    case "sign":
    case "delete": return p.title.trim() || null;
    case "action": return p.toolName.trim() || null;
  }
}

export function approvalBody(approval: Approval): Phrase {
  const title = approvalTitle(approval);
  return title ? { key: NOTIFY_APPROVAL, params: { title: { type: "text", value: title } } } : { key: NOTIFY_APPROVAL_GENERIC };
}

/** Where an approval's push opens: the task (its session holds the card), else the chat with the card. */
export async function approvalTarget(db: Db, userId: string, approval: Approval, fallbackChannelId: string | null): Promise<{ channelId: string | null; route: string } | null> {
  if (approval.taskId) {
    const task = await db.task.findFirst({ where: { id: approval.taskId, userId }, select: { channelId: true } });
    return { channelId: task?.channelId ?? fallbackChannelId, route: deepLink("tasks", approval.taskId, approval.messageId) };
  }
  const message = approval.messageId ? await db.message.findFirst({ where: { id: approval.messageId, userId }, select: { channelId: true } }) : null;
  const channelId = message?.channelId ?? fallbackChannelId ?? (await db.channel.findFirst({ where: { userId, isMain: true }, select: { id: true } }))?.id ?? null;
  if (!channelId) return null;
  return { channelId, route: deepLink("channels", channelId, message ? approval.messageId : null) };
}

/** M18: a resolved result pushes only while it's this new (a later event for it is a reaction or an edit). */
const RESULT_FRESH_MS = 2 * 60 * 1000;

export class NotificationTriggers {
  private readonly approvals = new Recent();
  private readonly alerts = new Recent();

  constructor(private readonly db: Db) {}

  async fromEvent(userId: string, event: DuetEvent): Promise<NotifyInput | null> {
    switch (event.type) {
      case "task": {
        const { task } = event.payload;
        if (task.archived || !isNotifying(task.status)) {
          // Left "needs you": the next time it gets there pushes again. Only while the row still has
          // this status, so a late event never clears a newer claim.
          await this.db.$executeRaw`UPDATE "Task" SET "lastNotifiedStatus" = NULL WHERE "id" = ${task.id} AND "userId" = ${userId} AND "status" = ${task.status} AND "lastNotifiedStatus" IS NOT NULL`;
          return null;
        }
        // Claim the push: only if the row is (still) in this status and it wasn't pushed for it yet.
        // Raw SQL so Task.updatedAt (the list order) doesn't move for this bookkeeping.
        const claimed = await this.db.$executeRaw`UPDATE "Task" SET "lastNotifiedStatus" = ${task.status} WHERE "id" = ${task.id} AND "userId" = ${userId} AND "status" = ${task.status} AND "archivedAt" IS NULL AND ("lastNotifiedStatus" IS NULL OR "lastNotifiedStatus" NOT IN (${task.status}, ${remindedMark(task.status)}))`;
        if (claimed === 0) return null;
        // M29: one push for the transition, the most specific one: a turn skipped at the usage
        // limit says so (and rings, like every usage-limit stop); a failed run says it failed.
        const limited = pausedAtLimit(task);
        return {
          userId, channelId: task.channelId, body: limited ? { key: NOTIFY_USAGE_LIMIT } : taskBody(task.status, task.title, task.failure !== null),
          route: deepLink("tasks", task.id), collapseId: collapseIdFor.task(task.id), quiet: !limited,
        };
      }
      case "approval": {
        const { approval } = event.payload;
        if (approval.status !== "pending" || approval.version !== 1 || !this.approvals.add(approval.id)) return null;
        const target = await approvalTarget(this.db, userId, approval, event.channelId);
        if (!target) return null;
        // Approvals ignore quiet hours: the work is blocked until the user answers.
        return { userId, channelId: target.channelId, body: approvalBody(approval), route: target.route, collapseId: collapseIdFor.approval(approval.id) };
      }
      case "message": {
        const { message } = event.payload;
        if (message.role === "user") return null;
        if (message.kind === "text") {
          // M18: ready_for_review already pushed from its task event; resolved has no task push.
          const result = message.payload.taskResult;
          // Only a freshly posted result: a reaction re-emits the message (and the dedup set is in memory).
          if (!result || result.status !== "resolved" || Date.now() - Date.parse(message.createdAt) > RESULT_FRESH_MS || !this.alerts.add(message.id)) return null;
          return {
            userId, channelId: message.channelId, body: { key: NOTIFY_TASK_DONE, params: { title: { type: "text", value: result.title } } },
            route: deepLink("channels", message.channelId, message.id), collapseId: collapseIdFor.message(message.id), quiet: true,
          };
        }
        if (message.kind !== "alert") return null;
        // M29: a human check's card (open_browser) is pushed once by the computer itself (it opens
        // the live screen, computer/service.ts humanCheck), with this card's collapse id.
        if (message.payload.action.type === "open_browser" || !this.alerts.add(message.id)) return null;
        const { title, body } = message.payload;
        const text = body.key !== undefined || (body.text ?? "").trim() !== "" ? body : title;
        const route = message.taskId ? deepLink("tasks", message.taskId, message.id) : deepLink("channels", message.channelId, message.id);
        return { userId, channelId: message.channelId, body: text, route, collapseId: collapseIdFor.message(message.id), quiet: true };
      }
      default:
        return null;
    }
  }
}
