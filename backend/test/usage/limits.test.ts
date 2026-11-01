// Usage limits (L79, L166): over the session limit a send is refused with usage_limited and one
// usage_limit line; once the window passes the old lines turn into "Usage limit lifted".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessagePage } from "../../src/contract/messages.ts";
import { SESSION_MS } from "../../src/usage/meter.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { replying, usage } from "../helpers/stub-agent.ts";

let clock = new Date("2026-10-26T09:00:00.000Z");
let fixture: TestApp;
let alex: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({ SESSION_TOKEN_LIMIT: "100", WEEKLY_TOKEN_LIMIT: "0" }, { agent: replying("Sure.", usage(80, 40)), now: () => clock });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

const send = (clientId: string) =>
  fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, {
    method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Another one", clientId }),
  });
const limitLines = () => fixture.db.message.findMany({ where: { userId: alex.userId, kind: "usage_limit" } });

describe("usage limits", () => {
  test("over the limit: 429 usage_limited, one usage_limit line, the message isn't stored", async () => {
    const frames = await readSse(await send("u-1"));
    const usageEvent = frames.events.find((e) => e.type === "usage");
    expect(usageEvent?.type === "usage" && usageEvent.payload.usage).toMatchObject({ limited: true, session: { used: 120, limit: 100 } });

    const before = await fixture.db.message.count({ where: { role: "user" } });
    const refused = await send("u-2");
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe("usage_limited");
    expect(await fixture.db.message.count({ where: { role: "user" } })).toBe(before);
    const lines = await limitLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.payload).resumesAt).toBe(new Date(new Date("2026-10-26T09:00:00.000Z").getTime() + SESSION_MS).toISOString());

    expect((await send("u-3")).status).toBe(429);
    expect(await limitLines()).toHaveLength(1);
  });

  test("after the window, opening the thread shows the line as \"Usage limit lifted\"", async () => {
    clock = new Date(clock.getTime() + SESSION_MS + 1000);
    const page = await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, { headers: alex.headers });
    const { messages } = MessagePage.parse(await page.json());
    expect(messages.some((m) => m.kind === "usage_limit")).toBe(false);
    expect(messages.some((m) => m.kind === "system" && m.payload.phrase.key === "system.usage_limit_lifted")).toBe(true);
    expect(await limitLines()).toHaveLength(0);
  });

  test("the next successful send after a limit lifts the line in the stream", async () => {
    await readSse(await send("u-4"));
    expect((await send("u-5")).status).toBe(429);
    const [line] = await limitLines();
    clock = new Date(clock.getTime() + SESSION_MS + 1000);
    const frames = await readSse(await send("u-6"));
    const lifted = frames.events.find((e) => e.type === "message" && e.payload.message.id === line!.id);
    expect(lifted?.type === "message" && lifted.payload.message).toMatchObject({ kind: "system", payload: { phrase: { key: "system.usage_limit_lifted" } } });
    expect(frames.events.at(-1)?.type).toBe("done");
  });
});
