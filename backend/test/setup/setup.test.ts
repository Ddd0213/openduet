// M22 W2 (#47): GET /api/setup and POST /api/setup/check. Rows for configured (not_checked until
// tried, then ready), missing (needs_setup with an env or route fix naming backend/.env.example's
// variables) and failing checks; the model check is one tiny llm.stream() call through the
// resolver; a change to the model's rows shows "not checked" again; 429 rate_limited within 30 s;
// no secret, key prefix or URL credential in the JSON. No network: fake search, apps, computer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SetupInfo } from "../../src/contract/m22.ts";
import { createModelsModule, type ModelsModule } from "../../src/models/index.ts";
import { ModelsDevCatalog } from "../../src/models/catalog.ts";
import type { NotifyConfig } from "../../src/notify/config.ts";
import { CHECK_WINDOW_MS, pushConfigOk, registerSetupRoutes, setupModels, SetupService, PING_MAX_TOKENS, type SetupDeps, type SetupModels } from "../../src/setup/index.ts";
import { Vault } from "../../src/vault/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { failing, FakeNet, Scripts, setUp, VAULT_KEY, type ModelsApp } from "../models/harness.ts";

const SECRETS = {
  search: "tvly-SECRET-search-key-0123456789",
  composio: "ak_SECRET_composio_0123456789",
  computer: "computer-SECRET-token-0123456789abcdef",
  ntfyToken: "tk_SECRET_ntfy_0123456789",
  searxCreds: "admin:SECRETpass",
  model: "sk-test-openai-0123456789abcdef",
};

let fixture: TestApp;
let models: ModelsModule;
let net: FakeNet;
let scripts: Scripts;
let alex: SignedIn;
let clock = Date.parse("2026-10-30T09:00:00.000Z");
/** The service behind the routes; each test sets the one it needs. */
let current: SetupService;

beforeAll(async () => {
  net = new FakeNet();
  scripts = new Scripts();
  fixture = await createTestApp({}, {
    setup: (core) => {
      models = createModelsModule({
        db: core.db, events: core.events, vault: new Vault(core.db, { key: VAULT_KEY }), legacy: null, config: core.config, env: {},
        fetch: net.fetch, catalog: new ModelsDevCatalog({ fetch: net.fetch }), buildLlm: scripts.build,
      });
      const routes = registerSetupRoutes({ info: (userId) => current.info(userId), check: (userId) => current.check(userId) });
      return { routes: [...models.routes, routes] };
    },
  });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const now = () => new Date(clock);
const realModels = (): SetupModels => setupModels({
  db: fixture.db, resolver: models.resolver, ready: (id) => models.service.ready(id), voice: (id) => models.realtime.pick(id),
});
const ntfy: NotifyConfig = { provider: "ntfy", url: "https://ntfy.example.com", topic: "duet-alex", token: SECRETS.ntfyToken };

interface Fakes { searchOk: boolean; probeOk: boolean; allows: boolean; apps: { toolkit: string; status: string }[] | Error; pushOk: boolean }
const fakes: Fakes = { searchOk: true, probeOk: true, allows: true, apps: [], pushOk: true };
const calls = { search: 0, probe: 0, push: 0, apps: 0 };

/** Everything set up (fake search, apps, computer, push) on top of `over`. */
function service(over: Partial<SetupDeps> = {}): SetupService {
  return new SetupService({
    db: fixture.db,
    config: { SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: SECRETS.search, SEARXNG_URL: undefined, COMPOSIO_API_KEY: SECRETS.composio, COMPUTER_URL: "http://computer:4100", COMPUTER_TOKEN: SECRETS.computer },
    notify: ntfy,
    models: realModels(),
    apps: { accounts: async () => { calls.apps++; if (fakes.apps instanceof Error) throw fakes.apps; return fakes.apps; } },
    computer: { allows: async () => fakes.allows, probe: async () => { calls.probe++; return { ok: fakes.probeOk }; } },
    search: async () => { calls.search++; return fakes.searchOk ? { results: [] } : { isError: true, error: "Search returned HTTP 401" }; },
    pushOk: async () => { calls.push++; return fakes.pushOk; },
    now,
    ...over,
  });
}

const request = async (method: "GET" | "POST", user: SignedIn = alex) => {
  const response = await fixture.app.request(method === "GET" ? "/api/setup" : "/api/setup/check", { method, headers: user.headers });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers, body: text ? JSON.parse(text) : null };
};
const rows = (body: unknown) => Object.fromEntries(SetupInfo.parse(body).items.map((item) => [item.id, item]));

const modelsApp = () => ({ fixture }) as unknown as ModelsApp;

describe("configured: not checked until tried, then the check's outcome", () => {
  test("GET: set-up rows are not_checked; apps counts the connected apps; voice needs a model", async () => {
    await setUp(modelsApp(), alex);
    fakes.apps = [{ toolkit: "gmail", status: "active" }, { toolkit: "gmail", status: "active" }, { toolkit: "notion", status: "active" }, { toolkit: "slack", status: "expired" }];
    current = service();
    const response = await request("GET");
    expect(response.status).toBe(200);
    const r = rows(response.body);
    expect(Object.keys(r)).toEqual(["model", "search", "apps", "computer", "push", "voice"]);
    expect(r.model).toEqual({ id: "model", status: "not_checked", required: true, title: { key: "setup.model.title" }, detail: { key: "setup.model.ready", params: { model: { type: "text", value: expect.any(String) } } }, fix: null, checkedAt: null });
    expect(r.search).toMatchObject({ status: "not_checked", required: false, detail: { key: "setup.search.ready", params: { provider: { value: "Tavily" } } }, fix: null, checkedAt: null });
    // Two distinct apps active (the expired one doesn't count); nothing to try, so no checkedAt.
    expect(r.apps).toMatchObject({ status: "ready", detail: { key: "setup.apps.ready", params: { count: { type: "number", value: 2 } } }, fix: null, checkedAt: null });
    expect(r.computer).toMatchObject({ status: "not_checked", detail: { key: "setup.computer.ready" } });
    expect(r.push).toMatchObject({ status: "not_checked", detail: { key: "setup.push.ready", params: { service: { value: "ntfy" } } } });
    expect(r.voice).toEqual({ id: "voice", status: "needs_setup", required: false, title: { key: "setup.voice.title" }, detail: { key: "setup.voice.missing" }, fix: { kind: "route", route: "duet://settings/voice" }, checkedAt: null });
    expect(calls).toMatchObject({ search: 0, probe: 0, push: 0 });
  });

  test("POST /check: one tiny model call (llm.stream, no tools), one search, the computer's health, the push config; all ready", async () => {
    const before = scripts.requests().length;
    scripts.push([{ type: "text_delta", text: "pong" }]);
    const response = await request("POST");
    expect(response.status).toBe(200);
    const r = rows(response.body);
    for (const id of ["model", "search", "computer", "push"] as const) expect(r[id]).toMatchObject({ status: "ready", fix: null, checkedAt: new Date(clock).toISOString() });
    expect(r.apps!.status).toBe("ready");
    const sent = scripts.requests().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.request).toMatchObject({ role: "chat", maxTokens: PING_MAX_TOKENS });
    expect(sent[0]!.request.tools ?? []).toEqual([]);
    expect(calls).toMatchObject({ search: 1, probe: 1, push: 1 });
    // GET keeps the outcome.
    expect(rows((await request("GET")).body).model!.status).toBe("ready");
  });

  test("a second check within 30 s: 429 rate_limited with Retry-After; nothing is tried again", async () => {
    const limited = await request("POST");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: "rate_limited", message: expect.any(String) } });
    expect(limited.headers.get("Retry-After")).toBe(String(CHECK_WINDOW_MS / 1000));
    clock += 10_000;
    expect((await request("POST")).headers.get("Retry-After")).toBe("20");
    expect(calls).toMatchObject({ search: 1, probe: 1, push: 1 });
  });

  test("failing checks: needs_setup with why and the fix (route or backend/.env.example names)", async () => {
    clock += CHECK_WINDOW_MS;
    fakes.searchOk = false; fakes.probeOk = false; fakes.pushOk = false;
    scripts.push(failing(401));
    const r = rows((await request("POST")).body);
    const at = new Date(clock).toISOString();
    expect(r.model).toMatchObject({ status: "needs_setup", detail: { key: "system.model_auth", params: { status: { type: "number", value: 401 } } }, fix: { kind: "route", route: "duet://settings/models" }, checkedAt: at });
    expect(r.search).toMatchObject({ status: "needs_setup", detail: { key: "setup.search.failed", params: { provider: { value: "Tavily" } } }, fix: { kind: "env", names: ["SEARCH_PROVIDER", "SEARCH_API_KEY"], hint: { key: "setup.hint.env" } }, checkedAt: at });
    expect(r.computer).toMatchObject({ status: "needs_setup", detail: { key: "setup.computer.failed" }, fix: { kind: "route", route: "duet://computer" }, checkedAt: at });
    expect(r.push).toMatchObject({ status: "needs_setup", detail: { key: "setup.push.failed", params: { service: { value: "ntfy" } } }, fix: { kind: "env", names: ["NTFY_URL", "NTFY_TOPIC", "NTFY_TOKEN"] }, checkedAt: at });
  });

  test("a change to the model's rows: not checked again; the other rows keep their outcome", async () => {
    clock += CHECK_WINDOW_MS;
    fakes.searchOk = true; fakes.probeOk = true; fakes.pushOk = true;
    scripts.push([{ type: "text_delta", text: "ok" }]);
    expect(rows((await request("POST")).body).model!.status).toBe("ready");
    const user = await fixture.db.user.findUniqueOrThrow({ where: { id: alex.userId } });
    await Bun.sleep(5);
    await fixture.db.modelEntry.update({ where: { id: user.defaultModelId! }, data: { label: "Renamed model" } });
    const r = rows((await request("GET")).body);
    expect(r.model).toMatchObject({ status: "not_checked", detail: { params: { model: { value: "Renamed model" } } }, checkedAt: null });
    expect(r.search!.status).toBe("ready");
  });
});

describe("missing and partly set up", () => {
  test("nothing configured: search uses the key-less default; other rows need setup", async () => {
    const sam = await signUp(fixture, "sam", "Sam Lee");
    current = service({
      config: { SEARCH_PROVIDER: undefined, SEARCH_API_KEY: undefined, SEARXNG_URL: undefined, COMPOSIO_API_KEY: undefined, COMPUTER_URL: undefined, COMPUTER_TOKEN: undefined },
      notify: { provider: null }, apps: null, computer: null,
    });
    const r = rows((await request("GET", sam)).body);
    for (const item of Object.values(r).filter(item => item.id !== "search")) expect(item).toMatchObject({ status: "needs_setup", checkedAt: null });
    expect(r.model).toMatchObject({ required: true, detail: { key: "setup.model.missing" }, fix: { kind: "route", route: "duet://settings/models" } });
    expect(r.search).toMatchObject({ status: "not_checked", detail: { key: "setup.search.keyless", params: { provider: { value: "Exa" }, fallback: { value: "Parallel" } } }, fix: null });
    expect(r.apps!.fix).toEqual({ kind: "env", names: ["COMPOSIO_API_KEY"], hint: { key: "setup.hint.env" } });
    expect(r.computer).toMatchObject({ detail: { key: "setup.computer.missing" }, fix: { kind: "env", names: ["COMPUTER_URL", "COMPUTER_TOKEN"] } });
    expect(r.push).toMatchObject({ detail: { key: "setup.push.missing" }, fix: { kind: "env", names: ["NOTIFY_PROVIDER"], hint: { key: "setup.hint.push" } } });
    expect(r.voice!.fix).toEqual({ kind: "route", route: "duet://settings/voice" });
    // Every env name is one backend/.env.example defines.
    const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    const defined = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
    const names = Object.values(r).flatMap((item) => (item.fix?.kind === "env" ? item.fix.names : []));
    expect(names.filter((n) => !defined.has(n))).toEqual([]);
    const before = { ...calls };
    const checked = rows((await request("POST", sam)).body);
    expect(Object.values(checked).filter(item => item.id !== "search").every((item) => item.status === "needs_setup" && item.checkedAt === null)).toBe(true);
    expect(checked.search!.status).toBe("ready");
    expect(calls).toEqual({ ...before, search: before.search + 1 });
  });

  test("apps: none connected is not_checked with the Apps page; a failed listing needs Composio's key", async () => {
    fakes.apps = [];
    current = service();
    expect(rows((await request("GET")).body).apps).toMatchObject({ status: "not_checked", detail: { key: "setup.apps.none" }, fix: { kind: "route", route: "duet://settings/apps" } });
    fakes.apps = new Error("composio down");
    expect(rows((await request("GET")).body).apps).toMatchObject({ status: "needs_setup", detail: { key: "setup.apps.failed" }, fix: { kind: "env", names: ["COMPOSIO_API_KEY"] } });
    fakes.apps = [];
  });

  test("the computer belongs to another account: needs_setup naming COMPUTER_OWNER, and it isn't probed", async () => {
    fakes.allows = false;
    clock += CHECK_WINDOW_MS;
    current = service();
    const probes = calls.probe;
    scripts.push([{ type: "text_delta", text: "ok" }]);
    expect(rows((await request("POST")).body).computer).toMatchObject({ status: "needs_setup", detail: { key: "setup.computer.not_yours" }, fix: { kind: "env", names: ["COMPUTER_OWNER"] } });
    expect(calls.probe).toBe(probes);
    fakes.allows = true;
  });

  test("search through the model itself; a voice model; APNs counts the phones registered", async () => {
    const fake: SetupModels = {
      chat: async () => ({ label: "Claude Sonnet", fingerprint: "f1", serverWebTools: true }),
      ping: async () => ({ ok: true }),
      voice: async () => ({ label: "Gemini Live" }),
    };
    await fixture.db.deviceToken.createMany({ data: [{ userId: alex.userId, provider: "apns", token: "a".repeat(64) }, { userId: alex.userId, provider: "apns", token: "b".repeat(64) }] });
    const apns: NotifyConfig = { provider: "apns", keyId: "KEY123", teamId: "TEAM123", key: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", topic: "app.duet", env: null };
    current = service({ models: fake, notify: apns, config: { BUILTIN_CONNECTORS_OFF: ["web_search"], SEARCH_PROVIDER: undefined, SEARCH_API_KEY: undefined, SEARXNG_URL: undefined, COMPOSIO_API_KEY: SECRETS.composio, COMPUTER_URL: undefined, COMPUTER_TOKEN: undefined } });
    const r = rows((await request("GET")).body);
    expect(r.search).toMatchObject({ status: "ready", detail: { key: "setup.search.model", params: { model: { value: "Claude Sonnet" } } }, fix: null });
    expect(r.voice).toMatchObject({ status: "ready", detail: { key: "setup.voice.ready", params: { model: { value: "Gemini Live" } } }, fix: null });
    expect(r.push).toMatchObject({ status: "not_checked", detail: { key: "setup.push.devices", params: { service: { value: "APNs" }, count: { type: "number", value: 2 } } } });
  });
});

describe("secrets and the push config check", () => {
  test("no secret value, key prefix or URL credential in GET or POST, failing or not", async () => {
    clock += CHECK_WINDOW_MS;
    fakes.searchOk = false; fakes.probeOk = false; fakes.pushOk = false;
    current = service({ config: { SEARCH_PROVIDER: "searxng", SEARCH_API_KEY: SECRETS.search, SEARXNG_URL: `https://${SECRETS.searxCreds}@search.internal.example/`, COMPOSIO_API_KEY: SECRETS.composio, COMPUTER_URL: `http://${SECRETS.searxCreds}@computer:4100`, COMPUTER_TOKEN: SECRETS.computer } });
    scripts.push(failing(401));
    const texts = [(await request("GET")).text, (await request("POST")).text, (await request("GET")).text];
    for (const text of texts) {
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
      for (const part of ["SECRET", "sk-", "tvly-", "ak_", "search.internal.example", "computer:4100", "ntfy.example.com", "duet-alex"]) expect(text).not.toContain(part);
    }
    expect(rows(JSON.parse(texts[1]!)).search!.fix).toMatchObject({ kind: "env", names: ["SEARCH_PROVIDER", "SEARXNG_URL"] });
    fakes.searchOk = true; fakes.probeOk = true; fakes.pushOk = true;
  });

  test("both routes need a session", async () => {
    expect((await fixture.app.request("/api/setup")).status).toBe(401);
    expect((await fixture.app.request("/api/setup/check", { method: "POST" })).status).toBe(401);
  });

  test("pushConfigOk: APNs signs a token with its .p8 key (sends nothing); ntfy and Bark check their settings", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    expect(await pushConfigOk({ provider: "apns", keyId: "KEY123", teamId: "TEAM123", key: pem, topic: "app.duet", env: null })).toBe(true);
    expect(await pushConfigOk({ provider: "apns", keyId: "KEY123", teamId: "TEAM123", key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", topic: "app.duet", env: null })).toBe(false);
    expect(await pushConfigOk(ntfy)).toBe(true);
    expect(await pushConfigOk({ provider: "bark", url: "https://api.day.app", deviceKey: "dev", encryptionKey: "k".repeat(16), encryptionIv: "i".repeat(16) })).toBe(true);
    expect(await pushConfigOk({ provider: "bark", url: "https://api.day.app", deviceKey: "dev", encryptionKey: "short", encryptionIv: "i".repeat(16) })).toBe(false);
    expect(await pushConfigOk({ provider: null })).toBe(false);
  });
});
