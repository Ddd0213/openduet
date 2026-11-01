import { expect, test } from "bun:test";
import { scoreSkill } from "../../evals/score/skill.ts";
import { emptyTurn, type ToolEvent } from "../../evals/score/types.ts";
const c = { id: "chat-creation", lang: "en" as const, ask: "Help me create a skill: write notes", requireCreator: true };
const tool = (name: string, input = {}, ok = true): ToolEvent => ({ type: "tool", name, input, ok, output: "{}" });
const use = tool("use_skill", { name: "skill-creator" });
const propose = tool("propose_skill");
const card = { id: "card", role: "assistant" as const, kind: "skill_proposal", text: "", payload: {} };

test("chat-creation eval requires creator before proposal, not after or failed", () => {
  const turn = (timeline: ToolEvent[]) => emptyTurn({ timeline, shown: [card] });
  expect(scoreSkill(c, [turn([use, propose])]).pass).toBe(true);
  expect(scoreSkill(c, [turn([propose])]).pass).toBe(false);
  expect(scoreSkill(c, [turn([propose, use])]).pass).toBe(false);
  expect(scoreSkill(c, [turn([tool("use_skill", { name: "skill-creator" }, false), propose])]).pass).toBe(false);
});

test("chat-creation eval allows at most one clarification, requires card/completion, catches early saved claims", () => {
  const done = emptyTurn({ timeline: [propose], shown: [card] });
  const first = emptyTurn({ timeline: [use] });
  expect(scoreSkill(c, [first, done]).pass).toBe(true);
  expect(scoreSkill(c, [first, emptyTurn(), done]).pass).toBe(false);
  expect(scoreSkill(c, [first, { ...done, status: "failed" }]).pass).toBe(false);
  expect(scoreSkill(c, [first, { ...done, shown: [] }]).pass).toBe(false);
  for (const text of ["I've saved this skill.", "已经保存了技能。", "Your skill is saved."]) {
    expect(scoreSkill(c, [emptyTurn({ timeline: [{ type: "text", text }, use, propose], shown: [card] })]).pass).toBe(false);
  }
});
