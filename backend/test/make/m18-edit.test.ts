// M18a: edit_artifact while the first build is still building: the edit is kept (queued) and runs
// right after the build; when the build fails it's folded into the prompt so a retry includes it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpError } from "../../src/http.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { deferred } from "../tasks/harness.ts";
import { buildTurn, call, chat, startMake, text, toolResults, type MakeApp } from "./harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); });
afterAll(() => m.fixture.cleanup());

const gated = (gate: Promise<void>, turn: ScriptTurn): ScriptTurn => async (request) => {
  await gate;
  return typeof turn === "function" ? turn(request) : turn;
};
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
};
const isBuilding = (id: string) => async () => m.llm.sent("task").some((r) => r.system?.includes("This is a Make build") && JSON.stringify(r.messages).includes(id));

describe("edit_artifact during the first build", () => {
  test("queued (the chat tool says so), then applied as one edit right after the build", async () => {
    const gate = deferred();
    m.llm.script("task", gated(gate.promise, buildTurn(m, { html: "<h1>Agenda</h1>" })), buildTurn(m, { html: "<h1>Agenda</h1><p data-duet-changed>Blue</p>" }));
    const artifact = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Offsite agenda", title: "Agenda" });
    await until(isBuilding(artifact.id));

    m.llm.script("chat", [call("edit_artifact", { artifactId: artifact.id, prompt: "Make the title blue." }, "ed-1")], [text("I'll change it once it's built.")]);
    await chat(m, "Make the title blue", "m18e-1");
    const results = toolResults(m.llm.sent("chat").at(-1));
    expect(results).toContain('\\"status\\":\\"queued\\"');
    expect(results).toContain("It's still being built; the change is applied right after.");
    const direct = await m.artifacts.service.requestEdit({ userId: m.alex.userId, id: artifact.id, prompt: "Add the dinner.", startedBy: "assistant" });
    expect(direct).toMatchObject({ queued: true, artifact: { id: artifact.id, status: "building" } });

    gate.resolve();
    await m.runs.idle();
    const builds = m.llm.sent("task").filter((r) => r.system?.includes("This is a Make build") && JSON.stringify(r.messages).includes(artifact.id));
    expect(builds).toHaveLength(2);
    const edit = JSON.stringify(builds[1]!.messages);
    expect(edit).toContain("Make the title blue.\\n\\nAdd the dinner.");
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).status).toBe("ready");
  });

  test("the first build fails: the kept edits join the prompt (\"Also: ...\"); no page and nothing building is still 400", async () => {
    const gate = deferred();
    m.llm.script("task", gated(gate.promise, [text("I couldn't finish.")]));
    const artifact = await m.artifacts.service.create({ userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", prompt: "Menu", title: "Menu" });
    await until(isBuilding(artifact.id));
    expect((await m.artifacts.service.requestEdit({ userId: m.alex.userId, id: artifact.id, prompt: "Add a vegan option." })).queued).toBe(true);
    gate.resolve();
    await m.runs.idle();
    const row = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(row.status).toBe("failed");
    expect(row.prompt).toBe("Menu\n\nAlso: Add a vegan option.");
    const refused = await m.artifacts.service.edit({ userId: m.alex.userId, id: artifact.id, prompt: "x" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(400);
  });
});
