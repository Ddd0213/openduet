// M23 W4 (#31, docs/API.md "## M23" Quick replies): the quick_replies rules, in code rather than in
// the prompt. 2-3 options (QUICK_REPLY_MIN / QUICK_REPLY_MAX), each at most QUICK_REPLY_MAX_CHARS
// characters (a Chinese character counts as one); options that break the rules are dropped, and
// fewer than 2 left means no card. No card at all:
//  - in a turn that used web_search (its answer isn't on the user's screen yet; review-harness P1-3:
//    the chips would hang under a question with no answer);
//  - while an approval card waits in this conversation (the card is the choice; review-ux §5);
//  - on an open question (the soul setup's "what was off?", the channel greeting's No / Not now);
//  - in the morning brief (the runtime doesn't offer the tool there).
// The first-day "Sounds right" / "Something's off" are confirm_profile's own card, not this tool.
// A setup question's card always ends with "Use the default" (soul/setup.ts); the invitation is the
// server's own card (postInvitation), so the model's chips are dropped in that turn.
import { QUICK_REPLY_MAX, QUICK_REPLY_MAX_CHARS, QUICK_REPLY_MIN } from "../contract/m23.ts";
import type { Db } from "../db.ts";
import type { ContentBlock } from "../llm/index.ts";
import { isSetupDefault, setupDefault, type SetupMode } from "../soul/setup.ts";

/** Characters as the user reads them: code points, so 中 is one and an emoji is one. */
export const replyLength = (option: string): number => Array.from(option).length;

const keyOf = (option: string) => option.normalize("NFKC").toLowerCase();

/** The options that may show, in order: trimmed, non-empty, short enough, no repeats; at most `max`. */
export function fittingReplies(options: readonly string[], max: number = QUICK_REPLY_MAX): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of options) {
    const option = raw.trim();
    if (!option || replyLength(option) > QUICK_REPLY_MAX_CHARS || seen.has(keyOf(option))) continue;
    seen.add(keyOf(option));
    kept.push(option);
    if (kept.length >= max) break;
  }
  return kept;
}

/** This turn's rules, from the context (agent/context.ts): what the setup or the greeting needs. */
export interface ReplyRules {
  /** User.language: the setup's "Use the default" is written in it */
  language: string;
  /** the soul setup's state this turn (soul/setup.ts); null outside it */
  setup: SetupMode | null;
  /** this turn answers an open question (the setup's "what was off?", a greeting's No / Not now): no card */
  open: boolean;
}

export const NO_RULES: ReplyRules = { language: "en", setup: null, open: false };

/** What the turn has done so far (the runtime keeps it up to date while the turn runs). */
export interface ReplyTurn {
  rules: ReplyRules;
  /** web_search ran in this turn (ours or the provider's own) */
  searched: boolean;
  /** a tool result in this turn said it waits on an approval card */
  approvalWaiting: boolean;
}

export type ReplyDecision =
  | { show: true; options: string[] }
  | { show: false; reason: "web_search" | "approval" | "open" | "invitation" | "too_few"; note: string };

const NOTES = {
  web_search: "No buttons were shown: this turn used web_search, and the user hasn't seen your answer yet. Write your full answer from the results now, and ask any follow-up question in plain text.",
  approval: "No buttons were shown: an approval card is waiting for the user, and the card is how they choose. Say in plain text what's waiting, if anything.",
  open: "No buttons were shown: this turn needs none (an open question for the user to answer in their own words, or a reply to their no). Write it as plain text.",
  invitation: "No buttons were shown: the app adds the one-line setup offer with its own buttons under your reply this turn. Write your reply as plain text; don't offer the setup or list choices yourself.",
  too_few: `No buttons were shown: quick replies need ${QUICK_REPLY_MIN}-${QUICK_REPLY_MAX} different options of at most ${QUICK_REPLY_MAX_CHARS} characters each. Send them again shorter, or ask in plain text.`,
  setup: `No buttons were shown: a setup question needs 1-${QUICK_REPLY_MAX - 1} short suggestions (at most ${QUICK_REPLY_MAX_CHARS} characters each); the server adds "Use the default" as the last option. Send them again shorter.`,
} as const;

/**
 * Whether the model's quick_replies may show, and with which options. `approvalWaiting` is asked
 * last (a database read): an approval card still pending in this conversation counts too.
 */
export async function decideReplies(options: readonly string[], turn: ReplyTurn, approvalWaiting: () => Promise<boolean>): Promise<ReplyDecision> {
  const no = (reason: Exclude<ReplyDecision, { show: true }>["reason"], note: string = NOTES[reason as keyof typeof NOTES]): ReplyDecision => ({ show: false, reason, note });
  const { rules } = turn;
  if (turn.searched) return no("web_search");
  if (rules.open || rules.setup?.kind === "open") return no("open");
  if (rules.setup?.kind === "invite") return no("invitation");
  let shown: string[];
  // A setup question ends with "Use the default" (appended when the model left it out); an answer to
  // the invitation that reads as a question (its options name the default) is put in the same shape.
  if (rules.setup?.kind === "question" && (rules.setup.required || options.some(isSetupDefault))) {
    const suggestions = fittingReplies(options.filter((option) => !isSetupDefault(option)), QUICK_REPLY_MAX - 1);
    if (!suggestions.length) return no("too_few", NOTES.setup);
    shown = [...suggestions, setupDefault(rules.language)];
  } else {
    shown = fittingReplies(options);
    if (shown.length < QUICK_REPLY_MIN) return no("too_few");
  }
  if (turn.approvalWaiting || (await approvalWaiting())) return no("approval");
  return { show: true, options: shown };
}

/**
 * An approval card still pending in this conversation (the channel's main thread, or this task's
 * session); one past its expiry doesn't count.
 */
export async function pendingApproval(db: Db, scope: { userId: string; channelId: string; taskId: string | null }, now: Date): Promise<boolean> {
  const rows = await db.approval.findMany({
    where: { userId: scope.userId, status: "pending", messageId: { not: null }, taskId: scope.taskId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { messageId: true }, orderBy: { createdAt: "desc" }, take: 20,
  });
  if (!rows.length) return false;
  const ids = rows.flatMap((row) => (row.messageId ? [row.messageId] : []));
  return (await db.message.count({ where: { id: { in: ids }, userId: scope.userId, channelId: scope.channelId, taskId: scope.taskId } })) > 0;
}

// `"status":"awaiting_approval"` as our own JSON writes it (approvals/gate.ts askNote, request_payment,
// skill scripts); a page quoting it inside a JSON string has its quotes escaped and doesn't match.
const WAITING = /"status":"(awaiting_approval|already_waiting)"/;
/** A tool result (before the untrusted envelope) that says the call waits on an approval card. */
export const waitsForApproval = (resultText: string): boolean => WAITING.test(resultText);

/** The provider's own web search ran in this model reply (its blocks are opaque provider_data). */
export function usedNativeSearch(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === "provider_data" && block.data.type === "server_tool_use" && block.data.name === "web_search");
}
