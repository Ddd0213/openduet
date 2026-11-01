// Refresh and edit (L151): ↻ rebuilds from the stored sources in place, the schedule refreshes once
// per slot in the user's timezone, ✎ edits re-render in place and glow the changed passages; the
// chat card follows. Plus the slot math and restart recovery.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactResponse } from "../../src/contract/artifacts.ts";
import { latestSlot } from "../../src/artifacts/schedule.ts";
import { GLOW_MS } from "../../src/artifacts/service.ts";
import { CHANGED_ATTR } from "../../src/make/base.ts";
import { errorOf } from "../helpers/http.ts";
import { buildTurn, json, lastEventId, ofType, startMake, storedEvents, timeline, type MakeApp } from "../make/harness.ts";
import { installSourceTool, sourceRead } from "./source-harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); installSourceTool(m); });
afterAll(() => m.fixture.cleanup());

const api = (path: string, init: RequestInit = {}) => m.fixture.app.request(path, init);
const page = (n: number) => `<html><body><main class="duet-page"><h1>Pipeline</h1><p class="n">Open deals: ${n}</p><p>Owners: 1</p><p>Owner: Alex</p></main></body></html>`;
const metrics = (n: number) => [{ label: "Open deals", value: n, unit: null }, { label: "Owners", value: 1, unit: null }];

/** A dashboard built through the real path (so its card is in the chat). */
async function dashboard(): Promise<string> {
  m.llm.script("task", buildTurn(m, { data: { open: 12, owners: 1 }, html: page(12), title: "Pipeline", sources: [{ name: "Deals", app: "HubSpot", detail: "open deals" }], metrics: metrics(12) }));
  const res = await api("/api/artifacts", json(m.alex, "POST", { type: "dashboard", prompt: "My pipeline", channelId: m.alex.mainChannelId }));
  const id = ArtifactResponse.parse(await res.json()).artifact.id;
  await m.runs.idle();
  // The M6/M21 regressions deliberately exercise dashboards from before M27.
  const row = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id } });
  await m.fixture.db.artifact.update({ where: { id }, data: { data: null, dataUpdatedAt: null, updatedAt: row.updatedAt } });
  return id;
}

describe("latestSlot", () => {
  const at = (iso: string) => new Date(iso);
  test("daily, in the user's timezone", () => {
    // 05:30 in Shanghai = 21:30 UTC the day before
    expect(latestSlot({ cadence: "daily", hour: 5, minute: 30 }, "Asia/Shanghai", at("2030-10-23T03:00:00Z"))?.toISOString()).toBe("2030-10-22T21:30:00.000Z");
    expect(latestSlot({ cadence: "daily", hour: 5, minute: 30 }, "Asia/Shanghai", at("2030-10-22T21:30:00Z"))?.toISOString()).toBe("2030-10-22T21:30:00.000Z");
  });
  test("weekdays skip the weekend; hourly uses the minute", () => {
    // Monday 2030-10-28 07:00 UTC -> last weekday 08:00 slot is Friday 10-25
    expect(latestSlot({ cadence: "weekdays", hour: 8, minute: 0 }, "UTC", at("2030-10-28T07:00:00Z"))?.toISOString()).toBe("2030-10-25T08:00:00.000Z");
    expect(latestSlot({ cadence: "hourly", hour: 0, minute: 15 }, "UTC", at("2030-10-28T07:10:00Z"))?.toISOString()).toBe("2030-10-28T06:15:00.000Z");
    expect(latestSlot({ cadence: "hourly", hour: 0, minute: 15 }, "Bad/Zone", at("2030-10-28T07:20:00Z"))?.toISOString()).toBe("2030-10-28T07:15:00.000Z");
  });
});

describe("refresh", () => {
  test("↻ rebuilds from the stored page and sources, in place; the card shows the new numbers", async () => {
    const id = await dashboard();
    const before = await lastEventId(m.fixture);
    const old = (await m.fixture.db.artifact.findUnique({ where: { id } }))!;
    m.llm.script("task", [sourceRead()], buildTurn(m, { html: page(15), metrics: metrics(15), step: "Reading HubSpot" }));
    const res = await api(`/api/artifacts/${id}/refresh`, json(m.alex, "POST"));
    expect(res.status).toBe(200);
    expect(ArtifactResponse.parse(await res.json()).artifact.status).toBe("ready");
    await m.runs.idle();

    const prompt = JSON.stringify(m.llm.sent("task").at(-1)!.messages);
    expect(prompt).toContain("Refresh the dashboard");
    expect(prompt).toContain("HubSpot");
    // the stored page went back to the workspace before the run
    expect(m.workspace.calls.some((c) => c.op === "write" && c.path === `artifacts/${id}/index.html`)).toBe(true);
    const row = (await m.fixture.db.artifact.findUnique({ where: { id } }))!;
    expect(row.html).toContain("Open deals: 15");
    expect(row.updatedAt.getTime()).toBeGreaterThan(old.updatedAt.getTime());
    expect(row.sources).toBe(old.sources); // finish_build without sources keeps them
    const statuses = ofType(await storedEvents(m.fixture, m.alex.userId, before), "artifact").filter((e) => e.payload.artifact.id === id).map((e) => [e.payload.artifact.status, e.payload.buildStatus]);
    expect(statuses).toEqual([["ready", { key: "build.starting_up" }], ["ready", { key: "build.waking_workspace" }], ["ready", { text: "Reading HubSpot" }], ["ready", null]]);
    // no second "made" line or card: the existing card updates
    const cards = (await timeline(m)).filter((x) => x.kind === "artifact" && x.payload.artifact.id === id);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    if (card.kind !== "artifact") throw new Error("no card");
    expect(card.payload.metrics).toEqual(metrics(15));
    expect(card.payload.artifact.updatedAt).toBe(row.updatedAt.toISOString());
  });

  test("a second ↻ while one is queued answers as is; a failed refresh keeps the last version", async () => {
    const id = await dashboard();
    m.llm.script("task", [{ type: "text_delta", text: "No access." }]);
    await api(`/api/artifacts/${id}/refresh`, json(m.alex, "POST"));
    const again = await api(`/api/artifacts/${id}/refresh`, json(m.alex, "POST"));
    expect(again.status).toBe(200);
    await m.runs.idle();
    expect(await m.fixture.db.run.count({ where: { userId: m.alex.userId, kind: "build" } })).toBe(3 + 1);
    const row = (await m.fixture.db.artifact.findUnique({ where: { id } }))!;
    expect([row.status, row.html.includes("Open deals: 12")]).toEqual(["ready", true]);
  });

  test("the schedule refreshes once per slot (user's timezone), never twice for the same slot", async () => {
    const id = await dashboard();
    const now = new Date();
    const slot = new Date(now.getTime() - 5 * 60_000);
    await m.fixture.db.artifact.update({ where: { id }, data: {
      refreshSchedule: JSON.stringify({ cadence: "daily", hour: slot.getUTCHours(), minute: slot.getUTCMinutes() }),
      updatedAt: new Date(now.getTime() - 2 * 86_400_000),
    } });
    m.llm.script("task", [sourceRead()], buildTurn(m, { html: page(20) }));
    expect(await m.artifacts.service.tick()).toBe(1);
    expect(await m.artifacts.service.tick()).toBe(0); // queued: not again
    await m.runs.idle();
    expect((await m.fixture.db.artifact.findUnique({ where: { id } }))!.html).toContain("Open deals: 20");
    expect(await m.artifacts.service.tick()).toBe(0); // done for this slot
    // a scheduled refresh never posts in the chat
    const lines = (await timeline(m)).filter((x) => x.kind === "system" && x.payload.phrase.key === "system.made_dashboard");
    expect(lines).toHaveLength(3);
  });
});

describe("✎ edit", () => {
  test("changes the page in place; the changed passages glow (markers served for GLOW_MS only)", async () => {
    const id = await dashboard();
    m.llm.script("task", buildTurn(m, { html: page(12).replace("<p>Owner: Alex</p>", `<p ${CHANGED_ATTR}>Owner: Sam</p>`) }));
    const res = await api(`/api/artifacts/${id}/edit`, json(m.alex, "POST", { prompt: "Make Sam the owner" }));
    expect(res.status).toBe(200);
    await m.runs.idle();
    const sent = m.llm.sent("task").at(-1)!;
    expect(JSON.stringify(sent.messages)).toContain("Make Sam the owner");
    expect(JSON.stringify(sent.messages)).toContain(CHANGED_ATTR);
    // finish_build ends the build turn; the stored page keeps the markers for the next glow window
    expect((await m.fixture.db.artifact.findUnique({ where: { id } }))!.html).toContain(`<p ${CHANGED_ATTR}>Owner: Sam</p>`);
    const fresh = await (await api(`/api/artifacts/${id}/html`, { headers: m.alex.headers })).text();
    expect(fresh).toContain(`<p ${CHANGED_ATTR}>Owner: Sam</p>`);
    m.clock.now = new Date(Date.now() + GLOW_MS + 1000);
    try {
      const later = await (await api(`/api/artifacts/${id}/html`, { headers: m.alex.headers })).text();
      expect(later).toContain("<p>Owner: Sam</p>");
      // the base CSS / script still name the selector; no element carries the marker any more
      expect(later).not.toMatch(new RegExp(`<[a-z][^>]*\\s${CHANGED_ATTR}`));
    } finally {
      m.clock.now = null;
    }
  });

  test("nothing to edit before the first page; validated body", async () => {
    const row = await m.fixture.db.artifact.create({ data: { userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", title: "T", prompt: "p", status: "failed" } });
    const res = await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "x" }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation_failed");
    expect((await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "" }))).status).toBe(400);
  });
});

describe("restart", () => {
  test("first builds left building turn failed (interrupted) with a line; pages keep their version", async () => {
    const building = await m.fixture.db.artifact.create({ data: { userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", title: "Brief", prompt: "p", status: "building" } });
    const before = await lastEventId(m.fixture);
    expect(await m.artifacts.service.recoverAfterRestart()).toBe(1);
    expect((await m.fixture.db.artifact.findUnique({ where: { id: building.id } }))!.status).toBe("failed");
    const events = await storedEvents(m.fixture, m.alex.userId, before);
    expect(ofType(events, "artifact")[0]!.payload.buildStatus).toEqual({ key: "artifact.interrupted" });
    expect(ofType(events, "message").some((e) => e.payload.message.kind === "system" && e.payload.message.payload.phrase.key === "artifact.interrupted")).toBe(true);
  });
});
