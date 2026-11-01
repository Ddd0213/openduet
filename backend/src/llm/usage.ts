// Conservative text-only estimates when a gateway omits complete token counts.
import type { ContentBlock, LlmRequest, Usage } from "./types.ts";
export function estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  for (const char of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u.test(char)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text": case "thinking": return block.text;
    case "tool_use": return block.name + JSON.stringify(block.input);
    case "tool_result": return block.content.map(blockText).join("");
    case "provider_data": return JSON.stringify(block.data);
    case "image": case "audio": return "";
  }
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : undefined;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export class UsageTracker {
  private anthropicFields: Record<string, unknown> = {};
  private input?: number;
  private output?: number;
  anthropic(value: unknown): void {
    const usage = object(value);
    for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
      if (count(usage[key]) !== undefined) this.anthropicFields[key] = usage[key];
    }
    const input = count(this.anthropicFields.input_tokens);
    if (input !== undefined) this.input = input + (count(this.anthropicFields.cache_creation_input_tokens) ?? 0) + (count(this.anthropicFields.cache_read_input_tokens) ?? 0);
    this.output = count(this.anthropicFields.output_tokens);
  }
  openai(value: unknown): void {
    const usage = object(value);
    this.input = count(usage.prompt_tokens) ?? this.input;
    this.output = count(usage.completion_tokens) ?? this.output;
  }
  finish(request: LlmRequest, output: ContentBlock[]): Usage {
    const inputText = request.system + request.messages.flatMap(m => m.content).map(blockText).join("") + (request.tools ?? []).map(t => t.name + t.description + JSON.stringify(t.inputSchema)).join("");
    return {
      inputTokens: this.input ?? estimateTokens(inputText),
      outputTokens: this.output ?? estimateTokens(output.map(blockText).join("")),
      estimated: this.input === undefined || this.output === undefined,
    };
  }
}
