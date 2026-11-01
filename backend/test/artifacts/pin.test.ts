// M10 Pin in Make (contract §2): PATCH /api/artifacts/:id { pinned } pins / unpins any number of
// artifacts (Artifact.pinnedAt); GET /api/artifacts lists pinned ones first (newest pin first), then
// updatedAt desc. Separate from pinnedToTabBar (both can be true; the tab-bar rule of one at a time
// never touches `pinned`). updatedAt stays; cards in chat follow; older payloads parse as false.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactList, ArtifactResponse, ArtifactSummary, UpdateArtifactRequest } from "../../src/contract/artifacts.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { json, lastEventId, ofType, PAGE, startMake, storedEvents, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
let sam: SignedIn;
beforeAll(async () => {
  m = await startMake();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
});
afterAll(() => m.fixture.cleanup());

const api = (path: string, init: RequestInit = {}) => m.fixture.app.request(path, init);
const patch = async (id: string, body: unknown, user: SignedIn = m.alex) => {
  const res = await api(`/api/artifacts/${id}`, json(user, "PATCH", body));
  expect(res.status).toBe(200);
  return ArtifactResponse.parse(await res.json()).artifact;
};
/** Seeded straight in the database with a fixed content time (oldest first). */
const seed = (title: string, updatedAt: string, user: SignedIn = m.alex) =>
  m.fixture.db.artifact.create({ data: { userId: user.userId, channelId: user.mainChannelId, type: "web_page", title, prompt: "A page", status: "ready", html: PAGE, updatedAt: new Date(updatedAt) } });
const order = async (user: SignedIn = m.alex) =>
  ArtifactList.parse(await (await api("/api/artifacts", { headers: user.headers })).json()).artifacts.map((a) => [a.title, a.pinned]);

describe("pinned artifacts", () => {
  test("pin, unpin and the order: pinned first (newest pin first), then updatedAt desc; updatedAt stays", async () => {
    const a = await seed("A", "2026-10-20T08:00:00.000Z");
    const b = await seed("B", "2026-10-21T08:00:00.000Z");
    const c = await seed("C", "2026-10-22T08:00:00.000Z");
    expect(await order()).toEqual([["C", false], ["B", false], ["A", false]]);

    const pinnedA = await patch(a.id, { pinned: true });
    expect(pinnedA).toMatchObject({ pinned: true, pinnedToTabBar: false, updatedAt: "2026-10-20T08:00:00.000Z" });
    expect(await order()).toEqual([["A", true], ["C", false], ["B", false]]);
    await Bun.sleep(5);
    await patch(b.id, { pinned: true });
    // Any number can be pinned; the newest pin is first.
    expect(await order()).toEqual([["B", true], ["A", true], ["C", false]]);

    // Pinning again keeps the first pin time.
    const pinnedAt = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: a.id } })).pinnedAt;
    expect(pinnedAt).toBeInstanceOf(Date);
    await Bun.sleep(5);
    await patch(a.id, { pinned: true });
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: a.id } })).pinnedAt).toEqual(pinnedAt);
    expect(await order()).toEqual([["B", true], ["A", true], ["C", false]]);

    const unpinned = await patch(b.id, { pinned: false });
    expect(unpinned).toMatchObject({ pinned: false, updatedAt: "2026-10-21T08:00:00.000Z" });
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: b.id } })).pinnedAt).toBeNull();
    expect(await order()).toEqual([["A", true], ["C", false], ["B", false]]);
    await patch(a.id, { pinned: false });
    expect(await order()).toEqual([["C", false], ["B", false], ["A", false]]);
    // Someone else's list never shows them; their PATCH is 404.
    expect(await order(sam)).toEqual([]);
    expect((await api(`/api/artifacts/${c.id}`, json(sam, "PATCH", { pinned: true }))).status).toBe(404);
  });

  test("independent of pinnedToTabBar: both can be true, and the one-tab rule never unpins", async () => {
    const x = await seed("X", "2026-10-23T08:00:00.000Z");
    const y = await seed("Y", "2026-10-24T08:00:00.000Z");
    const from = await lastEventId(m.fixture);
    const both = await patch(x.id, { pinned: true, pinnedToTabBar: true });
    expect([both.pinned, both.pinnedToTabBar]).toEqual([true, true]);
    // Y takes the 4th tab: X leaves the tab bar but stays pinned in Make.
    const tab = await patch(y.id, { pinnedToTabBar: true });
    expect([tab.pinned, tab.pinnedToTabBar]).toEqual([false, true]);
    const stored = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: x.id } });
    expect([stored.pinnedToTabBar, stored.pinnedAt !== null]).toEqual([false, true]);
    // Unpinning in Make leaves the tab bar alone.
    expect(await patch(y.id, { pinned: true })).toMatchObject({ pinned: true, pinnedToTabBar: true });
    expect(await patch(y.id, { pinned: false })).toMatchObject({ pinned: false, pinnedToTabBar: true });
    // Every change went out as an `artifact` event with the current pin state.
    const events = ofType(await storedEvents(m.fixture, m.alex.userId, from), "artifact").map((e) => [e.payload.artifact.title, e.payload.artifact.pinned, e.payload.artifact.pinnedToTabBar]);
    expect(events).toEqual([["X", true, true], ["X", true, false], ["Y", false, true], ["Y", true, true], ["Y", false, true]]);
    await patch(x.id, { pinned: false });
    await patch(y.id, { pinnedToTabBar: false });
  });

  test("contract: older ArtifactSummary payloads parse as unpinned; pinned must be a boolean", () => {
    const old = { id: "art_1", channelId: "ch_main", type: "docs", title: "Old", status: "ready", sourceCount: 0, refreshSchedule: null, pinnedToTabBar: true, createdAt: "2026-10-25T09:00:00.000Z", updatedAt: "2026-10-25T09:00:00.000Z" };
    expect(ArtifactSummary.parse(old).pinned).toBe(false);
    expect(UpdateArtifactRequest.safeParse({ pinned: true }).success).toBe(true);
    expect(UpdateArtifactRequest.safeParse({ pinned: "yes" }).success).toBe(false);
  });
});
