import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SignInResponse } from "../src/contract/auth.ts";
import { sessionTokenHash } from "../src/contract/m28.ts";
import { RunHost } from "../src/runs/host.ts";
import { createTasks } from "../src/tasks/index.ts";
import { createTestApp, type TestApp } from "./helpers/app.ts";
import { signUp, TEST_PASSWORD } from "./helpers/session.ts";
import { stubAgent, usage, MODEL } from "./helpers/stub-agent.ts";

let f: TestApp | undefined;
let release: (() => void) | undefined;
afterEach(async () => { release?.(); release = undefined; await f?.cleanup(); f = undefined; });

async function login(f: TestApp, username = "alex") {
  const response = await f.app.request("/api/session", { method: "POST", body: JSON.stringify({ username, password: TEST_PASSWORD }) });
  expect(response.status).toBe(200);
  const { token } = SignInResponse.parse(await response.json());
  return { token, headers: { Authorization: `Bearer ${token}` } };
}
const row = (f: TestApp, token: string) => f.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(token) } });
async function drains(response: Response) {
  const reader = response.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => { while (!(await reader.read()).done) {} })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stream did not close")), 2000); }),
    ]);
  } finally { clearTimeout(timer); await reader.cancel(); }
}
const revoke = (f: TestApp, id: string, headers: Record<string, string>) => f.app.request(`/api/sessions/${id}`, { method: "DELETE", headers });

describe("M28 stream lifetime", () => {
  test("revoking a GET events session ends all its streams and releases presence, preserving another device", async () => {
    f = await createTestApp();
    const alex = await signUp(f, "alex"), other = await login(f);
    const first = await f.app.request("/api/events", { headers: alex.headers });
    const duplicate = await f.app.request("/api/events", { headers: alex.headers });
    const second = await f.app.request("/api/events", { headers: other.headers });
    expect(f.events.onlineCount(alex.userId)).toBe(3);
    expect((await revoke(f, (await row(f, alex.token)).id, other.headers)).status).toBe(204);
    await Promise.all([drains(first), drains(duplicate)]);
    expect(f.events.onlineCount(alex.userId)).toBe(1);
    expect((await f.app.request("/api/events", { headers: alex.headers })).status).toBe(401);
    await second.body!.cancel();
    expect(f.events.onlineCount(alex.userId)).toBe(0);
  });

  for (const kind of ["channel", "task"] as const) {
    test(`revoking a ${kind} answer stream ends its response while the run finishes and persists`, async () => {
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const running = new Promise<void>(resolve => { entered = resolve; });
      let aborted = false;
      const agent = stubAgent(async input => {
        entered();
        await gate;
        aborted = input.signal.aborted;
        await input.sink.upsertMessage({ role: "assistant", kind: "text", text: "Finished after session ended." });
        return { status: "completed", error: null, usage: usage(10, 5), model: MODEL };
      });
      f = await createTestApp({}, { agent, setup: core => {
        const runs = new RunHost({ ...core, agent });
        const tasks = createTasks({ ...core, runs });
        return { runs, routes: tasks.routes };
      } });
      const alex = await signUp(f, "alex"), other = await login(f);
      let taskId: string | undefined;
      if (kind === "task") {
        taskId = (await f.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId,
          title: "Continue this task", prompt: "Continue", status: "needs_input" } })).id;
      }
      const path = taskId ? `/api/tasks/${taskId}/messages` : `/api/channels/${alex.mainChannelId}/messages`;
      const response = await f.app.request(path, { method: "POST", headers: alex.headers,
        body: JSON.stringify({ clientId: "m28-stream", text: "Continue" }) });
      expect(response.status).toBe(200);
      await running;
      expect((await revoke(f, (await row(f, alex.token)).id, other.headers)).status).toBe(204);
      await drains(response);
      release!();
      await f.runs.idle();
      expect(aborted).toBe(false);
      const run = await f.db.run.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
      expect(run.status).toBe("completed");
      expect(await f.db.message.count({ where: { userId: alex.userId, text: "Finished after session ended.",
        ...(taskId ? { taskId } : {}) } })).toBe(1);
    });
  }

  test("sweep uses one query and closes expired and directly deleted sessions, preserving live streams", async () => {
    f = await createTestApp();
    const alex = await signUp(f, "alex"), expired = await login(f), gone = await login(f);
    const activeStream = await f.app.request("/api/events", { headers: alex.headers });
    const expiredStream = await f.app.request("/api/events", { headers: expired.headers });
    const goneStream = await f.app.request("/api/events", { headers: gone.headers });
    await f.db.session.update({ where: { id: (await row(f, expired.token)).id }, data: { expiresAt: new Date() } });
    await f.db.session.delete({ where: { id: (await row(f, gone.token)).id } });
    let queries = 0;
    const db = f.db.$extends({ query: { session: { findMany({ args, query }) { queries++; return query(args); } } } }) as unknown as TestApp["db"];
    await f.connections.sweep(db);
    expect(queries).toBe(1);
    await Promise.all([drains(expiredStream), drains(goneStream)]);
    expect(f.events.onlineCount(alex.userId)).toBe(1);
    await activeStream.body!.cancel();
  });

  test("unregister, repeated close and registry stop release each callback once", async () => {
    f = await createTestApp();
    let closed = 0;
    const unregister = f.connections.register("unregistered", () => { closed++; });
    unregister(); unregister();
    f.connections.close(["unregistered"]);
    expect(closed).toBe(0);
    f.connections.register("first", () => { closed++; });
    f.connections.register("second", () => { closed++; });
    f.connections.start(); f.connections.start();
    f.connections.close(["first"]); f.connections.close(["first"]);
    expect(closed).toBe(1);
    f.connections.stop(); f.connections.stop();
    expect(closed).toBe(2);
  });

  test("startup awaits conversion after vault checks and before constructing the app or listener", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const vault = source.indexOf("await checkVaultKey(vaultKey, db)");
    const conversion = source.indexOf("await convertLegacySessions(db)");
    const app = source.indexOf("const app = createApp(");
    const listener = source.indexOf("Bun.serve({");
    expect(vault).toBeGreaterThan(0);
    expect(conversion).toBeGreaterThan(vault);
    expect(app).toBeGreaterThan(conversion);
    expect(listener).toBeGreaterThan(app);
  });
});
