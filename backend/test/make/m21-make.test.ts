// M21 W3 (#9, #10, #18, #46): Make edits and refreshes report progress and failure in
// editStatus / refreshStatus (status stays "ready"); the page Claude reads and saves back carries no
// injected code; edit_page changes part of the page; the shrink guard refuses a much shorter page
// (artifact.page_shrank); Retry rebuilds the same artifact with the trust of who started it; a
// saved edit / refresh asked for in the chat says so there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pageSize, replaceText, shrank, SHRINK_MIN_CHARS } from "../../src/artifacts/page-edit.ts";
import { ComputerError } from "../../src/computer/client.ts";
import { ArtifactResponse } from "../../src/contract/artifacts.ts";
import { ARTIFACT_CSP, BASE_CSS, BASE_SCRIPT, CHANGED_ATTR, CHART_SCRIPT, stripInjected, withBase } from "../../src/make/base.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { deferred } from "../tasks/harness.ts";
import { buildTurn, call, chat, json, lastEventId, ofType, PAGE, startMake, storedEvents, text, toolResults, type MakeApp } from "./harness.ts";

let m: MakeApp;
beforeAll(async () => { m = await startMake(); });
afterAll(() => m.fixture.cleanup());

const api = (path: string, init: RequestInit = {}) => m.fixture.app.request(path, init);
const pathOf = (id: string) => `artifacts/${id}/index.html`;

/** The artifact events of one artifact since `after`: [status, editStatus, refreshStatus]. */
async function statuses(id: string, after: number) {
  const events = ofType(await storedEvents(m.fixture, m.alex.userId, after), "artifact").filter((e) => e.payload.artifact.id === id);
  return events.map((e) => [e.payload.artifact.status, e.payload.editStatus, e.payload.refreshStatus] as const);
}

/** Phrase keys of the grey lines posted since `after`. */
async function lines(after: number) {
  return (await storedEvents(m.fixture, m.alex.userId, after)).flatMap((e) =>
    e.type === "message" && e.payload.message.kind === "system" ? [e.payload.message.payload.phrase] : []);
}

/** A long page (well over SHRINK_MIN_CHARS): `n` sections with a heading and a paragraph each. */
function longPage(n = 40): string {
  const sections = Array.from({ length: n }, (_, i) => `<section><h2>Part ${i}</h2><p>Notes for part ${i}: what we found, who owns it and what comes next.</p></section>`).join("");
  return `<!doctype html><html lang="en"><head><title>Plan</title></head><body><main class="duet-page"><h1>Plan</h1>${sections}</main></body></html>`;
}

/** A ready artifact whose stored page went through withBase, as finish_build stores it. */
async function seedReady(page = PAGE, data: Record<string, unknown> = {}) {
  return m.fixture.db.artifact.create({ data: {
    userId: m.alex.userId, channelId: m.alex.mainChannelId, type: "docs", title: "Plan", prompt: "A plan",
    status: "ready", html: withBase(page, { lang: "en", title: "Plan" }), ...data,
  } });
}

/** A build round that only calls tools (no page write), e.g. edit_page then finish_build. */
const tools = (...calls: ReturnType<typeof call>[]): ScriptTurn => [text("Changing the page\n"), ...calls];
const finishOf = (id: string) => call("finish_build", { path: `/workspace/${pathOf(id)}` });

/** Notes whether the running build counts as user-started (trust), then plays `turn`. */
function noting(seen: boolean[], turn: ScriptTurn): ScriptTurn {
  return async (request) => {
    const run = await m.fixture.db.run.findFirst({ where: { kind: "build", status: "running" }, orderBy: { createdAt: "desc" } });
    seen.push(!!run && m.artifacts.service.userStarted(run.id));
    return typeof turn === "function" ? turn(request) : turn;
  };
}

const WORKING = { state: "working" as const, reason: null };

describe("edit / refresh status (#9)", () => {
  test("✎ from the viewer: editStatus working until the page is saved, then null; status stays ready", async () => {
    const row = await seedReady();
    const before = await lastEventId(m.fixture);
    m.llm.script("task", buildTurn(m, { html: PAGE.replace("<p>Open 9 to 6.</p>", `<p ${CHANGED_ATTR}>Open 8 to 6.</p>`) }));
    expect((await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Open at 8" }))).status).toBe(200);
    await m.runs.idle();
    const got = await statuses(row.id, before);
    expect(got.at(-1)).toEqual(["ready", null, null]);
    expect(got.slice(0, -1).length).toBeGreaterThanOrEqual(2);
    for (const event of got.slice(0, -1)) expect(event).toEqual(["ready", WORKING, null]);
  });

  test("an edit that gives up: failed with the reason (page kept, ready); a rename keeps saying so; the next saved edit clears it", async () => {
    const row = await seedReady();
    const before = await lastEventId(m.fixture);
    m.llm.script("task", [text("I couldn't do that.")]);
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Make it pink" }));
    await m.runs.idle();
    const got = await statuses(row.id, before);
    expect(got.at(-1)).toEqual(["ready", { state: "failed", reason: { key: "artifact.not_finished" } }, null]);
    expect(got.slice(0, -1).every(([status, edit]) => status === "ready" && edit?.state === "working")).toBe(true);
    const stored = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } });
    expect([stored.status, stored.html]).toEqual(["ready", row.html]);

    const renamed = await lastEventId(m.fixture);
    await api(`/api/artifacts/${row.id}`, json(m.alex, "PATCH", { title: "Plan v2" }));
    expect((await statuses(row.id, renamed)).at(-1)?.[1]).toEqual({ state: "failed", reason: { key: "artifact.not_finished" } });

    const retried = await lastEventId(m.fixture);
    m.llm.script("task", buildTurn(m));
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Make it pink" }));
    await m.runs.idle();
    const again = await statuses(row.id, retried);
    expect(again[0]).toEqual(["ready", WORKING, null]); // a new edit replaces the old failure
    expect(again.at(-1)).toEqual(["ready", null, null]);
  });

  test("↻: refreshStatus working then null; a refresh the computer refused says failed with artifact.user_in_control", async () => {
    const row = await seedReady();
    const before = await lastEventId(m.fixture);
    m.llm.script("task", buildTurn(m));
    await api(`/api/artifacts/${row.id}/refresh`, json(m.alex, "POST"));
    await m.runs.idle();
    const ok = await statuses(row.id, before);
    expect(ok[0]).toEqual(["ready", null, WORKING]);
    expect(ok.at(-1)).toEqual(["ready", null, null]);

    const refused = await lastEventId(m.fixture);
    const write = m.workspace.writeFile.bind(m.workspace);
    m.workspace.writeFile = async () => { throw new ComputerError("human_in_control", 409, "A person has control."); };
    try {
      await api(`/api/artifacts/${row.id}/refresh`, json(m.alex, "POST"));
      await m.runs.idle();
    } finally {
      m.workspace.writeFile = write;
    }
    const got = await statuses(row.id, refused);
    expect(got.at(-1)).toEqual(["ready", null, { state: "failed", reason: { key: "artifact.user_in_control" } }]);
  });

  test("a first build reports buildStatus only (edit / refresh status stay null)", async () => {
    const before = await lastEventId(m.fixture);
    m.llm.script("task", buildTurn(m));
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "docs", prompt: "A brief", channelId: m.alex.mainChannelId }));
    const id = ArtifactResponse.parse(await res.json()).artifact.id;
    await m.runs.idle();
    const got = await statuses(id, before);
    expect(got.every(([, edit, refresh]) => edit === null && refresh === null)).toBe(true);
    expect(got.at(-1)?.[0]).toBe("ready");
  });
});

const once = (html: string, needle: string) => html.split(needle).length - 1;

describe("write-back without injected code (#10)", () => {
  test("read -> edit -> save: the page Claude reads has no injected markup, and the saved page has it exactly once", async () => {
    const row = await seedReady();
    expect(row.html).toContain("<style data-duet-base>"); // what finish_build stores (and GET .../html serves)
    let read = "";
    m.llm.script("task", async (request) => {
      read = m.workspace.get(m.alex.userId, pathOf(row.id)) ?? "";
      m.workspace.put(m.alex.userId, pathOf(row.id), read.replace("Open 9 to 6.", "Open 8 to 6."));
      void request;
      return [text("Changing the hours\n"), finishOf(row.id)];
    });
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Open at 8" }));
    await m.runs.idle();
    expect(read.replace(/^(<!doctype html>)\s+/i, "$1")).toBe(PAGE); // the model's own page, as it wrote it
    for (const injected of ["data-duet-base", "Content-Security-Policy", "name=\"viewport\"", "--duet-accent:", "duetBars"]) expect(read).not.toContain(injected);
    const saved = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } })).html;
    expect(saved).toContain("Open 8 to 6.");
    expect(once(saved, "<style data-duet-base>")).toBe(1);
    expect(once(saved, "Content-Security-Policy")).toBe(1);
    expect(once(saved, "name=\"viewport\"")).toBe(1);
    expect(once(saved, "window.duetBars=")).toBe(1);
  });

  test("a model that copied the served page without the markers still saves the base once (and the next read is clean)", async () => {
    const row = await seedReady();
    m.llm.script("task", buildTurn(m, { html: row.html.replaceAll(" data-duet-base", "").replace("Open 9 to 6.", "Open 7 to 6.") }));
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Open at 7" }));
    await m.runs.idle();
    const saved = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } })).html;
    expect(saved).toContain("Open 7 to 6.");
    expect(once(saved, BASE_CSS)).toBe(1);
    expect(once(saved, CHART_SCRIPT)).toBe(1);
    expect(once(saved, BASE_SCRIPT)).toBe(1);
    expect(once(saved, `content="${ARTIFACT_CSP}"`)).toBe(1);
    expect(once(saved, "charset=")).toBe(1);
    expect(stripInjected(saved)).not.toContain("--duet-accent:");
  });

  test("stripInjected keeps the page's own styles and scripts and is idempotent through withBase", () => {
    const own = `<!doctype html><html><head><meta charset="utf-8"><style>h1{color:red}</style><script>window.x=1</script><style>${BASE_CSS}</style></head><body><h1>Hi</h1><script>${BASE_SCRIPT}</script></body></html>`;
    const clean = stripInjected(own);
    expect(clean).toContain("<style>h1{color:red}</style>");
    expect(clean).toContain("<script>window.x=1</script>");
    expect(clean).not.toContain(BASE_CSS);
    expect(clean).not.toContain(BASE_SCRIPT);
    expect(clean).not.toContain("charset");
    const twice = withBase(withBase(own, { lang: "en", title: "T" }), { lang: "en", title: "T" });
    expect([once(twice, BASE_CSS), once(twice, BASE_SCRIPT), once(twice, "charset=")]).toEqual([1, 1, 1]);
  });
});

describe("edit_page (#10)", () => {
  test("offered in edit and refresh builds next to finish_build, not in a first build", async () => {
    const row = await seedReady();
    m.llm.script("task", buildTurn(m));
    await api(`/api/artifacts/${row.id}/refresh`, json(m.alex, "POST"));
    await m.runs.idle();
    expect(m.llm.sent("task").at(-1)!.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["finish_build", "edit_page"]));

    m.llm.script("task", [call("edit_page", { old_string: "a", new_string: "b" })], buildTurn(m));
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "docs", prompt: "A memo", channelId: m.alex.mainChannelId }));
    expect(res.status).toBe(200);
    await m.runs.idle();
    const sent = m.llm.sent("task").slice(-2);
    expect(sent[0]!.tools?.map((t) => t.name)).not.toContain("edit_page");
    expect(toolResults(sent[1])).toContain("Tool is not available");
  });

  test("not found / not unique are clear errors; a unique match and replace_all change the page; finish_build saves it", async () => {
    const row = await seedReady(longPage());
    m.llm.script(
      "task",
      tools(call("edit_page", { old_string: "Part  7</h2>", new_string: "Part seven</h2>" })),
      tools(call("edit_page", { old_string: "<section>", new_string: "<section class=\"x\">" })),
      tools(call("edit_page", { old_string: "Part 7</h2>", new_string: `Part seven</h2>` })),
      tools(call("edit_page", { old_string: "what we found", new_string: "what we learned", replace_all: true })),
      tools(finishOf(row.id)),
    );
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Spell out part 7" }));
    await m.runs.idle();
    const sent = m.llm.sent("task").slice(-4);
    expect(toolResults(sent[0])).toContain("old_string was not found in the page. The text is there with different spaces or line breaks");
    expect(toolResults(sent[1])).toContain("old_string appears 40 times in the page");
    expect(toolResults(sent[2])).toContain('\\"replacements\\":1');
    expect(toolResults(sent[3])).toContain('\\"replacements\\":40');
    const saved = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } })).html;
    expect(saved).toContain("<h2>Part seven</h2>");
    expect(saved).not.toContain("what we found");
    expect(once(saved, "what we learned")).toBe(40);
    expect(saved).toContain("Part 39");
    expect(once(saved, "<style data-duet-base>")).toBe(1);
  });
});

describe("shrink guard (#10)", () => {
  test("a rewrite from a cut-off read is refused (the workspace gets the page back); if the build ends there it fails with artifact.page_shrank", async () => {
    const page = longPage();
    const row = await seedReady(page);
    const before = await lastEventId(m.fixture);
    let after = "";
    m.llm.script(
      "task",
      buildTurn(m, { html: `${page.slice(0, 1500)}</main></body></html>` }),
      async () => {
        after = m.workspace.get(m.alex.userId, pathOf(row.id)) ?? "";
        return [text("I'll stop here.")];
      },
    );
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Fix a typo in part 3" }));
    await m.runs.idle();
    expect(toolResults(m.llm.sent("task").at(-1))).toContain("Not saved: the new page is much shorter than the page you started from");
    expect(after).toBe(stripInjected(row.html)); // the page the build started from, whole again
    const stored = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } });
    expect([stored.status, stored.html]).toEqual(["ready", row.html]);
    expect((await statuses(row.id, before)).at(-1)).toEqual(["ready", { state: "failed", reason: { key: "artifact.page_shrank" } }, null]);
    expect((await lines(before)).map((p) => p.key)).toContain("artifact.page_shrank");
  });

  test("after a refusal the build can still save a whole page; a deletion made with edit_page is allowed", async () => {
    const page = longPage();
    const row = await seedReady(page);
    m.llm.script(
      "task",
      buildTurn(m, { html: `${page.slice(0, 1500)}</main></body></html>` }),
      tools(call("edit_page", { old_string: "Part 3</h2>", new_string: "Part three</h2>" })),
      tools(finishOf(row.id)),
    );
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Spell out part 3" }));
    await m.runs.idle();
    let saved = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } })).html;
    expect(saved).toContain("Part three");
    expect(saved).toContain("Part 39");

    const start = stripInjected(saved);
    const cut = start.slice(start.indexOf("<section><h2>Part 5</h2>"), start.indexOf("</main>"));
    const before = await lastEventId(m.fixture);
    m.llm.script("task", tools(call("edit_page", { old_string: cut, new_string: "" })), tools(finishOf(row.id)));
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Keep only the first five parts" }));
    await m.runs.idle();
    saved = (await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: row.id } })).html;
    expect(saved).toContain("Part 4");
    expect(saved).not.toContain("Part 5<");
    expect((await statuses(row.id, before)).at(-1)).toEqual(["ready", null, null]);
  });

  test("the rule: old page at least SHRINK_MIN_CHARS, both markup and visible text under half; data: URIs and scripts don't count as text", () => {
    const old = pageSize(longPage());
    expect(old.markup).toBeGreaterThan(SHRINK_MIN_CHARS);
    expect(shrank(old, pageSize(longPage(10)))).toBe(true);
    expect(shrank(old, pageSize(longPage(25)))).toBe(false);
    // small pages are never guarded
    expect(shrank(pageSize(PAGE), pageSize("<p>x</p>"))).toBe(false);
    // what edit_page removed is credited
    expect(shrank(old, pageSize(longPage(10)), { markup: old.markup / 2, text: old.text / 2 })).toBe(false);
    // a dropped image (markup only) or a shorter data array (script, not text) isn't content lost
    const image = `<img src="data:image/png;base64,${"A".repeat(50_000)}">`;
    expect(pageSize(`<p>Hi</p>${image}`).markup).toBeLessThan(200);
    const data = `<script>duetBars("#c", [${Array.from({ length: 2000 }, (_, i) => `{label:"d${i}",value:${i}}`).join(",")}])</script>`;
    const dash = pageSize(`<h1>Signups</h1><p>${"Daily signups and what changed. ".repeat(20)}</p><div id="c"></div>${data}`);
    const shorter = pageSize(`<h1>Signups</h1><p>${"Daily signups and what changed. ".repeat(20)}</p><div id="c"></div><script>duetBars("#c", [{label:"d1",value:1}])</script>`);
    expect(dash.markup).toBeGreaterThan(SHRINK_MIN_CHARS);
    expect(shrank(dash, shorter)).toBe(false);
  });

  test("replaceText: exact, unique unless replace_all, literal replacement text", () => {
    expect(replaceText("a b a", "a", "c")).toMatchObject({ ok: false, error: expect.stringContaining("appears 2 times") });
    expect(replaceText("a b a", "a", "$&$&", true)).toEqual({ ok: true, html: "$&$& b $&$&", replacements: 2 });
    expect(replaceText("<p>one</p>", "<p>two</p>", "x")).toMatchObject({ ok: false, error: expect.stringContaining("was not found") });
    expect(replaceText("<p>one</p>", "<p>one</p>", "<p>one</p>")).toMatchObject({ ok: false });
    expect(replaceText("<p>one</p><p>two</p>", "<p>two</p>", "")).toEqual({ ok: true, html: "<p>one</p>", replacements: 1 });
  });
});

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
};
const builds = () => m.fixture.db.artifact.count({ where: { userId: m.alex.userId } });

describe("Retry by startedBy (#18)", () => {
  test("startedBy is stored: user for the app's Create, claude for make_artifact in chat", async () => {
    m.llm.script("task", buildTurn(m));
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "web_page", prompt: "A page for the shop", channelId: m.alex.mainChannelId }));
    const mine = ArtifactResponse.parse(await res.json()).artifact.id;
    await m.runs.idle();
    m.llm.script("chat", [call("make_artifact", { type: "doc", title: "Started by Claude", prompt: "A brief" })], [text("On it.")]);
    m.llm.script("task", buildTurn(m));
    await chat(m, "Write me a brief", "m21-sb-1");
    await m.runs.idle();
    const theirs = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Started by Claude" } });
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: mine } })).startedBy).toBe("user");
    expect(theirs.startedBy).toBe("assistant");
  });

  test("Retry (↻ on a failed first build) rebuilds the same artifact in place, with the trust of who started it", async () => {
    const seen: boolean[] = [];
    m.llm.script("chat", [call("make_artifact", { type: "doc", title: "Claude's memo", prompt: "A memo" })], [text("On it.")]);
    m.llm.script("task", noting(seen, [text("I couldn't finish.")]));
    await chat(m, "Write me a memo", "m21-sb-2");
    await m.runs.idle();
    const theirs = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Claude's memo" } });
    expect([theirs.status, theirs.startedBy]).toEqual(["failed", "assistant"]);
    const count = await builds();

    m.llm.script("task", noting(seen, buildTurn(m)));
    const retried = await api(`/api/artifacts/${theirs.id}/refresh`, json(m.alex, "POST"));
    expect(ArtifactResponse.parse(await retried.json()).artifact).toMatchObject({ id: theirs.id, status: "building" });
    await m.runs.idle();
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("ready");
    expect(await builds()).toBe(count); // no new artifact

    m.llm.script("task", noting(seen, [text("No.")]));
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "docs", prompt: "My own memo", channelId: m.alex.mainChannelId }));
    const mine = ArtifactResponse.parse(await res.json()).artifact.id;
    await m.runs.idle();
    m.llm.script("task", noting(seen, buildTurn(m)));
    await api(`/api/artifacts/${mine}/refresh`, json(m.alex, "POST"));
    await m.runs.idle();
    expect((await m.fixture.db.artifact.findUniqueOrThrow({ where: { id: mine } })).status).toBe("ready");
    // Claude's build, its retry (still Claude's trust), the user's build, its retry (the user's)
    expect(seen).toEqual([false, false, true, true]);
  });

  test("the user's ✎ on a page Claude started runs with Claude's trust (its request is in the edit prompt)", async () => {
    const seen: boolean[] = [];
    m.llm.script("chat", [call("make_artifact", { type: "doc", title: "Claude's notes", prompt: "Notes" })], [text("On it.")]);
    m.llm.script("task", noting(seen, buildTurn(m)));
    await chat(m, "Write me notes", "m21-sb-edit");
    await m.runs.idle();
    const theirs = await m.fixture.db.artifact.findFirstOrThrow({ where: { userId: m.alex.userId, title: "Claude's notes" } });
    expect([theirs.status, theirs.startedBy]).toEqual(["ready", "assistant"]);
    m.llm.script("task", noting(seen, buildTurn(m)));
    await m.artifacts.service.requestEdit({ userId: m.alex.userId, id: theirs.id, prompt: "Make it shorter.", startedBy: "user" });
    await m.runs.idle();
    expect(seen).toEqual([false, false]);
  });

  test("a failed first build folds in only edits that don't raise its trust; Claude's edit to the user's page waits for the retry", async () => {
    const gate = deferred();
    m.llm.script("task", async () => {
      await gate.promise;
      return [text("I couldn't finish.")];
    });
    const res = await api("/api/artifacts", json(m.alex, "POST", { type: "docs", prompt: "Offsite plan", channelId: m.alex.mainChannelId }));
    const id = ArtifactResponse.parse(await res.json()).artifact.id;
    await until(async () => m.llm.sent("task").some((r) => JSON.stringify(r.messages).includes(id)));
    await m.artifacts.service.requestEdit({ userId: m.alex.userId, id, prompt: "Add the dinner.", startedBy: "user" });
    await m.artifacts.service.requestEdit({ userId: m.alex.userId, id, prompt: "Make it blue.", startedBy: "assistant", chat: true });
    gate.resolve();
    await m.runs.idle();
    const failed = await m.fixture.db.artifact.findUniqueOrThrow({ where: { id } });
    expect([failed.status, failed.prompt]).toEqual(["failed", "Offsite plan\n\nAlso: Add the dinner."]);

    const seen: boolean[] = [];
    m.llm.script("task", noting(seen, buildTurn(m)), noting(seen, buildTurn(m)));
    await api(`/api/artifacts/${id}/refresh`, json(m.alex, "POST"));
    await m.runs.idle();
    const last = JSON.stringify(m.llm.sent("task").at(-1)!.messages);
    expect(last).toContain("Make it blue.");
    expect(seen).toEqual([true, false]); // the retry with the user's trust, then Claude's edit with Claude's
  });
});

describe("a line in the chat once it's done (#46)", () => {
  test("edit_artifact in chat: \"Updated <title>.\" after the page is saved; ✎ from the viewer posts nothing", async () => {
    const row = await seedReady(PAGE, { title: "Shop page" });
    const before = await lastEventId(m.fixture);
    m.llm.script("chat", [call("edit_artifact", { artifactId: row.id, prompt: "Open at 8" })], [text("On it.")]);
    m.llm.script("task", buildTurn(m));
    await chat(m, "Open at 8 on the shop page", "m21-line-1");
    await m.runs.idle();
    const edited = (await lines(before)).filter((p) => p.key === "artifact.edited");
    expect(edited).toEqual([{ key: "artifact.edited", params: { title: { type: "text", value: "Shop page" } } }]);

    const viewer = await lastEventId(m.fixture);
    m.llm.script("task", buildTurn(m));
    await api(`/api/artifacts/${row.id}/edit`, json(m.alex, "POST", { prompt: "Open at 9" }));
    await m.runs.idle();
    expect((await lines(viewer)).map((p) => p.key)).not.toContain("artifact.edited");
  });

  test("an edit asked for in chat that fails says why, never \"Updated\"", async () => {
    const row = await seedReady();
    const before = await lastEventId(m.fixture);
    m.llm.script("chat", [call("edit_artifact", { artifactId: row.id, prompt: "Make it pink" })], [text("On it.")]);
    m.llm.script("task", [text("I couldn't.")]);
    await chat(m, "Make the plan pink", "m21-line-2");
    await m.runs.idle();
    const keys = (await lines(before)).map((p) => p.key);
    expect(keys).toContain("artifact.not_finished");
    expect(keys).not.toContain("artifact.edited");
  });

  test("refresh_artifact in chat: \"Refreshed <title>.\" (Claude's trust); ↻ from the app posts nothing", async () => {
    const row = await seedReady(PAGE, { title: "Sales" });
    const seen: boolean[] = [];
    const before = await lastEventId(m.fixture);
    m.llm.script("chat", [call("refresh_artifact", { artifactId: row.id })], [text("Refreshing it.")]);
    m.llm.script("task", noting(seen, buildTurn(m)));
    await chat(m, "Refresh my sales page", "m21-line-3");
    await m.runs.idle();
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain('\\"status\\":\\"refreshing\\"');
    expect((await lines(before)).filter((p) => p.key === "artifact.refreshed")).toEqual([{ key: "artifact.refreshed", params: { title: { type: "text", value: "Sales" } } }]);

    const app = await lastEventId(m.fixture);
    m.llm.script("task", noting(seen, buildTurn(m)));
    await api(`/api/artifacts/${row.id}/refresh`, json(m.alex, "POST"));
    await m.runs.idle();
    expect((await lines(app)).map((p) => p.key)).not.toContain("artifact.refreshed");
    expect(seen).toEqual([false, true]);
  });

  test("refresh_artifact while the page is already being rebuilt says so instead of promising a line", async () => {
    const row = await seedReady(PAGE, { title: "Busy page" });
    const gate = deferred();
    const turn = buildTurn(m);
    m.llm.script("task", async (request) => { await gate.promise; return typeof turn === "function" ? turn(request) : turn; });
    await api(`/api/artifacts/${row.id}/refresh`, json(m.alex, "POST"));
    m.llm.script("chat", [call("refresh_artifact", { artifactId: row.id })], [text("It's already being refreshed.")]);
    const sent = chat(m, "Refresh my busy page", "m21-line-busy");
    for (let i = 0; i < 200 && m.llm.sent("chat").length === 0; i++) await Bun.sleep(10);
    await sent;
    for (let i = 0; i < 200 && !toolResults(m.llm.sent("chat").at(-1)).includes("already_running"); i++) await Bun.sleep(10);
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain('\\"status\\":\\"already_running\\"');
    gate.resolve();
    await m.runs.idle();
  });
});
