// M21 (#13): one Composio execution is bounded (EXECUTE_TIMEOUT_MS, below the agent's tool
// watchdog): the SDK gets an AbortSignal, and a call that doesn't answer in time comes back as
// "unavailable" with a note that the app may still have done it. A fake session stands in for the
// SDK (no network); the real SdkComposioGateway code runs.
import { describe, expect, test } from "bun:test";
import { EXECUTE_TIMEOUT_MS, SdkComposioGateway } from "../../src/composio/sdk.ts";
import { TOOL_LIMIT_MS } from "../../src/agent/runtime.ts";

type FakeSession = { execute: (slug: string, args: unknown, options?: unknown, request?: { signal?: AbortSignal }) => Promise<unknown> };

function gatewayWith(session: FakeSession, timeoutMs: number) {
  const gateway = new SdkComposioGateway("test-only-key", Date.now, timeoutMs);
  (gateway as unknown as { sessions: Map<string, { at: number; session: Promise<FakeSession> }> }).sessions.set("u1", { at: Date.now(), session: Promise.resolve(session) });
  return gateway;
}

describe("Composio execute timeout", () => {
  test("a hung execution is aborted at the bound and says it may still have happened", async () => {
    let signal: AbortSignal | undefined;
    const gateway = gatewayWith({
      execute: (_slug, _args, _options, request) => new Promise((_, reject) => {
        signal = request?.signal;
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "ComposioRequestCancelledError" })), { once: true });
      }),
    }, 50);
    const started = Date.now();
    const result = await gateway.execute("u1", "GMAIL_SEND_EMAIL", { to: "sam@example.com" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
    expect(result).toEqual({ ok: false, kind: "unavailable", error: "The app didn't answer in time. It may still have done it: check before trying again." });
  });

  test("an answer in time is unchanged", async () => {
    const gateway = gatewayWith({ execute: async () => ({ data: { id: "m1" }, resultType: "completed" }) }, 1000);
    expect(await gateway.execute("u1", "GMAIL_SEND_EMAIL", {})).toEqual({ ok: true, data: { id: "m1" } });
  });

  test("the bound stays below the watchdog's allowance per app call", () => {
    expect(EXECUTE_TIMEOUT_MS).toBeLessThan(TOOL_LIMIT_MS.appCall);
  });
});
