// Make builds (L151): POST /api/artifacts stores a building Artifact and queues a `build` run; the
// model writes the page on Claude's computer (a fake Workspace here) and calls finish_build; the
// page gets the base, the chat gets "Claude made a page." + the card; progress is `artifact`
// events; failures say why. Plus the read routes, PATCH, DELETE, ownership and validation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactDetail, ArtifactList, ArtifactResponse, type ArtifactSummary } from "../../src/contract/artifacts.ts";
import { LlmError } from "../../src/llm/index.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { buildTurn, chat, json, lastEventId, ofType, PAGE, startMake, storedEvents, text, timeline, toolResults, type MakeApp } from "../make/harness.ts";
import { deferred } from "../tasks/harness.ts";

let m: MakeApp;
let sam: SignedIn;
beforeAll(async () => {
  m = await startMake();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
});
afterAll(() => m.fixture.cleanup());

const api = (path: string, init: RequestInit = {}) => m.fixture.app.request(path, init);
const create = (body: Record<string, unknown>, user: SignedIn = m.alex) => api("/api/artifacts", json(user, "POST", body));
const created = async (response: Response): Promise<ArtifactSummary> => {
  expect(response.status).toBe(200);
  return ArtifactResponse.parse(await response.json()).artifact;
};
const artifactEvents = async (id: string, after: number) =>
  ofType(await storedEvents(m.fixture, m.alex.userId, after), "artifact").filter((e) => e.payload.artifact.id === id);

/** A ready artifact straight in the database (for routes that don't need a build). */
export async function seed(app: MakeApp, data: Record<string, unknown> = {}) {
  return app.fixture.db.artifact.create({ data: {
    userId: app.alex.userId, channelId: app.alex.mainChannelId, type: "web_page", title: "Seeded", prompt: "A page",
    status: "ready", html: PAGE, ...data,
  } });
}

describe("POST /api/artifacts -> build -> finish_build", () => {
  test("builds the page on the computer, stores it with the base and its sources, posts the line and the card", async () => {
    const before = await lastEventId(m.fixture);
    m.llm.script("task", buildTurn(m, {
      step: "Reading your calendar", title: "Bike shop booking",
      sources: [{ name: "Calendar", app: "Google Calendar", detail: "next 2 weeks" }],
    }));
    const artifact = await created(await create({ type: "web_page", prompt: "A booking page for my bike shop\nwith opening hours", channelId: m.alex.mainChannelId }));
    expect(artifact.status).toBe("building");
    expect(artifact.title).toBe("A booking page for my bike shop");
    await m.runs.idle();

    const events = await artifactEvents(artifact.id, before);
    expect(events.map((e) => e.payload.buildStatus)).toEqual([
      { key: "build.starting_up" }, { key: "build.waking_workspace" }, { text: "Reading your calendar" }, null,
    ]);
    const done = events.at(-1)!.payload.artifact;
    expect([done.status, done.title, done.sourceCount, done.channelId]).toEqual(["ready", "Bike shop booking", 1, m.alex.mainChannelId]);

    // the build run: kind build, finish_build offered (never make_artifact), the page read back through the Workspace
    const run = await m.fixture.db.run.findFirst({ where: { userId: m.alex.userId, kind: "build" }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("completed");
    const sent = m.llm.sent("task").at(-1)!;
    expect(sent.tools?.map((t) => t.name)).toContain("finish_build");
    expect(sent.tools?.map((t) => t.name)).not.toContain("make_artifact");
    expect(sent.system).toContain("This is a Make build");
    expect(m.workspace.calls.some((c) => c.op === "read" && c.path === `artifacts/${artifact.id}/index.html` && c.runId === run!.id)).toBe(true);

    // the chat: "Claude made a page." then the card; the build's step text never becomes a bubble
    const thread = await timeline(m);
    const line = thread.findIndex((x) => x.kind === "system" && x.payload.phrase.key === "system.made_page");
    const card = thread.findIndex((x) => x.kind === "artifact" && x.payload.artifact.id === artifact.id);
    expect(line).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(line);
    expect(thread.some((x) => x.text.includes("Reading your calendar"))).toBe(false);
    // no status pill / typing dots on the chat header for a build
    const runEvents = (await storedEvents(m.fixture, m.alex.userId, before)).filter((e) => (e.type === "status" || e.type === "typing") && e.payload.runId === run!.id);
    expect(runEvents.every((e) => (e.type === "status" ? e.payload.status === null : e.type === "typing" && !e.payload.typing))).toBe(true);

    // the page: base injected, CSP that keeps it off the network
    const html = await api(`/api/artifacts/${artifact.id}/html`, { headers: m.alex.headers });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    const body = await html.text();
    expect(body).toContain("Book a tune-up");
    expect(body).toContain("<style data-duet-base>");

    const detail = ArtifactDetail.parse(await (await api(`/api/artifacts/${artifact.id}`, { headers: m.alex.headers })).json());
    expect(detail.prompt).toContain("A booking page for my bike shop");
    expect(detail.sources).toEqual([{ name: "Calendar", app: "Google Calendar", detail: "next 2 weeks" }]);
    const list = ArtifactList.parse(await (await api("/api/artifacts", { headers: m.alex.headers })).json());
    expect(list.artifacts.map((a) => a.id)).toContain(artifact.id);
  });

  test("a build runs on its own queue: chat in the same channel is answered while it is still running", async () => {
    const gate = deferred();
    const build = buildTurn(m);
    if (typeof build !== "function") throw new Error("buildTurn returns a function");
    m.llm.script("task", async (request) => {
      await gate.promise;
      return build(request);
    });
    m.llm.script("chat", [text("Sure, here you go.")]);
    const artifact = await created(await create({ type: "docs", prompt: "A one-page brief", channelId: m.alex.mainChannelId }));

    const reply = await chat(m, "Quick question while that builds", "c-queue-1");
    expect(reply.events.at(-1)?.payload).toMatchObject({ status: "completed" });
    const row = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(row.status).toBe("building");

    gate.resolve();
    await m.runs.idle();
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).status).toBe("ready");
  });

  test("finish_build answers fixable problems (CDN, wrong path) and the model retries", async () => {
    m.llm.script(
      "task",
      buildTurn(m, { data: {}, html: `<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head><body>x</body></html>` }),
      buildTurn(m, { data: {}, path: () => "/workspace/elsewhere/index.html" }),
      buildTurn(m, { data: { deals: 12, owners: 1 }, html: "<h1>Sales funnel</h1><p>Deals: 12; Owners: 1</p>", metrics: [{ label: "Deals", value: 12, unit: null }, { label: "Owners", value: 1, unit: null }] }),
    );
    const artifact = await created(await create({ type: "dashboard", prompt: "Sales funnel", channelId: m.alex.mainChannelId }));
    await m.runs.idle();
    const rows = m.llm.sent("task").slice(-2);
    expect(toolResults(rows[0])).toContain("self-contained");
    expect(toolResults(rows[1])).toContain(`/workspace/artifacts/${artifact.id}/index.html and pass that path`);
    const row = await m.fixture.db.artifact.findUnique({ where: { id: artifact.id } });
    expect(row?.status).toBe("ready");
    expect(row?.html).not.toContain("cdn.jsdelivr");
  });

  test("a build that never calls finish_build fails with a reason in the event and the thread", async () => {
    const before = await lastEventId(m.fixture);
    m.llm.script("task", [text("I couldn't get to the data.")]);
    const artifact = await created(await create({ type: "slides", prompt: "A pitch deck for the bakery", channelId: m.alex.mainChannelId }));
    await m.runs.idle();
    const last = (await artifactEvents(artifact.id, before)).at(-1)!;
    expect(last.payload.artifact.status).toBe("failed");
    expect(last.payload.buildStatus).toEqual({ key: "artifact.not_finished" });
    const lines = (await storedEvents(m.fixture, m.alex.userId, before)).flatMap((e) => (e.type === "message" && e.payload.message.kind === "system" ? [e.payload.message.payload.phrase.key] : []));
    expect(lines).toContain("artifact.not_finished");
    expect(lines).not.toContain("system.made_slides");
    expect((await api(`/api/artifacts/${artifact.id}/html`, { headers: m.alex.headers })).status).toBe(404);
  });

  test("a model error fails the build with the model's reason (one model_error card without retry, from the run host)", async () => {
    const before = await lastEventId(m.fixture);
    m.llm.script("task", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }));
    const artifact = await created(await create({ type: "docs", prompt: "A one-page brief", channelId: m.alex.mainChannelId }));
    await m.runs.idle();
    const last = (await artifactEvents(artifact.id, before)).at(-1)!;
    expect(last.payload.artifact.status).toBe("failed");
    expect(last.payload.buildStatus?.key).toBe("system.model_error");
    // M12: the card replaces the grey line; a build has its own "Try again", so the card can't retry.
    const cards = (await storedEvents(m.fixture, m.alex.userId, before)).flatMap((e) => (e.type === "message" && e.payload.message.kind === "model_error" ? [e.payload.message.payload] : []));
    expect(cards.filter((p) => p.phrase.key === "system.model_error")).toHaveLength(1);
    expect(cards[0]).toMatchObject({ retry: false, state: "open" });
  });

  test("without Claude's computer: 503 not_configured, nothing stored, no make tools in chat", async () => {
    m.workspace.configured = false;
    try {
      const count = await m.fixture.db.artifact.count();
      const res = await create({ type: "web_page", prompt: "A page", channelId: m.alex.mainChannelId });
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe("not_configured");
      expect(await m.fixture.db.artifact.count()).toBe(count);
      m.llm.script("chat", [text("Here you go.")]);
      const frames = await m.fixture.app.request(`/api/channels/${m.alex.mainChannelId}/messages`, json(m.alex, "POST", { text: "Write me a brief", clientId: "nc-1" }));
      await frames.text();
      const sent = m.llm.sent("chat").at(-1)!;
      expect(sent.tools?.map((t) => t.name) ?? []).not.toContain("make_artifact");
      expect(sent.system).toContain("isn't set up on this server");
    } finally {
      m.workspace.configured = true;
    }
  });
});

describe("artifact routes", () => {
  test("only the owner's artifacts; bodies validated", async () => {
    const row = await seed(m);
    for (const [method, path, body] of [
      ["GET", `/api/artifacts/${row.id}`, undefined], ["GET", `/api/artifacts/${row.id}/html`, undefined],
      ["PATCH", `/api/artifacts/${row.id}`, { title: "Mine" }], ["DELETE", `/api/artifacts/${row.id}`, undefined],
      ["POST", `/api/artifacts/${row.id}/refresh`, undefined], ["POST", `/api/artifacts/${row.id}/edit`, { prompt: "x" }],
    ] as const) {
      const res = await api(path, json(sam, method, body));
      expect(res.status).toBe(404);
    }
    const list = ArtifactList.parse(await (await api("/api/artifacts", { headers: sam.headers })).json());
    expect(list.artifacts).toEqual([]);
    // someone else's channel
    expect((await create({ type: "web_page", prompt: "x", channelId: m.alex.mainChannelId }, sam)).status).toBe(404);
    expect((await api("/api/artifacts")).status).toBe(401);
    for (const body of [{ type: "poster", prompt: "x", channelId: m.alex.mainChannelId }, { type: "docs", prompt: " ", channelId: m.alex.mainChannelId }, { type: "docs", prompt: "x", channelId: m.alex.mainChannelId, extra: 1 }]) {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("validation_failed");
    }
    for (const body of [{ refreshSchedule: { cadence: "weekly", hour: 5, minute: 30 } }, { refreshSchedule: { cadence: "daily", hour: 25, minute: 0 } }, { pinned: "yes" }, { favourite: true }]) {
      expect((await api(`/api/artifacts/${row.id}`, json(m.alex, "PATCH", body))).status).toBe(400);
    }
  });

  test("PATCH renames, pins one artifact to the tab bar at a time, sets the refresh schedule; updatedAt stays", async () => {
    const a = await seed(m, { title: "A" });
    const b = await seed(m, { title: "B" });
    const patch = async (id: string, body: unknown) => {
      const res = await api(`/api/artifacts/${id}`, json(m.alex, "PATCH", body));
      expect(res.status).toBe(200);
      return ArtifactResponse.parse(await res.json()).artifact;
    };
    expect((await patch(a.id, { pinnedToTabBar: true })).pinnedToTabBar).toBe(true);
    const pinnedB = await patch(b.id, { pinnedToTabBar: true, title: "Morning brief", refreshSchedule: { cadence: "daily", hour: 5, minute: 30 } });
    expect([pinnedB.title, pinnedB.pinnedToTabBar, pinnedB.refreshSchedule]).toEqual(["Morning brief", true, { cadence: "daily", hour: 5, minute: 30 }]);
    expect(pinnedB.updatedAt).toBe(b.updatedAt.toISOString());
    expect((await m.fixture.db.artifact.findUnique({ where: { id: a.id } }))?.pinnedToTabBar).toBe(false);
    expect((await patch(b.id, { refreshSchedule: null })).refreshSchedule).toBeNull();
  });

  test("DELETE removes it (204, then 404)", async () => {
    const row = await seed(m);
    expect((await api(`/api/artifacts/${row.id}`, json(m.alex, "DELETE"))).status).toBe(204);
    expect((await api(`/api/artifacts/${row.id}`, { headers: m.alex.headers })).status).toBe(404);
    expect((await api(`/api/artifacts/${row.id}`, json(m.alex, "DELETE"))).status).toBe(404);
  });
});
