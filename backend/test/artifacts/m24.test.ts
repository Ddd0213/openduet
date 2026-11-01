import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactDetail, ArtifactResponse } from "../../src/contract/artifacts.ts";
import { ArtifactVersionList } from "../../src/contract/m24.ts";
import { stripChanged } from "../../src/make/base.ts";
import { buildTurn, call, chat, json, lastEventId, startMake, text, timeline, toolResults, type MakeApp } from "../make/harness.ts";
import { deferred } from "../tasks/harness.ts";
import { signUp } from "../helpers/session.ts";
import { installSourceTool, sourceRead } from "./source-harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); installSourceTool(m); });
afterAll(() => m.fixture.cleanup());
const page = (n: number) => `<h1>Pipeline</h1><p>Open deals: ${n}</p><p>Owners: 1</p>`;
const sources = [{ name: "Deals", app: "HubSpot", detail: "open deals" }];
const metrics = (n: number) => [{ label: "Open", value: n, unit: null }, { label: "Owners", value: 1, unit: null }];
const rows = (id: string) => m.fixture.db.artifactVersion.findMany({ where: { artifactId: id }, orderBy: { createdAt: "desc" } });
const current = (id: string) => m.fixture.db.artifact.findUniqueOrThrow({ where: { id } });
const api = (id: string, suffix: string, body?: unknown) => m.fixture.app.request(`/api/artifacts/${id}${suffix}`, json(m.alex, body === undefined ? "GET" : "POST", body));
async function create(n = 12, startedBy: "user" | "assistant" = "user") {
  m.llm.script("task", buildTurn(m, { data: { open: n, owners: 1 }, html: page(n), sources, metrics: metrics(n) }));
  const row = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "dashboard", prompt: "My pipeline", startedBy });
  await m.runs.idle();
  expect((await current(row.id)).status).toBe("ready");
  return row.id;
}
async function edit(id: string, n: number, startedBy: "user" | "assistant" = "user", prompt = `Use ${n}`) {
  m.llm.script("task", buildTurn(m, { html: page(n).replace("<p>", "<p data-duet-changed>"), sources, metrics: metrics(n) }));
  await m.artifacts.service.edit({ userId: m.alex.userId, id, prompt, startedBy });
  await m.runs.idle();
}

describe("M24 saved versions and restore routes", () => {
  test("create/edit snapshots have display attribution independent of trust, prompts and matching metadata", async () => {
    const id = await create(12, "assistant");
    await edit(id, 15, "user");
    const saved = await rows(id);
    expect(saved.map(v => [v.by, v.reason, v.prompt])).toEqual([["user", "edit", "Use 15"], ["assistant", "create", "My pipeline"]]);
    expect((await current(id)).startedBy).toBe("assistant");
    expect(saved[0]!.html).toBe((await current(id)).html);
    expect(JSON.parse(saved[0]!.metrics!)).toEqual(metrics(15));
    expect(JSON.parse(saved[0]!.sources)).toEqual(sources);
    const listed = ArtifactVersionList.parse(await (await api(id, "/versions")).json());
    expect(listed.versions.map(v => v.id)).toEqual(saved.map(v => v.id));
    // M27 adds dataUpdates (0 here); the list still never carries the page or the data.
    expect(Object.keys(listed.versions[0]!)).toEqual(["id", "artifactId", "by", "reason", "prompt", "createdAt", "dataUpdates"]);
  });

  test("restore strips glow, restores card metrics/sources, preserves rename/pins/schedule, and undo toggles", async () => {
    const id = await create();
    await edit(id, 15, "assistant");
    await m.artifacts.service.update(m.alex.userId, id, { title: "Renamed", pinned: true, pinnedToTabBar: true, refreshSchedule: { cadence: "daily", hour: 8, minute: 0 } });
    const before = await current(id), saved = await rows(id), event = await lastEventId(m.fixture);
    const response = await api(id, "/restore", { versionId: saved[1]!.id });
    expect(response.status).toBe(200);
    expect(ArtifactResponse.parse(await response.json()).artifact.title).toBe("Renamed");
    const restored = await current(id);
    expect(restored.html).toBe(stripChanged(saved[1]!.html));
    expect([restored.pinnedAt, restored.pinnedToTabBar, restored.refreshSchedule]).toEqual([before.pinnedAt, true, before.refreshSchedule]);
    expect(restored.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect((await rows(id))[0]).toMatchObject({ by: "user", reason: "restore", prompt: null });
    expect(await m.fixture.db.event.count({ where: { id: { gt: event }, type: "artifact" } })).toBe(1);
    const card = (await timeline(m)).find(x => x.kind === "artifact" && x.payload.artifact.id === id);
    expect(card?.kind === "artifact" && card.payload.metrics).toEqual(metrics(12));
    await api(id, "/restore", { versionId: (await rows(id))[1]!.id });
    expect((await current(id)).html).toBe(stripChanged(saved[0]!.html));
    await api(id, "/restore", { versionId: (await rows(id))[1]!.id });
    expect((await current(id)).html).toBe(stripChanged(saved[1]!.html));
  });

  test("newest restore is no-op and concurrent double-tap writes once", async () => {
    const id = await create();
    const first = (await rows(id))[0]!;
    const before = await current(id), event = await lastEventId(m.fixture);
    expect((await api(id, "/restore", { versionId: first.id })).status).toBe(200);
    expect(await current(id)).toEqual(before);
    expect(await lastEventId(m.fixture)).toBe(event);
    await edit(id, 15);
    const restoreEvent = await lastEventId(m.fixture);
    const responses = await Promise.all([api(id, "/restore", { versionId: first.id }), api(id, "/restore", { versionId: first.id })]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(await rows(id)).toHaveLength(3);
    expect(await m.fixture.db.event.count({ where: { id: { gt: restoreEvent }, type: "artifact" } })).toBe(1);
  });

  test("ten versions kept, oldest dropped, version ownership/auth/body validation and delete cascade", async () => {
    const id = await create();
    const first = (await rows(id))[0]!.id;
    for (let n = 20; n < 30; n++) await edit(id, n);
    expect(await rows(id)).toHaveLength(10);
    expect((await api(id, "/restore", { versionId: first })).status).toBe(404);
    const other = await create(40), foreign = (await rows(other))[0]!.id;
    expect((await api(id, "/restore", { versionId: foreign })).status).toBe(404);
    expect((await api(id, "/restore", { versionId: foreign, extra: true })).status).toBe(400);
    expect((await api(id, "/restore", {})).status).toBe(400);
    const sam = await signUp(m.fixture, "versions_sam");
    expect((await m.fixture.app.request(`/api/artifacts/${id}/versions`, json(sam, "GET"))).status).toBe(404);
    expect((await m.fixture.app.request(`/api/artifacts/${id}/restore`, json(sam, "POST", { versionId: foreign }))).status).toBe(404);
    expect((await m.fixture.app.request(`/api/artifacts/${id}/versions`)).status).toBe(401);
    expect((await m.fixture.app.request(`/api/artifacts/${id}/restore`, { method: "POST" })).status).toBe(401);
    await m.artifacts.service.remove(m.alex.userId, id);
    expect(await rows(id)).toHaveLength(0);
  });

  test("refresh needs this build's read, keeps old page on failure; unchanged refresh uses no slot", async () => {
    const id = await create();
    const before = await current(id);
    // This M24 regression covers a legacy dashboard's whole-page refresh.
    await m.fixture.db.artifact.update({ where: { id }, data: { data: null, dataUpdatedAt: null, updatedAt: before.updatedAt } });
    await m.fixture.db.artifactVersion.updateMany({ where: { artifactId: id }, data: { data: null } });
    m.llm.script("task", buildTurn(m, { html: page(15) }), buildTurn(m, { html: page(16) }), buildTurn(m, { html: page(17) }), [text("No access.")]);
    await m.artifacts.service.refresh(m.alex.userId, id);
    await m.runs.idle();
    expect((await current(id)).html).toBe(before.html);
    expect(await rows(id)).toHaveLength(1);
    expect(toolResults(m.llm.sent("task").at(-1))).toContain("no declared source was successfully read");
    m.llm.script("task", [sourceRead()], buildTurn(m, { html: page(12) }));
    await m.artifacts.service.refresh(m.alex.userId, id, "schedule");
    await m.runs.idle();
    expect(await rows(id)).toHaveLength(1);
    m.llm.script("task", [sourceRead()], buildTurn(m, { html: page(18), metrics: metrics(18) }));
    await m.artifacts.service.refresh(m.alex.userId, id, "schedule");
    await m.runs.idle();
    expect((await rows(id))[0]).toMatchObject({ reason: "refresh", by: "assistant", prompt: null });
    // Successful previous refresh is not evidence for the next run.
    m.llm.script("task", buildTurn(m, { html: page(19) }));
    await m.artifacts.service.refresh(m.alex.userId, id);
    await m.runs.idle();
    expect(await rows(id)).toHaveLength(2);
  });

  test("versions empty before first save; failed first build and failed edit save nothing; Retry is user/create", async () => {
    const gate = deferred();
    m.llm.script("task", async () => { await gate.promise; return [text("No page.")]; });
    const artifact = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "A brief", startedBy: "assistant" });
    expect(ArtifactVersionList.parse(await (await api(artifact.id, "/versions")).json()).versions).toEqual([]);
    gate.resolve(); await m.runs.idle();
    expect(await rows(artifact.id)).toHaveLength(0);
    m.llm.script("task", buildTurn(m));
    await m.artifacts.service.refresh(m.alex.userId, artifact.id);
    await m.runs.idle();
    expect((await rows(artifact.id))[0]).toMatchObject({ by: "user", reason: "create", prompt: "A brief" });
    m.llm.script("task", [text("No edit.")]);
    await m.artifacts.service.edit({ userId: m.alex.userId, id: artifact.id, prompt: "Add more" });
    await m.runs.idle();
    expect(await rows(artifact.id)).toHaveLength(1);
  });

  test("restore conflicts during builds/edits/refreshes, including a queued second edit; reads keep saved text", async () => {
    const id = await create(), versionId = (await rows(id))[0]!.id;
    for (const mode of ["edit", "refresh"] as const) {
      const gate = deferred();
      m.llm.script("task", async () => { await gate.promise; return [text("Not finished.")]; });
      if (mode === "edit") {
        await m.artifacts.service.edit({ userId: m.alex.userId, id, prompt: "First" });
        m.llm.script("task", [text("Not finished either.")]);
        await m.artifacts.service.edit({ userId: m.alex.userId, id, prompt: "Second" });
      } else await m.artifacts.service.refresh(m.alex.userId, id);
      expect((await api(id, "/restore", { versionId })).status).toBe(409);
      expect((await m.artifacts.service.read(m.alex.userId, id))?.text).toContain("Open deals: 12");
      gate.resolve(); await m.runs.idle();
    }
  });

  test("lastOpenedAt changes only on detail GET; keeps content time and emits no event", async () => {
    const id = await create(), before = await current(id);
    await api(id, "/html"); await api(id, "/versions"); await m.artifacts.service.list(m.alex.userId); await m.artifacts.service.read(m.alex.userId, id);
    expect((await current(id)).lastOpenedAt).toBeNull();
    const event = await lastEventId(m.fixture);
    m.clock.now = new Date("2031-01-01T00:00:00Z");
    try {
      const detail = ArtifactDetail.parse(await (await api(id, "")).json());
      expect(detail.lastOpenedAt).toBe(m.clock.now.toISOString());
      expect(detail.updatedAt).toBe(before.updatedAt.toISOString());
      expect(await lastEventId(m.fixture)).toBe(event);
      expect((await m.artifacts.service.list(m.alex.userId)).find(a => a.id === id)?.lastOpenedAt).toBe(detail.lastOpenedAt);
    } finally { m.clock.now = null; }
  });

  test("queued edits joined with blank lines; version prompt capped to 8000", async () => {
    const gate = deferred();
    const build = buildTurn(m);
    m.llm.script("task", async request => { await gate.promise; return typeof build === "function" ? build(request) : build; }, buildTurn(m, { html: "<h1>Changed</h1>" }));
    const a = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "A brief" });
    await m.artifacts.service.requestEdit({ userId: m.alex.userId, id: a.id, prompt: "First" });
    await m.artifacts.service.requestEdit({ userId: m.alex.userId, id: a.id, prompt: "Second".repeat(1500) });
    gate.resolve(); await m.runs.idle();
    const saved = await rows(a.id);
    expect(saved).toHaveLength(2);
    expect(saved[0]!.prompt?.startsWith("First\n\nSecond")).toBe(true);
    expect(saved[0]!.prompt).toHaveLength(8000);
  });
});

describe("M24 production lint and chat type wiring", () => {
  test("finish_build rejects all quality errors, scripted repair saves exactly once", async () => {
    const before = m.llm.sent("task").length;
    m.llm.script("task", buildTurn(m, { html: '<h1>Example</h1><div style="width:900px">lorem ipsum</div>' }), buildTurn(m, { html: "<h1>Repaired</h1><p>Actual content</p>" }));
    const a = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Make a page" });
    await m.runs.idle();
    const repair = toolResults(m.llm.sent("task")[before + 1]);
    expect(repair).toContain("layout.fixed_width"); expect(repair).toContain("content.lorem_ipsum");
    expect((await current(a.id)).html).toContain("Repaired");
    expect(await rows(a.id)).toHaveLength(1);
  });

  test("third quality failure saves with warnings; a new job starts with a fresh budget", async () => {
    const bad = () => buildTurn(m, { html: "<h1>Lorem ipsum</h1>" });
    m.llm.script("task", bad(), bad(), bad());
    const a = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Make a page" });
    await m.runs.idle(); expect(await rows(a.id)).toHaveLength(1);
    m.llm.script("task", bad());
    const b = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Make another" });
    await m.runs.idle(); expect(await rows(b.id)).toHaveLength(0);
  });

  test("security refusals never spend the quality budget or turn into saves", async () => {
    const bad = () => buildTurn(m, { html: '<h1>Unsafe</h1><script src="https://example.com/app.js"></script>' });
    m.llm.script("task", bad(), bad(), bad(), bad());
    const a = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Make a page" });
    await m.runs.idle(); expect(await rows(a.id)).toHaveLength(0);
  });

  for (const type of ["design", "design_system"] as const) test(`chat make_artifact registers and builds ${type}`, async () => {
    m.llm.script("chat", [call("make_artifact", { type, title: type, prompt: "A brand identity" })], [text("On it.")]);
    m.llm.script("task", buildTurn(m, { html: `<h1>${type}</h1>` }));
    await chat(m, "Design the brand", `m24-${type}`); await m.runs.idle();
    const row = await m.fixture.db.artifact.findFirstOrThrow({ where: { title: type } });
    expect(row).toMatchObject({ type, status: "ready", startedBy: "assistant" });
    expect((await rows(row.id))[0]).toMatchObject({ by: "assistant", reason: "create" });
  });
});

test("page and snapshot roll back together when the version insert fails", async () => {
  const id = await create(), before = await current(id);
  await m.fixture.db.$executeRawUnsafe(`CREATE TRIGGER m24_fail_version BEFORE INSERT ON ArtifactVersion WHEN NEW.artifactId = '${id}' BEGIN SELECT RAISE(ABORT, 'test-only version failure'); END`);
  try {
    await edit(id, 99);
    expect((await current(id)).html).toBe(before.html);
    expect(await rows(id)).toHaveLength(1);
  } finally { await m.fixture.db.$executeRawUnsafe("DROP TRIGGER m24_fail_version"); }
});

test("a cancelled finish waiting on workspace I/O cannot save late", async () => {
  const entered = deferred(), release = deferred();
  const read = m.workspace.readFile.bind(m.workspace);
  m.workspace.readFile = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
  m.llm.script("task", buildTurn(m));
  const artifact = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Cancel this page" });
  try {
    await entered.promise;
    await m.runs.cancel({ userId: m.alex.userId, channelId: m.alex.mainChannelId }, 0);
    release.resolve(); await m.runs.idle();
    await Bun.sleep(30); // the abandoned read's continuation must also have seen the aborted signal
    expect(await rows(artifact.id)).toHaveLength(0);
    expect((await current(artifact.id)).html).toBe("");
  } finally { release.resolve(); m.workspace.readFile = read; }
});

test("restoring a historical version without metrics keeps card numbers, but restores its sources", async () => {
  const id = await create(), first = (await rows(id))[0]!;
  await m.fixture.db.artifactVersion.update({ where: { id: first.id }, data: { metrics: null } });
  m.llm.script("task", buildTurn(m, { html: page(15), metrics: metrics(15), sources: [{ name: "Other", app: null, detail: "file.txt" }] }));
  await m.artifacts.service.edit({ userId: m.alex.userId, id, prompt: "Use other data" });
  await m.runs.idle();
  await api(id, "/restore", { versionId: first.id });
  expect(JSON.parse((await current(id)).sources)).toEqual(sources);
  const card = (await timeline(m)).find(x => x.kind === "artifact" && x.payload.artifact.id === id);
  expect(card?.kind === "artifact" && card.payload.metrics).toEqual(metrics(15));
  expect(JSON.parse((await rows(id))[0]!.metrics!)).toEqual(metrics(15));
});
