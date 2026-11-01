import { describe, expect, test } from "bun:test";
import { webSearch, type SearchConfig } from "../../src/web/search.ts";

const hits = Array.from({ length: 7 }, (_, i) => ({ title: `Title ${i}`, url: `https://public.example/${i}`, content: `Snippet ${i}`, description: `Snippet ${i}`, link: `https://public.example/${i}`, snippet: `Snippet ${i}` }));
describe("search providers", () => {
  for (const provider of ["tavily", "brave", "serper", "searxng"] as const) {
    test(`${provider} validates and normalizes injected responses, at most five results`, async () => {
      let calls = 0;
      const config: SearchConfig = { SEARCH_PROVIDER: provider, SEARCH_API_KEY: "test-secret", SEARXNG_URL: "https://search.example" };
      const result = await webSearch("中文 评审", config, { fetch: async (input, init) => {
        calls++; const url = new URL(String(input)), headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("error");
        switch (provider) {
          case "tavily": expect(url.href).toBe("https://api.tavily.com/search"); expect(headers.get("authorization")).toBe("Bearer test-secret"); expect(JSON.parse(String(init?.body))).toEqual({ query: "中文 评审", max_results: 5 }); return Response.json({ results: hits });
          case "brave": expect(url.hostname).toBe("api.search.brave.com"); expect(url.searchParams.get("q")).toBe("中文 评审"); expect(headers.get("x-subscription-token")).toBe("test-secret"); return Response.json({ web: { results: hits } });
          case "serper": expect(url.href).toBe("https://google.serper.dev/search"); expect(headers.get("x-api-key")).toBe("test-secret"); expect(JSON.parse(String(init?.body))).toEqual({ q: "中文 评审", num: 5 }); return Response.json({ organic: hits });
          case "searxng": expect(url.origin + url.pathname).toBe("https://search.example/search"); expect(url.searchParams.get("q")).toBe("中文 评审"); expect(url.searchParams.get("format")).toBe("json"); return Response.json({ results: hits });
        }
      } });
      expect(calls).toBe(1); expect(result).toEqual({ results: hits.slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.content })) });
    });
    test(`${provider} rejects malformed external data and hides service secrets`, async () => {
      const config: SearchConfig = { SEARCH_PROVIDER: provider, SEARCH_API_KEY: "test-secret", SEARXNG_URL: "https://search.example" };
      for (const response of [Response.json({ results: [{ title: 123, url: "file:///etc/passwd" }], organic: "invalid", web: 1 }), new Response("test-secret", { status: 401 })]) {
        const result = await webSearch("query", config, { fetch: async () => response });
        expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("test-secret");
      }
    });
  }
  test("default turned off and invalid queries never call the network", async () => {
    const never = async () => { throw new Error("must not fetch"); };
    expect(await webSearch("query", { BUILTIN_CONNECTORS_OFF: ["web_search"] }, { fetch: never })).toEqual({ isError: true, error: "Web search isn't set up yet" });
    expect(await webSearch("", { SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: "unused" }, { fetch: never })).toEqual({ isError: true, error: "Invalid search query" });
  });
});
