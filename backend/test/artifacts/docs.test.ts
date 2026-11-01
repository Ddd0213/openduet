// Documents in chat (L181): asking Claude for a doc runs make_artifact(type doc) -> a Docs build in
// the background -> the card in this thread (a task's own session when asked there); edit_artifact
// is ✎ by chat.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { offeredNames } from "../helpers/offered.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { buildTurn, call, chat, json, startMake, text, timeline, toolResults, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); });
afterAll(() => m.fixture.cleanup());

describe("make_artifact (doc)", () => {
  test("a doc asked for in chat builds in the background and lands in the thread as a card", async () => {
    m.llm.script("chat", [text("On it, writing the brief."), call("make_artifact", { type: "doc", title: "Q3 brief", prompt: "A one-page brief on Q3 for the team" })], [text("It'll show up here when it's done.")]);
    m.llm.script("task", buildTurn(m, { html: "<h1>Q3 brief</h1><p>Revenue grew.</p>", step: "Outlining the brief" }));
    const frames = await chat(m, "Write me a brief on Q3", "d-1");
    expect(frames.events.at(-1)?.type).toBe("done");
    const chatRequest = m.llm.sent("chat")[0]!;
    expect(offeredNames(chatRequest)).toEqual(expect.arrayContaining(["make_artifact", "edit_artifact", "propose_skill", "react"]));
    expect(offeredNames(chatRequest)).not.toContain("make_doc");
    expect(chatRequest.system).toContain("call make_artifact");
    expect(toolResults(m.llm.sent("chat")[1])).toContain("\\\"status\\\":\\\"building\\\"");
    await m.runs.idle();

    const row = await m.fixture.db.artifact.findFirst({ where: { userId: m.alex.userId, type: "docs" } });
    expect([row?.status, row?.title, row?.channelId]).toEqual(["ready", "Q3 brief", m.alex.mainChannelId]);
    expect(row?.prompt).toContain("A one-page brief on Q3");
    // a fragment gets wrapped into a full document with the base
    expect(row?.html).toContain("<main class=\"duet-page\"><h1>Q3 brief</h1>");
    const thread = await timeline(m);
    const kinds = thread.map((x) => (x.kind === "system" ? x.payload.phrase.key : x.kind));
    expect(kinds.slice(-4)).toEqual(["text", "text", "system.made_doc", "artifact"]);
    expect(thread.some((x) => x.text.includes("Outlining the brief"))).toBe(false);
  });

  test("asked in a task's own session, the card lands in that session", async () => {
    const task = await m.tasks.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, title: "Prep the offsite", prompt: "Prep the offsite" });
    m.llm.script("task", [call("make_artifact", { type: "doc", title: "Offsite agenda", prompt: "Agenda for the offsite" })]);
    // The task's next round and the build it started both use the "task" role and run at once, so
    // each scripted round answers by what the request is, not by which arrives first.
    const build = buildTurn(m, { html: "<h1>Offsite agenda</h1>" });
    const either: ScriptTurn = (request) => {
      if (!request.system?.includes("This is a Make build")) return [text("Started the agenda.")];
      if (typeof build !== "function") throw new Error("buildTurn returns a function");
      return build(request);
    };
    // the third round: the carry-on turn the settled build gives the task (M14a review #1)
    m.llm.script("task", either, either, either);
    await m.runs.idle();
    const card = await m.fixture.db.message.findFirst({ where: { userId: m.alex.userId, kind: "artifact", taskId: task.id } });
    expect(card).not.toBeNull();
    expect(await m.fixture.db.message.count({ where: { kind: "system", taskId: task.id, payload: { contains: "system.made_doc" } } })).toBe(1);
    // the build settled while the task was open: one carry-on turn, and it didn't fail
    const runs = await m.fixture.db.run.findMany({ where: { taskId: task.id, kind: "task" }, select: { status: true } });
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
  });
});

describe("make_artifact (dashboard)", () => {
  test("a dashboard asked for in chat builds with the dashboard template and lands as a card", async () => {
    const statuses = (frames: Awaited<ReturnType<typeof chat>>) => frames.events.flatMap((e) => (e.type === "status" ? [e.payload.status] : []));
    m.llm.script("chat", [call("make_artifact", { type: "dashboard", title: "Signup funnel", prompt: "Daily signups and conversion for the last 30 days" })], [text("Building it now.")]);
    m.llm.script("task", (request) => {
      // The build is a dashboard build: the dashboard template and the chart helper are in its brief.
      expect(JSON.stringify(request.messages)).toContain("duetBars");
      const turn = buildTurn(m, { data: { signups: 1204, conversion: 20 }, html: "<h1>Signup funnel</h1><p>Signups: 1,204; Conversion: 20%</p>", metrics: [{ label: "Signups", value: 1204, unit: null }, { label: "Conversion", value: 20, unit: "%" }] });
      if (typeof turn !== "function") throw new Error("buildTurn returns a function");
      return turn(request);
    });
    const frames = await chat(m, "Make me a dashboard of our signup funnel", "d-dash");
    expect(statuses(frames)).toContain("working");
    expect(statuses(frames)).not.toContain("writing_draft");
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("\\\"type\\\":\\\"dashboard\\\"");
    await m.runs.idle();
    const row = await m.fixture.db.artifact.findFirst({ where: { userId: m.alex.userId, title: "Signup funnel" } });
    expect([row?.type, row?.status]).toEqual(["dashboard", "ready"]);
    const thread = await timeline(m);
    const kinds = thread.map((x) => (x.kind === "system" ? x.payload.phrase.key : x.kind));
    expect(kinds.slice(-2)).toEqual(["system.made_dashboard", "artifact"]);
  });

  test("a doc reads Writing a draft; an unknown type is an error result", async () => {
    const statuses = (frames: Awaited<ReturnType<typeof chat>>) => frames.events.flatMap((e) => (e.type === "status" ? [e.payload.status] : []));
    m.llm.script("chat", [call("make_artifact", { type: "spreadsheet", title: "X", prompt: "Y" })], [text("That type isn't supported.")]);
    const frames = await chat(m, "Make a spreadsheet", "d-bad");
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("Invalid tool arguments");
    expect(statuses(frames)).not.toContain("writing_draft");
    m.llm.script("chat", [call("make_artifact", { type: "doc", title: "Notes", prompt: "Meeting notes" })], [text("On it.")]);
    m.llm.script("task", buildTurn(m, { html: "<h1>Notes</h1>" }));
    expect(statuses(await chat(m, "Write the notes", "d-doc"))).toContain("writing_draft");
    await m.runs.idle();
  });
});

describe("edit_artifact", () => {
  test("✎ by chat edits the page in place and updates the card (no new card)", async () => {
    const row = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Q3 brief" } });
    m.llm.script("chat", (request) => {
      expect(request.system).toContain(row.id); // the newest artifacts are in the instructions
      return [call("edit_artifact", { artifactId: row.id, prompt: "Add a risks section" })];
    }, [text("Adding it now.")]);
    m.llm.script("task", buildTurn(m, { html: "<h1>Q3 brief</h1><p>Revenue grew.</p><section data-duet-changed><h2>Risks</h2></section>" }));
    const cardsBefore = await m.fixture.db.message.count({ where: { kind: "artifact", payload: { contains: row.id } } });
    await chat(m, "Add a risks section to the Q3 brief", "d-2");
    await m.runs.idle();
    const updated = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.html).toContain("<h2>Risks</h2>");
    expect(await m.fixture.db.message.count({ where: { kind: "artifact", payload: { contains: row.id } } })).toBe(cardsBefore);
    const html = await (await m.fixture.app.request(`/api/artifacts/${row.id}/html`, json(m.alex, "GET"))).text();
    expect(html).toContain("<section data-duet-changed>");
  });

  test("someone else's artifact id is an error result, not an edit", async () => {
    m.llm.script("chat", [call("edit_artifact", { artifactId: "not-mine", prompt: "x" })], [text("I couldn't find it.")]);
    await chat(m, "Edit that", "d-3");
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("not_found");
  });
});
