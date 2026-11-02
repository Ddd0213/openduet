// Test-only harness for the proactive and onboarding tests: the real agent runtime + run host +
// connectors (FakeComposio, or none = not configured) + tasks + the proactive module, wired through
// createTestApp({ setup }) on a role-scripted model. A fake notify records pushes; the clock the
// proactive module sees is adjustable; the welcome pacing is 0 ms. Never touches the network.
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { createConnectorsModule, type ConnectorsModule } from "../../src/connectors/module.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { Message } from "../../src/contract/messages.ts";
import type { ModelResolver } from "../../src/llm/index.ts";
import { memoryProvider } from "../../src/memory/provider.ts";
import { createProactive, type NotifyInput, type Proactive } from "../../src/proactive/index.ts";
import { SoulService } from "../../src/soul/service.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { RoleScriptedLlm } from "../tasks/harness.ts";

export { call, deferred, json, RoleScriptedLlm, text } from "../tasks/harness.ts";

export interface ProactiveApp {
  fixture: TestApp;
  llm: RoleScriptedLlm;
  tasks: Tasks;
  connectors: ConnectorsModule;
  proactive: Proactive;
  /** null when Composio isn't configured */
  fake: FakeComposio | null;
  pushes: NotifyInput[];
  alex: SignedIn;
  clock: { now: Date };
  cleanup(): Promise<void>;
}

/** Wednesday 2030-10-23 09:00 UTC unless a test moves it. */
export const DEFAULT_NOW = new Date("2030-10-23T09:00:00.000Z");

/** `builtins` inherits the production module's default (on); tests can explicitly turn it off. */
/** `taskClock`: the task module reads the same fake clock (routines: PATCH schedule / resume). */
/** `memory` (M18c): the memory provider too (remember / followed_up), on the same fake clock. */
/** `triage` (M23, default true): mail triage gets the scripted model's "utility" role through a resolver. */
export async function startProactive(opts: { composio?: boolean; env?: Record<string, string | undefined>; builtins?: boolean; taskClock?: boolean; memory?: boolean; triage?: boolean } = {}): Promise<ProactiveApp> {
  const llm = new RoleScriptedLlm();
  const fake = opts.composio === false ? null : new FakeComposio();
  const pushes: NotifyInput[] = [];
  const clock = { now: DEFAULT_NOW };
  let built: { tasks: Tasks; connectors: ConnectorsModule; proactive: Proactive } | undefined;
  const fixture = await createTestApp(opts.env ?? {}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const providers: ToolProvider[] = [];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent });
      const tasks = createTasks({ db: core.db, events: core.events, runs, ...(opts.taskClock ? { now: () => clock.now } : {}) });
      const connectors = createConnectorsModule({ db: core.db, events: core.events, config: core.config, gateway: fake, resumer: tasks.service });
      const proactive = createProactive({
        db: core.db, runs, usage: core.usage, tasks: tasks.service, catalog: connectors.catalog,
        notify: async (input) => { pushes.push(structuredClone(input)); return "sent"; },
        now: () => clock.now, welcomeDelaysMs: [0, 0], builtins: opts.builtins,
        events: core.events, resolver: opts.triage === false ? null : scriptedResolver(llm),
      });
      providers.push(...connectors.providers, ...tasks.providers, ...proactive.providers);
      if (opts.memory) providers.push(memoryProvider({ db: core.db, soul: new SoulService({ db: core.db }), now: () => clock.now }));
      built = { tasks, connectors, proactive };
      return { agent, runs, routes: [...connectors.routes, ...tasks.routes, ...proactive.routes] };
    },
  });
  const alex = await signUp(fixture, "alex");
  const { tasks, connectors, proactive } = built!;
  return {
    fixture, llm, tasks, connectors, proactive, fake, pushes, alex, clock,
    cleanup: async () => { await proactive.scheduler.stop(); connectors.stop(); await fixture.cleanup(); },
  };
}

/** M23: a resolver that answers every role with the scripted model (triage asks for "utility"). */
export function scriptedResolver(llm: RoleScriptedLlm): ModelResolver {
  const model = llm.models.models[0]!;
  return { resolve: async () => ({ llm, model, thinkingLevel: "off", entryId: "test-entry", label: model.label }) };
}

/** Stored events of a user after an id, in order. */
export const eventsAfter = (app: ProactiveApp, afterId: number): Promise<DuetEvent[]> => app.fixture.events.replay(app.alex.userId, afterId);

export async function lastEventId(app: ProactiveApp): Promise<number> {
  return (await app.fixture.db.event.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0;
}

export const messagesIn = (events: DuetEvent[]): Message[] => events.flatMap((e) => (e.type === "message" ? [e.payload.message] : []));
export const ofType = <T extends DuetEvent["type"]>(events: DuetEvent[], type: T) => events.filter((e): e is Extract<DuetEvent, { type: T }> => e.type === type);

/** The main thread's stored messages, oldest first. */
export async function mainThread(app: ProactiveApp) {
  return app.fixture.db.message.findMany({ where: { channelId: app.alex.mainChannelId, taskId: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

/** Names of the tools offered in a request. */
export const toolNames = (request: { tools?: { name: string }[] } | undefined) => (request?.tools ?? []).map((t) => t.name);
