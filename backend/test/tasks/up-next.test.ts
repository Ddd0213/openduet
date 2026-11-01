// Up next (L119): open suggestions only, newest first, scanning false; Add makes one proactive task
// (twice is still one) in the suggestion's channel or the main thread; Hide; someone else's is 404.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AddSuggestionResponse, UpNext } from "../../src/contract/tasks.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { json, startApp, type TaskApp } from "./harness.ts";

let t: TaskApp;
let sam: SignedIn;
const ids: Record<string, string> = {};
beforeAll(async () => {
  t = await startApp();
  sam = await signUp(t.fixture, "sam", "Sam Lee");
  const side = await t.fixture.db.channel.create({ data: { userId: t.alex.userId, name: "Sales", purpose: "Renewals" } });
  const make = (key: string, data: Record<string, unknown>, at: number) =>
    t.fixture.db.suggestion.create({ data: { userId: t.alex.userId, title: key, createdAt: new Date(Date.UTC(2030, 0, 1, 9, at)), ...data } }).then((row) => { ids[key] = row.id; });
  await make("Reply to Northfield", { channelId: side.id, body: "They asked about pricing.", prompt: "Draft a reply to Northfield about pricing", app: "Gmail", origin: "checkin" }, 1);
  await make("File the expense report", { channelId: null, body: "Three receipts from last week.", app: "Google Drive", origin: "scan" }, 2);
  await make("Already hidden", { status: "hidden" }, 3);
  await make("Archive old threads", { body: "", origin: "brief" }, 4);
  ids.sams = (await t.fixture.db.suggestion.create({ data: { userId: sam.userId, title: "Sam's" } })).id;
});
afterAll(() => t.fixture.cleanup());

const upNext = async (user: SignedIn = t.alex) => UpNext.parse(await (await t.fixture.app.request("/api/up-next", { headers: user.headers })).json());
const post = (path: string, user: SignedIn = t.alex) => t.fixture.app.request(path, json(user, "POST"));

describe("up next", () => {
  test("lists the open suggestions newest first; scanning is false", async () => {
    const list = await upNext();
    expect(list.scanning).toBe(false);
    expect(list.suggestions.map((s) => s.title)).toEqual(["Archive old threads", "File the expense report", "Reply to Northfield"]);
    expect(list.suggestions.at(-1)).toMatchObject({ app: "Gmail", origin: "checkin", body: "They asked about pricing." });
    expect((await upNext(sam)).suggestions.map((s) => s.title)).toEqual(["Sam's"]);
  });

  test("Add makes one proactive task, in the suggestion's channel or the main thread", async () => {
    const first = await post(`/api/up-next/${ids["Reply to Northfield"]}/add`);
    expect(first.status).toBe(200);
    const { task } = AddSuggestionResponse.parse(await first.json());
    expect(task).toMatchObject({ title: "Reply to Northfield", source: "proactive", status: "working" });
    const row = await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row).toMatchObject({ prompt: "Draft a reply to Northfield about pricing", description: "They asked about pricing." });
    expect(row.noticedAt?.toISOString()).toBe("2030-01-01T09:01:00.000Z");
    expect(row.channelId).not.toBe(t.alex.mainChannelId);
    await t.fixture.runs.idle();

    const again = AddSuggestionResponse.parse(await (await post(`/api/up-next/${ids["Reply to Northfield"]}/add`)).json());
    expect(again.task.id).toBe(task.id);
    expect(await t.fixture.db.task.count({ where: { userId: t.alex.userId, title: "Reply to Northfield" } })).toBe(1);
    expect(await t.fixture.db.suggestion.findUniqueOrThrow({ where: { id: ids["Reply to Northfield"]! } })).toMatchObject({ status: "added", taskId: task.id });

    const fallback = AddSuggestionResponse.parse(await (await post(`/api/up-next/${ids["File the expense report"]}/add`)).json());
    expect(fallback.task.channelId).toBe(t.alex.mainChannelId);
    expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: fallback.task.id } })).prompt).toBe("File the expense report");
    await t.fixture.runs.idle();
    expect((await upNext()).suggestions.map((s) => s.title)).toEqual(["Archive old threads"]);
  });

  test("Hide takes it off the list (204, twice is fine); someone else's or a missing one is 404", async () => {
    expect((await post(`/api/up-next/${ids["Archive old threads"]}/hide`)).status).toBe(204);
    expect((await post(`/api/up-next/${ids["Archive old threads"]}/hide`)).status).toBe(204);
    expect((await upNext()).suggestions).toEqual([]);
    expect((await post(`/api/up-next/${ids.sams}/hide`)).status).toBe(404);
    expect((await post(`/api/up-next/${ids.sams}/add`)).status).toBe(404);
    expect((await post("/api/up-next/missing/add")).status).toBe(404);
    expect(await t.fixture.db.suggestion.findUniqueOrThrow({ where: { id: ids.sams } })).toMatchObject({ status: "open", taskId: null });
    expect((await t.fixture.app.request("/api/up-next")).status).toBe(401);
  });
});
