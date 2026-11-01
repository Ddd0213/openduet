// M11-B access: resolve() (main thread = everything, a channel's own row wins, else the item's
// scope with no rule = all; made in a channel = scope channels + on there), GET / PUT
// /api/channels/:id/access and PUT /api/access/scope, and the Composio tools hiding apps that are
// turned off in the channel (search, schemas, execute, manage connections, instructions).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelAccess } from "../../src/contract/m11.ts";
import { errorOf } from "../helpers/http.ts";
import { call, chatIn, get, json, newChannel, resultsIn, startChannels, text, type ChannelApp } from "../channels/harness.ts";

let m: ChannelApp;
beforeAll(async () => { m = await startChannels(); });
afterAll(() => m.cleanup());

const skill = async (name: string, channelId?: string) =>
  (await (await m.fixture.app.request("/api/skills", json(m.alex, "POST", { name, description: `${name} skill`, instructions: "Do it well.", ...(channelId ? { channelId } : {}) }))).json()) as { id: string; scope: string; channelIds: string[] };

describe("AccessService.resolve", () => {
  test("main thread sees everything; scope all / channels; a channel's own row wins; made in a channel = only there", async () => {
    const access = m.system.access;
    const a = await newChannel(m, m.alex, { name: "A" });
    const b = await newChannel(m, m.alex, { name: "B" });
    const everywhere = await skill("everywhere");
    const onlyA = await skill("only-a", a.id);
    expect(everywhere).toMatchObject({ scope: "all", channelIds: [] });
    expect(onlyA).toMatchObject({ scope: "channels", channelIds: [a.id] });
    expect(await m.fixture.db.accessRule.count({ where: { refId: everywhere.id } })).toBe(0);

    const inA = await access.resolve(m.alex.userId, a.id);
    const inB = await access.resolve(m.alex.userId, b.id);
    const main = await access.resolve(m.alex.userId, m.alex.mainChannelId);
    expect([inA.skills.has(everywhere.id), inA.skills.has(onlyA.id)]).toEqual([true, true]);
    expect([inB.skills.has(everywhere.id), inB.skills.has(onlyA.id)]).toEqual([true, false]);
    expect(main.main).toBe(true);
    expect([main.skills.has(everywhere.id), main.skills.has(onlyA.id)]).toEqual([true, true]);
    // Apps with no rows stay "all".
    expect(inB.apps).toBe("all");
    expect(inB.allowsApp("gmail")).toBe(true);

    // B turns the shared one off; A turns gmail off; the main thread ignores both.
    await access.setChannel(m.alex.userId, b.id, { kind: "skill", id: everywhere.id }, false);
    await access.setChannel(m.alex.userId, a.id, { kind: "app", id: "gmail" }, false);
    expect((await access.resolve(m.alex.userId, b.id)).skills.has(everywhere.id)).toBe(false);
    const aNow = await access.resolve(m.alex.userId, a.id);
    expect(aNow.allowsApp("gmail")).toBe(false);
    expect(aNow.allowsApp("slack")).toBe(true);
    const mainNow = await access.resolve(m.alex.userId, m.alex.mainChannelId);
    expect([mainNow.skills.has(everywhere.id), mainNow.allowsApp("gmail")]).toEqual([true, true]);

    // Scope channels: off where no row says on; a row turns it on.
    await access.setScope(m.alex.userId, { kind: "skill", id: everywhere.id }, "channels");
    expect((await access.resolve(m.alex.userId, a.id)).skills.has(everywhere.id)).toBe(false);
    await access.setChannel(m.alex.userId, a.id, { kind: "skill", id: everywhere.id }, true);
    expect((await access.resolve(m.alex.userId, a.id)).skills.has(everywhere.id)).toBe(true);

    // Someone else's or an unknown channel gets nothing.
    const foreign = await access.resolve(m.sam.userId, a.id);
    expect([foreign.skills.size, foreign.allowsApp("gmail")]).toEqual([0, false]);
  });

  test("a skill turned off in a channel is invisible there (index, use_skill, /name)", async () => {
    const c = await newChannel(m, m.alex, { name: "Quiet" });
    const hidden = await skill("hidden-skill");
    await m.system.access.setChannel(m.alex.userId, c.id, { kind: "skill", id: hidden.id }, false);
    m.llm.script("chat", [call("use_skill", { name: "hidden-skill" })], [text("ok")]);
    await chatIn(m, m.alex, c.id, "/hidden-skill go");
    const [first, second] = m.llm.sent("chat").slice(-2);
    expect(first!.system).not.toContain("<skill name=\"hidden-skill\">");
    expect(first!.system).toContain("no skill with that name here");
    expect(first!.system).not.toContain("/hidden-skill\",\"description");
    expect(resultsIn(second)[0]).toMatchObject({ error: "There's no skill /hidden-skill here." });
    // Visible on the main thread.
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "/hidden-skill go");
    expect(m.llm.sent("chat").at(-1)!.system).toContain("<skill name=\"hidden-skill\">");
  });
});

describe("/api/channels/:id/access and /api/access/scope", () => {
  test("lists skills, connectors and connected apps by name within each kind; PUT turns items on / off", async () => {
    m.fake.connect(m.alex.userId, "slack", "ca_slack");
    m.fake.connect(m.alex.userId, "gmail", "ca_gmail");
    m.connectors.catalog!.invalidateAccounts(m.alex.userId);
    const c = await newChannel(m, m.alex, { name: "Listing" });
    const zeta = await skill("zeta-skill");
    const alpha = await skill("alpha-skill");
    const created = await m.fixture.app.request("/api/custom-connectors", json(m.alex, "POST", { kind: "api_key", name: "Weather", domain: "api.weather.example.com", key: "wx-key-123456" }));
    expect(created.status).toBe(200);
    const connectorId = ((await created.json()) as { connector: { id: string } }).connector.id;

    const listed = ChannelAccess.parse(await (await get(m, m.alex, `/api/channels/${c.id}/access`)).json());
    const mine = listed.items.filter((i) => i.kind !== "skill" || [zeta.id, alpha.id].includes(i.id));
    expect(mine.map((i) => [i.kind, i.name])).toEqual([
      ["skill", "alpha-skill"], ["skill", "zeta-skill"], ["connector", "Weather"], ["app", "Gmail"], ["app", "Slack"],
    ]);
    expect(listed.items.every((i) => i.enabled || i.scope === "channels")).toBe(true);
    const kinds = listed.items.map((i) => i.kind);
    expect(kinds).toEqual([...kinds].sort((x, y) => ["skill", "connector", "app"].indexOf(x) - ["skill", "connector", "app"].indexOf(y)));

    const put = await m.fixture.app.request(`/api/channels/${c.id}/access`, json(m.alex, "PUT", { changes: [{ kind: "app", id: "gmail", enabled: false }, { kind: "connector", id: connectorId, enabled: false }] }));
    expect(put.status).toBe(200);
    const after = ChannelAccess.parse(await put.json());
    expect(after.items.find((i) => i.id === "gmail")?.enabled).toBe(false);
    expect(after.items.find((i) => i.id === connectorId)?.enabled).toBe(false);
    expect(after.items.find((i) => i.id === "slack")?.enabled).toBe(true);

    // The main thread: everything on, PUT is 400.
    const main = ChannelAccess.parse(await (await get(m, m.alex, `/api/channels/${m.alex.mainChannelId}/access`)).json());
    expect(main.items.every((i) => i.enabled)).toBe(true);
    const onMain = await m.fixture.app.request(`/api/channels/${m.alex.mainChannelId}/access`, json(m.alex, "PUT", { changes: [{ kind: "app", id: "gmail", enabled: false }] }));
    expect(onMain.status).toBe(400);
    // Unknown refs 400 (field changes); someone else's channel 404.
    const unknown = await m.fixture.app.request(`/api/channels/${c.id}/access`, json(m.alex, "PUT", { changes: [{ kind: "skill", id: "nope", enabled: true }] }));
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).field).toBe("changes");
    expect((await get(m, m.sam, `/api/channels/${c.id}/access`)).status).toBe(404);
  });

  test("PUT /api/access/scope sets an item's default (204); unknown refs are 400 field ref", async () => {
    const c = await newChannel(m, m.alex, { name: "Scope" });
    const s = await skill("scoped-skill");
    const ok = await m.fixture.app.request("/api/access/scope", json(m.alex, "PUT", { ref: { kind: "skill", id: s.id }, scope: "channels" }));
    expect(ok.status).toBe(204);
    expect((await m.system.access.resolve(m.alex.userId, c.id)).skills.has(s.id)).toBe(false);
    const listed = ChannelAccess.parse(await (await get(m, m.alex, `/api/channels/${c.id}/access`)).json());
    expect(listed.items.find((i) => i.id === s.id)).toMatchObject({ scope: "channels", enabled: false });
    expect((await m.fixture.app.request("/api/access/scope", json(m.alex, "PUT", { ref: { kind: "skill", id: s.id }, scope: "all" }))).status).toBe(204);
    expect((await m.system.access.resolve(m.alex.userId, c.id)).skills.has(s.id)).toBe(true);
    const bad = await m.fixture.app.request("/api/access/scope", json(m.sam, "PUT", { ref: { kind: "skill", id: s.id }, scope: "all" }));
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).field).toBe("ref");
    expect((await m.fixture.app.request("/api/access/scope", json(m.alex, "PUT", { ref: { kind: "app", id: "gmail" }, scope: "channels" }))).status).toBe(204);
    expect((await m.system.access.resolve(m.alex.userId, c.id)).allowsApp("gmail")).toBe(false);
    await m.fixture.app.request("/api/access/scope", json(m.alex, "PUT", { ref: { kind: "app", id: "gmail" }, scope: "all" }));
  });
});
describe("apps per channel in the Composio tools", () => {
  test("a disabled app is hidden from search, schemas, execute and manage connections; the main thread sees all", async () => {
    m.fake.connect(m.alex.userId, "gmail", "ca_gmail_2");
    m.fake.connect(m.alex.userId, "googlecalendar", "ca_cal");
    m.connectors.catalog!.invalidateAccounts(m.alex.userId);
    const c = await newChannel(m, m.alex, { name: "No mail" });
    await m.system.access.setChannel(m.alex.userId, c.id, { kind: "app", id: "gmail" }, false);
    const searches = m.fake.searches.length;
    const executions = m.fake.executions.length;
    m.llm.script("chat",
      [call("search_app_tools", { query: "recent email", apps: ["Gmail"] })],
      [call("search_app_tools", { query: "events", apps: ["Gmail", "Google Calendar"] })],
      [call("get_app_tool_schemas", { tools: ["GMAIL_SEND_EMAIL", "GOOGLECALENDAR_FIND_EVENT"] })],
      [call("execute_app_tools", { calls: [{ tool: "GMAIL_FETCH_EMAILS", arguments: {} }] })],
      [call("manage_app_connections", { apps: ["Gmail"] })],
      [text("Gmail is off here.")],
    );
    const before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, c.id, "check my email");
    const sent = m.llm.sent("chat").slice(before);
    expect(sent).toHaveLength(6);
    const system = sent[0]!.system;
    expect(system).toMatch(/Turned off in this channel[^\n]*Gmail/);
    expect(/Connected apps: [^\n]*/.exec(system)![0]).not.toContain("Gmail");
    expect(/Connected apps: [^\n]*/.exec(system)![0]).toContain("Google Calendar");

    const [onlyOff] = resultsIn(sent[1]);
    expect(onlyOff).toMatchObject({ tools: [], apps: [], turnedOffInChannel: ["Gmail"] });
    // Nothing asked of the gateway for an app that's off here.
    expect(m.fake.searches.length).toBe(searches + 1);
    expect(m.fake.searches.at(-1)!.toolkits).toEqual(["googlecalendar"]);
    const [mixed] = resultsIn(sent[2]);
    expect((mixed!.tools as { tool: string }[]).every((t) => t.tool.startsWith("GOOGLECALENDAR_"))).toBe(true);
    expect(mixed!.turnedOffInChannel).toEqual(["Gmail"]);
    const [schemas] = resultsIn(sent[3]);
    expect((schemas!.tools as { tool: string }[]).map((t) => t.tool)).toEqual(["GOOGLECALENDAR_FIND_EVENT"]);
    expect(schemas!).toMatchObject({ notFound: [], turnedOffInChannel: ["Gmail"] });
    const [executed] = resultsIn(sent[4]);
    expect((executed!.results as Record<string, unknown>[])[0]).toMatchObject({ status: "refused", app: "Gmail" });
    expect(m.fake.executions.length).toBe(executions);
    const [managed] = resultsIn(sent[5]);
    expect((managed!.apps as Record<string, unknown>[])[0]).toMatchObject({ app: "Gmail", status: "turned_off_in_channel" });
    expect(m.fake.authorizations.length).toBe(0);

    // The main thread can use Gmail.
    m.llm.script("chat", [call("execute_app_tools", { calls: [{ tool: "GMAIL_FETCH_EMAILS", arguments: {} }] })], [text("Here.")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "check my email");
    expect((resultsIn(m.llm.sent("chat").at(-1))[0]!.results as Record<string, unknown>[])[0]).toMatchObject({ status: "ok", app: "Gmail" });
    expect(m.fake.executions.length).toBe(executions + 1);
    expect(m.llm.sent("chat").at(-2)!.system).not.toContain("Turned off in this channel");
  });
});
