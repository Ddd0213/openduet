import { stripDigests } from "../runs/takeover.ts";
import { couldBePass, isPass } from "./harness.ts";
import type { TurnSink } from "./types.ts";

/**
 * M21: a lead-in line ("Here are the options:" / "三个方案：", also bold or italic) belongs to
 * what follows it, so the blank line after it is never a split point.
 */
function leadsIn(line: string): boolean {
  return /[:：]$/.test(line.trim().replace(/[*_]+$/, "").trimEnd());
}

/** Safe paragraph boundaries only: fenced code, Markdown tables and a lead-in with its list stay intact. */
function boundary(text: string): number | undefined {
  let fenced: string | null = null, table = false, offset = 0, lead = "";
  const lines = text.split(/(?<=\n)/);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!fenced) fenced = fence;
      else if (fence[0] === fenced[0] && fence.length >= fenced.length) fenced = null;
    }
    if (!fenced && line.trim()) table = line.includes("|");
    if (line.trim()) lead = line;
    offset += line.length;
    if (offset > 600 && !fenced && !table && !line.trim() && !leadsIn(lead) && text.slice(offset).trim()) return offset;
    // A blank line after a table ends it, but is not itself a split point.
    if (!line.trim() && !fenced) table = false;
  }
  return undefined;
}

export class TextBubbles {
  private text = "";
  private id: string | undefined;
  private sent = "";
  private last = -Infinity;
  constructor(private readonly sink: TurnSink, private readonly clock: () => number = () => performance.now(), private readonly reacted = false) {}

  async append(delta: string): Promise<void> {
    this.text += delta;
    let cut: number | undefined;
    while ((cut = boundary(this.text)) !== undefined) {
      const rest = this.text.slice(cut);
      this.text = this.text.slice(0, cut);
      await this.flush(true);
      this.text = rest; this.id = undefined; this.sent = ""; this.last = -Infinity;
    }
    await this.flush(false);
  }

  async finish(): Promise<void> { await this.flush(true); }

  private async flush(final: boolean): Promise<void> {
    // M28: a line copying the history's `[tools: …]` digest is the server's note, never the user's.
    const text = stripDigests(this.text, !final);
    if (!text || text === this.sent) return;
    // A potential pass waits until prose makes it unambiguous; suppressed text never reaches SSE.
    if (!this.id && (final ? isPass(text, this.reacted) : couldBePass(text, this.reacted))) return;
    const remaining = 125 - (this.clock() - this.last);
    if (remaining > 0) {
      if (!final) return;
      await Bun.sleep(remaining);
    }
    const message = await this.sink.upsertMessage({ ...(this.id ? { id: this.id } : {}), role: "assistant", kind: "text", text });
    this.id = message.id; this.sent = text; this.last = this.clock();
  }
}
