// One run at a time on OpenDuet's browser (ComputerService.claimBrowser): runs wait in order, a run
// keeps the browser until its turn ends (or sits idle past leaseIdleMs), and a claim from another
// thread makes the refs stale until the model sees the page again. The lease never touches the db,
// the events or the computer, so the service runs on stubs here.
import { describe, expect, test } from "bun:test";
import { ComputerService, type ComputerServiceDeps } from "../../src/computer/service.ts";

const service = (leaseIdleMs = 60_000) => new ComputerService({ db: {}, events: {}, client: null, audit: {}, leaseIdleMs } as unknown as ComputerServiceDeps);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Settled yet? (a pending promise reads as "pending") */
const peek = async <T>(p: Promise<T>): Promise<T | "pending"> => Promise.race([p, sleep(5).then(() => "pending" as const)]);

describe("browser lease", () => {
  test("a second run waits for the first one's turn to end; the first one's own calls never wait", async () => {
    const s = service();
    expect(await s.claimBrowser("run-a", "task:a", 1000)).toBe(true);
    s.doneWithBrowser("run-a");
    const b = s.claimBrowser("run-b", "task:b", 1000);
    expect(await peek(b)).toBe("pending");
    // run-a's next call in the same turn goes straight on.
    expect(await s.claimBrowser("run-a", "task:a", 1)).toBe(true);
    s.doneWithBrowser("run-a");
    expect(await peek(b)).toBe("pending");
    s.releaseBrowser("run-a");
    expect(await b).toBe(true);
  });

  test("waiters get it in order; a timed-out or aborted wait claims nothing", async () => {
    const s = service();
    expect(await s.claimBrowser("a", "x", 1000)).toBe(true);
    const order: string[] = [];
    const b = s.claimBrowser("b", "x", 1000).then((ok) => { order.push(`b:${ok}`); return ok; });
    const c = s.claimBrowser("c", "x", 30).then((ok) => { order.push(`c:${ok}`); return ok; });
    const controller = new AbortController();
    const d = s.claimBrowser("d", "x", 1000, controller.signal).then((ok) => { order.push(`d:${ok}`); return ok; });
    const e = s.claimBrowser("e", "x", 1000).then((ok) => { order.push(`e:${ok}`); return ok; });
    controller.abort();
    expect(await d).toBe(false);
    expect(await c).toBe(false);
    s.releaseBrowser("a");
    expect(await b).toBe(true);
    expect(await peek(e)).toBe("pending");
    s.releaseBrowser("b");
    expect(await e).toBe(true);
    expect(order).toEqual(["d:false", "c:false", "b:true", "e:true"]);
    expect(await s.claimBrowser("f", "x", 1, AbortSignal.abort())).toBe(false);
  });

  test("another thread's claim makes the refs stale until the page is shown; the same thread's next turn keeps them", async () => {
    const s = service();
    expect(await s.claimBrowser("chat-1", "channel:c", 100)).toBe(true);
    expect(s.refsStale).toBe(false);
    s.releaseBrowser("chat-1");
    // The channel's next turn: same thread, the refs it saw are still the page's.
    expect(await s.claimBrowser("chat-2", "channel:c", 100)).toBe(true);
    expect(s.refsStale).toBe(false);
    expect(s.needsSnapshot).toBe(false);
    s.releaseBrowser("chat-2");
    // A task: the chat's refs aren't its own.
    expect(await s.claimBrowser("task-1", "task:t", 100)).toBe(true);
    expect(s.refsStale).toBe(true);
    expect(s.needsSnapshot).toBe(true);
    s.releaseBrowser("task-1");
    // The task never looked: still stale for whoever comes next, the chat too.
    expect(await s.claimBrowser("chat-3", "channel:c", 100)).toBe(true);
    expect(s.refsStale).toBe(true);
    s.pageSeen();
    expect(s.refsStale).toBe(false);
    s.releaseBrowser("chat-3");
  });

  test("a run idle past leaseIdleMs gives the browser to the next; coming back, its refs are stale", async () => {
    const s = service(40);
    expect(await s.claimBrowser("a", "task:a", 100)).toBe(true);
    s.doneWithBrowser("a");
    const started = Date.now();
    expect(await s.claimBrowser("b", "task:a", 1000)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    s.pageSeen();
    s.doneWithBrowser("b");
    s.releaseBrowser("b");
    // Same thread, but a's turn went on without the browser and b changed the page meanwhile.
    expect(await s.claimBrowser("a", "task:a", 100)).toBe(true);
    expect(s.refsStale).toBe(true);
    s.releaseBrowser("a");
  });

  test("a call still running is never taken over, however long it takes", async () => {
    const s = service(10);
    expect(await s.claimBrowser("a", "x", 100)).toBe(true);
    // a's call hasn't finished (no doneWithBrowser): b gives up.
    expect(await s.claimBrowser("b", "x", 60)).toBe(false);
    s.doneWithBrowser("a");
    expect(await s.claimBrowser("b", "x", 200)).toBe(true);
  });

  test("a turn that ends drops its own waits; withBrowser claims, runs and lets go", async () => {
    const s = service();
    expect(await s.claimBrowser("a", "x", 100)).toBe(true);
    const b = s.claimBrowser("b", "y", 1000);
    s.releaseBrowser("b");
    expect(await b).toBe(false);
    expect(await s.withBrowser("card", "x", 20, async () => "ran")).toBeNull();
    s.releaseBrowser("a");
    expect(await s.withBrowser("card", "x", 20, async () => "ran")).toEqual({ done: "ran" });
    // Released after it ran (also when it throws).
    await expect(s.withBrowser("card", "x", 20, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await s.claimBrowser("c", "x", 20)).toBe(true);
  });

  test("stop ends every wait", async () => {
    const s = service();
    expect(await s.claimBrowser("a", "x", 100)).toBe(true);
    const b = s.claimBrowser("b", "x", 10_000);
    s.stop();
    expect(await b).toBe(false);
  });
});
