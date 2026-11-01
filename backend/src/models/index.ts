// M12: model configuration on the phone (contract .pi/handoff/m12-contract.md). Providers with their
// key in the vault, models from each provider's own list enriched by models.dev, the defaults, a
// channel's own model, the resolver every turn goes through, the model_error card's buttons and
// the one-time import of models.json / LLM_*.
//
// index.ts wiring:
//   const models = createModelsModule({ db, events, vault, legacy, config, onSecret: (s) => recorder.addSecret(s) });
//   const agent = createAgentRuntime({ db, resolver: models.resolver, config, providers });
//   const runs = new RunHost({ ... });
//   tasks.cards.handle("model_error", models.errorCard(runs));
//   createApp({ routes: [...models.routes, ...] });
import type { RegisterRoutes } from "../app.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { Fetch, LlmOptions, ModelConfig, RegisteredLlm } from "../llm/index.ts";
import { createModelFetch } from "../llm/net.ts";
import type { RunHost } from "../runs/host.ts";
import type { CardHandler } from "../tasks/cards.ts";
import { KeyedLock } from "../tasks/lock.ts";
import type { Vault } from "../vault/index.ts";
import { modelErrorCard } from "./cards.ts";
import { ModelsDevCatalog } from "./catalog.ts";
import { setModelHooks } from "./hooks.ts";
import { LegacyImporter } from "./import.ts";
import { VERIFY_TIMEOUT_MS } from "./net.ts";
import { RealtimeModels } from "./realtime.ts";
import { DbModelResolver } from "./resolver.ts";
import { registerModelRoutes } from "./routes.ts";
import { ModelService } from "./service.ts";

export { ModelsDevCatalog } from "./catalog.ts";
export { DbModelResolver } from "./resolver.ts";
export { LegacyImporter } from "./import.ts";
export { ModelService } from "./service.ts";
export { RealtimeModels, type RealtimeModel, type VoiceEngineKind } from "./realtime.ts";

export interface ModelsModuleDeps {
  db: Db;
  events: EventBus;
  vault: Vault;
  /** the models.json / LLM_* configuration loaded at startup (null: none; set up from the phone) */
  legacy: ModelConfig | null;
  config: Pick<Config, "LLM_TIMEOUT_SECONDS" | "LLM_ALLOW_INSECURE_HOSTS"> & Partial<Pick<Config, "LLM_ALLOW_PRIVATE_HOSTS">>;
  /** the legacy keys' values (default process.env) */
  env?: Record<string, string | undefined>;
  /** decrypted / typed keys join the run records' redaction set (RunRecorder.addSecret) */
  onSecret?: (secret: string) => void;
  /** tests: fake fetch for the providers' lists and models.dev, a fake model layer, a clock */
  fetch?: Fetch;
  catalog?: ModelsDevCatalog;
  buildLlm?: (config: ModelConfig, opts: LlmOptions) => RegisteredLlm;
  llmFetch?: Fetch;
  sleep?: LlmOptions["sleep"];
  verifyTimeoutMs?: number;
  now?: () => Date;
}

export interface ModelsModule {
  service: ModelService;
  resolver: DbModelResolver;
  importer: LegacyImporter;
  catalog: ModelsDevCatalog;
  /** M13: the realtime voice models (the calls module reads a provider's key through it) */
  realtime: RealtimeModels;
  routes: RegisterRoutes[];
  /** the model_error card's retry / dismiss (needs the run host, built after the agent) */
  errorCard(runs: Pick<RunHost, "retry">): CardHandler;
}

export function createModelsModule(deps: ModelsModuleDeps): ModelsModule {
  const onSecret = deps.onSecret ?? (() => {});
  const netOptions = { insecureHosts: deps.config.LLM_ALLOW_INSECURE_HOSTS, privateHosts: deps.config.LLM_ALLOW_PRIVATE_HOSTS };
  const fetchImpl = createModelFetch({ ...netOptions, fetch: deps.fetch });
  const catalog = deps.catalog ?? new ModelsDevCatalog({ fetch: fetchImpl });
  const importer = new LegacyImporter({ db: deps.db, vault: deps.vault, legacy: deps.legacy, onSecret, ...(deps.env ? { env: deps.env } : {}), ...(deps.now ? { now: deps.now } : {}) });
  const service = new ModelService({
    db: deps.db, events: deps.events, vault: deps.vault, catalog, fetch: fetchImpl, lock: new KeyedLock(),
    insecureHosts: deps.config.LLM_ALLOW_INSECURE_HOSTS, verifyTimeoutMs: deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS, onSecret,
    privateHosts: deps.config.LLM_ALLOW_PRIVATE_HOSTS, lookup: deps.fetch?.lookup,
  }, importer);
  const resolver = new DbModelResolver({
    db: deps.db, vault: deps.vault, importer, timeoutMs: deps.config.LLM_TIMEOUT_SECONDS * 1000, onSecret,
    fetch: createModelFetch({ ...netOptions, fetch: deps.llmFetch }),
    ...(deps.buildLlm ? { buildLlm: deps.buildLlm } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const realtime = new RealtimeModels({ db: deps.db, vault: deps.vault, importer, onSecret });
  setModelHooks(deps.db, {
    // M13: Features.voice = a usable realtime model (the voice settings' one, else the first).
    features: async (userId) => ({ ...(await service.features(userId)), voice: await realtime.configured(userId) }),
    ready: (userId) => service.ready(userId),
  });
  return {
    service, resolver, importer, catalog, realtime,
    routes: [registerModelRoutes(service)],
    errorCard: (runs) => modelErrorCard({ db: deps.db, events: deps.events, runs, ready: (userId) => service.ready(userId) }),
  };
}
