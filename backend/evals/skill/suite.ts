// "Make a skill that …" in chat ends in a skill proposal card (propose_skill), and OpenDuet doesn't
// say it's saved before the user taps Save skill. One clarifying question is allowed: the user
// then says "go ahead" once.
import { z } from "zod";
import { scoreSkill, type SkillCase, type SkillRow } from "../score/skill.ts";
import { calledTool, replyOf, type TurnRecord } from "../score/types.ts";
import { table } from "../lib/output.ts";
import { Session, toolExists } from "../lib/session.ts";
import { eachCase, loadCases, mark, problemLines, transcript, useFixtures, type Suite } from "../lib/suite.ts";

export const Case = z.object({ id: z.string(), lang: z.enum(["en", "zh-Hans"]), ask: z.string().min(1), requireCreator: z.boolean().optional() }).strict();

const GO_AHEAD = { en: "Looks good, go ahead.", "zh-Hans": "可以，就这样做吧。" } as const;

export const skill: Suite = {
  id: "skill",
  calls: "4 cases × 1-2 turns × 1-4 calls ≈ 4-32",
  skip: async () => (toolExists("propose_skill") ? null : "propose_skill isn't in src/ yet"),
  async run(env, opts) {
    const cases = loadCases<SkillCase>("skill", Case, opts);
    const runs = await eachCase<SkillCase, SkillRow>(env, "skill", cases, opts, async (c) => {
      useFixtures(env);
      const session = await Session.fresh(env, c.lang);
      const turns: TurnRecord[] = [await session.say(c.ask)];
      const first = turns[0]!;
      if (first.status === "completed" && !calledTool(first, "propose_skill") && !env.meter.exhausted) turns.push(await session.say(GO_AHEAD[c.lang]));
      return { row: scoreSkill(c, turns), turns };
    });
    const failed = runs.filter((r) => !r.row.pass);
    const pass = runs.length > 0 && failed.length === 0;
    const markdown = [
      "## Summary",
      "",
      `- cases ending in a proposal without claiming saved (Create with OpenDuet also loads skill-creator first, within two turns): ${runs.length - failed.length}/${runs.length}`,
      `- suite: ${pass ? "PASS" : "FAIL"}`,
      "",
      "## Cases",
      "",
      table(["case", "turns", "creator first", "propose_skill", "card", "says saved", "result", "reply"], runs.map((r) => [
        `${r.case.id}${opts.repeat > 1 ? ` #${r.repeat}` : ""}`, r.turns.length, mark(r.row.creatorFirst), mark(r.row.proposed), mark(r.row.card), r.row.claimsSaved ?? "", mark(r.row.pass), r.turns.map(replyOf).join(" ‖ "),
      ])),
      ...problemLines(runs),
    ].join("\n");
    return {
      json: { rows: runs.map((r) => ({ ...r.row, repeat: r.repeat, ask: r.case.ask, turns: transcript(r.turns) })) },
      markdown,
      summary: `skill: ${runs.length - failed.length}/${runs.length} proposed → ${pass ? "PASS" : "FAIL"}`,
      pass,
    };
  },
};
