// M22: setting up "who the assistant is" in the chat (prompt.txt L76, docs/API.md "## M22"). Asked once per
// person: User.soulIntroAt is written when it starts (the first question, or the existing user's
// invitation). No other stored state: where the setup stands is read from the main thread's last
// messages, so a restart mid-setup carries on from the thread itself:
//   - the invitation is a quick_replies card with exactly soul.setup_sure / soul.setup_later;
//   - a setup question is a quick_replies card whose options end with soul.setup_default;
//   - a soul_setup card (propose_soul_setup) ends it.
// soulSetupTurn() is the one hook (agent/context.ts): lines only while the setup is due or in
// progress on a main-thread chat turn, none in any other turn.
// M23 W4 (real-model run 2026-10-29: a model ignored the invitation line and posted its own chips,
// yet soulIntroAt was written, so the one invitation was lost): the invitation is the server's.
// The turn's mode says so; the runtime drops the model's own quick replies in that turn, posts the
// one-line invitation with exactly Sure / Later after the assistant's reply (postInvitation), and only then
// writes soulIntroAt. A setup question's chips always end with "Use the default" (agent/replies.ts
// appends it when the model left it out).
import type { Message as MessageRow } from "@prisma/client";
import { phrase, type PhraseKey } from "../agent/phrase.ts";
import type { TurnInput, TurnSink } from "../agent/types.ts";
import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import type { RunHost } from "../runs/host.ts";
import { SOUL_FIELDS, toSoul } from "./service.ts";

/** At most this many questions: what to call the user, what the assistant calls itself, tone and character. */
export const SETUP_ROUNDS = 3;
/** An existing user with fewer soul fields set than this (of the 5) is invited once. */
export const INVITE_BELOW = 3;

/**
 * The model-facing message of the turn POST /api/soul/intro queues ("Set up in chat"). Never stored
 * or shown; a synthetic turn (`turn_<runId>`) with exactly this text is the intro.
 */
export const INTRO_PROMPT = "[The user tapped \"Set up in chat\" in Everything → Who OpenDuet is. This message is from the server, not the user.]";

const LANGS = ["en", "zh-Hans"] as const;
const same = (text: string, key: PhraseKey) => LANGS.some((lang) => phrase(key, lang) === text.trim());

/** "Use the default" in either language (any case): the setup question's last option. */
export const isSetupDefault = (option: string): boolean => LANGS.some((lang) => phrase("soul.setup_default", lang).toLowerCase() === option.trim().toLowerCase());
/** "Use the default" in the user's language. */
export const setupDefault = (lang: string): string => phrase("soul.setup_default", lang);

/**
 * What this turn is in the setup, for the quick-reply rules (agent/replies.ts) and the runtime:
 *  - invite: the server posts the invitation after the assistant's reply (postInvitation);
 *  - question: a setup question may be asked; `required`: this turn asks one, so its chips end
 *    with "Use the default" (otherwise only when the model's options name the default);
 *  - open: "what was off?", to be answered in the user's own words (no chips).
 */
export type SetupMode = { kind: "invite" } | { kind: "question"; required: boolean } | { kind: "open" };

/** An assistant quick_replies row's options (null for any other row or an unreadable payload). */
function optionsOf(row: MessageRow): { options: string[]; chosen: string | null } | null {
  if (row.role !== "assistant" || row.kind !== "quick_replies") return null;
  try {
    const value = JSON.parse(row.payload) as { options?: unknown; chosen?: unknown };
    if (!Array.isArray(value.options) || !value.options.every((o) => typeof o === "string")) return null;
    return { options: value.options as string[], chosen: typeof value.chosen === "string" ? value.chosen : null };
  } catch {
    return null;
  }
}

/** A setup question: its last option is "Use the default". */
const isQuestion = (row: MessageRow) => {
  const card = optionsOf(row);
  return !!card && card.options.length > 0 && same(card.options.at(-1)!, "soul.setup_default");
};
/** The invitation: exactly Sure / Later. */
const isInvite = (row: MessageRow) => {
  const card = optionsOf(row);
  return !!card && card.options.length === 2 && same(card.options[0]!, "soul.setup_sure") && same(card.options[1]!, "soul.setup_later");
};

/**
 * The assistant's turns before the current message, newest first: the rows between two user messages
 * (newest row first). `rows`: the thread's last messages, newest first (agent/context.ts loads
 * them); the current message and anything after it are skipped.
 */
function assistantTurns(rows: readonly MessageRow[], currentId: string): MessageRow[][] {
  const at = rows.findIndex((row) => row.id === currentId);
  const turns: MessageRow[][] = [[]];
  for (const row of rows.slice(at + 1)) {
    if (row.role === "user") turns.push([]);
    else turns.at(-1)!.push(row);
  }
  return turns;
}

/** Where the setup stands, from the assistant's last turns. */
function threadState(rows: readonly MessageRow[], currentId: string) {
  const turns = assistantTurns(rows, currentId);
  const last = turns[0]!;
  // The newest quick replies of the turn just before this message (what this message answers).
  const pending = last.find((row) => row.kind === "quick_replies");
  // Questions asked in a row, back to the last card or a turn without a question.
  let asked = 0;
  for (const turn of turns) {
    if (turn.some((row) => row.kind === "soul_setup") || !turn.some(isQuestion)) break;
    asked++;
  }
  const proposed = last.some((row) => row.kind === "soul_setup");
  return {
    asked: proposed ? 0 : asked,
    invite: !proposed && pending && isInvite(pending) ? pending : null,
  };
}

/** The invitation's answer: a tapped chip (its `chosen`), else the typed text when it is one of the two. */
function inviteAnswer(card: MessageRow, text: string): "sure" | "later" | "typed" {
  const chosen = optionsOf(card)?.chosen ?? text;
  if (same(chosen, "soul.setup_sure")) return "sure";
  if (same(chosen, "soul.setup_later")) return "later";
  return "typed";
}

/**
 * The new user's first main-thread messages after their first-day scan (the Run of kind "scan" with
 * scheduledFor = onboardedAt), oldest first, at most 3. Empty without a first-day scan.
 */
async function sinceFirstDay(db: Db, userId: string, channelId: string): Promise<{ id: string; text: string }[]> {
  const scan = await db.run.findFirst({ where: { userId, kind: "scan", scheduledFor: { not: null } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (!scan) return [];
  return db.message.findMany({
    where: { userId, channelId, taskId: null, role: "user", createdAt: { gte: scan.createdAt } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 3, select: { id: true, text: true },
  });
}

/** Writes User.soulIntroAt once (a later call never moves it). */
async function markStarted(db: Db, userId: string): Promise<void> {
  await db.user.updateMany({ where: { id: userId, soulIntroAt: null }, data: { soulIntroAt: new Date() } });
}

// ---------------------------------------------------------------- the instruction

const HEAD = "[Setting up who you are for the user, in this chat]";

/** One corrective model round for a setup question whose mandatory chip call was omitted. */
export const MISSING_SETUP_CHIPS_NOTE = "[If that was this turn's setup question, finish it now by calling quick_replies with 1-2 short suggestions and Use the default in User.language, options only. The question is already on screen: do not repeat it, add another question, or write more prose. If the user changed subject and you dropped setup, do not restart it; end with (pass).]";

/** How every question round goes (borrowed from OpenDuet's bot creator: one question, then a card). */
function rules(lang: string): string[] {
  const fallback = JSON.stringify(phrase("soul.setup_default", lang));
  return [
    `One question per turn, at most ${SETUP_ROUNDS} rounds: addressAs, then name, then tone. Ask only this turn's field; never combine rounds, ask a second question, or repeat the question in other words. If they volunteer character or identity along with tone, include it in the final proposal; do not ask extra questions for those fields.`,
    `Each question round MUST end by calling quick_replies, not just by writing a question, and never ask_form. Write the question exactly once as plain text, then call quick_replies with options only (omit text: it would repeat the question on screen). Supply 1-2 suggestions of at most 24 characters each in User.language and ${fallback} as the last option (3 at most). Nothing after quick_replies: it ends the turn.`,
    "These setup rounds are choice questions, including tone: offer two brief contrasting suggestions even though the user can type freely. The general no-chips rule for open questions does not apply to these rounds.",
    `The user may type their own answer instead. ${fallback} (or "skip") leaves that field as it is: go on to the next round.`,
    "After the last round, read their answers back in one short message, then call propose_soul_setup once with only the fields they chose (their words, lightly tidied). Nothing changes until they tap Apply; never say it's saved before that. If they skipped every round, say you'll keep things as they are and that Everything → Who OpenDuet is changes it any time.",
    "If they ask something else, answer it and drop the setup: don't ask again later.",
  ];
}

type Start = "intro" | "after_scan" | "after_off" | "accepted" | "answered_invite";

const STARTS: Record<Start, string> = {
  intro: "The user asked to set this up now. Say in one short line that you'll ask up to three quick questions, then ask round 1.",
  after_scan: "This is the user's reply to your first-day profile read (or their first message, if they weren't there for it). First handle what they said: when something in the read was off, remember the correction (remember) and say so in a line. Then, in the same reply, say you'd like to get a few things right about how you talk with them, and ask round 1.",
  after_off: "The user just told you what was off in your first-day profile read. Remember the correction (remember) and thank them in a line. Then, in the same reply, say you'd like to get a few things right about how you talk with them, and ask round 1.",
  accepted: "The user said yes to setting this up. Ask round 1 right away.",
  answered_invite: "Your last message offered to set this up. If this message says yes, ask round 1 right away. If it says no or is about something else, just answer it and never offer the setup again.",
};

/** Name the one field for this turn, not a menu of questions for the model to choose from. */
function questionLine(round: number): string {
  const field = [
    "addressAs — what to call the user",
    "name — what you call yourself in replies (the app still shows OpenDuet)",
    "tone — how the user wants you to sound",
  ][round - 1];
  return field ? `This turn's one question is: ${field}. Ask it once, then call quick_replies with options only.`
    : "This turn has NO question. Read back the answers and call propose_soul_setup for chosen fields (if all were skipped, keep things as they are); do not call quick_replies or ask_form.";
}

function startLines(start: Start, lang: string): string[] {
  return [HEAD, STARTS[start], ...rules(lang), questionLine(1)];
}

function askingLines(asked: number, lang: string): string[] {
  const next = asked >= SETUP_ROUNDS
    ? "All rounds are asked: take this answer, then read the answers back and call propose_soul_setup."
    : `Take this answer, then ask round ${asked + 1}.`;
  return [HEAD, `You're in the middle of it: ${asked} of ${SETUP_ROUNDS} questions asked so far. ${next}`, ...rules(lang), questionLine(asked + 1)];
}

const OFF_LINES = [
  HEAD,
  "The user tapped \"Something's off\" under your first-day profile read. Ask in one short question what was off, and stop there (no quick replies). Getting who you are for them right comes after their answer.",
];

/** M23 W4: the invitation itself is the server's (postInvitation); the model only answers. */
const INVITE_LINES = [
  HEAD,
  "Answer this message fully as usual. After your reply the app adds one line offering to set up how you talk with them, with its own buttons: don't offer it yourself, don't call quick_replies in this turn, and don't mention the offer.",
];

// ---------------------------------------------------------------- the hook

export interface SetupTurn {
  db: Db;
  input: TurnInput;
  channel: { isMain: boolean };
  /** M23 W4: onboardedAt, so only a user who finished onboarding is invited */
  user: { soulIntroAt: Date | null; onboardedAt: Date | null; language: string };
  /** the thread's last messages, newest first, as agent/context.ts loaded them */
  rows: readonly MessageRow[];
}

/** This turn's part in the setup: its system-prompt lines and its mode (null: not part of it). */
export interface SetupStep { lines: string[]; mode: SetupMode | null }

const NONE: SetupStep = { lines: [], mode: null };
const asking = (lines: string[], required = true): SetupStep => ({ lines, mode: { kind: "question", required } });

/**
 * The setup for this turn (no lines and no mode in every turn that isn't part of it). Writes
 * User.soulIntroAt when a question round starts; the invitation's turn writes it only once the
 * server has posted the invitation (postInvitation). Only main-thread chat turns: the intro's own
 * turn, a reply to the invitation or to a setup question, or the turn that starts it.
 */
export async function soulSetupTurn(turn: SetupTurn): Promise<SetupStep> {
  const { db, input, channel, user, rows } = turn;
  const message = input.userMessage;
  const kind = input.kind ?? (input.taskId === null ? "chat" : "task");
  if (kind !== "chat" || input.taskId !== null || !channel.isMain || message.role !== "user" || message.callId) return NONE;
  const lang = user.language;

  if (message.id.startsWith("turn_")) {
    if (message.text !== INTRO_PROMPT) return NONE;
    await markStarted(db, input.userId);
    return asking(startLines("intro", lang));
  }

  const state = threadState(rows, message.id);
  if (state.asked > 0) {
    await markStarted(db, input.userId);
    // After the last round the answers are read back and the card proposed: no question this turn.
    return asking(askingLines(state.asked, lang), state.asked < SETUP_ROUNDS);
  }
  if (state.invite) {
    const answer = inviteAnswer(state.invite, message.text);
    if (answer === "later") return NONE;
    // A typed answer may be a yes (round 1 follows) or about something else (no question).
    return asking(startLines(answer === "sure" ? "accepted" : "answered_invite", lang), answer === "sure");
  }

  // Not started yet (a retried turn of the one that started it still counts as not started).
  const sentAt = new Date(message.createdAt);
  if (user.soulIntroAt && user.soulIntroAt < sentAt) return NONE;

  // New user: their reply to the first-day profile read (or a "Something's off" and then its answer).
  const firstDay = await sinceFirstDay(db, input.userId, input.channelId);
  const at = firstDay.findIndex((row) => row.id === message.id);
  const off = (row: { text: string } | undefined) => !!row && same(row.text, "agent.something_off");
  if (at === 0 && off(firstDay[0])) return { lines: OFF_LINES, mode: { kind: "open" } };
  if (at === 0 || (at === 1 && off(firstDay[0]))) {
    await markStarted(db, input.userId);
    return asking(startLines(at === 0 ? "after_scan" : "after_off", lang));
  }

  // Existing user: onboarded (one who hasn't finished onboarding gets the new user's path once they
  // do), fewer than 3 of the 5 fields set and never offered.
  if (user.soulIntroAt || !user.onboardedAt) return NONE;
  const soul = toSoul(await db.soul.findUnique({ where: { userId: input.userId } }));
  if (SOUL_FIELDS.filter((field) => soul[field].trim()).length >= INVITE_BELOW) return NONE;
  return { lines: INVITE_LINES, mode: { kind: "invite" } };
}

/** The setup lines alone (soulSetupTurn's). */
export async function soulSetupLines(turn: SetupTurn): Promise<string[]> {
  return (await soulSetupTurn(turn)).lines;
}

/**
 * M23 W4: the invitation, posted by the server after the assistant's reply in the turn whose mode is
 * "invite": one line with exactly Sure / Later (what threadState reads as the invitation), then
 * User.soulIntroAt. A turn that fails before this posts nothing and writes nothing, so the next
 * main-thread turn invites instead.
 */
export async function postInvitation(db: Db, sink: TurnSink, userId: string, lang: string): Promise<void> {
  await sink.upsertMessage({
    role: "assistant", kind: "quick_replies", text: phrase("soul.setup_invite", lang),
    payload: { options: [phrase("soul.setup_sure", lang), phrase("soul.setup_later", lang)] },
  });
  await markStarted(db, userId);
}

// ---------------------------------------------------------------- POST /api/soul/intro

/**
 * Queues the intro turn in the main thread (behind a turn already running there, like any chat
 * turn) and sets soulIntroAt if it was empty. Over the usage limit: 429, with the usage line in the
 * thread, the same as a chat message.
 */
export async function startIntro(deps: { db: Db; runs: RunHost }, userId: string): Promise<{ channelId: string; runId: string }> {
  const { db, runs } = deps;
  const channel = await db.channel.findFirstOrThrow({ where: { userId, isMain: true }, select: { id: true } });
  if (await runs.usageLimit(userId, channel.id, null)) throw new HttpError(429, "usage_limited", "Usage limit reached.");
  const runId = await runs.submit({
    userId, channelId: channel.id, taskId: null, kind: "chat", prompt: INTRO_PROMPT, title: { key: "run.title.soul_intro" },
  });
  if (!runId) throw new HttpError(503, "internal", "The server is restarting.");
  await markStarted(db, userId);
  return { channelId: channel.id, runId };
}
