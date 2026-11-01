// M17 GET /api/connector-templates + POST /api/connector-templates/install through the app: the
// list (featured first, installed flags, inputs, needsSignIn learned), a one-click install (empty
// inputs) of a server that asks for OAuth (saved waiting for sign-in, no tools, failed + "Sign in to
// ..."), a template with a required secret header (400 naming the missing field; with it: verified,
// the header in the vault), URL variables, unknown inputs, installing twice, unknown names, and a
// registry that's down with nothing cached (502).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CustomConnectorResponse } from "../../src/contract/m11.ts";
import { ConnectorTemplateList, InstallTemplateResponse } from "../../src/contract/m17.ts";
import { errorOf } from "../helpers/http.ts";
import { FakeMcp, get, json, startChannels, type ChannelApp } from "../channels/harness.ts";
import { FakeOAuth, FakeRegistry, registryEntry } from "../custom-connectors/oauth-fakes.ts";

let m: ChannelApp;
const registry = new FakeRegistry();
const oauth = new FakeOAuth("mcp.linear-like.example.com", "auth.linear-like.example.com");
const plain = new FakeMcp();
const GH_TOKEN = "ghp_TEMPLATESECRET0123456789abcdef";

beforeAll(async () => {
  m = await startChannels();
  registry.install(m.net);
  oauth.install(m.net);
  plain.tools = [{ name: "search_code", description: "Search code", annotations: { readOnlyHint: true } }];
  plain.required = { authorization: `Bearer ${GH_TOKEN}` };
  m.net.route("mcp.gh-like.example.com", plain.handler);
  const regional = new FakeMcp();
  regional.tools = [{ name: "ping", annotations: { readOnlyHint: true } }];
  m.net.route("eu.regional.example.com", regional.handler);
  registry.servers.set("app.linear/linear", registryEntry({ name: "app.linear/linear", title: "Linear", description: "Issues and projects", remotes: [{ type: "streamable-http", url: `https://${oauth.mcpHost}/mcp` }] }));
  registry.servers.set("io.github.github/github-mcp-server", registryEntry({
    name: "io.github.github/github-mcp-server", title: "GitHub",
    remotes: [{ type: "streamable-http", url: "https://mcp.gh-like.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer {token}", description: "A personal access token", isRequired: true, isSecret: true }] }],
  }));
  registry.pages = [[registryEntry({ name: "io.acme/regional", title: "Regional", remotes: [{ type: "streamable-http", url: "https://{region}.regional.example.com/mcp", variables: { region: { description: "Region", isRequired: true } } }] })]];
});
afterAll(() => m.cleanup());

const install = (body: Record<string, unknown>, user = m.alex) => m.fixture.app.request("/api/connector-templates/install", json(user, "POST", body));
const list = async (query = "") => ConnectorTemplateList.parse(await (await get(m, m.alex, `/api/connector-templates${query}`)).json());

describe("templates", () => {
  test("the list: featured first with inputs, then the registry's page; nothing installed yet", async () => {
    const page = await list();
    expect(page.templates.map((t) => [t.name, t.featured, t.installed])).toEqual([
      ["io.github.github/github-mcp-server", true, false],
      ["app.linear/linear", true, false],
      ["io.acme/regional", false, false],
    ]);
    const gh = page.templates[0]!;
    expect(gh.inputs).toEqual([{ name: "Authorization", description: "A personal access token", secret: true, required: true, kind: "header" }]);
    expect(gh.needsSignIn).toBeNull();
    expect(page.templates[2]!.inputs).toEqual([{ name: "region", description: "Region", secret: false, required: true, kind: "urlVariable" }]);
  });

  test("one click: a template with no inputs installs with empty inputs; a server answering 401 is saved waiting for sign-in", async () => {
    const res = await install({ name: "app.linear/linear" });
    expect(res.status).toBe(200);
    const body = InstallTemplateResponse.parse(await res.json());
    expect(body.needsSignIn).toBe(true);
    expect(body.connector).toMatchObject({
      kind: "mcp", name: "Linear", url: `https://${oauth.mcpHost}/mcp`, registryName: "app.linear/linear", status: "failed",
      error: "Sign in to Linear to finish connecting it.", tools: [], oauth: { signedIn: false, needsSignIn: true, expiresAt: null },
    });
    const grant = await m.fixture.db.oAuthGrant.findUniqueOrThrow({ where: { connectorId: body.connector.id } });
    expect(grant.status).toBe("needs_sign_in");
    // Old apps still decode `status` (active | failed only).
    expect(["active", "failed"]).toContain(body.connector.status);
    // The list knows it's installed, and that it asks for sign-in.
    const page = await list();
    expect(page.templates.find((t) => t.name === "app.linear/linear")).toMatchObject({ installed: true, needsSignIn: true });
    // Installing it again returns the same connector (no new row).
    const again = InstallTemplateResponse.parse(await (await install({ name: "app.linear/linear", inputs: {} })).json());
    expect(again.connector.id).toBe(body.connector.id);
    expect(await m.fixture.db.customConnector.count({ where: { registryName: "app.linear/linear" } })).toBe(1);
    // ... but not with new values.
    expect((await install({ name: "app.linear/linear", inputs: { x: "y" } })).status).toBe(409);
  });

  test("a required input missing is 400 naming it; with it the server is verified and the secret header goes to the vault", async () => {
    const missing = await install({ name: "io.github.github/github-mcp-server" });
    expect(missing.status).toBe(400);
    const error = await errorOf(missing);
    expect(error.field).toBe("inputs.Authorization");
    expect(error.message).toContain("missing: Authorization");
    const unknown = await install({ name: "io.github.github/github-mcp-server", inputs: { Authorization: GH_TOKEN, Extra: "1" } });
    expect((await errorOf(unknown)).field).toBe("inputs.Extra");
    const wrong = await install({ name: "io.github.github/github-mcp-server", inputs: { Authorization: "nope-wrong-token" } });
    expect(wrong.status).toBe(400);
    // A 401 with the user's own credentials is "refused", never "sign in".
    expect((await errorOf(wrong)).message).toContain("refused the credentials");
    expect(await m.fixture.db.customConnector.count({ where: { registryName: "io.github.github/github-mcp-server" } })).toBe(0);

    const res = await install({ name: "io.github.github/github-mcp-server", inputs: { Authorization: GH_TOKEN } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GH_TOKEN);
    const body = InstallTemplateResponse.parse(JSON.parse(text));
    expect(body.needsSignIn).toBe(false);
    expect(body.connector).toMatchObject({ status: "active", oauth: null, registryName: "io.github.github/github-mcp-server", headers: [{ name: "Authorization", secret: true, value: null, secretInfo: { set: true, last4: "cdef" } }], tools: [{ name: "search_code", access: "read" }] });
    expect(plain.seen.at(-1)!.headers.authorization).toBe(`Bearer ${GH_TOKEN}`);
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: body.connector.id } });
    expect(row.headers).not.toContain(GH_TOKEN);
  });

  test("URL variables: one URL-safe segment each", async () => {
    const bad = await install({ name: "io.acme/regional", inputs: { region: "evil.example.com/x" } });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).field).toBe("inputs.region");
    const res = await install({ name: "io.acme/regional", inputs: { region: "eu" } });
    expect(res.status).toBe(200);
    expect(InstallTemplateResponse.parse(await res.json()).connector).toMatchObject({ url: "https://eu.regional.example.com/mcp", status: "active", oauth: null });
  });

  test("unknown template 404; another user sees nothing installed", async () => {
    expect((await install({ name: "io.nobody/nothing" })).status).toBe(404);
    expect((await install({ name: "not a name" })).status).toBe(404);
    const sams = ConnectorTemplateList.parse(await (await get(m, m.sam, "/api/connector-templates")).json());
    expect(sams.templates.every((t) => !t.installed)).toBe(true);
  });

  test("the registry down with nothing cached: 502 with plain words; a cached list still answers", async () => {
    registry.down = true;
    try {
      const res = await get(m, m.alex, "/api/connector-templates?query=never-searched");
      expect(res.status).toBe(502);
      expect((await errorOf(res)).message).toContain("MCP Registry couldn't be reached");
      expect((await get(m, m.alex, "/api/connector-templates")).status).toBe(200);
    } finally {
      registry.down = false;
    }
  });

  test("a stored connector answer never carries a token (the one waiting for sign-in included)", async () => {
    const all = await (await get(m, m.alex, "/api/custom-connectors")).text();
    expect(all).not.toContain(GH_TOKEN);
    for (const c of (JSON.parse(all) as { connectors: unknown[] }).connectors) CustomConnectorResponse.parse({ connector: c });
  });
});
