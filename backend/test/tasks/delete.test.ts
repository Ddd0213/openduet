// M9 deletes and pins (contract §4): DELETE /api/tasks/:id and DELETE /api/channels/:id cancel a
// running turn, delete what belongs to them (cascade), move a channel's Make artifacts to the main
// thread and emit task_deleted / channel_deleted (+ message_deleted for a task's cards outside its
// thread); someone else's id is 404, the main thread 400. Active tasks sort pinned first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LlmRequest } from "../../src/llm/index.ts";
import { TaskList } from "../../src/contract/tasks.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { json, lastEventId, ofType, startApp, storedEvents, type TaskApp } from "./harness.ts";

let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const db = () => t.fixture.db;
const req = (path: string, method = "GET", body?: unknown, user: SignedIn = t.alex) =>
  t.fixture.app.request(path, method === "GET" ? { headers: user.headers } : json(user, method, body));

/** A model call that waits until its turn is cancelled (it never answers on its own). */
function untilCancelled(started: () => void) {
  return async (request: LlmRequest) => {
    started();
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) return resolve();
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("aborted");
  };
}
const waitFor = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
};

describe("DELETE /api/tasks/:id", () => {
  test("cancels its running turn and deletes the task, its thread, approvals and suggestions; its chip goes too", async () => {
    let running = false;
    t.llm.script("task", untilCancelled(() => { running = true; }));
    const anchor = await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, role: "user", text: "Plan the trip", payload: JSON.stringify({ skill: null }) } });
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Plan the trip", prompt: "Plan the trip", spawn: { channelId: t.alex.mainChannelId, anchorMessageId: anchor.id } });
    await waitFor(async () => running);
    const card = await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, role: "assistant", kind: "text", text: "approval card stand-in", payload: JSON.stringify({ skill: null }) } });
    await db().approval.create({ data: { userId: t.alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", taskId: task.id, messageId: card.id } });
    await db().suggestion.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Follow up", taskId: task.id } });
    const chipId = (await db().task.findUniqueOrThrow({ where: { id: task.id } })).spawnMessageId!;
    const run = await db().run.findFirstOrThrow({ where: { taskId: task.id } });
    const from = await lastEventId(t.fixture);

    expect((await req(`/api/tasks/${task.id}`, "DELETE", undefined, sam)).status).toBe(404);
    const response = await req(`/api/tasks/${task.id}`, "DELETE");
    expect(response.status).toBe(204);
    await t.fixture.runs.idle();

    expect(await db().task.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await db().message.count({ where: { taskId: task.id } })).toBe(0);
    expect(await db().message.findUnique({ where: { id: chipId } })).toBeNull();
    expect(await db().message.findUnique({ where: { id: card.id } })).toBeNull();
    expect(await db().approval.count({ where: { taskId: task.id } })).toBe(0);
    expect(await db().suggestion.count({ where: { taskId: task.id } })).toBe(0);
    expect(await db().message.findUnique({ where: { id: anchor.id } })).not.toBeNull();
    // The run row stays (usage history), cancelled.
    expect(await db().run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "cancelled" });

    const events = await storedEvents(t.fixture, t.alex.userId, from);
    expect(ofType(events, "task_deleted").map((e) => e.payload.taskId)).toEqual([task.id]);
    expect(ofType(events, "message_deleted").map((e) => e.payload.messageId).sort()).toEqual([chipId, card.id].sort());
    expect(ofType(events, "done").map((e) => [e.payload.runId, e.payload.status])).toEqual([[run.id, "cancelled"]]);
    expect((await req(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await req(`/api/tasks/${task.id}`, "DELETE")).status).toBe(404);
  });

  test("someone else's task is 404 and stays", async () => {
    const theirs = await db().task.create({ data: { userId: sam.userId, channelId: sam.mainChannelId, title: "Sam's", prompt: "p", status: "needs_input" } });
    const response = await req(`/api/tasks/${theirs.id}`, "DELETE");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
    expect(await db().task.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

describe("DELETE /api/channels/:id", () => {
  test("cancels its turns and deletes it with its messages, tasks, approvals, suggestions, reminders and files; artifacts move to main", async () => {
    const side = (await db().channel.create({ data: { userId: t.alex.userId, name: "Launch", purpose: "Q4" } })).id;
    let chatRunning = false;
    let taskRunning = false;
    t.llm.script("chat", untilCancelled(() => { chatRunning = true; }));
    t.llm.script("task", untilCancelled(() => { taskRunning = true; }));
    const stream = await req(`/api/channels/${side}/messages`, "POST", { text: "Draft the launch post", clientId: "del-ch-1" });
    expect(stream.status).toBe(200);
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: side, title: "Launch checklist", prompt: "Make the checklist" });
    await waitFor(async () => chatRunning && taskRunning);

    const message = await db().message.findFirstOrThrow({ where: { clientId: "del-ch-1" } });
    await db().approval.create({ data: { userId: t.alex.userId, kind: "email", toolSlug: "GMAIL_SEND_EMAIL", messageId: message.id } });
    await db().suggestion.create({ data: { userId: t.alex.userId, channelId: side, title: "Ping the team" } });
    await db().reminder.create({ data: { userId: t.alex.userId, channelId: side, at: new Date(Date.now() + 3_600_000), text: "Ship it" } });
    const path = await t.fixture.files.save(t.alex.userId, "text/plain", new TextEncoder().encode("notes"));
    const file = await db().channelFile.create({ data: { userId: t.alex.userId, channelId: side, messageId: message.id, path, name: "notes.txt", mime: "text/plain", size: 5, source: "user" } });
    const artifact = await db().artifact.create({ data: { userId: t.alex.userId, channelId: side, type: "docs", title: "Launch brief", status: "ready" } });
    const from = await lastEventId(t.fixture);

    expect((await req(`/api/channels/${side}`, "DELETE", undefined, sam)).status).toBe(404);
    const main = await req(`/api/channels/${t.alex.mainChannelId}`, "DELETE");
    expect(main.status).toBe(400);
    expect((await errorOf(main)).code).toBe("validation_failed");
    expect((await req(`/api/channels/${side}`, "DELETE")).status).toBe(204);
    await readSse(stream);
    await t.fixture.runs.idle();

    expect(await db().channel.findUnique({ where: { id: side } })).toBeNull();
    expect(await db().message.count({ where: { channelId: side } })).toBe(0);
    expect(await db().task.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await db().approval.count({ where: { messageId: message.id } })).toBe(0);
    expect(await db().suggestion.count({ where: { channelId: side } })).toBe(0);
    expect(await db().suggestion.count({ where: { userId: t.alex.userId, title: "Ping the team" } })).toBe(0);
    expect(await db().reminder.count({ where: { channelId: side } })).toBe(0);
    expect(await db().channelFile.findUnique({ where: { id: file.id } })).toBeNull();
    await expect(t.fixture.files.read(path)).rejects.toThrow();
    expect(await db().artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ channelId: t.alex.mainChannelId });
    const runs = await db().run.findMany({ where: { channelId: side } });
    expect(runs.map((r) => r.status).sort()).toEqual(["cancelled", "cancelled"]);

    const events = await storedEvents(t.fixture, t.alex.userId, from);
    const moved = ofType(events, "artifact").find((e) => e.payload.artifact.id === artifact.id);
    expect(moved).toMatchObject({ channelId: t.alex.mainChannelId, payload: { artifact: { channelId: t.alex.mainChannelId } } });
    expect(ofType(events, "task_deleted").map((e) => e.payload.taskId)).toEqual([task.id]);
    const gone = ofType(events, "channel_deleted");
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ channelId: side, payload: { channelId: side } });
    expect(events.indexOf(gone[0]!)).toBe(events.length - 1);
    expect((await req(`/api/channels/${side}/messages`)).status).toBe(404);
  });

  test("an unknown channel is 404; the user's main thread and its messages stay", async () => {
    expect((await req("/api/channels/nope", "DELETE")).status).toBe(404);
    expect(await db().channel.findUnique({ where: { id: t.alex.mainChannelId } })).not.toBeNull();
    expect((await req(`/api/channels/${sam.mainChannelId}`, "DELETE")).status).toBe(404);
  });
});

describe("pins", () => {
  test("Active lists pinned tasks first (newest pin first), then the rest by last update; unpin puts it back", async () => {
    const make = (title: string) => db().task.create({ data: { userId: sam.userId, channelId: sam.mainChannelId, title, prompt: title, status: "needs_input" } });
    const a = await make("A");
    await Bun.sleep(5);
    const b = await make("B");
    await Bun.sleep(5);
    const c = await make("C");
    const mine = new Set([a.id, b.id, c.id]);
    const order = async () => TaskList.parse(await (await req("/api/tasks", "GET", undefined, sam)).json()).tasks.filter((x) => mine.has(x.id)).map((x) => [x.title, x.pinned]);
    expect(await order()).toEqual([["C", false], ["B", false], ["A", false]]);
    expect((await req(`/api/tasks/${a.id}`, "PATCH", { pinned: true }, sam)).status).toBe(200);
    await Bun.sleep(5);
    expect((await req(`/api/tasks/${b.id}`, "PATCH", { pinned: true }, sam)).status).toBe(200);
    const pinnedAt = (await db().task.findUniqueOrThrow({ where: { id: b.id } })).pinnedAt;
    // Pinning again keeps the first pin time.
    await req(`/api/tasks/${b.id}`, "PATCH", { pinned: true }, sam);
    expect((await db().task.findUniqueOrThrow({ where: { id: b.id } })).pinnedAt).toEqual(pinnedAt);
    const pinned = await order();
    expect(pinned.slice(0, 2)).toEqual([["B", true], ["A", true]]);
    expect(pinned[2]).toEqual(["C", false]);
    expect((await req(`/api/tasks/${b.id}`, "PATCH", { pinned: false }, sam)).status).toBe(200);
    expect((await order())[0]).toEqual(["A", true]);
    expect((await order()).slice(1).map(([title]) => title)).toContain("B");
    expect((await req(`/api/tasks/${c.id}`, "PATCH", { pinned: "yes" }, sam)).status).toBe(400);
  });
});
