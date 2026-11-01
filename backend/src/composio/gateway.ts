// The one boundary between the backend and Composio. Everything else (policy, approvals, the
// connector routes and the agent's connector tools) talks to this interface; the real
// implementation (sdk.ts) wraps @composio/core, tests use test/helpers/fake-composio.ts.
// Composio user id = our User.id. Values crossing this boundary are already validated with zod.
// M20: guardOutbound() (below) checks every execution's arguments for credentials before it leaves;
// sdk.ts's createComposioGateway always returns the guarded gateway, so the direct path
// (execute_app_tools) and Approve (ApprovalService) are both covered.
import { credentialRefusal, describeFindings, inspectArguments } from "../agent/outbound-credentials.ts";
import { log } from "../log.ts";

export interface GatewayToolkit {
  /** Composio toolkit slug ("googlecalendar"): an identifier, never shown */
  slug: string;
  /** Composio's own display name; names.ts may override it */
  name: string;
  description: string;
  /** remote logo URL (fetched by the server, never handed to the app) */
  logo: string | null;
  /** Composio category names, e.g. ["Email", "Productivity"] */
  categories: string[];
}

export interface GatewayTool {
  /** tool slug, e.g. "GMAIL_SEND_EMAIL" */
  slug: string;
  /** toolkit slug the tool belongs to */
  toolkit: string;
  name: string;
  description: string;
  /** Composio hints: readOnlyHint, createHint, updateHint, destructiveHint ... */
  tags: string[];
  /** JSON schema of the arguments */
  inputSchema: Record<string, unknown>;
  /** one of the toolkit's "important" tools (listed first in the detail sheet) */
  important: boolean;
}

export interface GatewayAccount {
  id: string;
  toolkit: string;
  status: "INITIALIZING" | "INITIATED" | "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" | "REVOKED";
  /** the account alias set at connect time, if any */
  alias: string | null;
  /** the address / handle Composio's connection data carries, if any (tokens never leave sdk.ts) */
  label: string | null;
  createdAt: string;
}

export interface GatewaySearchTool { slug: string; toolkit: string; description: string }

export interface GatewaySearchResult {
  tools: GatewaySearchTool[];
  /** short guidance from Composio (already filtered of meta / workbench references) */
  guidance: string[];
  connections: { toolkit: string; connected: boolean }[];
}

export type GatewayFailureKind = "not_connected" | "invalid_arguments" | "not_found" | "provider" | "unavailable";

/** Result of running one tool. `error` is the provider's text: for the model only, never logged or shown. */
export type GatewayExecution =
  | { ok: true; data: unknown }
  | { ok: false; kind: GatewayFailureKind; error: string };

export interface ComposioGateway {
  /** semantic tool search for the user's request */
  search(userId: string, query: string, toolkits?: string[]): Promise<GatewaySearchResult>;
  /** tool definitions by slug (unknown slugs are left out) */
  getTools(slugs: string[]): Promise<GatewayTool[]>;
  /** every tool of a toolkit (the detail sheet, policy checks) */
  listTools(toolkit: string): Promise<GatewayTool[]>;
  /** run one tool for the user; failures are returned, not thrown */
  execute(userId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution>;
  /** run a read tool against one specific connected account (account label lookups) */
  executeForAccount(userId: string, accountId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution>;
  /** the catalog (most used first) */
  listToolkits(): Promise<GatewayToolkit[]>;
  getToolkit(slug: string): Promise<GatewayToolkit | null>;
  /** the user's connected accounts (every status) */
  listAccounts(userId: string): Promise<GatewayAccount[]>;
  /** starts Composio's hosted OAuth: the URL to open, returning to callbackUrl */
  authorize(userId: string, toolkit: string, callbackUrl: string): Promise<{ url: string }>;
  disconnect(accountId: string): Promise<void>;
  /** the bytes behind a toolkit's logo URL */
  fetchLogo(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/**
 * M20: a gateway whose executions are refused, before anything is sent, when their arguments carry a
 * credential (agent/outbound-credentials.ts). The refusal is an ordinary failed execution
 * (`invalid_arguments`, the fixed reason plus category / path of each finding); the log line has
 * the slug and the findings, never a value. Everything else passes straight through.
 */
export function guardOutbound(inner: ComposioGateway): ComposioGateway {
  const refusal = (slug: string, args: Record<string, unknown>, via: "execute" | "account"): GatewayExecution | null => {
    const inspection = inspectArguments(args);
    if (inspection.safe) return null;
    log.warn("connector call refused: credential in arguments", { via, tool: slug, reason: inspection.reason, findings: inspection.findings });
    const refused = credentialRefusal(inspection);
    return { ok: false, kind: "invalid_arguments", error: inspection.findings.length ? `${refused.error} Findings: ${describeFindings(inspection.findings)}.` : refused.error };
  };
  return {
    search: (userId, query, toolkits) => inner.search(userId, query, toolkits),
    getTools: (slugs) => inner.getTools(slugs),
    listTools: (toolkit) => inner.listTools(toolkit),
    execute: async (userId, slug, args) => refusal(slug, args, "execute") ?? inner.execute(userId, slug, args),
    executeForAccount: async (userId, accountId, slug, args) => refusal(slug, args, "account") ?? inner.executeForAccount(userId, accountId, slug, args),
    listToolkits: () => inner.listToolkits(),
    getToolkit: (slug) => inner.getToolkit(slug),
    listAccounts: (userId) => inner.listAccounts(userId),
    authorize: (userId, toolkit, callbackUrl) => inner.authorize(userId, toolkit, callbackUrl),
    disconnect: (accountId) => inner.disconnect(accountId),
    fetchLogo: (url) => inner.fetchLogo(url),
  };
}

/** Thrown when Composio itself can't be reached or answers something unusable. Message is safe to log. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}
