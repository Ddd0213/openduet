// bun run notify:test --username <u>: one test push through the configured provider (fake fetch).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runNotifyTest } from "../../src/cli/notify-test.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { testEnv } from "../helpers/db.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { fakeFetch, testP8 } from "./fakes.ts";

let fixture: TestApp;
let alex: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp();
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const env = (extra: Record<string, string> = {}) => testEnv({ DATABASE_URL: fixture.config.DATABASE_URL, FILES_DIR: fixture.config.FILES_DIR, ...extra });

describe("notify-test CLI", () => {
  test("sends 'OpenDuet' + the test sentence through ntfy", async () => {
    const { calls, fetch } = fakeFetch();
    const lines: string[] = [];
    const code = await runNotifyTest(["--username", "alex"], { env: env({ NOTIFY_PROVIDER: "ntfy", NTFY_URL: "https://ntfy.example.test", NTFY_TOPIC: "duet" }), fetch, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines).toEqual(["Sent a test push through ntfy."]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://ntfy.example.test/duet" });
    expect(calls[0]!.headers).toMatchObject({ Title: "OpenDuet", Click: `duet://channels/${alex.mainChannelId}` });
    const stored = await fixture.db.event.findFirst({ where: { userId: alex.userId, type: "notification" }, orderBy: { id: "desc" } });
    expect(JSON.parse(stored!.payload)).toMatchObject({ title: { key: "notify.title" }, body: { key: "notify.test" } });
  });

  test("without a provider it stores the in-app notification; bad input is reported", async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await runNotifyTest(["--username", "alex"], { env: env(), out })).toBe(0);
    expect(await runNotifyTest(["--username", "nobody"], { env: env(), out })).toBe(1);
    expect(await runNotifyTest([], { env: env(), out })).toBe(2);
    expect(await runNotifyTest(["--username", "alex"], { env: env({ NOTIFY_PROVIDER: "apns" }), out })).toBe(1);
    expect(lines[0]).toContain("NOTIFY_PROVIDER isn't set");
    expect(lines[1]).toContain('No user named "nobody"');
    expect(lines[2]).toContain("Usage:");
    expect(lines[3]).toContain("APNS_TOPIC is required");
  });

  test("apns with no registered iPhone says so", async () => {
    const lines: string[] = [];
    const { pem } = await testP8();
    const code = await runNotifyTest(["--username", "alex"], {
      env: env({ NOTIFY_PROVIDER: "apns", APNS_TOPIC: "com.example.duet", APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: pem.replace(/\n/g, "\\n") }),
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("No registered iPhone");
  });
});
