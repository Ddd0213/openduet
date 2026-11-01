// Backend entry point: validate config, open the database, wire the agent and run host, serve the API.
import { registerAccountRoutes } from "./account/routes.ts";
import { createAgentRuntime } from "./agent/runtime.ts";
import { createApp } from "./app.ts";
import { MAX_REQUEST_BODY_BYTES } from "./body-limit.ts";
import { createArtifacts } from "./artifacts/index.ts";
import { createCallsModule } from "./calls/index.ts";
import { createComputerModule } from "./computer/index.ts";
import { registerBuiltinRoutes } from "./builtins/routes.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { EventBus } from "./events/bus.ts";
import { FileStore } from "./files/store.ts";
import { Housekeeping } from "./housekeeping/index.ts";
import type { ModelConfig } from "./llm/index.ts";
import { createModelsModule } from "./models/index.ts";
import { createNeeds } from "./needs/index.ts";
import { createSetup } from "./setup/index.ts";
import { loadLegacyModels } from "./models/legacy.ts";
import { Vault } from "./vault/index.ts";
import { log, setLogLevel } from "./log.ts";
import { createConnectorsModule } from "./connectors/module.ts";
import { createPushProvider, loadNotifyConfig, Notifier, ReminderService, type NotifyConfig } from "./notify/index.ts";
import { createProactive } from "./proactive/index.ts";
import { createReactions } from "./reactions/index.ts";
import { RunHost } from "./runs/host.ts";
import { secretValues } from "./runs/redact.ts";
import { RunRecorder } from "./runs/steps.ts";
import { createSkills } from "./skills/index.ts";
import { createTasks } from "./tasks/index.ts";
import { UsageMeter } from "./usage/meter.ts";
import { startAddressPolicy } from "./network/address-policy.ts";
import type { ToolProvider } from "./agent/types.ts";
import { convertLegacySessions } from "./auth/sessions.ts";
import { SessionConnections } from "./auth/connections.ts";

async function main(): Promise<void> {
  let config;
  let notifyConfig: NotifyConfig;
  try {
    config = loadConfig();
    // NOTIFY_PROVIDER's own settings (e.g. "APNS_TOPIC is required when NOTIFY_PROVIDER=apns").
    notifyConfig = loadNotifyConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(config.LOG_LEVEL);
  await startAddressPolicy();
  // M12: models.json / LLM_* is only the one-time import now (models/import.ts). A bad one no longer
  // stops the server: one warning naming the fields (no values), and models are set up in the app.
  const legacy = loadLegacyModels(config);
  const models: ModelConfig | null = legacy.models;
  if (legacy.status === "absent") log.info("no models.json or LLM_* settings: models are set up in the app (Everything → Models)");
  if (legacy.status === "ignored") log.warn("model configuration ignored: models are set up in the app", { problems: legacy.problems });

  const db = await openDatabase(config.DATABASE_URL);
  const connections = new SessionConnections(db);
  const events = new EventBus(db);
  const usage = new UsageMeter(db, config);
  const files = new FileStore(config.FILES_DIR);
  // Every `notification` event (brief ready, task ready / needs input, approval, reminder); a remote
  // push only while the user has no live event stream.
  const notifier = new Notifier({ db, events, provider: createPushProvider(notifyConfig, { db }) });
  // The runtime reads `providers` on every turn, so modules built after it can add their tools.
  const providers: ToolProvider[] = [];
  // Run records (M8): every run's steps, redacted (the server's own keys too); a decided approval
  // updates its step; steps of runs older than 30 days are pruned at startup and once a day.
  const recorder = new RunRecorder({ db, secrets: secretValues(config, models) });
  // Composio (null gateway without COMPOSIO_API_KEY: "isn't set up yet"), ToolPolicy, approvals.
  const connectors = createConnectorsModule({ db, events, config, steps: recorder });
  // M12: the user's providers and models (keys in the vault), the resolver every turn goes through,
  // and the one-time import of the legacy configuration above. The vault key is checked below
  // (M11-B) before the server listens; this vault only loads it on first use.
  const modelsModule = createModelsModule({
    db, events, vault: new Vault(db, { env: process.env.VAULT_KEY, databaseUrl: config.DATABASE_URL }), legacy: models, config,
    onSecret: (secret) => recorder.addSecret(secret),
  });
  const agent = createAgentRuntime({ db, resolver: modelsModule.resolver, config, providers });
  // M29: the notifier hears what each run posts and how it ends (a reply, a card that waits, a failure).
  const runs = new RunHost({ db, events, usage, files, agent, recorder, notices: notifier });
  // add_update sources: "OpenDuet", "OpenDuet's computer" or an app the catalog knows (else "OpenDuet").
  const catalog = connectors.catalog;
  const tasks = createTasks({ db, events, runs, ...(catalog ? { apps: (userId: string, name: string) => catalog.knownApp(userId, name) } : {}) });
  // OpenDuet's computer (null client without COMPUTER_URL / COMPUTER_TOKEN: "isn't set up yet"):
  // computer_* tools, sign-in card, live screen + take over, human checks, send_file (L140-L144, L180).
  const computer = createComputerModule({
    db, events, files, config, connections, policy: connectors.policy, approvals: connectors.approvals,
    notify: (input) => notifier.notify(input),
    // After a hand back or a sign-in: a task's session continues through the tasks module (its
    // status bookkeeping). Anything else carries on as a chat turn in the same thread: the user is
    // here now, so a brief / check-in / scan they took over isn't a quiet proactive turn any more
    // (its hooks are gone). Builds are never continued.
    continueRun: async (input) => {
      if (input.taskId) await tasks.service.continueTask(input.taskId, input.prompt);
      else await runs.submit({ ...input, kind: "chat" });
    },
  });
  // Make (artifacts built on the computer's /workspace, refresh, edit, make_artifact), skills, reactions
  // (L151-L157, L181). Spend requests are request_payment's (approvals module).
  const artifacts = createArtifacts({ db, events, runs, usage, workspace: computer.workspace, notify: (input) => notifier.notify(input) });
  // Only builds the user started run "ask" computer tools without a card (not make_artifact, schedules).
  computer.setTrustedBuild((runId) => artifacts.service.userStarted(runId));
  const skills = createSkills({ db, events, cards: tasks.cards });
  const reactions = createReactions({ db, events });
  // ---- M11-A (soul, memory layers, dreaming): BE-A edits only between these markers.
  // The soul (/api/soul), "About you" + channel memories (/api/memory/*, /api/channels/:id/memory),
  // remember / forget / propose_soul_change, the memory_note and soul_proposal buttons, and
  // dreaming on the utility model (every 30 min; never without a model, never throws).
  const { createMemoryModule } = await import("./memory/index.ts");
  const memory = createMemoryModule({ db, events, llm: null, resolver: modelsModule.resolver });
  tasks.cards.handle("memory_note", memory.cards.memoryNote);
  tasks.cards.handle("soul_proposal", memory.cards.soulProposal);
  tasks.cards.handle("soul_setup", memory.cards.soulSetup);
  const m11a = { providers: memory.providers, routes: memory.routes, start: () => memory.start() };
  // ---- end M11-A
  // ---- M11-B (vault, skills folders, custom connectors, access, channel create / greet): BE-B edits only between these markers.
  // The vault (VAULT_KEY, else vault.key next to the database: a bad key stops startup here), channel
  // access, custom connectors + connection cards, apps per channel, run_skill_script's wiring.
  const { createChannelSystem, checkVaultKey } = await import("./channels/index.ts");
  const { VaultKeyError } = await import("./vault/index.ts");
  const vaultKey = { env: process.env.VAULT_KEY, databaseUrl: config.DATABASE_URL };
  try {
    // Also stops here when secrets are stored but VAULT_KEY and vault.key are both missing.
    await checkVaultKey(vaultKey, db);
  } catch (err) {
    if (err instanceof VaultKeyError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  // Conversion is mandatory before any request can reach the hash-only session lookup.
  await convertLegacySessions(db);
  const channelSystem = createChannelSystem({
    db, events, runs, connectors, cards: tasks.cards, skills, workspace: computer.workspace, vault: vaultKey,
    continueTask: (taskId, prompt) => tasks.service.continueTask(taskId, prompt),
  });
  // Pending custom-connector approvals get their executors before the server listens.
  await channelSystem.start();
  const m11b = { providers: channelSystem.providers, routes: channelSystem.routes, start: () => {} };
  // ---- end M11-B
  // Morning brief, check-ins, the first-day scan and the Up next scan (L75, L76, L118, L119).
  // Routines always run; the built-in brief and check-ins only with PROACTIVE_BUILTINS=1 (M9).
  const proactive = createProactive({
    db, runs, usage, tasks: tasks.service, catalog: connectors.catalog, builtins: config.PROACTIVE_BUILTINS,
    notify: (input) => notifier.notify(input),
    // M23: triage's model (role utility) and the brief payload's live event
    resolver: modelsModule.resolver, events,
  });
  // The Usage panel names models by the user's ModelEntry label, else the models.json one.
  const modelLabels = new Map((models?.models ?? []).map((m) => [m.id, { label: m.label, provider: m.provider }]));
  // M12: Retry / Switch model / Dismiss on a failed turn's model_error card.
  tasks.cards.handle("model_error", modelsModule.errorCard(runs));
  // M22: Needs you (GET /api/needs-you) + show_tasks; Setup (GET /api/setup, POST /api/setup/check).
  const needs = createNeeds({ db });
  const setup = createSetup({
    db, config, notify: notifyConfig, resolver: modelsModule.resolver,
    ready: (userId) => modelsModule.service.ready(userId), voice: (userId) => modelsModule.realtime.pick(userId),
    catalog: connectors.catalog, computer: computer.configured ? computer.service : null,
  });
  providers.push(
    ...connectors.providers, ...tasks.providers, ...proactive.providers,
    ...computer.providers, ...artifacts.providers, ...skills.providers, ...reactions.providers,
    ...m11a.providers, ...m11b.providers, ...needs.providers,
  );
  connectors.setResumer(tasks.service);
  // M13: realtime voice calls (credentials, the voice's tools, cues, the call's line, the 2 h sweep).
  const calls = createCallsModule({ db, events, runs, realtime: modelsModule.realtime, resolver: modelsModule.resolver });
  const reminders = new ReminderService({ db, events, notifier });
  const housekeeping = new Housekeeping({ db, files });

  // Pause tasks first (they're found through runs that aren't cancelled yet), then cancel the
  // runs of every kind left queued or running by the previous process.
  const paused = await tasks.service.recoverAfterRestart();
  // A first build the restart interrupted fails with a reason (before its run is cancelled).
  await artifacts.service.recoverAfterRestart();
  const stale = await runs.recoverStaleRuns();
  // A first-day scan the restart cancelled before it started runs again (once).
  const scans = await proactive.service.resumeFirstDayScans();
  if (paused > 0 || stale > 0 || scans > 0) log.info("recovered after restart", { pausedTasks: paused, cancelledRuns: stale, firstDayScans: scans });
  const app = createApp({
    config, db, events, usage, files, runs, connections, fileWorkspace: computer.workspace,
    routes: [
      ...tasks.routes, ...connectors.routes, ...proactive.routes, registerAccountRoutes({ labels: (id) => modelLabels.get(id) ?? null }),
      ...modelsModule.routes,
      ...computer.routes, ...artifacts.routes, ...skills.routes, ...reactions.routes,
      ...m11a.routes, ...m11b.routes, ...calls.routes, ...needs.routes, ...setup.routes,
      registerBuiltinRoutes(config),
    ],
  });

  // idleTimeout above the ~20 s SSE heartbeat so streams aren't cut between pings.
  // The live screen's WebSocket (GET /api/computer/stream) upgrades inside the authenticated
  // route; Bun hands the server to Hono as `env`, and `websocket` handles the open socket.
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch, websocket: computer.websocket, idleTimeout: 60, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  log.info("listening", {
    port: server.port, publicUrl: config.PUBLIC_URL, notify: notifyConfig.provider ?? "local", computer: computer.configured,
  });
  notifier.start();
  // Approvals with an expiresAt (payments, spend requests) turn expired; after the restart
  // recovery so a resumed task isn't queued before it was paused.
  connectors.start();
  reminders.start();
  m11a.start();
  m11b.start();
  housekeeping.start();
  connections.start();
  await calls.start();
  recorder.start();
  computer.start();
  // Scheduled artifact refreshes ("Refreshes daily at 5:30 AM").
  artifacts.service.start();
  // Ticks once now: slots less than 2 h late (also ones a restart interrupted) run here.
  await proactive.scheduler.start();

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    // Closes open connections too: a plain stop() waits for every SSE / live-screen socket, which
    // never ends on its own (the app reconnects after a restart).
    await server.stop(true);
    // Stop claiming slots before the run host shuts down.
    await proactive.scheduler.stop();
    connectors.stop();
    await reminders.stop();
    await housekeeping.stop();
    connections.stop();
    memory.stop();
    calls.stop();
    recorder.stop();
    artifacts.service.stop();
    computer.stop();
    // Running turns see the abort, write their results and emit done before the database closes.
    await runs.shutdown();
    // Aborted runs still emit task / approval events: let their pushes finish.
    await notifier.stop();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
