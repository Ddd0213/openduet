// Custom connectors (M11): MCP servers and domain-bound API keys the user added. Secrets live in
// the vault (VaultSecret rows "key" and "header:<name>"); the row keeps only the plain headers and
// the tool list. Create and every change of url / domain / key / headers verify first (mcp:
// initialize + tools/list; api_key: the domain is valid and resolves publicly, no request) and a
// failed check is 400 with the reason, nothing saved. Test re-checks and refreshes the tools; an mcp
// connector's tools are also refreshed lazily when older than 24 h. Delete removes the vault rows,
// its access rows and its ToolPolicy rows. ToolPolicy key of a tool: "<connectorId>:<tool>"
// (api_key: "<connectorId>:call_api"); "All tools" is the toolkit row "toolkit:custom-<id>".
// M17: an mcp connector can have an OAuth grant (oauth.ts): every MCP request of it then goes
// through withMcp, which sends `Authorization: Bearer` (refreshed before it runs out, and once
// after a 401); one waiting for sign-in is `failed` with "Sign in to ..." and sends nothing.
import type { CustomConnector as ConnectorRow, OAuthGrant } from "@prisma/client";
import type { z } from "zod";
import type { AccessService } from "../access/service.ts";
import { CustomConnector, type CreateCustomConnectorRequest, type UpdateCustomConnectorRequest } from "../contract/m11.ts";
import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import type { ToolFacts } from "../policy/classify.ts";
import { alwaysBlockedFor, alwaysFields, alwaysNotAllowed } from "../policy/floor.ts";
import type { Mode, PolicyService } from "../policy/service.ts";
import type { Vault } from "../vault/index.ts";
import { mcpCallTool, mcpListTools, mcpWarmUp, McpError, RESERVED_HEADERS, type McpCallResult, type McpTarget, type McpTool } from "./mcp.ts";
import { checkHttpsUrl, NetError, normalizeDomain, resolvePublic, type NetDeps } from "./net.ts";
import { ACCESS_TOKEN, OAuthError, OAuthFlow, SignInNeeded, signInMessage } from "./oauth.ts";
import { redactText } from "./redact.ts";

type Shape = z.infer<typeof CustomConnector>;
type CreateInput = z.output<typeof CreateCustomConnectorRequest>;
type UpdateInput = z.output<typeof UpdateCustomConnectorRequest>;

export const API_TOOL = "call_api";
const REFRESH_MS = 24 * 60 * 60_000;
const RETRY_FAILED_MS = 15 * 60_000;
const NAME_MAX = 80;

/** A stored header: plain ones keep their value, secret ones are vault rows "header:<name>". */
export interface StoredHeader { name: string; secret: boolean; value: string | null }
export interface StoredTool { name: string; description: string; access: "read" | "write"; inputSchema: Record<string, unknown> }

export const toolkitOf = (connectorId: string) => `custom-${connectorId.toLowerCase()}`;
export const policySlug = (connectorId: string, tool: string) => `${connectorId}:${tool}`;

/**
 * A tool's ToolPolicy facts: its policy slug, the connector's toolkit, the server's readOnlyHint
 * (an MCP read) and its default (read always, write ask). M20: the same facts decide the safety
 * floor (policy/floor.ts), so the sheet, the PUT and the modes agree.
 */
export const toolFacts = (row: ConnectorRow, tool: StoredTool): ToolFacts => ({
  slug: policySlug(row.id, tool.name), toolkit: toolkitOf(row.id),
  ...(tool.access === "read" ? { tags: ["readOnlyHint"] } : {}),
  defaultMode: tool.access === "read" ? "always" : "ask",
});
const headerSecret = (name: string) => `header:${name}`;
const HEADER_PREFIX = "header:";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(raw);
    return (Array.isArray(value) ? value : fallback) as T;
  } catch {
    return fallback;
  }
}

export const storedHeaders = (row: ConnectorRow): StoredHeader[] => parseJson<StoredHeader[]>(row.headers, []).filter((h) => h && typeof h.name === "string");
export const storedTools = (row: ConnectorRow): StoredTool[] => parseJson<StoredTool[]>(row.tools, []).filter((t) => t && typeof t.name === "string");

const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);
const notFound = () => new HttpError(404, "not_found", "Not found.");
const ONE_LINE = /^[^\r\n\0]*$/;

function checkHeaders(headers: readonly { name: string; value: string | null }[]): void {
  const names = headers.map((h) => h.name.toLowerCase());
  if (new Set(names).size !== names.length) throw invalid("headers", "two headers have the same name");
  const reserved = names.find((n) => RESERVED_HEADERS.has(n));
  if (reserved) throw invalid("headers", `${reserved} is set by the server`);
  if (headers.some((h) => h.value !== null && !ONE_LINE.test(h.value))) throw invalid("headers", "a header value must be one line");
}

function checkUrl(raw: string): string {
  try {
    return checkHttpsUrl(raw.trim()).href;
  } catch (error) {
    throw invalid("url", error instanceof NetError ? error.message : "not a valid URL");
  }
}

function checkName(raw: string): string {
  const name = raw.trim();
  if (!name) throw invalid("name", "required");
  if (name.length > NAME_MAX) throw invalid("name", `up to ${NAME_MAX} characters`);
  return name;
}

const toStored = (tools: McpTool[]): StoredTool[] => tools.map((t) => ({ name: t.name, description: t.description, access: t.readOnly ? "read" : "write", inputSchema: t.inputSchema }));

/** What the app sees of a grant: signed in or not (never a token). */
function oauthState(grant: OAuthGrant | undefined, hasToken: boolean): { signedIn: boolean; needsSignIn: boolean; expiresAt: string | null } | null {
  if (!grant) return null;
  const signedIn = grant.status === "signed_in" && hasToken;
  return { signedIn, needsSignIn: !signedIn, expiresAt: signedIn && grant.expiresAt ? grant.expiresAt.toISOString() : null };
}

export type CheckResult = { ok: true; tools: StoredTool[] } | { ok: false; field: string; reason: string };

export interface ConnectorServiceDeps { db: Db; vault: Vault; access: AccessService; policy: PolicyService; net?: NetDeps; now?: () => Date }

/** create(): where it was added, and (M17) a template's registry name / whether sign-in may be pending. */
export interface CreateOptions { channelId?: string | null; registryName?: string | null; allowSignIn?: boolean }

/** A header that carries the user's own credentials (then a 401 means "wrong credentials", not "sign in"). */
const isCredential = (h: { name: string; secret: boolean }) => h.secret || h.name.toLowerCase() === "authorization";

export class ConnectorService {
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  /** M17: remote MCP sign-in (PKCE state, refresh single-flight). */
  readonly oauth: OAuthFlow;

  constructor(private readonly deps: ConnectorServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.oauth = new OAuthFlow({ db: deps.db, vault: deps.vault, net: () => this.net, now: this.now });
  }

  get net(): NetDeps {
    return this.deps.net ?? {};
  }

  /** The tools the policy sheet shows: an mcp server's list; api_key: call_api (non-GET calls). */
  toolsOf(row: ConnectorRow): StoredTool[] {
    if (row.kind === "mcp") return storedTools(row);
    return [{ name: API_TOOL, description: `HTTP requests to ${row.domain ?? "its domain"} with the key (GET and HEAD always run; other methods follow this setting).`, access: "write", inputSchema: {} }];
  }

  /**
   * "<connectorId>:<tool>" -> mode (tool row > "All tools" row > read always / write ask). M20: a
   * stored Always on a safety-floor / per-recipient tool reads as Ask (PolicyService).
   */
  async modes(userId: string, row: ConnectorRow, tools: readonly StoredTool[] = this.toolsOf(row)): Promise<Map<string, Mode>> {
    return this.deps.policy.modes(userId, tools.map((t) => toolFacts(row, t)));
  }

  async mode(userId: string, row: ConnectorRow, tool: StoredTool): Promise<Mode> {
    return (await this.modes(userId, row, [tool])).get(policySlug(row.id, tool.name)) ?? "ask";
  }

  private async shapes(userId: string, rows: ConnectorRow[]): Promise<Shape[]> {
    if (!rows.length) return [];
    const [secrets, scopes, channels, grants] = await Promise.all([
      this.deps.vault.infos(userId, "connector", rows.map((r) => r.id)),
      this.deps.access.scopes(userId),
      this.deps.access.enabledChannels(userId, "connector"),
      this.deps.db.oAuthGrant.findMany({ where: { userId, connectorId: { in: rows.map((r) => r.id) } } }),
    ]);
    const grantOf = new Map(grants.map((g) => [g.connectorId, g]));
    const out: Shape[] = [];
    for (const row of rows) {
      const tools = this.toolsOf(row);
      const modes = await this.modes(userId, row, tools);
      const mine = secrets.get(row.id) ?? new Map();
      const scope = scopes.get(`connector:${row.id}`) ?? "all";
      out.push(CustomConnector.parse({
        id: row.id, kind: row.kind === "api_key" ? "api_key" : "mcp", name: row.name, description: row.description,
        url: row.kind === "mcp" ? row.url : null,
        domain: row.kind === "api_key" ? row.domain : null,
        headerName: row.kind === "api_key" ? row.headerName : null,
        valuePrefix: row.kind === "api_key" ? row.valuePrefix ?? "" : null,
        secret: row.kind === "api_key" ? mine.get("key") ?? { set: false, last4: null } : null,
        headers: row.kind === "mcp" ? storedHeaders(row).map((h) => ({
          name: h.name, secret: h.secret, value: h.secret ? null : h.value ?? "",
          secretInfo: h.secret ? mine.get(headerSecret(h.name)) ?? { set: false, last4: null } : null,
        })) : [],
        status: row.status === "failed" ? "failed" : "active",
        error: row.error,
        tools: tools.map((t) => ({ name: t.name, description: t.description, access: t.access, mode: modes.get(policySlug(row.id, t.name)) ?? "ask", ...alwaysFields(toolFacts(row, t)) })),
        scope, channelIds: scope === "channels" ? channels.get(row.id) ?? [] : [],
        createdAt: row.createdAt.toISOString(),
        registryName: row.registryName ?? null,
        oauth: oauthState(grantOf.get(row.id), mine.has(ACCESS_TOKEN)),
      }));
    }
    return out;
  }

  async list(userId: string): Promise<Shape[]> {
    return this.shapes(userId, await this.deps.db.customConnector.findMany({ where: { userId }, orderBy: [{ name: "asc" }, { createdAt: "asc" }] }));
  }

  async get(userId: string, id: string): Promise<Shape> {
    return (await this.shapes(userId, [await this.own(userId, id)]))[0]!;
  }

  async own(userId: string, id: string): Promise<ConnectorRow> {
    const row = id ? await this.deps.db.customConnector.findFirst({ where: { id, userId } }) : null;
    if (!row) throw notFound();
    return row;
  }

  /** The user's connector, or null (executors: a removed connector is a reason, not a 404). */
  async findOwned(userId: string, id: string): Promise<ConnectorRow | null> {
    return id ? this.deps.db.customConnector.findFirst({ where: { id, userId } }) : null;
  }

  /** Approval.toolSlug of every pending custom-connector card (their executors after a restart). */
  async pendingSlugs(): Promise<string[]> {
    const rows = await this.deps.db.approval.findMany({
      where: { status: "pending", OR: [{ toolSlug: { startsWith: "mcp:" } }, { toolSlug: { startsWith: "api:" } }] },
      select: { toolSlug: true }, distinct: ["toolSlug"], take: 5000,
    });
    return rows.map((r) => r.toolSlug);
  }

  /** Every stored secret of a connector (server-side only: headers for requests, redaction). */
  async secretsOf(row: ConnectorRow): Promise<Map<string, string>> {
    return this.deps.vault.values(row.userId, "connector", row.id);
  }

  /** M17: the connector's OAuth grant (null: the server takes the headers alone). */
  grantOf(row: ConnectorRow): Promise<OAuthGrant | null> {
    return row.kind === "mcp" ? this.deps.db.oAuthGrant.findUnique({ where: { connectorId: row.id } }) : Promise.resolve(null);
  }

  /**
   * M17: runs MCP requests against a stored connector. With an OAuth grant: `Authorization: Bearer`
   * (it replaces a header of that name), refreshed first when it's about to run out, and once more
   * after a 401 (then the whole operation runs again: a 401 comes before the server did anything).
   * `secrets` (what to redact) holds the token actually sent. Throws McpError (SignInNeeded when it
   * waits for sign-in: nothing is sent).
   */
  async withMcp<T>(row: ConnectorRow, run: (target: McpTarget) => Promise<T>, override?: { url: string; headers: Record<string, string>; secrets: readonly string[] }): Promise<T> {
    const values = await this.secretsOf(row);
    const base = override ?? { url: row.url ?? "", headers: await this.headersOf(row, values), secrets: [...values.values()] };
    const grant = await this.grantOf(row);
    if (!grant) return run(base);
    const withToken = (token: string): McpTarget => {
      const headers = Object.fromEntries(Object.entries(base.headers).filter(([name]) => name.toLowerCase() !== "authorization"));
      return { url: base.url, headers: { ...headers, Authorization: `Bearer ${token}` }, secrets: [...base.secrets, token] };
    };
    const token = await this.oauth.accessToken(row, grant);
    try {
      return await run(withToken(token));
    } catch (error) {
      if (!(error instanceof McpError) || error instanceof SignInNeeded || error.kind !== "auth" || error.status !== 401) throw error;
    }
    const again = await this.oauth.accessToken(row, grant, token);
    try {
      return await run(withToken(again));
    } catch (error) {
      if (error instanceof McpError && error.kind === "auth" && !(error instanceof SignInNeeded)) throw new McpError(`${row.name} refused the sign-in. Sign in again if this keeps happening.`, "auth", error.status);
      throw error;
    }
  }

  /** M29: opens the connection to an mcp connector's server before a tap needs it (mcpWarmUp); never throws. */
  warmUp(row: ConnectorRow): void {
    if (row.kind !== "mcp" || !row.url) return;
    let url: URL;
    try { url = new URL(row.url); } catch { return; }
    void mcpWarmUp(url, this.net);
  }

  /** One tool call of a stored mcp connector (OAuth handled); `secrets`: what to redact from it. */
  async callTool(row: ConnectorRow, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: McpCallResult; secrets: readonly string[] }> {
    let used: readonly string[] = [];
    const result = await this.withMcp(row, (target) => { used = target.secrets ?? []; return mcpCallTool(target, tool, args, this.net, signal); });
    return { result, secrets: used };
  }

  /** The request headers of an mcp connector (secret values from the vault). */
  async headersOf(row: ConnectorRow, secrets?: Map<string, string>): Promise<Record<string, string>> {
    const values = secrets ?? (await this.secretsOf(row));
    const out: Record<string, string> = {};
    for (const header of storedHeaders(row)) {
      const value = header.secret ? values.get(headerSecret(header.name)) : header.value;
      if (value) out[header.name] = value;
    }
    return out;
  }

  /**
   * mcp: initialize + tools/list; api_key: the domain is valid and resolves publicly (no request).
   * `row` (M17): a stored connector, so its OAuth grant is used (and refreshed) for the check.
   */
  async check(target: { kind: "mcp"; url: string; headers: Record<string, string> } | { kind: "api_key"; domain: string }, secrets: readonly string[], row?: ConnectorRow): Promise<CheckResult> {
    if (target.kind === "mcp") {
      let used: readonly string[] = secrets;
      try {
        const list = (t: McpTarget) => { used = t.secrets ?? secrets; return mcpListTools(t, this.net); };
        const tools = row ? await this.withMcp(row, list, { url: target.url, headers: target.headers, secrets }) : await list({ url: target.url, headers: target.headers, secrets });
        return { ok: true, tools: toStored(tools) };
      } catch (error) {
        if (error instanceof McpError) return { ok: false, field: "url", reason: redactText(error.message, [...secrets, ...used]) };
        throw error;
      }
    }
    try {
      await resolvePublic(target.domain, this.net.lookup);
      return { ok: true, tools: [] };
    } catch (error) {
      if (error instanceof NetError) return { ok: false, field: "domain", reason: error.message };
      throw error;
    }
  }

  /**
   * "Add connector" (and a connection card): verified before anything is saved. `channelId`: where
   * it was added (a card's channel: scope channels + on there; null / the main thread: scope all).
   * M17 `allowSignIn` (mcp): a server that asks for OAuth sign-in is saved `failed` with "Sign in to
   * ..." and a grant waiting for sign-in (nothing verified yet) instead of a 400.
   */
  async create(userId: string, input: CreateInput, opts: CreateOptions = {}): Promise<Shape> {
    const { db, vault } = this.deps;
    const name = checkName(input.name);
    const description = input.description.trim();
    let data: { kind: string; url: string | null; domain: string | null; headerName: string | null; valuePrefix: string | null; headers: StoredHeader[] };
    let secrets: { name: string; value: string }[];
    let tools: StoredTool[];
    let signIn = false;
    if (input.kind === "mcp") {
      const url = checkUrl(input.url);
      checkHeaders(input.headers);
      const headers = Object.fromEntries(input.headers.map((h) => [h.name, h.value]));
      const secretValues = input.headers.filter((h) => h.secret).map((h) => h.value);
      signIn = (opts.allowSignIn ?? input.allowSignIn ?? false) && await this.oauth.probe(url, headers, input.headers.some(isCredential));
      if (signIn) tools = [];
      else {
        const checked = await this.check({ kind: "mcp", url, headers }, secretValues);
        if (!checked.ok) throw invalid(checked.field, checked.reason);
        tools = checked.tools;
      }
      data = { kind: "mcp", url, domain: null, headerName: null, valuePrefix: null, headers: input.headers.map((h) => ({ name: h.name, secret: h.secret, value: h.secret ? null : h.value })) };
      secrets = input.headers.filter((h) => h.secret).map((h) => ({ name: headerSecret(h.name), value: h.value }));
    } else {
      const domain = normalizeDomain(input.domain.replace(/^https?:\/\//i, "").split("/")[0] ?? "");
      if (!domain) throw invalid("domain", "use a public domain name like api.example.com");
      if (!ONE_LINE.test(input.key) || !ONE_LINE.test(input.valuePrefix)) throw invalid("key", "must be one line");
      if (RESERVED_HEADERS.has(input.headerName.toLowerCase())) throw invalid("headerName", `${input.headerName} is set by the server`);
      const checked = await this.check({ kind: "api_key", domain }, [input.key]);
      if (!checked.ok) throw invalid(checked.field, checked.reason);
      tools = [];
      data = { kind: "api_key", url: null, domain, headerName: input.headerName, valuePrefix: input.valuePrefix, headers: [] };
      secrets = [{ name: "key", value: input.key }];
    }
    const row = await db.$transaction(async (tx) => {
      const created = await tx.customConnector.create({
        data: {
          userId, name, description, kind: data.kind, url: data.url, domain: data.domain, headerName: data.headerName, valuePrefix: data.valuePrefix, headers: JSON.stringify(data.headers), tools: JSON.stringify(tools),
          status: signIn ? "failed" : "active", error: signIn ? signInMessage(name) : null, checkedAt: this.now(), registryName: opts.registryName ?? null,
        },
      });
      for (const secret of secrets) await vault.put(userId, "connector", created.id, secret.name, secret.value, tx);
      if (signIn) await tx.oAuthGrant.create({ data: { userId, connectorId: created.id, status: "needs_sign_in", resource: data.url ?? "" } });
      return created;
    });
    await this.deps.access.created(userId, { kind: "connector", id: row.id }, opts.channelId ?? null);
    return this.get(userId, row.id);
  }

  /** PATCH: rename / describe; a new url, domain, key or headers is verified again first. */
  async update(userId: string, id: string, patch: UpdateInput): Promise<Shape> {
    const { db, vault } = this.deps;
    const row = await this.own(userId, id);
    const mcpOnly = (["url", "headers"] as const).find((k) => patch[k] !== undefined);
    const keyOnly = (["domain", "headerName", "valuePrefix", "key"] as const).find((k) => patch[k] !== undefined);
    if (row.kind === "mcp" && keyOnly) throw invalid(keyOnly, "only for API keys");
    if (row.kind === "api_key" && mcpOnly) throw invalid(mcpOnly, "only for MCP servers");
    const base = {
      ...(patch.name !== undefined ? { name: checkName(patch.name) } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    };
    if (!mcpOnly && !keyOnly) {
      await db.customConnector.update({ where: { id: row.id }, data: base });
      return this.get(userId, row.id);
    }
    const current = await this.secretsOf(row);
    if (row.kind === "mcp") {
      const url = patch.url !== undefined ? checkUrl(patch.url) : row.url ?? "";
      // Tokens are bound to the server they were issued for (RFC 8707): a new address means a new connector.
      const grant = await this.grantOf(row);
      if (grant && url !== row.url) throw invalid("url", "this connector signs in to its server; remove it and add the new address instead");
      const before = new Map(storedHeaders(row).map((h) => [h.name.toLowerCase(), h]));
      const next = patch.headers ?? storedHeaders(row).map((h) => ({ name: h.name, secret: h.secret, value: null }));
      checkHeaders(next);
      const resolved: { name: string; secret: boolean; value: string }[] = [];
      for (const header of next) {
        let value = header.value;
        if (value === null) {
          // null keeps the stored value: only for a header that exists with the same kind.
          const old = before.get(header.name.toLowerCase());
          if (!old || old.secret !== header.secret) throw invalid("headers", `${header.name}: a value is needed`);
          value = old.secret ? current.get(headerSecret(old.name)) ?? null : old.value;
          if (value === null) throw invalid("headers", `${header.name}: a value is needed`);
        }
        resolved.push({ name: header.name, secret: header.secret, value });
      }
      const headers = Object.fromEntries(resolved.map((h) => [h.name, h.value]));
      const checked = await this.check({ kind: "mcp", url, headers }, [...current.values(), ...resolved.filter((h) => h.secret).map((h) => h.value)], grant ? row : undefined);
      if (!checked.ok) throw invalid(checked.field, checked.reason);
      await db.$transaction(async (tx) => {
        await tx.customConnector.update({
          where: { id: row.id },
          data: { ...base, url, headers: JSON.stringify(resolved.map((h) => ({ name: h.name, secret: h.secret, value: h.secret ? null : h.value }))), tools: JSON.stringify(checked.tools), status: "active", error: null, checkedAt: this.now() },
        });
        // Only the header secrets are replaced (an OAuth grant's tokens stay).
        await vault.deletePrefix(userId, "connector", row.id, HEADER_PREFIX, tx);
        for (const header of resolved.filter((h) => h.secret)) await vault.put(userId, "connector", row.id, headerSecret(header.name), header.value, tx);
      });
      return this.get(userId, row.id);
    }
    const domain = patch.domain !== undefined ? normalizeDomain(patch.domain.replace(/^https?:\/\//i, "").split("/")[0] ?? "") : row.domain;
    if (!domain) throw invalid("domain", "use a public domain name like api.example.com");
    const headerName = patch.headerName ?? row.headerName ?? "Authorization";
    if (RESERVED_HEADERS.has(headerName.toLowerCase())) throw invalid("headerName", `${headerName} is set by the server`);
    const valuePrefix = patch.valuePrefix ?? row.valuePrefix ?? "";
    if ((patch.key !== undefined && !ONE_LINE.test(patch.key)) || !ONE_LINE.test(valuePrefix)) throw invalid("key", "must be one line");
    const checked = await this.check({ kind: "api_key", domain }, [...current.values(), ...(patch.key ? [patch.key] : [])]);
    if (!checked.ok) throw invalid(checked.field, checked.reason);
    await db.$transaction(async (tx) => {
      await tx.customConnector.update({ where: { id: row.id }, data: { ...base, domain, headerName, valuePrefix, status: "active", error: null, checkedAt: this.now() } });
      if (patch.key !== undefined) await vault.put(userId, "connector", row.id, "key", patch.key, tx);
    });
    return this.get(userId, row.id);
  }

  /** POST .../test: re-checks with the stored settings; status / error / tools follow the outcome. */
  async test(userId: string, id: string): Promise<Shape> {
    await this.recheck(await this.own(userId, id));
    return this.get(userId, id);
  }

  private async recheck(row: ConnectorRow): Promise<void> {
    const secrets = await this.secretsOf(row);
    const checked = row.kind === "mcp"
      ? await this.check({ kind: "mcp", url: row.url ?? "", headers: await this.headersOf(row, secrets) }, [...secrets.values()], row)
      : await this.check({ kind: "api_key", domain: row.domain ?? "" }, [...secrets.values()]);
    await this.deps.db.customConnector.updateMany({
      where: { id: row.id, userId: row.userId },
      data: checked.ok
        ? { status: "active", error: null, checkedAt: this.now(), ...(row.kind === "mcp" ? { tools: JSON.stringify(checked.tools) } : {}) }
        : { status: "failed", error: checked.reason.slice(0, 500), checkedAt: this.now() },
    });
  }

  /** DELETE: the row, its vault rows, its access rows and its ToolPolicy rows. */
  async remove(userId: string, id: string): Promise<void> {
    const { db, vault } = this.deps;
    const row = await this.own(userId, id);
    await db.$transaction(async (tx) => {
      // M17: its grant (the user's OAuth client stays, for other connectors at that server).
      await tx.oAuthGrant.deleteMany({ where: { connectorId: row.id, userId } });
      await tx.customConnector.deleteMany({ where: { id: row.id, userId } });
      await vault.deleteOwner(userId, "connector", row.id, tx);
      await tx.accessRule.deleteMany({ where: { userId, kind: "connector", refId: row.id } });
      await tx.channelAccess.deleteMany({ where: { userId, kind: "connector", refId: row.id } });
      await tx.toolPolicy.deleteMany({ where: { userId, OR: [{ toolSlug: { startsWith: `${row.id}:` } }, { toolSlug: `toolkit:${toolkitOf(row.id)}` }] } });
    });
  }

  /** M17 POST .../oauth/start: the authorize URL for the app's ASWebAuthenticationSession. */
  async oauthStart(userId: string, id: string): Promise<{ authorizeUrl: string; expiresAt: Date }> {
    const row = await this.own(userId, id);
    if (row.kind !== "mcp") throw invalid("kind", "only MCP servers sign in");
    try {
      return await this.oauth.start(row, await this.headersOf(row));
    } catch (error) {
      if (error instanceof OAuthError) throw invalid("oauth", error.message);
      throw error;
    }
  }

  /** M17 POST .../oauth/finish: the code for tokens, then the check (initialize + tools/list) with them. */
  async oauthFinish(userId: string, id: string, input: { state: string; code?: string | undefined; error?: string | undefined }): Promise<Shape> {
    const row = await this.own(userId, id);
    if (row.kind !== "mcp") throw invalid("kind", "only MCP servers sign in");
    try {
      await this.oauth.finish(row, input);
    } catch (error) {
      if (error instanceof OAuthError && error.kind === "expired") throw new HttpError(410, "expired", error.message, "state");
      if (error instanceof OAuthError) throw invalid("code", error.message);
      throw error;
    }
    await this.recheck(await this.own(userId, id));
    return this.get(userId, id);
  }

  /** M17 DELETE .../oauth: signs out (tokens deleted); the connector then waits for sign-in again. */
  async oauthDisconnect(userId: string, id: string): Promise<Shape> {
    const row = await this.own(userId, id);
    if (!(await this.grantOf(row))) throw invalid("oauth", "this connector doesn't sign in");
    await this.oauth.signOut(row);
    return this.get(userId, id);
  }

  /** M17: registry name -> connector id of the user's connectors installed from a template. */
  async installed(userId: string): Promise<Map<string, string>> {
    const rows = await this.deps.db.customConnector.findMany({ where: { userId, registryName: { not: null } }, select: { id: true, registryName: true }, orderBy: { createdAt: "asc" } });
    const out = new Map<string, string>();
    for (const row of rows) if (row.registryName && !out.has(row.registryName)) out.set(row.registryName, row.id);
    return out;
  }

  /** M17: every mcp URL the user has (a pasted config skips the ones added already). */
  async mcpUrls(userId: string): Promise<Set<string>> {
    const rows = await this.deps.db.customConnector.findMany({ where: { userId, kind: "mcp" }, select: { url: true } });
    return new Set(rows.flatMap((r) => (r.url ? [r.url] : [])));
  }

  /**
   * PUT .../policy: one tool's mode, or tool null = every tool of the connector. M20: Always on a
   * safety-floor / per-recipient tool (policy/floor.ts) is a 400 always_not_allowed; "All tools:
   * Always" skips those tools instead (PolicyService.modes reads them as Ask), as for Composio apps.
   */
  async setPolicy(userId: string, id: string, tool: string | null, mode: Mode): Promise<Shape> {
    const row = await this.own(userId, id);
    const tools = this.toolsOf(row);
    if (tool === null) await this.deps.policy.setToolkit(userId, toolkitOf(row.id), mode, tools.map((t) => policySlug(row.id, t.name)));
    else {
      const found = tools.find((t) => t.name === tool);
      if (!found) throw invalid("tool", "not a tool of this connector");
      const blocked = mode === "always" ? alwaysBlockedFor(toolFacts(row, found)) : null;
      if (blocked) throw alwaysNotAllowed(blocked);
      await this.deps.policy.setTool(userId, policySlug(row.id, tool), mode);
    }
    return this.get(userId, row.id);
  }

  /** The connectors this channel can use (stale mcp tool lists refresh in the background). */
  async enabledFor(userId: string, channelId: string): Promise<ConnectorRow[]> {
    const grant = await this.deps.access.resolve(userId, channelId);
    if (!grant.connectors.size) return [];
    const rows = await this.deps.db.customConnector.findMany({ where: { userId, id: { in: [...grant.connectors] } }, orderBy: [{ name: "asc" }, { createdAt: "asc" }] });
    for (const row of rows) this.refreshIfStale(row);
    return rows;
  }

  /** Lazily, at most one refresh per connector at a time; failures only mark the row. */
  private refreshIfStale(row: ConnectorRow): void {
    if (row.kind !== "mcp" || this.refreshing.has(row.id)) return;
    const age = this.now().getTime() - (row.checkedAt?.getTime() ?? 0);
    if (age < (row.status === "failed" ? RETRY_FAILED_MS : REFRESH_MS)) return;
    const job = this.recheck(row)
      .catch((error: unknown) => { log.warn("custom connector refresh failed", { connectorId: row.id, error: { name: (error as Error)?.name ?? "Error" } }); })
      .finally(() => { this.refreshing.delete(row.id); });
    this.refreshing.set(row.id, job);
  }

  /** Waits for background refreshes (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.refreshing.values()]);
  }
}
