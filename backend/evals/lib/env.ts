// The eval world: a private copy of the given duet.db (and the vault.key next to it) in a temp dir,
// migrated to this checkout's schema, wired like src/index.ts but with the model layer metered, the
// Composio gateway, web search / web_fetch and OpenDuet's computer replaced by the eval fakes, and no
// push, scheduler, housekeeping, dreaming or live screen. The source database is only ever read.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { User } from "@prisma/client";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { createArtifacts } from "../../src/artifacts/index.ts";
import { checkVaultKey, createChannelSystem } from "../../src/channels/index.ts";
import { guardOutbound } from "../../src/composio/gateway.ts";
import { createComputerModule } from "../../src/computer/index.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { createConnectorsModule } from "../../src/connectors/module.ts";
import { openDatabase, type Db } from "../../src/db.ts";
import { EventBus } from "../../src/events/bus.ts";
import { FileStore } from "../../src/files/store.ts";
import { setLogLevel } from "../../src/log.ts";
import { createMemoryModule } from "../../src/memory/index.ts";
import { createModelsModule } from "../../src/models/index.ts";
import type { DbModelResolver } from "../../src/models/resolver.ts";
import { createNeeds } from "../../src/needs/index.ts";
import { createProactive, type Proactive } from "../../src/proactive/index.ts";
import { createReactions } from "../../src/reactions/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { secretValues } from "../../src/runs/redact.ts";
import { RunRecorder } from "../../src/runs/steps.ts";
import { createSkills } from "../../src/skills/index.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { UsageMeter } from "../../src/usage/meter.ts";
import { Vault } from "../../src/vault/index.ts";
import { COMPUTER_URL, FakeComputer } from "./fake-computer.ts";
import { FakeComposio } from "./fake-composio.ts";
import { FakeWeb, SEARXNG_URL } from "./fake-web.ts";
import { persona as loadPersona, type Lang, type Persona } from "./fixtures.ts";
import { ModelMeter } from "./meter.ts";
import { TurnRecorder } from "./recorder.ts";

const BACKEND_DIR = join(import.meta.dir, "../..");

export interface EnvOptions {
  /** the duet.db to copy (vault.key next to it is copied too); never written */
  db: string;
  /** ModelEntry id; default: the user's default model */
  model?: string | null;
  /** username; default: the first account */
  user?: string | null;
  /** keep the account's own memory facts in the prompt (default: archived on the copy) */
  keepMemory?: boolean;
  /** keep the temp copy after the run (its path is printed) */
  keepDb?: boolean;
  /** stop after this many model calls (null: no cap) */
  maxCalls?: number | null;
  /** Dashboard eval: real build/task turns and an in-memory workspace; defaults stay stubbed. */
  liveDashboard?: boolean;
}

export interface EvalEnv {
  dir: string;
  db: Db;
  config: Config;
  user: User;
  model: { id: string; label: string };
  persona: Persona;
  meter: ModelMeter;
  composio: FakeComposio;
  web: FakeWeb;
  computer: FakeComputer;
  agent: TurnRecorder;
  runs: RunHost;
  tasks: Tasks;
  proactive: Proactive;
  recorder: RunRecorder;
  /** the production model resolver (the eval's model is the user's default on the copy) */
  resolver: DbModelResolver;
  /** when this env was built: rows newer than this were written by the eval */
  startedAt: Date;
  /** the main thread's id */
  mainChannelId: string;
  /** back to a clean account between cases (see tidy()) */
  tidy(): Promise<void>;
  /** the persona's name and the user's language for the next case */
  setLanguage(lang: Lang): Promise<void>;
  close(): Promise<void>;
}

/** Copies duet.db (+ its -wal) and vault.key into `dir` and checks the copy opens cleanly. */
export function copyDatabase(source: string, dir: string): string {
  if (!existsSync(source)) throw new Error(`--db: ${source} doesn't exist`);
  const target = join(dir, "duet.db");
  copyFileSync(source, target);
  if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${target}-wal`);
  const key = join(source, "..", "vault.key");
  if (existsSync(key)) copyFileSync(key, join(dir, "vault.key"));
  const check = new Database(target);
  try {
    const row = check.query("PRAGMA quick_check").get() as Record<string, string> | null;
    const verdict = row ? Object.values(row)[0] : "no answer";
    if (verdict !== "ok") throw new Error(`the database copy failed quick_check (${verdict}); copy it again while the server is idle`);
    check.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    check.close();
  }
  return target;
}

/** prisma migrate deploy on the copy (the eval code may expect a newer schema than the copy has). */
function migrate(url: string): void {
  const r = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`prisma migrate deploy on the copy failed:\n${r.stderr.toString().slice(-2000)}`);
}

function evalConfig(url: string, dir: string, owner: string): Config {
  return loadConfig({
    PUBLIC_URL: "http://localhost:3000",
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    FILES_DIR: join(dir, "files"),
    LOG_LEVEL: process.env.EVAL_LOG_LEVEL ?? "error",
    MODELS_FILE: join(dir, "no-models.json"),
    SEARCH_PROVIDER: "searxng",
    SEARXNG_URL,
    COMPUTER_URL,
    COMPUTER_TOKEN: crypto.randomUUID() + crypto.randomUUID(),
    COMPUTER_OWNER: owner,
    SESSION_TOKEN_LIMIT: "0",
    WEEKLY_TOKEN_LIMIT: "0",
  });
}

/** The model catalog / provider lists are never needed by a turn: nothing goes out. */
const offline = (async () => new Response("offline in evals", { status: 503 })) as unknown as typeof fetch;
export async function createEnv(opts: EnvOptions): Promise<EvalEnv> {
  const dir = mkdtempSync(join(tmpdir(), "duet-eval-"));
  try {
    return await build(dir, opts);
  } catch (error) {
    if (!opts.keepDb) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function build(dir: string, opts: EnvOptions): Promise<EvalEnv> {
  const file = copyDatabase(opts.db, dir);
  const url = `file:${file}`;
  migrate(url);
  mkdirSync(join(dir, "files"), { recursive: true });
  const db = await openDatabase(url);
  const user = opts.user
    ? await db.user.findUnique({ where: { username: opts.user } })
    : await db.user.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!user) throw new Error(opts.user ? `--user: no account "${opts.user}" in the database` : "the database has no account");
  const config = evalConfig(url, dir, user.username);
  setLogLevel(config.LOG_LEVEL);
  const vaultKey = { env: undefined, databaseUrl: url };
  await checkVaultKey(vaultKey, db);

  const persona = loadPersona();
  const meter = new ModelMeter(opts.maxCalls ?? null);
  const web = new FakeWeb();
  const computerFake = new FakeComputer(web, { fileStore: opts.liveDashboard === true });
  const timeZone = user.timezone;
  const composio = new FakeComposio(persona, () => timeZone);
  const events = new EventBus(db);
  const usage = new UsageMeter(db, config);
  const files = new FileStore(config.FILES_DIR);
  const providers: ToolProvider[] = [];
  // No env: nothing from this shell's environment (keys included) reaches the eval.
  const recorder = new RunRecorder({ db, secrets: secretValues(config, null, {}) });
  const connectors = createConnectorsModule({ db, events, config: { COMPOSIO_API_KEY: undefined }, gateway: guardOutbound(composio), steps: recorder });
  const modelsModule = createModelsModule({
    db, events, vault: new Vault(db, vaultKey), legacy: null, config, env: {},
    onSecret: (secret) => recorder.addSecret(secret),
    fetch: offline, buildLlm: meter.buildLlm, llmFetch: meter.fetch,
  });
  const model = await pickModel(db, modelsModule.resolver, user, opts.model ?? null);
  const inner = createAgentRuntime({ db, resolver: modelsModule.resolver, config, providers, fetch: web.fetch, lookup: web.lookup });
  const agent = new TurnRecorder(inner, opts.liveDashboard ? new Set() : undefined);
  // No automatic retries of failed background turns: a failure is a result here.
  const runs = new RunHost({ db, events, usage, files, agent, recorder, backgroundRetryMs: [] });
  const catalog = connectors.catalog;
  const tasks = createTasks({ db, events, runs, ...(catalog ? { apps: (userId: string, name: string) => catalog.knownApp(userId, name) } : {}) });
  const computer = createComputerModule({
    db, events, files, config, policy: connectors.policy, approvals: connectors.approvals,
    notify: async () => undefined, fetch: computerFake.fetch,
    connect: () => { throw new Error("no live screen in evals"); },
    continueRun: async (input) => {
      if (input.taskId) await tasks.service.continueTask(input.taskId, input.prompt);
      else await runs.submit({ ...input, kind: "chat" });
    },
  });
  const artifacts = createArtifacts({ db, events, runs, usage, workspace: computer.workspace });
  computer.setTrustedBuild((runId) => artifacts.service.userStarted(runId));
  const skills = createSkills({ db, events, cards: tasks.cards });
  const reactions = createReactions({ db, events });
  const memory = createMemoryModule({ db, events, llm: null, resolver: modelsModule.resolver });
  tasks.cards.handle("memory_note", memory.cards.memoryNote);
  tasks.cards.handle("soul_proposal", memory.cards.soulProposal);
  tasks.cards.handle("soul_setup", memory.cards.soulSetup);
  const channelSystem = createChannelSystem({
    db, events, runs, connectors, cards: tasks.cards, skills, workspace: computer.workspace, vault: vaultKey,
    continueTask: (taskId, prompt) => tasks.service.continueTask(taskId, prompt),
  });
  await channelSystem.start();
  // M23 W2: the brief / check-ins sort mail with triage.ts on the resolver's model (`resolver`, the
  // wiring src/proactive/index.ts describes for index.ts). Spread untyped so this still compiles
  // on a checkout whose ProactiveDeps doesn't take it yet (it's then ignored).
  const triageWiring: Record<string, unknown> = { resolver: modelsModule.resolver, events };
  const proactive = createProactive({
    db, runs, usage, tasks: tasks.service, catalog, builtins: config.PROACTIVE_BUILTINS, notify: async () => undefined,
    ...triageWiring,
  } as Parameters<typeof createProactive>[0]);
  tasks.cards.handle("model_error", modelsModule.errorCard(runs));
  const needs = createNeeds({ db });
  providers.push(
    ...connectors.providers, ...tasks.providers, ...proactive.providers,
    ...computer.providers, ...artifacts.providers, ...skills.providers, ...reactions.providers,
    ...memory.providers, ...channelSystem.providers, ...needs.providers,
  );
  connectors.setResumer(tasks.service);

  await tasks.service.recoverAfterRestart();
  await artifacts.service.recoverAfterRestart();
  await runs.recoverStaleRuns();
  await computer.service.refresh(user.id);

  const startedAt = new Date();
  const mainChannelId = await tasks.service.mainChannelId(user.id);
  const userId = user.id;
  // The persona's About-you document survives every tidy(); --keep-memory keeps the account's own too.
  const personaDoc = `${persona.name} (${persona.email}). ${persona.about}`;
  const since = opts.keepMemory === true ? startedAt : null;

  async function tidy(): Promise<void> {
    await runs.idle();
    await cleanSlate(db, userId, { since, keep: [personaDoc] });
    composio.mailbox = [];
    composio.events = [];
  }

  async function setLanguage(next: Lang): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { language: next, firstName: persona.firstName[next] } });
  }

  // The persona: name, address and what OpenDuet knows about them (the About-you document, which
  // triage's prompt reads too). The eval's model is the default and there's no separate utility
  // model, so every role (chat, the main thread, check-ins, triage) runs on it.
  const lang: Lang = user.language === "zh-Hans" ? "zh-Hans" : "en";
  await db.user.update({ where: { id: userId }, data: { firstName: persona.firstName[lang], email: persona.email, weekendsOn: true, defaultModelId: model.id, utilityModelId: null } });
  // The soul's tone / identity / persona stay (they're what's being evaluated); the account's own
  // "address me as" and OpenDuet's name would put the owner's name in the persona's replies.
  await db.soul.updateMany({ where: { userId }, data: { addressAs: "", name: "" } });
  await tidy();
  await db.memory.create({ data: { userId, kind: "document", text: personaDoc, source: "user" } });
  const fresh = await db.user.findUniqueOrThrow({ where: { id: userId } });

  return {
    dir, db, config, user: fresh, model, persona, meter, composio, web, computer: computerFake, agent, runs, tasks, proactive, recorder,
    resolver: modelsModule.resolver, startedAt, mainChannelId, tidy, setLanguage,
    async close() {
      await runs.shutdown();
      computer.stop();
      await db.$disconnect();
      if (opts.keepDb) process.stderr.write(`eval database kept at ${file}\n`);
      else rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The ModelEntry the eval runs on (it must be usable: a chat model with tools whose provider has a
 * key in the vault). Checked through the production resolver, so a bad id fails before any case.
 */
async function pickModel(db: Db, resolver: { resolve: (q: { userId: string; channelId: string | null; role: "chat"; pinModelId?: string | null }) => Promise<{ entryId: string; label: string } | null> }, user: User, wanted: string | null): Promise<{ id: string; label: string }> {
  const id = wanted ?? user.defaultModelId;
  if (!id) throw new Error("--model is required: the account has no default model");
  const row = await db.modelEntry.findFirst({ where: { id, userId: user.id }, select: { id: true, label: true } });
  if (!row) throw new Error(`--model: no ModelEntry ${id} for this account`);
  const resolved = await resolver.resolve({ userId: user.id, channelId: null, role: "chat", pinModelId: row.id });
  if (!resolved) throw new Error(`--model: ModelEntry ${id} (${row.label}) isn't usable (a chat model with tools, its provider's key in the vault)`);
  return { id: resolved.entryId, label: resolved.label };
}

/**
 * Back to a clean account (on the copy only): no messages, runs, tasks, approvals, Up next items,
 * reminders, artifacts or skills, other channels archived, and the account's own memory archived
 * (`since`: only what the eval wrote after that time, for --keep-memory). The soul stays. The chat
 * setup of who OpenDuet is counts as already offered (the soul suite opens it per case).
 */
export async function cleanSlate(db: Db, userId: string, opts: { since: Date | null; keep?: readonly string[] }): Promise<void> {
  const now = new Date();
  await db.run.deleteMany({ where: { userId } });
  await db.message.deleteMany({ where: { userId } });
  await db.approval.updateMany({ where: { userId, status: "pending" }, data: { status: "expired" } });
  await db.spendRequest.updateMany({ where: { userId, status: "pending" }, data: { status: "expired" } });
  await db.task.updateMany({ where: { userId, archivedAt: null }, data: { archivedAt: now, routinePaused: true, nextRunAt: null } });
  await db.suggestion.deleteMany({ where: { userId } });
  await db.reminder.deleteMany({ where: { userId } });
  await db.artifact.deleteMany({ where: { userId } });
  await db.skill.deleteMany({ where: { userId } });
  await db.event.deleteMany({ where: { userId } });
  await db.channel.updateMany({ where: { userId, isMain: false, archived: false }, data: { archived: true } });
  await db.memory.updateMany({
    where: { userId, archivedAt: null, ...(opts.since ? { createdAt: { gte: opts.since } } : {}), ...(opts.keep?.length ? { text: { notIn: [...opts.keep] } } : {}) },
    data: { archivedAt: now },
  });
  await db.user.update({ where: { id: userId }, data: { soulIntroAt: now } });
}
