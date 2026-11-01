// M12 security review fixes:
// 1. A new provider address only gets the key the request sends: PATCH baseUrl without `key` is 400
//    (the stored key, e.g. one the import copied from the server's models.json, never goes there).
// 4. Retry-After is capped at 60 s (a gateway can't park a turn and its channel for hours).
// 5. Verify sends the headers the way chat does: an extra header overrides a default in any case,
//    once; auth always wins.
// 6. Header values are tab + printable ASCII (else 400 field headers, not "couldn't reach").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { retryDelay, RETRY_AFTER_MAX_MS } from "../../src/llm/stream.ts";
import { authHeaders } from "../../src/models/presets.ts";
import { call, startModelsApp, type ModelsApp } from "./harness.ts";

let t: ModelsApp;
beforeAll(async () => {
  t = await startModelsApp();
});
afterAll(() => t.fixture.cleanup());

describe("a provider's address and its key", () => {
  test("PATCH baseUrl without key is 400 field key, nothing sent; with the key it's verified at the new address", async () => {
    const created = await call(t, t.alex, "POST", "/api/providers", { kind: "custom", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "sk-stored-key-11112222" });
    expect(created.status).toBe(200);
    const id = created.body.provider.id as string;
    const before = t.net.calls.length;

    const moved = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { baseUrl: "https://attacker.example/v1" });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatchObject({ code: "validation_failed", field: "key" });
    expect(t.net.calls.length).toBe(before);
    expect(t.net.calls.some((c) => c.url.includes("attacker.example"))).toBe(false);
    const row = await t.fixture.db.modelProvider.findUniqueOrThrow({ where: { id } });
    expect(row.baseUrl).toBe("https://llm.example.com/v1");

    const withKey = await call(t, t.alex, "PATCH", `/api/providers/${id}`, { baseUrl: "https://llm2.example.com/v1", key: "sk-typed-for-the-new-one-3333" });
    expect(withKey.status).toBe(200);
    const sent = t.net.calls.at(-1)!;
    expect(sent.url).toBe("https://llm2.example.com/v1/models");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-typed-for-the-new-one-3333");

    // The same address again (or a rename) doesn't need the key.
    expect((await call(t, t.alex, "PATCH", `/api/providers/${id}`, { name: "Gateway two" })).status).toBe(200);
    expect((await call(t, t.alex, "PATCH", `/api/providers/${id}`, { baseUrl: "https://llm2.example.com/v1" })).status).toBe(200);
  });

  test("a PATCH writes only its own fields", async () => {
    const created = await call(t, t.alex, "POST", "/api/providers", { kind: "custom", protocol: "openai", baseUrl: "https://own.example.com/v1", key: "sk-own-fields-4444", headers: [{ name: "X-Team", value: "shop" }] });
    const id = created.body.provider.id as string;
    // Someone else changed the headers in between (as a concurrent PATCH would).
    await t.fixture.db.modelProvider.update({ where: { id }, data: { headers: JSON.stringify([{ name: "X-Team", value: "ops" }]) } });
    expect((await call(t, t.alex, "PATCH", `/api/providers/${id}`, { name: "Renamed" })).status).toBe(200);
    const row = await t.fixture.db.modelProvider.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe("Renamed");
    expect(JSON.parse(row.headers)).toEqual([{ name: "X-Team", value: "ops" }]);
  });

  test("header values: plain ASCII only", async () => {
    const bad = await call(t, t.alex, "POST", "/api/providers", { kind: "custom", protocol: "openai", baseUrl: "https://ascii.example.com/v1", key: "sk-ascii-5555", headers: [{ name: "X-Team", value: "Équipe ✓" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "validation_failed", field: "headers" });
    const ok = await call(t, t.alex, "POST", "/api/providers", { kind: "custom", protocol: "openai", baseUrl: "https://ascii.example.com/v1", key: "sk-ascii-5555", headers: [{ name: "X-Team", value: "shop\tfront" }] });
    expect(ok.status).toBe(200);
  });
});

describe("verify headers match chat", () => {
  test("an extra header overrides a default once, in any case; auth always wins", () => {
    const h = authHeaders("anthropic", null, "k-1", [{ name: "Anthropic-Version", value: "2024-10-22" }, { name: "X-Team", value: "shop" }]);
    expect(h["anthropic-version"]).toBe("2024-10-22");
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "anthropic-version")).toHaveLength(1);
    expect(h["x-api-key"]).toBe("k-1");
    expect(h.authorization).toBeUndefined();
    expect(h["x-team"]).toBe("shop");
    expect(h.accept).toBe("application/json");
    expect(authHeaders("anthropic", "bearer", "k-2")).toMatchObject({ authorization: "Bearer k-2", "anthropic-version": "2023-06-01" });
    expect(authHeaders("openai", null, "k-3", [{ name: "Accept", value: "application/x-ndjson" }])).toMatchObject({ authorization: "Bearer k-3", accept: "application/x-ndjson" });
  });
});

describe("Retry-After", () => {
  test("capped at 60 s, seconds or a date; without it the backoff", () => {
    const now = () => 1_000_000;
    const h = (v: string) => new Headers({ "retry-after": v });
    expect(retryDelay(h("2"), 0, now, () => 0.5)).toBe(2000);
    expect(retryDelay(h("86400"), 0, now, () => 0.5)).toBe(RETRY_AFTER_MAX_MS);
    expect(retryDelay(h(new Date(1_000_000 + 3_600_000).toUTCString()), 0, now, () => 0.5)).toBe(RETRY_AFTER_MAX_MS);
    expect(retryDelay(undefined, 1, now, () => 0.5)).toBe(1000);
  });
});
