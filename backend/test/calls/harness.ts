// Test-only harness for M13: the real models module (vault with a fixed key, scripted model layer),
// the real agent runtime + run host + tasks, the calls module with a fake Gemini token endpoint and
// a fake clock. A test-only tool provider posts a card (cards in a call turn stay visible). No real
// network, no real model calls.
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { createCallsModule, type CallsModule } from "../../src/calls/index.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import type { Fetch, LlmEvent, LlmRequest, ModelIdentity } from "../../src/llm/index.ts";
import { ModelsDevCatalog } from "../../src/models/catalog.ts";
import { createModelsModule, type ModelsModule } from "../../src/models/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { RunRecorder } from "../../src/runs/steps.ts";
import { createTasks } from "../../src/tasks/index.ts";
import { Vault } from "../../src/vault/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { FakeNet, Scripts, VAULT_KEY } from "../models/harness.ts";

import { text } from "../tasks/harness.ts";
export { call as toolCall, text } from "../tasks/harness.ts";
export const GEMINI_KEY = "AIza-test-gemini-key-0123456789";
export const STEP_KEY = "step-test-realtime-key-ZXCVB98765";

export interface Minted { url: string; headers: Headers; body: Record<string, unknown>; redirect: RequestInit["redirect"] }

/** The Gemini token endpoint (v1alpha/auth_tokens), in memory. */
export class FakeGoogle {
  readonly mints: Minted[] = [];
  status = 200;
  token = "auth_tokens/test-token-1";
  down = false;
  /** set: each mint waits for it after being recorded (a test lands something meanwhile) */
  hold: Promise<void> | null = null;
  readonly fetch: Fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.mints.push({ url, headers, body, redirect: init?.redirect });
    if (this.hold) await this.hold;
    if (this.down) throw new TypeError("fetch failed");
    if (this.status !== 200) return new Response(`{"error":"bad key ${headers.get("x-goog-api-key")}"}`, { status: this.status });
    return new Response(JSON.stringify({ name: this.token }), { headers: { "content-type": "application/json" } });
  };
}

/** A model turn streamed live: `first`, then (after release()) `rest`, in one round (one bubble). */
export interface PausedTurn { reached: Promise<void>; release: () => void }
type LiveTurn = (request: LlmRequest, model: ModelIdentity) => AsyncIterable<LlmEvent>;

/** Live turns go before the scripts: the next model call of any model streams the first one. */
export class LiveTurns {
  private readonly queue: LiveTurn[] = [];

  paused(first: string, rest: string): PausedTurn {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    this.queue.push(async function* (request, model) {
      yield { type: "text_delta", text: first };
      // resumed once the agent wrote the first delta's bubble (it pulls the next event after that)
      reached();
      await gate;
      yield { type: "text_delta", text: rest };
      const text = `${first}${rest}`;
      yield { type: "done", stopReason: "end_turn", message: { role: "assistant", content: [{ type: "text", text }] }, model: request.pin ?? model };
    });
    return { reached: reachedP, release };
  }

  wrap(build: Scripts["build"]): Scripts["build"] {
    return (config, opts) => {
      const llm = build(config, opts);
      const model = config.models[0]!;
      const identity = { providerId: model.provider, modelId: model.id };
      return { ...llm, stream: (request) => this.queue.shift()?.(request, identity) ?? llm.stream(request) };
    };
  }
}

/** A scripted turn that waits for release() (or the turn's abort). */
export function heldTurn(reply = "Done.") {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => { reached = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  const turn = async (request: LlmRequest) => {
    reached();
    const ok = await new Promise<boolean>((resolve) => {
      if (request.signal?.aborted) return resolve(false);
      request.signal?.addEventListener("abort", () => resolve(false), { once: true });
      void releaseP.then(() => resolve(true));
    });
    if (!ok) throw new Error("aborted");
    return [text(reply)];
  };
  return { turn, reached: reachedP, release };
}

export interface CallsApp {
  fixture: TestApp;
  scripts: Scripts;
  live: LiveTurns;
  google: FakeGoogle;
  models: ModelsModule;
  calls: CallsModule;
  runs: RunHost;
  recorder: RunRecorder;
  vault: Vault;
  alex: SignedIn;
  clock: { now: number };
}

/** `post_card` (test only): posts a confirmation card through the sink. */
const cardProvider: ToolProvider = {
  name: "test-card",
  tools: async () => [{ name: "post_card", description: "test only", inputSchema: { type: "object", properties: {} } }],
  execute: async (call, input) => {
    await input.sink.upsertMessage({ role: "assistant", kind: "confirmation", payload: { title: "Order placed", detail: "4 sets", app: null } });
    return { result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: "posted" }] }, endTurn: false };
  },
};

export async function startCallsApp(opts: { progressGapMs?: number; idleMs?: number; handoffGraceMs?: number; noResolver?: boolean; fetch?: Fetch } = {}): Promise<CallsApp> {
  const scripts = new Scripts();
  const live = new LiveTurns();
  const google = new FakeGoogle();
  const net = new FakeNet();
  const clock = { now: Date.parse("2026-11-02T18:00:00.000Z") };
  let built: Omit<CallsApp, "fixture" | "alex" | "scripts" | "live" | "google" | "clock"> | undefined;
  const fixture = await createTestApp({}, {
    setup: (core) => {
      const vault = new Vault(core.db, { key: VAULT_KEY });
      const recorder = new RunRecorder({ db: core.db });
      const models = createModelsModule({
        db: core.db, events: core.events, vault, legacy: null, config: core.config, env: {},
        onSecret: (secret) => recorder.addSecret(secret), fetch: net.fetch,
        catalog: new ModelsDevCatalog({ fetch: net.fetch }), buildLlm: live.wrap(scripts.build),
      });
      const providers: ToolProvider[] = [cardProvider];
      const agent = createAgentRuntime({ db: core.db, resolver: models.resolver, config: core.config, providers });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent, recorder });
      const tasks = createTasks({ db: core.db, events: core.events, runs });
      providers.push(...tasks.providers);
      const calls = createCallsModule({
        db: core.db, events: core.events, runs, realtime: models.realtime, resolver: opts.noResolver ? null : models.resolver,
        fetch: opts.fetch ?? google.fetch, now: () => new Date(clock.now),
        ...(opts.progressGapMs !== undefined ? { progressGapMs: opts.progressGapMs } : {}),
        ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
        ...(opts.handoffGraceMs !== undefined ? { handoffGraceMs: opts.handoffGraceMs } : {}),
      });
      built = { models, calls, runs, recorder, vault };
      return { agent, runs, routes: [...tasks.routes, ...models.routes, ...calls.routes] };
    },
  });
  const alex = await signUp(fixture, "alex");
  return { fixture, scripts, live, google, clock, alex, ...built! };
}

type Body = Record<string, unknown>;
export async function req(t: Pick<CallsApp, "fixture">, user: SignedIn | null, method: string, path: string, body?: Body) {
  const response = await t.fixture.app.request(path, {
    method, headers: { ...(user?.headers ?? {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers, body: text ? JSON.parse(text) : null };
}

let names = 0;
/** A gemini / stepfun provider with its key in the vault and one realtime model (direct rows). */
export async function realtimeModel(t: CallsApp, user: SignedIn, kind: "gemini" | "stepfun", opts: { key?: string | null; modelId?: string; status?: string } = {}) {
  const db = t.fixture.db;
  const provider = await db.modelProvider.create({ data: {
    userId: user.userId, kind, protocol: "openai", name: `${kind}-${++names}`, status: opts.status ?? "active",
    baseUrl: kind === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "https://api.stepfun.com/v1",
  } });
  const key = opts.key === undefined ? (kind === "gemini" ? GEMINI_KEY : STEP_KEY) : opts.key;
  if (key) await t.vault.put(user.userId, "provider", provider.id, "key", key);
  const entry = await db.modelEntry.create({ data: {
    userId: user.userId, providerId: provider.id, purpose: "realtime", label: kind, contextWindow: 32000, maxOutputTokens: 8000,
    modelId: opts.modelId ?? (kind === "gemini" ? "gemini-live-2.5-flash" : "step-audio-2"),
  } });
  return { providerId: provider.id, entryId: entry.id, modelId: entry.modelId };
}

/** An OpenAI chat model as the default (the chat turns and the utility title run on it). */
export async function chatModel(t: CallsApp, user: SignedIn) {
  const db = t.fixture.db;
  const provider = await db.modelProvider.create({ data: { userId: user.userId, kind: "openai", protocol: "openai", name: `openai-${++names}`, baseUrl: "https://api.openai.com/v1" } });
  await t.vault.put(user.userId, "provider", provider.id, "key", "sk-test-chat-key-0000");
  const entry = await db.modelEntry.create({ data: { userId: user.userId, providerId: provider.id, purpose: "chat", label: "GPT A", modelId: "gpt-a", contextWindow: 128000, maxOutputTokens: 4096 } });
  await db.user.update({ where: { id: user.userId }, data: { defaultModelId: entry.id } });
  return entry.id;
}

export async function channel(t: CallsApp, user: SignedIn, name = "Bike shop", extra: { useSharedMemory?: boolean; purpose?: string } = {}) {
  return (await t.fixture.db.channel.create({ data: { userId: user.userId, isMain: false, name, purpose: extra.purpose ?? "", useSharedMemory: extra.useSharedMemory ?? true } })).id;
}

/** Stored events of a type (the SSE log), oldest first. */
export async function eventsOf<T extends DuetEvent["type"]>(t: CallsApp, userId: string, type: T, afterId = 0) {
  const all = await t.fixture.events.replay(userId, afterId);
  return all.filter((e): e is Extract<DuetEvent, { type: T }> => e.type === type);
}

export const line = (id: string, from: "user" | "voice", text: string, at = "2026-11-02T18:00:05.000Z") => ({ id, from, text, at });

/** Waits for the run host and the cue watcher to settle. */
export async function settle(t: CallsApp): Promise<void> {
  await t.runs.idle();
  await t.calls.cues.idle();
}

/** Stops the cue watcher's timers, then removes the test database. */
export async function stopCallsApp(t: CallsApp): Promise<void> {
  t.calls.stop();
  await t.fixture.cleanup();
}
