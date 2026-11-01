// /api/connectors: without COMPOSIO_API_KEY the list says configured: false, every other route is
// 503 not_configured and the model gets no app tools; with it, the catalog (connected first, real
// account labels), a toolkit's tools grouped Read / Write with their mode, the Ask / Always policy
// (one tool or All tools), logos through the server (cached), OAuth links and Disconnect.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/composio/gateway.ts";
import { ConnectorDetail, ConnectorList, ConnectResponse } from "../../src/contract/connectors.ts";
import { loadMessage } from "../../src/runs/serialize.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { connectorHarness, execute, tool, type Harness } from "./harness.ts";

describe("not configured (no COMPOSIO_API_KEY)", () => {
  let h: Harness;
  let alex: SignedIn;
  beforeAll(async () => {
    h = await connectorHarness({ configured: false });
    alex = await signUp(h.fixture, "alex");
  });
  afterAll(() => h.cleanup());

  test("the list says configured: false; every other route is 503 not_configured", async () => {
    const list = await h.get(alex, "/api/connectors?query=mail");
    expect(list.status).toBe(200);
    expect(ConnectorList.parse(await list.json())).toEqual({ configured: false, connectors: [] });
    const others: [string, RequestInit][] = [
      ["/api/connectors/gmail", {}],
      ["/api/connectors/gmail/logo", {}],
      ["/api/connectors/gmail/connect", { method: "POST" }],
      ["/api/connectors/gmail/accounts/ca_a1", { method: "DELETE" }],
      ["/api/connectors/gmail/policy", { method: "PUT", body: JSON.stringify({ tool: null, mode: "always" }) }],
    ];
    for (const [path, init] of others) {
      const response = await h.get(alex, path, init);
      expect([path, response.status]).toEqual([path, 503]);
      expect((await errorOf(response)).code).toBe("not_configured");
    }
    expect((await h.get(null, "/api/connectors")).status).toBe(401);
  });

  test("the model gets no app tools (request_payment still works) and is told apps aren't set up", async () => {
    h.script([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@b.co", body: "x" } })], [tool("update_approval", { approvalId: "x", changes: {} })]);
    await h.send(alex, "Email Sam");
    const request = h.llm.requests.at(-3)!;
    const names = request.tools!.map((t) => t.name);
    expect(names).toContain("request_payment");
    expect(names.filter((n) => /app_tool|app_connections|update_approval|COMPOSIO/.test(n))).toEqual([]);
    expect(request.system).toContain("aren't set up on this server yet");
    // Even if a model calls them anyway, nothing is offered or run.
    for (const r of h.llm.requests.slice(-2)) {
      const block = r.messages.at(-1)!.content[0]!;
      expect(block).toMatchObject({ type: "tool_result", isError: true });
    }
    expect(await h.fixture.db.approval.count()).toBe(0);

    h.script([tool("request_payment", { amount: 3.5, merchant: "Cafe", description: "Tea" })]);
    await h.send(alex, "Pay for tea");
    const card = await h.fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId } });
    const approved = await h.decide(alex, card.id, "approve", 1);
    expect(await approved.json()).toMatchObject({ approval: { status: "approved", result: { ok: true } } });
  });

  test("a stored connector card can't run without the key: it fails with a reason and stays pending", async () => {
    // A card stored while the key was set (written straight to the thread, like the run host's sink).
    const approval = await h.module.approvals.createToolApproval({
      userId: alex.userId, taskId: null, slug: "GMAIL_SEND_EMAIL", args: { recipient_email: "a@b.co", body: "x" }, kind: "email",
      preview: { kind: "email", app: "Gmail", to: ["a@b.co"], cc: [], subject: "", body: "x", attachments: [] },
      sink: {
        upsertMessage: async (draft) => {
          const row = await h.fixture.db.message.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, role: "assistant", kind: draft.kind, text: "", payload: JSON.stringify("payload" in draft ? draft.payload : {}) } });
          return (await loadMessage(h.fixture.db, row.id))!;
        },
      },
    });
    const response = await h.decide(alex, approval.id, "approve", 1);
    expect(await response.json()).toMatchObject({ approval: { status: "pending", result: { ok: false, error: { key: "approval.failed", params: { reason: { value: "Connected apps aren't set up on this server." } } } } } });
  });
});

describe("configured", () => {
  let h: Harness;
  let alex: SignedIn;
  let sam: SignedIn;
  const fake = () => h.fake!;
  beforeAll(async () => {
    h = await connectorHarness();
    alex = await signUp(h.fixture, "alex");
    sam = await signUp(h.fixture, "sam");
    fake().connect(alex.userId, "gmail", "ca_a1");
    fake().connect(alex.userId, "googlecalendar", "ca_cal", "alex@work.example");
    fake().connect(alex.userId, "slack", "ca_slack", null, "EXPIRED");
    fake().connect(alex.userId, "acme", "ca_acme", null, "INITIATED");
  });
  afterAll(() => h.cleanup());

  const list = async (user: SignedIn, query = "") => ConnectorList.parse(await (await h.get(user, `/api/connectors${query}`)).json());
  const detail = async (user: SignedIn, toolkit: string) => ConnectorDetail.parse(await (await h.get(user, `/api/connectors/${toolkit}`)).json());
  const modes = (d: { tools: { slug: string; mode: string }[] }) => Object.fromEntries(d.tools.map((t) => [t.slug, t.mode]));

  test("the list: connected apps first, display names, categories, real account labels (profile looked up once)", async () => {
    const body = await list(alex);
    expect(body.configured).toBe(true);
    expect(body.connectors.map((c) => c.toolkit)).toEqual(["slack", "gmail", "googlecalendar", "googledocs", "acme"]);
    const by = Object.fromEntries(body.connectors.map((c) => [c.toolkit, c]));
    expect(by.gmail).toEqual({
      toolkit: "gmail", name: "Gmail", description: "Read, draft and send email.", logoUrl: "/api/connectors/gmail/logo", category: "mail",
      accounts: [{ id: "ca_a1", label: "ca_a1@example.com", status: "active", connectedAt: "2030-10-25T08:00:00.000Z" }],
    });
    expect(by.googlecalendar!.accounts).toEqual([expect.objectContaining({ id: "ca_cal", label: "alex@work.example", status: "active" })]);
    expect(by.slack!.accounts).toEqual([expect.objectContaining({ id: "ca_slack", label: "Slack", status: "expired" })]);
    // A connection still being set up isn't shown.
    expect(by.acme).toMatchObject({ name: "Acme", category: null, accounts: [] });
    expect([by.googlecalendar!.category, by.googledocs!.category, by.slack!.category]).toEqual(["calendar", "files", "team_chat"]);
    await list(alex);
    expect(fake().profileLookups).toEqual([{ userId: alex.userId, accountId: "ca_a1", slug: "GMAIL_GET_PROFILE", args: {} }]);

    expect((await list(alex, "?query=calendar")).connectors.map((c) => c.toolkit)).toEqual(["googlecalendar"]);
    expect((await list(alex, "?query=Google")).connectors.map((c) => c.toolkit)).toEqual(["googlecalendar", "googledocs"]);
    // Accounts are per user.
    expect((await list(sam)).connectors.flatMap((c) => c.accounts)).toEqual([]);
  });

  test("a toolkit's tools: Read before Write, common first, each with its mode; unknown toolkits are 404", async () => {
    const gmail = await detail(alex, "gmail");
    expect(gmail.connector.name).toBe("Gmail");
    expect(gmail.tools.map((t) => [t.slug, t.name, t.access, t.mode, t.common])).toEqual([
      ["GMAIL_FETCH_EMAILS", "Fetch emails", "read", "always", true],
      ["GMAIL_GET_PROFILE", "Get profile", "read", "always", false],
      ["GMAIL_SEND_EMAIL", "Send email", "write", "ask", true],
      ["GMAIL_DELETE_MESSAGE", "Delete message", "write", "ask", false],
    ]);
    expect((await detail(alex, "acme")).tools).toEqual([expect.objectContaining({ slug: "ACME_FROBNICATE", access: "write", mode: "ask" })]);
    for (const path of ["/api/connectors/nope", "/api/connectors/Not%20A%20Slug", "/api/connectors/nope/logo"]) {
      const response = await h.get(alex, path);
      expect([path, response.status]).toEqual([path, 404]);
    }
  });

  test("policy: one tool, then All tools (clears the per-tool choices); per user; bad input is 400", async () => {
    const put = (user: SignedIn, toolkit: string, body: unknown) => h.get(user, `/api/connectors/${toolkit}/policy`, { method: "PUT", body: JSON.stringify(body) });
    // M20: the one tool is a delete (Always on sending mail is refused, see the next test).
    const one = await put(alex, "gmail", { tool: "GMAIL_DELETE_MESSAGE", mode: "always" });
    expect(one.status).toBe(200);
    expect(modes(ConnectorDetail.parse(await one.json()))).toEqual({ GMAIL_FETCH_EMAILS: "always", GMAIL_GET_PROFILE: "always", GMAIL_SEND_EMAIL: "ask", GMAIL_DELETE_MESSAGE: "always" });

    const all = await put(alex, "gmail", { tool: null, mode: "ask" });
    expect(modes(ConnectorDetail.parse(await all.json()))).toEqual({ GMAIL_FETCH_EMAILS: "ask", GMAIL_GET_PROFILE: "ask", GMAIL_SEND_EMAIL: "ask", GMAIL_DELETE_MESSAGE: "ask" });
    expect(await h.fixture.db.toolPolicy.findMany({ where: { userId: alex.userId }, select: { toolSlug: true, mode: true } })).toEqual([{ toolSlug: "toolkit:gmail", mode: "ask" }]);
    // The agent obeys it: a read now asks.
    h.script([execute({ tool: "GMAIL_FETCH_EMAILS" })]);
    await h.send(alex, "Check mail");
    expect(h.lastResults()[0]!.data.results).toEqual([expect.objectContaining({ status: "awaiting_approval" })]);

    // A per-tool choice still beats the toolkit's.
    await put(alex, "gmail", { tool: "GMAIL_FETCH_EMAILS", mode: "always" });
    expect(modes(await detail(alex, "gmail")).GMAIL_FETCH_EMAILS).toBe("always");
    expect(modes(await detail(sam, "gmail"))).toEqual({ GMAIL_FETCH_EMAILS: "always", GMAIL_GET_PROFILE: "always", GMAIL_SEND_EMAIL: "ask", GMAIL_DELETE_MESSAGE: "ask" });

    for (const [toolkit, body] of [
      ["gmail", { tool: "SLACK_SEND_MESSAGE", mode: "always" }],
      ["gmail", { tool: "COMPOSIO_REMOTE_WORKBENCH", mode: "always" }],
      ["gmail", { tool: null, mode: "sometimes" }],
      ["gmail", { mode: "always" }],
      ["gmail", { tool: null, mode: "always", extra: 1 }],
    ] as const) {
      const response = await put(alex, toolkit, body);
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), 400]);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    expect((await put(alex, "nope", { tool: null, mode: "always" })).status).toBe(404);
  });

  test("M20 safety floor: rows say which Always is blocked and why; Always on one is 400; All tools Always skips them", async () => {
    await h.fixture.db.toolPolicy.deleteMany({ where: { userId: alex.userId } });
    const put = (body: unknown) => h.get(alex, "/api/connectors/gmail/policy", { method: "PUT", body: JSON.stringify(body) });
    const fields = (d: { tools: { slug: string; alwaysAllowed: boolean; alwaysBlocked: string | null }[] }) => Object.fromEntries(d.tools.map((t) => [t.slug, [t.alwaysAllowed, t.alwaysBlocked]]));
    expect(fields(await detail(alex, "gmail"))).toEqual({
      GMAIL_FETCH_EMAILS: [true, null], GMAIL_GET_PROFILE: [true, null], GMAIL_SEND_EMAIL: [false, "per_recipient"], GMAIL_DELETE_MESSAGE: [true, null],
    });
    expect(fields(await detail(alex, "slack"))).toEqual({ SLACK_SEND_MESSAGE: [false, "per_recipient"] });

    const refused = await put({ tool: "GMAIL_SEND_EMAIL", mode: "always" });
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toMatchObject({ code: "always_not_allowed", field: "mode" });
    expect(await h.fixture.db.toolPolicy.count({ where: { userId: alex.userId } })).toBe(0);
    // Ask on such a tool is fine.
    expect((await put({ tool: "GMAIL_SEND_EMAIL", mode: "ask" })).status).toBe(200);

    const all = await put({ tool: null, mode: "always" });
    expect(all.status).toBe(200);
    expect(modes(ConnectorDetail.parse(await all.json()))).toEqual({ GMAIL_FETCH_EMAILS: "always", GMAIL_GET_PROFILE: "always", GMAIL_SEND_EMAIL: "ask", GMAIL_DELETE_MESSAGE: "always" });
    // The model is told the send still needs approval.
    h.script([tool("search_app_tools", { query: "send mail", apps: ["Gmail"] })]);
    await h.send(alex, "What can you do in Gmail?");
    const found = (h.lastResults()[0]!.data.tools as { tool: string; needsApproval: boolean }[]);
    expect(Object.fromEntries(found.map((t) => [t.tool, t.needsApproval]))).toMatchObject({ GMAIL_SEND_EMAIL: true, GMAIL_DELETE_MESSAGE: false });
    await h.fixture.db.toolPolicy.deleteMany({ where: { userId: alex.userId } });
  });

  test("logos come through the server as images and are cached; no logo is 404", async () => {
    const first = await h.get(alex, "/api/connectors/slack/logo");
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("image/png");
    expect(first.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(first.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const fetches = fake().logoFetches;
    expect((await h.get(alex, "/api/connectors/slack/logo")).status).toBe(200);
    expect(fake().logoFetches).toBe(fetches);
    expect((await h.get(alex, "/api/connectors/acme/logo")).status).toBe(404);
  });

  test("connect answers Composio's hosted link and the duet callback scheme", async () => {
    const response = await h.get(alex, "/api/connectors/googledocs/connect", { method: "POST" });
    expect(response.status).toBe(200);
    expect(ConnectResponse.parse(await response.json())).toEqual({ url: "https://connect.composio.test.invalid/link/googledocs", callbackScheme: "duet" });
    expect(fake().authorizations.at(-1)).toEqual({ userId: alex.userId, toolkit: "googledocs", callbackUrl: "duet://oauth" });
  });

  test("disconnect: only your own account of that toolkit (else 404); then it's gone", async () => {
    const del = (user: SignedIn, path: string) => h.get(user, path, { method: "DELETE" });
    expect((await del(sam, "/api/connectors/gmail/accounts/ca_a1")).status).toBe(404);
    expect((await del(alex, "/api/connectors/slack/accounts/ca_a1")).status).toBe(404);
    expect((await del(alex, "/api/connectors/gmail/accounts/ca_missing")).status).toBe(404);
    expect(fake().disconnected).toEqual([]);
    const gone = await del(alex, "/api/connectors/gmail/accounts/ca_a1");
    expect(gone.status).toBe(204);
    expect(fake().disconnected).toEqual(["ca_a1"]);
    expect((await list(alex)).connectors.find((c) => c.toolkit === "gmail")!.accounts).toEqual([]);
  });

  test("Composio being unreachable is a 502 without its detail", async () => {
    const original = fake().listTools.bind(fake());
    fake().listTools = async () => { throw new GatewayError("ECONNRESET api.composio.dev token=sk_live_abc"); };
    try {
      const response = await h.get(alex, "/api/connectors/googledocs");
      expect(response.status).toBe(502);
      const error = await errorOf(response);
      expect(error.code).toBe("internal");
      expect(error.message).not.toContain("composio.dev");
    } finally {
      fake().listTools = original;
    }
  });
});
