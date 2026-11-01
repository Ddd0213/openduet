// Connectors (Composio toolkits) and per-tool policies. The UI always shows display names.
import { z } from "zod";
import { AppName, Id, IsoDate } from "./common.ts";
import { AlwaysBlocked } from "./m20.ts";

export const PolicyMode = z.enum(["ask", "always"]);

/** The rows of the OpenDuet sheet's "What OpenDuet has access to". */
export const AccessCategory = z.enum(["files", "mail", "calendar", "team_chat", "payments"]);

export const ConnectedAccount = z.object({
  id: Id,
  /** the real address or handle of the account */
  label: z.string(),
  status: z.enum(["active", "expired", "failed"]),
  connectedAt: IsoDate,
});

export const Connector = z.object({
  /** Composio toolkit slug: an identifier only, never shown */
  toolkit: z.string(),
  name: AppName,
  description: z.string(),
  /** server-relative logo URL fetched through the session */
  logoUrl: z.string().nullable(),
  category: AccessCategory.nullable(),
  accounts: z.array(ConnectedAccount),
});
export type Connector = z.infer<typeof Connector>;

/** GET /api/connectors?query=: connected first, then the catalog. */
export const ConnectorList = z.object({
  /** false when COMPOSIO_API_KEY isn't set: the app shows "isn't set up yet" */
  configured: z.boolean(),
  connectors: z.array(Connector),
});

export const ConnectorTool = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  access: z.enum(["read", "write"]),
  mode: PolicyMode,
  /** common tools are listed first in each group */
  common: z.boolean(),
  /**
   * M20: false when the picker's Always is disabled for this tool; `alwaysBlocked` says why (the
   * safety floor, or Always per recipient on the approval card). PUT .../policy with
   * mode "always" for such a tool is a 400 always_not_allowed; "All tools" skips them.
   */
  alwaysAllowed: z.boolean().default(true),
  alwaysBlocked: AlwaysBlocked.nullable().default(null),
});

/** GET /api/connectors/:toolkit: the connector detail sheet. */
export const ConnectorDetail = z.object({
  connector: Connector,
  tools: z.array(ConnectorTool),
});

/** POST /api/connectors/:toolkit/connect -> open url in ASWebAuthenticationSession, callback duet://oauth */
export const ConnectResponse = z.object({ url: z.url(), callbackScheme: z.literal("duet") });

/** PUT /api/connectors/:toolkit/policy: one tool, or "All tools" when tool is null. */
export const UpdatePolicyRequest = z
  .object({ tool: z.string().nullable(), mode: PolicyMode })
  .strict();
