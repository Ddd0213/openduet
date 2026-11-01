import { z } from "zod";
import { searchOffered, searchProviders, type BuiltinConfig } from "../builtins/config.ts";
import { runBuiltin } from "../builtins/state.ts";
import { abortable, HttpStatusError, readBody, WebError, withDeadline, type HttpDeps } from "./http.ts";
import { mcpSearch } from "./mcp.ts";

export type SearchConfig = BuiltinConfig;
export interface SearchHit { title: string; url: string; snippet: string }
export type WebSearchResult = { results: SearchHit[]; isError?: false } | { isError: true; error: string };
const Query = z.string().trim().min(1).max(1000);
const Link = z.url({ protocol: /^https?$/ });
const Text = z.string();
const tavily = z.object({ results: z.array(z.object({ title: Text, url: Link, content: Text.optional().default("") })) });
const brave = z.object({ web: z.object({ results: z.array(z.object({ title: Text, url: Link, description: Text.optional().default("") })) }).optional() });
const serper = z.object({ organic: z.array(z.object({ title: Text, link: Link, snippet: Text.optional().default("") })).optional().default([]) });
const searxng = z.object({ results: z.array(z.object({ title: Text, url: Link, content: Text.optional().default("") })) });

export async function webSearch(query: string, config: SearchConfig, deps: HttpDeps = {}): Promise<WebSearchResult> {
  const input = Query.safeParse(query);
  if (!input.success) return { isError: true, error: "Invalid search query" };
  if (!searchOffered(config)) return { isError: true, error: "Web search isn't set up yet" };
  return runBuiltin("web_search", config, async () => {
    const providers = searchProviders(config);
    for (const [index, provider] of providers.entries()) {
      try {
        return await withDeadline(deps.signal, async signal => {
          if (provider === "exa" || provider === "parallel") {
            return { results: capHits(await mcpSearch(provider, input.data, deps, signal)) };
          }
          const headers: Record<string, string> = { accept: "application/json" };
          let url: URL, method = "GET", body: string | undefined;
          if (provider !== "searxng" && !config.SEARCH_API_KEY) throw new WebError("Web search isn't set up yet");
          switch (provider) {
            case "tavily":
              url = new URL("https://api.tavily.com/search"); method = "POST";
              headers.authorization = `Bearer ${config.SEARCH_API_KEY}`;
              body = JSON.stringify({ query: input.data, max_results: 5 }); break;
            case "brave":
              url = new URL("https://api.search.brave.com/res/v1/web/search");
              url.searchParams.set("q", input.data); url.searchParams.set("count", "5");
              headers["x-subscription-token"] = config.SEARCH_API_KEY!; break;
            case "serper":
              url = new URL("https://google.serper.dev/search"); method = "POST";
              headers["x-api-key"] = config.SEARCH_API_KEY!;
              body = JSON.stringify({ q: input.data, num: 5 }); break;
            case "searxng":
              if (!config.SEARXNG_URL) throw new WebError("Web search isn't set up yet");
              url = new URL(`${config.SEARXNG_URL.replace(/\/$/, "")}/search`);
              if (!/^https?:$/.test(url.protocol)) throw new WebError("Invalid search service URL");
              url.searchParams.set("q", input.data); url.searchParams.set("format", "json"); break;
            default: throw new WebError("Web search isn't set up yet");
          }
          if (body) headers["content-type"] = "application/json";
          const response = await abortable((deps.fetch ?? fetch)(url, { method, headers, body, signal, redirect: "error" }), signal);
          if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new HttpStatusError(response.status); }
          const data: unknown = JSON.parse(new TextDecoder().decode(await readBody(response, signal)));
          let results: SearchHit[];
          switch (provider) {
            case "tavily": results = tavily.parse(data).results.map(r => ({ title: r.title, url: r.url, snippet: r.content })); break;
            case "brave": results = (brave.parse(data).web?.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.description })); break;
            case "serper": results = serper.parse(data).organic.map(r => ({ title: r.title, url: r.link, snippet: r.snippet })); break;
            case "searxng": results = searxng.parse(data).results.map(r => ({ title: r.title, url: r.url, snippet: r.content })); break;
          }
          return { results: capHits(results) };
        });
      } catch (error) {
        // A fresh deadline for the fallback, never after caller cancellation; no keyed fallback.
        if (deps.signal?.aborted || index === providers.length - 1) throw error;
      }
    }
    throw new WebError("Web search isn't set up yet");
  });
}

function capHits(results: SearchHit[]): SearchHit[] {
  return results.slice(0, 5).map(r => ({ title: r.title.slice(0, 500), url: r.url, snippet: r.snippet.slice(0, 4000) }));
}
