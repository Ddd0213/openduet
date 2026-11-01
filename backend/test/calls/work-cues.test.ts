// M15: builds and tasks reach the voice. While a call is open, a Make build in its channel cues
// progress when it starts and a notice when it's ready or failed; a task there cues progress when
// it starts and a notice when it needs the user, is ready for review or is done. Only a change of
// status cues (a pin or a refresh of a ready page doesn't); another channel's don't.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SignedIn } from "../helpers/session.ts";
import { signUp } from "../helpers/session.ts";
import { chatModel, eventsOf, realtimeModel, req, settle, startCallsApp, stopCallsApp, type CallsApp } from "./harness.ts";

let t: CallsApp;
beforeAll(async () => {
  t = await startCallsApp();
});
afterAll(() => stopCallsApp(t));

const AT = "2026-11-02T18:00:00.000Z";

async function setUp(name: string) {
  const u = await signUp(t.fixture, name, `${name} Test`);
  await chatModel(t, u);
  await realtimeModel(t, u, "gemini");
  const start = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
  expect(start.status).toBe(200);
  return { u, id: start.body.call.id as string };
}

const cues = async (u: SignedIn) => (await eventsOf(t, u.userId, "call")).map((e) => ({ kind: e.payload.kind, text: e.payload.text }));

function artifact(channelId: string, status: "building" | "ready" | "failed", extra: { pinned?: boolean } = {}) {
  return {
    id: "art_dash", channelId, type: "dashboard" as const, title: "Shop dashboard", status, sourceCount: 2,
    refreshSchedule: null, pinnedToTabBar: false, pinned: extra.pinned ?? false, createdAt: AT, updatedAt: AT,
  };
}

function task(channelId: string, status: "working" | "needs_input" | "ready_for_review" | "resolved", update: string | null = null) {
  return {
    id: "task_books", channelId, title: "Recommend 5 books", status, source: "user" as const,
    latestUpdate: update ? { text: { text: update }, source: "Claude", at: AT } : null, updateCount: update ? 1 : 0,
    schedule: null, archived: false, pinned: false, routine: null, createdAt: AT, updatedAt: AT,
  };
}

describe("builds and tasks reach the voice", () => {
  test("a build: started (progress), ready (notice); a pin of the ready page says nothing", async () => {
    const { u } = await setUp("bea");
    const ch = u.mainChannelId;
    const emit = (payload: object) => t.fixture.events.emit(u.userId, ch, "artifact", payload as never);
    await emit({ artifact: artifact(ch, "building"), buildStatus: { text: "Starting" } });
    await emit({ artifact: artifact(ch, "building"), buildStatus: { text: "Reading the sources" } });
    await emit({ artifact: artifact(ch, "ready"), buildStatus: null });
    await emit({ artifact: artifact(ch, "ready", { pinned: true }), buildStatus: null });
    await settle(t);
    expect(await cues(u)).toEqual([
      { kind: "progress", text: "OpenDuet is building \"Shop dashboard\" in Make." },
      { kind: "notice", text: "\"Shop dashboard\" is ready: the card is in the chat." },
    ]);
  });

  test("a failed build: a notice with the reason; another channel's build: nothing", async () => {
    const { u } = await setUp("cyd");
    const ch = u.mainChannelId;
    const elsewhere = await t.fixture.db.channel.create({ data: { userId: u.userId, isMain: false, name: "Other", purpose: "" } });
    await t.fixture.events.emit(u.userId, elsewhere.id, "artifact", { artifact: artifact(elsewhere.id, "building"), buildStatus: null });
    await t.fixture.events.emit(u.userId, ch, "artifact", { artifact: artifact(ch, "building"), buildStatus: null });
    await t.fixture.events.emit(u.userId, ch, "artifact", { artifact: artifact(ch, "failed"), buildStatus: { text: "The data source didn't answer" } });
    await settle(t);
    expect(await cues(u)).toEqual([
      { kind: "progress", text: "OpenDuet is building \"Shop dashboard\" in Make." },
      { kind: "notice", text: "\"Shop dashboard\" couldn't be built: The data source didn't answer" },
    ]);
  });

  test("a task: working (progress), needs input (notice with the update), ready for review, done", async () => {
    const { u } = await setUp("dov");
    const ch = u.mainChannelId;
    const emit = (status: Parameters<typeof task>[1], update: string | null = null) =>
      t.fixture.events.emit(u.userId, ch, "task", { task: task(ch, status, update) });
    await emit("working");
    await emit("working", "Looked at 12 lists");
    await emit("needs_input", "Fiction or non-fiction?");
    await emit("working");
    await emit("ready_for_review", "Five books, with a line on each");
    await emit("resolved");
    await settle(t);
    expect(await cues(u)).toEqual([
      { kind: "progress", text: "OpenDuet is working on the task \"Recommend 5 books\"." },
      { kind: "notice", text: "The task \"Recommend 5 books\" needs the user: Fiction or non-fiction?" },
      { kind: "notice", text: "The task \"Recommend 5 books\" is done and ready for the user to review: Five books, with a line on each" },
      { kind: "notice", text: "The task \"Recommend 5 books\" is done." },
    ]);
  });
});
