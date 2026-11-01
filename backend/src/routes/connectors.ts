// /api/connectors (docs/API.md, L127 data, L167): the catalog with the user's accounts, a toolkit's
// tools grouped Read (Always) / Write (Ask) with common tools first, logos through the server,
// Composio's hosted OAuth, Disconnect, and the per-tool / "All tools" policy. Without
// COMPOSIO_API_KEY the list says configured: false and every other route is 503 not_configured.
// M20: tool rows carry alwaysAllowed / alwaysBlocked (policy/floor.ts); Always on one such tool is
// a 400 always_not_allowed, and "All tools" Always skips them (PolicyService reads them as Ask).
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { ConnectResponse, ConnectorDetail, ConnectorList, UpdatePolicyRequest } from "../contract/connectors.ts";
import { GatewayError, type GatewayToolkit } from "../composio/gateway.ts";
import { displayName, isMetaTool, toolDisplayName, TOOLKIT_SLUG } from "../composio/names.ts";
import { HttpError, readJson } from "../http.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import { OAUTH_CALLBACK } from "../connectors/provider.ts";
import { classify } from "../policy/classify.ts";
import { alwaysBlockedFor, alwaysFields, alwaysNotAllowed } from "../policy/floor.ts";
import type { PolicyService } from "../policy/service.ts";

export interface ConnectorRouteDeps { catalog: ConnectorCatalog | null; policy: PolicyService }

const notConfigured = () => new HttpError(503, "not_configured", "Connected apps aren't set up on this server.");
const notFound = () => new HttpError(404, "not_found", "Not found.");

/** Composio being down is a 502 with no third-party detail. */
async function upstream<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GatewayError) throw new HttpError(502, "internal", "Connected apps couldn't be reached. Try again in a moment.");
    throw error;
  }
}

export function connectorRoutes(deps: ConnectorRouteDeps): RegisterRoutes {
  const { catalog, policy } = deps;

  const need = (): ConnectorCatalog => {
    if (!catalog) throw notConfigured();
    return catalog;
  };

  async function toolkitOf(c: Context<AppEnv>): Promise<GatewayToolkit> {
    const slug = c.req.param("toolkit") ?? "";
    if (!TOOLKIT_SLUG.test(slug)) throw notFound();
    const toolkit = await upstream(() => need().toolkit(slug));
    if (!toolkit) throw notFound();
    return toolkit;
  }

  async function detail(userId: string, toolkit: GatewayToolkit) {
    const cat = need();
    const [tools, accounts] = await upstream(() => Promise.all([cat.tools(toolkit.slug), cat.accounts(userId)]));
    const visible = tools.filter((t) => !isMetaTool(t.slug));
    const modes = await policy.modes(userId, visible.map((t) => ({ slug: t.slug, toolkit: toolkit.slug, tags: t.tags })));
    const rows = visible.map((t) => {
      const facts = { slug: t.slug, toolkit: toolkit.slug, tags: t.tags };
      return {
        slug: t.slug,
        name: toolDisplayName(t.slug, t.name, toolkit.slug),
        description: t.description,
        access: classify(facts) === "read" ? "read" as const : "write" as const,
        mode: modes.get(t.slug) ?? "ask",
        common: t.important,
        // M20: Always is disabled (with the reason) for the safety floor and tools that send to others.
        ...alwaysFields(facts),
      };
    });
    rows.sort((a, b) => (a.access === b.access ? 0 : a.access === "read" ? -1 : 1) || Number(b.common) - Number(a.common) || a.name.localeCompare(b.name));
    return ConnectorDetail.parse({ connector: await cat.connector(toolkit, accounts), tools: rows });
  }

  return (app) => {
    app.get("/api/connectors", async (c) => {
      if (!catalog) return c.json(ConnectorList.parse({ configured: false, connectors: [] }));
      const query = (c.req.query("query") ?? "").trim().toLowerCase().slice(0, 100);
      const userId = c.get("user").id;
      const [toolkits, accounts] = await upstream(() => Promise.all([catalog.toolkits(), catalog.accounts(userId)]));
      const all = [...toolkits];
      for (const slug of new Set(accounts.map((a) => a.toolkit))) {
        if (!all.some((t) => t.slug === slug)) {
          const extra = await upstream(() => catalog.toolkit(slug));
          if (extra) all.push(extra);
        }
      }
      const matches = all.filter((t) => !query || t.slug.includes(query) || displayName(t.slug, t.name).toLowerCase().includes(query) || t.description.toLowerCase().includes(query));
      const connected = new Set(accounts.map((a) => a.toolkit));
      const ordered = [...matches.filter((t) => connected.has(t.slug)), ...matches.filter((t) => !connected.has(t.slug))];
      const connectors = await Promise.all(ordered.map((t) => catalog.connector(t, accounts)));
      return c.json(ConnectorList.parse({ configured: true, connectors }));
    });

    app.get("/api/connectors/:toolkit", async (c) => c.json(await detail(c.get("user").id, await toolkitOf(c))));

    app.get("/api/connectors/:toolkit/logo", async (c) => {
      const toolkit = await toolkitOf(c);
      const logo = await upstream(() => need().logo(toolkit.slug));
      if (!logo) throw notFound();
      // Logos come from Composio's CDN; served as an image only (SVG can't run script here).
      return new Response(logo.bytes, { headers: {
        "Content-Type": logo.contentType, "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      } });
    });

    app.post("/api/connectors/:toolkit/connect", async (c) => {
      const toolkit = await toolkitOf(c);
      const userId = c.get("user").id;
      const { url } = await upstream(() => need().gateway.authorize(userId, toolkit.slug, OAUTH_CALLBACK));
      need().invalidateAccounts(userId);
      return c.json(ConnectResponse.parse({ url, callbackScheme: "duet" }));
    });

    app.delete("/api/connectors/:toolkit/accounts/:accountId", async (c) => {
      const toolkit = await toolkitOf(c);
      const userId = c.get("user").id;
      const cat = need();
      cat.invalidateAccounts(userId);
      const accounts = await upstream(() => cat.accounts(userId));
      const account = accounts.find((a) => a.id === c.req.param("accountId") && a.toolkit === toolkit.slug);
      if (!account) throw notFound();
      await upstream(() => cat.gateway.disconnect(account.id));
      cat.invalidateAccounts(userId);
      return c.body(null, 204);
    });

    app.put("/api/connectors/:toolkit/policy", async (c) => {
      const toolkit = await toolkitOf(c);
      const userId = c.get("user").id;
      const body = await readJson(c, UpdatePolicyRequest);
      const tools = (await upstream(() => need().tools(toolkit.slug))).filter((t) => !isMetaTool(t.slug));
      if (body.tool === null) {
        await policy.setToolkit(userId, toolkit.slug, body.mode, tools.map((t) => t.slug));
      } else {
        const tool = tools.find((t) => t.slug === body.tool);
        if (!tool) throw new HttpError(400, "validation_failed", "tool: not a tool of this app", "tool");
        const blocked = body.mode === "always" ? alwaysBlockedFor({ slug: tool.slug, toolkit: toolkit.slug, tags: tool.tags }) : null;
        if (blocked) throw alwaysNotAllowed(blocked);
        await policy.setTool(userId, tool.slug, body.mode);
      }
      return c.json(await detail(userId, toolkit));
    });
  };
}
