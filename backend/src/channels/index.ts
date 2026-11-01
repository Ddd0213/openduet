// The M11-B channel system in one place, for index.ts (the M11-B block) and the tests: the vault,
// channel access (routes + the channel create hooks), custom connectors (service, routes, model
// tools, approvals, connection cards), the per-channel gate on the Composio apps, the skills
// module's late wiring (OpenDuet's computer + approvals for run_skill_script) and the "no purpose
// yet" hint. Built after the connectors, tasks, computer and skills modules.
import type { ToolProvider } from "../agent/types.ts";
import { AccessService } from "../access/service.ts";
import { registerAccessRoutes } from "../access/routes.ts";
import type { RegisterRoutes } from "../app.ts";
import type { Workspace } from "../computer/workspace.ts";
import type { ConnectorsModule } from "../connectors/module.ts";
import { gateApps } from "../connectors/provider.ts";
import { ConnectionCards } from "../custom-connectors/cards.ts";
import type { NetDeps } from "../custom-connectors/net.ts";
import { customConnectorProvider, type CustomConnectorProvider } from "../custom-connectors/provider.ts";
import { customConnectorRoutes } from "../custom-connectors/routes.ts";
import { ConnectorService } from "../custom-connectors/service.ts";
import { displayName } from "../composio/names.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import type { RunHost } from "../runs/host.ts";
import type { Skills } from "../skills/index.ts";
import type { CardActions } from "../tasks/cards.ts";
import { keyExists, loadVaultKey, Vault, type VaultKeySource } from "../vault/index.ts";
import { NO_PURPOSE_HINT } from "./greet.ts";
import { setChannelHooks, type ConnectedApp } from "./hooks.ts";

export interface ChannelSystemDeps {
  db: Db;
  events: EventBus;
  runs: Pick<RunHost, "submit">;
  connectors: Pick<ConnectorsModule, "catalog" | "policy" | "approvals" | "providers">;
  cards: CardActions;
  skills?: Pick<Skills, "configure"> | null;
  workspace?: Workspace | null;
  continueTask?: (taskId: string, prompt: string) => Promise<void>;
  /** VAULT_KEY + DATABASE_URL (the key file's directory), or a fixed key (tests) */
  vault: VaultKeySource | { key: Buffer };
  /** tests: fake fetch + DNS lookup */
  net?: NetDeps;
  now?: () => Date;
}

export interface ChannelSystem {
  vault: Vault;
  access: AccessService;
  connectors: ConnectorService;
  cards: ConnectionCards;
  provider: CustomConnectorProvider;
  providers: ToolProvider[];
  routes: RegisterRoutes[];
  /** registers the executors of pending custom-connector approvals (after a restart) */
  start(): Promise<void>;
}

/**
 * Startup check (throws VaultKeyError): loads an existing vault key so a bad one fails now, and
 * refuses to start when secrets are stored but VAULT_KEY and the key file are both missing.
 */
export async function checkVaultKey(source: VaultKeySource, db: Pick<Db, "vaultSecret">): Promise<void> {
  if (keyExists(source)) {
    loadVaultKey(source);
    return;
  }
  // No key yet: fine while nothing is stored (the first put creates it); rows without it are fatal.
  const stored = await db.vaultSecret.count();
  if (stored > 0) loadVaultKey(source, stored);
}

/** "This channel has no purpose yet": later turns save the answer in the channel's memory. */
function purposeHint(db: Db): ToolProvider {
  return {
    name: "channel-purpose",
    tools: async () => [],
    async instructions(input) {
      if (input.kind && input.kind !== "chat") return [];
      const channel = await db.channel.findFirst({ where: { id: input.channelId, userId: input.userId }, select: { isMain: true, purpose: true } });
      return channel && !channel.isMain && !channel.purpose.trim() ? [NO_PURPOSE_HINT] : [];
    },
    execute: async (call) => ({ result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify({ error: "Tool is not available" }) }], isError: true }, endTurn: false }),
  };
}

export function createChannelSystem(deps: ChannelSystemDeps): ChannelSystem {
  const { db, events, connectors } = deps;
  const catalog = connectors.catalog;
  const vault = new Vault(db, deps.vault);
  const access = new AccessService(db);
  const service = new ConnectorService({ db, vault, access, policy: connectors.policy, ...(deps.net ? { net: deps.net } : {}), ...(deps.now ? { now: deps.now } : {}) });
  const cards = new ConnectionCards({ db, events, service, access, catalog, runs: deps.runs, ...(deps.continueTask ? { continueTask: deps.continueTask } : {}) });
  // M29: warm MCP connections for approval cards, only on the real network (tests inject `net`).
  const provider = customConnectorProvider({ service, approvals: connectors.approvals, cards, warm: !deps.net });
  deps.cards.handle("connection_request", (row, action) => cards.act(row, action));

  // POST /api/channels (access refs) and GET /api/channels/:id/access (the user's apps).
  setChannelHooks(db, {
    appKnown: catalog ? async (_userId, toolkit) => !!(await catalog.toolkit(toolkit)) : null,
    connectedApps: catalog ? async (userId): Promise<ConnectedApp[]> => {
      const accounts = await catalog.accounts(userId);
      const slugs = [...new Set(accounts.filter((a) => a.status === "active").map((a) => a.toolkit))];
      return Promise.all(slugs.map(async (slug) => {
        const toolkit = await catalog.toolkit(slug).catch(() => null);
        return { toolkit: slug, name: displayName(slug, toolkit?.name), description: toolkit?.description ?? "" };
      }));
    } : null,
  });

  // Apps per channel: the Composio tools only see the toolkits this channel can use.
  gateApps(connectors.providers, async ({ userId, channelId }) => (await access.resolve(userId, channelId)).allowsApp);

  // App cards turn connected once the account is active (any fresh accounts listing).
  catalog?.onAccounts((userId, accounts) => {
    const active = new Set(accounts.filter((a) => a.status === "active").map((a) => a.toolkit));
    if (!active.size) return;
    void cards.syncApps(userId, active).catch((error: unknown) => {
      log.warn("app connection cards not synced", { error: { name: (error as Error)?.name ?? "Error" } });
    });
  });

  deps.skills?.configure({ workspace: deps.workspace ?? null, approvals: connectors.approvals });

  return {
    vault, access, connectors: service, cards, provider,
    providers: [provider, purposeHint(db)],
    routes: [registerAccessRoutes(access), customConnectorRoutes(service, cards)],
    start: () => provider.registerPending(),
  };
}
