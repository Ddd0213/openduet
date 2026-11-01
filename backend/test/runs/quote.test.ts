// Quote reply (M8 contract §2): a user message can quote one of Claude's messages in the same
// thread; the stored payload keeps an excerpt, the model reads "The user is replying to ..." before
// that turn, and anything else (own message, unknown id, another channel, task or user) is 400.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessagePage } from "../../src/contract/messages.ts";
import { errorOf } from "../helpers/http.ts";
import { readSse } from "../helpers/sse.ts";
import { signUp } from "../helpers/session.ts";
import { json, messagesOf, startApp, text, type TaskApp } from "../tasks/harness.ts";

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());

const send = (body: Record<string, unknown>) => t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, json(t.alex, "POST", body));
const LINE = "The user is replying to this earlier message of yours:";

describe("quote reply", () => {
  test("quoting Claude's message stores an excerpt and the model reads it before the user's turn", async () => {
    t.llm.script("chat", [text("## Options\nHere are **two**: [Option A](https://a.example) and `Option B`.")]);
    const first = messagesOf(await readSse(await send({ text: "What are my options?", clientId: "q-1" })));
    const assistantMessage = first.find((m) => m.role === "assistant" && m.kind === "text")!;
    expect(assistantMessage).toBeDefined();

    t.llm.script("chat", [text("Going with A.")]);
    const frames = await readSse(await send({ text: "The first one", clientId: "q-2", replyTo: assistantMessage.id }));
    const echo = messagesOf(frames).find((m) => m.role === "user")!;
    expect(echo.kind === "text" && echo.payload.replyTo).toEqual({ messageId: assistantMessage.id, role: "assistant", excerpt: "Options Here are two: Option A and Option B." });
    const sent = t.llm.sent("chat").at(-1)!;
    const turn = JSON.stringify(sent.messages.at(-1));
    expect(turn).toContain(`${LINE} «Options Here are two: Option A and Option B.»`);
    expect(turn).toContain("The first one");

    // The timeline shows it; a later turn still sees the quote in the history.
    const page = MessagePage.parse(await (await t.fixture.app.request(`/api/channels/${t.alex.mainChannelId}/messages`, { headers: t.alex.headers })).json());
    const stored = page.messages.find((m) => m.id === echo.id)!;
    expect(stored.kind === "text" && stored.payload.replyTo?.messageId).toBe(assistantMessage.id);
    const plain = page.messages.find((m) => m.role === "user" && m.text === "What are my options?")!;
    expect(plain.kind === "text" && plain.payload.replyTo).toBeNull();
    t.llm.script("chat", [text("Noted.")]);
    await readSse(await send({ text: "Thanks", clientId: "q-3" }));
    expect(JSON.stringify(t.llm.sent("chat").at(-1)!.messages)).toContain(LINE);
  });

  test("own message, unknown id, another channel, a task's session or another user: 400 replyTo, nothing stored", async () => {
    const own = await t.fixture.db.message.findFirstOrThrow({ where: { userId: t.alex.userId, role: "user" } });
    const other = await t.fixture.db.channel.create({ data: { userId: t.alex.userId, name: "Q4 planning" } });
    const elsewhere = await t.fixture.db.message.create({ data: { userId: t.alex.userId, channelId: other.id, role: "assistant", kind: "text", text: "In another channel", payload: "{}" } });
    const task = await t.fixture.db.task.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "A task", prompt: "x" } });
    const inTask = await t.fixture.db.message.create({ data: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: task.id, role: "assistant", kind: "text", text: "In the task", payload: "{}" } });
    const sam = await signUp(t.fixture, "sam", "Sam Lee");
    const theirs = await t.fixture.db.message.create({ data: { userId: sam.userId, channelId: sam.mainChannelId, role: "assistant", kind: "text", text: "Sam's", payload: "{}" } });
    for (const [i, id] of [own.id, "no-such-message", elsewhere.id, inTask.id, theirs.id].entries()) {
      const res = await send({ text: "Re that", clientId: `bad-${i}`, replyTo: id });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: "validation_failed", field: "replyTo" });
      expect(await t.fixture.db.message.count({ where: { clientId: `bad-${i}` } })).toBe(0);
    }
  });

  test("in a task's own session, a reply can quote Claude's message there", async () => {
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Draft the memo", prompt: "Draft the memo" });
    t.llm.script("task", [text("Should the memo be formal or casual?")]);
    await t.fixture.runs.idle();
    const question = await t.fixture.db.message.findFirstOrThrow({ where: { taskId: task.id, role: "assistant", kind: "text" } });
    t.llm.script("task", [text("Formal it is.")]);
    const res = await t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "Formal", clientId: "tq-1", replyTo: question.id }));
    expect(res.status).toBe(200);
    await readSse(res);
    expect(JSON.stringify(t.llm.sent("task").at(-1)!.messages.at(-1))).toContain(`${LINE} «Should the memo be formal or casual?»`);
    // The main timeline's messages can't be quoted from inside the task.
    const main = await t.fixture.db.message.findFirstOrThrow({ where: { userId: t.alex.userId, channelId: t.alex.mainChannelId, taskId: null, role: "assistant" } });
    const refused = await t.fixture.app.request(`/api/tasks/${task.id}/messages`, json(t.alex, "POST", { text: "x", clientId: "tq-2", replyTo: main.id }));
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).field).toBe("replyTo");
  });
});
