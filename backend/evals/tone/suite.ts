// Tone on everyday questions: words per bubble (a Chinese character counts as one), at most 3 list
// items, a straight "no" when the answer is no, and nothing taken from the prompt's own examples
// ("from the Q4 budget email", "every weekday at 9") as if it were the user's data.
import { z } from "zod";
import { MAX_LIST_ITEMS, scoreToneTurn, summarizeTone, TONE_BUDGET, type ToneCase, type ToneRow } from "../score/tone.ts";
import { bubblesOf } from "../score/types.ts";
import { table } from "../lib/output.ts";
import { Session } from "../lib/session.ts";
import { eachCase, loadCases, mark, problemLines, transcript, useFixtures, type Suite } from "../lib/suite.ts";

export const Case = z.object({
  id: z.string(),
  lang: z.enum(["en", "zh-Hans"]),
  ask: z.string().min(1),
  invented: z.array(z.string()).optional(),
  expectNo: z.boolean().optional(),
  reactionOnly: z.boolean().optional(),
  priorReply: z.string().min(1).optional(),
}).strict();

export const tone: Suite = {
  id: "tone",
  calls: "12 questions + 5 reaction-only acknowledgements ≈ 25-50 calls",
  skip: async () => null,
  async run(env, opts) {
    const cases = loadCases<ToneCase>("tone", Case, opts);
    const runs = await eachCase<ToneCase, ToneRow>(env, "tone", cases, opts, async (c) => {
      useFixtures(env);
      const session = await Session.fresh(env, c.lang);
      if (c.priorReply) await env.db.message.create({ data: {
        userId: env.user.id, channelId: session.channelId, role: "assistant", kind: "text", text: c.priorReply, status: "sent",
        // Keep the seeded history outside Session.say's timestamp-based recording window.
        createdAt: new Date(Date.now() - 1000),
      } });
      const turn = await session.say(c.ask);
      return { row: scoreToneTurn(c, turn), turns: [turn] };
    });
    const s = summarizeTone(runs.map((r) => r.row));
    const langs = Object.entries(s.byLang).map(([lang, l]) =>
      `- ${lang}: ${l.bubbles} bubbles, median ${l.median} / max ${l.max} ${lang === "zh-Hans" ? "characters" : "words"} (budget ≤ ${l.budget.median} / ≤ ${l.budget.max}) → ${l.ok ? "ok" : "OVER"}`);
    const markdown = [
      "## Summary",
      "",
      ...langs,
      `- replies with more than ${MAX_LIST_ITEMS} list items: ${s.overList}`,
      `- invented facts from the prompt's examples: ${s.invented}`,
      `- "no" answers that didn't start with a no: ${s.notDirect}`,
      `- empty replies: ${s.empty}`,
      `- reaction-only acknowledgements: ${s.reactionPassed}/${s.reactionTurns} (stored reaction and no message)`,
      `- suite: ${s.pass ? "PASS" : "FAIL"}`,
      "",
      `Budgets per bubble: en ${TONE_BUDGET.en.median} median / ${TONE_BUDGET.en.max} max words, zh-Hans ${TONE_BUDGET["zh-Hans"].median} / ${TONE_BUDGET["zh-Hans"].max} characters. The model decides length: numbers move between runs; this is a regression check for the prompt, not a grade.`,
      "",
      "## Cases",
      "",
      table(["case", "bubbles", "words", "list items", "direct no", "invented", "reaction only", "reacted", "result", "reply"], runs.map((r) => [
        `${r.case.id}${opts.repeat > 1 ? ` #${r.repeat}` : ""}`, r.row.bubbles, r.row.words.join(", "), r.row.listItems, mark(r.row.direct), r.row.invented ?? "",
        r.row.reactionOnly, r.row.reacted, mark(r.row.pass), bubblesOf(r.turns[0]!).join(" ⏎ "),
      ])),
      ...problemLines(runs),
    ].join("\n");
    const lengths = Object.entries(s.byLang).map(([lang, l]) => `${lang} median ${l.median}/max ${l.max}`).join(", ");
    return {
      json: { summary: s, rows: runs.map((r) => ({ ...r.row, repeat: r.repeat, ask: r.case.ask, turns: transcript(r.turns) })) },
      markdown,
      summary: `tone: ${lengths || "no bubbles"}, ${s.overList} long lists, ${s.invented} invented, ${s.notDirect} not direct, ${s.reactionPassed}/${s.reactionTurns} reaction-only → ${s.pass ? "PASS" : "FAIL"}`,
      pass: s.pass,
    };
  },
};
