import { expect, test } from "bun:test";
import { FakeComputer, COMPUTER_URL } from "../../evals/lib/fake-computer.ts";
import { FakeWeb } from "../../evals/lib/fake-web.ts";
import { scoreDashboard, type DashboardFacts } from "../../evals/dashboard/score.ts";
import { EXPECTED, BATCHES } from "../../evals/dashboard/fixtures.ts";

test("dashboard scorer keeps each required check independently strict", () => {
  const good: DashboardFacts = { buildRuns: 1, savedUpdates: 3, calls: [{ name: "update_artifact_data" }], before: { html: "same", pageUpdatedAt: "same" }, after: { html: "same", pageUpdatedAt: "same", dataVersion: 4, data: { total: EXPECTED.total, categories: Object.entries(EXPECTED.categories).map(([name, count]) => ({ name, count })), recent: BATCHES.at(-1)!.slice(-5) } } };
  expect(scoreDashboard(good).pass).toBe(true);
  for (const bad of [{ ...good, buildRuns: 2 }, { ...good, savedUpdates: 2 }, { ...good, calls: [{ name: "refresh_artifact" }] }, { ...good, calls: [{ name: "edit_artifact" }] }, { ...good, before: null }, { ...good, after: { ...good.after!, html: "changed" } }, { ...good, after: { ...good.after!, pageUpdatedAt: "changed" } }, { ...good, after: { ...good.after!, dataVersion: 3 } }, { ...good, after: { ...good.after!, data: {} } }]) expect(scoreDashboard(bad).pass).toBe(false);
});

test("fake file store is opt-in, write/read/list/download agree, traversal refused, no contents in calls", async () => {
  const fake = new FakeComputer(new FakeWeb());
  const request = (path: string, body: Record<string, unknown> = {}) => fake.fetch(COMPUTER_URL + path, { method: "POST", body: JSON.stringify(body) });
  await request("/files/write", { path: "a.txt", contents: "private" });
  expect((await request("/files/read", { path: "a.txt" })).status).toBe(404);
  fake.enableFileStore(true);
  await request("/files/write", { path: "/workspace/links/a.txt", contents: "private" });
  await request("/files/write", { path: "links/a.txt", contents: " plus", append: true });
  expect(await (await request("/files/read", { path: "links/a.txt" })).json()).toMatchObject({ text: "private plus", bytes: 12 });
  expect(await (await fake.fetch(COMPUTER_URL + "/files/download?path=links/a.txt")).text()).toBe("private plus");
  expect(await (await request("/files/list", { path: "links" })).json()).toMatchObject({ entries: [{ path: "links/a.txt", kind: "file" }] });
  expect(await (await request("/exec", { command: "echo not-a-real-shell" })).json()).toMatchObject({ exitCode: 1 });
  for (const path of ["../bad", "/etc/passwd", "/workspace/../bad", "/workspace-not/a"]) expect((await request("/files/write", { path, contents: "no" })).status).toBe(400);
  expect(JSON.stringify(fake.calls)).not.toContain("private");
});
