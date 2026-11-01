// M17: the template catalog with its caches (one per server process). The featured servers are looked
// up by name at most once a day (a failed or partial lookup is retried after 10 minutes, keeping what
// it had); registry pages (the first page, searches, later cursors) are kept 10 minutes, at most 200 of
// them. A failed refresh serves the stale copy; with no copy at all it throws RegistryError. Pages
// that hold nothing we can install are read past (at most 3 more, within 25 s), like Codync's
// past_empty_pages. Whether a no-input template asks for sign-in is learned from installs.
import type { NetDeps } from "../custom-connectors/net.ts";
import { FEATURED, fetchPage, fetchServer, RegistryError, type Template } from "./registry.ts";

const FEATURED_TTL_MS = 24 * 60 * 60_000;
const PAGE_TTL_MS = 10 * 60_000;
const RETRY_MS = 10 * 60_000;
const MAX_PAGES_CACHED = 200;
const EMPTY_PAGE_SKIPS = 3;
const BROWSE_BUDGET_MS = 25_000;

interface Page { templates: Template[]; nextCursor: string | null }
export interface CatalogPage { templates: (Template & { featured: boolean })[]; nextCursor: string | null }

export interface CatalogDeps { net?: NetDeps; now?: () => number }

export class TemplateCatalog {
  private featuredCache: { at: number; templates: Template[]; complete: boolean } | null = null;
  private featuredFailedAt = 0;
  private featuredJob: Promise<Template[]> | null = null;
  private readonly pages = new Map<string, { at: number; page: Page }>();
  private readonly pageJobs = new Map<string, Promise<Page>>();
  private readonly signIn = new Map<string, boolean>();
  private readonly now: () => number;

  constructor(private readonly deps: CatalogDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  private get net(): NetDeps {
    return this.deps.net ?? {};
  }

  /** The featured servers that exist in the registry as remotes, in FEATURED order. */
  async featured(): Promise<Template[]> {
    const cached = this.featuredCache;
    const now = this.now();
    if (cached && now - cached.at < (cached.complete ? FEATURED_TTL_MS : RETRY_MS)) return cached.templates;
    if (cached && now - this.featuredFailedAt < RETRY_MS) return cached.templates;
    this.featuredJob ??= this.loadFeatured().finally(() => { this.featuredJob = null; });
    return this.featuredJob;
  }

  private async loadFeatured(): Promise<Template[]> {
    const results = await Promise.allSettled(FEATURED.map((name) => fetchServer(this.net, name)));
    const old = new Map((this.featuredCache?.templates ?? []).map((t) => [t.name, t]));
    const templates: Template[] = [];
    let failed = 0;
    FEATURED.forEach((name, i) => {
      const result = results[i]!;
      if (result.status === "fulfilled") {
        if (result.value) templates.push(result.value);
      } else {
        failed++;
        // A lookup that failed this time keeps what it had.
        const before = old.get(name);
        if (before) templates.push(before);
      }
    });
    if (failed === FEATURED.length) {
      this.featuredFailedAt = this.now();
      if (this.featuredCache) return this.featuredCache.templates;
      throw new RegistryError("The MCP Registry couldn't be reached.");
    }
    this.featuredCache = { at: this.now(), templates, complete: failed === 0 };
    return templates;
  }

  /** One registry page, cached; a failure serves the stale copy if there is one. */
  private async page(search: string, cursor: string): Promise<Page> {
    const key = JSON.stringify([search.toLowerCase(), cursor]);
    const hit = this.pages.get(key);
    if (hit && this.now() - hit.at < PAGE_TTL_MS) return hit.page;
    const running = this.pageJobs.get(key);
    if (running) return running;
    const job = fetchPage(this.net, search, cursor)
      .then((page) => {
        this.pages.delete(key);
        this.pages.set(key, { at: this.now(), page });
        while (this.pages.size > MAX_PAGES_CACHED) this.pages.delete(this.pages.keys().next().value!);
        return page;
      })
      .catch((error: unknown) => {
        if (hit) return hit.page;
        throw error;
      })
      .finally(() => { this.pageJobs.delete(key); });
    this.pageJobs.set(key, job);
    return job;
  }

  /** A page minus what `drop` filters out, reading past empty pages (bounded in count and time). */
  private async pageSkippingEmpty(search: string, cursor: string, drop: (t: Template) => boolean): Promise<Page> {
    const deadline = this.now() + BROWSE_BUDGET_MS;
    let page = await this.page(search, cursor);
    let templates = page.templates.filter((t) => !drop(t));
    let asked = cursor;
    for (let i = 0; i < EMPTY_PAGE_SKIPS && !templates.length && page.nextCursor && page.nextCursor !== asked; i++) {
      if (this.now() > deadline) break;
      asked = page.nextCursor;
      page = await this.page(search, asked);
      templates = page.templates.filter((t) => !drop(t));
    }
    return { templates, nextCursor: page.nextCursor && page.nextCursor !== asked ? page.nextCursor : null };
  }

  /**
   * GET /api/connector-templates: no query and no cursor = the featured servers, then the registry's
   * first page without them; a query searches (featured ones keep their flag); a cursor reads on.
   */
  async list(query: string, cursor: string): Promise<CatalogPage> {
    const search = query.trim();
    const featuredNames = new Set<string>(FEATURED);
    const mark = (t: Template) => ({ ...t, featured: featuredNames.has(t.name) });
    if (search) {
      const page = await this.pageSkippingEmpty(search, cursor, () => false);
      return { templates: page.templates.map(mark), nextCursor: page.nextCursor };
    }
    // The unfiltered list: featured servers lead its first page and are left out of every page.
    const drop = (t: Template) => featuredNames.has(t.name);
    if (cursor) {
      const page = await this.pageSkippingEmpty("", cursor, drop);
      return { templates: page.templates.map(mark), nextCursor: page.nextCursor };
    }
    const [featured, first] = await Promise.allSettled([this.featured(), this.pageSkippingEmpty("", "", drop)]);
    if (featured.status === "rejected" && first.status === "rejected") throw first.reason;
    const lead = featured.status === "fulfilled" ? featured.value : [];
    const rest = first.status === "fulfilled" ? first.value : { templates: [], nextCursor: null };
    return { templates: [...lead.map(mark), ...rest.templates.map(mark)], nextCursor: rest.nextCursor };
  }

  /** A template by its registry name, for installing (cached copies first, else the registry). */
  async find(name: string): Promise<Template | null> {
    const fresh = (at: number, ttl: number) => this.now() - at < ttl;
    if (this.featuredCache && fresh(this.featuredCache.at, FEATURED_TTL_MS)) {
      const hit = this.featuredCache.templates.find((t) => t.name === name);
      if (hit) return hit;
    }
    for (const { at, page } of this.pages.values()) {
      if (!fresh(at, PAGE_TTL_MS)) continue;
      const hit = page.templates.find((t) => t.name === name);
      if (hit) return hit;
    }
    return fetchServer(this.net, name);
  }

  /** Learned from an install without inputs: whether this template asks for sign-in. */
  rememberSignIn(name: string, needsSignIn: boolean): void {
    this.signIn.set(name, needsSignIn);
    while (this.signIn.size > 1000) this.signIn.delete(this.signIn.keys().next().value!);
  }

  signInOf(name: string): boolean | null {
    return this.signIn.get(name) ?? null;
  }
}
