// M23 (BriefInfo): the morning brief says what it couldn't read. The brief's last text bubble gets
// TextPayload.brief = {unchecked: [app]} and, for each source it couldn't read, one fixed sentence
// (i18n brief.unchecked_*: not connected, its connection expired, the read failed) at its end, so a
// brief never reads as "nothing new" for a source it didn't read. When a read failed and the model
// posted nothing (or skipped the brief), the server posts that line by itself.
import { phrase, type PhraseKey } from "../agent/phrase.ts";
import type { BriefInfo } from "../contract/m23.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { emitStored, storedPayload } from "../tasks/thread.ts";
import type { ServerReads, UncheckedReason } from "./reads.ts";
import type { TurnState } from "./turns.ts";

const KEY: Record<UncheckedReason, PhraseKey> = {
  not_connected: "brief.unchecked_not_connected",
  expired: "brief.unchecked_expired",
  read_failed: "brief.unchecked_failed",
};

/** One sentence per source it couldn't read, in the user's language ("" when every source was read). */
export function uncheckedLine(reads: ServerReads, lang: string): string {
  return reads.unchecked.map((u) => phrase(KEY[u.reason], lang).replaceAll("{app}", u.app)).join(lang === "zh-Hans" ? "" : " ");
}

/** A source that is connected (or should be) but couldn't be read: the brief isn't skipped then. */
export const readFailed = (reads: ServerReads | null | undefined): boolean => !!reads?.unchecked.some((u) => u.reason !== "not_connected");

export const briefInfo = (reads: ServerReads): BriefInfo => ({ unchecked: reads.unchecked.map((u) => u.app) });

export interface FinishDeps { db: Db; events?: EventBus | null }

/**
 * After the brief's model turn completed: the line and the payload on its last text bubble, or the
 * line alone when nothing was posted and a read failed. Keeps the turn state (visible, first text)
 * in step, so afterTurn pushes it.
 */
export async function finishBrief(deps: FinishDeps, input: { userId: string; state: TurnState; reads: ServerReads; lang: string }): Promise<void> {
  const { state, reads, lang } = input;
  const sink = state.raw;
  if (!sink) return;
  const line = uncheckedLine(reads, lang);
  let id = state.lastTextId;
  if (!id) {
    if (!line || !readFailed(reads)) return;
    id = (await sink.upsertMessage({ role: "assistant", kind: "text", text: line })).id;
    state.visible = true;
    state.firstTextId = id;
    state.firstText = line;
    state.lastTextId = id;
    state.lastText = line;
  } else if (line && !state.lastText.includes(line)) {
    const text = `${state.lastText.trimEnd()}\n\n${line}`;
    await sink.upsertMessage({ id, role: "assistant", kind: "text", text });
    if (state.firstTextId === id) state.firstText = text;
    state.lastText = text;
  }
  // The run host stores a text bubble's payload as {skill}; the brief's field is written after it.
  const row = await deps.db.message.findFirst({ where: { id, userId: input.userId, kind: "text" }, select: { payload: true } });
  if (!row) return;
  await deps.db.message.update({ where: { id }, data: { payload: JSON.stringify({ ...storedPayload(row.payload), brief: briefInfo(reads) }) } });
  if (deps.events) await emitStored(deps.db, deps.events, input.userId, id);
}
