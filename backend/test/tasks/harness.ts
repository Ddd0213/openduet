// Test-only harness for the task tests: the real agent runtime + run host + task module wired
// through createTestApp({ setup }), on a scripted model that keeps one script queue per model role,
// so a chat turn and a task turn running at the same time never take each other's rounds.
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { Message } from "../../src/contract/messages.ts";
import { EventBus } from "../../src/events/bus.ts";
import type { LlmEvent, LlmRequest, ModelConfig, ModelRole, Model, RegisteredLlm } from "../../src/llm/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { UsageMeter } from "../../src/usage/meter.ts";
import { createTestApp, type TestApp, type TestCore } from "../helpers/app.ts";
import { ScriptedModel, type ScriptTurn } from "../helpers/scripted-model.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import type { SseFrames } from "../helpers/sse.ts";

const IDENTITY = { providerId: "scripted-test-only", modelId: "scripted-test-only" };

/** One script queue per role; an empty queue answers with a short text so a stray turn never hangs. */
export class RoleScriptedLlm implements RegisteredLlm {
  readonly requests: LlmRequest[] = [];
  readonly models: ModelConfig = {
    providers: [{ id: IDENTITY.providerId, protocol: "anthropic", baseUrl: "https://test.invalid", apiKeyEnv: "TEST_ONLY_UNUSED" }],
    models: [{ id: IDENTITY.modelId, provider: IDENTITY.providerId, label: "Test only", contextWindow: 128000, maxOutputTokens: 4096, capabilities: { tools: true, vision: false, thinking: false, serverWebTools: false, promptCaching: false } }],
    roles: { chat: [IDENTITY.modelId], task: [IDENTITY.modelId], proactive: [IDENTITY.modelId], utility: [IDENTITY.modelId] },
    timeoutMs: 1000,
  };
  private readonly queues = new Map<ModelRole, ScriptTurn[]>();

  /** Appends rounds (one model call each) to a role's script. */
  script(role: ModelRole, ...turns: ScriptTurn[]): void {
    this.queues.set(role, [...(this.queues.get(role) ?? []), ...turns]);
  }

  remaining(role: ModelRole): number {
    return this.queues.get(role)?.length ?? 0;
  }

  /** Requests sent with this role, oldest first. */
  sent(role: ModelRole): LlmRequest[] {
    return this.requests.filter((r) => r.role === role);
  }

  roleModels(role: ModelRole): Model[] {
    return this.models.roles[role].flatMap((id) => this.models.models.filter((m) => m.id === id));
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
    const turn = this.queues.get(request.role)?.shift() ?? [{ type: "text_delta", text: "(no script)" }];
    yield* new ScriptedModel([turn], IDENTITY).stream(request);
  }
}

export const text = (value: string): LlmEvent => ({ type: "text_delta", text: value });
export const call = (name: string, input: Record<string, unknown>, id: string = crypto.randomUUID()): LlmEvent => ({ type: "tool_call", id, name, input });

/** Agent runtime + run host + task module on one set of core services. */
export function rig(core: Pick<TestCore, "db" | "config" | "events" | "usage" | "files">, llm: RegisteredLlm) {
  const providers: ToolProvider[] = [];
  const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
  const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent });
  const tasks = createTasks({ db: core.db, events: core.events, runs });
  providers.push(...tasks.providers);
  return { agent, runs, tasks, providers };
}

export interface TaskApp { fixture: TestApp; llm: RoleScriptedLlm; tasks: Tasks; alex: SignedIn }

export async function startApp(env: Record<string, string | undefined> = {}): Promise<TaskApp> {
  const llm = new RoleScriptedLlm();
  let built: ReturnType<typeof rig> | undefined;
  const fixture = await createTestApp(env, {
    heartbeatMs: 1000,
    setup: (core) => {
      built = rig(core, llm);
      return { agent: built.agent, runs: built.runs, routes: built.tasks.routes };
    },
  });
  const alex = await signUp(fixture, "alex");
  return { fixture, llm, tasks: built!.tasks, alex };
}

/** A second process on the same database (a restart): new event bus, run host and task module. */
export function restarted(fixture: TestApp, llm: RegisteredLlm) {
  const events = new EventBus(fixture.db);
  const usage = new UsageMeter(fixture.db, fixture.config);
  const next = rig({ db: fixture.db, config: fixture.config, events, usage, files: fixture.files }, llm);
  const app = createApp({ config: fixture.config, db: fixture.db, auth: fixture.auth, events, usage, files: fixture.files, runs: next.runs, heartbeatMs: 1000, routes: next.tasks.routes });
  return { ...next, app, events };
}

export function json(user: SignedIn, method: string, body?: unknown): RequestInit {
  return { method, headers: { ...user.headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

/** A promise you resolve from outside, e.g. to hold a model call until the test lets it go. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export const messagesOf = (f: SseFrames): Message[] => f.events.flatMap((e) => (e.type === "message" ? [e.payload.message] : []));
export const ofType = <T extends DuetEvent["type"]>(f: SseFrames | DuetEvent[], type: T) =>
  (Array.isArray(f) ? f : f.events).filter((e): e is Extract<DuetEvent, { type: T }> => e.type === type);

/** Stored events of a user after an id, as the app would replay them. */
export async function storedEvents(fixture: TestApp, userId: string, afterId = 0): Promise<DuetEvent[]> {
  return fixture.events.replay(userId, afterId);
}

export async function lastEventId(fixture: TestApp): Promise<number> {
  return (await fixture.db.event.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0;
}
