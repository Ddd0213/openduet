// Eval scoring (no model): the text measures, the quick-reply rules and the tone budget.
import { describe, expect, test } from "bun:test";
import { scoreChipTurn, summarizeChips, type ChipCase } from "../../evals/score/chips.ts";
import { isQuestion, isStatement, listItems, median, sentences, wordCount } from "../../evals/score/text.ts";
import { scoreToneTurn, summarizeTone, type ToneCase } from "../../evals/score/tone.ts";
import { bubble, card, chips, tool, turn } from "./transcripts.ts";

describe("text measures", () => {
  test("words: a Chinese character is one word, English by words, markdown ignored", () => {
    expect(wordCount("Double-wall is safer for Sam's mugs.")).toBe(6);
    expect(wordCount("双层更稳")).toBe(4);
    expect(wordCount("**Matte** 更好看, I think")).toBe(6);
    expect(wordCount("See [the deck](https://x.example/a) now")).toBe(4);
  });

  test("sentences split on Chinese and English punctuation, not inside 3.5", () => {
    expect(sentences("It costs 3.5 dollars. Want it?")).toEqual(["It costs 3.5 dollars.", "Want it?"]);
    expect(sentences("先回 Ana。然后看发票！要我起草吗？")).toEqual(["先回 Ana。", "然后看发票！", "要我起草吗？"]);
    expect(sentences("- one\n- two")).toEqual(["one", "two"]);
  });

  test("questions and statements", () => {
    expect(isQuestion("Which one?")).toBe(true);
    expect(isQuestion("你选哪个吗")).toBe(true);
    expect(isQuestion("I'd go matte.")).toBe(false);
    expect(isStatement("I'd go with matte for Ana.")).toBe(true);
    expect(isStatement("Matte", ["Matte"])).toBe(false);
    expect(isStatement("Let me know which one.")).toBe(false);
    expect(isStatement("哑光更耐看。")).toBe(true);
    expect(isStatement("好的。")).toBe(false);
  });

  test("list items and the median", () => {
    expect(listItems("Here:\n- a\n- b\n1. c\n2、d\n（3）e\nplain")).toBe(5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("quick replies", () => {
  const choice: ChipCase = { id: "c1", lang: "en", ask: "Matte or gloss?", expect: "chips" };

  test("an answer then 2-3 short chips passes", () => {
    const row = scoreChipTurn(choice, turn([bubble("I'd go matte: it hides fingerprints."), chips("Which finish?", ["Matte", "Gloss"])]));
    expect(row).toMatchObject({ shapeOk: true, answered: true, violation: null, pass: true });
  });

  test("chips with only a question collapse the answer", () => {
    const row = scoreChipTurn(choice, turn([chips("Which finish do you want?", ["Matte", "Gloss"])]));
    expect(row.answered).toBe(false);
    expect(row.pass).toBe(false);
  });

  test("4 chips, a 25-character chip or two cards are the wrong shape", () => {
    const say = bubble("Matte hides fingerprints better.");
    expect(scoreChipTurn(choice, turn([say, chips("", ["a", "b", "c", "d"])])).shapeOk).toBe(false);
    expect(scoreChipTurn(choice, turn([say, chips("", ["a", "x".repeat(25)])])).shapeOk).toBe(false);
    expect(scoreChipTurn(choice, turn([say, chips("", ["哑光", "亮光".repeat(12) + "面"])])).shapeOk).toBe(false);
    expect(scoreChipTurn(choice, turn([say, chips("", ["a", "b"]), chips("", ["c", "d"])])).shapeOk).toBe(false);
    expect(scoreChipTurn(choice, turn([say, chips("", ["哑光", "亮光"])])).shapeOk).toBe(true);
  });

  test("chips in a turn that called web_search are a violation", () => {
    const row = scoreChipTurn(choice, turn([bubble("Gloss is trending this year."), chips("", ["Matte", "Gloss"])], [tool("web_search", { query: "glaze trends" })]));
    expect(row.violation).toContain("web_search");
    expect(row.pass).toBe(false);
  });

  test("controls: no chips on an open question, next to an approval card, or on a web question", () => {
    const open: ChipCase = { id: "o", lang: "en", ask: "Tell me about my week", expect: "none_open" };
    expect(scoreChipTurn(open, turn([bubble("Busy: three client calls and the launch on Friday.")])).pass).toBe(true);
    expect(scoreChipTurn(open, turn([bubble("Busy week."), chips("", ["More", "Less"])])).violation).toBe("chips on an open question");
    const approval: ChipCase = { id: "a", lang: "en", ask: "Email Ana yes", expect: "none_approval" };
    expect(scoreChipTurn(approval, turn([bubble("Drafted it for you to approve."), card("approval"), chips("", ["Send", "Edit"])])).violation).toBe("chips next to an approval card");
    expect(scoreChipTurn(approval, turn([])).pass).toBe(false);
  });

  test("a completed draft may offer short refinement choices, or no chips", () => {
    const draft: ChipCase = { id: "draft", lang: "en", ask: "Draft a thank-you note", expect: "optional_refinement" };
    const answer = bubble("Dear Ana, thank you for a great first project together.");
    const row = scoreChipTurn(draft, turn([answer, chips("", ["Make it more formal", "Make it shorter", "Warmer and more personal"])]));
    expect(row).toMatchObject({ shapeOk: true, answered: true, violation: null, pass: true });
    expect(scoreChipTurn(draft, turn([answer])).pass).toBe(true);
    expect(summarizeChips([row]).choiceTurns).toBe(0);
    expect(scoreChipTurn({ ...draft, lang: "zh-Hans" }, turn([bubble("从下周一起，我们把每天的站会改成文字版。"), chips("", ["更轻松一点", "更正式一点", "加个每日模板"])])).pass).toBe(true);
  });

  test("draft refinement still requires an answer, valid chips and no approval or search", () => {
    const draft: ChipCase = { id: "draft", lang: "en", ask: "Draft a thank-you note", expect: "optional_refinement" };
    const answer = bubble("Dear Ana, thank you for a great first project together.");
    const options = chips("", ["More formal", "Shorter"]);
    expect(scoreChipTurn(draft, turn([chips("What should I say?", ["Formal", "Casual"])])).pass).toBe(false);
    expect(scoreChipTurn(draft, turn([answer, chips("", ["Shorter", "x".repeat(25)])])).violation).toBe("invalid refinement chips");
    expect(scoreChipTurn(draft, turn([answer, options, card("approval")])).pass).toBe(false);
    expect(scoreChipTurn(draft, turn([answer, options], [tool("web_search", {})])).pass).toBe(false);
  });

  test("the summary needs 70% of choice turns with chips, no collapse and no violation", () => {
    const good = scoreChipTurn(choice, turn([bubble("Matte, since it hides prints."), chips("", ["Matte", "Gloss"])]));
    const none = scoreChipTurn(choice, turn([bubble("Matte, since it hides prints.")]));
    expect(summarizeChips([good, good, good, none]).pass).toBe(true);
    expect(summarizeChips([good, none, none]).pass).toBe(false);
    const collapsed = scoreChipTurn(choice, turn([chips("Which one?", ["Matte", "Gloss"])]));
    expect(summarizeChips([good, good, good, collapsed])).toMatchObject({ collapsed: 1, pass: false });
  });
});

describe("tone", () => {
  const en: ToneCase = { id: "t1", lang: "en", ask: "Did Sam email me?" };
  const zh: ToneCase = { id: "t2", lang: "zh-Hans", ask: "今天日程？" };

  test("bubbles within the budget pass; one over the max fails", () => {
    expect(scoreToneTurn(en, turn([bubble("Yes, Sam asked for Friday off and needs an answer today.")])).pass).toBe(true);
    expect(scoreToneTurn(en, turn([bubble("word ".repeat(81))])).pass).toBe(false);
    expect(scoreToneTurn(zh, turn([bubble("今天下午两点有周会。")])).words).toEqual([9]);
    expect(scoreToneTurn(zh, turn([bubble("字".repeat(161))])).pass).toBe(false);
  });

  test("more than 3 list items fail", () => {
    expect(scoreToneTurn(en, turn([bubble("Today:\n- a\n- b\n- c\n- d")])).listItems).toBe(4);
    expect(scoreToneTurn(en, turn([bubble("Today:\n- a\n- b\n- c\n- d")])).pass).toBe(false);
  });

  test("grounding: an invented fact or a missing 'no' fails", () => {
    const kenji: ToneCase = { id: "g", lang: "en", ask: "Did Kenji email me?", invented: ["thursday'?s call", "friday at 3"], expectNo: true };
    expect(scoreToneTurn(kenji, turn([bubble("No, nothing from Kenji today.")])).pass).toBe(true);
    expect(scoreToneTurn(kenji, turn([bubble("Yes, Kenji moved Thursday's call.")]))).toMatchObject({ invented: "thursday'?s call", direct: false, pass: false });
    expect(scoreToneTurn({ ...kenji, lang: "zh-Hans" }, turn([bubble("没有，今天没有 Kenji 的邮件。")])).direct).toBe(true);
    for (const no of ["Nobody named Kenji wrote today.", "You haven't got anything from Kenji.", "He hasn't written since Monday.", "None from Kenji."]) {
      expect(scoreToneTurn(kenji, turn([bubble(no)])).direct).toBe(true);
    }
    expect(scoreToneTurn(kenji, turn([bubble("Kenji wrote at 9.")])).direct).toBe(false);
  });

  test("reaction-only acknowledgements need a stored reaction and no message, not a spacing refusal", () => {
    const c: ToneCase = { ...en, reactionOnly: true };
    const reacted = { type: "tool" as const, name: "react", input: { emoji: "👍", final: true }, ok: true, output: JSON.stringify({ status: "reacted" }) };
    const good = scoreToneTurn(c, turn([], [reacted]));
    expect(good).toMatchObject({ pass: true, reactionOnly: true, reacted: true, bubbles: 0 });
    expect(summarizeTone([good])).toMatchObject({ empty: 0, reactionTurns: 1, reactionPassed: 1, pass: true });
    expect(scoreToneTurn(c, turn([bubble("（收到）")], [reacted])).pass).toBe(false);
    expect(scoreToneTurn(c, turn([card("quick_replies")], [reacted])).pass).toBe(false);
    const refused = { ...reacted, output: JSON.stringify({ status: "not_reacted" }) };
    expect(scoreToneTurn(c, turn([], [refused])).pass).toBe(false);
    expect(scoreToneTurn(c, turn([], [{ ...reacted, ok: false }])).pass).toBe(false);
    expect(scoreToneTurn(c, { ...turn([], [reacted]), status: "failed" }).pass).toBe(false);
    expect(summarizeTone([scoreToneTurn(c, turn([]))]).pass).toBe(false);
  });

  test("the summary takes the median per language and fails on an empty reply", () => {
    const short = scoreToneTurn(en, turn([bubble("Yes, from Sam this morning.")]));
    const long = scoreToneTurn(en, turn([bubble("word ".repeat(60))]));
    expect(summarizeTone([short, short, long]).byLang.en).toMatchObject({ median: 5, max: 60, ok: true });
    expect(summarizeTone([long, long, short]).byLang.en?.ok).toBe(false);
    expect(summarizeTone([short, scoreToneTurn(en, turn([]))])).toMatchObject({ empty: 1, pass: false });
  });
});
