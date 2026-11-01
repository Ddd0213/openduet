// Card previews (L157, L182): readable fields, never raw JSON; changedFields of an edit; money.
import { describe, expect, test } from "bun:test";
import { ApprovalPreview } from "../../src/contract/approvals.ts";
import { isCurrency, minorDigits, toMinorUnits } from "../../src/approvals/money.ts";
import { buildPreview, changedFields, humanLabel, rowsOf } from "../../src/approvals/preview.ts";

describe("buildPreview", () => {
  test("an email shows to / cc / subject / body / attachments", () => {
    const { kind, preview } = buildPreview({
      kind: "email", app: "Gmail", toolName: "Send email",
      args: { recipient_email: "sam@example.com", cc: ["lee@example.com"], subject: "Renewal", body: "Hi Sam", attachment: { name: "quote.pdf", mimetype: "application/pdf" }, user_id: "me" },
    });
    expect(kind).toBe("email");
    expect(preview).toEqual({ kind: "email", app: "Gmail", to: ["sam@example.com"], cc: ["lee@example.com"], subject: "Renewal", body: "Hi Sam", attachments: [{ name: "quote.pdf", mime: "application/pdf", fileId: null }] });
    expect(ApprovalPreview.safeParse(preview).success).toBe(true);
  });

  test("HTML bodies are shown as text", () => {
    const { preview } = buildPreview({ kind: "email", app: "Gmail", toolName: "Send email", args: { recipient_email: "a@example.com", body: "<p>Hello <b>there</b></p>", is_html: true } });
    expect(preview.kind === "email" && preview.body).toBe("Hello there");
  });

  test("an email with bcc or arguments the email card can't show falls back to labelled rows", () => {
    const bcc = buildPreview({ kind: "email", app: "Gmail", toolName: "Send email", args: { recipient_email: "a@example.com", bcc: ["hidden@example.com"], body: "x" } });
    expect(bcc.kind).toBe("action");
    expect(JSON.stringify(bcc.preview)).toContain("hidden@example.com");
    const odd = buildPreview({ kind: "email", app: "Gmail", toolName: "Send email", args: { recipient_email: "a@example.com", body: "x", schedule_at: "tomorrow" } });
    expect(odd.preview).toMatchObject({ kind: "action", rows: expect.arrayContaining([{ label: "Schedule at", value: "tomorrow" }]) });
  });

  test("generic cards are labelled rows, never JSON", () => {
    const { preview } = buildPreview({ kind: "action", app: "Google Calendar", toolName: "Create event", args: { summary: "Evals review", start_datetime: "2030-10-26T13:45:00Z", attendees: ["sam@example.com", "lee@example.com"], reminders: { useDefault: false, minutes: 10 }, send_updates: true } });
    expect(preview).toEqual({ kind: "action", app: "Google Calendar", toolName: "Create event", rows: [
      { label: "Summary", value: "Evals review" },
      { label: "Start datetime", value: "2030-10-26T13:45:00Z" },
      { label: "Attendees", value: "sam@example.com, lee@example.com" },
      { label: "Reminders", value: "Use default: No; Minutes: 10" },
      { label: "Send updates", value: "Yes" },
    ] });
    expect(JSON.stringify(preview)).not.toContain("{\\\"");
  });

  test("sign and delete cards get a title", () => {
    expect(buildPreview({ kind: "delete", app: "Gmail", toolName: "Delete message", args: { message_id: "m1" } }).preview).toEqual({ kind: "delete", app: "Gmail", title: "Delete message", rows: [{ label: "Message id", value: "m1" }] });
    expect(buildPreview({ kind: "sign", app: "DocuSign", toolName: "Send envelope", args: { email_subject: "Northfield MSA" } }).preview).toMatchObject({ kind: "sign", title: "Northfield MSA" });
  });

  test("rows are capped and labels humanized", () => {
    expect(humanLabel("startDateTime")).toBe("Start date time");
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i}`, `v${i}`]));
    const rows = rowsOf(many);
    expect(rows).toHaveLength(20);
    expect(rows.at(-1)).toEqual({ label: "More", value: "11 more fields" });
  });
});

describe("nested arguments on generic cards", () => {
  const runbook = [
    "Go-live runbook for the marketing website. One line per item — tick as you go.",
    "",
    "## Phase 1 — T-7 days: decide, freeze, prepare",
    "- [ ] Freeze scope — no new pages or features after today. *Verify: release branch cut; change log closed.*",
    "- [ ] Confirm registrar access. *Verify: you can log in and see the domain's DNS records.*",
    "- [ ] Lower DNS TTL to 300 s. *Verify: dig shows the new TTL.*",
    "",
    "## Phase 2 — T-1 day: rehearse",
    "- [ ] Run the full deploy on staging. *Verify: staging serves the release build.*",
    "- [ ] Check every form posts to the right inbox. *Verify: test submissions arrive.*",
  ].join("\n");
  const createPages = (content: string) => buildPreview({ kind: "action", app: "Notion", toolName: "Create pages", args: {
    parent: { page_id: "p-123" }, pages: [{ properties: { title: "Website launch" }, content }], creation_mode: "draft",
  } });

  test("a Notion MCP create-pages card: the title first, the whole markdown content last", () => {
    expect(runbook.length).toBeGreaterThan(500);
    const { kind, preview } = createPages(runbook);
    expect(kind).toBe("action");
    expect(preview).toEqual({ kind: "action", app: "Notion", toolName: "Create pages", rows: [
      { label: "Title", value: "Website launch" },
      { label: "Parent", value: "Page id: p-123" },
      { label: "Creation mode", value: "draft" },
      { label: "Content", value: runbook },
    ] });
    expect(ApprovalPreview.safeParse(preview).success).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("{\\\"");
    // Same labels for the same arguments: an edit of the content glows only that row.
    expect(changedFields(preview, createPages(`${runbook}\n- [ ] Celebrate.`).preview)).toEqual(["rows.Content"]);
  });

  test("rich-text properties read as plain text under the property's name", () => {
    expect(rowsOf({ parent: { database_id: "db-1" }, properties: { Name: { title: [{ text: { content: "Q3 plan" } }] }, Status: { select: { name: "Draft" } } } })).toEqual([
      { label: "Name", value: "Q3 plan" },
      { label: "Parent", value: "Database id: db-1" },
      { label: "Status", value: "Draft" },
    ]);
  });

  test("a long one-line value is cut at a word with …; long text keeps up to 20,000 characters", () => {
    const [note] = rowsOf({ note: "lorem ipsum dolor sit amet ".repeat(30) });
    expect(note!.value).toBe(`${"lorem ipsum dolor sit amet ".repeat(18)}lorem ipsum…`);
    const [description] = rowsOf({ description: "word ".repeat(5000) });
    expect(description!.value).toBe(`${"word ".repeat(4000).trim()}…`);
  });

  test("several pages: rows labelled by position, titles first", () => {
    expect(rowsOf({ pages: [{ properties: { title: "A" }, content: "One\nTwo" }, { properties: { title: "B" }, content: "Three" }] })).toEqual([
      { label: "Pages 1 title", value: "A" },
      { label: "Pages 2 title", value: "B" },
      { label: "Pages 1 content", value: "One\nTwo" },
      { label: "Pages 2 content", value: "Three" },
    ]);
  });

  test("a nested label already taken gets its parent's label first", () => {
    expect(rowsOf({ title: "Doc", page: { title: "Inner", body: "a\nb" } })).toEqual([
      { label: "Title", value: "Doc" },
      { label: "Page title", value: "Inner" },
      { label: "Body", value: "a\nb" },
    ]);
  });
});

describe("changedFields", () => {
  test("email fields and row labels", () => {
    const a = buildPreview({ kind: "email", app: "Gmail", toolName: "Send email", args: { recipient_email: "sam@example.com", subject: "Hi", body: "One" } }).preview;
    const b = buildPreview({ kind: "email", app: "Gmail", toolName: "Send email", args: { recipient_email: "sam@example.com", subject: "Hi", body: "One. So excited!" } }).preview;
    expect(changedFields(a, b)).toEqual(["body"]);
    const c = buildPreview({ kind: "action", app: "Google Calendar", toolName: "Create event", args: { summary: "Sync", start_datetime: "2pm" } }).preview;
    const d = buildPreview({ kind: "action", app: "Google Calendar", toolName: "Create event", args: { summary: "Sync", start_datetime: "3pm", location: "Room 4" } }).preview;
    expect(changedFields(c, d)).toEqual(["rows.Start datetime", "rows.Location"]);
  });
});

describe("money", () => {
  test("minor units by currency (Intl digits)", () => {
    expect(minorDigits("USD")).toBe(2);
    expect(minorDigits("JPY")).toBe(0);
    expect(toMinorUnits(16.49, "USD")).toBe(1649);
    expect(toMinorUnits(640, "usd")).toBe(64000);
    expect(toMinorUnits(1200, "JPY")).toBe(1200);
    expect(toMinorUnits(1.005, "KWD")).toBe(1005);
  });

  test("bad currencies and amounts are refused", () => {
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("XYZ")).toBe(false);
    expect(() => toMinorUnits(10, "XYZ")).toThrow(RangeError);
    expect(() => toMinorUnits(0, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(Number.NaN, "USD")).toThrow(RangeError);
  });
});
