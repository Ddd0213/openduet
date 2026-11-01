// M10 rename (contract §3): PATCH /api/tasks/:id { title } works on any task, not only routines
// (trimmed, 1-200 characters, else 400 validation_failed). It emits the `task` event and keeps the
// channel's task_spawn chip in sync; someone else's task is 404.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TaskDetail } from "../../src/contract/tasks.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { json, lastEventId, ofType, startApp, storedEvents, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
let sam: SignedIn;
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
});
afterAll(() => t.fixture.cleanup());

const db = () => t.fixture.db;
const patch = (id: string, body: unknown, user: SignedIn = t.alex) => t.fixture.app.request(`/api/tasks/${id}`, json(user, "PATCH", body));

describe("PATCH /api/tasks/:id title", () => {
  test("renames any task (trimmed): task event, and the task_spawn chip shows the new title", async () => {
    t.llm.script("task", [text("Started on it.")]);
    const anchor = await db().message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, role: "user", text: "Book the venue", payload: JSON.stringify({ skill: null }) } });
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Book the venue", prompt: "Book the venue", spawn: { channelId: t.alex.mainChannelId, anchorMessageId: anchor.id } });
    await t.fixture.runs.idle();
    const chipId = (await db().task.findUniqueOrThrow({ where: { id: task.id } })).spawnMessageId!;
    const from = await lastEventId(t.fixture);

    const response = await patch(task.id, { title: "  Venue for the offsite  " });
    expect(response.status).toBe(200);
    const detail = TaskDetail.parse(await response.json());
    expect(detail).toMatchObject({ id: task.id, title: "Venue for the offsite", routine: null });
    expect((await db().task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe("Venue for the offsite");

    const events = await storedEvents(t.fixture, t.alex.userId, from);
    expect(ofType(events, "task").map((e) => [e.payload.task.id, e.payload.task.title])).toEqual([[task.id, "Venue for the offsite"]]);
    const chip = ofType(events, "message").map((e) => e.payload.message).find((m) => m.id === chipId);
    expect(chip).toMatchObject({ kind: "task_spawn", payload: { task: { id: task.id, title: "Venue for the offsite" }, anchorMessageId: anchor.id } });
    expect(JSON.parse((await db().message.findUniqueOrThrow({ where: { id: chipId } })).payload)).toMatchObject({ task: { title: "Venue for the offsite" } });

    // The same title again changes nothing (no event).
    const again = await lastEventId(t.fixture);
    expect((await patch(task.id, { title: "Venue for the offsite" })).status).toBe(200);
    expect(ofType(await storedEvents(t.fixture, t.alex.userId, again), "task")).toEqual([]);
  });

  test("a blank or too long title is 400 validation_failed (field title); 200 characters is fine; someone else's task is 404", async () => {
    const task = await db().task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Plain", prompt: "p", status: "needs_input" } });
    for (const title of ["", "   ", "x".repeat(201), 7]) {
      const response = await patch(task.id, { title });
      expect({ title, status: response.status }).toEqual({ title, status: 400 });
      expect(await errorOf(response)).toMatchObject({ code: "validation_failed", field: "title" });
    }
    expect(TaskDetail.parse(await (await patch(task.id, { title: "y".repeat(200) })).json()).title).toBe("y".repeat(200));
    expect((await patch(task.id, { title: "Mine now" }, sam)).status).toBe(404);
    expect((await db().task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe("y".repeat(200));
  });
});
