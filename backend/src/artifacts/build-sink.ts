// The sink of a Make build run (L151): the model's text never reaches the chat. Each finished line
// becomes the build view's status (an `artifact` event's buildStatus), at most one every
// STEP_MIN_INTERVAL_MS plus the last line before each tool call. The status pill and typing dots
// stay off the chat header; cards a tool posts (approvals, system lines) pass through unchanged.
import type { TurnSink } from "../agent/types.ts";
import type { Message } from "../contract/messages.ts";

export const STEP_MIN_INTERVAL_MS = 500;
const STEP_MAX = 140;

function clean(line: string): string {
  const text = line.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "").replace(/[*_`]+/g, "").trim();
  return text.length <= STEP_MAX ? text : `${text.slice(0, STEP_MAX - 1).trimEnd()}…`;
}

/** The step line in the model's text so far: its last complete line, or its last line when final. */
export function stepLine(text: string, final: boolean): string | null {
  const lines = text.split(/\r?\n/);
  const complete = final ? lines : lines.slice(0, -1);
  for (let i = complete.length - 1; i >= 0; i--) {
    const line = clean(complete[i]!);
    if (line) return line;
  }
  return null;
}

export interface BuildSinkContext {
  channelId: string;
  taskId: string | null;
  /** shows one step line in the build view */
  step(text: string): Promise<void>;
}

export function buildSink(raw: TurnSink, ctx: BuildSinkContext): TurnSink {
  let bubble: string | null = null;
  let text: string | null = null;
  let last: string | null = null;
  let lastAt = 0;
  let counter = 0;

  const show = async (line: string | null, force: boolean) => {
    if (!line || line === last) return;
    const at = Date.now();
    if (!force && at - lastAt < STEP_MIN_INTERVAL_MS) return;
    last = line;
    lastAt = at;
    await ctx.step(line);
  };
  const flush = async () => {
    if (text === null) return;
    const final = stepLine(text, true);
    text = null;
    await show(final, true);
  };

  return {
    // Called before every tool call and at the end of the turn: the line so far is complete.
    status: async () => { await flush(); },
    typing: async () => {},
    upsertMessage: async (draft) => {
      if (draft.role !== "assistant" || draft.kind !== "text") return raw.upsertMessage(draft);
      const id = draft.id ?? `build_step_${++counter}`;
      if (bubble !== null && id !== bubble) await flush();
      bubble = id;
      text = draft.text;
      await show(stepLine(draft.text, false), false);
      return stepMessage(id, draft.text, ctx);
    },
  };
}

/** What the agent's bubble writer gets back for a step it thinks it wrote (never stored). */
function stepMessage(id: string, text: string, ctx: BuildSinkContext): Message {
  const at = new Date().toISOString();
  return {
    id, channelId: ctx.channelId, taskId: ctx.taskId, role: "assistant", kind: "text", text, status: "sent",
    clientId: null, reactions: [], stopped: false, callId: null, createdAt: at, updatedAt: at, payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null },
  };
}
