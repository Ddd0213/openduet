// M17 POST /api/custom-connectors/import: a pasted Claude / Cursor / VS Code config. Remote entries
// become connectors (credential-looking header values in the vault, plain ones kept; a server that
// asks for OAuth waits for sign-in), stdio entries are skipped with reason "stdio", plus http / bad
// URLs, ${...} placeholders, failed checks and URLs added already; bad JSON or no servers is 400.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ImportConnectorsResponse } from "../../src/contract/m17.ts";
import { configEntries, looksSecret } from "../../src/custom-connectors/import.ts";
import { errorOf } from "../helpers/http.ts";
import { FakeMcp, json, startChannels, type ChannelApp } from "../channels/harness.ts";
import { FakeOAuth } from "./oauth-fakes.ts";

let m: ChannelApp;
const docs = new FakeMcp();
const oauth = new FakeOAuth("mcp.tracker.example.com", "auth.tracker.example.com");
const TOKEN = "Bearer import-secret-token-0123456789";

beforeAll(async () => {
  m = await startChannels();
  docs.tools = [{ name: "search", annotations: { readOnlyHint: true } }];
  docs.required = { authorization: TOKEN, "x-team": "core" };
  m.net.route("docs.example.com", docs.handler);
  oauth.install(m.net);
});
afterAll(() => m.cleanup());

const paste = (body: unknown) => m.fixture.app.request("/api/custom-connectors/import", json(m.alex, "POST", { json: typeof body === "string" ? body : JSON.stringify(body) }));

const config = {
  mcpServers: {
    local: { command: "npx", args: ["-y", "some-mcp"], env: { API_KEY: "local-secret" } },
    docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: TOKEN, "X-Team": "core" } },
    tracker: { url: `https://${oauth.mcpHost}/mcp` },
    plain: { url: "http://docs.example.com/mcp" },
    templated: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${input:token}" } },
    wrong: { url: "https://docs.example.com/other", headers: { Authorization: "Bearer wrong-wrong-wrong-0000" } },
  },
};

describe("import", () => {
  test("remote entries are added (secrets to the vault, OAuth ones wait for sign-in); stdio and broken ones are skipped with reasons", async () => {
    const res = await paste(config);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("import-secret-token");
    expect(text).not.toContain("wrong-wrong-wrong");
    expect(text).not.toContain("local-secret");
    const body = ImportConnectorsResponse.parse(JSON.parse(text));
    expect(body.connectors.map((c) => [c.name, c.status, c.oauth?.needsSignIn ?? null])).toEqual([["docs", "active", null], ["tracker", "failed", true]]);
    expect(body.connectors[0]!.headers).toEqual([
      { name: "Authorization", secret: true, value: null, secretInfo: { set: true, last4: "6789" } },
      { name: "X-Team", secret: false, value: "core", secretInfo: null },
    ]);
    expect(body.skipped.map((s) => [s.name, s.reason])).toEqual([["local", "stdio"], ["plain", "invalid"], ["templated", "invalid"], ["wrong", "failed"]]);
    expect(body.skipped.find((s) => s.name === "plain")!.message).toContain("Only https");
    expect(body.skipped.find((s) => s.name === "templated")!.message).toContain("placeholders");
    expect(body.skipped.find((s) => s.name === "wrong")!.message).toContain("refused the credentials");
    expect(await m.fixture.db.vaultSecret.count({ where: { ownerId: body.connectors[0]!.id, name: "header:Authorization" } })).toBe(1);
    // Nothing was run for the stdio entry, and nothing went anywhere but https.
    expect(m.net.requests.every((r) => r.url.startsWith("https://"))).toBe(true);
  });

  test("pasting again skips what's there; other config shapes; bad JSON or no servers is 400", async () => {
    const again = ImportConnectorsResponse.parse(await (await paste(config)).json());
    expect(again.connectors).toEqual([]);
    expect(again.skipped.filter((s) => s.reason === "exists").map((s) => s.name)).toEqual(["docs", "tracker"]);
    expect(configEntries({ servers: { a: { type: "http", url: "https://a.example.com" } } }).map(([n]) => n)).toEqual(["a"]);
    expect(configEntries({ mcp: { servers: { b: { url: "https://b.example.com" } } } }).map(([n]) => n)).toEqual(["b"]);
    expect(configEntries({ name: "Solo", url: "https://c.example.com" }).map(([n]) => n)).toEqual(["Solo"]);
    expect(configEntries({ github: { command: "docker" } }).map(([n]) => n)).toEqual(["github"]);
    const bad = await paste("{nope");
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).field).toBe("json");
    expect((await paste({ something: 1 })).status).toBe(400);
  });

  test("which header values count as secrets", () => {
    expect(looksSecret("Authorization", "x")).toBe(true);
    expect(looksSecret("X-Api-Key", "abc")).toBe(true);
    expect(looksSecret("X-Thing", "Bearer abc")).toBe(true);
    expect(looksSecret("X-Thing", "a1b2c3d4e5f6g7h8i9j0k1")).toBe(true);
    expect(looksSecret("X-Team", "core")).toBe(false);
    expect(looksSecret("X-Region", "eu-west-1")).toBe(false);
  });
});
