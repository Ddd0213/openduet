// M0 skeleton: config validation, error shape, WAL database, log redaction, i18n parity.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { ApiError } from "../src/contract/index.ts";
import { sqliteUrl, type Db } from "../src/db.ts";
import { REDACTED, redact } from "../src/log.ts";
import en from "../src/i18n/en.json";
import zh from "../src/i18n/zh-Hans.json";
import { createTestDatabase, testEnv } from "./helpers/db.ts";

describe("config", () => {
  test("names every missing required setting", () => {
    try {
      loadConfig({});
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems;
      expect(problems).toContain("PUBLIC_URL is required");
      expect(problems).toContain("DATABASE_URL is required");
      expect(problems).toContain("BETTER_AUTH_SECRET is required");
    }
  });

  test("treats empty values as missing and applies defaults", () => {
    const c = loadConfig(testEnv({ PORT: "", SESSION_TOKEN_LIMIT: "", COMPOSIO_API_KEY: "" }));
    expect(c.PORT).toBe(3000);
    // M9: token limits are off unless set. M14b: the built-in brief and check-ins are on (gated per user).
    expect(c.SESSION_TOKEN_LIMIT).toBe(0);
    expect(c.WEEKLY_TOKEN_LIMIT).toBe(0);
    expect(c.PROACTIVE_BUILTINS).toBe(true);
    expect(c.COMPOSIO_API_KEY).toBeUndefined();
    expect(c.TRUSTED_PROXIES).toEqual([]);
  });

  test("M9: limits and PROACTIVE_BUILTINS are still settable", () => {
    const c = loadConfig(testEnv({ SESSION_TOKEN_LIMIT: "3000000", WEEKLY_TOKEN_LIMIT: "30000000", PROACTIVE_BUILTINS: "1" }));
    expect(c.SESSION_TOKEN_LIMIT).toBe(3_000_000);
    expect(c.WEEKLY_TOKEN_LIMIT).toBe(30_000_000);
    expect(c.PROACTIVE_BUILTINS).toBe(true);
    expect(loadConfig(testEnv({ PROACTIVE_BUILTINS: "true" })).PROACTIVE_BUILTINS).toBe(true);
    expect(loadConfig(testEnv({ PROACTIVE_BUILTINS: "0" })).PROACTIVE_BUILTINS).toBe(false);
    expect(() => loadConfig(testEnv({ PROACTIVE_BUILTINS: "yes" }))).toThrow(/PROACTIVE_BUILTINS/);
  });

  test("checks settings that depend on each other", () => {
    expect(() => loadConfig(testEnv({ BETTER_AUTH_SECRET: "short" }))).toThrow(/BETTER_AUTH_SECRET must be at least 32/);
    expect(() => loadConfig(testEnv({ COMPUTER_URL: "http://computer:4100" }))).toThrow(/COMPUTER_TOKEN is required when COMPUTER_URL/);
    expect(() => loadConfig(testEnv({ SEARCH_PROVIDER: "tavily" }))).toThrow(/SEARCH_API_KEY is required/);
    expect(loadConfig(testEnv({ TRUSTED_PROXIES: "10.0.0.2, 172.18.0.0/16" })).TRUSTED_PROXIES).toEqual(["10.0.0.2", "172.18.0.0/16"]);
  });
});

describe("app", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ db, cleanup } = await createTestDatabase());
  });
  afterAll(async () => cleanup());

  test("database runs in WAL mode with every migration applied", async () => {
    const mode = await db.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode;");
    expect(mode[0]?.journal_mode).toBe("wal");
    const migrations = readdirSync(join(import.meta.dir, "../prisma/migrations")).filter((d) => /^\d+_/.test(d));
    const applied = await db.$queryRawUnsafe<{ n: bigint | number }[]>(
      "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL;",
    );
    expect(Number(applied[0]?.n)).toBe(migrations.length);
  });

  test("one connection: concurrent queries all see synchronous = NORMAL; an explicit connection_limit is kept", async () => {
    expect(sqliteUrl("file:/data/db/duet.db")).toBe("file:/data/db/duet.db?connection_limit=1");
    expect(sqliteUrl("file:./test.db?socket_timeout=10")).toBe("file:./test.db?socket_timeout=10&connection_limit=1");
    expect(sqliteUrl("file:./test.db?connection_limit=4")).toBe("file:./test.db?connection_limit=4");
    // 1 = NORMAL, set in openDatabase. With the default pool some connections answered 2 (FULL).
    const rows = await Promise.all(Array.from({ length: 12 }, () => db.$queryRawUnsafe<Record<string, bigint | number>[]>("PRAGMA synchronous;")));
    expect(new Set(rows.map((row) => Number(Object.values(row[0] ?? {})[0])))).toEqual(new Set([1]));
  });

  test("unknown routes answer with the ApiError shape", async () => {
    const app = createApp({ config: loadConfig(testEnv()), db });
    // Unknown /api/* paths need a session first (401); this checks the 404 shape outside /api.
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = ApiError.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});

describe("log", () => {
  test("redacts secrets by key, deeply", () => {
    const out = redact({
      headers: { Authorization: "Bearer abc", "x-api-key": "k", cookie: "c", accept: "json" },
      body: { password: "p", nested: [{ apiKey: "a", ok: 1 }] },
      BETTER_AUTH_SECRET: "s",
    }) as Record<string, any>;
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers["x-api-key"]).toBe(REDACTED);
    expect(out.headers.cookie).toBe(REDACTED);
    expect(out.headers.accept).toBe("json");
    expect(out.body.password).toBe(REDACTED);
    expect(out.body.nested[0].apiKey).toBe(REDACTED);
    expect(out.body.nested[0].ok).toBe(1);
    expect(out.BETTER_AUTH_SECRET).toBe(REDACTED);
  });
});

describe("i18n", () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  test("en and zh-Hans have the same keys and placeholders", () => {
    for (const section of ["phrases", "agent"] as const) {
      const a = en[section] as Record<string, string>;
      const b = zh[section] as Record<string, string>;
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      for (const k of Object.keys(a)) expect(placeholders(b[k] ?? "")).toEqual(placeholders(a[k] ?? ""));
    }
  });

  test("every phrase key used in the api samples exists", () => {
    const dir = join(import.meta.dir, "../../docs/api-samples");
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/"key":\s*"([a-z_]+\.[a-z_]+)"/g)) used.add(m[1]!);
    }
    expect([...used].filter((k) => !(k in en.phrases))).toEqual([]);
  });
});
