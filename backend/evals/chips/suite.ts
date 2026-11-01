// Reply chips: natural choice questions get 2-3 short quick replies after a real answer. Drafts
// may offer refinement choices; unanswered open questions, approvals and web-search turns get none.
// One fresh channel per case, the fixture inbox and calendar connected.
import { z } from "zod";
import { MAX_CHIP_CHARS, scoreChipTurn, summarizeChips, type ChipCase, type ChipRow } from "../score/chips.ts";
import { bubblesOf } from "../score/types.ts";
import { pct } from "../score/text.ts";
import { table } from "../lib/output.ts";
import { Session } from "../lib/session.ts";
import { eachCase, loadCases, mark, problemLines, transcript, useFixtures, type Suite } from "../lib/suite.ts";

export const Case = z.object({
  id: z.string(),
  lang: z.enum(["en", "zh-Hans"]),
  ask: z.string().min(1),
  expect: z.enum(["chips", "optional_refinement", "none_open", "none_approval", "none_web"]),
}).strict();

export const chips: Suite = {
  id: "chips",
  calls: "16 cases × 1-3 calls ≈ 20-40",
  skip: async () => null,
  async run(env, opts) {
    const cases = loadCases<ChipCase>("chips", Case, opts);
    const runs = await eachCase<ChipCase, ChipRow>(env, "chips", cases, opts, async (c) => {
      useFixtures(env);
      const session = await Session.fresh(env, c.lang);
      const turn = await session.say(c.ask);
      return { row: scoreChipTurn(c, turn), turns: [turn] };
    });
    const rows = runs.map((r) => r.row);
    const s = summarizeChips(rows);
    const markdown = [
      "## Summary",
      "",
      `- choice questions with 2-3 chips (≤ ${MAX_CHIP_CHARS} chars each), no violation: ${s.offered}/${s.choiceTurns} (${pct(s.offered, s.choiceTurns)}; pass needs ≥ 70%)`,
      `- answers swallowed (no statement, only a question / chips): ${s.collapsed}`,
      `- chip violations (open question, approval, web_search, invalid refinements): ${s.violations}`,
      `- empty replies: ${s.empty}`,
      `- suite: ${s.pass ? "PASS" : "FAIL"}`,
      "",
      "Failed rows are structural checks; read the reply before calling it a model problem.",
      "",
      "## Cases",
      "",
      table(["case", "expect", "chips", "shape", "answered", "violation", "result", "reply"], runs.map((r) => [
        `${r.case.id}${opts.repeat > 1 ? ` #${r.repeat}` : ""}`, r.row.expect, r.row.chips.join(" / "), mark(r.row.shapeOk), mark(r.row.answered),
        r.row.violation ?? "", mark(r.row.pass), bubblesOf(r.turns[0]!).join(" ⏎ "),
      ])),
      ...problemLines(runs),
    ].join("\n");
    return {
      json: { summary: s, rows: runs.map((r) => ({ ...r.row, repeat: r.repeat, ask: r.case.ask, turns: transcript(r.turns) })) },
      markdown,
      summary: `chips: ${s.offered}/${s.choiceTurns} choice turns with chips, ${s.collapsed} swallowed, ${s.violations} violations → ${s.pass ? "PASS" : "FAIL"}`,
      pass: s.pass,
    };
  },
};
