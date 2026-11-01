// M22 (#47): the Setup page's rows (GET /api/setup) and Check again (POST /api/setup/check).
//
// index.ts wiring:
//   const setup = createSetup({ db, config, notify: notifyConfig, resolver: modelsModule.resolver,
//     ready: (id) => modelsModule.service.ready(id), voice: (id) => modelsModule.realtime.pick(id),
//     catalog: connectors.catalog, computer: computer.configured ? computer.service : null });
//   routes: [...setup.routes]
import type { RegisterRoutes } from "../app.ts";
import { probeComputer } from "../computer/health.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { ModelResolver } from "../llm/index.ts";
import type { NotifyConfig } from "../notify/config.ts";
import { webSearch } from "../web/search.ts";
import { setupModels } from "./models.ts";
import { registerSetupRoutes } from "./routes.ts";
import { SetupService } from "./service.ts";

export { SetupService, CHECK_WINDOW_MS, pushConfigOk, type SetupDeps, type SetupModels, type Outcome } from "./service.ts";
export { setupModels, PING_MAX_TOKENS } from "./models.ts";
export { registerSetupRoutes } from "./routes.ts";

export interface SetupModuleDeps {
  db: Db;
  config: SetupConfig;
  notify: NotifyConfig;
  resolver: ModelResolver;
  /** ModelService.ready (the one-time models.json / LLM_* import) */
  ready: (userId: string) => Promise<void>;
  /** RealtimeModels.pick */
  voice: (userId: string) => Promise<{ entry: { label: string } } | null>;
  /** the connectors module's catalog (null without COMPOSIO_API_KEY) */
  catalog: { accounts(userId: string): Promise<{ toolkit: string; status: string }[]>; invalidateAccounts?(userId: string): void } | null;
  /** OpenDuet's computer (null without COMPUTER_URL / COMPUTER_TOKEN): who may use it */
  computer: { allows(userId: string): Promise<boolean> } | null;
}

type SetupConfig = Pick<Config, "SEARCH_PROVIDER" | "SEARCH_API_KEY" | "SEARXNG_URL" | "COMPOSIO_API_KEY" | "COMPUTER_URL" | "COMPUTER_TOKEN">;

export interface Setup { service: SetupService; routes: RegisterRoutes[] }

export function createSetup(deps: SetupModuleDeps): Setup {
  const { config } = deps;
  const computerUrl = config.COMPUTER_URL && config.COMPUTER_TOKEN ? config.COMPUTER_URL : null;
  const service = new SetupService({
    db: deps.db, config, notify: deps.notify,
    models: setupModels({ db: deps.db, resolver: deps.resolver, ready: deps.ready, voice: deps.voice }),
    apps: config.COMPOSIO_API_KEY && deps.catalog
      ? { accounts: (userId) => deps.catalog!.accounts(userId), refresh: (userId) => deps.catalog!.invalidateAccounts?.(userId) }
      : null,
    computer: computerUrl && deps.computer
      ? { allows: (userId) => deps.computer!.allows(userId), probe: () => probeComputer(computerUrl, { timeoutMs: 5_000 }) }
      : null,
    search: (query, signal) => webSearch(query, config, { signal }),
  });
  return { service, routes: [registerSetupRoutes(service)] };
}
