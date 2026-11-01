// Eval-only web: the fetch and DNS lookup the agent runtime's web_search / web_fetch are given. The
// search service (SEARXNG_URL, a .invalid host) answers with canned hits; pages come from
// fixtures/pages.ts; anything else is a 404. Nothing goes to the network. Every call is logged.
import type { Fetch } from "../../src/llm/index.ts";
import type { Lookup } from "../../src/web/fetch.ts";
import { GENERIC_HIT, PAGES, SEARCH_HITS, type FakePage } from "../fixtures/pages.ts";

export const SEARCH_HOST = "search.eval.invalid";
export const SEARXNG_URL = `https://${SEARCH_HOST}`;

export interface WebCall { kind: "search" | "fetch"; target: string }

export const normUrl = (url: string): string => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
};

export class FakeWeb {
  readonly calls: WebCall[] = [];
  readonly pages = new Map<string, FakePage>(PAGES.map((p) => [normUrl(p.url), p]));

  page(url: string): FakePage | undefined {
    return this.pages.get(normUrl(url));
  }

  /** Every host resolves to a documentation address (203.0.113.0/24), so web_fetch's address check passes. */
  readonly lookup: Lookup = async () => [{ address: "203.0.113.10", family: 4 }];

  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === SEARCH_HOST) {
      const query = url.searchParams.get("q") ?? "";
      this.calls.push({ kind: "search", target: query });
      const hits = SEARCH_HITS.find((s) => s.when.test(query))?.hits ?? GENERIC_HIT(query);
      return Response.json({ results: hits.map((h) => ({ title: h.title, url: h.url, content: h.snippet })) });
    }
    this.calls.push({ kind: "fetch", target: url.href });
    if ((init?.method ?? "GET") !== "GET") return new Response("Method not allowed", { status: 405 });
    const page = this.page(url.href);
    if (!page) return new Response("<html><body><h1>404 Not Found</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } });
    // A copy each time: a PDF reader may take (detach) the buffer it's given.
    return new Response(page.body.slice(), { status: 200, headers: { "content-type": page.contentType, "content-length": String(page.body.byteLength) } });
  };
}
