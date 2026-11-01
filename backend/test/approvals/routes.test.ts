// Approval cards end to end: the model's write becomes a card, update_approval (edit by chat) makes a
// new version, a stale Approve is 409, Approve runs exactly the stored arguments once (double tap
// included), a failed run stays pending with a short reason and Retry, Decline, someone else's card
// is 404, and a task's cards tell the TaskResumer once decided.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApprovalDecisionResponse } from "../../src/contract/approvals.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { connectorHarness, eventsOf, execute, tool, type Harness } from "../connectors/harness.ts";

let h: Harness;
let alex: SignedIn;
let sam: SignedIn;
const fake = () => h.fake!;

beforeAll(async () => {
  h = await connectorHarness();
  alex = await signUp(h.fixture, "alex");
  sam = await signUp(h.fixture, "sam");
  fake().connect(alex.userId, "gmail", "ca_a1");
});
afterAll(() => h.cleanup());

const EMAIL = { recipient_email: "sam@example.com", subject: "Q3 numbers", body: "Hi Sam, numbers attached." };

/** A pending Send email card made by the model through the chat route. */
async function emailCard(user: SignedIn = alex, args: Record<string, unknown> = EMAIL) {
  h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: args })]);
  await h.send(user, "Email Sam");
  return h.fixture.db.approval.findFirstOrThrow({ where: { userId: user.userId }, orderBy: { createdAt: "desc" } });
}

const decision = async (response: Response) => ApprovalDecisionResponse.parse(await response.json()).approval;

describe("edit by chat, stale versions, approve once", () => {
  test("update_approval makes v2 with changedFields; approving v1 is 409; approving v2 runs exactly the merged arguments once", async () => {
    const card = await emailCard();
    let system = "";
    h.script(
      (request) => {
        system = request.system;
        return [tool("update_approval", { approvalId: card.id, changes: { cc: ["lee@example.com"], subject: null, body: "Hi Sam, numbers attached. Also adding Lee." } })];
      },
    );
    const frames = await h.send(alex, "Add a line about Lee, cc Lee and drop the subject");
    // The model saw the card (id, status, version, arguments) in its prompt.
    expect(system).toContain(card.id);
    expect(system).toContain("\"recipient_email\":\"sam@example.com\"");
    const [edit] = h.lastResults();
    expect(edit!.data).toMatchObject({ status: "updated", approvalId: card.id, version: 2, changedFields: ["cc", "subject", "body"] });

    const v2 = await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } });
    expect(v2).toMatchObject({ version: 2, status: "pending", result: null });
    expect(JSON.parse(v2.arguments)).toEqual({ recipient_email: "sam@example.com", body: "Hi Sam, numbers attached. Also adding Lee.", cc: ["lee@example.com"] });
    const shown = eventsOf(frames.events, "approval").at(-1)!.payload.approval;
    expect(shown).toMatchObject({ id: card.id, version: 2, changedFields: ["cc", "subject", "body"], preview: { kind: "email", to: ["sam@example.com"], cc: ["lee@example.com"], subject: "", body: "Hi Sam, numbers attached. Also adding Lee." } });
    const message = await h.fixture.db.message.findUniqueOrThrow({ where: { id: card.messageId! } });
    expect(JSON.parse(message.payload).approval).toMatchObject({ version: 2, changedFields: ["cc", "subject", "body"] });

    const before = fake().executions.length;
    const stale = await h.decide(alex, card.id, "approve", 1);
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("stale_version");
    expect(fake().executions.length).toBe(before);

    const recording = h.record(alex.userId);
    const approved = await h.decide(alex, card.id, "approve", 2);
    recording.stop();
    expect(approved.status).toBe(200);
    expect(await decision(approved)).toMatchObject({ id: card.id, status: "approved", version: 2, result: { ok: true, error: null } });
    expect(fake().executions.slice(before)).toEqual([{ userId: alex.userId, slug: "GMAIL_SEND_EMAIL", args: { recipient_email: "sam@example.com", body: "Hi Sam, numbers attached. Also adding Lee.", cc: ["lee@example.com"] } }]);
    // message (the card rewritten) then approval, on the card's channel.
    const kinds = recording.events.map((e) => e.type);
    expect(kinds).toEqual(["message", "approval"]);
    expect(recording.events.every((e) => e.channelId === alex.mainChannelId)).toBe(true);
    const rewritten = eventsOf(recording.events, "message")[0]!.payload.message;
    expect(rewritten.kind === "approval" && rewritten.payload.approval.status).toBe("approved");

    // Approving again (a retry after a dropped response) answers the stored result and runs nothing.
    const again = await h.decide(alex, card.id, "approve", 2);
    expect(again.status).toBe(200);
    expect((await decision(again)).status).toBe("approved");
    expect(fake().executions.length).toBe(before + 1);

    // A decided card can't be edited.
    h.script([tool("update_approval", { approvalId: card.id, changes: { body: "late" } })]);
    await h.send(alex, "Change it again");
    expect(h.lastResults()[0]!.data).toMatchObject({ reason: "not_pending" });
  });

  test("edits that change nothing, don't fit the tool, or name someone else's card", async () => {
    const card = await emailCard();
    h.script(
      [tool("update_approval", { approvalId: card.id, changes: { subject: "Q3 numbers" } })],
      [tool("update_approval", { approvalId: card.id, changes: { body: null } })],
      [tool("update_approval", { approvalId: card.id, changes: { is_html: "yes" } })],
      [tool("update_approval", { approvalId: "missing_card", changes: { body: "x" } })],
    );
    await h.send(alex, "Tweak it");
    const results = h.llm.requests.slice(-4).map((r) => {
      const block = r.messages.at(-1)!.content[0]!;
      return block.type === "tool_result" && block.content[0]?.type === "text" ? JSON.parse(block.content[0].text) : null;
    });
    expect(results[0]).toMatchObject({ status: "unchanged", version: 1 });
    expect(results[1]).toMatchObject({ reason: "invalid" });
    expect(results[1].error).toContain("body: required");
    expect(results[2]).toMatchObject({ reason: "invalid" });
    expect(results[3]).toMatchObject({ reason: "not_found" });
    expect(await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ version: 1, status: "pending" });

    h.script([tool("update_approval", { approvalId: card.id, changes: { body: "hijacked" } })]);
    await h.send(sam, "Edit that card");
    expect(h.lastResults()[0]!.data).toMatchObject({ reason: "not_found" });
    expect(JSON.parse((await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } })).arguments).body).toBe(EMAIL.body);
    await h.decide(alex, card.id, "decline", 1);
  });

  test("a double tap runs the call once; a decline racing it answers the approved card", async () => {
    const card = await emailCard();
    const before = fake().executions.length;
    let release!: () => void;
    fake().gate = new Promise<void>((resolve) => { release = resolve; });
    const first = h.decide(alex, card.id, "approve", 1);
    while (fake().executions.length === before) await Bun.sleep(2);
    const second = h.decide(alex, card.id, "approve", 1);
    const decline = h.decide(alex, card.id, "decline", 1);
    await Bun.sleep(20);
    release();
    fake().gate = null;
    const [a, b, c] = await Promise.all([first, second, decline]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect((await decision(a)).status).toBe("approved");
    expect((await decision(b)).status).toBe("approved");
    expect((await decision(c)).status).toBe("approved");
    expect(fake().executions.length).toBe(before + 1);
  });
});

describe("a failed run, decline, and someone else's card", () => {
  test("a failed run stays pending with approval.failed and a short reason (never the provider's text); Retry approves again", async () => {
    const card = await emailCard();
    const before = fake().executions.length;
    fake().results.set("GMAIL_SEND_EMAIL", { ok: false, kind: "not_connected", error: "OAuth token expired: invalid_grant (refresh_token revoked)" });
    const failed = await h.decide(alex, card.id, "approve", 1);
    expect(failed.status).toBe(200);
    const shown = await decision(failed);
    expect(shown).toMatchObject({ status: "pending", version: 1, result: { ok: false, error: { key: "approval.failed", params: { reason: { type: "text", value: "Gmail isn't connected anymore. Reconnect it and try again." } } } } });
    const stored = await h.fixture.db.message.findUniqueOrThrow({ where: { id: card.messageId! } });
    expect(stored.payload).not.toContain("invalid_grant");
    expect(fake().executions.length).toBe(before + 1);

    // The next turn knows it failed.
    let system = "";
    h.script((request) => { system = request.system; return [{ type: "text_delta", text: "It didn't send." }]; });
    await h.send(alex, "Did it send?");
    expect(system).toContain("failed (the user can retry or ask for edits)");
    expect(system).not.toContain("invalid_grant");

    // Retry = approve the same version again.
    fake().results.delete("GMAIL_SEND_EMAIL");
    const retried = await h.decide(alex, card.id, "approve", 1);
    expect(await decision(retried)).toMatchObject({ status: "approved", version: 1, result: { ok: true, error: null } });
    expect(fake().executions.slice(before).map((e) => e.args)).toEqual([EMAIL, EMAIL]);
  });

  test("the reason is in the user's language, also when the call throws", async () => {
    await h.fixture.db.user.update({ where: { id: alex.userId }, data: { language: "zh-Hans" } });
    const card = await emailCard();
    const original = fake().execute.bind(fake());
    fake().execute = async () => { throw new Error("socket hang up at 10.0.0.7"); };
    try {
      const shown = await decision(await h.decide(alex, card.id, "approve", 1));
      expect(shown.status).toBe("pending");
      expect(shown.result?.error).toEqual({ key: "approval.failed", params: { reason: { type: "text", value: "暂时连不上 Gmail，请稍后再试。" } } });
    } finally {
      fake().execute = original;
      await h.fixture.db.user.update({ where: { id: alex.userId }, data: { language: "en" } });
    }
    await h.decide(alex, card.id, "decline", 1);
  });

  test("Not now declines with any version; a declined card can't be approved; nothing runs", async () => {
    const card = await emailCard();
    const before = fake().executions.length;
    const recording = h.record(alex.userId);
    const declined = await h.decide(alex, card.id, "decline", 7);
    recording.stop();
    expect(declined.status).toBe(200);
    expect(await decision(declined)).toMatchObject({ id: card.id, status: "declined", version: 1, result: null });
    expect(recording.events.map((e) => e.type)).toEqual(["message", "approval"]);
    const approve = await h.decide(alex, card.id, "approve", 1);
    expect(approve.status).toBe(409);
    expect((await errorOf(approve)).code).toBe("stale_version");
    expect((await decision(await h.decide(alex, card.id, "decline", 1))).status).toBe("declined");
    expect(fake().executions.length).toBe(before);
  });

  test("someone else's card is 404; bad ids, versions and bodies are refused", async () => {
    const card = await emailCard();
    for (const action of ["approve", "decline"] as const) {
      const response = await h.decide(sam, card.id, action, 1);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
    }
    expect((await h.decide(alex, "x".repeat(65), "approve", 1)).status).toBe(404);
    expect((await h.decide(alex, "missing", "approve", 1)).status).toBe(404);
    for (const version of [0, "1", null]) {
      const response = await h.decide(alex, card.id, "approve", version);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    const anonymous = await h.fixture.app.request(`/api/approvals/${card.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1 }) });
    expect(anonymous.status).toBe(401);
    expect(await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ status: "pending", version: 1, result: null });
    await h.decide(alex, card.id, "decline", 1);
  });
});

describe("task approvals and the TaskResumer", () => {
  test("approved (after a failed attempt), declined and expired task cards each resume the task once", async () => {
    const task = await h.fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Q3 follow-up" } });
    // M20: not EMAIL itself: the previous test declined that exact call, and a task session has no
    // user message since, so it would be refused as the user's decision (test/approvals/ask.test.ts).
    h.script(
      [execute({ tool: "GMAIL_SEND_EMAIL", arguments: { ...EMAIL, body: "Hi Sam, the Q3 numbers, as the task asked." } }, { tool: "GMAIL_DELETE_MESSAGE", arguments: { message_id: "m_1" } })],
      [tool("request_payment", { amount: 12, merchant: "Figma", description: "Seat for Lee" })],
    );
    await h.runTask(alex, task.id, "Send the Q3 numbers");
    const cards = await h.fixture.db.approval.findMany({ where: { taskId: task.id }, orderBy: { toolSlug: "asc" } });
    expect(cards.map((c) => [c.toolSlug, c.kind, c.status])).toEqual([
      ["GMAIL_DELETE_MESSAGE", "delete", "pending"],
      ["GMAIL_SEND_EMAIL", "email", "pending"],
      ["duet:request_payment", "payment", "pending"],
    ]);
    const [remove, send, payment] = cards as [typeof cards[0], typeof cards[0], typeof cards[0]];
    // The cards live in the task's own session.
    expect(await h.fixture.db.message.findUniqueOrThrow({ where: { id: send.messageId! } })).toMatchObject({ taskId: task.id, kind: "approval" });
    expect(h.resumer.calls).toEqual([]);

    fake().results.set("GMAIL_SEND_EMAIL", { ok: false, kind: "provider", error: "500" });
    expect((await decision(await h.decide(alex, send.id, "approve", 1))).status).toBe("pending");
    expect(h.resumer.calls).toEqual([]);
    fake().results.delete("GMAIL_SEND_EMAIL");
    const recording = h.record(alex.userId);
    await h.decide(alex, send.id, "approve", 1);
    recording.stop();
    expect(eventsOf(recording.events, "approval").map((e) => e.payload.approval.taskId)).toEqual([task.id]);
    expect(h.resumer.calls).toEqual([{ taskId: task.id, outcome: { approvalId: send.id, status: "approved", ok: true, summary: "Gmail · Email to sam@example.com: Q3 numbers" } }]);

    await h.decide(alex, remove.id, "decline", 1);
    await h.decide(alex, remove.id, "decline", 1);
    expect(h.resumer.calls.slice(1)).toEqual([{ taskId: task.id, outcome: { approvalId: remove.id, status: "declined", ok: false, summary: "Gmail · Delete: Delete message" } }]);

    h.advance(16 * 60_000);
    try {
      expect(await h.module.approvals.sweep(alex.userId)).toBe(1);
      expect(await h.module.approvals.sweep(alex.userId)).toBe(0);
    } finally {
      h.advance(-16 * 60_000);
    }
    expect(h.resumer.calls.slice(2)).toEqual([{ taskId: task.id, outcome: { approvalId: payment.id, status: "expired", ok: false, summary: "Payment of 12.00 USD to Figma (test mode, nothing charged)" } }]);
    expect(h.resumer.calls).toHaveLength(3);
  });
});
