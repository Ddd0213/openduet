// M20 approvals (approvals/gate.ts): ApprovalService.ask() / requestBrowserAction() and Approve with
// Always. No second card for a call already waiting, none for one the user just declined (until they
// write in that thread, at most 24 h); Always per recipient (one ApprovalRule per address) and per
// site + category for browser clicks (never purchase / account / checkout); the floor's "why"; and
// the connector call site: covered recipients run now, background turns refuse nested writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput } from "../../src/agent/types.ts";
import { BROWSER_ACTION_SLUG, type AskInput, type AskOutcome, type BrowserActionInput } from "../../src/approvals/gate.ts";
import type { CardSink } from "../../src/approvals/service.ts";
import { ApprovalDecisionResponse, type Approval } from "../../src/contract/approvals.ts";
import { loadMessage } from "../../src/runs/serialize.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { connectorHarness, execute, type Harness } from "../connectors/harness.ts";

let h: Harness;
let alex: SignedIn;
const fake = () => h.fake!;
const approvals = () => h.module.approvals;

beforeAll(async () => {
  h = await connectorHarness();
  alex = await signUp(h.fixture, "alex");
  fake().connect(alex.userId, "gmail", "ca_a1");
  // Approved browser clicks run here (W1 registers the real ones).
  approvals().registerExecutor("computer_click", async () => ({ ok: true }));
  approvals().registerExecutor("computer_type", async () => ({ ok: true }));
});
afterAll(() => h.cleanup());

/** Writes the card into alex's main channel (the main thread, or a task's session), like the run host's sink. */
const sinkIn = (taskId: string | null = null): CardSink => ({
  upsertMessage: async (draft) => {
    const row = await h.fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, taskId, role: "assistant", kind: draft.kind, text: "", payload: JSON.stringify("payload" in draft ? draft.payload : {}) } });
    return (await loadMessage(h.fixture.db, row.id))!;
  },
});
const preview = { kind: "action" as const, app: "App", toolName: "Do it", rows: [{ label: "What", value: "it" }] };
function call(slug: string, args: Record<string, unknown>, extra: Partial<AskInput> = {}): AskInput {
  return { userId: alex.userId, channelId: alex.mainChannelId, taskId: null, sink: sinkIn(), slug, args, kind: "action", preview, toolkit: slug.split("_")[0]!.toLowerCase(), ...extra };
}
const click = (over: Partial<BrowserActionInput> = {}): BrowserActionInput => ({
  userId: alex.userId, channelId: alex.mainChannelId, taskId: null, sink: sinkIn(), slug: "computer_click", args: { ref: "e12" },
  site: "news.example.com", button: "Post comment", category: "send", via: "click", checkoutPage: false, ...over,
});
const approvalOf = (outcome: AskOutcome): Approval => {
  if (!("approval" in outcome)) throw new Error(`no card: ${outcome.status}`);
  return outcome.approval;
};
const idOf = (outcome: AskOutcome) => ("approval" in outcome ? outcome.approval.id : null);
const cards = () => h.fixture.db.approval.count({ where: { userId: alex.userId } });
const decide = (id: string, action: "approve" | "decline", body: Record<string, unknown> = { version: 1 }) =>
  h.get(alex, `/api/approvals/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
const userSays = (text: string, taskId: string | null = null) =>
  h.fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, taskId, role: "user", kind: "text", text } });
const resultsOf = () => h.lastResults()[0]!.data.results as Record<string, unknown>[];

describe("the same call while its card is pending", () => {
  test("no second card (already_waiting); different arguments are a new card; volatile keys don't count", async () => {
    const first = await approvals().ask(call("GOOGLECALENDAR_CREATE_EVENT", { summary: "Design review", start: "2030-10-26T15:00:00Z" }));
    expect(first.status).toBe("created");
    const row = await h.fixture.db.approval.findUniqueOrThrow({ where: { id: idOf(first)! } });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const before = await cards();
    // Key order doesn't matter either.
    const again = await approvals().ask(call("GOOGLECALENDAR_CREATE_EVENT", { start: "2030-10-26T15:00:00Z", summary: "Design review" }));
    expect([again.status, idOf(again)]).toEqual(["already_waiting", row.id]);
    expect(await cards()).toBe(before);

    const other = await approvals().ask(call("GOOGLECALENDAR_CREATE_EVENT", { summary: "Design review", start: "2030-10-27T15:00:00Z" }));
    expect(other.status).toBe("created");
    expect(await cards()).toBe(before + 1);

    // Snapshot ids and the model's call id are dropped for every tool; element refs for the computer's.
    const snap = await approvals().ask(call("ACME_FROBNICATE", { level: 3, snapshotId: "s1", toolCallId: "c1" }));
    expect((await approvals().ask(call("ACME_FROBNICATE", { level: 3, snapshotId: "s2", toolCallId: "c2" }))).status).toBe("already_waiting");
    expect(snap.status).toBe("created");
    const key = await approvals().ask(call("computer_key", { key: "Enter", ref: "e12" }, { toolkit: "duet_computer" }));
    expect((await approvals().ask(call("computer_key", { key: "Enter", ref: "e40" }, { toolkit: "duet_computer" }))).status).toBe("already_waiting");
    expect(key.status).toBe("created");
    // A connector's `ref` is real data: another branch is another call.
    await approvals().ask(call("GITHUB_CREATE_A_REFERENCE", { ref: "refs/heads/a", sha: "1" }));
    expect((await approvals().ask(call("GITHUB_CREATE_A_REFERENCE", { ref: "refs/heads/b", sha: "1" }))).status).toBe("created");
  });

  test("two identical asks at the same moment post one card", async () => {
    const before = await cards();
    const outcomes = await Promise.all([1, 2, 3].map(() => approvals().ask(call("NOTION_CREATE_NOTION_PAGE", { title: "Race" }))));
    expect(outcomes.map((o) => o.status).sort()).toEqual(["already_waiting", "already_waiting", "created"]);
    expect(new Set(outcomes.map(idOf)).size).toBe(1);
    expect(await cards()).toBe(before + 1);
  });
});

describe("the same call after the user declined it", () => {
  test("refused without a card until the user writes in that thread (a task session is its own thread); 25 h later it asks again", async () => {
    const args = { title: "Quarterly plan" };
    const first = approvalOf(await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args)));
    expect((await decide(first.id, "decline")).status).toBe(200);
    const before = await cards();
    const refused = await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args));
    expect([refused.status, idOf(refused)]).toEqual(["declined", first.id]);
    expect(await cards()).toBe(before);

    // The user writes in a task's session: the main thread still reads "declined"; the task asks again.
    const task = await h.fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Planning" } });
    await userSays("Go ahead with the plan page", task.id);
    expect((await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args))).status).toBe("declined");
    const inTask = await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args, { taskId: task.id, sink: sinkIn(task.id) }));
    expect(inTask.status).toBe("created");
    expect((await decide(idOf(inTask)!, "decline")).status).toBe(200);
    expect((await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args))).status).toBe("declined");

    // The user writes in the main thread: a new card.
    await userSays("Actually, make the plan page");
    const second = await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args));
    expect(second.status).toBe("created");
    expect((await decide(idOf(second)!, "decline")).status).toBe(200);
    expect((await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args))).status).toBe("declined");

    // At most 24 hours.
    h.advance(25 * 60 * 60_000);
    try {
      expect((await approvals().ask(call("NOTION_CREATE_NOTION_PAGE", args))).status).toBe("created");
    } finally {
      h.advance(-25 * 60 * 60_000);
    }
  });
});

describe("Always per recipient", () => {
  test("Approve with Always stores one rule per address; covered calls run; one new recipient asks again for all of them", async () => {
    const send = (args: Record<string, unknown>) => approvals().ask(call("GMAIL_SEND_EMAIL", { subject: "Hi", body: "Hello", ...args }));
    const first = approvalOf(await send({ recipient_email: "Sam@Example.com ", cc: ["lee@example.com", "sam@example.com"] }));
    expect(first.always).toEqual({ scope: "recipient", value: "lee@example.com, sam@example.com", category: null });
    expect(first.why).toBeNull();
    const response = await decide(first.id, "approve", { version: 1, always: true });
    expect(response.status).toBe(200);
    expect(ApprovalDecisionResponse.parse(await response.json()).approval).toMatchObject({ status: "approved", result: { ok: true } });
    const rules = await h.fixture.db.approvalRule.findMany({ where: { userId: alex.userId, scopeKind: "recipient" }, orderBy: { scopeValue: "asc" } });
    expect(rules.map((r) => [r.toolSlug, r.scopeValue, r.category])).toEqual([["GMAIL_SEND_EMAIL", "lee@example.com", ""], ["GMAIL_SEND_EMAIL", "sam@example.com", ""]]);

    // Every recipient covered (in any spelling): runs now, no card.
    const before = await cards();
    expect((await send({ recipient_email: "\"Sam\" <SAM@example.com>", body: "Another one" })).status).toBe("allowed");
    expect((await send({ to: "lee@example.com; sam@example.com", body: "Both" })).status).toBe("allowed");
    expect(await cards()).toBe(before);

    // A covered address as the display name can't carry another one along: both are recipients.
    const spoofed = approvalOf(await send({ recipient_email: "\"sam@example.com\" <eve@evil.example>", body: "Spoof" }));
    expect(spoofed.always).toEqual({ scope: "recipient", value: "eve@evil.example, sam@example.com", category: null });
    expect(approvalOf(await send({ to: "sam@example.com eve2@evil.example", body: "Two in one part" })).always?.value).toBe("eve2@evil.example, sam@example.com");
    expect(approvalOf(await send({ to: [{ emailAddress: { name: "sam@example.com", address: "eve3@evil.example" } }], body: "Object" })).always?.value).toBe("eve3@evil.example, sam@example.com");
    expect((await decide(spoofed.id, "decline", { version: 1 })).status).toBe(200);

    // One new recipient: a card whose Always covers all of them; approving it adds only the new one.
    const widened = approvalOf(await send({ recipient_email: "sam@example.com", bcc: "new@example.com" }));
    expect(widened.always).toEqual({ scope: "recipient", value: "new@example.com, sam@example.com", category: null });
    expect((await decide(widened.id, "approve", { version: 1, always: true })).status).toBe(200);
    expect(await h.fixture.db.approvalRule.count({ where: { userId: alex.userId, scopeKind: "recipient" } })).toBe(3);

    // Rules are per tool: Outlook to the same person asks.
    expect((await approvals().ask(call("OUTLOOK_SEND_EMAIL", { to: "sam@example.com", body: "x" }))).status).toBe("created");
  });

  test("no recipients found: no Always row; Always on it, or on a decline, is 400 validation_failed", async () => {
    const card = approvalOf(await approvals().ask(call("SLACK_SEND_MESSAGE", { text: "no channel given" })));
    expect(card.always).toBeNull();
    const refused = await decide(card.id, "approve", { version: 1, always: true });
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toMatchObject({ code: "validation_failed", field: "always" });
    const declining = await decide(card.id, "decline", { version: 1, always: true });
    expect(declining.status).toBe(400);
    expect((await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } })).status).toBe("pending");
    expect((await decide(card.id, "decline", { version: 1, always: false })).status).toBe(200);
  });

  test("an edit by chat is a different call, and its Always covers the edited recipients", async () => {
    const card = approvalOf(await approvals().ask(call("GMAIL_SEND_EMAIL", { recipient_email: "kim@example.com", body: "Draft" })));
    const before = await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } });
    const edited = await approvals().edit(alex.userId, card.id, async ({ args }) => ({ args: { ...args, cc: ["pat@example.com"] }, kind: "action", preview: { ...preview, rows: [{ label: "Cc", value: "pat@example.com" }] } }));
    expect(edited.ok && edited.approval.always).toEqual({ scope: "recipient", value: "kim@example.com, pat@example.com", category: null });
    const after = await h.fixture.db.approval.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // The original call is no longer the one waiting.
    expect((await approvals().ask(call("GMAIL_SEND_EMAIL", { recipient_email: "kim@example.com", body: "Draft" }))).status).toBe("created");
    expect((await decide(card.id, "approve", { version: 2, always: true })).status).toBe(200);
    expect((await h.fixture.db.approvalRule.findMany({ where: { userId: alex.userId, scopeValue: { in: ["kim@example.com", "pat@example.com"] } } })).length).toBe(2);
  });
});

describe("the safety floor on cards", () => {
  test("a floor tool's card says why and offers no Always; an ordinary write has neither", async () => {
    const refund = approvalOf(await approvals().ask(call("STRIPE_CREATE_REFUND", { charge: "ch_1" })));
    expect([refund.why, refund.always]).toEqual([{ key: "approval.why_floor" }, null]);
    expect((await decide(refund.id, "approve", { version: 1, always: true })).status).toBe(400);
    const event = approvalOf(await approvals().ask(call("GOOGLECALENDAR_CREATE_EVENT", { summary: "Plain" })));
    expect([event.why, event.always]).toEqual([null, null]);
  });
});

describe("browser clicks (requestBrowserAction)", () => {
  test("the card shows site, button and why; Always is by site + category; another kind of click or site still asks", async () => {
    const first = approvalOf(await approvals().requestBrowserAction(click()));
    expect(first.preview).toMatchObject({ kind: "action", app: "OpenDuet's computer", toolName: "Click in the browser", browser: { site: "news.example.com", button: "Post comment", category: "send", via: "click" } });
    expect(first.why).toEqual({ key: "approval.why_send" });
    expect(first.always).toEqual({ scope: "site", value: "news.example.com", category: "send" });
    // The same click on a newer snapshot (another ref) is the same call.
    expect((await approvals().requestBrowserAction(click({ args: { ref: "e31" } }))).status).toBe("already_waiting");

    expect((await decide(first.id, "approve", { version: 1, always: true })).status).toBe(200);
    expect((await h.fixture.db.approvalRule.findMany({ where: { userId: alex.userId, scopeKind: "site" } })).map((r) => [r.toolSlug, r.scopeValue, r.category]))
      .toEqual([[BROWSER_ACTION_SLUG, "news.example.com", "send"]]);
    // Another send button on that site runs now; other kinds and other sites ask.
    expect((await approvals().requestBrowserAction(click({ button: "Reply", args: { ref: "e50" } }))).status).toBe("allowed");
    expect((await approvals().requestBrowserAction(click({ site: "News.Example.com", button: "Reply", args: { ref: "e51" } }))).status).toBe("allowed");
    const remove = approvalOf(await approvals().requestBrowserAction(click({ button: "Delete comment", category: "delete" })));
    expect([remove.why, remove.always]).toEqual([{ key: "approval.why_delete" }, { scope: "site", value: "news.example.com", category: "delete" }]);
    expect((await approvals().requestBrowserAction(click({ site: "other.example" }))).status).toBe("created");
  });

  test("purchase, account and checkout pages never offer or honor Always; clicks can't be edited; Always on decline is 400", async () => {
    const buy = approvalOf(await approvals().requestBrowserAction(click({ site: "shop.example", button: "Place your order", category: "purchase" })));
    expect([buy.why, buy.always]).toEqual([{ key: "approval.why_purchase" }, null]);
    expect((await decide(buy.id, "approve", { version: 1, always: true })).status).toBe(400);
    expect((await decide(buy.id, "decline", { version: 1, always: true })).status).toBe(400);
    // Even a rule stored by hand doesn't let a purchase through.
    await h.fixture.db.approvalRule.create({ data: { userId: alex.userId, toolSlug: BROWSER_ACTION_SLUG, scopeKind: "site", scopeValue: "shop.example", category: "purchase" } });
    expect((await approvals().requestBrowserAction(click({ site: "shop.example", button: "Buy now", category: "purchase", args: { ref: "e70" } }))).status).toBe("created");

    const account = approvalOf(await approvals().requestBrowserAction(click({ site: "shop.example", button: "Change password", category: "account" })));
    expect([account.why, account.always]).toEqual([{ key: "approval.why_account" }, null]);

    // A submit on a checkout page: "why" says checkout, and a site rule for submit doesn't cover it.
    await h.fixture.db.approvalRule.create({ data: { userId: alex.userId, toolSlug: BROWSER_ACTION_SLUG, scopeKind: "site", scopeValue: "shop.example", category: "submit" } });
    expect((await approvals().requestBrowserAction(click({ site: "shop.example", button: "Continue", category: "submit", args: { ref: "e80" } }))).status).toBe("allowed");
    const checkout = await approvals().requestBrowserAction(click({ site: "shop.example", button: "Continue", category: "submit", checkoutPage: true, slug: "computer_type", args: { ref: "e81", text: "4242", submit: true }, via: "submit" }));
    expect(checkout.status).toBe("created");
    expect([approvalOf(checkout).why, approvalOf(checkout).always]).toEqual([{ key: "approval.why_checkout" }, null]);

    const edit = await approvals().edit(alex.userId, account.id, async ({ args }) => ({ args: { ...args, ref: "e99" }, kind: "action", preview }));
    expect(edit).toMatchObject({ ok: false, reason: "not_editable" });
    expect((await decide(account.id, "decline")).status).toBe(200);
    expect((await approvals().requestBrowserAction(click({ site: "shop.example", button: "Change password", category: "account", args: { ref: "e90" } }))).status).toBe("declined");
  });
});

describe("execute_app_tools on the new seam", () => {
  const LUNCH = { recipient_email: "dana@example.com", subject: "Lunch", body: "Lunch on Friday?" };

  test("the same write twice in one turn: one card; declined, then refused as the user's decision until they write again", async () => {
    const before = await cards();
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: LUNCH }, { tool: "GMAIL_SEND_EMAIL", arguments: LUNCH })]);
    await h.send(alex, "Ask Dana to lunch");
    const [created, waiting] = resultsOf();
    expect(created).toMatchObject({ status: "awaiting_approval", tool: "Send email" });
    expect(waiting).toMatchObject({ status: "already_waiting", approvalId: created!.approvalId, tool: "Send email" });
    expect(await cards()).toBe(before + 1);
    expect(String(h.lastResults()[0]!.data.note)).toContain("NOT run");

    // Declined while the turn goes on: the retry in that turn is refused without a card.
    h.script(async () => {
      await decide(String(created!.approvalId), "decline");
      return [execute({ tool: "GMAIL_SEND_EMAIL", arguments: LUNCH })];
    });
    await h.send(alex, "Did you ask her?");
    expect(resultsOf()).toEqual([expect.objectContaining({ status: "declined_by_user", approvalId: created!.approvalId, note: expect.stringContaining("their decision") })]);
    expect(await cards()).toBe(before + 1);

    // The user asks again in words: a new card, approved with Always for Dana.
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: LUNCH })]);
    await h.send(alex, "I changed my mind, send it");
    const [again] = resultsOf();
    expect(again).toMatchObject({ status: "awaiting_approval" });
    expect(again!.approvalId).not.toBe(created!.approvalId);
    expect((await decide(String(again!.approvalId), "approve", { version: 1, always: true })).status).toBe(200);

    // Dana is covered: the next mail to her runs right away; Eve still asks.
    const runs = fake().executions.length;
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { ...LUNCH, body: "Noon works?" } }, { tool: "GMAIL_SEND_EMAIL", arguments: { ...LUNCH, recipient_email: "eve@example.com" } })]);
    await h.send(alex, "Follow up with Dana, and ask Eve too");
    expect(resultsOf().map((r) => r.status)).toEqual(["ok", "awaiting_approval"]);
    expect(fake().executions.slice(runs)).toEqual([{ userId: alex.userId, slug: "GMAIL_SEND_EMAIL", args: { ...LUNCH, body: "Noon works?" } }]);
  });

  test("a stored tool-wide Always on a send no longer skips the card", async () => {
    await h.module.policy.setTool(alex.userId, "GMAIL_SEND_EMAIL", "always");
    const runs = fake().executions.length;
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { ...LUNCH, recipient_email: "zoe@example.com" } })]);
    await h.send(alex, "Ask Zoe to lunch");
    expect(resultsOf()).toEqual([expect.objectContaining({ status: "awaiting_approval" })]);
    expect(fake().executions.length).toBe(runs);
    await h.fixture.db.toolPolicy.deleteMany({ where: { userId: alex.userId } });
  });

  test("background turns: nested reads run; writes are refused with no card, even when a rule would cover them", async () => {
    const provider = h.module.providers.find((p) => p.name === "connectors")!;
    for (const kind of ["brief", "checkin", "scan"] as const) {
      const before = await cards();
      const runs = fake().executions.length;
      const input = { userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind, runId: `run_${kind}`, sink: sinkIn() } as unknown as TurnInput;
      const { result } = await provider.execute({ type: "tool_use", id: `t_${kind}`, name: "execute_app_tools", input: { calls: [
        { tool: "GMAIL_FETCH_EMAILS", arguments: { query: "is:unread" } },
        { tool: "GMAIL_SEND_EMAIL", arguments: LUNCH },
        { tool: "GMAIL_DELETE_MESSAGE", arguments: { message_id: "m_1" } },
      ] } }, input);
      const data = JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "null") as { results: Record<string, unknown>[] };
      expect([kind, data.results.map((r) => r.status)]).toEqual([kind, ["ok", "refused", "refused"]]);
      expect(data.results[1]).toMatchObject({ app: "Gmail", tool: "Send email", note: expect.stringContaining("Background turns can only read") });
      expect(await cards()).toBe(before);
      expect(fake().executions.slice(runs).map((e) => e.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);
    }
    // A routine is the user's own task: it asks as usual.
    const input = { userId: alex.userId, channelId: alex.mainChannelId, taskId: null, kind: "routine", runId: "run_routine", sink: sinkIn() } as unknown as TurnInput;
    const { result } = await provider.execute({ type: "tool_use", id: "t_routine", name: "execute_app_tools", input: { calls: [{ tool: "GMAIL_DELETE_MESSAGE", arguments: { message_id: "m_2" } }] } }, input);
    expect(JSON.stringify(result.content)).toContain("awaiting_approval");
  });
});
