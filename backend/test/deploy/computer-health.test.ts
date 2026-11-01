import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { probeComputer } from "../../src/computer/health.ts";
import { runHealthChecks } from "../../src/cli/health.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let reply: () => Response | Promise<Response> = () => Response.json({ status: "ok", browser: false });
const seen: { path: string; token: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push({ path: new URL(request.url).pathname, token: request.headers.get("x-openbot-computer-token") });
      return reply();
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("probeComputer", () => {
  test("ok when /health answers status ok, without sending a token", async () => {
    reply = () => Response.json({ status: "ok", browser: true, profile: {} });
    expect(await probeComputer(base)).toEqual({ ok: true, browser: true });
    expect(seen.at(-1)).toEqual({ path: "/health", token: null });
  });

  test("bad_status on a non-2xx answer", async () => {
    reply = () => new Response("nope", { status: 503 });
    expect(await probeComputer(base)).toEqual({ ok: false, reason: "bad_status", status: 503 });
  });

  test("bad_body when the answer is not the health shape", async () => {
    reply = () => Response.json({ status: "starting" });
    expect(await probeComputer(base)).toMatchObject({ ok: false, reason: "bad_body" });
  });

  test("timeout when it does not answer in time", async () => {
    reply = () => new Promise((resolve) => setTimeout(() => resolve(Response.json({ status: "ok" })), 500));
    expect(await probeComputer(base, { timeoutMs: 50 })).toEqual({ ok: false, reason: "timeout" });
  });

  test("unreachable when nothing listens", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    expect(await probeComputer(url, { timeoutMs: 1_000 })).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("runHealthChecks", () => {
  test("healthy when every check passes", async () => {
    const checks = await runHealthChecks({
      database: async () => true,
      api: async () => true,
      computer: async () => ({ ok: true, browser: false }),
    });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(["database", "api", "computer"]);
  });

  test("unhealthy when the computer is down, and a throwing check counts as failed", async () => {
    const checks = await runHealthChecks({
      database: async () => { throw new Error("SQLITE_BUSY"); },
      api: async () => true,
      computer: async () => ({ ok: false, reason: "unreachable" }),
    });
    expect(checks.find((c) => c.name === "database")).toMatchObject({ ok: false, detail: "not answering" });
    expect(checks.find((c) => c.name === "computer")).toMatchObject({ ok: false, detail: "unreachable" });
  });

  test("computer not configured is not a failure", async () => {
    const checks = await runHealthChecks({ database: async () => true, api: async () => true });
    expect(checks.find((c) => c.name === "computer")).toEqual({ name: "computer", ok: true, detail: "not configured" });
  });
});
