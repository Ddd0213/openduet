// M9 resource app sanitisation (contract §6): a resource keeps `app` only when it is a known app
// (connected / in the catalog, by display name or slug) or "Claude's computer"; anything else
// ("[CL]", "Claude", a file name) is null, so the app never draws a monogram for a non-app.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { TaskDetail } from "../../src/contract/tasks.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { call, RoleScriptedLlm, text } from "./harness.ts";

/** What connectors.catalog.knownApp answers in production: the display name of a known toolkit, else null. */
const CATALOG: Record<string, string> = { gmail: "Gmail", "google docs": "Google Docs", googledocs: "Google Docs" };
const knownApp = async (_userId: string, name: string) => CATALOG[name.trim().toLowerCase()] ?? null;

const llm = new RoleScriptedLlm();
let fixture: TestApp;
let tasks: Tasks;
let alex: SignedIn;
beforeAll(async () => {
  fixture = await createTestApp({}, {
    setup: (core) => {
      const providers: ToolProvider[] = [];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent });
      tasks = createTasks({ db: core.db, events: core.events, runs, apps: knownApp });
      providers.push(...tasks.providers);
      return { agent, runs, routes: tasks.routes };
    },
  });
  alex = await signUp(fixture, "alex");
});
afterAll(() => fixture.cleanup());

describe("resource app", () => {
  test("add_resource keeps a known app (as its display name) and Claude's computer; anything else is null", async () => {
    const resource = (title: string, app?: string) => call("add_resource", { title, type: "link", link: `https://example.com/${encodeURIComponent(title)}`, ...(app === undefined ? {} : { app }) });
    llm.script("task", [
      resource("Inbox thread", "Gmail"),
      resource("Agenda", "googledocs"),
      resource("Screenshot", "Claude’s computer"),
      resource("Bracketed", "[CL]"),
      resource("Self", "Claude"),
      resource("File name", "agenda.pdf"),
      resource("No app"),
    ], [text("Collected.")]);
    const created = await fixture.app.request("/api/tasks", {
      method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Collect the links", channelId: alex.mainChannelId }),
    });
    const { id } = TaskDetail.parse(await created.json());
    await fixture.runs.idle();
    const detail = TaskDetail.parse(await (await fixture.app.request(`/api/tasks/${id}`, { headers: alex.headers })).json());
    expect(detail.resources.map((r) => [r.title, r.app])).toEqual([
      ["Inbox thread", "Gmail"], ["Agenda", "Google Docs"], ["Screenshot", "OpenDuet's computer"],
      ["Bracketed", null], ["Self", null], ["File name", null], ["No app", null],
    ]);
  });

  test("resourceApp: without a catalog only Claude's computer passes; a failing lookup is null", async () => {
    const service = tasks.service;
    expect(await service.resourceApp(alex.userId, "  ")).toBeNull();
    expect(await service.resourceApp(alex.userId, undefined)).toBeNull();
    expect(await service.resourceApp(alex.userId, "claude's computer")).toBe("OpenDuet's computer");
    const bare = createTasks({ db: fixture.db, events: fixture.events, runs: fixture.runs });
    expect(await bare.service.resourceApp(alex.userId, "Gmail")).toBeNull();
    expect(await bare.service.resourceApp(alex.userId, "Claude's computer")).toBe("OpenDuet's computer");
    expect(await bare.service.resourceApp(alex.userId, "OpenDuet's computer")).toBe("OpenDuet's computer");
    expect(await bare.service.resourceApp(alex.userId, "Open Duet's computer")).toBe("OpenDuet's computer");
    expect(await bare.service.resourceApp(alex.userId, "open duet’s computer")).toBe("OpenDuet's computer");
    expect(await bare.service.resourceApp(alex.userId, "OpenDuet")).toBeNull();
    const broken = createTasks({ db: fixture.db, events: fixture.events, runs: fixture.runs, apps: async () => { throw new Error("catalog down"); } });
    expect(await broken.service.resourceApp(alex.userId, "Gmail")).toBeNull();
  });
});
