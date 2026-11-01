// Shared fixture for the M3 connector / approval tests: the real app + run host + agent runtime
// with a scripted model, the connectors module on a FakeComposio (or none = not configured), an
// adjustable clock and a recording TaskResumer. Never touches the network.
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { TaskResumer } from "../../src/agent/types.ts";
import { createConnectorsModule, type ConnectorsModule } from "../../src/connectors/module.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { LlmEvent, ToolResultBlock } from "../../src/llm/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { RegisteredScriptedModel, type ScriptEvent, type ScriptTurn } from "../helpers/scripted-model.ts";
import type { SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";

export type Outcome = Parameters<TaskResumer["resumeAfterApproval"]>[1];

export class RecordingResumer implements TaskResumer {
  calls: { taskId: string; outcome: Outcome }[] = [];
  async resumeAfterApproval(taskId: string, outcome: Outcome): Promise<void> {
    this.calls.push({ taskId, outcome });
  }
}

export const tool = (name: string, input: Record<string, unknown>, id: string = crypto.randomUUID()): LlmEvent => ({ type: "tool_call", id, name, input });
export const say = (value: string): LlmEvent => ({ type: "text_delta", text: value });
/** One execute_app_tools call with the given nested calls. */
export const execute = (...calls: { tool: string; arguments?: Record<string, unknown> }[]): LlmEvent => tool("execute_app_tools", { calls });

export interface Harness {
  fixture: TestApp;
  fake: FakeComposio | null;
  module: ConnectorsModule;
  llm: RegisteredScriptedModel;
  resumer: RecordingResumer;
  /** queue the next model turns; once empty every turn answers "Done." */
  script(...turns: ScriptTurn[]): void;
  /** milliseconds added to the real clock (Prisma timestamps are real time) */
  advance(ms: number): void;
  send(user: SignedIn, text: string): Promise<SseFrames>;
  /** the tool results the model got in its latest request, parsed */
  lastResults(): { block: ToolResultBlock; data: Record<string, unknown> }[];
  decide(user: SignedIn, id: string, action: "approve" | "decline", version: unknown): Promise<Response>;
  get(user: SignedIn | null, path: string, init?: RequestInit): Promise<Response>;
  /** records every event of a user until stop() */
  record(userId: string): { events: DuetEvent[]; stop(): void };
  /** a task-session turn through the real run host; resolves after its `done` */
  runTask(user: SignedIn, taskId: string, prompt: string): Promise<void>;
  cleanup(): Promise<void>;
}

const DONE: readonly ScriptEvent[] = [say("Done.")];

export async function connectorHarness(opts: { configured?: boolean } = {}): Promise<Harness> {
  const fake = opts.configured === false ? null : new FakeComposio();
  const queue: ScriptTurn[] = [];
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const resumer = new RecordingResumer();
  const next: ScriptTurn = async (request) => {
    const turn = queue.shift();
    if (!turn) return DONE;
    return typeof turn === "function" ? turn(request) : turn;
  };
  // Every model call takes the next queued turn (the scripted model's own list never runs out).
  const llm = new RegisteredScriptedModel(Array.from({ length: 2000 }, () => next));
  let module!: ConnectorsModule;
  const fixture = await createTestApp({}, {
    setup: ({ db, events, config }) => {
      module = createConnectorsModule({ db, events, config, gateway: fake, now, resumer });
      return { agent: createAgentRuntime({ db, llm, config, providers: module.providers }), routes: module.routes };
    },
  });
  let sent = 0;
  return {
    fixture, fake, module, llm, resumer,
    script: (...turns) => { queue.push(...turns); },
    advance: (ms) => { offset += ms; },
    async send(user, text) {
      const response = await fixture.app.request(`/api/channels/${user.mainChannelId}/messages`, {
        method: "POST", headers: { ...user.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ text, clientId: `c-${++sent}` }),
      });
      if (response.status !== 200) throw new Error(`send failed: ${response.status} ${await response.text()}`);
      const frames = await readSse(response, { timeoutMs: 10_000 });
      if (queue.length) throw new Error(`${queue.length} scripted turn(s) left unused`);
      return frames;
    },
    lastResults() {
      const last = llm.requests.at(-1)?.messages.at(-1);
      return (last?.content ?? []).flatMap((block) => block.type === "tool_result"
        ? [{ block, data: JSON.parse(block.content[0]?.type === "text" ? block.content[0].text : "null") as Record<string, unknown> }]
        : []);
    },
    decide: (user, id, action, version) => Promise.resolve(fixture.app.request(`/api/approvals/${id}/${action}`, {
      method: "POST", headers: { ...user.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version }),
    })),
    get: (user, path, init = {}) => Promise.resolve(fixture.app.request(path, {
      ...init, headers: { ...(user?.headers ?? {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) },
    })),
    record(userId) {
      const events: DuetEvent[] = [];
      const stop = fixture.events.subscribe(userId, (event) => { events.push(event); });
      return { events, stop };
    },
    async runTask(user, taskId, prompt) {
      const runIds = new Set<string>();
      let finish!: (ok: boolean) => void;
      const finished = new Promise<boolean>((resolve) => { finish = resolve; });
      const seen: string[] = [];
      const stop = fixture.events.subscribe(user.userId, (event) => {
        if (event.type !== "done") return;
        seen.push(event.payload.runId);
        if (runIds.has(event.payload.runId)) finish(true);
      });
      const timer = setTimeout(() => finish(false), 10_000);
      try {
        const runId = await fixture.runs.submit({ userId: user.userId, channelId: user.mainChannelId, taskId, kind: "task", prompt });
        if (!runId) throw new Error("submit refused");
        runIds.add(runId);
        if (seen.includes(runId)) finish(true);
        if (!(await finished)) throw new Error("task turn timed out");
      } finally {
        clearTimeout(timer);
        stop();
      }
      if (queue.length) throw new Error(`${queue.length} scripted turn(s) left unused`);
    },
    cleanup: async () => { module.stop(); await fixture.cleanup(); },
  };
}

/** Events of one type, in order. */
export function eventsOf<T extends DuetEvent["type"]>(events: readonly DuetEvent[], type: T): Extract<DuetEvent, { type: T }>[] {
  return events.filter((e): e is Extract<DuetEvent, { type: T }> => e.type === type);
}

export const statuses = (frames: SseFrames) => eventsOf(frames.events, "status").map((e) => e.payload.status);
