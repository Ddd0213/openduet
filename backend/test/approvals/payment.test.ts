// request_payment (test mode, nothing is ever charged): a payment card without an item, a
// Link-style spend request card with one; minor units by currency; approve marks them approved
// without calling anything; decline, lazy expiry (410) and the sweep keep SpendRequest in sync.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApprovalDecisionResponse } from "../../src/contract/approvals.ts";
import { PAYMENT_TTL_MS, SPEND_REQUEST_TTL_MS } from "../../src/approvals/service.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { connectorHarness, eventsOf, tool, type Harness } from "../connectors/harness.ts";

let h: Harness;
let alex: SignedIn;
const fake = () => h.fake!;

beforeAll(async () => {
  h = await connectorHarness();
  alex = await signUp(h.fixture, "alex");
});
afterAll(() => h.cleanup());

const decision = async (response: Response) => ApprovalDecisionResponse.parse(await response.json()).approval;

async function pay(input: Record<string, unknown>) {
  h.script([tool("request_payment", input)]);
  const frames = await h.send(alex, "Pay for it");
  const [result] = h.lastResults();
  return { frames, data: result!.data };
}

describe("request_payment", () => {
  test("without an item: a payment card in minor units, test mode, valid 15 minutes; approve calls nothing", async () => {
    expect(PAYMENT_TTL_MS).toBe(15 * 60_000);
    const started = Date.now();
    const { frames, data } = await pay({ amount: 16.49, merchant: "Blue Bottle", description: "Coffee beans" });
    const row = await h.fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
    expect(row).toMatchObject({ kind: "payment", toolSlug: "duet:request_payment", status: "pending", version: 1 });
    expect(row.expiresAt!.getTime() - started).toBeGreaterThanOrEqual(PAYMENT_TTL_MS - 1000);
    expect(row.expiresAt!.getTime() - started).toBeLessThanOrEqual(PAYMENT_TTL_MS + 5000);
    expect(JSON.parse(row.preview)).toEqual({ kind: "payment", amount: 1649, currency: "USD", merchant: "Blue Bottle", description: "Coffee beans", testMode: true });
    expect(data).toMatchObject({ status: "awaiting_approval", approvalId: row.id, card: "payment", testMode: true, expiresAt: row.expiresAt!.toISOString() });
    expect(await h.fixture.db.spendRequest.count({ where: { userId: alex.userId } })).toBe(0);
    const card = eventsOf(frames.events, "message").map((e) => e.payload.message).filter((m) => m.kind === "approval").at(-1)!;
    expect(card.kind === "approval" && card.payload.approval).toMatchObject({ id: row.id, kind: "payment", preview: { amount: 1649, testMode: true } });

    // Payment cards can't be edited by chat.
    h.script([tool("update_approval", { approvalId: row.id, changes: { amount: 1 } })]);
    await h.send(alex, "Make it a dollar");
    expect(h.lastResults()[0]!.data).toMatchObject({ reason: "not_editable" });

    const before = fake().executions.length;
    const approved = await decision(await h.decide(alex, row.id, "approve", 1));
    expect(approved).toMatchObject({ status: "approved", result: { ok: true, error: null } });
    expect(fake().executions.length).toBe(before);
  });

  test("with an item: a SpendRequest row + spend_request card, valid 30 minutes, JPY has no minor digits", async () => {
    expect(SPEND_REQUEST_TTL_MS).toBe(30 * 60_000);
    const started = Date.now();
    const { frames, data } = await pay({ amount: 1200, currency: "jpy", merchant: "Muji", description: "Notebook set", item: "A5 dot grid notebook ×3" });
    const spend = await h.fixture.db.spendRequest.findFirstOrThrow({ where: { userId: alex.userId } });
    expect(spend).toMatchObject({ amount: 1200, currency: "JPY", merchant: "Muji", description: "Notebook set", item: "A5 dot grid notebook ×3", status: "pending", channelId: alex.mainChannelId });
    expect(spend.expiresAt.getTime() - started).toBeGreaterThanOrEqual(SPEND_REQUEST_TTL_MS - 1000);
    expect(spend.expiresAt.getTime() - started).toBeLessThanOrEqual(SPEND_REQUEST_TTL_MS + 5000);
    const approval = await h.fixture.db.approval.findUniqueOrThrow({ where: { id: spend.approvalId! } });
    expect(approval).toMatchObject({ kind: "payment", status: "pending", expiresAt: spend.expiresAt });
    expect(approval.messageId).toBe(spend.messageId);
    expect(data).toMatchObject({ status: "awaiting_approval", approvalId: approval.id, card: "spend_request", testMode: true });

    const message = await h.fixture.db.message.findUniqueOrThrow({ where: { id: spend.messageId! } });
    expect(message.kind).toBe("spend_request");
    expect(JSON.parse(message.payload)).toEqual({ spendRequest: {
      id: spend.id, approvalId: approval.id, amount: 1200, currency: "JPY", merchant: "Muji", description: "Notebook set",
      item: "A5 dot grid notebook ×3", expiresAt: spend.expiresAt.toISOString(), status: "pending", testMode: true,
    } });
    expect(eventsOf(frames.events, "approval").map((e) => e.payload.approval.id)).toContain(approval.id);

    const recording = h.record(alex.userId);
    const approved = await decision(await h.decide(alex, approval.id, "approve", 1));
    recording.stop();
    expect(approved).toMatchObject({ status: "approved", result: { ok: true, error: null } });
    expect(await h.fixture.db.spendRequest.findUniqueOrThrow({ where: { id: spend.id } })).toMatchObject({ status: "approved" });
    const rewritten = eventsOf(recording.events, "message")[0]!.payload.message;
    expect(rewritten.kind === "spend_request" && rewritten.payload.spendRequest.status).toBe("approved");
    expect(fake().executions).toHaveLength(0);
  });

  test("decline and expiry keep the SpendRequest in sync; an expired card answers 410", async () => {
    await pay({ amount: 5, merchant: "Shop", description: "Declined", item: "Socks" });
    const declined = await h.fixture.db.spendRequest.findFirstOrThrow({ where: { userId: alex.userId, description: "Declined" } });
    await h.decide(alex, declined.approvalId!, "decline", 1);
    expect(await h.fixture.db.spendRequest.findUniqueOrThrow({ where: { id: declined.id } })).toMatchObject({ status: "declined" });

    // A payment card past its 15 minutes: Approve is 410 and the card turns expired.
    await pay({ amount: 9.99, merchant: "Shop", description: "Too late" });
    const late = await h.fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId }, orderBy: { createdAt: "desc" } });
    h.advance(16 * 60_000);
    try {
      const response = await h.decide(alex, late.id, "approve", 1);
      expect(response.status).toBe(410);
      expect((await errorOf(response)).code).toBe("expired");
      expect(await h.fixture.db.approval.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ status: "expired" });
      expect((await decision(await h.decide(alex, late.id, "decline", 1))).status).toBe("expired");
    } finally {
      h.advance(-16 * 60_000);
    }

    // A spend request lasts 30 minutes; the sweep (and the start() timer) expires it after that.
    await pay({ amount: 20, merchant: "Shop", description: "Swept", item: "Hat" });
    const swept = await h.fixture.db.spendRequest.findFirstOrThrow({ where: { userId: alex.userId, description: "Swept" } });
    h.advance(29 * 60_000);
    expect(await h.module.approvals.sweep()).toBe(0);
    h.advance(2 * 60_000);
    try {
      const recording = h.record(alex.userId);
      h.module.approvals.start(10);
      for (let i = 0; i < 200 && (await h.fixture.db.spendRequest.findUniqueOrThrow({ where: { id: swept.id } })).status === "pending"; i++) await Bun.sleep(10);
      h.module.approvals.stop();
      recording.stop();
      expect(await h.fixture.db.spendRequest.findUniqueOrThrow({ where: { id: swept.id } })).toMatchObject({ status: "expired" });
      expect(await h.fixture.db.approval.findUniqueOrThrow({ where: { id: swept.approvalId! } })).toMatchObject({ status: "expired" });
      const card = eventsOf(recording.events, "message").map((e) => e.payload.message).find((m) => m.kind === "spend_request");
      expect(card?.kind === "spend_request" && card.payload.spendRequest.status).toBe("expired");
      expect(eventsOf(recording.events, "approval").map((e) => e.payload.approval.status)).toContain("expired");
      expect((await h.decide(alex, swept.approvalId!, "approve", 1)).status).toBe(410);
    } finally {
      h.advance(-31 * 60_000);
    }
    expect(fake().executions).toHaveLength(0);
  });

  test("an unknown currency or a bad amount is an error for the model and makes no card", async () => {
    const before = await h.fixture.db.approval.count({ where: { userId: alex.userId } });
    h.script(
      [tool("request_payment", { amount: 10, currency: "ZZZ", merchant: "Shop", description: "x" })],
      [tool("request_payment", { amount: -3, merchant: "Shop", description: "x" })],
      [tool("request_payment", { amount: 5_000_000, merchant: "Shop", description: "x" })],
    );
    await h.send(alex, "Pay");
    const results = h.llm.requests.slice(-3).map((r) => r.messages.at(-1)!.content[0]!);
    expect(results.every((b) => b.type === "tool_result" && b.isError === true)).toBe(true);
    expect(JSON.stringify(results[0])).toContain("Unknown currency");
    expect(await h.fixture.db.approval.count({ where: { userId: alex.userId } })).toBe(before);
  });
});
