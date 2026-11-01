// The connector tools through the whole chat path (route -> run host -> agent runtime -> scripted
// model -> our executor -> FakeComposio): ToolPolicy is enforced per nested call, writes become
// approval cards and never run, meta tools are refused, and the model only ever reads app names.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { connectorHarness, eventsOf, execute, statuses, tool, type Harness } from "./harness.ts";

let h: Harness;
let alex: SignedIn;
const fake = () => h.fake!;
const SLUG_WORDS = /\b(gmail|googlecalendar|googledocs|slack|acme)\b/;

beforeAll(async () => {
  h = await connectorHarness();
  alex = await signUp(h.fixture, "alex");
  fake().connect(alex.userId, "gmail", "ca_a1");
  fake().connect(alex.userId, "googlecalendar", "ca_cal", null, "EXPIRED");
});
afterAll(() => h.cleanup());

const approvalsOf = (userId: string) => h.fixture.db.approval.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
const allToolResultText = () => h.llm.requests.flatMap((r) => r.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? [JSON.stringify(b.content)] : []))));

describe("connector tools offered to the model", () => {
  test("our four meta tools plus the approval tools; never workbench, bash or any Composio tool", async () => {
    await h.send(alex, "hi");
    const names = h.llm.requests.at(-1)!.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_app_tools", "get_app_tool_schemas", "execute_app_tools", "manage_app_connections", "update_approval", "request_payment"]));
    expect(names.filter((n) => /^COMPOSIO_|workbench|bash|code/i.test(n))).toEqual([]);
    const system = h.llm.requests.at(-1)!.system;
    expect(system).toContain("Connected apps: Gmail (ca_a1@example.com); Google Calendar (Google Calendar (needs reconnecting))");
    expect(system).not.toMatch(SLUG_WORDS);
  });
});

describe("execute_app_tools: ToolPolicy per call", () => {
  test("a read runs right away with exactly the model's arguments (searching_email)", async () => {
    const before = fake().executions.length;
    h.script([execute({ tool: "GMAIL_FETCH_EMAILS", arguments: { query: "from:sam", max_results: 5 } }, { tool: "gmail_get_profile" })]);
    const frames = await h.send(alex, "Any mail from Sam?");
    expect(fake().executions.slice(before)).toEqual([
      { userId: alex.userId, slug: "GMAIL_FETCH_EMAILS", args: { query: "from:sam", max_results: 5 } },
      { userId: alex.userId, slug: "GMAIL_GET_PROFILE", args: {} },
    ]);
    const [result] = h.lastResults();
    expect(result!.data.results).toEqual([
      { index: 0, app: "Gmail", tool: "Fetch emails", status: "ok", data: { ok: true, items: [{ id: "item_1", title: "Quarterly sync" }] } },
      { index: 1, app: "Gmail", tool: "Get profile", status: "ok", data: { ok: true, items: [{ id: "item_1", title: "Quarterly sync" }] } },
    ]);
    expect(statuses(frames)).toEqual(["thinking", "searching_email", "thinking", null]);
    expect(await approvalsOf(alex.userId)).toHaveLength(0);
  });

  test("a write becomes an approval card (row, card message, events) and is not run (writing_draft)", async () => {
    const before = fake().executions.length;
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "sam@example.com", subject: "Q3 numbers", body: "Hi Sam, attached." } })]);
    const frames = await h.send(alex, "Email Sam the Q3 numbers");
    expect(fake().executions.length).toBe(before);
    const [row] = await approvalsOf(alex.userId);
    expect(row).toMatchObject({ kind: "email", toolSlug: "GMAIL_SEND_EMAIL", status: "pending", version: 1, expiresAt: null, taskId: null });
    expect(JSON.parse(row!.arguments)).toEqual({ recipient_email: "sam@example.com", subject: "Q3 numbers", body: "Hi Sam, attached." });
    expect(JSON.parse(row!.preview)).toEqual({ kind: "email", app: "Gmail", to: ["sam@example.com"], cc: [], subject: "Q3 numbers", body: "Hi Sam, attached.", attachments: [] });

    const [result] = h.lastResults();
    expect(result!.data.results).toEqual([{ index: 0, app: "Gmail", tool: "Send email", status: "awaiting_approval", approvalId: row!.id, note: expect.any(String) }]);
    expect(String(result!.data.note)).toContain("NOT run");
    expect(statuses(frames)).toEqual(["thinking", "writing_draft", "thinking", null]);

    // The card message holds { approval } with its own messageId; `approval` follows its `message`.
    const message = await h.fixture.db.message.findUniqueOrThrow({ where: { id: row!.messageId! } });
    expect(message).toMatchObject({ kind: "approval", role: "assistant", channelId: alex.mainChannelId, taskId: null });
    expect(JSON.parse(message.payload).approval).toMatchObject({ id: row!.id, messageId: message.id, status: "pending", version: 1 });
    const cards = eventsOf(frames.events, "message").filter((e) => e.payload.message.kind === "approval");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const approvalEvents = eventsOf(frames.events, "approval");
    expect(approvalEvents.map((e) => e.payload.approval)).toEqual([expect.objectContaining({ id: row!.id, messageId: message.id, status: "pending" })]);
    expect(frames.events.indexOf(cards.at(-1)!)).toBeLessThan(frames.events.indexOf(approvalEvents[0]!));
    // The stored arguments never reach the app.
    expect(JSON.stringify(frames.events)).not.toContain("recipient_email");
  });

  test("multi-execute with a read and a write runs only the read; the write becomes a card (checking_calendar)", async () => {
    const before = fake().executions.length;
    const cards = (await approvalsOf(alex.userId)).length;
    h.script([execute(
      { tool: "GOOGLECALENDAR_FIND_EVENT", arguments: { query: "design review" } },
      { tool: "GOOGLECALENDAR_CREATE_EVENT", arguments: { summary: "Design review", start_datetime: "2030-10-26T15:00:00Z" } },
    )]);
    const frames = await h.send(alex, "Find the design review, and put a new one on Friday");
    expect(fake().executions.slice(before).map((e) => e.slug)).toEqual(["GOOGLECALENDAR_FIND_EVENT"]);
    const rows = await approvalsOf(alex.userId);
    expect(rows).toHaveLength(cards + 1);
    const created = rows.at(-1)!;
    expect(created).toMatchObject({ kind: "action", toolSlug: "GOOGLECALENDAR_CREATE_EVENT", status: "pending" });
    expect(JSON.parse(created.preview)).toEqual({
      kind: "action", app: "Google Calendar", toolName: "Create event",
      rows: [{ label: "Summary", value: "Design review" }, { label: "Start datetime", value: "2030-10-26T15:00:00Z" }], browser: null,
    });
    const [result] = h.lastResults();
    expect((result!.data.results as { status: string }[]).map((r) => r.status)).toEqual(["ok", "awaiting_approval"]);
    expect(statuses(frames)).toEqual(["thinking", "checking_calendar", "thinking", null]);
  });

  test("a tool we can't classify asks (generic card with labelled rows, never JSON)", async () => {
    const before = fake().executions.length;
    h.script([execute({ tool: "ACME_FROBNICATE", arguments: { level: 3 } })]);
    const frames = await h.send(alex, "Frobnicate it");
    expect(fake().executions.length).toBe(before);
    const row = (await approvalsOf(alex.userId)).at(-1)!;
    expect(row).toMatchObject({ kind: "action", toolSlug: "ACME_FROBNICATE", status: "pending" });
    expect(JSON.parse(row.preview)).toEqual({ kind: "action", app: "Acme", toolName: "Frobnicate", rows: [{ label: "Level", value: "3" }], browser: null });
    expect(statuses(frames)).toEqual(["thinking", "checking", "thinking", null]);
  });

  test("meta tools (workbench, bash, nested multi-execute) are refused and unknown tools error; nothing runs", async () => {
    const before = fake().executions.length;
    const cards = (await approvalsOf(alex.userId)).length;
    h.script([execute(
      { tool: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "print(1)" } },
      { tool: "COMPOSIO_REMOTE_BASH_TOOL", arguments: { command: "ls" } },
      { tool: "composio_multi_execute_tool", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] } },
      { tool: "MADE_UP_TOOL", arguments: {} },
    )]);
    await h.send(alex, "Run some code");
    expect(fake().executions.length).toBe(before);
    expect(await approvalsOf(alex.userId)).toHaveLength(cards);
    const [result] = h.lastResults();
    expect((result!.data.results as { status: string }[]).map((r) => r.status)).toEqual(["refused", "refused", "refused", "error"]);
  });

  test("arguments that don't fit the tool come back as invalid_arguments and make no card", async () => {
    const cards = (await approvalsOf(alex.userId)).length;
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "sam@example.com", is_html: "yes" } })]);
    await h.send(alex, "Email Sam");
    expect(await approvalsOf(alex.userId)).toHaveLength(cards);
    const [result] = h.lastResults();
    expect(result!.data.results).toEqual([{ index: 0, app: "Gmail", tool: "Send email", status: "invalid_arguments", issues: ["body: required", "is_html: expected boolean"] }]);
  });

  test("M20: a write carrying a credential is refused before it can become a card; nothing runs", async () => {
    const cards = (await approvalsOf(alex.userId)).length;
    const before = fake().executions.length;
    const key = `sk-ant-${"a1".repeat(16)}`;
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "sam@example.com", body: `Here's the key: ${key}` } })]);
    await h.send(alex, "Email Sam the key");
    expect(await approvalsOf(alex.userId)).toHaveLength(cards);
    expect(fake().executions.length).toBe(before);
    const [result] = h.lastResults();
    const text = JSON.stringify(result!.data);
    expect(result!.data.results).toEqual([{ index: 0, app: "Gmail", tool: "Send email", status: "refused", error: expect.any(String), findings: [{ category: "provider_token", path: "$.body" }] }]);
    expect(text).not.toContain(key);
  });

  // M20: the write is a calendar event (a stored Always on a send reads as Ask: test/approvals/ask.test.ts).
  test("the user's Always runs a write directly; an All tools Ask turns even reads into cards", async () => {
    await h.module.policy.setTool(alex.userId, "GOOGLECALENDAR_CREATE_EVENT", "always");
    const before = fake().executions.length;
    h.script([execute({ tool: "GOOGLECALENDAR_CREATE_EVENT", arguments: { summary: "Launch" } })]);
    await h.send(alex, "Put the launch on my calendar");
    expect(fake().executions.slice(before)).toEqual([{ userId: alex.userId, slug: "GOOGLECALENDAR_CREATE_EVENT", args: { summary: "Launch" } }]);

    await h.module.policy.setToolkit(alex.userId, "gmail", "ask", ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
    const cards = (await approvalsOf(alex.userId)).length;
    h.script([execute({ tool: "GMAIL_FETCH_EMAILS", arguments: { query: "is:unread" } })]);
    await h.send(alex, "Check my unread mail");
    expect(fake().executions.length).toBe(before + 1);
    const rows = await approvalsOf(alex.userId);
    expect(rows).toHaveLength(cards + 1);
    expect(rows.at(-1)).toMatchObject({ kind: "action", toolSlug: "GMAIL_FETCH_EMAILS" });
    await h.fixture.db.toolPolicy.deleteMany({ where: { userId: alex.userId } });
  });
});

describe("search, schemas and connections speak app names", () => {
  test("search and schemas: display names, approval needs, guidance without slugs (looking_up)", async () => {
    h.script([
      tool("search_app_tools", { query: "read my email", apps: ["Gmail", "Nope"] }),
      tool("get_app_tool_schemas", { tools: ["GMAIL_SEND_EMAIL", "COMPOSIO_REMOTE_WORKBENCH", "NOPE_TOOL"] }),
    ]);
    const frames = await h.send(alex, "What can you do in my mail?");
    expect(fake().searches.at(-1)).toEqual({ userId: alex.userId, query: "read my email", toolkits: ["gmail"] });
    const [search, schemas] = h.lastResults().map((r) => r.data);
    expect(search).toEqual({
      tools: [
        { tool: "GMAIL_FETCH_EMAILS", app: "Gmail", description: "List recent messages in Gmail.", needsApproval: false },
        { tool: "GMAIL_GET_PROFILE", app: "Gmail", description: "The account's address.", needsApproval: false },
        { tool: "GMAIL_SEND_EMAIL", app: "Gmail", description: "Send a message.", needsApproval: true },
        { tool: "GMAIL_DELETE_MESSAGE", app: "Gmail", description: "Delete a message.", needsApproval: true },
      ],
      apps: [{ app: "Gmail", connected: true }],
      guidance: ["Use Gmail search syntax for queries; Google Calendar times are RFC 3339."],
      unknownApps: ["Nope"],
    });
    expect(schemas).toMatchObject({
      tools: [{ tool: "GMAIL_SEND_EMAIL", app: "Gmail", name: "Send email", needsApproval: true, arguments: { required: ["recipient_email", "body"] } }],
      notFound: ["COMPOSIO_REMOTE_WORKBENCH", "NOPE_TOOL"],
    });
    expect(statuses(frames)).toEqual(["thinking", "looking_up", "thinking", "looking_up", "thinking", null]);
  });

  test("manage_app_connections: a connect card for Slack, a reconnect card for an expired app, Gmail connected", async () => {
    h.script([tool("manage_app_connections", { apps: ["Slack", "Gmail", "google calendar", "Nonexistent App"] })]);
    const frames = await h.send(alex, "Connect Slack");
    const [result] = h.lastResults();
    expect(result!.data).toEqual({ apps: [
      { app: "Slack", status: "connect_card_shown" },
      { app: "Gmail", status: "connected", accounts: ["ca_a1@example.com"] },
      { app: "Google Calendar", status: "reconnect_card_shown" },
      { app: "Nonexistent App", status: "unknown_app" },
    ] });
    expect(fake().authorizations.slice(-2)).toEqual([
      { userId: alex.userId, toolkit: "slack", callbackUrl: "duet://oauth" },
      { userId: alex.userId, toolkit: "googlecalendar", callbackUrl: "duet://oauth" },
    ]);
    const alerts = eventsOf(frames.events, "message").map((e) => e.payload.message).filter((m) => m.kind === "alert");
    expect(alerts.map((m) => m.payload)).toEqual([
      {
        title: { key: "alert.one_thing" },
        body: { key: "connectors.connect_body", params: { app: { type: "text", value: "Slack" } } },
        action: { label: { key: "connectors.connect_action", params: { app: { type: "text", value: "Slack" } } }, type: "open_connector", url: "https://connect.composio.test.invalid/link/slack", toolkit: "slack" },
      },
      expect.objectContaining({ body: { key: "connectors.connect_body", params: { app: { type: "text", value: "Google Calendar" } } } }),
    ]);
    expect(statuses(frames)).toEqual(["thinking", "checking", "thinking", null]);
  });

  test("no toolkit slug reached the model in any tool result of this file", () => {
    const texts = allToolResultText();
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.filter((t) => SLUG_WORDS.test(t))).toEqual([]);
  });
});
