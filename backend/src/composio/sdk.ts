// The real ComposioGateway on @composio/core@0.27.0 (sessions, the former Tool Router). The SDK
// is imported lazily so a server without COMPOSIO_API_KEY (and every test) never loads it.
// Everything Composio returns is validated here; tokens in connection data never leave this file.
// The model never sees Composio's hosted meta tools: we call session.search / session.execute
// ourselves and the sandbox (remote workbench / bash) is disabled on every session.
import type { Composio } from "@composio/core";
import { z } from "zod";
import { log } from "../log.ts";
import { requestBytes } from "../custom-connectors/outbound.ts";
import type { NetDeps } from "../custom-connectors/net.ts";
import { accountLabelFrom, isMetaTool } from "./names.ts";
import { GatewayError, guardOutbound, type ComposioGateway, type GatewayAccount, type GatewayExecution, type GatewayFailureKind, type GatewaySearchResult, type GatewayTool, type GatewayToolkit } from "./gateway.ts";

type Session = Awaited<ReturnType<Composio["create"]>>;

/** Sessions are reused per user for a while (Composio recommends resuming instead of recreating). */
const SESSION_TTL_MS = 30 * 60_000;
/**
 * M21 (#13): one tool execution waits at most this long. The client's own request timeout is 60 s
 * (tools.execute may retry on top of it); this bound keeps one call under the agent's tool
 * watchdog (agent/runtime.ts TOOL_LIMIT_MS, 2 min per call of execute_app_tools), so the model gets
 * this answer instead of the watchdog's. The request is aborted (the SDK's AbortSignal); the app
 * may still have done it, and the answer says so.
 */
export const EXECUTE_TIMEOUT_MS = 90_000;
const TIMED_OUT = "The app didn't answer in time. It may still have done it: check before trying again.";
type SessionExecute = (slug: string, args?: Record<string, unknown>, options?: undefined, requestOptions?: { signal?: AbortSignal }) => Promise<unknown>;
const LOGO_MAX_BYTES = 1024 * 1024;
const ERROR_TEXT_MAX = 300;

const ToolSchema = z.object({
  slug: z.string().min(1),
  name: z.string().default(""),
  description: z.string().optional().default(""),
  inputParameters: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional().default([]),
  toolkit: z.object({ slug: z.string() }).partial().optional(),
});
const ToolkitSchema = z.object({
  slug: z.string().min(1),
  name: z.string().default(""),
  meta: z.object({
    description: z.string().optional(),
    logo: z.string().optional(),
    categories: z.array(z.object({ name: z.string() }).partial()).optional(),
  }).partial().optional(),
});
const AccountSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["INITIALIZING", "INITIATED", "ACTIVE", "FAILED", "EXPIRED", "INACTIVE", "REVOKED"]),
  alias: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).optional(),
  state: z.object({ val: z.record(z.string(), z.unknown()).optional() }).partial().optional(),
  toolkit: z.object({ slug: z.string().min(1) }),
  createdAt: z.string().default(() => new Date(0).toISOString()),
});
const AccountPage = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullish() });
const SearchSchema = z.object({
  success: z.boolean().optional(),
  error: z.string().nullish(),
  results: z.array(z.object({
    primaryToolSlugs: z.array(z.string()).default([]),
    relatedToolSlugs: z.array(z.string()).default([]),
    executionGuidance: z.string().optional(),
    knownPitfalls: z.array(z.string()).optional(),
  }).loose()).default([]),
  toolSchemas: z.record(z.string(), z.object({ toolSlug: z.string(), toolkit: z.string(), description: z.string().optional() }).loose()).default({}),
  toolkitConnectionStatuses: z.array(z.object({ toolkit: z.string(), hasActiveConnection: z.boolean() }).loose()).default([]),
});
const SessionExecution = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  error: z.string().nullish(),
  resultType: z.enum(["completed", "failed", "blocked"]).optional(),
});
const DirectExecution = z.object({ data: z.record(z.string(), z.unknown()).nullish(), error: z.string().nullish(), successful: z.boolean() });
const Authorization = z.object({ redirectUrl: z.url().nullish() });

/** Composio's text for the model: short, and with anything token-like removed. */
function modelText(text: string | null | undefined): string {
  return (text ?? "").replace(/(bearer\s+)?[A-Za-z0-9_\-]{32,}/gi, "[redacted]").slice(0, ERROR_TEXT_MAX);
}

function failureKind(error: unknown): GatewayFailureKind {
  const name = error instanceof Error ? error.name : "";
  if (/ConnectedAccountNotFound|MultipleConnectedAccounts|AuthConfigNotFound/.test(name)) return "not_connected";
  if (/ToolNotFound|ToolkitNotFound/.test(name)) return "not_found";
  if (/InvalidToolArguments|ToolInputRequired/.test(name)) return "invalid_arguments";
  return "unavailable";
}

function kindFromText(text: string): GatewayFailureKind {
  if (/not connected|no (active )?connect|connected account|reauth|expired|unauthori[sz]ed|\b401\b/i.test(text)) return "not_connected";
  if (/invalid|required|missing|validation|\b400\b|\b422\b/i.test(text)) return "invalid_arguments";
  if (/not found|\b404\b/i.test(text)) return "not_found";
  return "provider";
}

function toTool(raw: unknown, important: boolean): GatewayTool | null {
  const parsed = ToolSchema.safeParse(raw);
  if (!parsed.success || isMetaTool(parsed.data.slug)) return null;
  const tool = parsed.data;
  return {
    slug: tool.slug, toolkit: tool.toolkit?.slug ?? "", name: tool.name, description: tool.description, tags: tool.tags,
    inputSchema: tool.inputParameters ?? { type: "object", properties: {} }, important,
  };
}

function toToolkit(raw: unknown): GatewayToolkit | null {
  const parsed = ToolkitSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { slug, name, meta } = parsed.data;
  return {
    slug, name, description: meta?.description ?? "", logo: meta?.logo ?? null,
    categories: (meta?.categories ?? []).flatMap((c) => (c.name ? [c.name] : [])),
  };
}

export class SdkComposioGateway implements ComposioGateway {
  private client: Promise<Composio> | null = null;
  private readonly sessions = new Map<string, { at: number; session: Promise<Session> }>();

  constructor(private readonly apiKey: string, private readonly now: () => number = Date.now, private readonly executeTimeoutMs = EXECUTE_TIMEOUT_MS, private readonly logoNet: NetDeps = {}) {}

  private composio(): Promise<Composio> {
    this.client ??= import("@composio/core").then(({ Composio: Client }) => new Client({
      apiKey: this.apiKey, allowTracking: false, disableVersionCheck: true, logLevel: "silent",
    }));
    return this.client;
  }

  private async session(userId: string): Promise<Session> {
    const cached = this.sessions.get(userId);
    if (cached && this.now() - cached.at < SESSION_TTL_MS) return cached.session;
    // No code-execution sandbox: the remote workbench / bash meta tools are never available.
    const session = this.composio().then((c) => c.create(userId, { sandbox: { enable: false } }));
    this.sessions.set(userId, { at: this.now(), session });
    session.catch(() => this.sessions.delete(userId));
    return session;
  }

  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // Third-party messages can echo secrets: log the class only.
      log.warn("composio call failed", { call: what, error: { name: (error as Error)?.name ?? "Error" } });
      throw new GatewayError(`Composio ${what} failed`);
    }
  }

  async search(userId: string, query: string, toolkits?: string[]): Promise<GatewaySearchResult> {
    const raw = await this.call("search", async () => (await this.session(userId)).search({ query, ...(toolkits?.length ? { toolkits } : {}) }));
    const parsed = SearchSchema.safeParse(raw);
    if (!parsed.success) throw new GatewayError("Composio search returned an unexpected shape");
    const { results, toolSchemas, toolkitConnectionStatuses } = parsed.data;
    const slugs = [...new Set(results.flatMap((r) => [...r.primaryToolSlugs, ...r.relatedToolSlugs]))].filter((s) => !isMetaTool(s));
    const tools = slugs.flatMap((slug) => {
      const schema = toolSchemas[slug];
      return schema ? [{ slug, toolkit: schema.toolkit, description: schema.description ?? "" }] : [];
    });
    const guidance = results.flatMap((r) => [r.executionGuidance ?? "", ...(r.knownPitfalls ?? [])])
      .filter((g) => g.trim() && !/COMPOSIO_|workbench|\bbash\b|sandbox/i.test(g)).slice(0, 8);
    return { tools, guidance, connections: toolkitConnectionStatuses.map((s) => ({ toolkit: s.toolkit, connected: s.hasActiveConnection })) };
  }

  async getTools(slugs: string[]): Promise<GatewayTool[]> {
    const wanted = slugs.filter((s) => !isMetaTool(s));
    if (!wanted.length) return [];
    const raw = await this.call("tools", async () => (await this.composio()).tools.getRawComposioTools({ tools: wanted }));
    return raw.flatMap((t) => toTool(t, false) ?? []);
  }

  async listTools(toolkit: string): Promise<GatewayTool[]> {
    const client = await this.composio();
    const [all, important] = await Promise.all([
      this.call("tools", () => client.tools.getRawComposioTools({ toolkits: [toolkit], limit: 200 })),
      this.call("tools", () => client.tools.getRawComposioTools({ toolkits: [toolkit], important: true, limit: 50 })).catch(() => []),
    ]);
    const common = new Set(important.map((t) => t.slug));
    return all.flatMap((t) => toTool(t, common.has(t.slug)) ?? []);
  }

  async execute(userId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution> {
    if (isMetaTool(slug)) return { ok: false, kind: "not_found", error: "This tool is not available." };
    let raw: unknown;
    const signal = AbortSignal.timeout(this.executeTimeoutMs);
    try {
      // The session's execute takes the SDK's request options as its 4th argument (ToolRouterSession.execute
      // in @composio/core 0.27's index.d.mts); the Session type the factory returns only lists three.
      const session = (await this.session(userId)) as unknown as { execute: SessionExecute };
      raw = await session.execute(slug, args, undefined, { signal });
    } catch (error) {
      log.warn("composio execute failed", { error: { name: (error as Error)?.name ?? "Error" }, ...(signal.aborted ? { timedOut: true } : {}) });
      this.sessions.delete(userId);
      if (signal.aborted) return { ok: false, kind: "unavailable", error: TIMED_OUT };
      return { ok: false, kind: failureKind(error), error: modelText((error as Error)?.message) };
    }
    const parsed = SessionExecution.safeParse(raw);
    if (!parsed.success) return { ok: false, kind: "unavailable", error: "Unexpected response from Composio." };
    const { data, error, resultType } = parsed.data;
    if (resultType === "completed" || (!resultType && !error)) return { ok: true, data: data ?? {} };
    const text = error ?? "The app returned an error.";
    return { ok: false, kind: resultType === "blocked" ? "provider" : kindFromText(text), error: modelText(text) };
  }

  async executeForAccount(userId: string, accountId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution> {
    if (isMetaTool(slug)) return { ok: false, kind: "not_found", error: "This tool is not available." };
    const signal = AbortSignal.timeout(this.executeTimeoutMs);
    try {
      const raw = await (await this.composio()).tools.execute(slug, { userId, connectedAccountId: accountId, arguments: args, dangerouslySkipVersionCheck: true }, { signal });
      const parsed = DirectExecution.safeParse(raw);
      if (!parsed.success) return { ok: false, kind: "unavailable", error: "Unexpected response from Composio." };
      return parsed.data.successful ? { ok: true, data: parsed.data.data ?? {} } : { ok: false, kind: kindFromText(parsed.data.error ?? ""), error: modelText(parsed.data.error) };
    } catch (error) {
      log.warn("composio execute failed", { error: { name: (error as Error)?.name ?? "Error" }, ...(signal.aborted ? { timedOut: true } : {}) });
      if (signal.aborted) return { ok: false, kind: "unavailable", error: TIMED_OUT };
      return { ok: false, kind: failureKind(error), error: modelText((error as Error)?.message) };
    }
  }

  async listToolkits(): Promise<GatewayToolkit[]> {
    const raw = await this.call("toolkits", async () => (await this.composio()).toolkits.get({ sortBy: "usage", limit: 100 }));
    return (Array.isArray(raw) ? raw : []).flatMap((t) => toToolkit(t) ?? []);
  }

  async getToolkit(slug: string): Promise<GatewayToolkit | null> {
    try {
      return toToolkit(await (await this.composio()).toolkits.get(slug));
    } catch (error) {
      if (/ToolkitNotFound|NotFound/.test((error as Error)?.name ?? "")) return null;
      log.warn("composio call failed", { call: "toolkit", error: { name: (error as Error)?.name ?? "Error" } });
      throw new GatewayError("Composio toolkit lookup failed");
    }
  }

  async listAccounts(userId: string): Promise<GatewayAccount[]> {
    const client = await this.composio();
    const out: GatewayAccount[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const raw = await this.call("accounts", () => client.connectedAccounts.list({ userIds: [userId], limit: 100, ...(cursor ? { cursor } : {}) }));
      const parsed = AccountPage.safeParse(raw);
      if (!parsed.success) throw new GatewayError("Composio accounts returned an unexpected shape");
      for (const item of parsed.data.items) {
        const account = AccountSchema.safeParse(item);
        if (!account.success) continue;
        const { id, status, alias, data, state, toolkit, createdAt } = account.data;
        out.push({ id, status, toolkit: toolkit.slug, alias: alias ?? null, label: accountLabelFrom({ ...(state?.val ?? {}), ...(data ?? {}) }), createdAt });
      }
      cursor = parsed.data.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  async authorize(userId: string, toolkit: string, callbackUrl: string): Promise<{ url: string }> {
    const raw = await this.call("authorize", async () => (await this.session(userId)).authorize(toolkit, { callbackUrl }));
    const parsed = Authorization.safeParse(raw);
    if (!parsed.success || !parsed.data.redirectUrl) throw new GatewayError("Composio returned no connect link");
    return { url: parsed.data.redirectUrl };
  }

  async disconnect(accountId: string): Promise<void> {
    await this.call("disconnect", async () => (await this.composio()).connectedAccounts.delete(accountId));
  }

  async fetchLogo(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const answer = await requestBytes(url, { timeoutMs: 5000, maxBytes: LOGO_MAX_BYTES, headers: { accept: "image/*" } }, this.logoNet);
      const contentType = (answer.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (answer.status < 200 || answer.status >= 300 || !contentType.startsWith("image/")) return null;
      return answer.bytes.byteLength > 0 ? { bytes: answer.bytes, contentType } : null;
    } catch {
      return null;
    }
  }
}

/**
 * The gateway for this server, or null when COMPOSIO_API_KEY isn't set ("isn't set up yet"). M20:
 * always behind guardOutbound, so no execution (direct or approved) carries a credential out.
 */
export function createComposioGateway(config: { COMPOSIO_API_KEY?: string | undefined }): ComposioGateway | null {
  return config.COMPOSIO_API_KEY ? guardOutbound(new SdkComposioGateway(config.COMPOSIO_API_KEY)) : null;
}
