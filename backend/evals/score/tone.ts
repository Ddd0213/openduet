// Tone on everyday questions: how long each bubble is (a Chinese character counts as a word),
// at most 3 list items, and no facts invented from the prompts' own examples.
import { listItems, median, wordCount } from "./text.ts";
import { bubblesOf, toolsOf, type TurnRecord } from "./types.ts";

export interface ToneCase {
  id: string;
  lang: "en" | "zh-Hans";
  ask: string;
  /** grounding checks: patterns (case-insensitive) that only an invented answer would contain */
  invented?: string[];
  /** the honest answer starts with a no ("No, nothing from Kenji.") */
  expectNo?: boolean;
  /** A plain acknowledgement should receive only a stored reaction, never a text message. */
  reactionOnly?: boolean;
  /** Seeded assistant reply for the acknowledgement, without spending a setup model call. */
  priorReply?: string;
}

export interface ToneRow {
  id: string;
  lang: "en" | "zh-Hans";
  bubbles: number;
  /** words per bubble */
  words: number[];
  listItems: number;
  invented: string | null;
  /** expectNo cases: the first bubble says no */
  direct: boolean | null;
  reactionOnly: boolean;
  reacted: boolean;
  pass: boolean;
}

/** Per bubble: median and max. English counts words, Chinese characters (about twice as many). */
export const TONE_BUDGET = { en: { median: 45, max: 80 }, "zh-Hans": { median: 90, max: 160 } } as const;
export const MAX_LIST_ITEMS = 3;

const NO = /^\s*(?:no\b|nope\b|nothing\b|not\b|none\b|nobody\b|no one\b|neither\b|(?:i|you) (?:don't|do not|didn't|did not|can't|cannot|couldn't|haven't|have not) (?:see|find|have|got|get)|(?:you|i) (?:haven't|have not|didn't|did not) (?:got|gotten|received|had)|(?:he|she|they|it) (?:hasn't|has not|haven't|have not|didn't|did not)\b|there(?:'s| is| are| was| were) no\b|没有|没|不是|并没有|目前没有|暂时没有|还没|查了.{0,6}没|无)/i;

export function scoreToneTurn(c: ToneCase, turn: TurnRecord): ToneRow {
  const bubbles = bubblesOf(turn);
  const words = bubbles.map(wordCount);
  const all = bubbles.join("\n");
  const items = Math.max(0, ...bubbles.map(listItems));
  const invented = (c.invented ?? []).find((p) => new RegExp(p, "i").test(all)) ?? null;
  const direct = c.expectNo ? NO.test(bubbles[0] ?? "") : null;
  const reactionOnly = c.reactionOnly === true;
  const reacted = toolsOf(turn).some(tool => {
    if (tool.name !== "react" || tool.ok !== true || !tool.output) return false;
    try { return JSON.parse(tool.output).status === "reacted"; } catch { return false; }
  });
  const budget = TONE_BUDGET[c.lang];
  const pass = reactionOnly ? turn.status === "completed" && reacted && turn.shown.length === 0
    : bubbles.length > 0 && words.every((w) => w <= budget.max) && items <= MAX_LIST_ITEMS && !invented && direct !== false;
  return { id: c.id, lang: c.lang, bubbles: bubbles.length, words, listItems: items, invented, direct, reactionOnly, reacted, pass };
}

export interface ToneSummary {
  byLang: Record<string, { bubbles: number; median: number; max: number; budget: { median: number; max: number }; ok: boolean }>;
  overList: number;
  invented: number;
  notDirect: number;
  empty: number;
  reactionTurns: number;
  reactionPassed: number;
  pass: boolean;
}

export function summarizeTone(rows: readonly ToneRow[]): ToneSummary {
  const byLang: ToneSummary["byLang"] = {};
  for (const lang of ["en", "zh-Hans"] as const) {
    const words = rows.filter((r) => r.lang === lang).flatMap((r) => r.words);
    if (!words.length) continue;
    const budget = TONE_BUDGET[lang];
    const m = median(words);
    const max = Math.max(...words);
    byLang[lang] = { bubbles: words.length, median: m, max, budget: { ...budget }, ok: m <= budget.median && max <= budget.max };
  }
  const overList = rows.filter((r) => r.listItems > MAX_LIST_ITEMS).length;
  const invented = rows.filter((r) => r.invented).length;
  const notDirect = rows.filter((r) => r.direct === false).length;
  const empty = rows.filter((r) => !r.reactionOnly && r.bubbles === 0).length;
  const reactions = rows.filter((r) => r.reactionOnly);
  const reactionPassed = reactions.filter((r) => r.pass).length;
  const pass = Object.values(byLang).every((l) => l.ok) && overList === 0 && invented === 0 && notDirect === 0 && empty === 0 && reactionPassed === reactions.length;
  return { byLang, overList, invented, notDirect, empty, reactionTurns: reactions.length, reactionPassed, pass };
}
