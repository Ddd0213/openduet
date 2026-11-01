// Who started a build (the M6 review): only builds the user started (Create, ↻, ✎) count as
// user-started, so their "ask" computer tools run without a card; make_artifact / edit_artifact from
// chat and scheduled refreshes don't. And one owner per deployment: another account gets no Make.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { buildTurn, call, chat, json, PAGE, startMake, text, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
let sam: SignedIn;
beforeAll(async () => {
  m = await startMake();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
});
afterAll(() => m.fixture.cleanup());

/** A build round that first notes whether the running build counts as user-started. */
function noting(seen: boolean[], turn: ScriptTurn): ScriptTurn {
  return async (request) => {
    const run = await m.fixture.db.run.findFirst({ where: { kind: "build", status: "running" }, orderBy: { createdAt: "desc" } });
    seen.push(!!run && m.artifacts.service.userStarted(run.id));
    return typeof turn === "function" ? turn(request) : turn;
  };
}

describe("user-started builds", () => {
  test("Create from the app is user-started; make_artifact from chat is not", async () => {
    const seen: boolean[] = [];
    m.llm.script("task", noting(seen, buildTurn(m)));
    const made = await m.fixture.app.request("/api/artifacts", json(m.alex, "POST", { type: "web_page", channelId: m.alex.mainChannelId, prompt: "A page for the bike shop" }));
    expect(made.status).toBe(200);
    await m.runs.idle();

    m.llm.script("chat", [call("make_artifact", { type: "doc", title: "Q3 brief", prompt: "A one-page brief" })], [text("On it.")]);
    m.llm.script("task", noting(seen, buildTurn(m, { html: "<h1>Q3</h1>" })));
    await chat(m, "Write me a brief", "t-1");
    await m.runs.idle();
    expect(seen).toEqual([true, false]);
  });

  test("a scheduled refresh is not user-started; ↻ from the app is", async () => {
    const row = await m.fixture.db.artifact.create({ data: {
      userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "dashboard", title: "Sales", prompt: "Sales", status: "ready", html: PAGE,
      refreshSchedule: JSON.stringify({ cadence: "hourly", hour: 0, minute: 0 }), updatedAt: new Date(Date.now() - 3 * 3600_000),
    } });
    const seen: boolean[] = [];
    m.llm.script("task", noting(seen, buildTurn(m)));
    expect(await m.artifacts.service.tick()).toBe(1);
    await m.runs.idle();
    m.llm.script("task", noting(seen, buildTurn(m)));
    expect((await m.fixture.app.request(`/api/artifacts/${row.id}/refresh`, json(m.alex, "POST"))).status).toBe(200);
    await m.runs.idle();
    expect(seen).toEqual([false, true]);
  });
});

describe("one owner per deployment", () => {
  test("another account can't build, refresh or edit, gets no make tools, and its schedule doesn't run", async () => {
    m.workspace.owner = m.alex.userId;
    try {
      const refused = await m.fixture.app.request("/api/artifacts", json(sam, "POST", { type: "web_page", channelId: sam.mainChannelId, prompt: "A page" }));
      expect(refused.status).toBe(503);
      expect((await errorOf(refused)).code).toBe("not_configured");
      const theirs = await m.fixture.db.artifact.create({ data: {
        userId: sam.userId, channelId: sam.mainChannelId, type: "dashboard", title: "Old", prompt: "Old", status: "ready", html: PAGE,
        refreshSchedule: JSON.stringify({ cadence: "hourly", hour: 0, minute: 0 }), updatedAt: new Date(Date.now() - 3 * 3600_000),
      } });
      expect((await m.fixture.app.request(`/api/artifacts/${theirs.id}/refresh`, json(sam, "POST"))).status).toBe(503);
      expect((await m.fixture.app.request(`/api/artifacts/${theirs.id}/edit`, json(sam, "POST", { prompt: "Bigger title" }))).status).toBe(503);
      expect(await m.artifacts.service.tick()).toBe(0);
      expect(await m.artifacts.service.usable(sam.userId)).toBe(false);
      expect(await m.artifacts.service.usable(m.alex.userId)).toBe(true);
      // Sam's chat: no make_artifact / edit_artifact, and Claude is told Make isn't set up.
      const before = m.llm.sent("chat").length;
      m.llm.script("chat", [text("I'll write it here.")]);
      const response = await m.fixture.app.request(`/api/channels/${sam.mainChannelId}/messages`, json(sam, "POST", { text: "Write me a doc", clientId: "s-1" }));
      expect(response.status).toBe(200);
      await m.runs.idle();
      const request = m.llm.sent("chat")[before]!;
      expect((request.tools ?? []).map((t) => t.name)).not.toContain("make_artifact");
      expect(request.system).toContain("isn't set up on this server");
    } finally {
      m.workspace.owner = null;
    }
  });
});
