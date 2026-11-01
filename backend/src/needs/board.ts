// M22 (show_tasks; plan §5 「任务列表分类」 last item): the task overview card built from real data.
// Groups: Needs you (needsYou(), so its number is the badge's), Working (status working, not
// already in Needs you), Suggested (open Up next items), Done (resolved in the last
// RESOLVED_KEEP_DAYS days, as GET /api/tasks keeps them). Each group has at most 5 rows and its
// real total as `count`; an empty one gets one short line. Every string is rendered here in the
// user's language (User.language), since a card's text isn't a Phrase. Row routes:
// duet://tasks/<id>, duet://suggestions/<id> (tapping starts it), and a card outside any task opens
// its channel at the card (duet://channels/<id>?message=<id>, the Needs you route).
import type { z } from "zod";
import { RESOLVED_KEEP_DAYS } from "../contract/m22.ts";
import type { Phrase } from "../contract/common.ts";
import { CardMessage } from "../contract/messages.ts";
import type { NeedsYou } from "../contract/tasks.ts";
import type { Db } from "../db.ts";
import { renderPhrase } from "../notify/phrases.ts";
import { clipLine } from "../tasks/notices.ts";
import { toTaskSummary } from "../tasks/serialize.ts";
import { needsYou } from "./service.ts";

export const GROUP_ROWS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_TITLE_MAX = 160;
const ROW_DETAIL_MAX = 200;

type CardPayload = z.input<typeof CardMessage.shape.payload>;
type GroupBlock = Extract<CardPayload["blocks"][number], { type: "group" }>;
type Row = GroupBlock["rows"][number];

export interface BoardCounts { needsYou: number; working: number; suggested: number; done: number }
export interface Board { payload: CardPayload; counts: BoardCounts; needs: NeedsYou }

export interface BoardScope {
  userId: string;
  /** only this channel's tasks, cards and suggestions; null = everything */
  channelId: string | null;
  language: string;
  timezone: string;
  now: Date;
}

export async function buildTaskBoard(db: Db, scope: BoardScope): Promise<Board> {
  const { userId, channelId, language, timezone, now } = scope;
  // A server phrase in the user's language; a model-written one ({text}) as written.
  const render = (phrase: Phrase) => renderPhrase(phrase, language, timezone);
  const say = (key: string, params?: Phrase["params"]) => render(params ? { key, params } : { key });
  const inScope = channelId ? { channelId } : {};

  const needs = await needsYou(db, userId, { channelId, now });
  const waiting = new Set(needs.items.flatMap((item) => (item.kind === "task" ? [item.task.id] : [])));
  const needsRows = needs.items.slice(0, GROUP_ROWS).map((item) =>
    item.kind === "task"
      ? row(item.task.title, item.task.nextStep ? render(item.task.nextStep.text) : null, `duet://tasks/${item.task.id}`)
      : row(item.title, render(item.detail), item.route),
  );

  // Working: what runs now; a working task that waits on a card of its own is under Needs you.
  const workingWhere = { userId, ...inScope, archivedAt: null, routine: false, status: "working", ...(waiting.size ? { id: { notIn: [...waiting] } } : {}) };
  const [workingCount, workingRows] = await Promise.all([
    db.task.count({ where: workingWhere }),
    db.task.findMany({ where: workingWhere, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: GROUP_ROWS }),
  ]);

  const suggestedWhere = { userId, status: "open", ...inScope };
  const [suggestedCount, suggestions] = await Promise.all([
    db.suggestion.count({ where: suggestedWhere }),
    db.suggestion.findMany({ where: suggestedWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: GROUP_ROWS }),
  ]);

  // Done: resolved within the window (a resolved row without resolvedAt counts by updatedAt).
  const cutoff = new Date(now.getTime() - RESOLVED_KEEP_DAYS * DAY_MS);
  const doneWhere = {
    userId, ...inScope, archivedAt: null, status: "resolved",
    OR: [{ resolvedAt: { gte: cutoff } }, { resolvedAt: null, updatedAt: { gte: cutoff } }],
  };
  const [doneCount, doneRows] = await Promise.all([
    db.task.count({ where: doneWhere }),
    db.task.findMany({ where: doneWhere, orderBy: [{ resolvedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }], take: GROUP_ROWS }),
  ]);

  const groups: GroupBlock[] = [
    group(say("show_tasks.needs_you"), needs.count, say("show_tasks.needs_you_empty"), needsRows),
    group(say("show_tasks.working"), workingCount, say("show_tasks.working_empty"), workingRows.map((task) => {
      const latest = toTaskSummary(task)?.latestUpdate?.text;
      return row(task.title, latest ? render(latest) : null, `duet://tasks/${task.id}`);
    })),
    group(say("show_tasks.suggested"), suggestedCount, say("show_tasks.suggested_empty"), suggestions.map((s) =>
      row(s.title, s.app ? say("show_tasks.from_app", { app: { type: "text", value: s.app } }) : say(s.fromUser ? "show_tasks.you_asked" : "show_tasks.assistant_suggested"), `duet://suggestions/${s.id}`),
    )),
    group(say("show_tasks.done"), doneCount, say("show_tasks.done_empty"), doneRows.map((task) => row(task.title, null, `duet://tasks/${task.id}`))),
  ];
  const payload: CardPayload = { icon: "checklist", tint: "grey", title: say("show_tasks.title"), subtitle: null, blocks: groups, actions: [] };
  return { payload, counts: { needsYou: needs.count, working: workingCount, suggested: suggestedCount, done: doneCount }, needs };
}

/** A group block: the real total, at most GROUP_ROWS rows, the empty line only when it has none. */
function group(title: string, count: number, empty: string, rows: (Row | null)[]): GroupBlock {
  const kept = rows.filter((r): r is Row => r !== null).slice(0, GROUP_ROWS);
  return { type: "group", title: clipLine(title, 60), count, empty: kept.length ? null : clipLine(empty, 160), rows: kept };
}

/** One row; null when it has no title to show (the group's count still includes it). */
function row(title: string, detail: string | null, route: string): Row | null {
  const shown = title.trim();
  if (!shown) return null;
  const line = (detail ?? "").trim();
  return { title: clipLine(shown, ROW_TITLE_MAX), detail: line ? clipLine(line, ROW_DETAIL_MAX) : null, route };
}
