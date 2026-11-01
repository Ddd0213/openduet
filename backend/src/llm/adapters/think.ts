// Some OpenAI-compatible gateways put the model's reasoning inline, as a <think>…</think> block at the
// very start of the reply text. Split that block off into thinking deltas so it never reaches a bubble.
// Only a block at the start counts (after whitespace); a "<think>" later in the text is left alone.
// Works on streamed chunks: a tag split across chunks is held back until it can be decided.
const OPEN = "<think>";
const CLOSE = "</think>";

export type ThinkPiece = { type: "text" | "thinking"; text: string };

export class ThinkSplitter {
  private state: "start" | "inside" | "after" | "text" = "start";
  private buffer = "";

  push(chunk: string): ThinkPiece[] {
    if (!chunk) return [];
    if (this.state === "text") return [{ type: "text", text: chunk }];
    this.buffer += chunk;
    const out: ThinkPiece[] = [];
    if (this.state === "start") {
      const lead = this.buffer.trimStart();
      if (!lead || (lead.length < OPEN.length && OPEN.startsWith(lead))) return out;
      if (!lead.startsWith(OPEN)) return this.toText(out);
      this.buffer = lead.slice(OPEN.length);
      this.state = "inside";
    }
    if (this.state === "inside") {
      const end = this.buffer.indexOf(CLOSE);
      if (end < 0) {
        // Hold back a tail that could be the start of "</think>".
        let keep = 0;
        for (let n = Math.min(CLOSE.length - 1, this.buffer.length); n > 0; n--) {
          if (CLOSE.startsWith(this.buffer.slice(-n))) { keep = n; break; }
        }
        const thought = this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        if (thought) out.push({ type: "thinking", text: thought });
        return out;
      }
      const thought = this.buffer.slice(0, end);
      if (thought) out.push({ type: "thinking", text: thought });
      this.buffer = this.buffer.slice(end + CLOSE.length);
      this.state = "after";
    }
    // "after": whitespace between the block and the answer is dropped.
    this.buffer = this.buffer.trimStart();
    if (!this.buffer) return out;
    return this.toText(out);
  }

  /** The stream ended: whatever is still held back. An unclosed block stays thinking. */
  end(): ThinkPiece[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest) return [];
    if (this.state === "inside") return [{ type: "thinking", text: rest }];
    if (this.state === "after") return [];
    this.state = "text";
    return [{ type: "text", text: rest }];
  }

  private toText(out: ThinkPiece[]): ThinkPiece[] {
    this.state = "text";
    out.push({ type: "text", text: this.buffer });
    this.buffer = "";
    return out;
  }
}
