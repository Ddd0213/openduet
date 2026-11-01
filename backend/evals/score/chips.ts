// Quick replies ("chips"): on a natural choice question OpenDuet answers in words and offers 2-3
// short chips. A draft may offer refinement choices; an unanswered open question, approval or web
// search turn must not. The user's open-ended request alone doesn't make the reply an open question.
import { charLength, isStatement, sentences } from "./text.ts";
import { bubblesOf, calledTool, quickRepliesOf, type TurnRecord } from "./types.ts";

/** Drafts may offer refinement chips but needn't; they aren't counted as required choice turns. */
export type ChipExpect = "chips" | "optional_refinement" | "none_open" | "none_approval" | "none_web";

export interface ChipCase { id: string; lang: "en" | "zh-Hans"; ask: string; expect: ChipExpect }

export interface ChipRow {
  id: string;
  expect: ChipExpect;
  chips: string[];
  /** 2-3 chips, each 1-24 characters */
  shapeOk: boolean;
  /** at least one sentence that isn't a question (bubbles + the chip card's own text) */
  answered: boolean;
  /** chips where none may show (open question, approval card, web_search in the turn) */
  violation: string | null;
  /** an empty reply: no text, no chips, no card */
  empty: boolean;
  pass: boolean;
}

export const MAX_CHIP_CHARS = 24;

export function chipShapeOk(options: readonly string[]): boolean {
  return options.length >= 2 && options.length <= 3 && options.every((o) => charLength(o.trim()) >= 1 && charLength(o.trim()) <= MAX_CHIP_CHARS);
}

export function scoreChipTurn(c: ChipCase, turn: TurnRecord): ChipRow {
  const cards = quickRepliesOf(turn);
  const chips = cards.flatMap((card) => card.options);
  const labels = chips.map((o) => o.trim());
  const prose = [...bubblesOf(turn), ...cards.map((card) => card.text)];
  const answered = prose.some((text) => sentences(text).some((s) => isStatement(s, labels)));
  const approval = turn.shown.some((m) => m.kind === "approval");
  const searched = calledTool(turn, "web_search");
  const empty = !prose.some((t) => t.trim()) && !turn.shown.some((m) => m.role === "assistant");
  let violation: string | null = null;
  if (chips.length) {
    if (searched) violation = "chips in a turn that called web_search";
    else if (approval) violation = "chips next to an approval card";
    else if (c.expect === "none_open") violation = "chips on an open question";
    else if (c.expect === "none_approval") violation = "chips on an approval request";
    else if (c.expect === "none_web") violation = "chips on a web question";
  }
  const shapeOk = chips.length > 0 && cards.length === 1 && chipShapeOk(chips);
  if (c.expect === "optional_refinement" && chips.length && !shapeOk && !violation) violation = "invalid refinement chips";
  const pass = c.expect === "chips" ? shapeOk && answered && !violation
    : c.expect === "optional_refinement" ? answered && !violation && !empty : !violation && !empty;
  return { id: c.id, expect: c.expect, chips, shapeOk, answered, violation, empty, pass };
}

export interface ChipSummary {
  choiceTurns: number;
  /** choice turns with well-shaped chips */
  offered: number;
  /** choice turns whose answer was swallowed (no statement) */
  collapsed: number;
  violations: number;
  empty: number;
  /** ≥ 70% of choice turns offered chips, none collapsed, no violations */
  pass: boolean;
}

export function summarizeChips(rows: readonly ChipRow[]): ChipSummary {
  const choice = rows.filter((r) => r.expect === "chips");
  const offered = choice.filter((r) => r.shapeOk && !r.violation).length;
  const collapsed = rows.filter((r) => !r.answered && !r.empty).filter((r) => r.chips.length > 0 || r.expect === "chips" || r.expect === "optional_refinement").length;
  const violations = rows.filter((r) => r.violation).length;
  const empty = rows.filter((r) => r.empty).length;
  return { choiceTurns: choice.length, offered, collapsed, violations, empty, pass: choice.length > 0 && offered >= Math.ceil(choice.length * 0.7) && collapsed === 0 && violations === 0 && empty === 0 };
}
