// M14 B5 deliverables are grounded (nanomuse-harness-2 N4/N5): finish_task refuses while a Make
// build the task started is still building or a checklist step is open; a failed build of the task
// adds an update and moves it back to needs_input; one that succeeds after the task finished adds
// the page as a resource; add_resource only takes duet:// ids that exist and belong to the user.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TaskDetail } from "../../src/contract/tasks.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import { taskBuilds } from "../../src/tasks/builds.ts";
import { FAILED_CARRY_ONS } from "../../src/tasks/service.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { signUp } from "../helpers/session.ts";
import { buildTurn, call, json, startMake, text, type MakeApp } from "../make/harness.ts";
import { deferred } from "./harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); });
afterAll(() => m.fixture.cleanup());

const detail = async (taskId: string) => TaskDetail.parse(await (await m.fixture.app.request(`/api/tasks/${taskId}`, { headers: m.alex.headers })).json());
const isBuild = (request: LlmRequest) => !!request.system?.includes("This is a Make build");

/**
 * A task's rounds and the builds it starts share the "task" role and can run at once, so one
 * dispatcher per expected request answers from the right queue by what the request is.
 */
function script(taskRounds: ScriptTurn[], buildRounds: ScriptTurn[]): void {
  const queues = { task: [...taskRounds], build: [...buildRounds] };
  const either: ScriptTurn = (request) => {
    const next = (isBuild(request) ? queues.build : queues.task).shift();
    if (!next) throw new Error(`no ${isBuild(request) ? "build" : "task"} round scripted`);
    return typeof next === "function" ? next(request) : next;
  };
  m.llm.script("task", ...Array.from({ length: taskRounds.length + buildRounds.length }, () => either));
}

/** A round that answers only once `gate` resolves (the build stays "building" until then). */
const gated = (gate: Promise<void>, turn: ScriptTurn): ScriptTurn => async (request) => {
  await gate;
  return typeof turn === "function" ? turn(request) : turn;
};

/** The tool_result the task's session got for one call id. */
function resultFor(id: string): { isError: boolean; text: string } {
  for (const request of m.llm.sent("task")) {
    for (const message of request.messages) {
      for (const block of message.content) {
        if (block.type === "tool_result" && block.toolUseId === id) {
          return { isError: !!block.isError, text: block.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") };
        }
      }
    }
  }
  throw new Error(`no tool_result for ${id}`);
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** The messages of the task turn whose request is the carry-on note for this artifact (JSON). */
function carryOnRequest(artifactId: string): string {
  const found = m.llm.sent("task").filter((r) => !isBuild(r)).map((r) => JSON.stringify(r.messages))
    .find((s) => s.includes("[Server note, not from the user] The Make build") && s.includes(`duet://artifacts/${artifactId}`));
  if (!found) throw new Error(`no carry-on turn for ${artifactId}`);
  return found;
}
/** M18: result messages of a task on the main timeline (taskResult on the payload). */
const results = (taskId: string) => m.fixture.db.message.count({ where: { userId: m.alex.userId, taskId: null, role: "assistant", kind: "text", payload: { contains: `"taskResult":{"taskId":"${taskId}"` } } });
const statusIs = (taskId: string, status: string) => async () => (await m.fixture.db.task.findUnique({ where: { id: taskId } }))?.status === status;
const newTask = (title: string) => m.tasks.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, title, prompt: title });

describe("finish_task", () => {
  test("refuses while a build the task started is still building; once it's built the session carries on by itself and finishes", async () => {
    const gate = deferred();
    const build = buildTurn(m, { html: "<h1>Offsite agenda</h1>" });
    script(
      [
        [call("make_artifact", { type: "doc", title: "Offsite agenda", prompt: "Agenda for the offsite" })], [call("finish_task", { summary: "Agenda done." }, "fin-1")], [text("Noted.")],
        // the carry-on turn the settled build queues (nobody calls continueTask)
        [call("finish_task", { summary: "Agenda done." })],
      ],
      [gated(gate.promise, build)],
    );
    const task = await newTask("Prep the offsite");
    await until(statusIs(task.id, "needs_input"), "the task turn to end");
    const refused = resultFor("fin-1");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("A Make build this task started is still building");
    const artifact = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Offsite agenda" } });
    expect(refused.text).toContain(artifact.id);
    expect(taskBuilds.building(task.id)).toEqual([artifact.id]);

    gate.resolve();
    await m.runs.idle();
    expect(taskBuilds.building(task.id)).toEqual([]);
    // finish_task ends the turn when it's accepted, so the status is what shows it went through
    // (M18: resolved, since nothing of the user's was touched; a build run has no taskId)
    const d = await detail(task.id);
    expect(d.status).toBe("resolved");
    // built while the task was still open: the card is in the session; M22 (A P2-8) the page it made
    // is a resource too, derived from that card (once, by its link)
    expect(d.resources).toEqual([{ title: "Offsite agenda", type: "artifact", link: `duet://artifacts/${artifact.id}`, app: null }]);
    // exactly one carry-on turn, whose request names the built page and says to finish now
    expect(await m.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } })).toBe(2);
    const carry = carryOnRequest(artifact.id);
    expect(carry).toContain("is built; its card is in this task's thread.");
    expect(carry).toContain("call finish_task now");
    // the card was posted before the carry-on turn read its context (M18 history line: [artifact "<title>" ready])
    expect(carry).toContain(`[artifact \\"Offsite agenda\\" ready id=\\"${artifact.id}\\"]`);
    // and the result went out once
    expect(await results(task.id)).toBe(1);
  });

  test("built while the task's own turn still runs: that turn finishes it, and no carry-on turn follows", async () => {
    const built = deferred();
    script(
      [
        [call("make_artifact", { type: "doc", title: "Seating plan", prompt: "Who sits where" })],
        // still the first turn: it answers only after the build's card is in the thread
        gated(built.promise, [call("finish_task", { summary: "Seating plan done." }, "fin-s")]),
      ],
      [buildTurn(m, { html: "<h1>Seating plan</h1>" })],
    );
    const task = await newTask("Plan the seating");
    await until(async () => (await m.fixture.db.message.count({ where: { taskId: task.id, kind: "artifact" } })) > 0, "the build's card");
    built.resolve();
    await m.runs.idle();
    expect((await detail(task.id)).status).toBe("resolved");
    // the carry-on waited for the running turn, which ended done (M18: resolved): nothing more to do
    expect(await m.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } })).toBe(1);
    expect(await results(task.id)).toBe(1);
  });

  test("refuses while a step is planned or current, naming them; closing the checklist lets it finish", async () => {
    m.llm.script("task",
      [call("set_steps", { steps: [{ text: "Find a venue", state: "done" }, { text: "Draft the agenda", state: "current" }, { text: "Book flights", state: "planned" }] }), call("finish_task", {}, "fin-3")],
      [text("Still on the agenda.")],
    );
    const task = await newTask("Plan the offsite");
    await m.runs.idle();
    const refused = resultFor("fin-3");
    expect(refused.isError).toBe(true);
    const body = JSON.parse(refused.text) as { error: string; openSteps: string[] };
    expect(body.error).toStartWith("2 step(s) of the checklist are still planned or current (\"Draft the agenda\", \"Book flights\").");
    expect(body.openSteps).toEqual(["Draft the agenda", "Book flights"]);
    expect((await detail(task.id)).status).toBe("needs_input");

    m.llm.script("task", [call("set_steps", { steps: [{ text: "Find a venue", state: "done" }, { text: "Draft the agenda", state: "done" }] }), call("finish_task", { summary: "All set." })]);
    await m.tasks.service.continueTask(task.id, "carry on");
    await m.runs.idle();
    expect((await detail(task.id)).status).toBe("resolved");
  });
});
describe("a build the task started settles", () => {
  test("failed while the task waited: one carry-on turn says why, Claude tells the user, the task stays needs_input", async () => {
    const gate = deferred();
    script(
      [
        [call("make_artifact", { type: "doc", title: "Venue shortlist", prompt: "Three venues in Lisbon" })], [call("finish_task", {}, "fin-v")], [text("It's building.")],
        // the carry-on turn the failed build queues
        [text("The venue shortlist couldn't be built. Want me to try again?")],
      ],
      // the build ends without finish_build: artifact.not_finished
      [gated(gate.promise, [text("Looking at venues\n")])],
    );
    const task = await newTask("Shortlist venues");
    await until(statusIs(task.id, "needs_input"), "the task turn to end");
    expect(resultFor("fin-v").isError).toBe(true);
    gate.resolve();
    await m.runs.idle();
    const artifact = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Venue shortlist" } });
    expect(artifact.status).toBe("failed");
    expect(await m.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } })).toBe(2);
    const carry = carryOnRequest(artifact.id);
    expect(carry).toContain("couldn't be built: OpenDuet couldn't finish this. Try again or change the request.");
    expect(carry).toContain("Tell the user in User.language what couldn't be built and why");
    const d = await detail(task.id);
    expect(d.status).toBe("needs_input");
    expect(d.latestUpdate).toMatchObject({ source: "OpenDuet", text: { key: "task.build_failed" } });
    expect(await m.fixture.db.message.count({ where: { taskId: task.id, role: "assistant", kind: "text", text: { contains: "couldn't be built. Want me to try again?" } } })).toBe(1);
  });

  test("failed: the task gets \"<title> couldn't be built: <reason>\" and goes back to needs_input", async () => {
    const gate = deferred();
    script(
      [[call("make_artifact", { type: "doc", title: "Venue shortlist", prompt: "Three venues in Lisbon" })], [text("It's building.")]],
      // the build ends without finish_build: artifact.not_finished
      [gated(gate.promise, [text("Looking at venues\n")])],
    );
    const task = await newTask("Find a venue");
    await until(statusIs(task.id, "needs_input"), "the task turn to end");
    // the user (or a later turn) had moved it on: a failure still brings it back
    await m.fixture.db.task.update({ where: { id: task.id }, data: { status: "ready_for_review" } });
    gate.resolve();
    await m.runs.idle();
    const d = await detail(task.id);
    expect(d.status).toBe("needs_input");
    expect(d.latestUpdate).toMatchObject({
      source: "OpenDuet",
      text: { key: "task.build_failed", params: { title: { type: "text", value: "Venue shortlist" }, reason: { type: "text", value: "OpenDuet couldn't finish this. Try again or change the request." } } },
    });
    expect(taskBuilds.building(task.id)).toEqual([]);
    const events = await m.fixture.db.event.findMany({ where: { userId: m.alex.userId, type: "task" }, orderBy: { id: "desc" }, take: 1 });
    expect(events[0]?.payload).toContain("\"needs_input\"");
    // it was ready for review when the build failed: it waits for the user, no carry-on turn
    expect(await m.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } })).toBe(1);
  });

  test("succeeded after the task was finished: the page is added as a resource", async () => {
    const gate = deferred();
    script(
      [[call("make_artifact", { type: "doc", title: "Packing list", prompt: "What to bring" })], [text("It's building.")]],
      [gated(gate.promise, buildTurn(m, { html: "<h1>Packing list</h1>" }))],
    );
    const task = await newTask("Pack for the trip");
    await until(statusIs(task.id, "needs_input"), "the task turn to end");
    const resolved = await m.fixture.app.request(`/api/tasks/${task.id}`, json(m.alex, "PATCH", { status: "resolved" }));
    expect(resolved.status).toBe(200);
    gate.resolve();
    await m.runs.idle();
    const artifact = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Packing list" } });
    expect(artifact.status).toBe("ready");
    const d = await detail(task.id);
    expect(d.status).toBe("resolved");
    expect(d.resources).toEqual([{ title: "Packing list", type: "artifact", link: `duet://artifacts/${artifact.id}`, app: null }]);
  });
});

describe("a build that keeps failing", () => {
  test(`at most ${FAILED_CARRY_ONS} carry-on turns in a row for failed builds; a built page starts the count again`, async () => {
    m.llm.script("task", [text("Starting on it.")]);
    const task = await newTask("Build the price list");
    await m.runs.idle();
    await m.fixture.db.task.update({ where: { id: task.id }, data: { status: "needs_input" } });
    const runs = () => m.fixture.db.run.count({ where: { taskId: task.id, kind: "task" } });
    const failed = { artifactId: "art_prices", ok: false as const, title: "Price list", reason: { key: "artifact.not_finished" } };
    const before = await runs();
    for (let i = 0; i < FAILED_CARRY_ONS; i++) {
      m.llm.script("task", [text(`Couldn't build it (${i + 1}).`)]);
      await m.tasks.service.carryOnAfterBuild(task.id, [failed]);
      await m.runs.idle();
    }
    expect(await runs()).toBe(before + FAILED_CARRY_ONS);
    // the next failure in a row queues nothing: the task waits for the user
    await m.tasks.service.carryOnAfterBuild(task.id, [failed]);
    await m.runs.idle();
    expect(await runs()).toBe(before + FAILED_CARRY_ONS);
    expect(m.llm.remaining("task")).toBe(0);
    // a page that did build: carried on, and failures count from 0 again
    m.llm.script("task", [text("Built it.")], [text("Failed again.")]);
    await m.tasks.service.carryOnAfterBuild(task.id, [{ artifactId: "art_prices", ok: true, title: "Price list", artifactType: "doc" }]);
    await m.runs.idle();
    await m.fixture.db.task.update({ where: { id: task.id }, data: { status: "needs_input" } });
    await m.tasks.service.carryOnAfterBuild(task.id, [failed]);
    await m.runs.idle();
    expect(await runs()).toBe(before + FAILED_CARRY_ONS + 2);
  });
});

describe("add_resource", () => {
  test("a duet:// artifact or task id must exist and be the user's; an error result names the id", async () => {
    const sam = await signUp(m.fixture, "sam_deliverables", "Sam Lee");
    const theirs = await m.fixture.db.artifact.create({ data: { userId: sam.userId, channelId: sam.mainChannelId, type: "docs", title: "Sam's doc", prompt: "x", status: "ready" } });
    const mine = await m.fixture.db.artifact.create({ data: { userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", title: "Budget", prompt: "x", status: "ready" } });
    m.llm.script("task",
      [
        call("add_resource", { title: "Made up", type: "artifact", link: "duet://artifacts/art_made_up" }, "res-1"),
        call("add_resource", { title: "Not mine", type: "artifact", link: `duet://artifacts/${theirs.id}` }, "res-2"),
        call("add_resource", { title: "Ghost task", type: "link", link: "duet://tasks/task_ghost" }, "res-3"),
        call("add_resource", { title: "Budget", type: "artifact", link: `duet://artifacts/${mine.id}` }, "res-4"),
      ],
      [text("Attached the budget.")],
    );
    const task = await newTask("Collect the docs");
    await m.runs.idle();
    for (const [id, missing] of [["res-1", "art_made_up"], ["res-2", theirs.id], ["res-3", "task_ghost"]]) {
      const result = resultFor(id!);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`with id ${missing}`);
    }
    expect(resultFor("res-4").isError).toBe(false);
    expect((await detail(task.id)).resources).toEqual([{ title: "Budget", type: "artifact", link: `duet://artifacts/${mine.id}`, app: null }]);
  });
});
