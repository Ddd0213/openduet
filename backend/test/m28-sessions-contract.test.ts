// M28 contract (security review M4): the session constants and helpers, the X-Device-Name rule, the
// shapes, the sign-in token the hash is taken of, and the additive migration (docs/API.md "M28 sessions").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { createUser } from "../src/auth/users.ts";
import { SignInResponse } from "../src/contract/auth.ts";
import {
  bearerToken, DEVICE_NAME_HEADER, DeviceName, effectiveExpiresAt, hashedTokenPlaceholder, RevokeOtherSessionsResponse,
  SESSION_ENDED_CLOSE_CODE, SESSION_MAX_AGE_MS, SESSION_STREAM_CHECK_MS, SESSION_TOUCH_INTERVAL_MS, SessionInfo,
  sessionExpiresAt, SessionList, sessionTokenHash,
} from "../src/contract/m28.ts";
import { createTestApp } from "./helpers/app.ts";

const PASSWORD = "test-only correct horse battery staple";
const DAY = 24 * 60 * 60 * 1000;
const migrationSql = readFileSync(join(import.meta.dir, "../prisma/migrations/20270209090000_m28_sessions/migration.sql"), "utf8");

const info = (overrides: Record<string, unknown> = {}) => ({
  id: "Qm7xT2vLp9RkW4sZc8YbN3dHf6JgA1eU", current: true, createdAt: "2026-11-02T09:14:00.000Z",
  lastUsedAt: null, expiresAt: "2027-01-31T09:14:00.000Z", deviceName: null, userAgent: null,
  signInIp: null, lastIp: null, push: false, ...overrides,
});

describe("M28 sessions contract", () => {
  test("constants", () => {
    expect(SESSION_MAX_AGE_MS).toBe(90 * DAY);
    expect(SESSION_TOUCH_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(SESSION_STREAM_CHECK_MS).toBe(60 * 1000);
    expect(SESSION_ENDED_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(SESSION_ENDED_CLOSE_CODE).toBeLessThanOrEqual(4999);
    expect(DEVICE_NAME_HEADER).toBe("X-Device-Name");
  });

  test("tokenHash is sha256 of the token's bytes as 64 lowercase hex", () => {
    expect(sessionTokenHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sessionTokenHash("Qm7xT2vLp9RkW4sZc8YbN3dHf6JgA1eU")).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionTokenHash("a")).not.toBe(sessionTokenHash("A"));
  });

  test("bearerToken keeps the old header rule and can never carry the placeholder", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer   abc123")).toBe("abc123");
    for (const bad of [null, undefined, "", "Bearer", "Bearer ", "Basic abc", "Bearer a b", "abc123"]) {
      expect(bearerToken(bad)).toBeNull();
    }
    const placeholder = hashedTokenPlaceholder("Qm7xT2vLp9RkW4sZc8YbN3dHf6JgA1eU");
    expect(placeholder).toBe("hashed Qm7xT2vLp9RkW4sZc8YbN3dHf6JgA1eU");
    expect(bearerToken(`Bearer ${placeholder}`)).toBeNull();
    // the pre-M28 middleware's own check (auth/middleware.ts) refuses it too
    expect(/^Bearer\s+\S+$/i.test(`Bearer ${placeholder}`)).toBe(false);
    expect(hashedTokenPlaceholder("a")).not.toBe(hashedTokenPlaceholder("b"));
  });

  test("expiry: createdAt + 90 days, and a stored later expiry is capped", () => {
    const createdAt = new Date("2026-10-26T14:20:00.000Z");
    expect(sessionExpiresAt(createdAt).toISOString()).toBe("2027-01-24T14:20:00.000Z");
    const rolling = new Date(createdAt.getTime() + 365 * DAY);
    expect(effectiveExpiresAt({ createdAt, expiresAt: rolling }).toISOString()).toBe("2027-01-24T14:20:00.000Z");
    const sooner = new Date(createdAt.getTime() + 7 * DAY);
    expect(effectiveExpiresAt({ createdAt, expiresAt: sooner })).toEqual(sooner);
  });
});

describe("M28 X-Device-Name", () => {
  test("trimmed printable ASCII, 1-64 characters; anything else is ignored by the server", () => {
    expect(DeviceName.parse("  iPhone 15 Pro ")).toBe("iPhone 15 Pro");
    expect(DeviceName.parse("x".repeat(64))).toBe("x".repeat(64));
    for (const bad of ["", "   ", "x".repeat(65), "iPhone\n15", "iPhone\t15", "Alex’s iPhone", "林晓的 iPhone", "iPhone\u0000"]) {
      expect(DeviceName.safeParse(bad).success).toBe(false);
    }
    expect(DeviceName.safeParse(undefined).success).toBe(false);
  });
});

describe("M28 shapes", () => {
  test("SessionInfo carries no credential and every field is required (null, not missing)", () => {
    const keys = Object.keys(SessionInfo.shape).sort();
    expect(keys).toEqual(["createdAt", "current", "deviceName", "expiresAt", "id", "lastIp", "lastUsedAt", "push", "signInIp", "userAgent"]);
    expect(keys.some((k) => /token|hash/i.test(k))).toBe(false);
    expect(SessionInfo.safeParse(info()).success).toBe(true);
    const { lastUsedAt: _, ...missing } = info();
    expect(SessionInfo.safeParse(missing).success).toBe(false);
    expect(SessionInfo.safeParse(info({ expiresAt: "soon" })).success).toBe(false);
    // zod strips unknown keys: a token put in by mistake never reaches the wire through parse()
    expect(SessionInfo.parse(info({ token: "x", tokenHash: "y" }))).not.toHaveProperty("token");
  });

  test("SessionList and RevokeOtherSessionsResponse", () => {
    expect(SessionList.parse({ sessions: [info(), info({ id: "b", current: false })] }).sessions).toHaveLength(2);
    expect(SessionList.safeParse({}).success).toBe(false);
    expect(RevokeOtherSessionsResponse.parse({ revoked: 0 })).toEqual({ revoked: 0 });
    for (const bad of [{ revoked: -1 }, { revoked: 1.5 }, {}]) expect(RevokeOtherSessionsResponse.safeParse(bad).success).toBe(false);
  });
});

describe("M28 migration", () => {
  test("additive only: nullable ADD COLUMNs and new indexes", () => {
    const statements = migrationSql.replace(/--.*$/gm, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
    expect(statements).toHaveLength(7);
    for (const s of statements) {
      expect(/^ALTER TABLE "\w+" ADD COLUMN "\w+" (TEXT|DATETIME)$/.test(s) || /^CREATE (UNIQUE )?INDEX "\w+" ON "\w+"\("\w+"\)$/.test(s)).toBe(true);
    }
    expect(/\b(DROP|RENAME|UPDATE|DELETE|INSERT|NOT NULL|DEFAULT)\b/i.test(migrationSql.replace(/--.*$/gm, ""))).toBe(false);
  });
});

describe("M28 database", () => {
  let fixture: Awaited<ReturnType<typeof createTestApp>>;
  let userId: string;
  beforeAll(async () => {
    fixture = await createTestApp();
    userId = (await createUser(fixture.db, fixture.auth, { username: "alex", name: "Alex Kim", password: PASSWORD, random: () => 0 })).id;
  });
  afterAll(async () => fixture.cleanup());

  test("Better Auth's sign-in token (what tokenHash hashes) is 32 letters and digits", async () => {
    const response = await fixture.app.request("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alex", password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const { token } = SignInResponse.parse(await response.json());
    expect(/^[A-Za-z0-9]{32}$/.test(token)).toBe(true);
  });

  test("the new columns exist; tokenHash is unique but allows any number of nulls", async () => {
    const expiresAt = new Date(Date.now() + DAY);
    const a = await fixture.db.session.create({ data: { id: "s_a", token: "raw_a", userId, expiresAt } });
    const b = await fixture.db.session.create({ data: { id: "s_b", token: "raw_b", userId, expiresAt } });
    expect([a.tokenHash, b.tokenHash, a.lastUsedAt, a.lastIp, a.deviceName]).toEqual([null, null, null, null, null]);
    const hash = sessionTokenHash("raw_a");
    await fixture.db.session.update({ where: { id: "s_a" }, data: { tokenHash: hash, token: hashedTokenPlaceholder("s_a"), deviceName: "iPhone" } });
    expect((await fixture.db.session.findUnique({ where: { tokenHash: hash } }))?.id).toBe("s_a");
    let code: string | undefined;
    try {
      await fixture.db.session.update({ where: { id: "s_b" }, data: { tokenHash: hash } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) code = error.code;
    }
    expect(code).toBe("P2002");
    const device = await fixture.db.deviceToken.create({ data: { provider: "apns", token: "ab".repeat(32), userId, environment: "sandbox", sessionId: "s_a" } });
    expect(await fixture.db.deviceToken.count({ where: { sessionId: "s_a" } })).toBe(1);
    // a plain column: no foreign key, so deleting the session leaves the row to the server's own cleanup
    await fixture.db.session.delete({ where: { id: "s_a" } });
    expect((await fixture.db.deviceToken.findUnique({ where: { id: device.id } }))?.sessionId).toBe("s_a");
  });
});
