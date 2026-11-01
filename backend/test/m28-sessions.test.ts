import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.ts";
import { registerAccountRoutes } from "../src/account/routes.ts";
import { convertLegacySessions, findSession } from "../src/auth/sessions.ts";
import { setPassword } from "../src/auth/users.ts";
import { SignInResponse } from "../src/contract/auth.ts";
import { SessionList, hashedTokenPlaceholder, SESSION_MAX_AGE_MS, SESSION_TOUCH_INTERVAL_MS, sessionExpiresAt, sessionTokenHash } from "../src/contract/m28.ts";
import { Housekeeping } from "../src/housekeeping/index.ts";
import { log } from "../src/log.ts";
import { ApnsProvider } from "../src/notify/providers/apns.ts";
import { createTestApp, type TestApp } from "./helpers/app.ts";
import { signUp, TEST_PASSWORD, type SignedIn } from "./helpers/session.ts";
import { fakeTransport, testP8 } from "./notify/fakes.ts";

let f: TestApp;
let alex: SignedIn;
beforeEach(async () => {
  f = await createTestApp({}, { setup: () => ({ routes: [registerAccountRoutes()] }) });
  alex = await signUp(f, "alex");
});
afterEach(async () => f.cleanup());

async function login(headers: Record<string, string> = {}) {
  const response = await f.app.request("/api/session", { method: "POST", headers,
    body: JSON.stringify({ username: "alex", password: TEST_PASSWORD }) });
  expect(response.status).toBe(200);
  const signedIn = SignInResponse.parse(await response.json());
  const row = await f.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(signedIn.token) } });
  return { token: signedIn.token, row, headers: { Authorization: `Bearer ${signedIn.token}` } };
}
const current = () => f.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(alex.token) } });
const api = (path: string, method = "GET", headers = alex.headers) => f.app.request(path, { method, headers });
const requestBody = (text: unknown, headers = alex.headers) => ({ method: "POST", headers, body: JSON.stringify(text) });
const rawToken = () => randomBytes(24).toString("hex");
async function legacy(id: string, createdAt = new Date(), expiresAt = new Date(createdAt.getTime() + 365 * 86400_000)) {
  const token = rawToken();
  const row = await f.db.session.create({ data: { id, userId: alex.userId, token, createdAt, expiresAt } });
  return { row, token };
}
function storedBytesContain(tokens: string[]) {
  const path = f.config.DATABASE_URL.slice("file:".length);
  return [path, `${path}-wal`].some(file => existsSync(file) && tokens.some(token => readFileSync(file).includes(Buffer.from(token))));
}
const device = (id: string, sessionId: string | null, userId = alex.userId) => f.db.deviceToken.create({
  data: { id, sessionId, userId, provider: "apns", token: id, environment: "production" },
});

describe("M28 hash-only sessions", () => {
  test("sign-in returns an alphanumeric bearer; only its hash and placeholder reach SQLite or WAL", async () => {
    const signed = await login({ "X-Device-Name": "  iPhone 15 Pro  ", "User-Agent": "phone" });
    expect(/^[a-zA-Z0-9]{32}$/.test(signed.token)).toBe(true);
    expect(signed.row.token === hashedTokenPlaceholder(signed.row.id)).toBe(true);
    expect(signed.row.tokenHash === sessionTokenHash(signed.token)).toBe(true);
    expect(signed.row.expiresAt.getTime() - signed.row.createdAt.getTime()).toBe(SESSION_MAX_AGE_MS);
    expect(signed.row.deviceName).toBe("iPhone 15 Pro");
    expect(signed.row.lastUsedAt).not.toBeNull();
    expect((await api("/api/me", "GET", signed.headers)).status).toBe(200);
    expect((await api("/api/me", "GET", { Authorization: `Bearer ${signed.row.token}` })).status).toBe(401);
    await f.db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(storedBytesContain([signed.token, alex.token])).toBe(false);
    expect((await login({ "X-Device-Name": "x".repeat(65) })).row.deviceName).toBeNull();
  });

  test("Better Auth session creation outside the sign-in slot fails closed", async () => {
    const count = await f.db.session.count();
    await expect(f.auth.api.signInUsername({ body: { username: "alex", password: TEST_PASSWORD } })).rejects.toThrow();
    const context = await f.auth.$context;
    await expect(context.internalAdapter.createSession(alex.userId)).rejects.toThrow();
    expect(await f.db.session.count()).toBe(count);
  });

  test("parallel sign-ins keep their own raw token and row", async () => {
    const answers = await Promise.all([login(), login(), login()]);
    expect(new Set(answers.map(answer => answer.token)).size).toBe(3);
    expect(new Set(answers.map(answer => answer.row.id)).size).toBe(3);
    expect(answers.every(answer => answer.row.tokenHash === sessionTokenHash(answer.token))).toBe(true);
    expect(answers.every(answer => answer.row.token === hashedTokenPlaceholder(answer.row.id))).toBe(true);
  });

  test("a missing hook slot result is an internal error", async () => {
    const user = await f.db.user.findUniqueOrThrow({ where: { id: alex.userId } });
    const auth = { api: { signInUsername: async () => ({ token: "unused", user }) } } as unknown as TestApp["auth"];
    const app = createApp({ ...f, auth });
    const response = await app.request("/api/session", requestBody({ username: "alex", password: TEST_PASSWORD }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "Something went wrong." } });
  });

  test("90-day boundary and stored expiry are enforced without rolling renewal", async () => {
    const row = await current();
    expect(await findSession(f.db, alex.token, sessionExpiresAt(row.createdAt))).toBeNull();
    const earlier = new Date(Date.now() + 60_000);
    await f.db.session.update({ where: { id: row.id }, data: { expiresAt: earlier } });
    expect((await api("/api/me")).status).toBe(200);
    expect((await current()).expiresAt.getTime()).toBe(earlier.getTime());
    await f.db.session.update({ where: { id: row.id }, data: {
      createdAt: new Date(Date.now() - SESSION_MAX_AGE_MS), expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
    } });
    const response = await api("/api/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Sign in again." } });
  });

  test("conversion caps legacy expiry, deletes expired rows, is idempotent and removes raw bytes", async () => {
    const alive = await legacy("legacy-live");
    const expired = await legacy("legacy-expired", new Date(Date.now() - SESSION_MAX_AGE_MS));
    expect((await api("/api/me", "GET", { Authorization: `Bearer ${alive.token}` })).status).toBe(401);
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      expect(await convertLegacySessions(f.db)).toEqual({ converted: 1, expired: 1 });
      expect(info).toHaveBeenCalledWith("legacy sessions converted", { converted: 1, expired: 1 });
      const recordText = JSON.stringify(info.mock.calls);
      expect([alive.token, expired.token].some(token => recordText.includes(token))).toBe(false);
      const row = await f.db.session.findUniqueOrThrow({ where: { id: alive.row.id } });
      expect(row.tokenHash === sessionTokenHash(alive.token)).toBe(true);
      expect(row.token === hashedTokenPlaceholder(row.id)).toBe(true);
      expect(row.expiresAt.getTime()).toBe(sessionExpiresAt(row.createdAt).getTime());
      expect(await f.db.session.findUnique({ where: { id: expired.row.id } })).toBeNull();
      expect(storedBytesContain([alive.token, expired.token])).toBe(false);
      expect(await convertLegacySessions(f.db)).toEqual({ converted: 0, expired: 0 });
      expect((await api("/api/me", "GET", { Authorization: `Bearer ${alive.token}` })).status).toBe(200);
    } finally { info.mockRestore(); }
  });

  test("touch is throttled, resolves IP only on a touch and ignores invalid device names", async () => {
    let ipCalls = 0;
    const app = createApp({ ...f, clientIp: () => { ipCalls++; return "203.0.113.22"; } });
    const req = (name?: string) => app.request("/api/me", { headers: { ...alex.headers, ...(name === undefined ? {} : { "X-Device-Name": name }) } });
    const first = await current();
    expect((await req()).status).toBe(200);
    expect(ipCalls).toBe(0);
    expect((await current()).lastUsedAt?.getTime()).toBe(first.lastUsedAt?.getTime());
    await f.db.session.update({ where: { id: first.id }, data: { lastUsedAt: null } });
    await req();
    expect(ipCalls).toBe(1);
    expect((await current()).lastIp).toBe("203.0.113.22");
    const aged = new Date(Date.now() - SESSION_TOUCH_INTERVAL_MS);
    await f.db.session.update({ where: { id: first.id }, data: { lastUsedAt: aged } });
    await req();
    expect(ipCalls).toBe(2);
    await req("iPad Air");
    expect(ipCalls).toBe(3);
    expect((await current()).deviceName).toBe("iPad Air");
    await req("x".repeat(65));
    await req();
    expect(ipCalls).toBe(3);
    expect((await current()).deviceName).toBe("iPad Air");
    expect((await current()).ipAddress).toBe(first.ipAddress);
  });

  test("failed touches log only the error class and do not fail the request", async () => {
    const row = await current();
    await f.db.session.update({ where: { id: row.id }, data: { lastUsedAt: null } });
    const db = f.db.$extends({ query: { session: { updateMany() { throw new Error("sensitive-detail"); } } } }) as unknown as TestApp["db"];
    const app = createApp({ ...f, db });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect((await app.request("/api/me", { headers: alex.headers })).status).toBe(200);
      expect(warn).toHaveBeenCalledWith("session activity update failed", { error: { name: "Error" } });
      expect(JSON.stringify(warn.mock.calls).includes("sensitive-detail")).toBe(false);
    } finally { warn.mockRestore(); }
  });
});

describe("M28 signed-in devices and revoke", () => {
  test("list is no-store, current first, activity then creation, with one push lookup and no credentials", async () => {
    const a = await login(), b = await login(), c = await login(), expired = await login();
    const now = Date.now();
    await f.db.session.update({ where: { id: a.row.id }, data: { lastUsedAt: null, createdAt: new Date(now - 20_000), userAgent: "" } });
    await f.db.session.update({ where: { id: b.row.id }, data: { lastUsedAt: null, createdAt: new Date(now - 10_000) } });
    await f.db.session.update({ where: { id: c.row.id }, data: { lastUsedAt: new Date(now), createdAt: new Date(now - 30_000) } });
    await f.db.session.update({ where: { id: expired.row.id }, data: { expiresAt: new Date(now) } });
    await signUp(f, "other");
    await device("push-c", c.row.id);
    await device("old-push", null);
    let queries = 0;
    const db = f.db.$extends({ query: { deviceToken: { findMany({ args, query }) { queries++; return query(args); } } } }) as unknown as TestApp["db"];
    const app = createApp({ ...f, db });
    const response = await app.request("/api/sessions", { headers: alex.headers });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const json = await response.json();
    const list = SessionList.parse(json).sessions;
    expect(list.map(row => row.id)).toEqual([(await current()).id, c.row.id, b.row.id, a.row.id]);
    expect(list.filter(row => row.current)).toHaveLength(1);
    expect(list.filter(row => row.push).map(row => row.id)).toEqual([c.row.id]);
    expect(list.at(-1)?.userAgent).toBeNull();
    expect(JSON.stringify(json).includes("token")).toBe(false);
    expect(queries).toBe(1);
  });

  test("delete rejects current, expired, unknown and foreign ids; revokes the owner immediately", async () => {
    const row = await current(), other = await login(), expired = await login();
    await f.db.session.update({ where: { id: expired.row.id }, data: { expiresAt: new Date() } });
    const foreign = await signUp(f, "foreign");
    const foreignRow = await f.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(foreign.token) } });
    const ownError = await api(`/api/sessions/${row.id}`, "DELETE");
    expect(ownError.status).toBe(400);
    expect(await ownError.json()).toEqual({ error: { code: "validation_failed", field: "id", message: "id: this is the session making the request; use sign out" } });
    for (const id of ["unknown", expired.row.id, foreignRow.id]) expect((await api(`/api/sessions/${id}`, "DELETE")).status).toBe(404);
    await device("other-linked", other.row.id);
    await device("current-linked", row.id);
    await device("unlinked", null);
    await device("foreign-unlinked", null, foreign.userId);
    expect((await api(`/api/sessions/${other.row.id}`, "DELETE")).status).toBe(204);
    expect((await api("/api/me", "GET", other.headers)).status).toBe(401);
    expect((await f.db.deviceToken.findMany()).map(row => row.id).sort()).toEqual(["current-linked", "foreign-unlinked"]);
  });

  test("revoke-others deletes expired too but counts live sessions and leaves current usable", async () => {
    const currentRow = await current();
    const live = await login(), expired = await login();
    await f.db.session.update({ where: { id: expired.row.id }, data: { expiresAt: new Date() } });
    await device("live-linked", live.row.id);
    await device("expired-linked", expired.row.id);
    await device("current-linked", currentRow.id);
    await device("unlinked", null);
    expect(await (await api("/api/sessions/revoke-others", "POST")).json()).toEqual({ revoked: 1 });
    expect(await f.db.session.count({ where: { userId: alex.userId } })).toBe(1);
    expect((await api("/api/me")).status).toBe(200);
    expect((await f.db.deviceToken.findMany()).map(row => row.id)).toEqual(["current-linked"]);
    expect(await (await api("/api/sessions/revoke-others", "POST")).json()).toEqual({ revoked: 0 });
  });

  test("sign-out removes linked pushes and keeps unlinked pushes", async () => {
    await device("linked", (await current()).id);
    await device("unlinked", null);
    expect((await api("/api/session", "DELETE")).status).toBe(204);
    expect((await f.db.deviceToken.findMany()).map(row => row.id)).toEqual(["unlinked"]);
    expect((await api("/api/me")).status).toBe(401);
  });

  test("registering a device links and re-links it; foreign registration cannot move it", async () => {
    const input = { provider: "apns", token: "a".repeat(64), environment: "production", locale: "en" };
    const first = await f.app.request("/api/devices", requestBody(input));
    expect(first.status).toBe(200);
    const { deviceId } = await first.json() as { deviceId: string };
    const row = () => f.db.deviceToken.findUniqueOrThrow({ where: { id: deviceId } });
    expect((await row()).sessionId).toBe((await current()).id);
    const other = await login();
    expect((await f.app.request("/api/devices", requestBody(input, other.headers))).status).toBe(200);
    expect((await row()).sessionId).toBe(other.row.id);
    const foreign = await signUp(f, "foreign");
    expect((await f.app.request("/api/devices", requestBody(input, foreign.headers))).status).toBe(404);
    expect((await row()).sessionId).toBe(other.row.id);
  });

  test("setPassword removes every device token for that user only", async () => {
    const foreign = await signUp(f, "foreign");
    await device("linked", (await current()).id);
    await device("unlinked", null);
    await device("foreign", null, foreign.userId);
    await setPassword(f.db, f.auth, "alex", "new-test-only horse battery staple");
    expect(await f.db.session.count({ where: { userId: alex.userId } })).toBe(0);
    expect((await f.db.deviceToken.findMany()).map(row => row.id)).toEqual(["foreign"]);
  });

  test("housekeeping converts, expires sessions and linked tokens, and deletes orphaned tokens", async () => {
    const expired = await login();
    await f.db.session.update({ where: { id: expired.row.id }, data: { expiresAt: new Date() } });
    const aliveLegacy = await legacy("legacy-live");
    const expiredLegacy = await legacy("legacy-expired", new Date(Date.now() - SESSION_MAX_AGE_MS));
    await device("expired-linked", expired.row.id);
    await device("legacy-expired-linked", expiredLegacy.row.id);
    await device("orphan", "gone");
    await device("live-linked", (await current()).id);
    await device("legacy-live-linked", aliveLegacy.row.id);
    await device("unlinked", null);
    const result = await new Housekeeping({ db: f.db, files: f.files }).tick();
    expect(result).toMatchObject({ convertedSessions: 1, legacyExpiredSessions: 1, expiredSessions: 1,
      expiredDeviceTokens: 1, orphanDeviceTokens: 2 });
    expect((await f.db.deviceToken.findMany()).map(row => row.id).sort()).toEqual(["legacy-live-linked", "live-linked", "unlinked"]);
  });

  test("APNs sends to live and unlinked tokens, skips expired/gone/foreign sessions, then no_devices", async () => {
    const live = await current(), expired = await login();
    await f.db.session.update({ where: { id: expired.row.id }, data: { expiresAt: new Date() } });
    const foreign = await signUp(f, "foreign");
    const foreignRow = await f.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(foreign.token) } });
    await device("live", live.id);
    await device("unlinked", null);
    await device("gone", "gone");
    await device("expired", expired.row.id);
    await device("foreign", foreignRow.id);
    const { pem } = await testP8();
    const fake = fakeTransport();
    const apns = new ApnsProvider({ db: f.db, keyId: "K", teamId: "T", key: pem, topic: "t", env: null, transport: fake.transport });
    const message = { userId: alex.userId, title: "OpenDuet", body: "Ready", teaser: "Ready", route: "duet://chat", channelId: null };
    try {
      expect(await apns.send(message)).toBe("sent");
      expect(fake.requests.map(request => request.path).sort()).toEqual(["/3/device/live", "/3/device/unlinked"]);
      await f.db.deviceToken.deleteMany({ where: { id: { in: ["live", "unlinked"] } } });
      expect(await apns.send(message)).toBe("no_devices");
      expect(fake.requests).toHaveLength(2);
    } finally { await apns.close(); }
  });
});
