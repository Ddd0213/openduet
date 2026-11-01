// Setting up "who OpenDuet is" in the chat (M22): after the first-day "Sounds right", OpenDuet asks one
// question per turn, its quick replies come after the question (they end the turn), at most 3
// rounds, then one soul_setup card.
import { isQuestion, sentences } from "./text.ts";
import { bubblesOf, calledTool, quickRepliesOf, type TurnRecord } from "./types.ts";

export interface SoulCase { id: string; lang: "en" | "zh-Hans"; firstReply: string; answers: string[] }

export interface SoulTurnRow { questions: number; chips: string[]; chipsAfterQuestion: boolean | null; setupQuestion: boolean; card: boolean }

export interface SoulRow {
  id: string;
  /** setup questions asked before the card */
  rounds: number;
  card: boolean;
  turns: SoulTurnRow[];
  problems: string[];
  pass: boolean;
}

export const MAX_ROUNDS = 3;

/**
 * `defaults`: the "Use the default" option in every language (phrase soul.setup_default): a quick
 * reply card whose last option is one of them is a setup question.
 */
export function scoreSoul(c: SoulCase, turns: readonly TurnRecord[], defaults: readonly string[]): SoulRow {
  const problems: string[] = [];
  const rows: SoulTurnRow[] = [];
  let rounds = 0;
  let card = false;
  for (const [index, turn] of turns.entries()) {
    const cards = quickRepliesOf(turn);
    const chips = cards.flatMap((q) => q.options);
    const setupQuestion = cards.some((q) => defaults.includes((q.options.at(-1) ?? "").trim()));
    const shownCard = turn.shown.some((m) => m.kind === "soul_setup") || calledTool(turn, "propose_soul_setup");
    const text = [...bubblesOf(turn), ...cards.map((q) => q.text)].join("\n");
    const questions = sentences(text).filter(isQuestion).length;
    // The chips are the turn's last message (quick_replies ends the turn) and come after a question.
    const order = turn.shown.filter((m) => m.role === "assistant");
    const lastIsChips = order.at(-1)?.kind === "quick_replies";
    const questionBefore = order.slice(0, -1).some((m) => m.kind === "text" && sentences(m.text).some(isQuestion)) || cards.some((q) => sentences(q.text).some(isQuestion));
    const chipsAfterQuestion = cards.length ? lastIsChips && questionBefore : null;
    rows.push({ questions, chips, chipsAfterQuestion, setupQuestion, card: shownCard });
    if (card) continue;
    if (shownCard) { card = true; continue; }
    if (setupQuestion) {
      rounds++;
      if (questions > 1) problems.push(`turn ${index + 1}: ${questions} questions in one turn`);
      if (chipsAfterQuestion === false) problems.push(`turn ${index + 1}: quick replies not after the question`);
    } else if (index === 0) {
      problems.push("turn 1: no setup question after \"Sounds right\"");
    } else if (!cards.length && questions > 0) {
      problems.push(`turn ${index + 1}: a question without quick replies`);
    }
  }
  if (rounds > MAX_ROUNDS) problems.push(`${rounds} rounds (at most ${MAX_ROUNDS})`);
  if (!card) problems.push("no soul_setup card");
  return { id: c.id, rounds, card, turns: rows, problems, pass: problems.length === 0 };
}
