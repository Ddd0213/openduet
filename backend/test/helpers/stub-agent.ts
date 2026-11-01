// Test-only AgentRuntime: records every turn and runs a scripted body against the real sink.
import type { AgentRuntime, TurnInput, TurnResult } from "../../src/agent/types.ts";

export interface StubAgent extends AgentRuntime { turns: TurnInput[] }

export function stubAgent(script: (input: TurnInput) => Promise<TurnResult>): StubAgent {
  const turns: TurnInput[] = [];
  return {
    turns,
    runTurn: async (input) => {
      turns.push(input);
      return script(input);
    },
  };
}

export const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, estimated: false });
export const MODEL = { providerId: "test", modelId: "scripted-1" };

/** Thinking -> one reply bubble -> completed, with the given token counts. */
export function replying(text: string, tokens = usage(10, 5)) {
  return stubAgent(async ({ sink, onFirstEvent }) => {
    await sink.status("thinking");
    // Like the real runtime: the model's first streamed event marks the user's message seen.
    await onFirstEvent?.();
    await sink.typing(true);
    await sink.upsertMessage({ role: "assistant", kind: "text", text });
    return { status: "completed", error: null, usage: tokens, model: MODEL };
  });
}
