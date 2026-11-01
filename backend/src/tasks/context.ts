// The task lines of the system prompt (ToolProvider.instructions). A chat turn learns when to
// start a task and how to link one (L100); a task's own turn gets the task's state and the latest
// outcomes of its approvals, so a resumed session knows what happened while it waited.
import type { Task as TaskRow } from "@prisma/client";
import { markUntrusted } from "../agent/untrusted.ts";
import type { Db } from "../db.ts";
import { clipLine } from "./notices.ts";
import { renderPhrase } from "./phrases.ts";
import { resourcesOf, stepsOf, updatesOf } from "./serialize.ts";
import { storedPayload } from "./thread.ts";

/** M18: the main thread's task list: open, or finished in the last FINISHED_DAYS days, newest first. */
export const MAIN_TASKS_MAX = 15;
export const FINISHED_DAYS = 3;
const UPDATE_MAX = 160;

export async function chatInstructions(db: Db, userId: string, channelId: string, now: Date = new Date()): Promise<string[]> {
  const channel = await db.channel.findFirst({ where: { id: channelId, userId }, select: { isMain: true } });
  const tasks = channel?.isMain
    ? `Your tasks across all channels, open or finished in the last ${FINISHED_DAYS} days, newest first:\n${markUntrusted(JSON.stringify(await mainTasks(db, userId, now)), "task list")}`
    : `Recent tasks in this channel:\n${markUntrusted(JSON.stringify(await db.task.findMany({
      where: { userId, channelId, archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 10,
      select: { id: true, title: true, status: true },
    })), "task list")}`;
  return [
    "Background tasks: when the user asks for something substantial (several steps, research, drafting, work across their apps, anything more than a quick answer), call start_task(title, prompt) instead of doing it in the chat. The task runs in the background as its own session with the same tools while the chat stays free. The server posts the short acknowledgement and the task chip under the user's message, so don't write your own. Answer quick questions directly.",
    "Delegate substantial multi-step work right away: call start_task (or make_artifact for a document, dashboard, web page or slide deck) as your first step, instead of exploring with computer_exec or other tools in the chat first. The task or build does the exploring.",
    "Offer work with propose_tasks (a few tasks you could take on) or propose_task (one task you noticed); the user starts them with a tap.",
    "Link a task in your text as [title](duet://tasks/<id>).",
    "When the user adds to or changes a task that's running or waiting, pass their words on with tell_task. Use resolve_task / delete_task only when the user asked in this turn to mark that task done / delete it.",
    tasks,
  ];
}

/**
 * The user's tasks in every channel (not archived, not scheduled routines) that are open or were
 * finished in the last FINISHED_DAYS days: id, title, status, channel ("main" or its name), the
 * latest update in English (≤ UPDATE_MAX characters) and updatedAt. At most MAIN_TASKS_MAX.
 */
async function mainTasks(db: Db, userId: string, now: Date) {
  const since = new Date(now.getTime() - FINISHED_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.task.findMany({
    where: { userId, archivedAt: null, routine: false, OR: [{ status: { not: "resolved" } }, { updatedAt: { gte: since } }] },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: MAIN_TASKS_MAX,
    include: { channel: { select: { isMain: true, name: true } } },
  });
  return rows.map((row) => {
    const last = updatesOf(row).at(-1);
    return {
      id: row.id, title: row.title, status: row.status, channel: row.channel.isMain ? "main" : row.channel.name,
      lastUpdate: last ? clipLine(renderPhrase(last.text).replace(/\s+/g, " ").trim(), UPDATE_MAX) : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function taskInstructions(db: Db, task: TaskRow): Promise<string[]> {
  const approvals = await db.approval.findMany({
    where: { taskId: task.id, userId: task.userId }, orderBy: { updatedAt: "desc" }, take: 10,
    select: { id: true, kind: true, status: true, preview: true, result: true, updatedAt: true },
  });
  const state = {
    title: task.title, status: task.status, request: task.prompt, description: task.description,
    steps: stepsOf(task).map((s) => ({ text: s.text, state: s.state })),
    updates: updatesOf(task).slice(-20).map((u) => ({ text: renderPhrase(u.text), source: u.source, at: u.at, ...(u.count ? { times: u.count, since: u.since } : {}) })),
    resources: resourcesOf(task),
    approvals: approvals.map(approvalLine),
  };
  return [
    "This turn belongs to a background task's own session, not the chat. Do the work with your tools and keep the task page current:",
    "- set_steps keeps the checklist (planned / current / done); add_update records decisions and progress with the app as source; add_resource attaches what you made or used; update_task keeps a clear title and a one-paragraph description.",
    "- Language: everything you write for the user in this task (messages, questions, steps, updates, resources, titles) is in User.language. The task's request was written by OpenDuet, not the user, and server notes come from the server, so their language doesn't decide yours; only the user's own replies in this task can switch it.",
    "- add_update's source is \"OpenDuet\", \"OpenDuet's computer\" or the display name of a connected app (\"Gmail\"); anything else is shown as \"OpenDuet\".",
    "- An action that needs the user's approval waits on its card: carry on with the steps that don't depend on it, then stop. A later turn brings you the outcome.",
    "- When you can't go on without the user: ask_form when they must choose between options or answer several questions, ask_user for one open question; both end the turn and the task shows Needs input.",
    "- When the work is done, call finish_task (its summary is optional; your last message is the result the user sees in the chat). When you need the user, call ask_user. Don't just stop.",
    `Task state:\n${markUntrusted(JSON.stringify(state), "task state")}`,
  ];
}

/** An approval as the model needs it: what it was about and how it ended; never its arguments. */
function approvalLine(row: { id: string; kind: string; status: string; preview: string; result: string | null; updatedAt: Date }) {
  const preview = storedPayload(row.preview);
  const result = row.result ? storedPayload(row.result) : null;
  const pick = (key: string) => (typeof preview[key] === "string" && preview[key] ? (preview[key] as string) : null);
  return {
    id: row.id, kind: row.kind, status: row.status,
    app: pick("app") ?? pick("merchant"),
    about: pick("subject") ?? pick("title") ?? pick("toolName") ?? pick("description"),
    outcome: result ? (result.ok === true ? "done" : "failed") : null,
    at: row.updatedAt.toISOString(),
  };
}
