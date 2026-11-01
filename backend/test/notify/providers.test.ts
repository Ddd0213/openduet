// Push providers with injected fetch / HTTP/2 transport (no network): APNs JWT + dead tokens,
// ntfy title-and-link only, Bark AES-CBC, at most one retry; and NOTIFY_* validation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { ConfigError } from "../../src/config.ts";
import type { Db } from "../../src/db.ts";
import { loadNotifyConfig } from "../../src/notify/config.ts";
import { APNS_JWT_TTL_MS, signApnsJwt } from "../../src/notify/providers/apns-jwt.ts";
import { ApnsProvider } from "../../src/notify/providers/apns.ts";
import { BarkProvider, barkEncrypt } from "../../src/notify/providers/bark.ts";
import { createPushProvider } from "../../src/notify/providers/index.ts";
import { NtfyProvider } from "../../src/notify/providers/ntfy.ts";
import type { PushMessage } from "../../src/notify/providers/types.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { fakeFetch, fakeTransport, testP8 } from "./fakes.ts";

let db: Db;
let cleanup: () => Promise<void>;
let pem: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDatabase());
  await db.user.create({ data: { id: "u1", name: "Alex Kim", authEmail: "alex@users.invalid", username: "alex" } });
  ({ pem, publicKey } = await testP8());
});
afterAll(() => cleanup());

const message: PushMessage = { userId: "u1", title: "OpenDuet", body: "Your prep for Launch review is ready.", teaser: "Launch OpenDuet to see it.", route: "duet://tasks/t1", channelId: "c1" };
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("APNs", () => {
  test("the provider token is an ES256 JWT that verifies with the key", async () => {
    const jwt = await signApnsJwt(pem, "KEY123", "TEAM456", new Date("2026-10-25T08:00:00.000Z"));
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(decode(claims!)).toEqual({ iss: "TEAM456", iat: Math.floor(Date.parse("2026-10-25T08:00:00.000Z") / 1000) });
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
    expect(ok).toBe(true);
  });

  test("sends to each device on its environment's host, caches the JWT and drops dead tokens", async () => {
    await db.deviceToken.createMany({ data: [
      { id: "d-prod", userId: "u1", provider: "apns", token: "a".repeat(64), environment: "production" },
      { id: "d-sandbox", userId: "u1", provider: "apns", token: "b".repeat(64), environment: "sandbox" },
      { id: "d-dead", userId: "u1", provider: "apns", token: "c".repeat(64), environment: "production" },
      { id: "d-bad", userId: "u1", provider: "apns", token: "d".repeat(64), environment: "production" },
      { id: "d-other400", userId: "u1", provider: "apns", token: "e".repeat(64), environment: "production" },
    ] });
    const answers: Record<string, { status: number; body?: string }> = {
      a: { status: 200 }, b: { status: 200 }, c: { status: 410, body: '{"reason":"Unregistered"}' },
      d: { status: 400, body: '{"reason":"BadDeviceToken"}' }, e: { status: 400, body: '{"reason":"BadTopic"}' },
    };
    const { requests, transport, closed } = fakeTransport((req) => answers[req.path.charAt("/3/device/".length)]!);
    const apns = new ApnsProvider({ db, keyId: "KEY123", teamId: "TEAM456", key: pem, topic: "com.example.duet", env: null, transport, retryDelayMs: 0 });
    expect(await apns.send(message)).toBe("sent");
    expect(requests).toHaveLength(5);
    const byToken = Object.fromEntries(requests.map((r) => [r.path.slice("/3/device/".length, "/3/device/".length + 1), r]));
    expect(byToken.a!.origin).toBe("https://api.push.apple.com");
    expect(byToken.b!.origin).toBe("https://api.sandbox.push.apple.com");
    const first = requests[0]!;
    expect(first.headers).toMatchObject({ "apns-topic": "com.example.duet", "apns-push-type": "alert", "apns-priority": "10" });
    expect(first.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(new Set(requests.map((r) => r.headers.authorization)).size).toBe(1);
    expect(JSON.parse(first.body)).toEqual({ aps: { alert: { title: "OpenDuet", body: "Your prep for Launch review is ready." }, sound: "default", "thread-id": "c1" }, route: "duet://tasks/t1" });
    expect((await db.deviceToken.findMany({ orderBy: { id: "asc" } })).map((d) => d.id)).toEqual(["d-other400", "d-prod", "d-sandbox"]);
    await apns.close();
    expect(closed()).toBe(true);
    await db.deviceToken.deleteMany();
  });

  test("retries once (5xx, network error, expired provider token with a fresh JWT), then gives up", async () => {
    // A dev-build (sandbox) token stays on the sandbox host even with APNS_ENV=production.
    await db.deviceToken.create({ data: { id: "d1", userId: "u1", provider: "apns", token: "f".repeat(64), environment: "sandbox" } });
    const now = new Date("2026-10-25T08:00:00.000Z");
    const run = async (script: Parameters<typeof fakeTransport>[0]) => {
      const fake = fakeTransport(script);
      const apns = new ApnsProvider({ db, keyId: "K", teamId: "T", key: pem, topic: "com.example.duet", env: "production", transport: fake.transport, now: () => now, retryDelayMs: 0 });
      return { outcome: await apns.send(message), requests: fake.requests, apns };
    };
    const flaky = await run([{ status: 503 }, { status: 200 }]);
    expect([flaky.outcome, flaky.requests.length, flaky.requests[0]!.origin]).toEqual(["sent", 2, "https://api.sandbox.push.apple.com"]);
    expect((await run([new Error("ECONNRESET"), { status: 200 }])).outcome).toBe("sent");
    const down = await run([{ status: 500 }, { status: 500 }, { status: 200 }]);
    expect([down.outcome, down.requests.length]).toEqual(["failed", 2]);
    const expired = await run([{ status: 403, body: '{"reason":"ExpiredProviderToken"}' }, { status: 200 }]);
    expect(expired.outcome).toBe("sent");
    // Same clock, but the rejected token was dropped: the retry signs a new one (ECDSA is randomized).
    expect(expired.requests[1]!.headers.authorization).not.toBe(expired.requests[0]!.headers.authorization);
    const forbidden = await run([{ status: 403, body: '{"reason":"TopicDisallowed"}' }]);
    expect([forbidden.outcome, forbidden.requests.length]).toEqual(["failed", 1]);
    expect(await db.deviceToken.count()).toBe(1);
    await db.deviceToken.deleteMany();
  });

  test("the JWT is re-signed after 50 minutes; no devices is 'no_devices'", async () => {
    await db.deviceToken.create({ data: { userId: "u1", provider: "apns", token: "9".repeat(64) } });
    let now = new Date("2026-10-25T08:00:00.000Z");
    const fake = fakeTransport();
    const apns = new ApnsProvider({ db, keyId: "K", teamId: "T", key: pem, topic: "t", env: null, transport: fake.transport, now: () => now });
    await apns.send(message);
    now = new Date(now.getTime() + APNS_JWT_TTL_MS - 1000);
    await apns.send(message);
    now = new Date(now.getTime() + 2000);
    await apns.send(message);
    const auth = fake.requests.map((r) => r.headers.authorization);
    expect(auth[0]).toBe(auth[1]);
    expect(auth[2]).not.toBe(auth[1]);
    await db.deviceToken.deleteMany();
    expect(await apns.send(message)).toBe("no_devices");
  });
});

describe("ntfy", () => {
  test("posts only the title and the deep link, with the token when set", async () => {
    const { calls, fetch } = fakeFetch();
    const ntfy = new NtfyProvider({ url: "https://ntfy.example.test", topic: "duet-alex", token: "tk_secret", fetch, retryDelayMs: 0 });
    expect(await ntfy.send(message)).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://ntfy.example.test/duet-alex", method: "POST", body: "Launch OpenDuet to see it." });
    expect(calls[0]!.headers).toMatchObject({ Title: "OpenDuet", Click: "duet://tasks/t1", Authorization: "Bearer tk_secret" });
    expect(JSON.stringify(calls[0])).not.toContain("Launch review");
  });

  test("one retry on 429 / 5xx / network errors, none on 4xx", async () => {
    const send = async (statuses: Array<number | Error>) => {
      const fake = fakeFetch(statuses);
      const outcome = await new NtfyProvider({ url: "https://ntfy.example.test", topic: "t", token: null, fetch: fake.fetch, retryDelayMs: 0 }).send(message);
      return [outcome, fake.calls.length, fake.calls[0]!.headers.Authorization] as const;
    };
    expect(await send([503])).toEqual(["sent", 2, undefined]);
    expect(await send([new Error("offline"), new Error("offline"), 200])).toEqual(["failed", 2, undefined]);
    expect(await send([403])).toEqual(["failed", 1, undefined]);
  });
});

describe("Bark", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const iv = "fedcba9876543210";
  test("sends AES-CBC ciphertext of {title, body, url} that the Bark app can decrypt", async () => {
    const { calls, fetch } = fakeFetch();
    const bark = new BarkProvider({ url: "https://bark.example.test", deviceKey: "devKey123", encryptionKey: key, encryptionIv: iv, fetch, retryDelayMs: 0 });
    expect(await bark.send(message)).toBe("sent");
    expect(calls[0]).toMatchObject({ url: "https://bark.example.test/devKey123", method: "POST" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("iv")).toBe(iv);
    const decipher = createDecipheriv("aes-256-cbc", Buffer.from(key), Buffer.from(iv));
    const plain = Buffer.concat([decipher.update(Buffer.from(form.get("ciphertext")!, "base64")), decipher.final()]).toString("utf8");
    expect(JSON.parse(plain)).toEqual({ title: "OpenDuet", body: "Launch OpenDuet to see it.", url: "duet://tasks/t1" });
    expect(calls[0]!.body).not.toContain("Launch");
  });

  test("the key length picks AES-128 / 192 / 256", () => {
    for (const k of ["k".repeat(16), "k".repeat(24), "k".repeat(32)]) {
      const decipher = createDecipheriv(`aes-${k.length * 8}-cbc`, Buffer.from(k), Buffer.from(iv));
      const text = Buffer.concat([decipher.update(Buffer.from(barkEncrypt("hello", k, iv), "base64")), decipher.final()]).toString();
      expect(text).toBe("hello");
    }
  });
});

describe("loadNotifyConfig", () => {
  const problems = (env: Record<string, string>) => {
    try {
      loadNotifyConfig(env);
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).problems;
    }
  };

  test("nothing set: local notifications only", () => {
    expect(loadNotifyConfig({})).toEqual({ provider: null });
    expect(createPushProvider({ provider: null }, { db })).toBeNull();
  });

  test("apns names each missing setting and refuses .p12 and bad keys", () => {
    expect(problems({ NOTIFY_PROVIDER: "apns" })).toEqual(expect.arrayContaining(["APNS_TOPIC is required when NOTIFY_PROVIDER=apns", "APNS_KEY_ID is required when NOTIFY_PROVIDER=apns", "APNS_TEAM_ID is required when NOTIFY_PROVIDER=apns", "APNS_KEY is required when NOTIFY_PROVIDER=apns"]));
    expect(problems({ NOTIFY_PROVIDER: "apns", APNS_TOPIC: "com.example.duet", APNS_CERT: "/certs/push.p12" })[0]).toContain("APNS_CERT");
    expect(problems({ NOTIFY_PROVIDER: "apns", APNS_TOPIC: "t", APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: "/no/such/AuthKey.p8" })).toEqual(["APNS_KEY must be the .p8 key or a readable path to it"]);
    expect(problems({ NOTIFY_PROVIDER: "apns", APNS_TOPIC: "t", APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----" })).toEqual(["APNS_KEY is not a valid .p8 (EC P-256) private key"]);
  });

  test("apns accepts the .p8 inline with \\n escapes", () => {
    const config = loadNotifyConfig({ NOTIFY_PROVIDER: "apns", APNS_TOPIC: "com.example.duet", APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: pem.replace(/\n/g, "\\n"), APNS_ENV: "sandbox" });
    expect(config).toMatchObject({ provider: "apns", topic: "com.example.duet", keyId: "K", teamId: "T", env: "sandbox", key: pem });
  });

  test("ntfy and bark", () => {
    expect(problems({ NOTIFY_PROVIDER: "ntfy" })).toEqual(["NTFY_URL is required when NOTIFY_PROVIDER=ntfy", "NTFY_TOPIC is required when NOTIFY_PROVIDER=ntfy"]);
    expect(problems({ NOTIFY_PROVIDER: "ntfy", NTFY_URL: "ftp://x", NTFY_TOPIC: "t" })[0]).toContain("NTFY_URL");
    expect(loadNotifyConfig({ NOTIFY_PROVIDER: "ntfy", NTFY_URL: "https://ntfy.sh/", NTFY_TOPIC: "duet" })).toEqual({ provider: "ntfy", url: "https://ntfy.sh", topic: "duet", token: null });
    expect(problems({ NOTIFY_PROVIDER: "bark", BARK_URL: "https://api.day.app", BARK_DEVICE_KEY: "abc" })).toEqual(["BARK_ENCRYPTION_KEY is required when NOTIFY_PROVIDER=bark", "BARK_ENCRYPTION_IV is required when NOTIFY_PROVIDER=bark"]);
    expect(problems({ NOTIFY_PROVIDER: "bark", BARK_URL: "https://api.day.app", BARK_DEVICE_KEY: "abc", BARK_ENCRYPTION_KEY: "short", BARK_ENCRYPTION_IV: "x".repeat(16) })[0]).toContain("BARK_ENCRYPTION_KEY");
    const bark = loadNotifyConfig({ NOTIFY_PROVIDER: "bark", BARK_URL: "https://api.day.app", BARK_DEVICE_KEY: "abc", BARK_ENCRYPTION_KEY: "k".repeat(16), BARK_ENCRYPTION_IV: "v".repeat(16) });
    expect(createPushProvider(bark, { db })?.name).toBe("bark");
  });
});
