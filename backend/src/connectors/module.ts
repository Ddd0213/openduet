// The M3 connector + approval module in one place, for index.ts and the tests: the Composio
// gateway (or null without COMPOSIO_API_KEY), ToolPolicy, the approval service with its expiry
// sweep, the agent's tool providers and the routes.
import type { TaskResumer, ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { ComposioGateway } from "../composio/gateway.ts";
import { createComposioGateway } from "../composio/sdk.ts";
import { PolicyService } from "../policy/service.ts";
import { approvalProvider } from "../approvals/provider.ts";
import { ApprovalService, type ApprovalSteps } from "../approvals/service.ts";
import { approvalRoutes } from "../routes/approvals.ts";
import { connectorRoutes } from "../routes/connectors.ts";
import { ConnectorCatalog } from "./catalog.ts";
import { connectorProvider } from "./provider.ts";

export interface ConnectorsModuleDeps {
  db: Db;
  events: EventBus;
  config: Pick<Config, "COMPOSIO_API_KEY">;
  /** tests pass a fake; undefined = built from config (null when COMPOSIO_API_KEY isn't set) */
  gateway?: ComposioGateway | null;
  now?: () => Date;
  resumer?: TaskResumer | null;
  /** the run records (index.ts passes the shared RunRecorder); default: one without the server's secrets */
  steps?: ApprovalSteps;
}

export interface ConnectorsModule {
  /** false = "isn't set up yet" */
  configured: boolean;
  catalog: ConnectorCatalog | null;
  policy: PolicyService;
  approvals: ApprovalService;
  /** for createAgentRuntime({ providers }) */
  providers: ToolProvider[];
  /** for createApp({ routes }) */
  routes: RegisterRoutes[];
  /** the expiry sweep */
  start(): void;
  stop(): void;
  /** the task runner, once built */
  setResumer(resumer: TaskResumer | null): void;
}

export function createConnectorsModule(deps: ConnectorsModuleDeps): ConnectorsModule {
  const gateway = deps.gateway === undefined ? createComposioGateway(deps.config) : deps.gateway;
  const now = deps.now ?? (() => new Date());
  const catalog = gateway ? new ConnectorCatalog(gateway, () => now().getTime()) : null;
  const policy = new PolicyService(deps.db);
  const approvals = new ApprovalService({
    db: deps.db, events: deps.events, now, resumer: deps.resumer ?? null,
    execute: gateway ? (userId, slug, args) => gateway.execute(userId, slug, args) : null,
    ...(deps.steps ? { steps: deps.steps } : {}),
  });
  return {
    configured: !!gateway,
    catalog,
    policy,
    approvals,
    providers: [connectorProvider({ catalog, policy, approvals }), approvalProvider({ approvals, catalog })],
    routes: [approvalRoutes(approvals), connectorRoutes({ catalog, policy })],
    start: () => approvals.start(),
    stop: () => approvals.stop(),
    setResumer: (resumer) => approvals.setResumer(resumer),
  };
}
