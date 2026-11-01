// M17 remote MCP OAuth end to end, against a fake MCP server + authorization server: a server that
// answers 401 is saved waiting for sign-in (only with allowSignIn); oauth/start discovers (the
// WWW-Authenticate resource_metadata hint, RFC 9728, RFC 8414), registers once per authorization
// server (RFC 7591) and answers an authorize URL with PKCE S256, state, resource and scope;
// oauth/finish trades the code (verifier + resource checked by the fake) and verifies; the state is
// single use, bound to the user and connector, and runs out after 10 minutes; every MCP request
// sends Bearer, refreshes before expiry and once after a 401 (rotated refresh tokens kept); a
// refused refresh signs the connector out; Disconnect / Delete remove the tokens; every metadata
// URL is guarded (private addresses, http, redirects); and no token, code, verifier or client
// secret reaches a response, a log line, a stored row in plain or a model request.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CustomConnectorResponse } from "../../src/contract/m11.ts";
import { OAuthStartResponse } from "../../src/contract/m17.ts";
import { modelToolName } from "../../src/custom-connectors/provider.ts";
import { ConnectorService } from "../../src/custom-connectors/service.ts";
import { errorOf } from "../helpers/http.ts";
import { call, captureOutput, chatIn, dumpDatabase, json, newChannel, resultsIn, startChannels, text, type ChannelApp } from "../channels/harness.ts";
import { FakeOAuth } from "./oauth-fakes.ts";

let m: ChannelApp;
let output: ReturnType<typeof captureOutput>;
const answers: string[] = [];
/** secrets of the other fakes in this file, for the final scan */
const extraSecrets: string[] = [];
const fake = new FakeOAuth();
const MCP_URL = `https://${fake.mcpHost}/mcp`;
let clock = Date.now();
/** The same tables, vault and network, with a clock the tests move. */
let timed: ConnectorService;

beforeAll(async () => {
  m = await startChannels();
  fake.install(m.net);
  output = captureOutput();
  timed = new ConnectorService({ db: m.fixture.db, vault: m.system.vault, access: m.system.access, policy: m.connectors.policy, net: m.net, now: () => new Date(clock) });
});
afterAll(async () => {
  output.stop();
  await m.cleanup();
});

async function request(path: string, method: string, body?: unknown, user = m.alex): Promise<Response> {
  const res = await m.fixture.app.request(path, json(user, method, body));
  answers.push(await res.clone().text());
  return res;
}
const createTracker = (name = "Tracker", allowSignIn = true) => request("/api/custom-connectors", "POST", { kind: "mcp", name, url: MCP_URL, ...(allowSignIn ? { allowSignIn } : {}) });
async function start(id: string, user = m.alex) {
  const res = await request(`/api/custom-connectors/${id}/oauth/start`, "POST", undefined, user);
  return { res, body: res.status === 200 ? OAuthStartResponse.parse(await res.clone().json()) : null };
}
const finish = (id: string, body: Record<string, unknown>, user = m.alex) => request(`/api/custom-connectors/${id}/oauth/finish`, "POST", body, user);
const vaultNames = async (id: string) => (await m.fixture.db.vaultSecret.findMany({ where: { ownerId: id }, select: { name: true }, orderBy: { name: "asc" } })).map((r) => r.name);

let trackerId = "";

describe("sign-in", () => {
  test("a server answering 401 without credentials: 400 for old clients, saved waiting for sign-in with allowSignIn", async () => {
    const old = await createTracker("Tracker", false);
    expect(old.status).toBe(400);
    expect((await errorOf(old)).message).toContain("refused the credentials");
    const res = await createTracker();
    expect(res.status).toBe(200);
    const { connector } = CustomConnectorResponse.parse(await res.json());
    trackerId = connector.id;
    expect(connector).toMatchObject({ status: "failed", error: "Sign in to Tracker to finish connecting it.", tools: [], oauth: { signedIn: false, needsSignIn: true, expiresAt: null }, registryName: null });
    // Waiting for sign-in: a test sends nothing and keeps the reason.
    const sent = m.net.to(fake.mcpHost).length;
    const tested = CustomConnectorResponse.parse(await (await request(`/api/custom-connectors/${trackerId}/test`, "POST")).json());
    expect(tested.connector).toMatchObject({ status: "failed", error: "Sign in to Tracker to finish connecting it." });
    expect(m.net.to(fake.mcpHost).length).toBe(sent);
  });

  test("start: discovery, one registration, an authorize URL with PKCE S256, state, resource and scope", async () => {
    const { res, body } = await start(trackerId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ callbackScheme: "duet", redirectUri: "duet://oauth/callback" });
    const url = new URL(body!.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${fake.asHost}/authorize`);
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client-1");
    expect(q.get("redirect_uri")).toBe("duet://oauth/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("resource")).toBe(MCP_URL);
    expect(q.get("scope")).toBe("read write");
    expect(new Date(body!.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(fake.registrations).toEqual([{ client_name: "OpenDuet", redirect_uris: ["duet://oauth/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" }]);
    // The hint was followed (path-specific metadata of the server).
    expect(m.net.to(fake.mcpHost).some((r) => new URL(r.url).pathname === "/.well-known/oauth-protected-resource/mcp")).toBe(true);
    const client = await m.fixture.db.oAuthClient.findFirstOrThrow({ where: { userId: m.alex.userId } });
    expect(client).toMatchObject({ issuer: `https://${fake.asHost}`, clientId: "client-1", authMethod: "none", redirectUri: "duet://oauth/callback", tokenEndpoint: `https://${fake.asHost}/token` });
  });

  test("finish: the code for tokens (verifier and resource checked), stored in the vault, verified; the state is single use", async () => {
    const { body } = await start(trackerId);
    const { code, state } = fake.approve(body!.authorizeUrl);
    const res = await finish(trackerId, { state, code });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { connector } = CustomConnectorResponse.parse(await res.json());
    expect(connector).toMatchObject({ status: "active", error: null, oauth: { signedIn: true, needsSignIn: false }, tools: [{ name: "list_issues", access: "read" }, { name: "create_issue", access: "write" }] });
    expect(new Date(connector.oauth!.expiresAt!).getTime() - Date.now()).toBeGreaterThan(50 * 60_000);
    const exchange = fake.tokenCalls.at(-1)!.form;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code, redirect_uri: "duet://oauth/callback", client_id: "client-1", resource: MCP_URL });
    expect(createHash("sha256").update(exchange.code_verifier!).digest("base64url")).toBe(new URL(body!.authorizeUrl).searchParams.get("code_challenge")!);
    expect(await vaultNames(trackerId)).toEqual(["oauth:access_token", "oauth:refresh_token"]);
    const grant = await m.fixture.db.oAuthGrant.findUniqueOrThrow({ where: { connectorId: trackerId } });
    expect(grant).toMatchObject({ status: "signed_in", resource: MCP_URL, scope: "read write" });
    // The verify went out with the token.
    expect(fake.mcp.seen.at(-1)!.headers.authorization).toBe(`Bearer ${fake.issuedAccess.at(-1)}`);
    // Used once: again (or an unknown state) is 410 expired.
    const again = await finish(trackerId, { state, code });
    expect(again.status).toBe(410);
    expect(await errorOf(again)).toMatchObject({ code: "expired", field: "state" });
    expect((await finish(trackerId, { state: "made-up", code })).status).toBe(410);
  });

  test("a second connector at the same authorization server reuses the user's client", async () => {
    const res = await createTracker("Tracker two");
    const { connector } = CustomConnectorResponse.parse(await res.json());
    const { body } = await start(connector.id);
    expect(new URL(body!.authorizeUrl).searchParams.get("client_id")).toBe("client-1");
    expect(fake.registrations).toHaveLength(1);
    await request(`/api/custom-connectors/${connector.id}`, "DELETE");
  });
});

describe("tokens on use", () => {
  test("tool calls send Bearer; a 401 refreshes once (rotated refresh token stored) and the call runs again", async () => {
    const channel = await newChannel(m, m.alex, { name: "Issues" });
    const tool = modelToolName(trackerId, "list_issues");
    m.llm.script("chat", [call(tool, {})], [call(tool, {})], [text("Done.")]);
    const before = m.llm.sent("chat").length;
    const firstAccess = fake.issuedAccess.at(-1)!;
    const firstRefresh = fake.issuedRefresh.at(-1)!;
    // The first call works; then the server revokes the token before the second.
    let calls = 0;
    const answer = fake.mcp.answer;
    fake.mcp.answer = (c) => { calls++; if (calls === 1) fake.revokeAccess(); return answer(c); };
    try {
      await chatIn(m, m.alex, channel.id, "list my issues twice");
    } finally {
      fake.mcp.answer = answer;
    }
    const sent = m.llm.sent("chat").slice(before);
    expect(resultsIn(sent[1])[0]).toMatchObject({ connector: "Tracker", tool: "list_issues", status: "ok" });
    expect(resultsIn(sent[2])[0]).toMatchObject({ connector: "Tracker", tool: "list_issues", status: "ok" });
    expect(fake.mcp.calls.at(-2)!.headers.authorization).toBe(`Bearer ${firstAccess}`);
    const refresh = fake.tokenCalls.at(-1)!.form;
    expect(refresh).toMatchObject({ grant_type: "refresh_token", refresh_token: firstRefresh, resource: MCP_URL, client_id: "client-1" });
    const newAccess = fake.issuedAccess.at(-1)!;
    expect(newAccess).not.toBe(firstAccess);
    expect(fake.mcp.calls.at(-1)!.headers.authorization).toBe(`Bearer ${newAccess}`);
    // Rotated: the vault holds the new refresh token (the old one is dead at the server).
    expect(await m.system.vault.get(m.alex.userId, "connector", trackerId, "oauth:refresh_token")).toBe(fake.issuedRefresh.at(-1)!);
    expect(fake.liveRefresh.has(firstRefresh)).toBe(false);
    // Nothing the model saw holds a token.
    expect(JSON.stringify(sent)).not.toMatch(/at-SECRET|rt-SECRET/);
  });

  test("a token about to run out is refreshed before the request (no 401 first)", async () => {
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: trackerId } });
    const refreshes = fake.tokenCalls.length;
    const rejected = fake.rejected;
    clock = Date.now() + 2 * 60 * 60_000;
    try {
      const { result } = await timed.callTool(row, "list_issues", {});
      expect(result.isError).toBe(false);
    } finally {
      clock = Date.now();
    }
    expect(fake.tokenCalls.length).toBe(refreshes + 1);
    expect(fake.tokenCalls.at(-1)!.form.grant_type).toBe("refresh_token");
    expect(fake.rejected).toBe(rejected);
    expect(fake.mcp.calls.at(-1)!.headers.authorization).toBe(`Bearer ${fake.issuedAccess.at(-1)}`);
  });

  test("a refused refresh signs the connector out: tokens deleted, failed with 'Sign in ... again', nothing sent after", async () => {
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: trackerId } });
    fake.refuseRefresh = true;
    fake.revokeAccess();
    try {
      await expect(timed.callTool(row, "list_issues", {})).rejects.toMatchObject({ name: "SignInNeeded", message: "Sign in to Tracker again to use it." });
    } finally {
      fake.refuseRefresh = false;
    }
    expect(await vaultNames(trackerId)).toEqual([]);
    const { connector } = CustomConnectorResponse.parse(await (await request(`/api/custom-connectors/${trackerId}`, "PATCH", { description: "x" })).json());
    expect(connector).toMatchObject({ status: "failed", error: "Sign in to Tracker again to use it.", oauth: { signedIn: false, needsSignIn: true, expiresAt: null } });
    const sent = m.net.to(fake.mcpHost).length;
    await expect(timed.callTool(row, "list_issues", {})).rejects.toMatchObject({ name: "SignInNeeded" });
    expect(m.net.to(fake.mcpHost).length).toBe(sent);
    // Signing in again brings it back.
    const { body } = await start(trackerId);
    const { code, state } = fake.approve(body!.authorizeUrl);
    expect(CustomConnectorResponse.parse(await (await finish(trackerId, { state, code })).json()).connector).toMatchObject({ status: "active", oauth: { signedIn: true } });
    expect(fake.registrations).toHaveLength(1);
  });
});

describe("state", () => {
  test("bound to the user and the connector; runs out after 10 minutes; a cancelled sign-in is 400", async () => {
    const other = CustomConnectorResponse.parse(await (await createTracker("Other")).json()).connector;
    const { body } = await start(trackerId);
    const { code, state } = fake.approve(body!.authorizeUrl);
    // Another user: 404 (not theirs). Another connector of the same user: 410, and the state survives.
    expect((await finish(trackerId, { state, code }, m.sam)).status).toBe(404);
    expect((await finish(other.id, { state, code })).status).toBe(410);
    expect((await finish(trackerId, { state, code })).status).toBe(200);
    // The error the authorization server sends back.
    const cancelled = await start(trackerId);
    const declined = await finish(trackerId, { state: new URL(cancelled.body!.authorizeUrl).searchParams.get("state")!, error: "access_denied" });
    expect(declined.status).toBe(400);
    expect(await errorOf(declined)).toMatchObject({ field: "code", message: "code: Sign-in was cancelled." });
    // 10 minutes (the injected clock).
    const row = await m.fixture.db.customConnector.findUniqueOrThrow({ where: { id: trackerId } });
    const started = await timed.oauthStart(m.alex.userId, row.id);
    const late = fake.approve(started.authorizeUrl);
    clock = Date.now() + 11 * 60_000;
    try {
      await expect(timed.oauthFinish(m.alex.userId, row.id, { state: late.state, code: late.code })).rejects.toMatchObject({ status: 410, code: "expired" });
    } finally {
      clock = Date.now();
    }
    await request(`/api/custom-connectors/${other.id}`, "DELETE");
  });
});

describe("guards", () => {
  test("metadata URLs go through the outbound guard: private hints, private / local / http authorization servers and redirects to private hosts are refused without a request", async () => {
    const evil = new FakeOAuth("mcp.evil.example.com", "auth.evil.example.com");
    evil.install(m.net);
    m.net.dns.set("inside.evil.example.com", ["10.0.0.7"]);
    let inside = 0;
    m.net.route("inside.evil.example.com", () => { inside++; return Response.json({}); });
    const id = CustomConnectorResponse.parse(await (await request("/api/custom-connectors", "POST", { kind: "mcp", name: "Evil", url: `https://${evil.mcpHost}/mcp`, allowSignIn: true })).json()).connector.id;
    const attempt = async () => {
      const { res } = await start(id);
      return { status: res.status, message: res.status === 200 ? "" : (await errorOf(res)).message };
    };
    // A hint to the metadata address: skipped (never requested), the well-known path is used instead.
    evil.hint = "https://169.254.169.254/latest/meta-data";
    evil.authorizationServers = ["https://inside.evil.example.com"];
    expect(await attempt()).toMatchObject({ status: 400, message: expect.stringContaining("private or reserved") });
    evil.authorizationServers = ["https://localhost"];
    expect(await attempt()).toMatchObject({ status: 400, message: expect.stringContaining("public host name") });
    evil.authorizationServers = ["http://auth.evil.example.com"];
    expect(await attempt()).toMatchObject({ status: 400, message: expect.stringContaining("Only https") });
    evil.authorizationServers = [`https://${evil.asHost}`];
    evil.tokenEndpoint = "http://auth.evil.example.com/token";
    expect(await attempt()).toMatchObject({ status: 400, message: expect.stringContaining("Only https") });
    // A redirect from the metadata to a private host: re-checked, refused.
    evil.tokenEndpoint = `https://${evil.asHost}/token`;
    const asHandler = evil.asHandler;
    m.net.route(evil.asHost, (r) => new URL(r.url).pathname.startsWith("/.well-known/") ? new Response(null, { status: 302, headers: { location: "https://inside.evil.example.com/meta" } }) : asHandler(r));
    expect(await attempt()).toMatchObject({ status: 400, message: expect.stringContaining("private or reserved") });
    m.net.route(evil.asHost, asHandler);
    expect(inside).toBe(0);
    expect(m.net.requests.some((r) => r.url.includes("169.254.169.254") || r.url.startsWith("http://"))).toBe(false);
    // No dynamic registration: plain words.
    evil.registration = false;
    expect(await attempt()).toMatchObject({ status: 400, message: expect.stringContaining("doesn't let new apps register") });
    await request(`/api/custom-connectors/${id}`, "DELETE");
  });

  test("a client secret from registration lives in the vault and goes only to the token endpoint", async () => {
    const withSecret = new FakeOAuth("mcp.secretive.example.com", "auth.secretive.example.com");
    withSecret.clientSecret = "cs-SECRET-0123456789abcdef";
    withSecret.install(m.net);
    const id = CustomConnectorResponse.parse(await (await request("/api/custom-connectors", "POST", { kind: "mcp", name: "Secretive", url: `https://${withSecret.mcpHost}/mcp`, allowSignIn: true })).json()).connector.id;
    const { body } = await start(id);
    const { code, state } = withSecret.approve(body!.authorizeUrl);
    expect((await finish(id, { state, code })).status).toBe(200);
    expect(withSecret.tokenCalls.at(-1)!.form.client_secret).toBe(withSecret.clientSecret);
    const client = await m.fixture.db.oAuthClient.findFirstOrThrow({ where: { issuer: `https://${withSecret.asHost}` } });
    expect(client.authMethod).toBe("client_secret_post");
    expect(await m.fixture.db.vaultSecret.count({ where: { ownerKind: "oauth_client", ownerId: client.id, name: "client_secret" } })).toBe(1);
    expect(withSecret.mcp.seen.some((r) => JSON.stringify(r).includes(withSecret.clientSecret!))).toBe(false);
    extraSecrets.push(...withSecret.secrets(), ...withSecret.tokenCalls.flatMap((c) => [c.form.code, c.form.code_verifier].filter((v): v is string => !!v)));
  });
});

describe("disconnect and delete", () => {
  test("Disconnect deletes the tokens and waits for sign-in; Delete removes the grant and its vault rows (the client stays)", async () => {
    const res = await request(`/api/custom-connectors/${trackerId}/oauth`, "DELETE");
    expect(res.status).toBe(200);
    expect(CustomConnectorResponse.parse(await res.json()).connector).toMatchObject({ status: "failed", oauth: { signedIn: false, needsSignIn: true } });
    expect(await vaultNames(trackerId)).toEqual([]);
    expect(await m.fixture.db.oAuthGrant.count({ where: { connectorId: trackerId } })).toBe(1);
    expect((await request(`/api/custom-connectors/${trackerId}`, "DELETE")).status).toBe(204);
    expect(await m.fixture.db.oAuthGrant.count({ where: { connectorId: trackerId } })).toBe(0);
    expect(await m.fixture.db.vaultSecret.count({ where: { ownerId: trackerId } })).toBe(0);
    expect(await m.fixture.db.oAuthClient.count({ where: { userId: m.alex.userId } })).toBeGreaterThan(0);
    // A removed connector: 404.
    expect((await request(`/api/custom-connectors/${trackerId}/oauth`, "DELETE")).status).toBe(404);
  });

  test("no token, code, verifier or client secret in any answer, log line, plain column or model request", async () => {
    const secrets = [...fake.secrets(), ...extraSecrets, ...fake.tokenCalls.flatMap((c) => [c.form.code, c.form.code_verifier].filter((v): v is string => !!v))];
    expect(secrets.length).toBeGreaterThan(6);
    const sinks = { answers: answers.join("\n"), logs: output.text(), prompts: JSON.stringify(m.llm.sent("chat")) };
    const db = await dumpDatabase(m.fixture.db);
    for (const secret of secrets) {
      for (const [sink, body] of Object.entries(sinks)) expect(`${sink}: ${body.includes(secret)}`).toBe(`${sink}: false`);
      expect(db.includes(secret)).toBe(false);
    }
  });
});
