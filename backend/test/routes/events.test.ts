// GET /api/events (L73): heartbeat, no-buffering headers, replay with Last-Event-ID / ?since=
// without gaps or repeats, and per-user isolation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { replying } from "../helpers/stub-agent.ts";

let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({}, { agent: replying("Hi!"), heartbeatMs: 25 });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const chat = async (who: SignedIn, clientId: string) =>
  readSse(await fixture.app.request(`/api/channels/${who.mainChannelId}/messages`, {
    method: "POST", headers: { ...who.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello", clientId }),
  }));
const events = (headers: Record<string, string>, query = "") => fixture.app.request(`/api/events${query}`, { headers });

describe("GET /api/events", () => {
  test("needs a session, sends heartbeats and no-buffering headers", async () => {
    expect((await events({})).status).toBe(401);
    const response = await events(alex.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    const frames = await readSse(response, { until: (f) => f.comments.includes("ping"), timeoutMs: 2000 });
    expect(frames.comments).toContain("ping");
  });

  test("Last-Event-ID replays exactly what was missed, and only this user's events", async () => {
    const first = await chat(alex, "e-1");
    await chat(sam, "e-sam");
    const second = await chat(alex, "e-2");
    const resumeAt = first.ids.at(-1)!;
    const replay = await readSse(await events({ ...alex.headers, "Last-Event-ID": String(resumeAt) }), { until: (f) => f.ids.includes(second.ids.at(-1)!) });
    const stored = await fixture.db.event.findMany({ where: { userId: alex.userId, id: { gt: resumeAt } }, orderBy: { id: "asc" } });
    expect(replay.ids).toEqual(stored.map((e) => e.id));
    expect(replay.ids).toEqual(expect.arrayContaining(second.ids));
    expect(replay.ids.some((id) => first.ids.includes(id))).toBe(false);
  });

  test("?since= works the same, Last-Event-ID wins over it, and live events follow without repeats", async () => {
    const before = await chat(alex, "e-3");
    const since = before.ids[0]! - 1;
    const response = await events(alex.headers, `?since=${since}`);
    const reading = readSse(response, { until: (f) => f.events.some((e) => e.type === "message" && e.payload.message.clientId === "e-live") && f.events.at(-1)?.type === "done" });
    const live = await chat(alex, "e-live");
    const frames = await reading;
    expect(new Set(frames.ids).size).toBe(frames.ids.length);
    expect(frames.ids).toEqual([...frames.ids].sort((a, b) => a - b));
    expect(frames.ids).toEqual(expect.arrayContaining([...before.ids, ...live.ids]));

    const latest = live.ids.at(-1)!;
    const both = await readSse(await events({ ...alex.headers, "Last-Event-ID": String(latest) }, "?since=0"), { timeoutMs: 150 });
    expect(both.ids).toEqual([]);
  });
});
