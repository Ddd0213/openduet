// M20 (#36, the 09:54 incident): a Make build the user's Take over stopped fails with
// artifact.user_in_control ("You're using Claude's browser ..."), not the generic
// artifact.not_finished / workspace_unreachable, in the event and the thread.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { noteBuildStop } from "../../src/computer/build-stops.ts";
import { ComputerError } from "../../src/computer/client.ts";
import { ArtifactResponse } from "../../src/contract/artifacts.ts";
import { buildTurn, json, lastEventId, ofType, startMake, storedEvents, text, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); });
afterAll(() => m.fixture.cleanup());

const api = (path: string, init: RequestInit = {}) => m.fixture.app.request(path, init);

/** The artifact's terminal build status and the thread's grey lines since `before`. */
async function outcome(id: string, before: number) {
  const events = await storedEvents(m.fixture, m.alex.userId, before);
  const last = ofType(events, "artifact").filter((e) => e.payload.artifact.id === id).at(-1)!;
  const lines = events.flatMap((e) => (e.type === "message" && e.payload.message.kind === "system" ? [e.payload.message.payload.phrase.key] : []));
  return { status: last.payload.artifact.status, reason: last.payload.buildStatus, lines };
}

describe("a build stopped by the user's Take over", () => {
  test("the turn gave up waiting for the browser: the build fails with artifact.user_in_control", async () => {
    const before = await lastEventId(m.fixture);
    // What the computer provider does when a build's tool meets the user in control (stopForUser).
    m.llm.script("task", async () => {
      const run = await m.fixture.db.run.findFirstOrThrow({ where: { userId: m.alex.userId, kind: "build", status: "running" }, orderBy: { createdAt: "desc" } });
      noteBuildStop(run.id, "user_in_control");
      return [text("The user is using the browser; stopping.")];
    });
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "web_page", prompt: "A page for the shop", channelId: m.alex.mainChannelId }));
    const id = ArtifactResponse.parse(await res.json()).artifact.id;
    await m.runs.idle();
    const got = await outcome(id, before);
    expect(got).toMatchObject({ status: "failed", reason: { key: "artifact.user_in_control" } });
    expect(got.lines).toContain("artifact.user_in_control");
    expect(got.lines).not.toContain("artifact.not_finished");
  });

  test("the computer refused the page's write before the run (prepare): artifact.user_in_control, not unreachable", async () => {
    m.llm.script("task", buildTurn(m, { title: "Shop" }));
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "web_page", prompt: "Another page", channelId: m.alex.mainChannelId }));
    const id = ArtifactResponse.parse(await res.json()).artifact.id;
    await m.runs.idle();
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id } })).status).toBe("ready");
    const before = await lastEventId(m.fixture);
    const write = m.workspace.writeFile.bind(m.workspace);
    m.workspace.writeFile = async () => { throw new ComputerError("human_in_control", 409, "A person has control."); };
    try {
      await api(`/api/artifacts/${id}/refresh`, json(m.alex, "POST"));
      await m.runs.idle();
    } finally {
      m.workspace.writeFile = write;
    }
    const got = await outcome(id, before);
    // A refresh keeps the last good version; the reason says why this one didn't run.
    expect(got).toMatchObject({ status: "ready", reason: { key: "artifact.user_in_control" } });
  });

  test("a build that just didn't finish still says not_finished", async () => {
    const before = await lastEventId(m.fixture);
    m.llm.script("task", [text("I couldn't get to the data.")]);
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "slides", prompt: "A deck", channelId: m.alex.mainChannelId }));
    const id = ArtifactResponse.parse(await res.json()).artifact.id;
    await m.runs.idle();
    expect((await outcome(id, before)).reason).toEqual({ key: "artifact.not_finished" });
  });
});
