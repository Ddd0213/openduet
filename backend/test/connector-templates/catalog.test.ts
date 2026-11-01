// M17 connector templates: the MCP Registry parsed into templates (hosted remotes only, URL guard,
// inputs from headers and URL variables), the featured list first in its order, registry pages
// after it without the featured ones, search, cursors past empty pages, and the caches (featured a
// day, pages 10 minutes, stale copies when the registry is down, a clear error with nothing cached).
import { describe, expect, test } from "bun:test";
import { TemplateCatalog } from "../../src/connector-templates/catalog.ts";
import { FEATURED, inputsOf, parseServer, titleFromName } from "../../src/connector-templates/registry.ts";
import { FakeNet } from "../channels/harness.ts";
import { FakeRegistry, registryEntry } from "../custom-connectors/oauth-fakes.ts";

const remote = (url: string, extra: Record<string, unknown> = {}) => ({ type: "streamable-http", url, ...extra });

function world() {
  const net = new FakeNet();
  const registry = new FakeRegistry();
  registry.install(net);
  let now = 1_000_000;
  const catalog = new TemplateCatalog({ net, now: () => now });
  registry.servers.set("app.linear/linear", registryEntry({ name: "app.linear/linear", title: "Linear", description: "Issues", remotes: [remote("https://mcp.linear.app/mcp")] }));
  registry.servers.set("com.notion/mcp", registryEntry({ name: "com.notion/mcp", description: "Docs", remotes: [{ type: "sse", url: "https://mcp.notion.com/sse" }, remote("https://mcp.notion.com/mcp")], icons: [{ src: "http://insecure.example.com/x.png" }, { src: "https://www.notion.so/icon.png" }], websiteUrl: "https://notion.so" }));
  registry.servers.set("io.github.github/github-mcp-server", registryEntry({ name: "io.github.github/github-mcp-server", remotes: [remote("https://api.githubcopilot.com/mcp/", { headers: [{ name: "Authorization", value: "Bearer {token}", description: "A GitHub token", isRequired: true, isSecret: true }] })] }));
  // A local package only: not a template.
  registry.servers.set("com.figma.mcp/mcp", registryEntry({ name: "com.figma.mcp/mcp", packages: [{ registryType: "npm", identifier: "figma-mcp", transport: { type: "stdio" } }] }));
  registry.servers.set("com.stripe/mcp", registryEntry({ name: "com.stripe/mcp", remotes: [remote("https://{region}.stripe.example.com/mcp", { variables: { region: { description: "Region", default: "us" } } })] }));
  registry.pages = [
    [
      registryEntry({ name: "app.linear/linear", remotes: [remote("https://mcp.linear.app/mcp")] }),
      registryEntry({ name: "io.acme/tickets", description: "Tickets", remotes: [remote("https://mcp.acme.example.com/mcp")] }),
      registryEntry({ name: "io.acme/local-only", packages: [{ registryType: "npm", identifier: "x" }] }),
    ],
    [registryEntry({ name: "io.acme/local-two", packages: [{ registryType: "pypi", identifier: "y" }] })],
    [registryEntry({ name: "io.acme/wiki", remotes: [remote("https://wiki.acme.example.com/mcp")] })],
  ];
  return { net, registry, catalog, tick: (ms: number) => { now += ms; } };
}

describe("registry parsing", () => {
  test("hosted remotes only; streamable-http first; inputs from headers and URL variables; guarded URLs", () => {
    const notion = parseServer(registryEntry({ name: "com.notion/mcp", remotes: [{ type: "sse", url: "https://mcp.notion.com/sse" }, remote("https://mcp.notion.com/mcp")], icons: [{ src: "https://notion.so/i.png" }] }))!;
    expect(notion).toMatchObject({ name: "com.notion/mcp", title: "Notion", remote: { type: "streamable-http", url: "https://mcp.notion.com/mcp" }, iconUrl: "https://notion.so/i.png" });
    const sseOnly = parseServer(registryEntry({ name: "io.x/old", remotes: [{ type: "sse", url: "https://old.example.com/sse" }] }))!;
    expect(sseOnly.remote.type).toBe("sse");
    const gh = parseServer(registryEntry({ name: "io.github.github/github-mcp-server", remotes: [remote("https://api.githubcopilot.com/mcp/", { headers: [{ name: "Authorization", value: "Bearer {token}", isRequired: true }, { name: "X-Fixed", value: "on" }] })] }))!;
    expect(inputsOf(gh)).toEqual([{ name: "Authorization", description: "", secret: true, required: true, kind: "header" }]);
    expect(gh.headers.find((h) => h.name === "X-Fixed")?.fixed).toBe("on");
    const regional = parseServer(registryEntry({ name: "io.x/regional", remotes: [remote("https://{tenant}.example.com/mcp", { variables: { tenant: { description: "Your tenant", isRequired: true } } })] }))!;
    expect(inputsOf(regional)).toEqual([{ name: "tenant", description: "Your tenant", secret: false, required: true, kind: "urlVariable" }]);

    // Not templates: packages only, http, private / local hosts, a secret in the URL, reserved headers, two placeholders, deleted.
    const rejected = [
      registryEntry({ name: "io.x/pkg", packages: [{ registryType: "npm", identifier: "x", transport: { type: "stdio" } }] }),
      registryEntry({ name: "io.x/http", remotes: [remote("http://plain.example.com/mcp")] }),
      registryEntry({ name: "io.x/ip", remotes: [remote("https://10.0.0.5/mcp")] }),
      registryEntry({ name: "io.x/local", remotes: [remote("https://mcp.localhost/mcp")] }),
      registryEntry({ name: "io.x/internal", remotes: [remote("https://mcp.corp/mcp")] }),
      registryEntry({ name: "io.x/secret-url", remotes: [remote("https://x.example.com/{key}/mcp", { variables: { key: { isSecret: true } } })] }),
      registryEntry({ name: "io.x/reserved", remotes: [remote("https://x.example.com/mcp", { headers: [{ name: "Host", value: "{h}" }] })] }),
      registryEntry({ name: "io.x/two", remotes: [remote("https://x.example.com/mcp", { headers: [{ name: "X-Key", value: "{a}:{b}" }] })] }),
      registryEntry({ name: "io.x/gone", remotes: [remote("https://x.example.com/mcp")] }, "deleted"),
      registryEntry({ name: "not a name", remotes: [remote("https://x.example.com/mcp")] }),
    ];
    expect(rejected.map((e) => parseServer(e))).toEqual(rejected.map(() => null));
    expect(titleFromName("io.github.upstash/context7")).toBe("Context7");
    expect(titleFromName("com.vercel/vercel-mcp")).toBe("Vercel");
  });
});

describe("catalog", () => {
  test("featured first in their order (missing / package-only ones skipped), then the first page without them; cursor reads on past empty pages", async () => {
    const { catalog } = world();
    const first = await catalog.list("", "");
    const names = first.templates.map((t) => t.name);
    // FEATURED order: GitHub, Linear, Notion, (Figma: package only), Stripe; the others aren't in this registry.
    expect(names).toEqual(["io.github.github/github-mcp-server", "app.linear/linear", "com.notion/mcp", "com.stripe/mcp", "io.acme/tickets"]);
    expect(names.slice(0, 4).every((n) => (FEATURED as readonly string[]).includes(n))).toBe(true);
    expect(first.templates.map((t) => t.featured)).toEqual([true, true, true, true, false]);
    expect(first.nextCursor).toBe("1");
    const notion = first.templates.find((t) => t.name === "com.notion/mcp")!;
    expect(notion).toMatchObject({ iconUrl: "https://www.notion.so/icon.png", website: "https://notion.so/", remote: { type: "streamable-http" } });
    // Page 1 has nothing we can run: read on to page 2.
    const next = await catalog.list("", "1");
    expect(next.templates.map((t) => t.name)).toEqual(["io.acme/wiki"]);
    expect(next.nextCursor).toBeNull();
  });

  test("search goes to the registry (featured ones keep their flag)", async () => {
    const { catalog, registry } = world();
    const found = await catalog.list("linear", "");
    expect(found.templates.map((t) => [t.name, t.featured])).toEqual([["app.linear/linear", true]]);
    expect(registry.seen.some((u) => new URL(u).searchParams.get("search") === "linear")).toBe(true);
  });

  test("caches: featured kept a day, pages 10 minutes; a down registry serves the stale copy; nothing cached = RegistryError", async () => {
    const { catalog, registry, tick } = world();
    await catalog.list("", "");
    const calls = registry.seen.length;
    await catalog.list("", "");
    expect(registry.seen.length).toBe(calls);
    // 11 minutes: the page is fetched again, the featured lookups aren't.
    tick(11 * 60_000);
    await catalog.list("", "");
    const refetched = registry.seen.slice(calls);
    expect(refetched.length).toBe(1);
    expect(new URL(refetched[0]!).pathname).toBe("/v0/servers");
    // A day later: featured looked up again.
    tick(24 * 60 * 60_000);
    const before = registry.seen.length;
    await catalog.list("", "");
    expect(registry.seen.slice(before).filter((u) => u.includes("/versions/latest")).length).toBe(FEATURED.length);
    // Down: the stale copies answer.
    registry.down = true;
    tick(25 * 60 * 60_000);
    const stale = await catalog.list("", "");
    expect(stale.templates.length).toBe(5);
    // A search never fetched before: no copy, so it's an error.
    await expect(catalog.list("nothing-cached", "")).rejects.toMatchObject({ name: "RegistryError" });
    const fresh = world();
    fresh.registry.down = true;
    await expect(fresh.catalog.list("", "")).rejects.toMatchObject({ name: "RegistryError" });
  });

  test("every registry request goes through the outbound guard (https to the registry host only)", async () => {
    const { catalog, net } = world();
    await catalog.list("", "");
    expect(net.requests.length).toBeGreaterThan(0);
    expect(net.requests.every((r) => r.url.startsWith("https://registry.modelcontextprotocol.io/v0/servers"))).toBe(true);
    expect(net.lookups.every((h) => h === "registry.modelcontextprotocol.io")).toBe(true);
  });
});
