// M12 providers (contract §1, §9): create with each preset (fake fetch), custom with 404 on the list
// = active, 401 = 400 "the key was refused" with nothing saved, PATCH re-verifies, POST /test,
// credential headers refused, names unique, and the key never in a response or a log line.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ModelProviderResponse } from "../../src/contract/m12.ts";
import { captureOutput } from "../channels/harness.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { call, startModelsApp, type ModelsApp } from "./harness.ts";

const KEY = "sk-provider-key-abcdef123456";
let t: ModelsApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startModelsApp({ overrides: { LLM_ALLOW_INSECURE_HOSTS: "gw.local" } });
  sam = await signUp(t.fixture, "sam");
});
afterAll(() => t.fixture.cleanup());

const create = (body: Record<string, unknown>, user = t.alex) => call(t, user, "POST", "/api/providers", body);

describe("POST /api/providers", () => {
  test("each preset: its URL, list request and auth headers; name, key { set, last4 }, active", async () => {
    const cases = [
      { kind: "openai", url: "https://api.openai.com/v1/models", name: "OpenAI", auth: (h: Headers) => h.get("authorization") === `Bearer ${KEY}`, protocol: "openai" },
      { kind: "anthropic", url: "https://api.anthropic.com/v1/models?limit=1000", name: "Anthropic", auth: (h: Headers) => h.get("x-api-key") === KEY && h.get("anthropic-version") === "2023-06-01" && !h.get("authorization"), protocol: "anthropic" },
      { kind: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/models", name: "Google Gemini", auth: (h: Headers) => h.get("authorization") === `Bearer ${KEY}`, protocol: "openai" },
      { kind: "stepfun", url: "https://api.stepfun.com/v1/models", name: "StepFun", auth: (h: Headers) => h.get("authorization") === `Bearer ${KEY}`, protocol: "openai" },
    ];
    for (const c of cases) {
      const before = t.net.calls.length;
      // A preset's protocol in the request is ignored.
      const r = await create({ kind: c.kind, key: KEY, protocol: c.protocol === "openai" ? "anthropic" : "openai" });
      expect(r.status).toBe(200);
      const { provider } = ModelProviderResponse.parse(r.body);
      expect(provider).toMatchObject({ kind: c.kind, protocol: c.protocol, name: c.name, status: "active", error: null, imported: false, modelCount: 0, key: { set: true, last4: "3456" } });
      const sent = t.net.calls.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(c.url);
      expect(c.auth(sent[0]!.headers)).toBe(true);
      expect(r.text).not.toContain(KEY);
    }
    // A second OpenAI gets " 2".
    const again = await create({ kind: "openai", key: KEY });
    expect(again.body.provider.name).toBe("OpenAI 2");
  });

  test("gemini strips a leading models/ from the list", async () => {
    t.net.lists.set("generativelanguage.googleapis.com", { data: [{ id: "models/gemini-2.5-pro" }, { id: "gemini-2.5-flash" }] });
    const r = await create({ kind: "gemini", key: KEY }, sam);
    const remote = await call(t, sam, "GET", `/api/providers/${r.body.provider.id}/remote-models`);
    expect(remote.body.models.map((m: { modelId: string }) => m.modelId)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    t.net.lists.delete("generativelanguage.googleapis.com");
  });

  test("custom: protocol and baseUrl required; name = host; anthropic auth bearer; 404 on the list = active (no list)", async () => {
    expect((await create({ kind: "custom", key: KEY, baseUrl: "https://gw.example.test/v1" })).body.error.field).toBe("protocol");
    expect((await create({ kind: "custom", key: KEY, protocol: "openai" })).body.error.field).toBe("baseUrl");
    t.net.listStatus.set("gw.example.test", 404);
    const r = await create({ kind: "custom", protocol: "anthropic", auth: "bearer", key: KEY, baseUrl: "https://gw.example.test/v1/" });
    expect(r.status).toBe(200);
    expect(r.body.provider).toMatchObject({ kind: "custom", protocol: "anthropic", auth: "bearer", baseUrl: "https://gw.example.test", name: "gw.example.test", status: "active", error: null });
    const sent = t.net.listCalls().at(-1)!;
    expect(sent.url).toBe("https://gw.example.test/v1/models?limit=1000");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent.headers.get("x-api-key")).toBeNull();
    const remote = await call(t, t.alex, "GET", `/api/providers/${r.body.provider.id}/remote-models`);
    expect(remote).toMatchObject({ status: 200, body: { models: [] } });
    // 405 / 501 count the same; a preset answering 404 is a failure.
    t.net.listStatus.set("gw.example.test", 501);
    expect((await create({ kind: "custom", protocol: "openai", key: KEY, baseUrl: "https://gw.example.test/v1", name: "Second" })).status).toBe(200);
    t.net.listStatus.set("api.stepfun.com", 404);
    const preset = await create({ kind: "stepfun", key: KEY });
    expect(preset).toMatchObject({ status: 400, body: { error: { code: "validation_failed", field: "baseUrl", message: "baseUrl: api.stepfun.com answered 404" } } });
    t.net.listStatus.delete("api.stepfun.com");
    t.net.listStatus.delete("gw.example.test");
  });

  test('401 / 403 = 400 field key "the key was refused", nothing saved; other failures name the host', async () => {
    const before = await t.fixture.db.modelProvider.count();
    const secrets = await t.fixture.db.vaultSecret.count();
    for (const status of [401, 403]) {
      t.net.listStatus.set("api.openai.com", status);
      const r = await create({ kind: "openai", key: KEY, name: "Refused" });
      expect(r).toMatchObject({ status: 400, body: { error: { code: "validation_failed", field: "key", message: "key: the key was refused" } } });
      expect(r.text).not.toContain("nope");
    }
    t.net.listStatus.set("api.openai.com", 500);
    expect((await create({ kind: "openai", key: KEY })).body.error).toMatchObject({ field: "baseUrl", message: "baseUrl: api.openai.com answered 500" });
    t.net.listStatus.delete("api.openai.com");
    expect(await t.fixture.db.modelProvider.count()).toBe(before);
    expect(await t.fixture.db.vaultSecret.count()).toBe(secrets);
  });

  test("an unreachable host: couldn't reach <host>; URL rules; credential headers refused", async () => {
    t.net.down.add("down.example.test");
    const r = await create({ kind: "custom", protocol: "openai", key: KEY, baseUrl: "https://down.example.test/v1" });
    expect(r).toMatchObject({ status: 400, body: { error: { field: "baseUrl", message: "baseUrl: couldn't reach down.example.test" } } });
    t.net.down.delete("down.example.test");
    expect((await create({ kind: "custom", protocol: "openai", key: KEY, baseUrl: "http://public.example.test/v1" })).body.error.field).toBe("baseUrl");
    expect((await create({ kind: "custom", protocol: "openai", key: KEY, baseUrl: "https://user:pw@gw.example.test/v1" })).body.error.field).toBe("baseUrl");
    expect((await create({ kind: "custom", protocol: "openai", key: KEY, baseUrl: "http://gw.local:8080/v1", name: "Local" })).status).toBe(200);
    for (const name of ["Authorization", "X-Api-Key", "Cookie", "X-Auth-Token", "Client-Secret", "Host"]) {
      const bad = await create({ kind: "openai", key: KEY, headers: [{ name, value: "v" }] });
      expect(bad.body.error?.field).toBe("headers");
    }
    expect((await create({ kind: "openai", key: KEY, headers: [{ name: "X-Org", value: "a" }, { name: "x-org", value: "b" }] })).body.error.field).toBe("headers");
    expect((await create({ kind: "openai", key: KEY, auth: "bearer" })).body.error.field).toBe("auth");
    const ok = await create({ kind: "openai", key: KEY, name: "With header", headers: [{ name: "OpenAI-Organization", value: "org-1" }] });
    expect(ok.body.provider.headers).toEqual([{ name: "OpenAI-Organization", value: "org-1" }]);
    expect(t.net.listCalls().at(-1)!.headers.get("openai-organization")).toBe("org-1");
  });
});

describe("PATCH / test / delete", () => {
  test("PATCH: a new key or URL is verified again (failure = 400, nothing saved); a rename isn't", async () => {
    const created = await create({ kind: "openai", key: KEY, name: "Patch me" });
    const id = created.body.provider.id as string;
    const calls = t.net.listCalls().length;
    const renamed = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { name: "OpenAI" });
    expect(renamed.body.provider.name).toMatch(/^OpenAI \d+$/);
    expect(t.net.listCalls().length).toBe(calls);
    t.net.listStatus.set("api.openai.com", 401);
    const refused = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { key: "sk-another-key-zzzz9999" });
    expect(refused).toMatchObject({ status: 400, body: { error: { field: "key" } } });
    expect(await t.vault.get(t.alex.userId, "provider", id, "key")).toBe(KEY);
    t.net.listStatus.delete("api.openai.com");
    const rekeyed = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { key: "sk-another-key-zzzz9999" });
    expect(rekeyed.body.provider.key).toEqual({ set: true, last4: "9999" });
    expect(t.net.listCalls().at(-1)!.headers.get("authorization")).toBe("Bearer sk-another-key-zzzz9999");
    expect(rekeyed.text).not.toContain("sk-another-key-zzzz9999");
    // Headers / URL changes are checked with the stored key.
    await call(t, t.alex, "PATCH", `/api/providers/${id}`, { headers: [{ name: "X-Team", value: "a" }] });
    expect(t.net.listCalls().at(-1)!.headers.get("authorization")).toBe("Bearer sk-another-key-zzzz9999");
    expect((await call(t, t.alex, "PATCH", `/api/providers/${id}`, { headers: [{ name: "Api-Key", value: "x" }] })).body.error.field).toBe("headers");
  });

  test("POST /test stores failed + the reason (200), then active again", async () => {
    const id = (await create({ kind: "openai", key: KEY, name: "Tested" })).body.provider.id as string;
    t.net.listStatus.set("api.openai.com", 403);
    const failed = await call(t, t.alex, "POST", `/api/providers/${id}/test`);
    expect(failed).toMatchObject({ status: 200, body: { provider: { status: "failed", error: "the key was refused" } } });
    t.net.listStatus.delete("api.openai.com");
    expect((await call(t, t.alex, "POST", `/api/providers/${id}/test`)).body.provider).toMatchObject({ status: "active", error: null });
    // remote-models with a refused key is 400 with the reason.
    t.net.listStatus.set("api.openai.com", 401);
    expect((await call(t, t.alex, "GET", `/api/providers/${id}/remote-models`)).body.error).toMatchObject({ code: "validation_failed", field: "key" });
    t.net.listStatus.delete("api.openai.com");
  });

  test("someone else's provider is 404 everywhere; DELETE removes the vault rows", async () => {
    const id = (await create({ kind: "openai", key: KEY, name: "Mine" })).body.provider.id as string;
    for (const [method, path, body] of [
      ["PATCH", `/api/providers/${id}`, { name: "x" }], ["DELETE", `/api/providers/${id}`, undefined],
      ["POST", `/api/providers/${id}/test`, undefined], ["GET", `/api/providers/${id}/remote-models`, undefined],
    ] as const) {
      expect((await call(t, sam, method, path, body)).status).toBe(404);
    }
    expect(await t.fixture.db.vaultSecret.count({ where: { ownerKind: "provider", ownerId: id } })).toBe(1);
    expect((await call(t, t.alex, "DELETE", `/api/providers/${id}`)).status).toBe(204);
    expect(await t.fixture.db.vaultSecret.count({ where: { ownerKind: "provider", ownerId: id } })).toBe(0);
    expect((await call(t, t.alex, "DELETE", `/api/providers/${id}`)).status).toBe(404);
  });

  test("the typed key never reaches a response body or a log line", async () => {
    const secret = "sk-only-in-the-vault-77778888";
    const out = captureOutput();
    try {
      t.net.listStatus.set("api.openai.com", 401);
      await create({ kind: "openai", key: secret });
      t.net.listStatus.delete("api.openai.com");
      const ok = await create({ kind: "openai", key: secret, name: "Secret one" });
      const state = await call(t, t.alex, "GET", "/api/models");
      await call(t, t.alex, "POST", `/api/providers/${ok.body.provider.id}/test`);
      expect(ok.text + state.text).not.toContain(secret);
      expect(state.text).toContain("8888");
    } finally {
      out.stop();
    }
    expect(out.text()).not.toContain(secret);
    const row = await t.fixture.db.modelProvider.findFirstOrThrow({ where: { name: "Secret one" } });
    expect(JSON.stringify(row)).not.toContain(secret);
  });
});
