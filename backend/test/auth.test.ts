import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/auth.ts";
import { createClientIpResolver, createDynamicClientIpResolver, ipMatches, socketIp } from "../src/auth/client-ip.ts";
import { toMe } from "../src/auth/me.ts";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { createUser, setPassword } from "../src/auth/users.ts";
import { loadConfig } from "../src/config.ts";
import { ApiError } from "../src/contract/common.ts";
import { Me, ServerInfo, SignInResponse } from "../src/contract/auth.ts";
import { hashedTokenPlaceholder, SESSION_MAX_AGE_MS, sessionTokenHash } from "../src/contract/m28.ts";
import { openDatabase } from "../src/db.ts";
import { version } from "../package.json";
import { createTestApp } from "./helpers/app.ts";

const PASSWORD = "test-only correct horse battery staple";
type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const login = (app: TestApp["app"], username: string, password = PASSWORD, headers: Record<string, string> = {}) =>
  app.request("/api/session", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ username, password }),
  });

async function signedIn(app: TestApp["app"], username: string) {
  const response = await login(app, username);
  expect(response.status).toBe(200);
  return SignInResponse.parse(await response.json());
}

async function errorResponse(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = ApiError.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body;
}

describe("self-hosted auth", () => {
  let fixture: TestApp;
  beforeAll(async () => {
    fixture = await createTestApp();
    await createUser(fixture.db, fixture.auth, { username: "Alex", name: "Alex Kim", password: PASSWORD, random: () => 0 });
    await createUser(fixture.db, fixture.auth, { username: "lin", name: "林晓", password: PASSWORD, random: () => 0.999999 });
  });
  afterAll(async () => fixture.cleanup());

  test("telemetry stays disabled even if the dependency's environment opt-in is set", async () => {
    process.env.BETTER_AUTH_TELEMETRY = "true";
    process.env.BETTER_AUTH_TELEMETRY_DEBUG = "true";
    const auth = createAuth(fixture.config, fixture.db);
    expect(process.env.BETTER_AUTH_TELEMETRY).toBe("false");
    expect(process.env.BETTER_AUTH_TELEMETRY_DEBUG).toBe("false");
    expect(auth.options.telemetry?.enabled).toBe(false);
    await auth.$context;
  });

  test("server-info is public and contains only the contract fields", async () => {
    const response = await fixture.app.request("/api/server-info");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(ServerInfo.parse(body)).toEqual({ name: fixture.config.SERVER_NAME, version, apiVersion: 1 });
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(["apiVersion", "name", "version"]);
  });

  test("account defaults, normalized username, credential hash and main channel", async () => {
    const alex = await fixture.db.user.findUniqueOrThrow({ where: { username: "alex" } });
    const lin = await fixture.db.user.findUniqueOrThrow({ where: { username: "lin" } });
    expect(alex.firstName).toBe("Alex");
    expect(lin.firstName).toBe("林晓");
    expect(alex.authEmail).toBe("alex@users.invalid");
    expect(alex.email).toBeNull();
    expect(alex.language).toBe("en");
    expect(alex.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(alex.briefTime).toBe("07:01");
    expect(lin.briefTime).toBe("08:59");
    expect(alex.checkinMinute).toBe(0);
    expect(lin.checkinMinute).toBe(59);
    for (const user of [alex, lin]) {
      const [hour, minute] = user.briefTime.split(":").map(Number);
      expect(hour).toBeGreaterThanOrEqual(7);
      expect(hour).toBeLessThanOrEqual(8);
      expect(minute! % 2).toBe(1);
      expect(user.weekendsOn).toBe(false);
      expect(user.onboardedAt).toBeNull();
      const channels = await fixture.db.channel.findMany({ where: { userId: user.id } });
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({ isMain: true, name: "", icon: "checkbox", colorHex: "#E69F4E" });
      const account = await fixture.db.account.findFirstOrThrow({ where: { userId: user.id } });
      expect(account.providerId).toBe("credential");
      expect(account.accountId).toBe(user.id);
      expect(account.password).not.toBe(PASSWORD);
    }
    const direct = await signedIn(fixture.app, "ALEX");
    expect(direct.user.id).toBe(alex.id);
    expect(direct.token).toBeString();
  });

  test("validates CLI-facing input and duplicate usernames without partial writes", async () => {
    const base = { username: "custom.user_1", name: "Full Name", password: PASSWORD };
    const user = await createUser(fixture.db, fixture.auth, {
      ...base, firstName: "First", language: "zh-Hans", timezone: "Asia/Shanghai",
    });
    expect(user).toMatchObject({ firstName: "First", language: "zh-Hans", timezone: "Asia/Shanghai" });
    await expect(createUser(fixture.db, fixture.auth, { ...base, username: "CUSTOM.USER_1" })).rejects.toThrow(/already exists/);
    for (const invalid of [
      { username: "ab" }, { username: "a-b" }, { username: "a".repeat(31) },
      { language: "zh" }, { timezone: "Mars/Olympus" }, { timezone: "+08:00" },
      { password: "short" }, { password: "x".repeat(129) }, { name: " " },
    ]) {
      await expect(createUser(fixture.db, fixture.auth, { ...base, ...invalid })).rejects.toThrow();
    }
    expect(await fixture.db.user.count()).toBe(3);
    expect(await fixture.db.channel.count()).toBe(3);
    await expect(setPassword(fixture.db, fixture.auth, "alex", "short")).rejects.toThrow(/at least 12/);
    await expect(setPassword(fixture.db, fixture.auth, "absent", PASSWORD)).rejects.toThrow(/does not exist/);
  });

  test("sign-in returns the raw bearer token plus a sanitized Me", async () => {
    const { token, user } = await signedIn(fixture.app, "ALEX");
    expect(user.username).toBe("alex");
    expect(user.email).toBeNull();
    expect(user.features).toEqual({ connectors: false, webSearch: true, push: null, computer: false, models: true, voice: false, computerMode: "off", computerIdleMinutes: 30 });
    const response = await fixture.app.request("/api/me", { headers: bearer(token) });
    expect(response.status).toBe(200);
    expect(Me.parse(await response.json())).toEqual(user);
    const row = await fixture.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(token) } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(SESSION_MAX_AGE_MS);
    expect(JSON.stringify(user)).not.toContain("users.invalid");
    expect(user).not.toHaveProperty("authEmail");
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("wrong passwords and unknown usernames have identical errors", async () => {
    const wrong = await errorResponse(await login(fixture.app, "alex", "incorrect"), 401, "invalid_credentials");
    const absent = await errorResponse(await login(fixture.app, "no_such_user", "incorrect"), 401, "invalid_credentials");
    expect(absent).toEqual(wrong);
    expect(wrong.error.message).toBe("Wrong username or password.");
  });

  test("public registration is disabled and Better Auth's HTTP endpoints are not mounted", async () => {
    await expect(fixture.auth.api.signUpEmail({ body: {
      username: "new_user", name: "New User", email: "new_user@users.invalid", password: PASSWORD,
    } })).rejects.toThrow(/not enabled/i);
    expect(await fixture.db.user.findUnique({ where: { username: "new_user" } })).toBeNull();
    await errorResponse(await fixture.app.request("/api/auth/sign-up/email", { method: "POST" }), 401, "unauthorized");
    const { token } = await signedIn(fixture.app, "alex");
    await errorResponse(await fixture.app.request("/api/auth/sign-up/email", { method: "POST", headers: bearer(token) }), 404, "not_found");
  });

  test("missing, malformed, expired and cookie-only credentials fail closed", async () => {
    for (const path of ["/api/me", "/api/channels", "/api/nope"]) {
      const body = await errorResponse(await fixture.app.request(path), 401, "unauthorized");
      expect(body.error.message).toBe("Sign in again.");
    }
    for (const token of ["garbage", "x.y.z", "%broken", "", "not a token"]) {
      await errorResponse(await fixture.app.request("/api/me", { headers: bearer(token) }), 401, "unauthorized");
    }
    const { token } = await signedIn(fixture.app, "alex");
    await errorResponse(await fixture.app.request("/api/me", { headers: { Cookie: `better-auth.session_token=${token}` } }), 401, "unauthorized");
    await fixture.db.session.update({ where: { tokenHash: sessionTokenHash(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await errorResponse(await fixture.app.request("/api/me", { headers: bearer(token) }), 401, "unauthorized");
  });

  test("external JSON is validated", async () => {
    await errorResponse(await fixture.app.request("/api/session", { method: "POST", body: "{" }), 400, "validation_failed");
    await errorResponse(await fixture.app.request("/api/session", {
      method: "POST", body: JSON.stringify({ username: "alex", password: 123 }),
    }), 400, "validation_failed");
  });

  test("locale and timezone synchronize on sign-in and authenticated requests; invalid values are ignored", async () => {
    const signIn = await login(fixture.app, "lin", PASSWORD, { "X-Timezone": "Asia/Shanghai", "X-Locale": "zh-Hans" });
    const { token, user } = SignInResponse.parse(await signIn.json());
    expect(user).toMatchObject({ timezone: "Asia/Shanghai", language: "zh-Hans" });
    const response = await fixture.app.request("/api/me", {
      headers: { ...bearer(token), "X-Timezone": "America/New_York", "X-Locale": "en" },
    });
    expect(Me.parse(await response.json())).toMatchObject({ timezone: "America/New_York", language: "en" });
    const row = await fixture.db.user.findUniqueOrThrow({ where: { username: "lin" } });
    expect(row).toMatchObject({ timezone: "America/New_York", language: "en" });
    const ignored = await fixture.app.request("/api/me", {
      headers: { ...bearer(token), "X-Timezone": "Invalid/Zone", "X-Locale": "zh-CN" },
    });
    expect(Me.parse(await ignored.json())).toMatchObject({ timezone: "America/New_York", language: "en" });
  });

  test("M25: X-Region keeps User.region (two letters, upper case); other values and no header keep it", async () => {
    const { token } = SignInResponse.parse(await (await login(fixture.app, "lin", PASSWORD, { "X-Region": "cn" })).json());
    const region = async () => (await fixture.db.user.findUniqueOrThrow({ where: { username: "lin" } })).region;
    expect(await region()).toBe("CN");
    await fixture.app.request("/api/me", { headers: { ...bearer(token), "X-Region": "US" } });
    expect(await region()).toBe("US");
    for (const value of ["001", "USA", "", "u1"]) {
      await fixture.app.request("/api/me", { headers: { ...bearer(token), "X-Region": value } });
      expect(await region()).toBe("US");
    }
    await fixture.app.request("/api/me", { headers: bearer(token) });
    expect(await region()).toBe("US");
  });

  test("Me uses the real email and configured feature flags", async () => {
    const user = await fixture.db.user.findUniqueOrThrow({ where: { username: "alex" } });
    const config = loadConfig({
      PUBLIC_URL: fixture.config.PUBLIC_URL, DATABASE_URL: fixture.config.DATABASE_URL,
      BETTER_AUTH_SECRET: fixture.config.BETTER_AUTH_SECRET, COMPOSIO_API_KEY: "test-only-key",
      SEARCH_PROVIDER: "tavily", SEARCH_API_KEY: "test-only-key", NOTIFY_PROVIDER: "ntfy",
      COMPUTER_URL: "http://computer:4100", COMPUTER_TOKEN: "test-only-token-1234567890",
    });
    const result = toMe({ ...user, email: "real@example.com" }, "main", config);
    expect(result.email).toBe("real@example.com");
    expect(result.features).toEqual({ connectors: true, webSearch: true, push: "ntfy", computer: true, models: true, voice: false, computerMode: "headless", computerIdleMinutes: 30 });
  });

  test("logout revokes only the current session immediately", async () => {
    const first = await signedIn(fixture.app, "alex");
    const second = await signedIn(fixture.app, "alex");
    const response = await fixture.app.request("/api/session", { method: "DELETE", headers: bearer(first.token) });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await errorResponse(await fixture.app.request("/api/me", { headers: bearer(first.token) }), 401, "unauthorized");
    expect((await fixture.app.request("/api/me", { headers: bearer(second.token) })).status).toBe(200);
    await errorResponse(await fixture.app.request("/api/session", { method: "DELETE" }), 401, "unauthorized");
  });

  test("password changes revoke every session and the old password stops working", async () => {
    const first = await signedIn(fixture.app, "alex");
    const second = await signedIn(fixture.app, "alex");
    const lin = await signedIn(fixture.app, "lin");
    await setPassword(fixture.db, fixture.auth, "ALEX", "test-only new password");
    for (const { token } of [first, second]) {
      await errorResponse(await fixture.app.request("/api/me", { headers: bearer(token) }), 401, "unauthorized");
    }
    await errorResponse(await login(fixture.app, "alex"), 401, "invalid_credentials");
    expect((await login(fixture.app, "alex", "test-only new password")).status).toBe(200);
    expect((await fixture.app.request("/api/me", { headers: bearer(lin.token) })).status).toBe(200);
    await setPassword(fixture.db, fixture.auth, "alex", PASSWORD);
  });

  test("sessions survive a new database client and auth/app factory; use leaves expiry fixed", async () => {
    const { token } = await signedIn(fixture.app, "lin");
    const oldExpiry = new Date(Date.now() + 89 * 86400 * 1000);
    await fixture.db.session.update({ where: { tokenHash: sessionTokenHash(token) }, data: { expiresAt: oldExpiry } });
    const db = await openDatabase(fixture.config.DATABASE_URL);
    try {
      const auth = createAuth(fixture.config, db);
      const app = createApp({ config: fixture.config, db, auth });
      expect((await app.request("/api/me", { headers: bearer(token) })).status).toBe(200);
      const row = await db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(token) } });
      expect(row.expiresAt.getTime()).toBe(oldExpiry.getTime());
      expect(row.token).toBe(hashedTokenPlaceholder(row.id));
    } finally {
      await db.$disconnect();
    }
  });

  test("both existing and absent usernames are pair/IP limited without locking a different IP", async () => {
    for (const username of ["alex", "nonexistent_user"]) {
      let now = 1000;
      let ip = "192.0.2.1";
      const limiter = new LoginRateLimiter(() => now);
      const app = createApp({ ...fixture, loginRateLimiter: limiter, clientIp: () => ip });
      for (let i = 0; i < 5; i++) await errorResponse(await login(app, username.toUpperCase(), "incorrect"), 401, "invalid_credentials");
      const locked = await login(app, username, "incorrect");
      const body = await errorResponse(locked, 429, "rate_limited");
      expect(body.error.message).toBe("Too many attempts. Try again in a moment.");
      expect(locked.headers.get("Retry-After")).toBe("1");
      ip = "192.0.2.2";
      expect(limiter.retryAfter(ip, username)).toBe(0);
      expect(limiter.slowdown(username)).toBe(1);
      now += 1000;
      if (username === "alex") {
        expect((await login(app, username)).status).toBe(200);
        ip = "192.0.2.3";
        expect((await login(app, username, "incorrect")).status).toBe(401);
        expect(limiter.retryAfter("192.0.2.4", username)).toBe(0);
      } else {
        await errorResponse(await login(app, username, "incorrect"), 401, "invalid_credentials");
        expect(limiter.retryAfter(ip, username)).toBe(0);
        ip = "192.0.2.1";
        await errorResponse(await login(app, username, "incorrect"), 401, "invalid_credentials");
        expect((await login(app, username)).headers.get("Retry-After")).toBe("2");
      }
    }
  });
});

describe("rate limit clock and cleanup", () => {
  test("IP and username counters are independent, grow exponentially, cap and expire", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(() => now);
    for (let i = 0; i < 5; i++) limiter.failure("ip", `user${i}`);
    expect(limiter.retryAfter("ip", "fresh")).toBe(1);
    expect(limiter.retryAfter("other", "user0")).toBe(0);
    now += 1000;
    limiter.failure("ip", "user0");
    expect(limiter.retryAfter("ip", "fresh")).toBe(2);
    for (let i = 0; i < 20; i++) limiter.failure("cap", "CAP");
    expect(limiter.retryAfter("elsewhere", "cap")).toBe(0);
    expect(limiter.retryAfter("cap", "cap")).toBe(900);
    expect(limiter.slowdown("cap")).toBe(30);
    limiter.success("elsewhere", "cAp");
    expect(limiter.slowdown("cap")).toBe(0);
    expect(limiter.retryAfter("cap", "new")).toBe(900);
    now += 15 * 60 * 1000 + 1;
    expect(limiter.size).toBe(0);
  });
});

describe("trusted proxy IP handling", () => {
  test("service-name DNS trusts exact peers, caches briefly and fails closed after recreation/failure", async () => {
    let now = 0, calls = 0, ips = ["172.20.0.3"];
    const resolver = createDynamicClientIpResolver(["caddy"], async (host) => {
      expect(host).toBe("caddy"); calls++; return ips;
    }, () => now);
    expect(await resolver("172.20.0.3", "203.0.113.1")).toBe("203.0.113.1");
    expect(await resolver("172.20.0.1", "203.0.113.1")).toBe("172.20.0.1");
    expect(await resolver("172.20.0.4", "203.0.113.1")).toBe("172.20.0.4");
    expect(calls).toBe(1);
    ips = ["172.20.0.4"]; now = 30_001;
    expect(await resolver("172.20.0.3", "203.0.113.1")).toBe("172.20.0.3");
    expect(await resolver("172.20.0.4", "203.0.113.1")).toBe("203.0.113.1");
    ips = []; now += 30_001;
    expect(await resolver("172.20.0.4", "203.0.113.1")).toBe("172.20.0.4");
    const failed = createDynamicClientIpResolver(["tunnel"], async () => { throw new Error("DNS unavailable"); });
    expect(await failed("172.20.0.4", "203.0.113.1")).toBe("172.20.0.4");
  });
  test("IPv4 and IPv6 exact addresses and CIDRs, including mapped IPv4", () => {
    for (const [ip, rule, expected] of [
      ["10.2.3.4", "10.0.0.0/8", true], ["11.2.3.4", "10.0.0.0/8", false],
      ["192.0.2.255", "192.0.2.128/25", true], ["192.0.2.127", "192.0.2.128/25", false],
      ["10.0.0.1", "10.0.0.1", true], ["10.0.0.2", "10.0.0.1/32", false],
      ["198.51.100.1", "0.0.0.0/0", true], ["::1", "::1", true],
      ["2001:db8:abcd::1", "2001:db8::/32", true], ["2001:db9::1", "2001:db8::/32", false],
      ["2001:db8::1", "2001:db8::1/128", true], ["2001:db8::2", "2001:db8::1/128", false],
      ["::ffff:10.2.3.4", "10.0.0.0/8", true], ["::ffff:a02:304", "10.0.0.0/8", true],
      ["10.0.0.1", "::ffff:10.0.0.0/104", true], ["::1", "0.0.0.0/0", false],
      ["::ffff:192.0.2.1", "::/0", true], ["192.0.2.1", "::ffff:0:0/96", true],
      ["192.0.2.1", "::1/128", false], ["2001:db8::1", "::/0", true],
      ["not-ip", "10.0.0.1", false],
    ] as const) expect(ipMatches(ip, rule)).toBe(expected);
    for (const rule of ["bad", "10.0.0.0/33", "::/129", "10.0.0.1/x", "10.0.0.1/8/9"]) {
      expect(() => createClientIpResolver([rule])).toThrow(/TRUSTED_PROXIES/);
    }
  });

  test("ignores spoofed XFF and selects the rightmost untrusted hop", () => {
    const resolve = createClientIpResolver(["10.0.0.0/8", "2001:db8::/32"]);
    expect(resolve("192.0.2.1", "198.51.100.9")).toBe("192.0.2.1");
    expect(resolve(undefined, "198.51.100.9")).toBe("unknown");
    expect(resolve("10.0.0.2", "203.0.113.8, 198.51.100.9, 10.0.0.3")).toBe("198.51.100.9");
    expect(resolve("2001:db8::1", "2001:DB9:0:0::2, 2001:db8::3")).toBe("2001:db9::2");
    expect(resolve("10.0.0.2", "10.0.0.3, 10.0.0.4")).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", "203.0.113.8, invalid")).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", "203.0.113.8:1234")).toBe("10.0.0.2");
  });

  test("app.fetch reads Bun's second argument without starting a server", async () => {
    const fixture = await createTestApp({ TRUSTED_PROXIES: "10.0.0.0/8" });
    try {
      fixture.app.get("/connection-test", (c) => {
        const resolve = createClientIpResolver(fixture.config.TRUSTED_PROXIES);
        return c.json({ ip: resolve(socketIp(c), c.req.header("X-Forwarded-For")) });
      });
      const req = new Request("http://localhost/connection-test", { headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.3" } });
      const trusted = await fixture.app.fetch(req, { requestIP: () => ({ address: "10.0.0.2", family: "IPv4", port: 1234 }) });
      expect(await trusted.json()).toEqual({ ip: "203.0.113.7" });
      const untrusted = await fixture.app.fetch(req, { requestIP: () => ({ address: "192.0.2.2", family: "IPv4", port: 1234 }) });
      expect(await untrusted.json()).toEqual({ ip: "192.0.2.2" });
      const noSocket = await fixture.app.request(req);
      expect(await noSocket.json()).toEqual({ ip: "unknown" });
    } finally {
      await fixture.cleanup();
    }
  });
});
