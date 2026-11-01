// M17: connector templates from the official MCP Registry, one-tap installs, remote MCP OAuth sign-in
// (the app opens `authorizeUrl` in ASWebAuthenticationSession and posts the code back) and pasted
// mcpServers configs. Connector answers are the M11 CustomConnectorResponse (with `oauth` and
// `registryName`). Tokens, client secrets, codes and PKCE verifiers never appear in any answer.
import { z } from "zod";
import { IsoDate } from "./common.ts";
import { CustomConnector } from "./m11.ts";

// ---------------------------------------------------------------- templates (GET /api/connector-templates)

/** What the user fills in for a template: a request header value or a `{name}` part of the URL. */
export const ConnectorTemplateInput = z.object({
  /** header: the header name (e.g. "Authorization"); urlVariable: the `{name}` in the URL */
  name: z.string().min(1).max(64),
  description: z.string(),
  /** secret values go to the vault (shown as {set, last4} afterwards) */
  secret: z.boolean(),
  required: z.boolean(),
  kind: z.enum(["header", "urlVariable"]),
});

export const ConnectorTemplate = z.object({
  /** the registry name, e.g. "com.notion/mcp" (the install key) */
  name: z.string().min(1).max(200),
  title: z.string(),
  description: z.string(),
  website: z.string().nullable(),
  iconUrl: z.string().nullable(),
  /** where it runs: a hosted remote (streamable-http or sse); the URL may still hold `{variables}` */
  remote: z.object({ type: z.enum(["streamable-http", "sse"]), url: z.string() }),
  inputs: z.array(ConnectorTemplateInput),
  /** true = it asks for OAuth sign-in; false = it doesn't; null = not known until it's installed */
  needsSignIn: z.boolean().nullable(),
  /** the user already has a connector installed from this template */
  installed: z.boolean(),
  /** one of the curated featured servers (they lead the first page) */
  featured: z.boolean(),
});

/** GET /api/connector-templates?query=&cursor= : featured first (no query, no cursor), then the registry's page. */
export const ConnectorTemplateList = z.object({
  templates: z.array(ConnectorTemplate),
  /** pass back as `cursor` for the next page; null = the end */
  nextCursor: z.string().nullable(),
});

export const ConnectorTemplateQuery = z.object({
  query: z.string().trim().max(100).optional(),
  cursor: z.string().max(500).optional(),
});

/** POST /api/connector-templates/install. `inputs`: input name -> value (omit for a template with no required inputs). */
export const InstallTemplateRequest = z.object({
  name: z.string().min(1).max(200),
  inputs: z.record(z.string().min(1).max(64), z.string().max(4000)).default({}),
}).strict();

export const InstallTemplateResponse = z.object({
  connector: CustomConnector,
  /** the server asks for OAuth sign-in: call POST /api/custom-connectors/:id/oauth/start next */
  needsSignIn: z.boolean(),
});

// ---------------------------------------------------------------- OAuth sign-in

/** POST /api/custom-connectors/:id/oauth/start (no body). */
export const OAuthStartResponse = z.object({
  /** open in ASWebAuthenticationSession */
  authorizeUrl: z.string(),
  /** the callbackURLScheme for ASWebAuthenticationSession: "duet" */
  callbackScheme: z.literal("duet"),
  /** the registered redirect, "duet://oauth/callback" */
  redirectUri: z.string(),
  /** the sign-in must finish before this (about 10 min); after it, start again */
  expiresAt: IsoDate,
});

/**
 * POST /api/custom-connectors/:id/oauth/finish: the query of the callback URL the session returned.
 * `code` on success; `error` (+ `errorDescription`) when the user cancelled or the server refused.
 */
export const OAuthFinishRequest = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(4000).optional(),
  error: z.string().max(200).optional(),
  errorDescription: z.string().max(1000).optional(),
}).strict();

// ---------------------------------------------------------------- pasted config (POST /api/custom-connectors/import)

export const ImportConnectorsRequest = z.object({
  /** a Claude / Cursor / VS Code config: {"mcpServers": {...}}, {"servers": {...}}, {"mcp": {"servers": {...}}} or one server entry */
  json: z.string().min(1).max(100_000),
}).strict();

export const ImportSkipReason = z.enum(["stdio", "exists", "invalid", "failed"]);

export const ImportConnectorsResponse = z.object({
  /** created, in config order; those with `oauth.needsSignIn` wait for POST .../oauth/start */
  connectors: z.array(CustomConnector),
  skipped: z.array(z.object({
    name: z.string().max(200),
    /** stdio: runs a local command (not supported on a hosted server); exists: that URL is added already; invalid: no usable https URL / headers; failed: the check failed */
    reason: ImportSkipReason,
    /** the details in plain words */
    message: z.string(),
  })),
});
