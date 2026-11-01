// Test-only ComposioGateway: an in-memory catalog, tools and accounts. Records every execution
// (with the exact arguments) and never touches the network.
import type { ComposioGateway, GatewayAccount, GatewayExecution, GatewaySearchResult, GatewayTool, GatewayToolkit } from "../../src/composio/gateway.ts";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = { type: "string" };

export const FAKE_TOOLKITS: GatewayToolkit[] = [
  { slug: "slack", name: "Slack", description: "Team chat.", logo: "https://logos.test.invalid/slack.png", categories: ["Communication"] },
  { slug: "googledocs", name: "Google Docs", description: "Read and edit documents.", logo: "https://logos.test.invalid/googledocs.png", categories: ["Documents"] },
  { slug: "gmail", name: "Gmail", description: "Read, draft and send email.", logo: "https://logos.test.invalid/gmail.png", categories: ["Email"] },
  { slug: "googlecalendar", name: "Google Calendar", description: "Events and availability.", logo: "https://logos.test.invalid/googlecalendar.png", categories: ["Scheduling"] },
  { slug: "acme", name: "Acme", description: "A made-up app.", logo: null, categories: [] },
];

export const FAKE_TOOLS: GatewayTool[] = [
  { slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail", name: "Fetch emails", description: "List recent messages in gmail.", tags: ["readOnlyHint"], inputSchema: schema({ query: str, max_results: { type: "integer" } }), important: true },
  { slug: "GMAIL_GET_PROFILE", toolkit: "gmail", name: "Get profile", description: "The account's address.", tags: ["readOnlyHint"], inputSchema: schema({}), important: false },
  { slug: "GMAIL_SEND_EMAIL", toolkit: "gmail", name: "Send Email", description: "Send a message.", tags: [], inputSchema: schema({ recipient_email: str, cc: { type: "array" }, subject: str, body: str, is_html: { type: "boolean" } }, ["recipient_email", "body"]), important: true },
  { slug: "GMAIL_DELETE_MESSAGE", toolkit: "gmail", name: "Delete message", description: "Delete a message.", tags: ["destructiveHint"], inputSchema: schema({ message_id: str }, ["message_id"]), important: false },
  { slug: "GOOGLECALENDAR_FIND_EVENT", toolkit: "googlecalendar", name: "Find event", description: "Search events.", tags: [], inputSchema: schema({ query: str }), important: true },
  { slug: "GOOGLECALENDAR_CREATE_EVENT", toolkit: "googlecalendar", name: "Create event", description: "Create an event.", tags: [], inputSchema: schema({ summary: str, start_datetime: str }, ["summary"]), important: true },
  { slug: "GOOGLEDOCS_GET_DOCUMENT", toolkit: "googledocs", name: "Get document", description: "Read a document.", tags: [], inputSchema: schema({ document_id: str }), important: true },
  { slug: "SLACK_SEND_MESSAGE", toolkit: "slack", name: "Send message", description: "Post to a channel.", tags: [], inputSchema: schema({ channel: str, text: str }), important: true },
  { slug: "ACME_FROBNICATE", toolkit: "acme", name: "Frobnicate", description: "Does something.", tags: [], inputSchema: schema({ level: { type: "integer" } }), important: false },
];

export interface FakeExecution { userId: string; slug: string; args: Record<string, unknown>; accountId?: string }

export class FakeComposio implements ComposioGateway {
  toolkits = structuredClone(FAKE_TOOLKITS);
  tools = structuredClone(FAKE_TOOLS);
  /** userId -> accounts */
  accounts = new Map<string, GatewayAccount[]>();
  executions: FakeExecution[] = [];
  profileLookups: FakeExecution[] = [];
  /** slug -> what execute returns (default: ok with a small payload) */
  results = new Map<string, GatewayExecution>();
  /** set to hold executions until released (double-tap tests) */
  gate: Promise<void> | null = null;
  authorizations: { userId: string; toolkit: string; callbackUrl: string }[] = [];
  disconnected: string[] = [];
  logoFetches = 0;
  searches: { userId: string; query: string; toolkits: string[] }[] = [];

  connect(userId: string, toolkit: string, id: string, label: string | null = null, status: GatewayAccount["status"] = "ACTIVE"): void {
    this.accounts.set(userId, [...(this.accounts.get(userId) ?? []), { id, toolkit, status, alias: null, label, createdAt: "2030-10-25T08:00:00.000Z" }]);
  }

  async search(userId: string, query: string, toolkits: string[] = []): Promise<GatewaySearchResult> {
    this.searches.push({ userId, query, toolkits });
    const tools = this.tools.filter((t) => !toolkits.length || toolkits.includes(t.toolkit)).slice(0, 4);
    const kits = [...new Set(tools.map((t) => t.toolkit))];
    return {
      tools: tools.map((t) => ({ slug: t.slug, toolkit: t.toolkit, description: t.description })),
      guidance: ["Use gmail search syntax for queries; googlecalendar times are RFC 3339."],
      connections: kits.map((toolkit) => ({ toolkit, connected: (this.accounts.get(userId) ?? []).some((a) => a.toolkit === toolkit && a.status === "ACTIVE") })),
    };
  }

  async getTools(slugs: string[]): Promise<GatewayTool[]> {
    return this.tools.filter((t) => slugs.includes(t.slug));
  }

  async listTools(toolkit: string): Promise<GatewayTool[]> {
    return this.tools.filter((t) => t.toolkit === toolkit);
  }

  async execute(userId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution> {
    this.executions.push({ userId, slug, args: structuredClone(args) });
    if (this.gate) await this.gate;
    return this.results.get(slug) ?? { ok: true, data: { ok: true, items: [{ id: "item_1", title: "Quarterly sync" }] } };
  }

  async executeForAccount(userId: string, accountId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution> {
    this.profileLookups.push({ userId, slug, args, accountId });
    return slug === "GMAIL_GET_PROFILE" ? { ok: true, data: { emailAddress: `${accountId}@example.com`, messagesTotal: 12 } } : { ok: false, kind: "not_found", error: "no" };
  }

  async listToolkits(): Promise<GatewayToolkit[]> {
    return this.toolkits;
  }

  async getToolkit(slug: string): Promise<GatewayToolkit | null> {
    return this.toolkits.find((t) => t.slug === slug) ?? null;
  }

  async listAccounts(userId: string): Promise<GatewayAccount[]> {
    return (this.accounts.get(userId) ?? []).filter((a) => !this.disconnected.includes(a.id));
  }

  async authorize(userId: string, toolkit: string, callbackUrl: string): Promise<{ url: string }> {
    this.authorizations.push({ userId, toolkit, callbackUrl });
    return { url: `https://connect.composio.test.invalid/link/${toolkit}` };
  }

  async disconnect(accountId: string): Promise<void> {
    this.disconnected.push(accountId);
  }

  async fetchLogo(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    this.logoFetches++;
    return url.startsWith("https://") ? { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" } : null;
  }
}
