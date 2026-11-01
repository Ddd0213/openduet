// Eval-only Composio gateway: a Gmail and a Google Calendar connected for the persona, serving the
// fixture inbox and calendar (Chinese and English). Reads filter the fixtures; writes (send, reply,
// forward, create event ...) only ever run after an approval and then only record the call: nothing
// leaves this process. Every execution is logged for the scorers.
import type { ComposioGateway, GatewayAccount, GatewayExecution, GatewaySearchResult, GatewayTool, GatewayToolkit } from "../../src/composio/gateway.ts";
import { zonedAt, zonedIso, type EventFixture, type MailFixture, type Persona } from "./fixtures.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const int = { type: "integer" };
const strs = { type: "array", items: str };

const TOOLKITS: GatewayToolkit[] = [
  { slug: "gmail", name: "Gmail", description: "Read, draft and send email.", logo: null, categories: ["Email"] },
  { slug: "googlecalendar", name: "Google Calendar", description: "Events and availability.", logo: null, categories: ["Scheduling"] },
];

const TOOLS: GatewayTool[] = [
  { slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail", name: "Fetch emails", description: "List messages in the user's mailbox, newest first. query uses Gmail search syntax (from:, subject:, newer_than:1d, is:unread).", tags: ["readOnlyHint"], inputSchema: obj({ query: str, max_results: int, label_ids: strs, include_payload: { type: "boolean" } }), important: true },
  { slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", toolkit: "gmail", name: "Fetch message by id", description: "Read one message in full by its id.", tags: ["readOnlyHint"], inputSchema: obj({ message_id: str }, ["message_id"]), important: true },
  { slug: "GMAIL_GET_PROFILE", toolkit: "gmail", name: "Get profile", description: "The account's address and message count.", tags: ["readOnlyHint"], inputSchema: obj({}), important: false },
  { slug: "GMAIL_SEND_EMAIL", toolkit: "gmail", name: "Send email", description: "Send a new email.", tags: [], inputSchema: obj({ recipient_email: str, cc: strs, subject: str, body: str, is_html: { type: "boolean" } }, ["recipient_email", "body"]), important: true },
  { slug: "GMAIL_REPLY_TO_THREAD", toolkit: "gmail", name: "Reply to thread", description: "Reply in an existing thread.", tags: [], inputSchema: obj({ thread_id: str, recipient_email: str, message_body: str }, ["thread_id", "message_body"]), important: true },
  { slug: "GMAIL_CREATE_EMAIL_DRAFT", toolkit: "gmail", name: "Create draft", description: "Save a draft without sending it.", tags: ["createHint"], inputSchema: obj({ recipient_email: str, subject: str, body: str }, ["body"]), important: true },
  { slug: "GMAIL_FORWARD_MESSAGE", toolkit: "gmail", name: "Forward message", description: "Forward a message to someone.", tags: [], inputSchema: obj({ message_id: str, recipient_email: str, additional_text: str }, ["message_id", "recipient_email"]), important: false },
  { slug: "GMAIL_DELETE_MESSAGE", toolkit: "gmail", name: "Delete message", description: "Move a message to the trash.", tags: ["destructiveHint"], inputSchema: obj({ message_id: str }, ["message_id"]), important: false },
  { slug: "GOOGLECALENDAR_EVENTS_LIST", toolkit: "googlecalendar", name: "List events", description: "Events between timeMin and timeMax (RFC 3339).", tags: ["readOnlyHint"], inputSchema: obj({ timeMin: str, timeMax: str, max_results: int }), important: true },
  { slug: "GOOGLECALENDAR_FIND_EVENT", toolkit: "googlecalendar", name: "Find event", description: "Search events by text.", tags: ["readOnlyHint"], inputSchema: obj({ query: str, timeMin: str, timeMax: str }), important: true },
  { slug: "GOOGLECALENDAR_CREATE_EVENT", toolkit: "googlecalendar", name: "Create event", description: "Create an event.", tags: [], inputSchema: obj({ summary: str, start_datetime: str, end_datetime: str, attendees: strs }, ["summary", "start_datetime"]), important: true },
  { slug: "GOOGLECALENDAR_DELETE_EVENT", toolkit: "googlecalendar", name: "Delete event", description: "Delete an event.", tags: ["destructiveHint"], inputSchema: obj({ event_id: str }, ["event_id"]), important: false },
];

const WRITE_WORDS = /send|reply|forward|draft|delete|trash|create|schedule|book|invite|move|cancel|回复|发送|转发|草稿|删除|创建|安排|预约/i;
const CALENDAR_WORDS = /calendar|event|meeting|schedule|today|tomorrow|week|free|busy|日程|日历|会议|安排|今天|明天|本周|下周/i;
const MAIL_WORDS = /mail|email|inbox|message|thread|invoice|from|reply|邮件|邮箱|收件|来信|回复|发票/i;

export interface AppCall { slug: string; args: Record<string, unknown> }

export class FakeComposio implements ComposioGateway {
  mailbox: MailFixture[] = [];
  events: EventFixture[] = [];
  readonly calls: AppCall[] = [];

  constructor(private readonly persona: Persona, private readonly timeZone: () => string, private readonly now: () => Date = () => new Date()) {}

  /** One message as GMAIL_FETCH_EMAILS returns it. */
  message(m: MailFixture) {
    const at = new Date(this.now().getTime() - m.minutesAgo * 60_000);
    return {
      messageId: m.id, threadId: `t-${m.id}`, sender: m.from, to: (m.to.length ? m.to : [this.persona.email]).join(", "), cc: m.cc.join(", "),
      subject: m.subject, messageTimestamp: zonedIso(this.timeZone(), at), labelIds: m.labels, headers: m.headers,
      preview: { body: m.body.slice(0, 200) }, messageText: m.body,
    };
  }

  private event(e: EventFixture) {
    const zone = this.timeZone();
    return {
      id: e.id, summary: e.title, location: e.location ?? null, attendees: e.attendees.map((email) => ({ email })),
      start: { dateTime: zonedIso(zone, zonedAt(zone, this.now(), e.day, e.start)), timeZone: zone },
      end: { dateTime: zonedIso(zone, zonedAt(zone, this.now(), e.day, e.end)), timeZone: zone },
    };
  }

  /** Gmail search, loosely: from: / to: / subject: and bare words must all match; OR splits; date and is: operators pass. */
  private matches(m: MailFixture, query: string): boolean {
    const text = `${m.from} ${m.to.join(" ")} ${m.cc.join(" ")} ${m.subject} ${m.body}`.toLowerCase();
    return query.split(/\s+OR\s+/).some((branch) => {
      const terms = branch.match(/(?:[a-z_]+:)?(?:"[^"]*"|\S+)/gi) ?? [];
      return terms.every((raw) => {
        const term = raw.replace(/[()]/g, "");
        const [, op, value] = /^(?:([a-z_]+):)?(.*)$/i.exec(term) ?? [];
        const v = (value ?? "").replace(/^"|"$/g, "").toLowerCase();
        if (!v) return true;
        switch (op?.toLowerCase()) {
          case undefined: return text.includes(v);
          case "from": return m.from.toLowerCase().includes(v);
          case "to": case "cc": return `${m.to.join(" ")} ${m.cc.join(" ")} ${this.persona.email}`.toLowerCase().includes(v);
          case "subject": return m.subject.toLowerCase().includes(v);
          case "label": case "category": return m.labels.some((l) => l.toLowerCase().includes(v));
          default: return true; // newer_than:, after:, is:, in: ...
        }
      });
    });
  }

  async execute(_userId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution> {
    this.calls.push({ slug, args: structuredClone(args) });
    const s = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
    switch (slug) {
      case "GMAIL_FETCH_EMAILS": {
        const max = Math.min(50, Math.max(1, typeof args.max_results === "number" ? args.max_results : 10));
        const found = this.mailbox.filter((m) => this.matches(m, s("query"))).sort((a, b) => a.minutesAgo - b.minutesAgo).slice(0, max);
        return { ok: true, data: { messages: found.map((m) => this.message(m)), resultSizeEstimate: found.length } };
      }
      case "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID": {
        const m = this.mailbox.find((x) => x.id === s("message_id") || `t-${x.id}` === s("message_id"));
        return m ? { ok: true, data: this.message(m) } : { ok: false, kind: "not_found", error: "Message not found." };
      }
      case "GMAIL_GET_PROFILE":
        return { ok: true, data: { emailAddress: this.persona.email, messagesTotal: this.mailbox.length } };
      case "GOOGLECALENDAR_EVENTS_LIST":
      case "GOOGLECALENDAR_FIND_EVENT": {
        const min = Date.parse(s("timeMin")) || -Infinity;
        const max = Date.parse(s("timeMax")) || Infinity;
        const q = s("query").toLowerCase();
        const zone = this.timeZone();
        const items = this.events.filter((e) => {
          const at = zonedAt(zone, this.now(), e.day, e.start).getTime();
          return at >= min && at <= max && (!q || e.title.toLowerCase().includes(q) || (e.location ?? "").toLowerCase().includes(q));
        });
        return { ok: true, data: { items: items.map((e) => this.event(e)) } };
      }
      default:
        if (TOOLS.some((t) => t.slug === slug)) return { ok: true, data: { id: `fake-${this.calls.length}`, status: "done" } };
        return { ok: false, kind: "not_found", error: "Unknown tool." };
    }
  }

  async search(_userId: string, query: string, toolkits: string[] = []): Promise<GatewaySearchResult> {
    const wanted = toolkits.length ? toolkits : [
      ...(MAIL_WORDS.test(query) || !CALENDAR_WORDS.test(query) ? ["gmail"] : []),
      ...(CALENDAR_WORDS.test(query) || !MAIL_WORDS.test(query) ? ["googlecalendar"] : []),
    ];
    const writes = WRITE_WORDS.test(query);
    const tools = TOOLS.filter((t) => wanted.includes(t.toolkit) && (writes || t.tags.includes("readOnlyHint")));
    return {
      tools: tools.slice(0, 10).map((t) => ({ slug: t.slug, toolkit: t.toolkit, description: t.description })),
      guidance: ["Gmail queries use Gmail search syntax; Google Calendar times are RFC 3339 with an offset."],
      connections: [...new Set(tools.map((t) => t.toolkit))].map((toolkit) => ({ toolkit, connected: true })),
    };
  }

  async getTools(slugs: string[]): Promise<GatewayTool[]> {
    return TOOLS.filter((t) => slugs.includes(t.slug));
  }

  async listTools(toolkit: string): Promise<GatewayTool[]> {
    return TOOLS.filter((t) => t.toolkit === toolkit);
  }

  async executeForAccount(userId: string, _accountId: string, slug: string, args: Record<string, unknown>): Promise<GatewayExecution> {
    return slug === "GMAIL_GET_PROFILE" ? { ok: true, data: { emailAddress: this.persona.email } } : this.execute(userId, slug, args);
  }

  async listToolkits(): Promise<GatewayToolkit[]> {
    return TOOLKITS;
  }

  async getToolkit(slug: string): Promise<GatewayToolkit | null> {
    return TOOLKITS.find((t) => t.slug === slug) ?? null;
  }

  async listAccounts(): Promise<GatewayAccount[]> {
    return TOOLKITS.map((t) => ({ id: `acct-${t.slug}`, toolkit: t.slug, status: "ACTIVE", alias: null, label: this.persona.email, createdAt: "2026-01-05T08:00:00.000Z" }));
  }

  async authorize(_userId: string, toolkit: string): Promise<{ url: string }> {
    return { url: `https://connect.composio.example/link/${toolkit}` };
  }

  async disconnect(): Promise<void> {}

  async fetchLogo(): Promise<null> {
    return null;
  }
}
