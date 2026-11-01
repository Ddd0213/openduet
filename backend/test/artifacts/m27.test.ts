import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { makeProvider } from "../../src/artifacts/provider.ts";
import { saveDataVersion, saveVersion, VERSION_ORDER } from "../../src/artifacts/versions.ts";
import { toSummary } from "../../src/artifacts/serialize.ts";
import { ArtifactDataResponse, DATA_UPDATES_PER_MINUTE, UpdateArtifactDataInput, UpdateArtifactDataResult } from "../../src/contract/m27.ts";
import type { TurnInput } from "../../src/agent/types.ts";
import { describeCall } from "../../src/runs/describe.ts";
import type { ToolUseBlock } from "../../src/llm/index.ts";
import { Redactor } from "../../src/runs/redact.ts";
import { metricWarnings } from "../../src/artifacts/checks.ts";
import { buildTurn, call, chat, json, lastEventId, startMake, text, toolResults, type MakeApp } from "../make/harness.ts";
import { deferred } from "../tasks/harness.ts";
import { signUp } from "../helpers/session.ts";
import { installSourceTool, sourceRead } from "./source-harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); installSourceTool(m); });
afterAll(() => m.fixture.cleanup());
const current = (id: string) => m.fixture.db.artifact.findUniqueOrThrow({ where: { id } });
const versions = (id: string) => m.fixture.db.artifactVersion.findMany({ where: { artifactId: id }, orderBy: VERSION_ORDER });
const metrics = [{ label: "Total", value: 8, unit: null }, { label: "AI", value: 3, unit: null }];
const seed = (extra: Record<string, unknown> = {}) => m.fixture.db.artifact.create({ data: { userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "dashboard", title: "Links", prompt: "Links", status: "ready", html: "<h1>Links</h1>", data: '{"total":0,"categories":[],"recent":[]}', dataVersion: 1, ...extra } });
const update = async (id: string, input: Record<string, unknown> = {}, runId = "run-a", userId = m.alex.userId) => UpdateArtifactDataResult.parse(await m.artifacts.service.updateData(userId, runId, UpdateArtifactDataInput.parse({ artifactId: id, ops: [{ op: "increment", path: ["total"] }], ...input })));
const savePage = (row: Awaited<ReturnType<typeof seed>>, now: Date) => m.fixture.db.$transaction(tx => saveVersion(tx, row, { by: "user", reason: "edit", prompt: null, metrics: null, now }));
const toolCall = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: "call-test", name, input });

describe("M27 update service", () => {
  test("refusal precedence, ownership and every non-rate refusal parse the contract; none writes", async () => {
    expect(await update("missing")).toMatchObject({ code: "not_found" });
    const foreign = await seed();
    expect(await update(foreign.id, {}, "run-a", "foreign")).toMatchObject({ code: "not_found" });
    for (const [extra, code] of [[{ type: "docs", status: "building", data: null }, "not_dashboard"], [{ status: "building", data: null }, "not_ready"], [{ html: "" }, "not_ready"], [{ data: null }, "no_data"]] as const) {
      const row = await seed(extra);
      expect(await update(row.id, { expectedVersion: 9 })).toMatchObject({ code });
      expect(await current(row.id)).toEqual(row);
    }
    const row = await seed();
    for (const [input, code] of [[{ expectedVersion: 9 }, "version_conflict"], [{ ops: [{ op: "append", path: ["total"], value: 1 }] }, "invalid_op"], [{ ops: [{ op: "set", path: ["x"], value: "x".repeat(65536) }] }, "too_large"], [{ ops: [{ op: "set", path: ["x"], value: JSON.parse('{"constructor":1}') }] }, "invalid_data"]] as const) {
      expect(await update(row.id, input)).toMatchObject({ code, dataVersion: 1 });
      expect(await current(row.id)).toEqual(row);
      expect(await versions(row.id)).toHaveLength(0);
    }
  });

  test("saved data preserves page time, emits content time/version and synchronizes card metrics", async () => {
    const row = await seed();
    await m.fixture.db.message.create({ data: { userId: m.alex.userId, channelId: m.alex.mainChannelId, role: "assistant", kind: "artifact", text: "", payload: JSON.stringify({ artifact: toSummary(row), metrics: [] }) } });
    const before = await lastEventId(m.fixture);
    expect(await update(row.id, { ops: null, data: { total: 8, ai: 3 }, metrics })).toMatchObject({ status: "updated", dataVersion: 2 });
    const saved = await current(row.id);
    expect(saved.html).toBe(row.html); expect(saved.updatedAt).toEqual(row.updatedAt);
    expect(saved.dataUpdatedAt!.getTime()).toBeGreaterThan(row.updatedAt.getTime());
    const event = await m.fixture.db.event.findFirstOrThrow({ where: { id: { gt: before }, type: "artifact" } });
    expect(JSON.parse(event.payload)).toMatchObject({ artifact: { pageUpdatedAt: row.updatedAt.toISOString(), dataVersion: 2, updatedAt: saved.dataUpdatedAt!.toISOString() } });
    const card = await m.fixture.db.message.findFirstOrThrow({ where: { kind: "artifact", payload: { contains: row.id } } });
    expect(JSON.parse(card.payload).metrics).toEqual(metrics);
  });

  test("no-ops don't write/events/rate; the fake-clock 20/minute window counts only successful saves", async () => {
    const row = await seed(); m.clock.now = new Date("2035-01-01T00:00:00Z");
    try {
      for (let n = 0; n < DATA_UPDATES_PER_MINUTE; n++) expect(await update(row.id)).toMatchObject({ status: "updated" });
      const before = await current(row.id), event = await lastEventId(m.fixture);
      expect(await update(row.id, { ops: [{ op: "increment", path: ["total"], by: 0 }] })).toMatchObject({ status: "unchanged" });
      expect(await current(row.id)).toEqual(before); expect(await lastEventId(m.fixture)).toBe(event);
      expect(await update(row.id)).toMatchObject({ code: "too_frequent", retryAfterMs: 60000 });
      m.clock.now = new Date("2035-01-01T00:00:59Z");
      expect(await update(row.id)).toMatchObject({ retryAfterMs: 1000 });
      m.clock.now = new Date("2035-01-01T00:01:00Z");
      expect(await update(row.id)).toMatchObject({ status: "updated" });
    } finally { m.clock.now = null; }
  });

  test("a failed version insert rolls back data and does not consume a rate slot", async () => {
    const row = await seed();
    await m.fixture.db.$executeRawUnsafe(`CREATE TRIGGER m27_fail BEFORE INSERT ON ArtifactVersion WHEN NEW.artifactId='${row.id}' BEGIN SELECT RAISE(ABORT,'test'); END`);
    try { await expect(update(row.id)).rejects.toThrow(); expect(await current(row.id)).toEqual(row); }
    finally { await m.fixture.db.$executeRawUnsafe("DROP TRIGGER m27_fail"); }
    expect(await update(row.id)).toMatchObject({ status: "updated", dataVersion: 2 });
  });

  test("concurrent expected versions serialize with only one winner", async () => {
    const row = await seed();
    const results = await Promise.all([update(row.id, { expectedVersion: 1 }), update(row.id, { expectedVersion: 1 })]);
    expect(results[0]).toMatchObject({ status: "updated" }); expect(results[1]).toMatchObject({ code: "version_conflict", dataVersion: 2 });
  });

  test("/data is authenticated, foreign 404, own/null exact JSON; no open or event", async () => {
    const row = await seed(), old = await seed({ data: null, dataVersion: 0 }), sam = await signUp(m.fixture, "m27_sam");
    const event = await lastEventId(m.fixture);
    for (const a of [row, old]) {
      const response = await m.fixture.app.request(`/api/artifacts/${a.id}/data`, json(m.alex, "GET"));
      expect(response.status).toBe(200); expect(ArtifactDataResponse.parse(await response.json())).toMatchObject({ json: a.data, dataVersion: a.dataVersion });
      expect((await current(a.id)).lastOpenedAt).toBeNull();
    }
    expect((await m.fixture.app.request(`/api/artifacts/${row.id}/data`, json(sam, "GET"))).status).toBe(404);
    expect((await m.fixture.app.request(`/api/artifacts/${row.id}/data`)).status).toBe(401);
    expect(await lastEventId(m.fixture)).toBe(event);
  });

  test("read exposes parsed data/version; recent marks liveData without leaking data", async () => {
    const row = await seed({ data: '{"total":0,"private":"do not leak"}' });
    expect(await m.artifacts.service.read(m.alex.userId, row.id)).toMatchObject({ dataVersion: 1, data: { total: 0, private: "do not leak" } });
    const recent = await m.artifacts.service.recent(m.alex.userId);
    expect(recent.find(a => a.id === row.id)?.liveData).toBe(true); expect(JSON.stringify(recent)).not.toContain("do not leak");
  });
});

describe("M27 history", () => {
  test("same run <10min merges, new run or exactly 10min creates; keeps first timestamp", async () => {
    const row = await seed(); m.clock.now = new Date("2034-01-01T00:00:00Z");
    try {
      await update(row.id); const first = (await versions(row.id))[0]!;
      m.clock.now = new Date("2034-01-01T00:09:59Z"); await update(row.id);
      expect(await versions(row.id)).toHaveLength(1); expect((await versions(row.id))[0]).toMatchObject({ dataUpdates: 2, createdAt: first.createdAt });
      m.clock.now = new Date("2034-01-01T00:10:00Z"); await update(row.id); expect(await versions(row.id)).toHaveLength(2);
      await update(row.id, {}, "run-b"); expect(await versions(row.id)).toHaveLength(3);
    } finally { m.clock.now = null; }
  });

  test("at most 4 data rows, at most 10 total; different data defeats page dedupe", async () => {
    const row = await seed();
    for (let n = 0; n < 7; n++) await savePage({ ...row, html: `<h1>Page ${n}</h1>` }, new Date(Date.now() + n));
    for (let n = 0; n < 6; n++) await m.fixture.db.$transaction(tx => saveDataVersion(tx, { ...row, data: JSON.stringify({ total: n }) }, { runId: `run-${n}`, metrics: null, now: new Date(Date.now() + 20 + n) }));
    const saved = await versions(row.id); expect(saved).toHaveLength(10); expect(saved.filter(v => v.reason === "data")).toHaveLength(4);
    const latest = saved[0]!;
    await savePage({ ...row, html: latest.html, data: '{"total":99}' }, new Date());
    expect((await versions(row.id))[0]).toMatchObject({ reason: "edit", data: '{"total":99}' });
    const count = await m.fixture.db.artifactVersion.count({ where: { artifactId: row.id } });
    await savePage({ ...row, html: latest.html, data: '{"total":99}', sources: '[{"name":"new","app":null,"detail":""}]' }, new Date());
    expect(await m.fixture.db.artifactVersion.count({ where: { artifactId: row.id } })).toBe(count);
  });

  test("restore data-only keeps page time, page restore moves it, pre-M27 clears data; repeat no-op", async () => {
    const row = await seed(); await savePage(row, new Date()); const original = (await versions(row.id))[0]!;
    await update(row.id, {}, "r1"); const data = (await versions(row.id))[0]!;
    await update(row.id, {}, "r2");
    const before = await current(row.id);
    await m.artifacts.service.restore(m.alex.userId, row.id, data.id);
    const restored = await current(row.id); expect(restored.updatedAt).toEqual(before.updatedAt); expect(restored.dataVersion).toBe(before.dataVersion + 1); expect(restored.data).toBe(data.data);
    const event = await lastEventId(m.fixture); await m.artifacts.service.restore(m.alex.userId, row.id, data.id); expect(await lastEventId(m.fixture)).toBe(event);
    await m.fixture.db.artifactVersion.update({ where: { id: original.id }, data: { html: "<h1>Old page</h1>", data: null } });
    await m.artifacts.service.restore(m.alex.userId, row.id, original.id);
    const old = await current(row.id); expect(old.updatedAt.getTime()).toBeGreaterThan(restored.updatedAt.getTime()); expect(old.data).toBeNull(); expect(old.dataVersion).toBe(restored.dataVersion + 1);
    expect(await update(row.id)).toMatchObject({ code: "no_data" });
  });
});

describe("M27 builds and offering", () => {
  test("tool is chat/task/routine only, without computer too; execute guard and JSON Schema object", async () => {
    const provider = makeProvider(m.artifacts.service);
    for (const configured of [true, false]) {
      m.workspace.configured = configured;
      try { for (const kind of ["chat", "task", "routine", "brief", "checkin", "scan", "build"] as const) {
        const input = { kind, runId: "not-a-build", userId: m.alex.userId } as TurnInput;
        const tools = await provider.tools(input), expected = ["chat", "task", "routine"].includes(kind);
        expect(tools.some(t => t.name === "update_artifact_data")).toBe(expected);
        if (!expected) expect((await provider.execute(toolCall("update_artifact_data", {}), input))?.result.isError).toBe(true);
      } } finally { m.workspace.configured = true; }
    }
    const schema = z.toJSONSchema(UpdateArtifactDataInput, { io: "input" });
    expect(JSON.stringify(schema.properties?.data)).toContain('"type":"object"');
    expect(provider.status?.(toolCall("update_artifact_data", {}))).toBe("working");
  });

  test("chat update runs through provider and read's untrusted envelope includes data", async () => {
    const row = await seed();
    m.llm.script("chat", [call("read_artifact", { artifactId: row.id }), call("update_artifact_data", { artifactId: row.id, expectedVersion: 1, ops: [{ op: "increment", path: ["total"], by: 8 }] })], [text("Done.")]);
    await chat(m, "Update links", "m27-chat");
    expect((await current(row.id)).dataVersion).toBe(2);
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("dataVersion");
    const view = describeCall(toolCall("update_artifact_data", { ops: [{ op: "increment", path: ["total"] }, { op: "remove", path: ["recent"] }] }), new Redactor([]));
    expect(view.title.key).toBe("run.step.artifact_data"); expect(view.detail).toBe("total, recent");
    expect(describeCall(toolCall("update_artifact_data", { data: {} }), new Redactor([])).detail).toBe("");
  });

  test("dashboard create requires data without spending quality retries; other types reject it", async () => {
    m.llm.script("task", buildTurn(m, { html: "<h1>Links</h1>" }), buildTurn(m, { html: "<h1>Links</h1>", data: { total: 0 }, metrics: [{ label: "Total", value: 0, unit: null }, { label: "AI", value: 0, unit: null }] }));
    const a = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "dashboard", prompt: "Links" });
    await m.runs.idle(); expect((await current(a.id)).dataVersion).toBe(1); expect(toolResults(m.llm.sent("task").at(-1))).toContain("Pass data:");
    m.llm.script("task", buildTurn(m, { data: {} }));
    const doc = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Doc" });
    await m.runs.idle(); expect((await current(doc.id)).status).toBe("failed"); expect(await versions(doc.id)).toHaveLength(0);
  });

  test("edit keeps data when omitted, replaces when passed", async () => {
    const row = await seed();
    for (const data of [undefined, { total: 5 }]) {
      m.llm.script("task", buildTurn(m, { html: "<h1>New layout</h1>", data }));
      await m.artifacts.service.edit({ userId: m.alex.userId, id: row.id, prompt: "Change layout" }); await m.runs.idle();
      expect((await current(row.id)).data).toBe(data ? JSON.stringify(data) : row.data);
    }
    expect((await current(row.id)).dataVersion).toBe(2);
  });

  test("data-only refresh requires data/source read, no edit_page, keeps html/page time; updates while running keep statuses", async () => {
    const row = await seed({ sources: '[{"name":"Deals","app":"HubSpot","detail":"open deals"}]' });
    const entered = deferred(), release = deferred();
    m.llm.script("task", async request => { expect(request.tools?.map(t => t.name)).not.toContain("edit_page"); expect(request.tools?.map(t => t.name)).not.toContain("update_artifact_data"); entered.resolve(); await release.promise; return [sourceRead()]; }, buildTurn(m, { write: false }), buildTurn(m, { write: false, data: { total: 99 }, metrics }));
    await m.artifacts.service.refresh(m.alex.userId, row.id); await entered.promise;
    expect(m.workspace.get(m.alex.userId, `artifacts/${row.id}/data.json`)).toBe(JSON.stringify(JSON.parse(row.data!), null, 2));
    const event = await lastEventId(m.fixture); await update(row.id);
    const live = await m.fixture.db.event.findFirstOrThrow({ where: { id: { gt: event }, type: "artifact" } });
    expect(JSON.parse(live.payload)).toMatchObject({ refreshStatus: { state: "working" }, buildStatus: { key: "build.waking_workspace" }, artifact: { pageUpdatedAt: row.updatedAt.toISOString(), dataVersion: 2 } });
    release.resolve(); await m.runs.idle();
    const saved = await current(row.id); expect(saved.html).toBe(row.html); expect(saved.updatedAt).toEqual(row.updatedAt); expect(saved.dataVersion).toBe(3); expect(saved.data).toBe('{"total":99}');
    expect(m.workspace.calls.filter(c => c.op === "read" && c.path === `artifacts/${row.id}/index.html`)).toHaveLength(0);
    expect((await versions(row.id))[0]).toMatchObject({ reason: "refresh", data: '{"total":99}' });
  });

  test("data-only refresh refuses fabricated freshness; legacy dashboard refresh reads/saves whole page", async () => {
    const row = await seed({ sources: '[{"name":"Deals","app":"HubSpot","detail":"open deals"}]' });
    m.llm.script("task", buildTurn(m, { write: false, data: { total: 88 } }));
    await m.artifacts.service.refresh(m.alex.userId, row.id); await m.runs.idle(); expect((await current(row.id)).data).toBe(row.data);
    const old = await seed({ data: null });
    m.llm.script("task", buildTurn(m, { html: "<h1>Whole page refreshed</h1>" }));
    await m.artifacts.service.refresh(m.alex.userId, old.id); await m.runs.idle(); expect((await current(old.id)).html).toContain("Whole page refreshed"); expect((await current(old.id)).updatedAt.getTime()).toBeGreaterThan(old.updatedAt.getTime());
  });

  test("schedule tick compares content time; metric warnings find numbers in data not HTML", async () => {
    m.clock.now = new Date("2035-01-01T10:30:00Z");
    try {
      const row = await seed({ updatedAt: new Date("2035-01-01T09:00:00Z"), dataUpdatedAt: new Date("2035-01-01T10:01:00Z"), refreshSchedule: '{"cadence":"hourly","hour":0,"minute":0}' });
      expect(await m.artifacts.service.tick()).toBe(0); await m.artifacts.service.remove(m.alex.userId, row.id);
    } finally { m.clock.now = null; }
    expect(metricWarnings("", metrics, { rows: [8, { ai: 3 }] })).toEqual([]);
    expect(metricWarnings("8 3", metrics, { total: "8", ai: 3 })).toHaveLength(1);
  });
});

test("served pages without data remain byte-identical for docs and legacy dashboards", async () => {
  for (const type of ["docs", "dashboard"]) {
    const html = '<!doctype html><html><head><title>Existing</title></head><body><h1>Existing</h1><p>42</p></body></html>';
    const row = await seed({ type, data: null, html });
    expect(await m.artifacts.service.html(m.alex.userId, row.id)).toBe(html);
    expect(await m.artifacts.service.html(m.alex.userId, row.id)).toMatchInlineSnapshot(`"<!doctype html><html><head><title>Existing</title></head><body><h1>Existing</h1><p>42</p></body></html>"`);
  }
});
