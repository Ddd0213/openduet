// Wraps the production agent runtime: records each run's timeline (reply text and tool calls, in
// order, as the runtime reports them through TurnInput.steps) and stubs the turns an eval doesn't
// want to pay for: a Make build ends without a page (so it fails the honest way, "OpenDuet couldn't
// finish this", with no reason), a background task or routine run is cancelled before the model.
import type { AgentRuntime, RunKind, RunSteps, TurnInput, TurnResult } from "../../src/agent/types.ts";
import type { TimelineEvent, ToolEvent } from "../score/types.ts";

const OUTPUT_MAX = 2000;
const NO_USAGE = { inputTokens: 0, outputTokens: 0, estimated: false };

export interface RunLog { runId: string; kind: RunKind; stubbed: boolean; timeline: TimelineEvent[] }

function tee(log: RunLog, inner: RunSteps | undefined): RunSteps {
  const open = new Map<string, ToolEvent>();
  let seq = 0;
  let text: { type: "text"; text: string } | null = null;
  return {
    text(delta) {
      if (!text) { text = { type: "text", text: "" }; log.timeline.push(text); }
      text.text += delta;
      inner?.text(delta);
    },
    thinking(delta) { inner?.thinking(delta); },
    endRound() { text = null; inner?.endRound(); },
    toolStart(call) {
      text = null;
      const event: ToolEvent = { type: "tool", name: call.name, input: structuredClone(call.input), ok: null, output: null };
      log.timeline.push(event);
      const handle = inner ? inner.toolStart(call) : `eval-${++seq}`;
      open.set(handle, event);
      return handle;
    },
    toolEnd(handle, outcome) {
      const event = open.get(handle);
      if (event) {
        open.delete(handle);
        if (typeof outcome === "string") { event.ok = false; event.output = outcome; }
        else {
          event.ok = !outcome.isError;
          const out = outcome.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
          event.output = out.length > OUTPUT_MAX ? `${out.slice(0, OUTPUT_MAX)}…` : out;
        }
      }
      inner?.toolEnd(handle, outcome);
    },
  };
}

export class TurnRecorder implements AgentRuntime {
  private readonly logs = new Map<string, RunLog>();

  constructor(private readonly inner: AgentRuntime, private stub: ReadonlySet<RunKind> = new Set(["build", "task", "routine"])) {}

  setStubbedKinds(kinds: ReadonlySet<RunKind>): void { this.stub = kinds; }

  log(runId: string): RunLog | undefined {
    return this.logs.get(runId);
  }

  /** Runs that were stubbed (builds, tasks, routines), oldest first. */
  stubbed(): RunLog[] {
    return [...this.logs.values()].filter((l) => l.stubbed);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const kind: RunKind = input.kind ?? (input.taskId === null ? "chat" : "task");
    const stubbed = this.stub.has(kind);
    const log: RunLog = { runId: input.runId, kind, stubbed, timeline: [] };
    this.logs.set(input.runId, log);
    if (stubbed) {
      // A build that ends without finish_build fails with "not finished" (artifacts/service.ts settle);
      // a cancelled task turn changes nothing on its task (tasks/service.ts afterTurn).
      return kind === "build"
        ? { status: "completed", error: null, usage: { ...NO_USAGE }, model: null }
        : { status: "cancelled", error: null, usage: { ...NO_USAGE }, model: null };
    }
    return this.inner.runTurn({ ...input, steps: tee(log, input.steps) });
  }
}
