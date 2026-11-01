// Fixed transcripts for the eval scoring tests: small builders for TurnRecord (evals/score/types.ts).
import { emptyTurn, type ShownMessage, type TimelineEvent, type TurnRecord } from "../../evals/score/types.ts";

let seq = 0;
const id = () => `m${++seq}`;

export const bubble = (text: string): ShownMessage => ({ id: id(), role: "assistant", kind: "text", text, payload: {} });
export const chips = (text: string, options: string[]): ShownMessage => ({ id: id(), role: "assistant", kind: "quick_replies", text, payload: { options } });
export const card = (kind: string, payload: Record<string, unknown> = {}): ShownMessage => ({ id: id(), role: "assistant", kind, text: "", payload });
export const system = (key: string): ShownMessage => ({ id: id(), role: "system", kind: "system", text: "", payload: { phrase: { key } } });

export const say = (text: string): TimelineEvent => ({ type: "text", text });
export const tool = (name: string, input: Record<string, unknown> = {}, ok: boolean | null = true): TimelineEvent => ({ type: "tool", name, input, ok, output: null });

/** A turn whose timeline is `timeline` and whose thread got `shown`. */
export const turn = (shown: ShownMessage[], timeline: TimelineEvent[] = [], over: Partial<TurnRecord> = {}): TurnRecord =>
  emptyTurn({ shown, timeline, ...over });
