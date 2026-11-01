// M8 task bits: the done notice in the chat (M18: the task's result, with taskResult on the payload,
// once per move into done, in the user's language), the add_update source whitelist, and the
// language / delegation lines.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { descriptions } from "../../src/computer/tools.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog.ts";
import { doneText, TaskService } from "../../src/tasks/service.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, startApp, text, type TaskApp } from "./harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

/** The task's result messages on its channel's timeline (M18: taskResult on the payload). */
const notices = (taskId: string) => t.fixture.db.message.findMany({
  where: { userId: t.alex.userId, taskId: null, role: "assistant", kind: "text", payload: { contains: `"taskResult":{"taskId":"${taskId}"` } },
  orderBy: { createdAt: "asc" },
});

describe("the done notice", () => {
  test("in zh-Hans: finish_task's summary is the result when the turn wrote no text; without one, the task_done line with the title's link brackets escaped", async () => {
    await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "zh-Hans" } });
    try {
      const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Q3 [draft] $5 budget", prompt: "Plan the budget" });
      t.llm.script("task", [call("finish_task", { summary: "预算表已经做好。" })]);
      await t.fixture.runs.idle();
      expect((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("resolved");
      const posted = await notices(task.id);
      expect(posted.map((m) => m.text)).toEqual(["预算表已经做好。"]);
      expect(posted[0]).toMatchObject({ channelId: t.alex.mainChannelId, taskId: null });

      const bare = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Q4 [final] $5", prompt: "Plan it" });
      t.llm.script("task", [call("finish_task", {})]);
      await t.fixture.runs.idle();
      expect((await notices(bare.id)).map((m) => m.text)).toEqual([`做好了：[Q4 \\[final\\] $5](duet://tasks/${bare.id})`]);
    } finally {
      await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "en" } });
    }
  });

  test("M27: finish_task's summary replaces opening text before the call (same or earlier round)", async () => {
    for (const sameRound of [true, false]) {
      const opening = text("I'll compare the venues.");
      const steps = call("set_steps", { steps: [{ text: "Compare venues", state: "done" }] });
      const finish = call("finish_task", { summary: "LX Factory fits all 12 people and the budget." });
      if (sameRound) t.llm.script("task", [opening, steps, finish]);
      else t.llm.script("task", [opening, steps], [finish]);
      const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Compare venues", prompt: "Compare them" });
      await t.fixture.runs.idle();
      expect((await notices(task.id)).map(m => m.text)).toEqual(["LX Factory fits all 12 people and the budget."]);
      const row = await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(row.status).toBe("resolved");
      expect(JSON.parse(row.updates).at(-1).text).toEqual({ text: "LX Factory fits all 12 people and the budget." });
    }
  });

  test("M27: final text after finish_task wins over its summary, without including the opening", async () => {
    // The runtime writes all streamed text before it executes tools: timestamps cannot establish
    // this ordering. The final assistant blocks must identify the text after the finish call.
    t.llm.script("task", [
      text("I'll compare the venues.\n\n"),
      call("finish_task", { summary: "Venue comparison complete." }),
      text("**LX Factory** fits your budget.\n\nVillage Underground is too small."),
    ]);
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Venue result", prompt: "Compare venues" });
    await t.fixture.runs.idle();
    expect((await notices(task.id)).map(m => m.text)).toEqual(["**LX Factory** fits your budget.\n\nVillage Underground is too small."]);
    const row = await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("resolved");
    expect(JSON.parse(row.updates).at(-1).text).toEqual({ text: "Venue comparison complete." });
  });

  test("M27: no finish_task summary preserves the last-text fallback", async () => {
    t.llm.script("task", [text("LX Factory fits your budget."), call("finish_task", {})]);
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Venue without summary", prompt: "Compare venues" });
    await t.fixture.runs.idle();
    expect((await notices(task.id)).map(m => m.text)).toEqual(["LX Factory fits your budget."]);
  });

  test("only on a real move into done: a task that already was gets no second result; a new move does", async () => {
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Book the venue", prompt: "Book it" });
    t.llm.script("task", [call("finish_task", {})]);
    await t.fixture.runs.idle();
    expect((await notices(task.id)).map((m) => m.text)).toEqual([`Done: [Book the venue](duet://tasks/${task.id})`]);

    // A turn that ends while the task already shows ready_for_review (set during the turn) posts nothing.
    await t.fixture.db.task.update({ where: { id: task.id }, data: { status: "needs_input" } });
    t.llm.script("task", async () => {
      await t.fixture.db.task.update({ where: { id: task.id }, data: { status: "ready_for_review" } });
      return [call("finish_task", { summary: "Still done." })];
    });
    await t.tasks.service.continueTask(task.id, "carry on");
    await t.fixture.runs.idle();
    expect(await notices(task.id)).toHaveLength(1);

    // The user replies inside the done task and Claude finishes again: they read it in the task, so
    // the chat gets no second result.
    t.llm.script("task", [call("finish_task", { summary: "Booked for May 19." })]);
    await readSse(await t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "Book May 19", clientId: "dn-1" })));
    await t.fixture.runs.idle();
    expect(await notices(task.id)).toHaveLength(1);

    // Words passed on from the chat (tell_task) that finish it again: a new move the chat hears about.
    t.llm.script("task", [call("finish_task", { summary: "Moved to May 20." })]);
    await t.tasks.service.tell((await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } })), "Make it May 20");
    await t.fixture.runs.idle();
    const after = await notices(task.id);
    expect(after).toHaveLength(2);
    expect(after[1]!.text).toBe("Moved to May 20.");
  });

  test("ask_user posts no result (M18: a waiting line instead, see test/tasks/m18.test.ts)", async () => {
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Pick a date", prompt: "Pick one" });
    t.llm.script("task", [call("ask_user", { question: "Which date?" })]);
    await t.fixture.runs.idle();
    expect(await notices(task.id)).toHaveLength(0);
  });

  test("doneText fills {title} and {id} literally", () => {
    expect(doneText("Done: [{title}](duet://tasks/{id})", { id: "t1", title: "Pay $& and $1 [now]" }, "  ")).toBe("Done: [Pay $& and $1 \\[now\\]](duet://tasks/t1)");
    // A literal "{id}" in the title stays in the title; the link still gets the task's id.
    expect(doneText("Done: [{title}](duet://tasks/{id})", { id: "t2", title: "Rename {id} field" })).toBe("Done: [Rename {id} field](duet://tasks/t2)");
  });
});

describe("add_update source", () => {
  const service = (apps?: (userId: string, name: string) => Promise<string | null>) =>
    new TaskService({ db: t.fixture.db, events: t.fixture.events, runs: t.fixture.runs, ...(apps ? { apps } : {}) });

  test("Claude, Claude's computer and known apps stay (as their display name); anything else becomes Claude", async () => {
    const known: Record<string, string> = { gmail: "Gmail", "google docs": "Google Docs" };
    const s = service(async (_userId, name) => known[name.toLowerCase()] ?? null);
    const cases: [string | undefined, string][] = [
      [undefined, "OpenDuet"], ["", "OpenDuet"], ["assistant", "OpenDuet"], ["Claude", "OpenDuet"],
      ["OpenDuet", "OpenDuet"], ["open duet", "OpenDuet"], ["Open Duet", "OpenDuet"], ["openduet", "OpenDuet"],
      ["Open Duet's computer", "OpenDuet's computer"],
      ["Claude's computer", "OpenDuet's computer"], ["claude’s computer", "OpenDuet's computer"], ["CLAUDES COMPUTER", "OpenDuet's computer"],
      ["OpenDuet's computer", "OpenDuet's computer"], ["open duet’s computer", "OpenDuet's computer"], ["OPEN DUETS COMPUTER", "OpenDuet's computer"],
      ["gmail", "Gmail"], [" Google Docs ", "Google Docs"],
      ["[CL]'s computer", "OpenDuet"], ["Google Maps", "OpenDuet"], ["My notes", "OpenDuet"],
    ];
    for (const [input, expected] of cases) expect(await s.updateSource(t.alex.userId, input)).toBe(expected);
  });

  test("without a catalog, or when the lookup fails, only Claude and Claude's computer pass", async () => {
    expect(await service().updateSource(t.alex.userId, "Gmail")).toBe("OpenDuet");
    expect(await service(async () => { throw new Error("upstream down"); }).updateSource(t.alex.userId, "Gmail")).toBe("OpenDuet");
    expect(await service().updateSource(t.alex.userId, "Claude's computer")).toBe("OpenDuet's computer");
    expect(await service().updateSource(t.alex.userId, "OpenDuet's computer")).toBe("OpenDuet's computer");
  });

  test("the add_update tool writes the whitelisted source", async () => {
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Sources", prompt: "x" });
    t.llm.script("task", [call("add_update", { text: "Checked the browser.", source: "claude's computer" }), call("add_update", { text: "Odd label.", source: "[CL]'s computer" }), call("ask_user", {})]);
    await t.fixture.runs.idle();
    const row = await t.fixture.db.task.findUniqueOrThrow({ where: { id: task.id } });
    const sources = (JSON.parse(row.updates) as { source: string }[]).map((u) => u.source);
    expect(sources).toEqual(["OpenDuet's computer", "OpenDuet"]);
  });

  test("ConnectorCatalog.knownApp: a connected app or a catalog toolkit by display name or slug, exact only", async () => {
    const fake = new FakeComposio();
    fake.connect(t.alex.userId, "gmail", "ca_1");
    const catalog = new ConnectorCatalog(fake);
    expect(await catalog.knownApp(t.alex.userId, "Gmail")).toBe("Gmail");
    expect(await catalog.knownApp(t.alex.userId, "gmail")).toBe("Gmail");
    expect(await catalog.knownApp(t.alex.userId, "google calendar")).toBe("Google Calendar");
    expect(await catalog.knownApp(t.alex.userId, "googledocs")).toBe("Google Docs");
    for (const name of ["Google Maps", "Gmai", "", "[CL]'s computer"]) expect(await catalog.knownApp(t.alex.userId, name)).toBeNull();
    class Down extends FakeComposio {
      override async listToolkits(): Promise<never> { throw new Error("down"); }
      override async listAccounts(): Promise<never> { throw new Error("down"); }
    }
    expect(await new ConnectorCatalog(new Down()).knownApp(t.alex.userId, "Gmail")).toBeNull();
  });
});

describe("language and delegation lines", () => {
  test("a task turn writes in User.language whatever its request is in; a chat turn follows the user", async () => {
    await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "zh-Hans" } });
    try {
      t.llm.script("chat", [text("好的。")]);
      await readSse(await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", { text: "Hi", clientId: "lang-1" })));
      const chat = t.llm.sent("chat").at(-1)!.system;
      expect(chat).toContain("Reply in the language the user writes in.");
      expect(chat).toContain("call start_task (or make_artifact");

      await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Find a venue", prompt: "Find a venue in Lisbon for 12 people" });
      t.llm.script("task", [call("ask_user", { question: "预算是多少？" })]);
      await t.fixture.runs.idle();
      const task = t.llm.sent("task").at(-1)!.system;
      expect(task).toContain("In this task, write everything for the user in User.language (zh-Hans)");
      expect(task).toContain("The task's request was written by OpenDuet, not the user");
      expect(task).not.toContain("Reply in the language the user writes in.");
    } finally {
      await t.fixture.db.user.update({ where: { id: t.alex.userId }, data: { language: "en" } });
    }
  });

  test("computer_exec is only for running programs; list/read/write/edit/search use file tools", () => {
    expect(descriptions.computer_exec).toContain("Only for running programs");
    expect(descriptions.computer_exec).toContain("computer_files_list / read / write / edit / search");
  });
});
