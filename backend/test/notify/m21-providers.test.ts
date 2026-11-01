// M21 push hygiene per provider (fakes only, no network): APNs apns-collapse-id, passive in quiet
// hours and the silent withdraw push; ntfy low priority in quiet hours (no collapse / withdraw);
// Bark level passive and id inside the ciphertext (no withdraw).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import type { Db } from "../../src/db.ts";
import { ApnsProvider } from "../../src/notify/providers/apns.ts";
import { BarkProvider } from "../../src/notify/providers/bark.ts";
import { NtfyProvider } from "../../src/notify/providers/ntfy.ts";
import type { PushMessage } from "../../src/notify/providers/types.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { fakeFetch, fakeTransport, testP8 } from "./fakes.ts";

let db: Db;
let cleanup: () => Promise<void>;
let pem: string;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDatabase());
  await db.user.create({ data: { id: "u1", name: "Alex Kim", authEmail: "alex@users.invalid", username: "alex" } });
  await db.deviceToken.create({ data: { userId: "u1", provider: "apns", token: "a".repeat(64), environment: "production" } });
  ({ pem } = await testP8());
});
afterAll(() => cleanup());

const message: PushMessage = {
  userId: "u1", title: "OpenDuet", body: "Waiting for your approval: Launch notes", teaser: "Launch OpenDuet to see it.",
  route: "duet://channels/c1?message=m1", channelId: "c1", collapseId: "approval-a1",
};
const apns = () => {
  const fake = fakeTransport();
  return { ...fake, provider: new ApnsProvider({ db, keyId: "KEY123", teamId: "TEAM456", key: pem, topic: "com.example.duet", env: null, transport: fake.transport, retryDelayMs: 0 }) };
};

describe("APNs", () => {
  test("apns-collapse-id per thing, the collapse id and the anchored route in the payload", async () => {
    const { provider, requests } = apns();
    expect(await provider.send(message)).toBe("sent");
    expect(requests[0]!.headers).toMatchObject({ "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "approval-a1" });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      aps: { alert: { title: "OpenDuet", body: "Waiting for your approval: Launch notes" }, sound: "default", "thread-id": "c1" },
      route: "duet://channels/c1?message=m1", collapseId: "approval-a1",
    });
  });

  test("quiet hours: interruption-level passive, no sound, priority 5", async () => {
    const { provider, requests } = apns();
    await provider.send({ ...message, collapseId: "task-t1", passive: true });
    expect(requests[0]!.headers).toMatchObject({ "apns-push-type": "alert", "apns-priority": "5", "apns-collapse-id": "task-t1" });
    const aps = JSON.parse(requests[0]!.body).aps;
    expect(aps["interruption-level"]).toBe("passive");
    expect(aps.sound).toBeUndefined();
  });

  test("withdraw is a silent background push naming the collapse id; no alert, sound or text", async () => {
    const { provider, requests } = apns();
    expect(await provider.withdraw("u1", "approval-a1")).toBe("sent");
    expect(requests[0]!.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5" });
    expect(requests[0]!.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(requests[0]!.body)).toEqual({ aps: { "content-available": 1 }, withdraw: ["approval-a1"] });
    expect(await provider.withdraw("nobody", "approval-a1")).toBe("no_devices");
  });
});

describe("ntfy", () => {
  test("passive sends Priority 2; no collapse id header and no withdraw", async () => {
    const { calls, fetch } = fakeFetch();
    const ntfy = new NtfyProvider({ url: "https://ntfy.example.test", topic: "duet", token: null, fetch, retryDelayMs: 0 });
    await ntfy.send(message);
    await ntfy.send({ ...message, passive: true });
    expect(calls[0]!.headers.Priority).toBeUndefined();
    expect(calls[1]!.headers.Priority).toBe("2");
    expect(JSON.stringify(calls)).not.toContain("approval-a1");
    expect(calls[0]!.headers.Click).toBe("duet://channels/c1?message=m1");
    expect("withdraw" in ntfy).toBe(false);
  });
});

describe("Bark", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const iv = "fedcba9876543210";
  test("level passive and the collapse id travel inside the ciphertext only; no withdraw", async () => {
    const { calls, fetch } = fakeFetch();
    const bark = new BarkProvider({ url: "https://bark.example.test", deviceKey: "devKey123", encryptionKey: key, encryptionIv: iv, fetch, retryDelayMs: 0 });
    await bark.send({ ...message, passive: true });
    const form = new URLSearchParams(calls[0]!.body);
    expect([...form.keys()].sort()).toEqual(["ciphertext", "iv"]);
    const decipher = createDecipheriv("aes-256-cbc", Buffer.from(key), Buffer.from(iv));
    const plain = Buffer.concat([decipher.update(Buffer.from(form.get("ciphertext")!, "base64")), decipher.final()]).toString("utf8");
    expect(JSON.parse(plain)).toEqual({ title: "OpenDuet", body: "Launch OpenDuet to see it.", url: "duet://channels/c1?message=m1", level: "passive", id: "approval-a1" });
    expect("withdraw" in bark).toBe(false);
  });
});
