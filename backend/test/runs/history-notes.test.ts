import { describe, expect, test } from "bun:test";
import { composeTakeover, stripDigests } from "../../src/runs/takeover.ts";
import { clearFinishText, finishTextAfter, noteFinishText } from "../../src/tasks/result-text.ts";

describe("copied history notes outside chat bubbles", () => {
  test("task result text removes suffix notes without taking text before finish_task", () => {
    const runId = crypto.randomUUID();
    try {
      noteFinishText(runId, [
        { type: "text", text: "Working on it." },
        { type: "tool_use", id: "finish", name: "finish_task", input: {} },
        { type: "text", text: "做好了。[attachment]" },
        { type: "text", text: "[tools: finish_task → ok]" },
      ]);
      expect(finishTextAfter(runId, "finish")).toBe("做好了。");
    } finally { clearFinishText(runId); }
  });

  test("a retry quotes the cleaned prose without repeating copied card labels", () => {
    const body = '做好了。[artifact "Plan [A]" ready][tools: make_artifact → ok]';
    const note = composeTakeover([{ kind: "text", tool: null, detail: body, input: body, output: null, status: "ok" }], "chat", "failed");
    expect(note).toContain('What the user was already told:\n- "做好了。"');
    expect(note).not.toContain("[artifact");
    expect(note).not.toContain("[tools:");
  });

  test("prose with an unclosed bracket and a card word is never cut, on any line", () => {
    for (const value of [
      "配置项写在 [file 名称 那一栏，然后保存。",
      "先看 [card 标题 这一段\n第二行正常",
      "例子：[text 这里随便写",
      "[image of a cat, then more text",
      "The list [file names are below\nnext line",
    ]) {
      expect(stripDigests(value)).toBe(value);
    }
    // A cut-off server note is still dropped (its kind is followed by a quoted title).
    expect(stripDigests('完成。[file "report.pdf')).toBe("完成。");
    expect(stripDigests("完成。[tools: computer_exec →")).toBe("完成。");
  });

  test("mentions and code survive cleanup, while adjacent copied notes are removed", () => {
    const body = '说明 `[attachment]` 的意思。\n```text\n[tools: quick_replies → ok]\n```';
    expect(stripDigests(`${body}\n完成。[attachment][tools: quick_replies → ok]`)).toBe(`${body}\n完成。`);
    for (const value of ["提到 [tools: 见下]", "[attachment] 是什么", "[tools: quick_replies → ok] 是内部标注"]) {
      expect(stripDigests(value)).toBe(value);
    }
  });
});
