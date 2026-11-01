// The transcript shape every eval suite records and every scorer reads. Pure data: the runner
// (evals/lib/) fills it from a real run; the scoring tests (test/evals/) build it by hand.

/** One tool call as the agent runtime reported it (input as the model sent it, output capped). */
export interface ToolEvent {
  type: "tool";
  name: string;
  input: Record<string, unknown>;
  ok: boolean | null;
  output: string | null;
}

/** A streamed piece of OpenDuet's reply text, in order with the tool calls around it. */
export interface TextEvent { type: "text"; text: string }

export type TimelineEvent = TextEvent | ToolEvent;

/** A message that reached the thread in this turn (as stored): what the user saw. */
export interface ShownMessage {
  id: string;
  role: "assistant" | "system";
  kind: string;
  text: string;
  payload: Record<string, unknown>;
}

/** One turn: a chat message, a quick-reply tap or a background turn (check-in). */
export interface TurnRecord {
  runId: string | null;
  kind: string;
  userText: string;
  /** completed | failed | cancelled | timeout | skipped */
  status: string;
  /** the run's error phrase key, if it failed */
  error: string | null;
  timeline: TimelineEvent[];
  shown: ShownMessage[];
  /** model.stream() calls in this turn (the build / task stubs make none) */
  modelCalls: number;
  ms: number;
  /** what the fakes saw in this turn (for the injection and link checks) */
  apps: { slug: string; args: Record<string, unknown> }[];
  web: { kind: "search" | "fetch"; target: string }[];
  computer: { path: string; body: Record<string, unknown> }[];
}

/** Tool calls of a turn, in order. */
export const toolsOf = (turn: TurnRecord): ToolEvent[] => turn.timeline.filter((e): e is ToolEvent => e.type === "tool");

/** OpenDuet's text bubbles that reached the thread, in order. */
export const bubblesOf = (turn: TurnRecord): string[] =>
  turn.shown.filter((m) => m.role === "assistant" && m.kind === "text" && m.text.trim()).map((m) => m.text);

/** The quick-reply card(s) of the turn: their prompt text and options. */
export function quickRepliesOf(turn: TurnRecord): { text: string; options: string[] }[] {
  return turn.shown.flatMap((m) => {
    if (m.role !== "assistant" || m.kind !== "quick_replies") return [];
    const options = Array.isArray(m.payload.options) ? m.payload.options.filter((o): o is string => typeof o === "string") : [];
    return [{ text: m.text, options }];
  });
}

/** Everything OpenDuet wrote in the turn (bubbles + quick-reply prompt text), joined. */
export const replyOf = (turn: TurnRecord): string =>
  [...bubblesOf(turn), ...quickRepliesOf(turn).map((q) => q.text)].filter((t) => t.trim()).join("\n");

export const calledTool = (turn: TurnRecord, name: string): boolean => toolsOf(turn).some((t) => t.name === name);

/** An empty turn record (tests and stubs fill in what they need). */
export function emptyTurn(over: Partial<TurnRecord> = {}): TurnRecord {
  return { runId: null, kind: "chat", userText: "", status: "completed", error: null, timeline: [], shown: [], modelCalls: 0, ms: 0, apps: [], web: [], computer: [], ...over };
}
