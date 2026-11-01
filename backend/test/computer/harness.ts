// Test-only rig for the computer tests: the real app, run host, agent runtime and approval service,
// the computer module on the fake computer (injected fetch, no port), RoleScriptedLlm for the model
// (test/tasks/harness.ts), a recorded notifier and the provider's tool results as they happen.
import type { ToolProvider, RunKind } from "../../src/agent/types.ts";
import { createApp } from "../../src/app.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { createConnectorsModule, type ConnectorsModule } from "../../src/connectors/module.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { createComputerModule, type ComputerModule } from "../../src/computer/index.ts";
import type { NotifyInput } from "../../src/notify/notifier.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { RoleScriptedLlm } from "../tasks/harness.ts";
import { FAKE_TOKEN, FAKE_URL, FakeComputer } from "./fake-computer.ts";

export { call, text } from "../tasks/harness.ts";

export interface ToolRecord { name: string; data: Record<string, unknown>; endTurn: boolean; isError: boolean; images: number }

export interface ComputerRig {
  fixture: TestApp;
  fake: FakeComputer;
  llm: RoleScriptedLlm;
  computer: ComputerModule;
  connectors: ConnectorsModule;
  alex: SignedIn;
  notified: NotifyInput[];
  continued: { userId: string; channelId: string; kind: RunKind; prompt: string }[];
  results: ToolRecord[];
  send(user: SignedIn, text: string, extra?: Record<string, unknown>): Promise<SseFrames>;
  api(user: SignedIn | null, path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  /** resolves once `predicate` holds for an event of this user */
  waitFor(userId: string, predicate: (event: DuetEvent) => boolean, timeoutMs?: number): Promise<DuetEvent>;
  setVision(on: boolean): void;
  cleanup(): Promise<void>;
}

export async function computerRig(opts: {
  configured?: boolean; waitMs?: { chat: number; background: number }; signInTtlMs?: number; connect?: (url: string) => WebSocket;
  /** extra env (e.g. COMPUTER_OWNER) */
  env?: Record<string, string>;
  /** which build runs count as user-started (index.ts: artifacts.service.userStarted); default none */
  trustedBuild?: (runId: string) => boolean;
  /** M20: the service clock (auto hand back) and its idle time */
  now?: () => number;
  handBackMs?: number;
} = {}): Promise<ComputerRig> {
  const fake = new FakeComputer();
  const llm = new RoleScriptedLlm();
  const notified: NotifyInput[] = [];
  const continued: ComputerRig["continued"] = [];
  const results: ToolRecord[] = [];
  let computer!: ComputerModule;
  let connectors!: ConnectorsModule;
  let runs!: RunHost;
  const env = { ...(opts.configured === false ? {} : { COMPUTER_URL: FAKE_URL, COMPUTER_TOKEN: FAKE_TOKEN }), ...(opts.env ?? {}) };
  const fixture = await createTestApp(env, {
    heartbeatMs: 1000,
    setup: (core) => {
      connectors = createConnectorsModule({ db: core.db, events: core.events, config: core.config, gateway: null });
      computer = createComputerModule({
        db: core.db, events: core.events, files: core.files, config: core.config, connections: core.connections, llm, policy: connectors.policy, approvals: connectors.approvals,
        notify: async (input) => { notified.push(input); return "local_only"; },
        fetch: fake.fetch, connect: opts.connect, waitMs: opts.waitMs ?? { chat: 5_000, background: 5_000 }, copyWaitMs: 5_000, signInTtlMs: opts.signInTtlMs,
        now: opts.now, handBackMs: opts.handBackMs,
      });
      const recording: ToolProvider = {
        ...computer.provider,
        async execute(toolCall, input) {
          const out = await computer.provider.execute(toolCall, input);
          const first = out.result.content[0];
          results.push({
            name: toolCall.name, endTurn: out.endTurn, isError: !!out.result.isError,
            data: first?.type === "text" ? JSON.parse(first.text) as Record<string, unknown> : {},
            images: out.result.content.filter((b) => b.type === "image").length,
          });
          return out;
        },
      };
      const providers: ToolProvider[] = [...connectors.providers, recording];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent });
      if (opts.trustedBuild) computer.setTrustedBuild(opts.trustedBuild);
      computer.setContinueRun(async (input) => {
        continued.push({ userId: input.userId, channelId: input.channelId, kind: input.kind, prompt: input.prompt });
        await runs.submit({ userId: input.userId, channelId: input.channelId, taskId: input.taskId, kind: input.kind, prompt: input.prompt });
      });
      return { agent, runs, routes: [...computer.routes, ...connectors.routes] };
    },
  });
  // M26: mirror the production AppDeps wiring (owned by the main agent).
  fixture.app = createApp({ ...fixture, ...{ fileWorkspace: computer.workspace }, routes: [...computer.routes, ...connectors.routes] });
  const alex = await signUp(fixture, "alex");
  let sent = 0;
  const api: ComputerRig["api"] = (user, path, init = {}) => Promise.resolve(fixture.app.request(path, {
    method: init.method ?? "GET",
    headers: { ...(user?.headers ?? {}), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  }));
  return {
    fixture, fake, llm, computer, connectors, alex, notified, continued, results, api,
    async send(user, value, extra = {}) {
      const response = await api(user, `/api/channels/${user.mainChannelId}/messages`, { method: "POST", body: { text: value, clientId: `c-${++sent}`, ...extra } });
      if (response.status !== 200) throw new Error(`send failed: ${response.status} ${await response.text()}`);
      return readSse(response, { timeoutMs: 20_000 });
    },
    waitFor(userId, predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error("timed out waiting for an event")); }, timeoutMs);
        const stop = fixture.events.subscribe(userId, (event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          stop();
          resolve(event);
        });
      });
    },
    setVision(on) {
      for (const model of llm.models.models) (model.capabilities as { vision: boolean }).vision = on;
    },
    async cleanup() {
      computer.stop();
      connectors.stop();
      await fixture.cleanup();
      fake.cleanup();
    },
  };
}

export const messagesOf = (frames: SseFrames | DuetEvent[]) => (Array.isArray(frames) ? frames : frames.events).flatMap((e) => (e.type === "message" ? [e.payload.message] : []));
export const statusesOf = (frames: SseFrames) => frames.events.flatMap((e) => (e.type === "status" ? [e.payload.status] : []));
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
