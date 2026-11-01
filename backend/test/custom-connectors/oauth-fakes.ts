// M17 test fakes: an MCP server that wants OAuth (401 + WWW-Authenticate resource_metadata, RFC 9728
// metadata) and its authorization server (RFC 8414 metadata, RFC 7591 registration, an authorize
// step the test plays, a token endpoint that checks PKCE S256, the client, the redirect and the
// resource, and rotates refresh tokens). Both are FakeNet hosts; nothing leaves the process.
import { createHash } from "node:crypto";
import { FakeMcp, type FakeNet, type SeenRequest } from "../channels/harness.ts";

export interface TokenCall { form: Record<string, string>; headers: Record<string, string> }

export class FakeOAuth {
  readonly mcp = new FakeMcp();
  readonly registrations: Record<string, unknown>[] = [];
  readonly tokenCalls: TokenCall[] = [];
  readonly issuedAccess: string[] = [];
  readonly issuedRefresh: string[] = [];
  /** the access tokens the MCP server takes (newest only by default) */
  accepted = new Set<string>();
  /** refresh tokens still valid */
  readonly liveRefresh = new Set<string>();
  /** code -> what the authorize step saw */
  private readonly codes = new Map<string, { challenge: string; method: string; clientId: string; redirectUri: string; resource: string; scope: string | null }>();
  private seq = 0;
  clientSecret: string | null = null;
  expiresIn = 3600;
  rotate = true;
  /** the token endpoint refuses refreshes (invalid_grant) */
  refuseRefresh = false;
  /** metadata knobs */
  hint: string | null = null;
  authorizationServers: string[] = [];
  tokenEndpoint = "";
  registration = true;
  /** MCP requests answered 401 */
  rejected = 0;

  constructor(readonly mcpHost = "mcp.signin.example.com", readonly asHost = "auth.signin.example.com") {
    this.hint = `https://${mcpHost}/.well-known/oauth-protected-resource/mcp`;
    this.authorizationServers = [`https://${asHost}`];
    this.tokenEndpoint = `https://${asHost}/token`;
    this.mcp.tools = [
      { name: "list_issues", description: "List issues", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
      { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    ];
  }

  install(net: FakeNet): void {
    net.route(this.mcpHost, this.mcpHandler);
    net.route(this.asHost, this.asHandler);
  }

  /** The current access token stops working (the server revoked it). */
  revokeAccess(): void {
    this.accepted.clear();
  }

  readonly mcpHandler = async (request: SeenRequest, init: RequestInit): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: `https://${this.mcpHost}/mcp`, authorization_servers: this.authorizationServers, scopes_supported: ["read", "write"] });
    }
    const auth = request.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!this.accepted.has(token)) {
      this.rejected++;
      const hint = this.hint ? `, resource_metadata="${this.hint}"` : "";
      return new Response("{\"error\":\"invalid_token\"}", { status: 401, headers: { "www-authenticate": `Bearer realm="mcp", error="invalid_token"${hint}` } });
    }
    return this.mcp.handler(request, init);
  };

  readonly asHandler = async (request: SeenRequest): Promise<Response> => {
    const url = new URL(request.url);
    const origin = `https://${this.asHost}`;
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: this.tokenEndpoint,
        ...(this.registration ? { registration_endpoint: `${origin}/register` } : {}),
        code_challenge_methods_supported: ["S256"], response_types_supported: ["code"],
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      this.registrations.push(body);
      return Response.json({ client_id: `client-${this.registrations.length}`, ...(this.clientSecret ? { client_secret: this.clientSecret, token_endpoint_auth_method: "client_secret_post" } : {}), redirect_uris: body.redirect_uris }, { status: 201 });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(request.body ?? ""));
      this.tokenCalls.push({ form, headers: request.headers });
      if (this.clientSecret && form.client_secret !== this.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (form.grant_type === "authorization_code") {
        const seen = this.codes.get(form.code ?? "");
        if (!seen) return Response.json({ error: "invalid_grant" }, { status: 400 });
        this.codes.delete(form.code!);
        const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
        if (seen.method !== "S256" || challenge !== seen.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE check failed" }, { status: 400 });
        if (form.client_id !== seen.clientId || form.redirect_uri !== seen.redirectUri || form.resource !== seen.resource) return Response.json({ error: "invalid_request" }, { status: 400 });
        return Response.json(this.issue(true));
      }
      if (form.grant_type === "refresh_token") {
        if (this.refuseRefresh || !this.liveRefresh.has(form.refresh_token ?? "")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (this.rotate) this.liveRefresh.delete(form.refresh_token!);
        return Response.json(this.issue(this.rotate));
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    return new Response("not found", { status: 404 });
  };

  private issue(withRefresh: boolean): Record<string, unknown> {
    const n = ++this.seq;
    const access = `at-SECRET-${n}-${"x".repeat(24)}`;
    this.issuedAccess.push(access);
    this.accepted = new Set([access]);
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: this.expiresIn, scope: "read write" };
    if (withRefresh) {
      const refresh = `rt-SECRET-${n}-${"y".repeat(24)}`;
      this.issuedRefresh.push(refresh);
      this.liveRefresh.add(refresh);
      out.refresh_token = refresh;
    }
    return out;
  }

  /** The user signs in on the authorize page: the code the redirect would carry (and the page's query). */
  approve(authorizeUrl: string): { code: string; state: string; query: URLSearchParams } {
    const url = new URL(authorizeUrl);
    const q = url.searchParams;
    const code = `code-SECRET-${++this.seq}`;
    this.codes.set(code, { challenge: q.get("code_challenge") ?? "", method: q.get("code_challenge_method") ?? "", clientId: q.get("client_id") ?? "", redirectUri: q.get("redirect_uri") ?? "", resource: q.get("resource") ?? "", scope: q.get("scope") });
    return { code, state: q.get("state") ?? "", query: q };
  }

  /** Every secret string this fake handed out. */
  secrets(): string[] {
    return [...this.issuedAccess, ...this.issuedRefresh, ...(this.clientSecret ? [this.clientSecret] : [])];
  }
}

/** A registry entry (the v0 list shape: {server, _meta}). */
export function registryEntry(server: Record<string, unknown>, status = "active"): Record<string, unknown> {
  return { server: { version: "1.0.0", ...server }, _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } } };
}

/** A fake MCP Registry: GET /v0/servers (search, cursor pages) and /v0/servers/<name>/versions/latest. */
export class FakeRegistry {
  pages: Record<string, unknown>[][] = [[]];
  servers = new Map<string, Record<string, unknown>>();
  down = false;
  readonly seen: string[] = [];

  install(net: FakeNet): void {
    net.route("registry.modelcontextprotocol.io", this.handler);
  }

  readonly handler = async (request: SeenRequest): Promise<Response> => {
    this.seen.push(request.url);
    if (this.down) return new Response("unavailable", { status: 503 });
    const url = new URL(request.url);
    const latest = url.pathname.match(/^\/v0\/servers\/(.+)\/versions\/latest$/);
    if (latest) {
      const entry = this.servers.get(decodeURIComponent(latest[1]!));
      return entry ? Response.json(entry) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname === "/v0/servers") {
      const search = url.searchParams.get("search");
      if (search) {
        const all = [...this.servers.values(), ...this.pages.flat()];
        const hits = all.filter((e) => String((e.server as { name: string }).name).toLowerCase().includes(search.toLowerCase()));
        return Response.json({ servers: hits, metadata: { count: hits.length } });
      }
      const index = Number(url.searchParams.get("cursor") ?? "0");
      const page = this.pages[index] ?? [];
      return Response.json({ servers: page, metadata: { count: page.length, ...(index + 1 < this.pages.length ? { nextCursor: String(index + 1) } : {}) } });
    }
    return new Response("not found", { status: 404 });
  };
}
