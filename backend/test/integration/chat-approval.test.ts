// M21 (#12) end to end, wired like src/index.ts (the TaskService is the approval service's resumer):
// a chat turn's approval cards (no task) carry the chat on once they're decided, the same path a
// task's session uses. Two cards of one turn, one approved and one declined: one carried-on chat
// turn that sees both outcomes (a server note, never stored). A chat message already waiting in
// the thread reads the decided cards itself, so no extra turn is added. Scripted model, fake Composio.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConnectorsModule } from "../../src/connectors/module.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, deferred, json, rig, RoleScriptedLlm, text } from "../tasks/harness.ts";

let fixture: TestApp;
let llm: RoleScriptedLlm;
let fake: FakeComposio;
let alex: SignedIn;
let stopSweep = () => {};

beforeAll(async () => {
  llm = new RoleScriptedLlm();
  fake = new FakeComposio();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const built = rig(core, llm);
      const connectors = createConnectorsModule({ db: core.db, events: core.events, config: core.config, gateway: fake });
      built.providers.push(...connectors.providers);
      connectors.setResumer(built.tasks.service);
      stopSweep = () => connectors.stop();
      return { agent: built.agent, runs: built.runs, routes: [...built.tasks.routes, ...connectors.routes] };
    },
  });
  alex = await signUp(fixture, "alex");
  fake.connect(alex.userId, "gmail", "ca_alex");
});
afterAll(async () => { stopSweep(); await fixture.cleanup(); });

const email = (to: string) => ({ recipient_email: to, subject: "Launch review", body: "Hi, the deck is ready." });
const newChannel = async (name: string) => (await fixture.db.channel.create({ data: { userId: alex.userId, name, purpose: "" } })).id;
const send = (channelId: string, body: string, clientId: string) => fixture.app.request(`/api/channels/${channelId}/messages`, json(alex, "POST", { text: body, clientId }));
const decide = (id: string, action: "approve" | "decline") => fixture.app.request(`/api/approvals/${id}/${action}`, json(alex, "POST", { version: 1 }));

/** Waits until the chat role has been asked `count` times, then until every queue is idle. */
async function chatCalls(count: number) {
  for (let i = 0; i < 200 && llm.sent("chat").length < count; i++) await Bun.sleep(25);
  await fixture.runs.idle();
  return llm.sent("chat").length;
}

describe("chat approvals carry the chat on", () => {
  test("two cards of one turn: nothing until both are decided, then one turn that sees both outcomes", async () => {
    const channelId = await newChannel("Two cards");
    llm.script("chat",
      [call("execute_app_tools", { calls: [{ tool: "GMAIL_SEND_EMAIL", arguments: email("sam@example.com") }, { tool: "GMAIL_SEND_EMAIL", arguments: email("lee@example.com") }] })],
      [text("Both emails are waiting for your OK.")]);
    await readSse(await send(channelId, "Send the deck to Sam and Lee", "chat-appr-1"));
    await fixture.runs.idle();
    const cards = await fixture.db.approval.findMany({ where: { userId: alex.userId, taskId: null, status: "pending" }, orderBy: { createdAt: "asc" } });
    expect(cards).toHaveLength(2);
    const [sam, lee] = cards as [typeof cards[number], typeof cards[number]];
    const before = llm.sent("chat").length;

    expect((await decide(sam.id, "approve")).status).toBe(200);
    await Bun.sleep(150);
    await fixture.runs.idle();
    // Lee's card still waits: the chat isn't carried on yet.
    expect(llm.sent("chat").length).toBe(before);

    llm.script("chat", [text("Sent to Sam; I left Lee out as you asked.")]);
    expect((await decide(lee.id, "decline")).status).toBe(200);
    expect(await chatCalls(before + 1)).toBe(before + 1);
    const resumed = JSON.stringify(llm.sent("chat").at(-1)!.messages);
    expect(resumed).toContain(`Approval ${sam.id}: the user approved it and it was carried out`);
    expect(resumed).toContain(`Approval ${lee.id}: the user declined it, so it was not carried out`);
    // Its reply is in the thread; the server note never is.
    const replies = await fixture.db.message.findMany({ where: { channelId, taskId: null, role: "assistant", kind: "text" }, orderBy: { createdAt: "asc" } });
    expect(replies.map((m) => m.text)).toEqual(["Both emails are waiting for your OK.", "Sent to Sam; I left Lee out as you asked."]);
    expect(await fixture.db.message.count({ where: { channelId, text: { contains: "[Server note" } } })).toBe(0);
    const runs = await fixture.db.run.findMany({ where: { channelId, kind: "chat" }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);

    // Deciding again changes nothing (the approved card answers its stored result).
    expect((await decide(sam.id, "approve")).status).toBe(200);
    await Bun.sleep(100);
    await fixture.runs.idle();
    expect(llm.sent("chat").length).toBe(before + 1);
  });

  test("a card whose run record has no step for it (its tool call hasn't returned) is not carried on", async () => {
    const channelId = await newChannel("No step yet");
    llm.script("chat", [call("execute_app_tools", { calls: [{ tool: "GMAIL_SEND_EMAIL", arguments: email("ana@example.com") }] })], [text("Waiting for your OK.")]);
    await readSse(await send(channelId, "Email Ana the deck", "chat-appr-nostep"));
    await fixture.runs.idle();
    const card = await fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId, taskId: null, status: "pending" } });
    // As if the decision landed before the recorder wrote the step (or the record failed).
    await fixture.db.runStep.updateMany({ where: { approvalId: card.id }, data: { approvalId: null } });
    const before = llm.sent("chat").length;
    expect((await decide(card.id, "approve")).status).toBe(200);
    await Bun.sleep(150);
    await fixture.runs.idle();
    expect(llm.sent("chat").length).toBe(before);
    expect(await fixture.db.run.count({ where: { channelId, kind: "chat" } })).toBe(1);
  });

  test("a chat message already waiting in the thread reads the decided card itself: no extra turn", async () => {
    const channelId = await newChannel("Waiting message");
    llm.script("chat", [call("execute_app_tools", { calls: [{ tool: "GMAIL_SEND_EMAIL", arguments: email("kim@example.com") }] })], [text("Waiting for your OK.")]);
    await readSse(await send(channelId, "Email Kim the deck", "chat-appr-2"));
    await fixture.runs.idle();
    const card = await fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId, taskId: null, status: "pending" } });
    // Hold the next chat turn so a second message waits behind it.
    const reached = deferred();
    const release = deferred();
    llm.script("chat", async () => { reached.resolve(); await release.promise; return [text("Busy answer.")]; }, [text("Kim got it.")]);
    const busy = await send(channelId, "Something else first", "chat-appr-3");
    await reached.promise;
    const waiting = await send(channelId, "Did the email go out?", "chat-appr-4");
    const before = llm.sent("chat").length;
    expect((await decide(card.id, "approve")).status).toBe(200);
    await Bun.sleep(100);
    release.resolve();
    await Promise.all([readSse(busy), readSse(waiting)]);
    await fixture.runs.idle();
    // Only the waiting message's own turn ran after the decision, and it saw the decided card.
    expect(llm.sent("chat").length).toBe(before + 1);
    expect(llm.sent("chat").at(-1)!.system).toContain(card.id);
    expect(await fixture.db.run.count({ where: { channelId, kind: "chat" } })).toBe(3);
  });
});
