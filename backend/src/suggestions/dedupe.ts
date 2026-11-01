// M23: one place that decides whether a new Up next suggestion is new (contract: docs/API.md "## M23").
// Interface fixed in the M23 contract; M23 W3 wrote the rules and their tests. Callers go through
// createOrLinkSuggestion (suggestions/create.ts), which calls `checkSuggestion` before creating a row;
// nobody dedupes on their own.
//
// Rules (review-harness P1-5):
// - titles compare normalised (titleKeyOf): NFKC (full-width letters, digits and punctuation become
//   their ASCII forms), lower case, every punctuation mark / symbol / emoji (Chinese ones too: 【】、。
//   《》“”…) and apostrophes dropped, runs of space folded, and no space next to a Han / kana character
//   ("回复 Dana" and "回复Dana" are the same);
// - an open suggestion with the same key is a duplicate however old; an added one within
//   HIDDEN_SUGGESTION_DAYS (the task it made is recent: a second card links to it);
// - one the user hid within HIDDEN_SUGGESTION_DAYS is "hidden" (hide means hide); older ones may
//   come back;
// - a candidate that names a source (sourceId) is "unread_source" unless the id is in readThisTurn
//   (no set = nothing proven read = refused).
// Rows written before M23 (titleKey null) are compared by their title.
import type { PrismaClient, Suggestion } from "@prisma/client";
import { HIDDEN_SUGGESTION_DAYS } from "../contract/m23.ts";

/** What the caller wants to add. `sourceId` is the email / event id it came from (server only). */
export interface SuggestionCandidate {
  userId: string;
  channelId: string | null;
  title: string;
  /** "Gmail", "Google Calendar"; null for the chat */
  app: string | null;
  sourceId: string | null;
  /** ids of the emails / events this turn really read (tool results); a sourceId outside it is refused */
  readThisTurn?: ReadonlySet<string>;
}

/**
 * new: create it (with `titleKey`). duplicate: an open or recently added suggestion is the same thing
 * (reuse `suggestionId`, e.g. link a new card to it). hidden: the user hid the same thing within
 * HIDDEN_SUGGESTION_DAYS. unread_source: it names a source this turn didn't read.
 */
export type SuggestionCheck =
  | { verdict: "new"; titleKey: string }
  | { verdict: "duplicate"; suggestionId: string; titleKey: string }
  | { verdict: "hidden"; suggestionId: string; titleKey: string }
  | { verdict: "unread_source"; titleKey: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many pre-M23 rows (no titleKey) of the user are compared by title. */
const LEGACY_ROWS = 300;

/** Punctuation, symbols and emoji (after NFKC, so full-width forms are already ASCII). */
const MARKS = /[\p{P}\p{S}\p{Extended_Pictographic}\u200d\ufe0f]+/gu;
const APOSTROPHES = /['’‘`´]/g;
const WIDE = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const SPACE_BEFORE_WIDE = new RegExp(`\\s+(?=[${WIDE}])`, "gu");
const SPACE_AFTER_WIDE = new RegExp(`(?<=[${WIDE}])\\s+`, "gu");

/** The normalised title used to compare suggestions. */
export function titleKeyOf(title: string): string {
  const key = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(MARKS, " ")
    .replace(/\s+/g, " ")
    .replace(SPACE_BEFORE_WIDE, "")
    .replace(SPACE_AFTER_WIDE, "")
    .trim();
  // A title of marks only keeps its own (folded) form, so two such titles don't all collide on "".
  return key || title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

type Row = Pick<Suggestion, "id" | "status" | "title" | "titleKey" | "hiddenAt" | "updatedAt" | "createdAt">;
const RANK: Record<string, number> = { open: 0, added: 1, hidden: 2 };

export async function checkSuggestion(db: PrismaClient, input: SuggestionCandidate, now = new Date()): Promise<SuggestionCheck> {
  const titleKey = titleKeyOf(input.title);
  if (input.sourceId && !input.readThisTurn?.has(input.sourceId)) return { verdict: "unread_source", titleKey };
  const since = new Date(now.getTime() - HIDDEN_SUGGESTION_DAYS * DAY_MS);
  const select = { id: true, status: true, title: true, titleKey: true, hiddenAt: true, updatedAt: true, createdAt: true } as const;
  const live = [{ status: "open" }, { status: "added", updatedAt: { gte: since } }, { status: "hidden", hiddenAt: { gte: since } }, { status: "hidden", hiddenAt: null, updatedAt: { gte: since } }];
  const [keyed, legacy] = await Promise.all([
    db.suggestion.findMany({ where: { userId: input.userId, titleKey, OR: live }, select }),
    db.suggestion.findMany({ where: { userId: input.userId, titleKey: null, OR: live }, orderBy: { createdAt: "desc" }, take: LEGACY_ROWS, select }),
  ]);
  const same: Row[] = [...keyed, ...legacy.filter((row) => titleKeyOf(row.title) === titleKey)];
  if (!same.length) return { verdict: "new", titleKey };
  // An open one first (the live item), then an added one (its task), then a hidden one; newest first.
  const best = same.sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  return best.status === "hidden" ? { verdict: "hidden", suggestionId: best.id, titleKey } : { verdict: "duplicate", suggestionId: best.id, titleKey };
}
