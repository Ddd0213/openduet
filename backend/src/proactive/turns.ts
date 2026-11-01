// Per-run state of a proactive turn (brief, check-in, Up next scan, first-day scan) and the sink
// filter that keeps check-ins and scans quiet: what the model writes as plain text in a check-in
// (or anything chat-shaped in an Up next scan) never reaches the thread. Only the post_message
// and (M18c) share_finding tools (which write to the unfiltered sink) speak in a check-in.
import type { TurnSink } from "../agent/types.ts";
import type { Message } from "../contract/messages.ts";
import type { ServerReads } from "./reads.ts";

export type ProactiveMode = "brief" | "checkin" | "upnext_scan" | "first_day";

export interface TurnState {
  mode: ProactiveMode;
  runId: string;
  /** something reached the user's thread (a message or a card) */
  visible: boolean;
  /** something was done for the user without a message (an Up next item) */
  acted: boolean;
  /** the first text bubble of the turn (the brief's "Morning, ..." line), for the push */
  firstTextId: string | null;
  firstText: string;
  /** start_first_step tasks in a brief, add_up_next items in a check-in / scan */
  steps: number;
  items: number;
  /** M18c: share_finding already called in this turn (at most once per run) */
  finding: boolean;
  /** the host's sink, for the tools that must write even while the turn is filtered */
  raw: TurnSink | null;
  /** M23: the last text bubble of the turn (the brief's message: TextPayload.brief and the unchecked line) */
  lastTextId: string | null;
  lastText: string;
  /**
   * M23: what the server read before the model (reads.ts): undefined = this turn doesn't read
   * (scans), null = the reads themselves failed (the model reads with its own tools).
   */
  reads?: ServerReads | null;
}

export const newTurnState = (mode: ProactiveMode, runId: string): TurnState => ({
  mode, runId, visible: false, acted: false, firstTextId: null, firstText: "", steps: 0, items: 0, finding: false, raw: null, lastTextId: null, lastText: "",
});

/** Message kinds the model can't put in the thread in this mode (approvals, alerts and system lines always pass). */
const MUTED: Record<ProactiveMode, ReadonlySet<string>> = {
  brief: new Set(),
  first_day: new Set(),
  checkin: new Set(["text"]),
  upnext_scan: new Set(["text", "quick_replies", "task_suggestions", "proactive_suggestion"]),
};

/** Muted kinds that only a tool posts (text and quick replies come from the model's own writing). */
const CARD_KINDS: ReadonlySet<string> = new Set(["task_suggestions", "proactive_suggestion"]);

export class MutedCardError extends Error {
  constructor(kind: string) {
    super(`${kind} cards aren't shown in this kind of turn`);
    this.name = "MutedCardError";
  }
}

/** A stand-in for a dropped draft, so the bubble writer can keep "updating" it. Never stored. */
function placeholder(id: string, channelId: string, kind: string): Message {
  const at = new Date().toISOString();
  return { id, channelId, taskId: null, role: "assistant", kind, text: "", status: "sent", clientId: null, reactions: [], createdAt: at, updatedAt: at, payload: {} } as unknown as Message;
}

/**
 * The sink the agent gets for a proactive turn: tracks what became visible (and the first text
 * line), and in a check-in / scan drops muted drafts and never turns typing on.
 */
export function filteredSink(raw: TurnSink, state: TurnState, channelId: string): TurnSink {
  state.raw = raw;
  const muted = MUTED[state.mode];
  const quiet = muted.has("text");
  return {
    status: (status) => raw.status(status),
    typing: (on) => (quiet && on ? Promise.resolve() : raw.typing(on)),
    async upsertMessage(draft) {
      // Cards a tool posts can't be dropped silently (the tool would report them as shown): the
      // tool call fails instead, and the model goes on with the tools this mode is for.
      if (draft.role === "assistant" && muted.has(draft.kind) && CARD_KINDS.has(draft.kind)) throw new MutedCardError(draft.kind);
      if (draft.role === "assistant" && muted.has(draft.kind)) return placeholder(draft.id ?? `muted_${crypto.randomUUID()}`, channelId, draft.kind);
      const message = await raw.upsertMessage(draft);
      if (draft.role === "assistant") state.visible = true;
      if (draft.kind === "text" && (state.firstTextId === null || state.firstTextId === message.id)) {
        state.firstTextId = message.id;
        state.firstText = draft.text;
      }
      if (draft.role === "assistant" && draft.kind === "text") {
        state.lastTextId = message.id;
        state.lastText = draft.text;
      }
      return message;
    },
  };
}

/** The first non-empty line of the brief, without markdown emphasis, for the push body. */
export function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const plain = line.replace(/\*\*|__/g, "").replace(/^#+\s*/, "");
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
}
