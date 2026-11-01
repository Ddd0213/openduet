// M21 bubble splitting: a lead-in line ending with ":" / "：" (bold or italic too) stays in the
// same bubble as the list after it; other paragraph breaks past 600 characters still split.
import { describe, expect, test } from "bun:test";
import { TextBubbles } from "../../src/agent/bubbles.ts";
import { recordingSink } from "./fixtures.ts";

/** Streams `value` in small deltas (like a model) and returns the bubbles' final texts. */
async function bubblesOf(value: string, step = 37): Promise<string[]> {
  const recording = recordingSink();
  let clock = 0;
  const bubbles = new TextBubbles(recording.sink, () => (clock += 1000));
  for (let i = 0; i < value.length; i += step) await bubbles.append(value.slice(i, i + step));
  await bubbles.finish();
  return [...recording.messages.values()].map((message) => message.text);
}

// One line of ~700 characters, so the first blank line after it (and the lead-in below it) is past 600.
const para = "This sentence is long enough that ten of them pass the split threshold. ".repeat(10).trim() + "\n";
const list = "- First option, with a short note\n- Second option, also short\n- Third option\n";

describe("lead-in lines and their lists", () => {
  test("\"…:\" stays in the same bubble as the list that follows it", async () => {
    const value = `${para}Here are the three options:\n\n${list}`;
    const parts = await bubblesOf(value);
    expect(parts).toEqual([value]);
  });

  test("the full-width colon and a bold or italic lead-in count too", async () => {
    for (const lead of ["我整理了三个方案：", "**Options:**", "_Next steps:_ "]) {
      const value = `${para}${lead}\n\n${list}`;
      expect(await bubblesOf(value, 53)).toEqual([value]);
    }
  });

  test("more than one blank line after the lead-in still keeps its list", async () => {
    const value = `${para}Choose one:\n\n\n${list}`;
    expect(await bubblesOf(value)).toEqual([value]);
  });

  test("a line that doesn't end with a colon still splits there", async () => {
    const value = `${para}Here are the three options.\n\n${list}`;
    expect(await bubblesOf(value)).toEqual([`${para}Here are the three options.\n\n`, list]);
    // A colon inside the line (not at its end) is not a lead-in.
    const inline = `${para}Note: this one is done.\n\n${list}`;
    expect(await bubblesOf(inline)).toEqual([`${para}Note: this one is done.\n\n`, list]);
  });

  test("a lead-in after a split point travels with its list into the next bubble", async () => {
    const value = `${para}\nThree options:\n\n${list}`;
    expect(await bubblesOf(value)).toEqual([`${para}\n`, `Three options:\n\n${list}`]);
  });
});

describe("M27: silent reactions never flash a text bubble", () => {
  test("every delta of a short parenthetical after a reaction stays off the client", async () => {
    for (const value of ["（收到）", " （好的）。 \n", "(ok)!", "(no reply needed)"]) {
      const recording = recordingSink();
      let clock = 0;
      const bubbles = new TextBubbles(recording.sink, () => (clock += 1000), true);
      for (const char of value.trimStart()) {
        await bubbles.append(char);
        expect(recording.updates).toHaveLength(0);
      }
      await bubbles.finish();
      expect(recording.updates).toHaveLength(0);
      expect(recording.messages.size).toBe(0);
    }
  });
  test("a parenthetical prefix is released as soon as real prose follows", async () => {
    for (const [prefix, prose] of [["(Updated)", " Here is the plan…"], ["（注：更新）", "后面还有正文"]]) {
      const recording = recordingSink();
      const bubbles = new TextBubbles(recording.sink, () => 1000, true);
      await bubbles.append(prefix!);
      expect(recording.updates).toHaveLength(0);
      await bubbles.append(prose!);
      expect(recording.updates).toHaveLength(1);
      await bubbles.finish();
      expect([...recording.messages.values()].map(m => m.text)).toEqual([prefix! + prose!]);
    }
  });
  test("without a reaction, ordinary parentheticals remain visible; full-width pass stays silent", async () => {
    expect(await bubblesOf("（收到）", 1)).toEqual(["（收到）"]);
    expect(await bubblesOf("(ok)", 1)).toEqual(["(ok)"]);
    expect(await bubblesOf("（pass）", 1)).toEqual([]);
  });
});

describe("M28: a copy of the history's [tools: …] digest never reaches the user", () => {
  const digest = "[tools: computer_navigate → ok; computer_screenshot → ok]";
  /** Every text the client was sent while streaming, and the final bubbles. */
  async function streamed(value: string, step: number) {
    const recording = recordingSink();
    let clock = 0;
    const bubbles = new TextBubbles(recording.sink, () => (clock += 1000));
    for (let i = 0; i < value.length; i += step) await bubbles.append(value.slice(i, i + step));
    await bubbles.finish();
    const sent = recording.updates.map((u) => ("text" in u.draft ? u.draft.text ?? "" : ""));
    return { sent, final: [...recording.messages.values()].map((m) => m.text) };
  }

  test("a trailing digest line is dropped, and no partial of it is ever sent", async () => {
    for (const step of [1, 3, 37]) {
      const { sent, final } = await streamed(`开了。浏览器停在 Bing 首页。\n${digest}`, step);
      expect(final).toEqual(["开了。浏览器停在 Bing 首页。"]);
      for (const text of sent) expect(text).not.toContain("[");
    }
  });

  test("a digest line between paragraphs goes, the text around it stays", async () => {
    expect((await streamed(`第一段。\n${digest}\n第二段。`, 5)).final).toEqual(["第一段。\n第二段。"]);
  });

  test("a reply that is only a digest, or a pass with one, sends nothing", async () => {
    for (const value of [digest, ` ${digest}\n`, `(pass)\n${digest}`]) {
      const { sent, final } = await streamed(value, 2);
      expect(sent).toEqual([]);
      expect(final).toEqual([]);
    }
  });

  test("a mention inside a sentence and other bracketed lines stay", async () => {
    const value = "那行 [tools: …] 是服务器加的。\n[注] 这是备注\n[链接](https://example.com)\n[tools: 见下] 说明";
    expect((await streamed(value, 1)).final).toEqual([value]);
  });
});
