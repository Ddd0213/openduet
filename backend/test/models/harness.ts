// Test-only harness for M12: the real models module (vault with a fixed key, fake network for the
// providers' lists and models.dev), the real agent runtime with the resolver, the run host, the
// task module and the model_error card. The model layer is scripted per built model (one
// RegisteredLlm per resolved turn, as in production) unless `realLlm` routes it through createLlm
// over the same fake network. No real network, no real model calls.
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { LlmError, type Fetch, type LlmEvent, type LlmOptions, type LlmRequest, type Model, type ModelConfig, type ModelRole, type RegisteredLlm } from "../../src/llm/index.ts";
import { ModelsDevCatalog } from "../../src/models/catalog.ts";
import { createModelsModule, type ModelsModule } from "../../src/models/index.ts";
import { createProactive, type Proactive } from "../../src/proactive/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { RunRecorder } from "../../src/runs/steps.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { Vault } from "../../src/vault/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { ScriptedModel, type ScriptTurn } from "../helpers/scripted-model.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";

export const VAULT_KEY = Buffer.alloc(32, 7);
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface Call { url: string; method: string; headers: Headers; body: string }

/** The providers' /models, models.dev and (with realLlm) the chat endpoints, all in memory. */
export class FakeNet {
  readonly calls: Call[] = [];
  /** host -> status for its model list (default 200) */
  readonly listStatus = new Map<string, number>();
  /** host -> its model list body (default: gpt-a, gpt-b) */
  readonly lists = new Map<string, unknown>();
  /** hosts whose requests fail like a network error */
  readonly down = new Set<string>();
  modelsDev: unknown = {};
  modelsDevStatus = 200;
  /** chat completions / messages answer (realLlm) */
  chat: (call: Call) => Response = () => new Response("", { status: 500 });

  readonly fetch: Fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    const body = typeof init?.body === "string" ? init.body : "";
    const call = { url, method: init?.method ?? request?.method ?? "GET", headers, body };
    this.calls.push(call);
    const parsed = new URL(url);
    if (this.down.has(parsed.host)) throw new TypeError("fetch failed");
    if (url === "https://models.dev/api.json") return json(this.modelsDev, this.modelsDevStatus);
    if (/\/(chat\/completions|messages)$/.test(parsed.pathname)) return this.chat(call);
    if (/\/models$/.test(parsed.pathname)) {
      const status = this.listStatus.get(parsed.host) ?? 200;
      if (status !== 200) return new Response("nope: secret-ish body that must never show", { status });
      return json(this.lists.get(parsed.host) ?? { data: [{ id: "gpt-a" }, { id: "gpt-b" }] });
    }
    return new Response("not found", { status: 404 });
  };

  listCalls(): Call[] {
    return this.calls.filter((c) => /\/models(\?|$)/.test(c.url));
  }
}

/** One built model layer per resolved turn: its config (the one model) and what it was asked. */
export interface Built { config: ModelConfig; opts: LlmOptions; requests: LlmRequest[] }

/** A shared script queue for every built model layer; each request remembers its model. */
export class Scripts {
  readonly built: Built[] = [];
  private readonly queue: ScriptTurn[] = [];

  push(...turns: ScriptTurn[]): void {
    this.queue.push(...turns);
  }

  /** Every request with the model (ModelEntry.modelId) it went to. */
  requests(): { modelId: string; providerId: string; request: LlmRequest }[] {
    return this.built.flatMap((b) => b.requests.map((request) => ({ modelId: b.config.models[0]!.id, providerId: b.config.providers[0]!.id, request })));
  }

  readonly build = (config: ModelConfig, opts: LlmOptions): RegisteredLlm => {
    const built: Built = { config, opts, requests: [] };
    this.built.push(built);
    const model = config.models[0]!;
    const identity = { providerId: model.provider, modelId: model.id };
    const queue = this.queue;
    return {
      models: config,
      roleModels: (role: ModelRole): Model[] => config.roles[role].flatMap((id) => config.models.filter((m) => m.id === id)),
      async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
        built.requests.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
        const turn = queue.shift() ?? [{ type: "text_delta", text: "(no script)" }];
        yield* new ScriptedModel([turn], identity).stream(request);
      },
    };
  };
}

export const failing = (status = 529) => new LlmError({ kind: "http", status, providerId: "x", modelId: "x", attempts: 1 });

export interface ModelsApp {
  fixture: TestApp;
  net: FakeNet;
  scripts: Scripts;
  models: ModelsModule;
  runs: RunHost;
  tasks: Tasks;
  recorder: RunRecorder;
  vault: Vault;
  /** with `proactive: true`: the brief / check-ins and routines (the scheduler isn't started) */
  proactive: Proactive | null;
  alex: SignedIn;
}

export interface HarnessOptions {
  legacy?: ModelConfig | null;
  env?: Record<string, string | undefined>;
  /** the real createLlm over the fake network (secrets test) */
  realLlm?: boolean;
  overrides?: Record<string, string | undefined>;
  now?: () => number;
  /** also build the proactive module (briefs, check-ins, routines) on the same run host */
  proactive?: boolean;
}

export async function startModelsApp(options: HarnessOptions = {}): Promise<ModelsApp> {
  const net = new FakeNet();
  net.fetch.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const scripts = new Scripts();
  let built: Omit<ModelsApp, "fixture" | "alex" | "net" | "scripts"> | undefined;
  const fixture = await createTestApp(options.overrides ?? {}, {
    setup: (core) => {
      const vault = new Vault(core.db, { key: VAULT_KEY });
      const recorder = new RunRecorder({ db: core.db });
      const models = createModelsModule({
        db: core.db, events: core.events, vault, legacy: options.legacy ?? null, config: core.config, env: options.env ?? {},
        onSecret: (secret) => recorder.addSecret(secret), fetch: net.fetch,
        catalog: new ModelsDevCatalog({ fetch: net.fetch, ...(options.now ? { now: options.now } : {}) }),
        ...(options.realLlm ? { llmFetch: net.fetch, sleep: async () => {} } : { buildLlm: scripts.build }),
      });
      const providers: ToolProvider[] = [];
      const agent = createAgentRuntime({ db: core.db, resolver: models.resolver, config: core.config, providers });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent, recorder });
      const tasks = createTasks({ db: core.db, events: core.events, runs });
      providers.push(...tasks.providers);
      const proactive = options.proactive
        ? createProactive({ db: core.db, runs, usage: core.usage, tasks: tasks.service, catalog: null, notify: async () => "sent", welcomeDelaysMs: [0, 0], builtins: true })
        : null;
      if (proactive) providers.push(...proactive.providers);
      tasks.cards.handle("model_error", models.errorCard(runs));
      built = { models, runs, tasks, recorder, vault, proactive };
      return { agent, runs, routes: [...tasks.routes, ...models.routes, ...(proactive?.routes ?? [])] };
    },
  });
  const alex = await signUp(fixture, "alex");
  return { fixture, net, scripts, alex, ...built! };
}

type Body = Record<string, unknown>;
export async function call(t: Pick<ModelsApp, "fixture">, user: SignedIn, method: string, path: string, body?: Body) {
  const response = await t.fixture.app.request(path, {
    method, headers: { ...user.headers, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

export const OPENAI_KEY = "sk-test-openai-0123456789abcdef";

/** An OpenAI preset provider (fake list: gpt-a, gpt-b) with gpt-a added (the auto default). */
export async function setUp(t: ModelsApp, user: SignedIn = t.alex, key = OPENAI_KEY) {
  const provider = await call(t, user, "POST", "/api/providers", { kind: "openai", key });
  if (provider.status !== 200) throw new Error(`provider: ${provider.status} ${provider.text}`);
  const providerId = provider.body.provider.id as string;
  const model = await call(t, user, "POST", "/api/models", { providerId, modelId: "gpt-a" });
  if (model.status !== 200) throw new Error(`model: ${model.status} ${model.text}`);
  return { providerId, modelEntryId: model.body.model.id as string };
}

/** A non-main channel (direct row: no greeting turn). */
export async function channelOf(t: ModelsApp, user: SignedIn = t.alex, name = "Trips") {
  return (await t.fixture.db.channel.create({ data: { userId: user.userId, isMain: false, name } })).id;
}
