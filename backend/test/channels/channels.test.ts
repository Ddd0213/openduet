// M11-B channels: create with `access` (validated, enabled rows) and `greet` (a background chat
// turn in the user's language whose quick replies are Claude's own), the "no purpose yet" path,
// PATCH soulExtra / useSharedMemory (main thread 400), and delete cleaning up the channel's memory,
// dreaming passes and access rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Channel, ChannelList } from "../../src/contract/channels.ts";
import { errorOf } from "../helpers/http.ts";
import { call, chatIn, json, messagesOf, newChannel, startChannels, text, thread, type ChannelApp } from "./harness.ts";

let m: ChannelApp;
beforeAll(async () => { m = await startChannels(); });
afterAll(() => m.cleanup());

const lastChat = () => m.llm.sent("chat").at(-1)!;
const promptOf = (request: ReturnType<typeof lastChat>) => JSON.stringify(request.messages);

describe("POST /api/channels", () => {
  test("greet queues a chat turn in the channel; Claude greets by name and purpose with quick replies", async () => {
    m.llm.script("chat", [text("Hi! This is your Q4 planning space."), call("quick_replies", { options: ["Yes", "No", "Not now"], text: "Want me to suggest a few tasks?" })]);
    const before = m.llm.sent("chat").length;
    const created = await newChannel(m, m.alex, { name: "Q4 planning", purpose: "Plan the Q4 launch", greet: true });
    expect(created.status).toBe(200);
    const run = await m.fixture.db.run.findFirstOrThrow({ where: { channelId: created.id } });
    expect([run.kind, run.taskId]).toEqual(["chat", null]);
    await m.runs.idle();
    expect(m.llm.sent("chat").length).toBe(before + 1);
    const prompt = promptOf(lastChat());
    expect(prompt).toContain("Q4 planning");
    expect(prompt).toContain("Plan the Q4 launch");
    expect(prompt).toContain("in English");
    expect(prompt).toContain("[\\\"Yes\\\",\\\"No\\\",\\\"Not now\\\"]");
    const messages = await thread(m, m.alex, created.id);
    // The server's prompt is never a message; Claude's greeting and chips are.
    expect(messages.some((x) => x.role === "user")).toBe(false);
    expect(messages.map((x) => x.kind)).toEqual(["text", "quick_replies"]);
    expect(messages[1]).toMatchObject({ role: "assistant", payload: { options: ["Yes", "No", "Not now"] } });
  });

  test("the greeting follows User.language", async () => {
    await m.fixture.db.user.update({ where: { id: m.sam.userId }, data: { language: "zh-Hans" } });
    m.llm.script("chat", [text("你好！")]);
    const created = await newChannel(m, m.sam, { name: "旅行", purpose: "规划东京之旅", greet: true });
    await m.runs.idle();
    const prompt = promptOf(lastChat());
    expect(prompt).toContain("Simplified Chinese");
    expect(prompt).toContain("[\\\"好\\\",\\\"不用\\\",\\\"暂不\\\"]");
    expect((await thread(m, m.sam, created.id)).map((x) => x.text)).toEqual(["你好！"]);
    await m.fixture.db.user.update({ where: { id: m.sam.userId }, data: { language: "en" } });
  });

  test("no purpose: the greeting asks what it's for, later turns are told to remember the answer (channel scope)", async () => {
    m.llm.script("chat", [text("Hi! What is this channel for?")]);
    const created = await newChannel(m, m.alex, { name: "Misc", greet: true });
    await m.runs.idle();
    const prompt = promptOf(lastChat());
    expect(prompt).toContain("has no purpose yet");
    expect(prompt).toContain("remember (scope: channel)");
    m.llm.script("chat", [text("Got it.")]);
    await chatIn(m, m.alex, created.id, "It's for my garden");
    expect(lastChat().system).toContain("This channel has no purpose set yet");
    // Not on the main thread, and not once the channel has a purpose.
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "hello");
    expect(lastChat().system).not.toContain("no purpose set yet");
    await m.fixture.app.request(`/api/channels/${created.id}`, json(m.alex, "PATCH", { purpose: "Garden" }));
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, m.alex, created.id, "hi");
    expect(lastChat().system).not.toContain("no purpose set yet");
  });

  test("greet false queues nothing; access refs are validated and become enabled rows", async () => {
    const skill = await (await m.fixture.app.request("/api/skills", json(m.alex, "POST", { name: "weekly-report", description: "Report", instructions: "Three sections." }))).json() as { id: string };
    const theirs = await (await m.fixture.app.request("/api/skills", json(m.sam, "POST", { name: "sams-skill", description: "", instructions: "x" }))).json() as { id: string };
    const created = await newChannel(m, m.alex, { name: "Reports", access: [{ kind: "skill", id: skill.id }, { kind: "app", id: "gmail" }, { kind: "skill", id: skill.id }] });
    expect(created.status).toBe(200);
    expect(await m.fixture.db.run.count({ where: { channelId: created.id } })).toBe(0);
    const rows = await m.fixture.db.channelAccess.findMany({ where: { channelId: created.id }, orderBy: { kind: "asc" } });
    expect(rows.map((r) => [r.kind, r.refId, r.enabled])).toEqual([["app", "gmail", true], ["skill", skill.id, true]]);
    for (const access of [[{ kind: "skill", id: theirs.id }], [{ kind: "skill", id: "nope" }], [{ kind: "connector", id: "nope" }], [{ kind: "app", id: "not-an-app" }], [{ kind: "app", id: "Bad Slug" }]]) {
      const before = await m.fixture.db.channel.count({ where: { userId: m.alex.userId } });
      const bad = await m.fixture.app.request("/api/channels", json(m.alex, "POST", { name: "X", icon: "chart", colorHex: "#6290C2", access }));
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).field).toBe("access");
      expect(await m.fixture.db.channel.count({ where: { userId: m.alex.userId } })).toBe(before);
    }
  });
});

describe("M23 W4: the answer to the greeting's Yes / No / Not now", () => {
  /** A new channel whose greeting posted its Yes / No / Not now card (in the user's language). */
  async function greeted(user: typeof m.alex, name: string, options = ["Yes", "No", "Not now"]) {
    m.llm.script("chat", [text(`Hi! This is ${name}.`), call("quick_replies", { options, text: "Want me to suggest a few tasks?" })]);
    const created = await newChannel(m, user, { name, purpose: `Plan ${name}`, greet: true });
    await m.runs.idle();
    const card = (await thread(m, user, created.id)).find((x) => x.kind === "quick_replies")!;
    return { id: created.id, card };
  }
  const HEAD = "[The user is answering your greeting's offer to suggest tasks for this channel]";

  test("Yes (tapped): exactly three grounded tasks with propose_tasks; later turns and the main thread get no such lines", async () => {
    const { id, card } = await greeted(m.alex, "Garden");
    m.llm.script("chat", [text("Here are three.")]);
    await chatIn(m, m.alex, id, "Yes", { quickReply: { messageId: card.id, option: "Yes" } });
    for (const part of [HEAD, "They said yes. Offer exactly three tasks with propose_tasks", "grounded in this channel's purpose or in something you read in their connected apps", "No generic ideas", "don't call propose_tasks"]) expect(lastChat().system).toContain(part);
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, m.alex, id, "thanks");
    expect(lastChat().system).not.toContain(HEAD);
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, m.alex, m.alex.mainChannelId, "Yes");
    expect(lastChat().system).not.toContain(HEAD);
  });

  test("No: one line, no chips (dropped in code), and remember (scope: channel) that no task suggestions are wanted here", async () => {
    const { id, card } = await greeted(m.alex, "Taxes");
    m.llm.script("chat", [text("No problem."), call("quick_replies", { options: ["Undo", "OK"] })], [text("I won't suggest tasks here.")]);
    const frames = await chatIn(m, m.alex, id, "No", { quickReply: { messageId: card.id, option: "No" } });
    for (const part of ["They said no. Reply in one short line", "remember (scope: channel) that the user doesn't want task suggestions in this channel", "don't offer tasks here"]) expect(lastChat().system).toContain(part);
    expect(messagesOf(frames).some((x) => x.kind === "quick_replies" && x.payload.chosen === null)).toBe(false);
    expect(JSON.stringify(lastChat().messages.at(-1))).toContain("No buttons were shown");
  });

  test("Not now (typed, in Chinese): a few words, no chips; another typed answer is read as yes / no / something else", async () => {
    await m.fixture.db.user.update({ where: { id: m.sam.userId }, data: { language: "zh-Hans" } });
    const trip = await greeted(m.sam, "旅行", ["好", "不用", "暂不"]);
    m.llm.script("chat", [text("好的。")]);
    await chatIn(m, m.sam, trip.id, "暂不");
    expect(lastChat().system).toContain("They said not now. Reply in a few words");
    await m.fixture.db.user.update({ where: { id: m.sam.userId }, data: { language: "en" } });

    const shop = await greeted(m.alex, "Shop");
    m.llm.script("chat", [text("Sure.")]);
    await chatIn(m, m.alex, shop.id, "sure, go ahead");
    expect(lastChat().system).toContain("They typed an answer instead of tapping one");
  });
});

describe("PATCH /api/channels/:id (M11 fields)", () => {
  test("soulExtra and useSharedMemory are per channel; the main thread refuses them and always answers the defaults", async () => {
    const created = await newChannel(m, m.alex, { name: "Writing" });
    const patched = await m.fixture.app.request(`/api/channels/${created.id}`, json(m.alex, "PATCH", { soulExtra: "Be terse here.", useSharedMemory: false }));
    expect(patched.status).toBe(200);
    expect(Channel.parse(await patched.json())).toMatchObject({ soulExtra: "Be terse here.", useSharedMemory: false });
    for (const body of [{ soulExtra: "x" }, { useSharedMemory: false }]) {
      const bad = await m.fixture.app.request(`/api/channels/${m.alex.mainChannelId}`, json(m.alex, "PATCH", body));
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).field).toBe(Object.keys(body)[0]!);
    }
    const list = ChannelList.parse(await (await m.fixture.app.request("/api/channels", { headers: m.alex.headers })).json()).channels;
    expect(list.find((c) => c.isMain)).toMatchObject({ soulExtra: "", useSharedMemory: true });
    expect(list.find((c) => c.id === created.id)).toMatchObject({ soulExtra: "Be terse here.", useSharedMemory: false });
    expect((await m.fixture.app.request(`/api/channels/${created.id}`, json(m.sam, "PATCH", { soulExtra: "x" }))).status).toBe(404);
  });
});

describe("DELETE /api/channels/:id", () => {
  test("removes the channel's memory, dreaming passes and access rows; other layers stay", async () => {
    const { db } = m.fixture;
    const created = await newChannel(m, m.alex, { name: "Temp", access: [{ kind: "app", id: "slack" }] });
    const other = await newChannel(m, m.alex, { name: "Keep" });
    const userId = m.alex.userId;
    await db.memory.createMany({ data: [
      { userId, kind: "fact", text: "temp fact", channelId: created.id },
      { userId, kind: "document", text: "temp doc", channelId: created.id },
      { userId, kind: "fact", text: "keep fact", channelId: other.id },
      { userId, kind: "fact", text: "about you", channelId: null },
    ] });
    await db.memoryCuration.create({ data: { userId, channelId: created.id, status: "applied", cursorAt: new Date() } });
    await db.memoryCuration.create({ data: { userId, channelId: other.id, status: "applied", cursorAt: new Date() } });
    await db.channelAccess.create({ data: { userId, channelId: other.id, kind: "app", refId: "slack", enabled: false } });
    expect((await m.fixture.app.request(`/api/channels/${created.id}`, { method: "DELETE", headers: m.sam.headers })).status).toBe(404);
    expect((await m.fixture.app.request(`/api/channels/${created.id}`, { method: "DELETE", headers: m.alex.headers })).status).toBe(204);
    expect(await db.memory.count({ where: { channelId: created.id } })).toBe(0);
    expect(await db.memoryCuration.count({ where: { channelId: created.id } })).toBe(0);
    expect(await db.channelAccess.count({ where: { channelId: created.id } })).toBe(0);
    expect((await db.memory.findMany({ where: { userId }, orderBy: { text: "asc" } })).map((r) => r.text)).toEqual(expect.arrayContaining(["about you", "keep fact"]));
    expect(await db.memoryCuration.count({ where: { channelId: other.id } })).toBe(1);
    expect(await db.channelAccess.count({ where: { channelId: other.id } })).toBe(1);
  });
});
