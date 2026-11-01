// M27: preserve model block order for finish_task. The runtime streams every text bubble BEFORE
// executing the round's tools, so message timestamps alone cannot identify text after a tool call.
import type { ContentBlock } from "../llm/index.ts";
import { stripDigests } from "../runs/takeover.ts";

const after = new Map<string, Map<string, string>>();

export function noteFinishText(runId: string, blocks: readonly ContentBlock[]): void {
  const calls = new Map<string, string>();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type === "tool_use" && block.name === "finish_task") {
      calls.set(block.id, stripDigests(blocks.slice(i + 1).flatMap(b => b.type === "text" ? [b.text] : []).join("")));
    }
  }
  if (calls.size) after.set(runId, calls);
}

export function finishTextAfter(runId: string, callId?: string): string | undefined {
  return callId ? after.get(runId)?.get(callId) : undefined;
}

export function clearFinishText(runId: string): void { after.delete(runId); }
