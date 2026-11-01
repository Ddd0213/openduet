// Connection cards (M11): request_connection (an MCP server with its header fields, or an app from
// the Composio catalog with a Connect button) and request_secret (an API key bound to one domain,
// one secret field "key"). The user answers on the card: POST /api/messages/:id/connect sends the
// values straight into the vault through the same create path as "Add connector" (verified first;
// a failure is 400 with the reason and the card stays open). On success the card turns connected,
// the connector is turned on in the card's channel, a system line says so, and the thread carries
// on with a server-authored turn. What the user typed never reaches a Message row, a prompt, a run
// record, the audit log or the logs. App cards turn connected once the account is active.
import type { Message as MessageRow } from "@prisma/client";
import { z } from "zod";
import type { TurnInput } from "../agent/types.ts";
import type { AccessService } from "../access/service.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import { displayName, TOOLKIT_SLUG } from "../composio/names.ts";
import { ConnectRequestSubmit, CreateCustomConnectorRequest } from "../contract/m11.ts";
import { ConnectionRequestMessage, type Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import type { Tool } from "../llm/index.ts";
import { log } from "../log.ts";
import type { RunHost } from "../runs/host.ts";
import type { Action } from "../tasks/cards.ts";
import { KeyedLock } from "../tasks/lock.ts";
import { postMessage, storedPayload, updatePayload } from "../tasks/thread.ts";
import { RESERVED_HEADERS } from "./mcp.ts";
import { checkHttpsUrl, NetError, normalizeDomain } from "./net.ts";
import type { ConnectorService } from "./service.ts";

type Card = z.infer<typeof ConnectionRequestMessage.shape.payload>;

const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a header name like Authorization or X-Api-Key");
const schemas = {
  request_connection: z.object({
    type: z.enum(["mcp", "app"]),
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(500),
    /** mcp: the server URL, if you know it (the user can fill it in) */
    url: z.string().trim().max(2000).optional(),
    /** app: the app's name or toolkit id */
    toolkit: z.string().trim().max(80).optional(),
    /**
     * mcp: the headers the server needs. Every value typed into a card goes to the vault: `secret`
     * is accepted but ignored (a model can't make the user's token a plain, readable header;
     * plain headers only come from the user's own "Add connector" form).
     */
    headers: z.array(z.object({ name: HeaderName, label: z.string().trim().min(1).max(80), secret: z.boolean().optional() }).strict()).max(10).optional(),
  }).strict(),
  request_secret: z.object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(500),
    /** the API's domain, e.g. api.example.com: the key is only ever sent there (and its subdomains) */
    domain: z.string().trim().min(1).max(253),
    headerName: HeaderName.optional(),
    valuePrefix: z.string().max(20).optional(),
    label: z.string().trim().min(1).max(80).optional(),
  }).strict(),
};
type ToolName = keyof typeof schemas;

const toolOf = (name: ToolName, description: string): Tool => ({ name, description, inputSchema: z.toJSONSchema(schemas[name], { io: "input" }) as Record<string, unknown> });

const TOOLS: Tool[] = [
  toolOf("request_connection", "Ask the user to connect a service the task needs: type mcp = an MCP server (url if you know it; headers it needs, e.g. Authorization; every header value typed into the card is stored as a secret), type app = an app from the connected-apps catalog (toolkit: its name or id). Shows a card; values the user types go straight to the server's vault, never into the chat. Stop after calling it: you'll carry on once it's connected."),
  toolOf("request_secret", "Ask the user for an API key for one domain (e.g. api.example.com): a card with one secret field. The key is stored in the server's vault and only ever sent to that domain and its subdomains, in headerName (default Authorization, with valuePrefix \"Bearer \"). Then use call_api. Stop after calling it: you'll carry on once it's connected."),
];

export type CardReply = { data: Record<string, unknown>; isError: boolean; endTurn: boolean };

export interface ConnectionCardDeps {
  db: Db;
  events: EventBus;
  service: ConnectorService;
  access: AccessService;
  catalog: ConnectorCatalog | null;
  runs: Pick<RunHost, "submit">;
  /** a task card's thread carries on through the tasks module */
  continueTask?: (taskId: string, prompt: string) => Promise<void>;
}

const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);

export class ConnectionCards {
  readonly tools = TOOLS;
  private readonly lock = new KeyedLock();

  constructor(private readonly deps: ConnectionCardDeps) {}

  handles(name: string): boolean {
    return Object.hasOwn(schemas, name);
  }

  /** The model's request_connection / request_secret: a card (nothing is connected yet). */
  async request(name: string, raw: unknown, input: TurnInput): Promise<CardReply> {
    const fail = (error: string, extra: Record<string, unknown> = {}): CardReply => ({ data: { error, ...extra }, isError: true, endTurn: false });
    if (!this.handles(name)) return fail("Tool is not available");
    const parsed = schemas[name as ToolName].safeParse(raw);
    if (!parsed.success) return fail("Invalid tool arguments", { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`) });
    let payload: Card;
    if (name === "request_secret") {
      const args = parsed.data as z.infer<typeof schemas.request_secret>;
      const domain = normalizeDomain(args.domain.replace(/^https?:\/\//i, "").split("/")[0] ?? "");
      if (!domain) return fail("Use the API's public domain name, e.g. api.example.com.");
      const headerName = args.headerName ?? "Authorization";
      if (RESERVED_HEADERS.has(headerName.toLowerCase())) return fail(`${headerName} can't carry the key.`);
      const valuePrefix = args.valuePrefix ?? (headerName.toLowerCase() === "authorization" ? "Bearer " : "");
      payload = {
        type: "api_key", name: args.name, purpose: args.purpose, url: null, domain, toolkit: null, headerName, valuePrefix,
        fields: [{ key: "key", label: (args.label ?? `${args.name} API key`).slice(0, 80), secret: true, placeholder: null }],
        state: "open", connectorId: null,
      };
    } else {
      const args = parsed.data as z.infer<typeof schemas.request_connection>;
      if (args.type === "mcp") {
        let url: string | null = null;
        if (args.url) {
          try {
            url = checkHttpsUrl(args.url).href;
          } catch (error) {
            return fail(error instanceof NetError ? error.message : "That isn't a valid URL.");
          }
        }
        const headers = args.headers ?? [];
        const names = headers.map((h) => h.name.toLowerCase());
        if (new Set(names).size !== names.length) return fail("Two headers have the same name.");
        const reserved = names.find((n) => RESERVED_HEADERS.has(n));
        if (reserved) return fail(`${reserved} is set by the server.`);
        payload = {
          type: "mcp", name: args.name, purpose: args.purpose, url, domain: null, toolkit: null, headerName: null, valuePrefix: null,
          // Always secret, whatever the model asked for (see the schema).
          fields: headers.map((h) => ({ key: h.name, label: h.label, secret: true, placeholder: null })),
          state: "open", connectorId: null,
        };
      } else {
        const catalog = this.deps.catalog;
        if (!catalog) return fail("Connected apps aren't set up on this server.");
        const wanted = args.toolkit ?? args.name;
        const toolkit = await catalog.resolveApp(wanted).catch(() => null);
        if (!toolkit) return fail(`${wanted} isn't an app the catalog knows. Use request_connection with type mcp, or request_secret, instead.`);
        const app = displayName(toolkit.slug, toolkit.name);
        const accounts = await catalog.accounts(input.userId).catch(() => []);
        if (accounts.some((a) => a.toolkit === toolkit.slug && a.status === "active")) {
          const grant = await this.deps.access.resolve(input.userId, input.channelId);
          return grant.allowsApp(toolkit.slug)
            ? { data: { status: "already_connected", app, note: `${app} is already connected; use it with the app tools.` }, isError: false, endTurn: false }
            : { data: { status: "turned_off_in_channel", app, note: `${app} is connected but turned off in this channel. The user can turn it on in the channel's settings.` }, isError: false, endTurn: false };
        }
        payload = {
          type: "app", name: app, purpose: args.purpose, url: null, domain: null, toolkit: toolkit.slug, headerName: null, valuePrefix: null,
          fields: [], state: "open", connectorId: null,
        };
      }
    }
    const card = await input.sink.upsertMessage({ role: "assistant", kind: "connection_request", text: "", payload });
    return {
      data: { status: "awaiting_user", messageId: card.id, note: "The card is in the chat. Stop here and wait: the user fills it in (never ask for the values in text), and you'll carry on once it's connected." },
      isError: false, endTurn: true,
    };
  }

  /** POST /api/messages/:id/connect: the card's values go to the vault through the create path. */
  submit(userId: string, messageId: string, body: z.output<typeof ConnectRequestSubmit>): Promise<Message> {
    return this.lock.run(messageId, async () => {
      const { db, events, service } = this.deps;
      const row = await db.message.findFirst({ where: { id: messageId, userId } });
      if (!row || row.kind !== "connection_request") throw new HttpError(404, "not_found", "Not found.");
      const raw = storedPayload(row.payload);
      const card = ConnectionRequestMessage.shape.payload.parse(raw);
      if (card.state !== "open") throw new HttpError(409, "conflict", "This card isn't open any more.");
      if (card.type === "app") throw invalid("type", "an app connects with its Connect button");
      const keys = new Set(card.fields.map((f) => f.key));
      const unknown = Object.keys(body.values).find((k) => !keys.has(k));
      if (unknown) throw invalid("values", `${unknown} isn't a field of this card`);
      const missing = card.fields.find((f) => !body.values[f.key]);
      if (missing) throw invalid(`values.${missing.key}`, "required");
      const name = (body.name ?? card.name).trim();
      const parsed = card.type === "mcp"
        ? CreateCustomConnectorRequest.safeParse({
          kind: "mcp", name, description: card.purpose,
          url: body.url ?? card.url ?? "",
          // Every value typed into a card is a secret (also for a card stored before that rule).
          headers: card.fields.map((f) => ({ name: f.key, value: body.values[f.key]!, secret: true })),
        })
        : CreateCustomConnectorRequest.safeParse({
          kind: "api_key", name, description: card.purpose,
          domain: body.domain ?? card.domain ?? "",
          headerName: card.headerName ?? "Authorization", valuePrefix: card.valuePrefix ?? "",
          key: body.values.key ?? "",
        });
      if (!parsed.success) {
        // Field names only; never a value.
        const issue = parsed.error.issues[0];
        const path = issue?.path.join(".") ?? "";
        const field = path.startsWith("headers") || path === "key" ? "values" : path || "values";
        throw invalid(field, issue?.code === "too_small" ? "required" : "not valid");
      }
      if (parsed.data.kind === "mcp" && !parsed.data.url) throw invalid("url", "required");
      const channel = await db.channel.findFirst({ where: { id: row.channelId, userId }, select: { id: true } });
      const connector = await service.create(userId, parsed.data, { channelId: channel?.id ?? null });
      const updated = await updatePayload(db, events, userId, row.id, "connection_request", {
        ...raw, name: connector.name, state: "connected", connectorId: connector.id,
        ...(connector.kind === "mcp" ? { url: connector.url } : { domain: connector.domain }),
      });
      await postMessage(db, events, {
        userId, channelId: row.channelId, taskId: row.taskId, role: "system", kind: "system", text: "",
        payload: { phrase: { key: "system.connection_added", params: { name: { type: "text", value: connector.name } } } },
      });
      await this.carryOn(row, connector.name);
      return updated;
    });
  }

  /** The thread carries on: a task card continues its task, anything else is a chat turn. */
  private async carryOn(row: MessageRow, name: string): Promise<void> {
    const prompt = `[From the server, not the user: ${JSON.stringify(name)} is connected now (the user filled in your card). Carry on with what you were doing.]`;
    try {
      if (row.taskId && this.deps.continueTask) await this.deps.continueTask(row.taskId, prompt);
      else await this.deps.runs.submit({ userId: row.userId, channelId: row.channelId, taskId: row.taskId, kind: row.taskId ? "task" : "chat", prompt });
    } catch (error) {
      log.warn("connection card follow-up not queued", { messageId: row.id, error: { name: (error as Error)?.name ?? "Error" } });
    }
  }

  /** Not now (POST /api/messages/:id/action { action: "dismiss" }); a decided card answers as it is. */
  act(row: MessageRow, action: Action): Promise<Message> {
    return this.lock.run(row.id, async () => {
      const { db, events } = this.deps;
      if (action.action !== "dismiss") throw invalid("action", `this card has no ${action.action} action`);
      const fresh = await db.message.findFirst({ where: { id: row.id, userId: row.userId } });
      const raw = storedPayload(fresh?.payload ?? row.payload);
      const card = ConnectionRequestMessage.shape.payload.parse(raw);
      if (card.state !== "open") return updatePayload(db, events, row.userId, row.id, "connection_request", raw);
      return updatePayload(db, events, row.userId, row.id, "connection_request", { ...raw, state: "dismissed" });
    });
  }

  /** The user's accounts were listed: open app cards whose toolkit is active turn connected. */
  async syncApps(userId: string, activeToolkits: ReadonlySet<string>): Promise<void> {
    if (!activeToolkits.size) return;
    const { db, events, access } = this.deps;
    const rows = await db.message.findMany({
      where: { userId, kind: "connection_request", payload: { contains: "\"state\":\"open\"" } },
      select: { id: true }, orderBy: { createdAt: "desc" }, take: 50,
    });
    for (const { id } of rows) {
      await this.lock.run(id, async () => {
        const row = await db.message.findFirst({ where: { id, userId } });
        if (!row) return;
        const raw = storedPayload(row.payload);
        const parsed = ConnectionRequestMessage.shape.payload.safeParse(raw);
        if (!parsed.success || parsed.data.state !== "open" || parsed.data.type !== "app" || !parsed.data.toolkit) return;
        const toolkit = parsed.data.toolkit;
        if (!TOOLKIT_SLUG.test(toolkit) || !activeToolkits.has(toolkit)) return;
        // Connected from this channel's card: the app is on here even if it's restricted elsewhere.
        // Turned on before the card says connected, so whoever sees the card can already use it.
        const grant = await access.resolve(userId, row.channelId);
        if (!grant.main && !grant.allowsApp(toolkit)) await access.setChannel(userId, row.channelId, { kind: "app", id: toolkit }, true);
        await updatePayload(db, events, userId, row.id, "connection_request", { ...raw, state: "connected" });
      }).catch((error: unknown) => {
        log.warn("app connection card not updated", { messageId: id, error: { name: (error as Error)?.name ?? "Error" } });
      });
    }
  }
}
