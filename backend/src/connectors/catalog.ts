// Cached lookups over the Composio gateway: the toolkit catalog, a toolkit's tools, the user's
// connected accounts (with their real address, L167) and logos. Display names (L168) come from here.
import type { z } from "zod";
import type { ConnectedAccount, Connector } from "../contract/connectors.ts";
import type { ComposioGateway, GatewayAccount, GatewayTool, GatewayToolkit } from "../composio/gateway.ts";
import { categoryOf, displayName, emailFrom, TOOLKIT_SLUG } from "../composio/names.ts";

type Account = z.infer<typeof ConnectedAccount>;

const CATALOG_TTL_MS = 60 * 60_000;
const TOOLS_TTL_MS = 10 * 60_000;
const ACCOUNTS_TTL_MS = 60_000;
const LOGO_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;

/**
 * When Composio's connection data carries no address, one read tool per toolkit is called once per
 * account and the answer cached in memory (until restart). Only toolkits listed here; the others
 * fall back to the account alias, then the app's display name.
 */
export const PROFILE_TOOLS: Record<string, string> = { gmail: "GMAIL_GET_PROFILE" };

interface Cached<T> { at: number; value: T }

export interface UserAccount extends Account { toolkit: string }

export class ConnectorCatalog {
  private catalog: Cached<GatewayToolkit[]> | null = null;
  private readonly toolkitCache = new Map<string, Cached<GatewayToolkit | null>>();
  private readonly toolsCache = new Map<string, Cached<GatewayTool[]>>();
  private readonly accountsCache = new Map<string, Cached<UserAccount[]>>();
  private readonly labels = new Map<string, Cached<string | null>>();
  private readonly logos = new Map<string, Cached<{ bytes: Uint8Array; contentType: string } | null>>();
  private readonly accountListeners: ((userId: string, accounts: readonly UserAccount[]) => void)[] = [];

  constructor(readonly gateway: ComposioGateway, private readonly now: () => number = Date.now) {}

  /** M11: called after every fresh accounts listing (connection cards turn connected); never throws into it. */
  onAccounts(listener: (userId: string, accounts: readonly UserAccount[]) => void): void {
    this.accountListeners.push(listener);
  }

  private fresh<T>(entry: Cached<T> | null | undefined, ttl: number): entry is Cached<T> {
    return !!entry && this.now() - entry.at < ttl;
  }

  async toolkits(): Promise<GatewayToolkit[]> {
    if (this.fresh(this.catalog, CATALOG_TTL_MS)) return this.catalog.value;
    const value = await this.gateway.listToolkits();
    this.catalog = { at: this.now(), value };
    return value;
  }

  async toolkit(slug: string): Promise<GatewayToolkit | null> {
    if (!TOOLKIT_SLUG.test(slug)) return null;
    const listed = this.fresh(this.catalog, CATALOG_TTL_MS) ? this.catalog.value.find((t) => t.slug === slug) : undefined;
    if (listed) return listed;
    const cached = this.toolkitCache.get(slug);
    if (this.fresh(cached, CATALOG_TTL_MS)) return cached.value;
    const value = await this.gateway.getToolkit(slug);
    this.toolkitCache.set(slug, { at: this.now(), value });
    return value;
  }

  /** The display name of a toolkit (never its slug). */
  async name(slug: string): Promise<string> {
    const known = this.catalog?.value.find((t) => t.slug === slug) ?? this.toolkitCache.get(slug)?.value;
    if (known) return displayName(slug, known.name);
    try {
      return displayName(slug, (await this.toolkit(slug))?.name);
    } catch {
      return displayName(slug);
    }
  }

  /** slug -> display name for every toolkit we know of (catalog + the user's apps). */
  async names(extra: readonly string[] = []): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try { for (const t of await this.toolkits()) out.set(t.slug, displayName(t.slug, t.name)); } catch { /* catalog unavailable */ }
    for (const slug of extra) if (!out.has(slug)) out.set(slug, await this.name(slug));
    return out;
  }

  async tools(toolkit: string): Promise<GatewayTool[]> {
    const cached = this.toolsCache.get(toolkit);
    if (this.fresh(cached, TOOLS_TTL_MS)) return cached.value;
    const value = await this.gateway.listTools(toolkit);
    this.toolsCache.set(toolkit, { at: this.now(), value });
    return value;
  }

  /** The user's accounts in the contract's statuses (connections still being set up are left out). */
  async accounts(userId: string): Promise<UserAccount[]> {
    const cached = this.accountsCache.get(userId);
    if (this.fresh(cached, ACCOUNTS_TTL_MS)) return cached.value;
    const raw = await this.gateway.listAccounts(userId);
    const value: UserAccount[] = [];
    for (const account of raw) {
      const status = account.status === "ACTIVE" ? "active" : account.status === "EXPIRED" || account.status === "INACTIVE" ? "expired" : account.status === "FAILED" ? "failed" : null;
      if (!status) continue;
      const created = new Date(account.createdAt);
      const connectedAt = Number.isNaN(created.getTime()) ? new Date(0).toISOString() : created.toISOString();
      value.push({ id: account.id, toolkit: account.toolkit, status, label: await this.label(userId, account), connectedAt });
    }
    this.accountsCache.set(userId, { at: this.now(), value });
    for (const listener of this.accountListeners) {
      try { listener(userId, value); } catch { /* a listener's failure never fails the listing */ }
    }
    return value;
  }

  invalidateAccounts(userId: string): void {
    this.accountsCache.delete(userId);
  }

  /** The real address / handle: Composio's data, else a cached profile read, else alias, else the app name. */
  private async label(userId: string, account: GatewayAccount): Promise<string> {
    if (account.label) return account.label;
    const cached = this.labels.get(account.id);
    if (cached && (cached.value !== null || this.now() - cached.at < MISS_TTL_MS)) return cached.value ?? account.alias ?? (await this.name(account.toolkit));
    let found: string | null = null;
    const tool = PROFILE_TOOLS[account.toolkit];
    if (tool && account.status === "ACTIVE") {
      const result = await this.gateway.executeForAccount(userId, account.id, tool, {}).catch(() => null);
      if (result?.ok) found = emailFrom(result.data);
    }
    this.labels.set(account.id, { at: this.now(), value: found });
    return found ?? account.alias ?? (await this.name(account.toolkit));
  }

  async logo(slug: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const cached = this.logos.get(slug);
    if (this.fresh(cached, cached?.value ? LOGO_TTL_MS : MISS_TTL_MS)) return cached.value;
    const toolkit = await this.toolkit(slug);
    const value = toolkit?.logo ? await this.gateway.fetchLogo(toolkit.logo) : null;
    this.logos.set(slug, { at: this.now(), value });
    return value;
  }

  /** A toolkit by display name or slug ("Google Calendar", "googlecalendar"). */
  async resolveApp(app: string): Promise<GatewayToolkit | null> {
    const wanted = app.trim().toLowerCase();
    const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    let list: GatewayToolkit[] = [];
    try { list = await this.toolkits(); } catch { /* fall through to a direct lookup */ }
    const hit = list.find((t) => t.slug === wanted || displayName(t.slug, t.name).toLowerCase() === wanted)
      ?? list.find((t) => squash(t.slug) === squash(wanted) || squash(displayName(t.slug, t.name)) === squash(wanted));
    if (hit) return hit;
    const slug = squash(wanted);
    return slug && TOOLKIT_SLUG.test(slug) ? this.toolkit(slug).catch(() => null) : null;
  }

  /**
   * A task update's source label (add_update): the display name of an app the user connected or a
   * toolkit in the catalog, matched case-insensitively on display name or slug, else null. Only
   * exact names count (no fuzzy match), and an upstream failure counts as unknown.
   */
  async knownApp(userId: string, name: string): Promise<string | null> {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return null;
    const matches = (slug: string, known?: string | null) => slug.toLowerCase() === wanted || displayName(slug, known).toLowerCase() === wanted;
    try {
      for (const account of await this.accounts(userId)) {
        if (matches(account.toolkit)) return this.name(account.toolkit);
      }
    } catch { /* accounts unavailable: the catalog alone */ }
    try {
      const hit = (await this.toolkits()).find((t) => matches(t.slug, t.name));
      return hit ? displayName(hit.slug, hit.name) : null;
    } catch {
      return null;
    }
  }

  /** A toolkit as the contract's Connector, with the user's accounts of it. */
  async connector(toolkit: GatewayToolkit, accounts: readonly UserAccount[]): Promise<Connector> {
    return {
      toolkit: toolkit.slug,
      name: displayName(toolkit.slug, toolkit.name),
      description: toolkit.description,
      logoUrl: `/api/connectors/${encodeURIComponent(toolkit.slug)}/logo`,
      category: categoryOf(toolkit.slug, toolkit.categories),
      accounts: accounts.filter((a) => a.toolkit === toolkit.slug).map(({ id, label, status, connectedAt }) => ({ id, label, status, connectedAt })),
    };
  }
}
