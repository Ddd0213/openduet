// M23: the one way to add an Up next suggestion (docs/API.md "## M23"). propose_task / propose_tasks
// (tasks/tools.ts), add_up_next and the brief (proactive/, M23 W2) call it; nobody creates a
// suggestion for the assistant or dedupes on their own. The user's own "Save for Up next" (POST
// /api/up-next) is their explicit ask and isn't deduped (it still gets its titleKey).
//
// It runs checkSuggestion (dedupe.ts) under a per-user, per-title lock, so two calls for the same
// thing at once make one row:
// - created: a new open row (titleKey, sourceRef);
// - linked: the same thing is already open or recently added: that row is reused (a card links to
//   it; a missing titleKey / sourceRef is filled in);
// - hidden: the user hid it within HIDDEN_SUGGESTION_DAYS: nothing is made;
// - unread_source: it names an email / event / page this turn didn't read: nothing is made.
import type { Suggestion } from "@prisma/client";
import type { z } from "zod";
import type { Db } from "../db.ts";
import { KeyedLock } from "../tasks/lock.ts";
import { checkSuggestion, titleKeyOf } from "./dedupe.ts";
import { readInRun, storeSource, toStored, type SourceInput, type StoredSource } from "./source.ts";

export { titleKeyOf } from "./dedupe.ts";
export { SourceInput, publicSourceRef, readInRun, type StoredSource } from "./source.ts";

export type SuggestionOrigin = "checkin" | "scan" | "brief" | "chat";

export interface NewSuggestion {
  userId: string;
  channelId: string | null;
  title: string;
  body?: string;
  prompt?: string;
  /** the app's display name shown on the row ("From Gmail"); null for none */
  app?: string | null;
  origin: SuggestionOrigin;
  /** the email / event / page it came from (SourceInput, e.g. a tool argument); omit when none */
  source?: z.output<typeof SourceInput> | null;
  /** the run that read it: the source must have been read in this run (readInRun) */
  runId?: string | null;
  /**
   * Instead of runId: ids the caller itself read this turn (e.g. a server-side fetch). With neither,
   * a named source counts as unread.
   */
  readThisTurn?: ReadonlySet<string>;
  now?: Date;
}

export type SuggestionOutcome =
  | { outcome: "created"; suggestion: Suggestion }
  | { outcome: "linked"; suggestion: Suggestion }
  | { outcome: "hidden"; suggestionId: string }
  | { outcome: "unread_source" };

const lock = new KeyedLock();

/** Creates the Up next row, or links to the same one already there (see the header). */
export async function createOrLinkSuggestion(db: Db, input: NewSuggestion): Promise<SuggestionOutcome> {
  let source: StoredSource | null = null;
  let read: ReadonlySet<string> | undefined = input.readThisTurn;
  if (input.source) {
    const named = toStored(input.source);
    const seen = input.readThisTurn?.has(named.id) ? { app: named.app } : input.runId ? await readInRun(db, input.runId, named) : undefined;
    // The record's spelling of the app wins over the model's ("gmail" -> "Gmail").
    source = seen ? toStored(input.source, seen.app ?? named.app) : named;
    read = seen ? new Set([named.id]) : new Set();
  }
  const titleKey = titleKeyOf(input.title);
  return lock.run(`${input.userId}\u0000${titleKey}`, async () => {
    const check = await checkSuggestion(db, {
      userId: input.userId, channelId: input.channelId, title: input.title, app: input.app ?? source?.app ?? null,
      sourceId: source?.id ?? null, ...(read ? { readThisTurn: read } : {}),
    }, input.now);
    switch (check.verdict) {
      case "unread_source": return { outcome: "unread_source" };
      case "hidden": return { outcome: "hidden", suggestionId: check.suggestionId };
      case "duplicate": {
        const row = await db.suggestion.findUniqueOrThrow({ where: { id: check.suggestionId } });
        const fill = { ...(row.titleKey ? {} : { titleKey: check.titleKey }), ...(!row.sourceRef && source ? { sourceRef: storeSource(source) } : {}) };
        const suggestion = Object.keys(fill).length ? await db.suggestion.update({ where: { id: row.id }, data: fill }) : row;
        return { outcome: "linked", suggestion };
      }
      case "new": {
        const suggestion = await db.suggestion.create({ data: {
          userId: input.userId, channelId: input.channelId, title: input.title, body: input.body ?? "", prompt: input.prompt ?? "",
          app: input.app ?? source?.app ?? null, origin: input.origin, titleKey: check.titleKey, sourceRef: storeSource(source),
        } });
        return { outcome: "created", suggestion };
      }
    }
  });
}

/** The card that offers this row (Suggestion.messageId: the newest card linked to it). */
export async function linkCard(db: Db, suggestionId: string, messageId: string): Promise<void> {
  await db.suggestion.updateMany({ where: { id: suggestionId }, data: { messageId } });
}
