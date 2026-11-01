// M17: sign-in for remote MCP servers (the MCP authorization spec: OAuth 2.1 + PKCE, RFC 9728
// protected resource metadata, RFC 8414 / OIDC discovery, RFC 7591 dynamic client registration,
// RFC 8707 resource indicators), after Codync's host/src/market/oauth.rs. The app opens the
// authorize URL in ASWebAuthenticationSession with redirect duet://oauth/callback and posts the
// code + state back; the PKCE verifier stays here (in memory, single use, 10 minutes). One OAuth
// client per user and authorization server (OAuthClient, its secret in the vault); a connector's
// tokens are vault rows "oauth:access_token" / "oauth:refresh_token" of the connector, its grant
// (OAuthGrant) holds only the client, expiry, scope and resource. Tokens refresh a minute before
// they run out and once after a 401, one refresh per connector at a time (servers that rotate
// refresh tokens revoke the old one on use); a refused refresh signs the connector out. Every URL
// from metadata goes through outbound.ts (net.ts's guard). Nothing secret is logged or returned:
// errors carry plain words, a status and at most an OAuth error code.
import { createHash, randomBytes } from "node:crypto";
import type { CustomConnector as ConnectorRow, OAuthClient, OAuthGrant } from "@prisma/client";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import type { Vault } from "../vault/index.ts";
import { mcpProbe, McpError } from "./mcp.ts";
import { NetError, type NetDeps } from "./net.ts";
import { asObject, guardUrl, requestJson, textOf } from "./outbound.ts";

export const CALLBACK_SCHEME = "duet";
export const REDIRECT_URI = "duet://oauth/callback";
export const OAUTH_PREFIX = "oauth:";
export const ACCESS_TOKEN = "oauth:access_token";
export const REFRESH_TOKEN = "oauth:refresh_token";
const CLIENT_SECRET = "client_secret";
export const PENDING_TTL_MS = 10 * 60_000;
/** Tokens this close to running out are refreshed before use. */
const EARLY_MS = 60_000;
const MAX_PENDING_PER_USER = 20;
const TOKEN_MAX = 8192;
/** RFC 6750 b64token-ish: printable ASCII, no spaces (it goes into a header). */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;
const MAX_LIFETIME_S = 10 * 365 * 24 * 3600;

/** A sign-in step that failed, in plain words (never a token, code, secret or the server's body). */
export class OAuthError extends Error {
  constructor(message: string, readonly kind: "discovery" | "registration" | "refused" | "expired" | "unreachable" = "discovery") {
    super(message);
    this.name = "OAuthError";
  }
}

/** The connector waits for (another) sign-in: no request was sent. */
export class SignInNeeded extends McpError {
  constructor(name: string, again = false) {
    super(again ? `Sign in to ${name} again to use it.` : `Sign in to ${name} to finish connecting it.`, "auth");
    this.name = "SignInNeeded";
  }
}

export const signInMessage = (name: string, again = false) => new SignInNeeded(name, again).message;

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const hostOf = (raw: string) => { try { return new URL(raw).hostname; } catch { return "the sign-in server"; } };
const codeOf = (value: unknown) => (typeof value === "string" && ERROR_CODE.test(value) ? value : null);

/** The auth-params of a `Bearer` challenge (resource_metadata, scope, error), quoted or not. */
export function bearerParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const at = header.search(/\bbearer\b/i);
  if (at < 0) return out;
  for (const m of header.slice(at + 6).matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    const key = m[1]!.toLowerCase();
    if (!(key in out)) out[key] = (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]!).slice(0, 2000);
  }
  return out;
}

interface ServerMeta { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null }
interface Tokens { access: string; refresh: string | null; expiresIn: number | null; scope: string | null }
interface Pending { userId: string; connectorId: string; verifier: string; clientId: string; resource: string; expiresAt: number }

export interface OAuthDeps { db: Db; vault: Vault; net: () => NetDeps; now: () => Date }

export class OAuthFlow {
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly deps: OAuthDeps) {}

  private get net(): NetDeps {
    return this.deps.net();
  }

  private get nowMs(): number {
    return this.deps.now().getTime();
  }

  /**
   * Does this server ask for OAuth sign-in? One `initialize` with the given headers: a 401 when the
   * user gave no credentials of their own = yes; a 2xx without user credentials whose protected
   * resource metadata names an authorization server = yes (initialize is open, tools aren't);
   * anything else = no (the normal verify then reports what's wrong).
   */
  async probe(url: string, headers: Record<string, string>, userCredentials: boolean): Promise<boolean> {
    if (userCredentials) return false;
    let server: URL;
    try {
      server = guardUrl(url);
    } catch {
      return false;
    }
    let answer: { status: number; wwwAuthenticate: string | null };
    try {
      answer = await mcpProbe(server, headers, this.net);
    } catch {
      return false;
    }
    if (answer.status === 401) return true;
    if (answer.status < 200 || answer.status >= 300) return false;
    return (await this.resourceMetadata(server, null)) !== null;
  }

  /** RFC 9728: the hint from WWW-Authenticate, then the well-known paths (path-specific first). */
  private async resourceMetadata(server: URL, hint: string | null): Promise<Record<string, unknown> | null> {
    const path = server.pathname.replace(/\/+$/, "");
    const candidates = [
      ...(hint ? [hint] : []),
      ...(path ? [`${server.origin}/.well-known/oauth-protected-resource${path}`] : []),
      `${server.origin}/.well-known/oauth-protected-resource`,
    ];
    for (const candidate of candidates) {
      let answer;
      try {
        answer = await requestJson(candidate, {}, this.net);
      } catch (error) {
        // A hint to a refused address is skipped like one that doesn't answer (nothing was sent there).
        if (error instanceof NetError) continue;
        throw error;
      }
      const doc = asObject(answer.json);
      if (answer.status !== 200 || !doc || !Array.isArray(doc.authorization_servers)) continue;
      // The metadata must be about this server (same origin), else it's ignored.
      const resource = textOf(doc.resource);
      if (resource) {
        try {
          if (new URL(resource).origin !== server.origin) continue;
        } catch {
          continue;
        }
      }
      return doc;
    }
    return null;
  }

  /** RFC 8414, then OpenID discovery; the document's issuer must be the one asked for. */
  private async serverMetadata(issuer: string): Promise<ServerMeta> {
    let base: URL;
    try {
      base = guardUrl(issuer);
    } catch (error) {
      throw new OAuthError(`The sign-in server's address isn't allowed${error instanceof NetError ? `: ${error.message}` : "."}`);
    }
    const path = base.pathname.replace(/\/+$/, "");
    const candidates = path
      ? [`${base.origin}/.well-known/oauth-authorization-server${path}`, `${base.origin}/.well-known/openid-configuration${path}`, `${base.origin}${path}/.well-known/openid-configuration`]
      : [`${base.origin}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration`];
    const wanted = issuer.replace(/\/+$/, "");
    for (const candidate of candidates) {
      let answer;
      try {
        answer = await requestJson(candidate, {}, this.net);
      } catch (error) {
        if (error instanceof NetError && (error.kind === "blocked" || error.kind === "invalid")) throw new OAuthError(`The sign-in server's address isn't allowed: ${error.message}`);
        if (error instanceof NetError) continue;
        throw error;
      }
      const doc = asObject(answer.json);
      const authorize = textOf(doc?.authorization_endpoint);
      const token = textOf(doc?.token_endpoint);
      if (answer.status !== 200 || !doc || !authorize || !token) continue;
      const declared = textOf(doc.issuer);
      if (declared && declared.replace(/\/+$/, "") !== wanted) continue;
      const methods = doc.code_challenge_methods_supported;
      if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthError(`${base.hostname} doesn't support PKCE (S256), so it can't be signed in to safely.`);
      const registration = textOf(doc.registration_endpoint);
      try {
        return {
          issuer: wanted,
          authorizationEndpoint: guardUrl(authorize).href,
          tokenEndpoint: guardUrl(token).href,
          registrationEndpoint: registration ? guardUrl(registration).href : null,
        };
      } catch (error) {
        throw new OAuthError(`The sign-in server's address isn't allowed${error instanceof NetError ? `: ${error.message}` : "."}`);
      }
    }
    throw new OAuthError(`${base.hostname} doesn't describe how to sign in.`);
  }

  /** The user's client at this authorization server: stored, else registered (RFC 7591). */
  private async client(userId: string, meta: ServerMeta): Promise<OAuthClient> {
    const { db, vault } = this.deps;
    const where = { userId_issuer_redirectUri: { userId, issuer: meta.issuer, redirectUri: REDIRECT_URI } };
    const existing = await db.oAuthClient.findUnique({ where });
    if (existing) {
      if (existing.authorizationEndpoint === meta.authorizationEndpoint && existing.tokenEndpoint === meta.tokenEndpoint && existing.registrationEndpoint === meta.registrationEndpoint) return existing;
      return db.oAuthClient.update({ where: { id: existing.id }, data: { authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint, registrationEndpoint: meta.registrationEndpoint } });
    }
    const host = hostOf(meta.issuer);
    if (!meta.registrationEndpoint) throw new OAuthError(`${host} doesn't let new apps register on their own. Add it as a custom connector with a token header instead.`, "registration");
    let answer;
    try {
      answer = await requestJson(meta.registrationEndpoint, {
        method: "POST",
        body: { client_name: "OpenDuet", redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" },
        maxBytes: 64 * 1024,
      }, this.net);
    } catch (error) {
      if (error instanceof NetError) throw new OAuthError(`${host} couldn't be reached to register the app (${error.kind}).`, error.kind === "blocked" || error.kind === "invalid" ? "registration" : "unreachable");
      throw error;
    }
    const doc = asObject(answer.json);
    const clientId = textOf(doc?.client_id, 500);
    if (answer.status < 200 || answer.status >= 300 || !clientId) {
      const code = codeOf(doc?.error);
      throw new OAuthError(`${host} refused the app's registration (${answer.status}${code ? `, ${code}` : ""}).`, "registration");
    }
    const secret = textOf(doc!.client_secret, 4000);
    const declared = textOf(doc!.token_endpoint_auth_method, 64);
    const authMethod = !secret ? "none" : declared === "client_secret_basic" ? "client_secret_basic" : "client_secret_post";
    try {
      return await db.$transaction(async (tx) => {
        const row = await tx.oAuthClient.create({ data: { userId, issuer: meta.issuer, authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint, registrationEndpoint: meta.registrationEndpoint, clientId, authMethod, redirectUri: REDIRECT_URI } });
        if (secret) await vault.put(userId, "oauth_client", row.id, CLIENT_SECRET, secret, tx);
        return row;
      });
    } catch (error) {
      // Two sign-ins registered at once: the one stored first is used.
      const raced = await db.oAuthClient.findUnique({ where });
      if (raced) return raced;
      throw error;
    }
  }

  /** A client the server no longer knows (invalid_client): the next sign-in registers again. */
  private async forgetClient(client: OAuthClient): Promise<void> {
    await this.deps.db.$transaction(async (tx) => {
      await tx.oAuthClient.deleteMany({ where: { id: client.id, userId: client.userId } });
      await this.deps.vault.deleteOwner(client.userId, "oauth_client", client.id, tx);
    });
  }

  /**
   * POST .../oauth/start: discovery (the server's 401 challenge, its resource metadata, the
   * authorization server's metadata), the client, then PKCE S256 + a random state kept here.
   * `headers`: the connector's own headers (sent with the probe; never an Authorization header).
   */
  async start(row: ConnectorRow, headers: Record<string, string>): Promise<{ authorizeUrl: string; expiresAt: Date }> {
    let server: URL;
    try {
      server = guardUrl(row.url ?? "");
    } catch (error) {
      throw new OAuthError(error instanceof NetError ? error.message : "That isn't a valid URL.");
    }
    let hint: string | null = null;
    let challengeScope: string | null = null;
    try {
      const plain = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
      const answer = await mcpProbe(server, plain, this.net);
      if (answer.status === 401) {
        const params = bearerParams(answer.wwwAuthenticate);
        hint = params.resource_metadata ?? null;
        challengeScope = params.scope ?? null;
      }
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      // Unreachable now: discovery below fails with its own words.
    }
    const prm = await this.resourceMetadata(server, hint);
    const servers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === "string" && s.length <= 2000) : [];
    // No resource metadata: the server's origin is its own authorization server (the 2025-03 spec).
    const issuer = servers[0] ?? server.origin;
    const declared = textOf(prm?.resource);
    const resource = declared ?? `${server.origin}${server.pathname}${server.search}`;
    const meta = await this.serverMetadata(issuer);
    const client = await this.client(row.userId, meta);
    const supported = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === "string" && /^[\x21-\x7e]{1,200}$/.test(s)) : [];
    const scope = (challengeScope ?? (supported.length ? supported.join(" ") : null))?.slice(0, 1000) ?? null;

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(32));
    const link = new URL(client.authorizationEndpoint);
    link.searchParams.set("response_type", "code");
    link.searchParams.set("client_id", client.clientId);
    link.searchParams.set("redirect_uri", client.redirectUri);
    link.searchParams.set("code_challenge", challenge);
    link.searchParams.set("code_challenge_method", "S256");
    link.searchParams.set("state", state);
    link.searchParams.set("resource", resource);
    if (scope) link.searchParams.set("scope", scope);
    const expiresAt = this.nowMs + PENDING_TTL_MS;
    this.keep(state, { userId: row.userId, connectorId: row.id, verifier, clientId: client.id, resource, expiresAt });
    return { authorizeUrl: link.href, expiresAt: new Date(expiresAt) };
  }

  private keep(state: string, entry: Pending): void {
    const now = this.nowMs;
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    const mine = [...this.pending].filter(([, value]) => value.userId === entry.userId);
    // Oldest first (insertion order): a user starting sign-in over and over keeps the newest 20.
    for (const [key] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_USER + 1))) this.pending.delete(key);
    this.pending.set(state, entry);
  }

  /** The pending sign-in for this state, once: another user's or connector's state isn't touched. */
  private take(state: string, userId: string, connectorId: string): Pending | null {
    const entry = this.pending.get(state);
    if (!entry || entry.userId !== userId || entry.connectorId !== connectorId) return null;
    this.pending.delete(state);
    return entry.expiresAt > this.nowMs ? entry : null;
  }

  /** POST .../oauth/finish: the code for tokens (with the verifier and the resource), stored in the vault. */
  async finish(row: ConnectorRow, input: { state: string; code?: string | undefined; error?: string | undefined }): Promise<void> {
    const entry = this.take(input.state, row.userId, row.id);
    if (!entry) throw new OAuthError("This sign-in expired or was already used. Start it again.", "expired");
    if (input.error || !input.code) {
      const code = codeOf(input.error);
      throw new OAuthError(code === "access_denied" ? "Sign-in was cancelled." : `Sign-in didn't finish${code ? ` (${code})` : ""}.`, "refused");
    }
    const client = await this.deps.db.oAuthClient.findFirst({ where: { id: entry.clientId, userId: row.userId } });
    if (!client) throw new OAuthError("This sign-in expired or was already used. Start it again.", "expired");
    const tokens = await this.tokenRequest(client, { grant_type: "authorization_code", code: input.code, redirect_uri: client.redirectUri, code_verifier: entry.verifier, resource: entry.resource });
    await this.store(row, client.id, entry.resource, tokens, "sign_in");
  }

  private async tokenRequest(client: OAuthClient, form: Record<string, string>): Promise<Tokens> {
    const secret = client.authMethod === "none" ? null : await this.deps.vault.get(client.userId, "oauth_client", client.id, CLIENT_SECRET);
    const body = { ...form };
    const headers: Record<string, string> = {};
    if (client.authMethod === "client_secret_basic" && secret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
    } else {
      body.client_id = client.clientId;
      if (secret) body.client_secret = secret;
    }
    const host = hostOf(client.tokenEndpoint);
    let answer;
    try {
      answer = await requestJson(client.tokenEndpoint, { method: "POST", form: body, headers, timeoutMs: 20_000, maxBytes: 64 * 1024 }, this.net);
    } catch (error) {
      if (error instanceof NetError) throw new OAuthError(`${host} couldn't be reached (${error.kind}).`, "unreachable");
      throw error;
    }
    const doc = asObject(answer.json);
    const access = doc?.access_token;
    if (answer.status < 200 || answer.status >= 300 || typeof access !== "string" || access.length > TOKEN_MAX || !TOKEN_CHARS.test(access)) {
      const code = codeOf(doc?.error);
      if (code === "invalid_client") await this.forgetClient(client);
      // 4xx: the server said no (a refresh: sign in again); 5xx or no JSON: it's down (try later).
      const refused = answer.status >= 400 && answer.status < 500;
      throw new OAuthError(`${host} refused the request (${answer.status}${code ? `, ${code}` : ""}).`, refused || answer.status < 300 ? "refused" : "unreachable");
    }
    const type = textOf(doc!.token_type, 64);
    if (type && type.toLowerCase() !== "bearer") throw new OAuthError(`${host} issued a ${type.slice(0, 20)} token; only Bearer tokens work.`, "refused");
    const rawRefresh = doc!.refresh_token;
    const refresh = typeof rawRefresh === "string" && rawRefresh.length <= TOKEN_MAX && TOKEN_CHARS.test(rawRefresh) ? rawRefresh : null;
    const rawExpires = doc!.expires_in;
    const expiresIn = typeof rawExpires === "number" ? rawExpires : typeof rawExpires === "string" && /^\d{1,10}$/.test(rawExpires) ? Number(rawExpires) : null;
    return { access, refresh, expiresIn: expiresIn !== null && expiresIn > 0 && expiresIn < MAX_LIFETIME_S ? Math.floor(expiresIn) : null, scope: textOf(doc!.scope, 2000) };
  }

  /** Tokens into the vault, the grant signed in. A refresh without a new refresh token keeps the old one. */
  private async store(row: ConnectorRow, clientId: string, resource: string, tokens: Tokens, mode: "sign_in" | "refresh"): Promise<void> {
    const { db, vault } = this.deps;
    const now = this.deps.now();
    const expiresAt = tokens.expiresIn !== null ? new Date(now.getTime() + tokens.expiresIn * 1000) : null;
    await db.$transaction(async (tx) => {
      await vault.put(row.userId, "connector", row.id, ACCESS_TOKEN, tokens.access, tx);
      if (tokens.refresh) await vault.put(row.userId, "connector", row.id, REFRESH_TOKEN, tokens.refresh, tx);
      else if (mode === "sign_in") await vault.remove(row.userId, "connector", row.id, REFRESH_TOKEN, tx);
      const data = { clientId, resource, status: "signed_in", expiresAt, ...(tokens.scope !== null || mode === "sign_in" ? { scope: tokens.scope } : {}), ...(mode === "sign_in" ? { signedInAt: now } : {}) };
      await tx.oAuthGrant.upsert({ where: { connectorId: row.id }, create: { userId: row.userId, connectorId: row.id, ...data }, update: data });
    });
  }

  /**
   * The access token to send: refreshed first when it runs out within a minute, or `rejected` (the
   * token the server just answered 401 to). SignInNeeded when there's none and no way to get one.
   */
  async accessToken(row: ConnectorRow, grant: OAuthGrant, rejected: string | null = null): Promise<string> {
    if (grant.status !== "signed_in") throw new SignInNeeded(row.name, grant.signedInAt !== null);
    const token = await this.deps.vault.get(row.userId, "connector", row.id, ACCESS_TOKEN);
    const expiring = grant.expiresAt !== null && grant.expiresAt.getTime() - EARLY_MS <= this.nowMs;
    if (token && !expiring && rejected === null) return token;
    const running = this.refreshing.get(row.id);
    if (running) return running;
    const job = this.refresh(row, rejected).finally(() => { this.refreshing.delete(row.id); });
    this.refreshing.set(row.id, job);
    return job;
  }

  private async refresh(row: ConnectorRow, rejected: string | null): Promise<string> {
    const { db, vault } = this.deps;
    // Read again: another request may have refreshed in the meantime.
    const grant = await db.oAuthGrant.findUnique({ where: { connectorId: row.id } });
    if (!grant || grant.status !== "signed_in") throw new SignInNeeded(row.name, true);
    const current = await vault.get(row.userId, "connector", row.id, ACCESS_TOKEN);
    const fresh = grant.expiresAt === null || grant.expiresAt.getTime() - EARLY_MS > this.nowMs;
    if (current && (rejected !== null ? current !== rejected : fresh)) return current;
    const refreshToken = await vault.get(row.userId, "connector", row.id, REFRESH_TOKEN);
    const client = grant.clientId ? await db.oAuthClient.findFirst({ where: { id: grant.clientId, userId: row.userId } }) : null;
    if (!refreshToken || !client) {
      await this.signOut(row);
      throw new SignInNeeded(row.name, true);
    }
    let tokens: Tokens;
    try {
      tokens = await this.tokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken, resource: grant.resource });
    } catch (error) {
      if (error instanceof OAuthError && (error.kind === "refused" || error.kind === "registration")) {
        log.warn("custom connector sign-in refresh refused", { connectorId: row.id });
        await this.signOut(row);
        throw new SignInNeeded(row.name, true);
      }
      if (error instanceof OAuthError) throw new McpError(error.message, "unreachable");
      throw error;
    }
    await this.store(row, client.id, grant.resource, tokens, "refresh");
    return tokens.access;
  }

  /**
   * Signed out (a refused refresh, or Disconnect): the tokens are deleted, the grant waits for a new
   * sign-in and the connector is `failed` with the reason (so older apps see why it stopped).
   */
  async signOut(row: ConnectorRow): Promise<void> {
    const { db, vault } = this.deps;
    await db.$transaction(async (tx) => {
      await vault.deletePrefix(row.userId, "connector", row.id, OAUTH_PREFIX, tx);
      await tx.oAuthGrant.updateMany({ where: { connectorId: row.id, userId: row.userId }, data: { status: "needs_sign_in", expiresAt: null, scope: null } });
      await tx.customConnector.updateMany({ where: { id: row.id, userId: row.userId }, data: { status: "failed", error: signInMessage(row.name, true), checkedAt: this.deps.now() } });
    });
  }
}
