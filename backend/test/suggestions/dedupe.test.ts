// M23 W3 (#28): Up next dedupe (suggestions/dedupe.ts) and the one way to add a row
// (suggestions/create.ts createOrLinkSuggestion): normalised titles incl. Chinese / full-width
// punctuation, open = duplicate however old, added = duplicate within 14 days, hidden within 14 days
// = hidden, a named source must be read this turn (RunStep of this run, same app, the id in it),
// pre-M23 rows compared by title, one row for two calls at once, sourceRef's public part only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HIDDEN_SUGGESTION_DAYS } from "../../src/contract/m23.ts";
import type { Db } from "../../src/db.ts";
import { createOrLinkSuggestion } from "../../src/suggestions/create.ts";
import { checkSuggestion, titleKeyOf } from "../../src/suggestions/dedupe.ts";
import { publicSourceRef, readInRun } from "../../src/suggestions/source.ts";
import { createTestDatabase } from "../helpers/db.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2030-03-20T09:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let db: Db;
let cleanup: () => Promise<void>;
let userId: string;
let otherId: string;
beforeAll(async () => {
  ({ db, cleanup } = await createTestDatabase());
  const user = (name: string) => db.user.create({ data: { id: crypto.randomUUID(), name, firstName: name, username: name, authEmail: `${name}@test.invalid` } });
  userId = (await user("alex")).id;
  otherId = (await user("sam")).id;
});
afterAll(() => cleanup());

const row = (title: string, data: Record<string, unknown> = {}) =>
  db.suggestion.create({ data: { userId, title, titleKey: titleKeyOf(title), ...data } });
const check = (title: string, extra: { sourceId?: string; readThisTurn?: Set<string>; user?: string } = {}) =>
  checkSuggestion(db, { userId: extra.user ?? userId, channelId: null, title, app: null, sourceId: extra.sourceId ?? null, ...(extra.readThisTurn ? { readThisTurn: extra.readThisTurn } : {}) }, NOW);

describe("titleKeyOf", () => {
  test("case, spacing, punctuation, emoji and apostrophes don't count", () => {
    expect(titleKeyOf("Reply to Dana's email!")).toBe(titleKeyOf("  reply to Danas   email "));
    expect(titleKeyOf("Prep for the 2 PM.")).toBe(titleKeyOf("prep for the 2 pm"));
    expect(titleKeyOf("📅 Prep — design sync…")).toBe("prep design sync");
    expect(titleKeyOf("Re: Q4 budget (draft)")).toBe("re q4 budget draft");
  });

  test("Chinese and full-width punctuation and spaces: the same key", () => {
    expect(titleKeyOf("【回复】Dana：关于预算！")).toBe(titleKeyOf("回复 Dana 关于预算"));
    expect(titleKeyOf("回复Dana关于预算")).toBe(titleKeyOf("回复 Dana 关于预算"));
    expect(titleKeyOf("整理周报。")).toBe(titleKeyOf("整理周报"));
    expect(titleKeyOf("《年度计划》、“复盘”")).toBe(titleKeyOf("年度计划 复盘"));
    // Full-width letters and digits are their ASCII forms (NFKC); the ideographic space is a space.
    expect(titleKeyOf("Ｑ４　ｂｕｄｇｅｔ")).toBe("q4 budget");
  });

  test("different words stay different; a title of marks only isn't empty", () => {
    expect(titleKeyOf("Reply to Dana")).not.toBe(titleKeyOf("Reply to Dan"));
    expect(titleKeyOf("整理周报")).not.toBe(titleKeyOf("整理月报"));
    expect(titleKeyOf("!!!")).toBe("!!!");
    expect(titleKeyOf("？？")).not.toBe("");
  });
});

describe("checkSuggestion", () => {
  test("new; an open one with the same key is a duplicate however old; another user's never counts", async () => {
    expect(await check("Book the venue")).toEqual({ verdict: "new", titleKey: "book the venue" });
    const open = await row("Book the venue", { createdAt: ago(90) });
    expect(await check("book the VENUE!")).toEqual({ verdict: "duplicate", suggestionId: open.id, titleKey: "book the venue" });
    expect((await check("Book the venue", { user: otherId })).verdict).toBe("new");
  });

  test("added: a duplicate within the window, new after it", async () => {
    const recent = await row("Send the deck", { status: "added", updatedAt: ago(3) });
    expect(await check("Send the deck")).toMatchObject({ verdict: "duplicate", suggestionId: recent.id });
    await row("Renew the domain", { status: "added", updatedAt: ago(HIDDEN_SUGGESTION_DAYS + 1) });
    expect((await check("Renew the domain")).verdict).toBe("new");
  });

  test(`hidden within ${HIDDEN_SUGGESTION_DAYS} days: hidden; older: new; a pre-M23 hidden row counts by updatedAt`, async () => {
    const hid = await row("Archive newsletters", { status: "hidden", hiddenAt: ago(HIDDEN_SUGGESTION_DAYS - 1) });
    expect(await check("Archive newsletters.")).toEqual({ verdict: "hidden", suggestionId: hid.id, titleKey: "archive newsletters" });
    await row("Clean the drive", { status: "hidden", hiddenAt: ago(HIDDEN_SUGGESTION_DAYS + 1) });
    expect((await check("Clean the drive")).verdict).toBe("new");
    const legacyHidden = await db.suggestion.create({ data: { userId, title: "Old hidden one", status: "hidden", updatedAt: ago(2) } });
    expect(await check("old hidden one")).toMatchObject({ verdict: "hidden", suggestionId: legacyHidden.id });
  });

  test("an open one wins over a hidden one of the same key", async () => {
    await row("Call the bank", { status: "hidden", hiddenAt: ago(1) });
    const open = await row("Call the bank");
    expect(await check("Call the bank")).toMatchObject({ verdict: "duplicate", suggestionId: open.id });
  });

  test("rows written before M23 (no titleKey) are compared by their title", async () => {
    const legacy = await db.suggestion.create({ data: { userId, title: "【回复】Priya：预算" } });
    expect(legacy.titleKey).toBeNull();
    expect(await check("回复Priya 预算")).toMatchObject({ verdict: "duplicate", suggestionId: legacy.id });
  });

  test("a named source must be in readThisTurn; without the set it counts as unread", async () => {
    expect((await check("Answer Lee", { sourceId: "msg_18c2f0a1" })).verdict).toBe("unread_source");
    expect((await check("Answer Lee", { sourceId: "msg_18c2f0a1", readThisTurn: new Set(["msg_other"]) })).verdict).toBe("unread_source");
    expect((await check("Answer Lee", { sourceId: "msg_18c2f0a1", readThisTurn: new Set(["msg_18c2f0a1"]) })).verdict).toBe("new");
  });
});

describe("createOrLinkSuggestion", () => {
  /** A run of this user with one ok app step (as runs/steps.ts records an execute_app_tools call). */
  const runWith = async (step: { app: string | null; tool: string; input?: unknown; output?: unknown; status?: string }) => {
    const run = await db.run.create({ data: { userId, kind: "checkin", status: "running" } });
    await db.runStep.create({ data: {
      id: crypto.randomUUID(), runId: run.id, index: 0, kind: "tool", tool: step.tool, app: step.app, title: JSON.stringify({ key: "run.step.tool" }),
      status: step.status ?? "ok", input: step.input === undefined ? null : JSON.stringify(step.input), output: step.output === undefined ? null : JSON.stringify(step.output),
    } });
    return run.id;
  };
  const email = { app: "Gmail", kind: "email" as const, id: "18c2f0a1b2c3d4e5", title: "Re: Q4 budget", at: "2030-03-19T16:20:00.000Z" };

  test("created: an open row with titleKey, origin and the source; its public part has no id", async () => {
    const runId = await runWith({ app: "Gmail", tool: "GMAIL_FETCH_EMAILS", output: { messages: [{ messageId: email.id, subject: "Re: Q4 budget" }] } });
    const made = await createOrLinkSuggestion(db, { userId, channelId: null, title: "Reply to Priya about Q4", body: "She asked twice", origin: "checkin", source: { ...email, app: "gmail" }, runId, now: NOW });
    if (made.outcome !== "created") throw new Error(made.outcome);
    expect(made.suggestion).toMatchObject({ status: "open", titleKey: "reply to priya about q4", origin: "checkin", app: "Gmail" });
    // The record's spelling of the app wins over the model's.
    expect(JSON.parse(made.suggestion.sourceRef!)).toEqual({ ...email, app: "Gmail" });
    expect(publicSourceRef(made.suggestion.sourceRef)).toEqual({ app: "Gmail", kind: "email", title: "Re: Q4 budget", at: "2030-03-19T16:20:00.000Z" });
  });

  test("linked: the same thing again reuses the row and fills a missing titleKey / sourceRef", async () => {
    const legacy = await db.suggestion.create({ data: { userId, title: "Pay the invoice", app: "Gmail" } });
    const runId = await runWith({ app: "Gmail", tool: "GMAIL_GET_MESSAGE", input: { message_id: "18d0aa55bb66cc77" } });
    const again = await createOrLinkSuggestion(db, { userId, channelId: null, title: "Pay the invoice!", origin: "scan", source: { app: "Gmail", kind: "email", id: "18d0aa55bb66cc77", title: "Invoice 42" }, runId, now: NOW });
    expect(again.outcome).toBe("linked");
    const stored = await db.suggestion.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(stored.titleKey).toBe("pay the invoice");
    expect(publicSourceRef(stored.sourceRef)).toEqual({ app: "Gmail", kind: "email", title: "Invoice 42", at: null });
    expect(await db.suggestion.count({ where: { userId, titleKey: "pay the invoice" } })).toBe(1);
  });

  test("hidden and unread_source make nothing", async () => {
    const hid = await row("Unsubscribe from Daily Deals", { status: "hidden", hiddenAt: ago(2) });
    expect(await createOrLinkSuggestion(db, { userId, channelId: null, title: "Unsubscribe from daily deals", origin: "checkin", now: NOW })).toEqual({ outcome: "hidden", suggestionId: hid.id });
    const before = await db.suggestion.count({ where: { userId } });
    const runId = await runWith({ app: "Gmail", tool: "GMAIL_FETCH_EMAILS", output: { messages: [{ messageId: "18aaaaaaaaaaaaaa" }] } });
    // Not in this run's record / another app / a step that failed / an id too short to count / no run at all.
    for (const source of [{ ...email, id: "18ffffffffffffff" }, { ...email, app: "Outlook", id: "18aaaaaaaaaaaaaa" }]) {
      expect((await createOrLinkSuggestion(db, { userId, channelId: null, title: "Something new", origin: "checkin", source, runId, now: NOW })).outcome).toBe("unread_source");
    }
    const failed = await runWith({ app: "Gmail", tool: "GMAIL_FETCH_EMAILS", status: "error", output: { messages: [{ messageId: email.id }] } });
    expect((await createOrLinkSuggestion(db, { userId, channelId: null, title: "Something new", origin: "checkin", source: email, runId: failed, now: NOW })).outcome).toBe("unread_source");
    const short = await runWith({ app: "Gmail", tool: "GMAIL_FETCH_EMAILS", output: { messages: [{ messageId: "42" }] } });
    expect((await createOrLinkSuggestion(db, { userId, channelId: null, title: "Something new", origin: "checkin", source: { ...email, id: "42" }, runId: short, now: NOW })).outcome).toBe("unread_source");
    expect((await createOrLinkSuggestion(db, { userId, channelId: null, title: "Something new", origin: "checkin", source: email, now: NOW })).outcome).toBe("unread_source");
    expect(await db.suggestion.count({ where: { userId } })).toBe(before);
  });

  test("readThisTurn instead of a run: a caller's own read counts", async () => {
    const made = await createOrLinkSuggestion(db, { userId, channelId: null, title: "Prep the design sync", origin: "brief", source: { app: "Google Calendar", kind: "event", id: "evt_design_sync_7", title: "Design sync" }, readThisTurn: new Set(["evt_design_sync_7"]), now: NOW });
    expect(made.outcome).toBe("created");
  });

  test("a web page: read with web_fetch in this run (its URL), app null", async () => {
    const runId = await runWith({ app: null, tool: "web_fetch", input: { url: "https://example.com/launch-notes" }, output: "Launch notes ..." });
    expect(await readInRun(db, runId, { app: null, kind: "web", id: "https://example.com/launch-notes/" })).toEqual({ app: null });
    expect(await readInRun(db, runId, { app: null, kind: "web", id: "https://example.com/other" })).toBeUndefined();
  });

  test("two calls at once for the same thing make one row", async () => {
    const both = await Promise.all([0, 1].map(() => createOrLinkSuggestion(db, { userId, channelId: null, title: "Draft the offsite agenda", origin: "scan", now: NOW })));
    expect(both.map((b) => b.outcome).sort()).toEqual(["created", "linked"]);
    expect(await db.suggestion.count({ where: { userId, titleKey: "draft the offsite agenda" } })).toBe(1);
  });

  test("publicSourceRef: absent, unreadable or off-contract stays null; a title is clipped to 200", () => {
    expect(publicSourceRef(null)).toBeNull();
    expect(publicSourceRef("not json")).toBeNull();
    expect(publicSourceRef(JSON.stringify({ kind: "fax", id: "x", title: "t" }))).toBeNull();
    const long = publicSourceRef(JSON.stringify({ app: "Gmail", kind: "email", id: "x", title: "a".repeat(300), at: "not a date" }));
    expect(long).toMatchObject({ app: "Gmail", kind: "email", at: null });
    expect([...long!.title].length).toBe(200);
    expect(long).not.toHaveProperty("id");
  });
});
