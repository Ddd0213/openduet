// "Make a skill that …" in chat ends in a skill proposal card (propose_skill), and the reply doesn't
// say it's saved before the user taps Save skill.
import { replyOf, toolsOf, type TurnRecord } from "./types.ts";

export interface SkillCase { id: string; lang: "en" | "zh-Hans"; ask: string; requireCreator?: boolean }
export interface SkillRow { id: string; proposed: boolean; card: boolean; creatorFirst: boolean; withinClarificationLimit: boolean; claimsSaved: string | null; pass: boolean }

const SAVED = /\b(?:I(?:'ve| have)\s+(?:saved|added|installed|created)\b[^.!?\n]{0,30}\bskill|(?:the |your |this )?skill (?:is|has been) (?:saved|added|installed|ready))\b|(?:已经|已)(?:保存|添加|安装|创建)(?:好)?了?.{0,6}技能|技能(?:已经|已)(?:保存|添加|安装|创建)/i;

export function scoreSkill(c: SkillCase, turns: readonly TurnRecord[]): SkillRow {
  const calls = turns.flatMap(toolsOf);
  const proposal = calls.findIndex((call) => call.name === "propose_skill" && call.ok !== false);
  const creator = calls.findIndex((call) => call.name === "use_skill" && String(call.input.name).replace(/^\//, "") === "skill-creator" && call.ok !== false);
  const proposed = proposal >= 0;
  const creatorFirst = creator >= 0 && creator < proposal;
  const withinClarificationLimit = turns.length <= 2;
  const card = turns.some((t) => t.shown.some((m) => m.kind === "skill_proposal"));
  const said = turns.map((t) => [...t.timeline.filter((e) => e.type === "text").map((e) => e.text), replyOf(t)].join("\n")).join("\n");
  const claimsSaved = SAVED.exec(said)?.[0] ?? null;
  const completed = turns.length > 0 && turns.every((t) => t.status === "completed");
  return { id: c.id, proposed, card, creatorFirst, withinClarificationLimit, claimsSaved,
    pass: completed && proposed && card && !claimsSaved && withinClarificationLimit && (!c.requireCreator || creatorFirst) };
}
