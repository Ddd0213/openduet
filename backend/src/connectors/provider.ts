// The agent's connector tools (L106): our own versions of Composio's session meta tools (search
// tools, get schemas, multi-execute, manage connections), run through our executor so ToolPolicy is
// enforced on the server for every call, including each call of a multi-execute. Composio's remote
// workbench / bash / code-execution meta tools are never offered and never run. Every app the model
// reads about is named by its display name (L168).
import { z } from "zod";
import type { ToolProvider, TurnInput } from "../agent/types.ts";
import type { StatusKey } from "../contract/common.ts";
import type { Tool, ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { GatewayError, type GatewayTool } from "../composio/gateway.ts";
import { displayName, isMetaTool, scrubSlugs, toolDisplayName, toolkitOfSlug } from "../composio/names.ts";
import { approvalKind, classify } from "../policy/classify.ts";
import type { PolicyService } from "../policy/service.ts";
import { backgroundRefusal, isBackgroundTurn } from "../agent/background.ts";
import { credentialRefusal, inspectArguments } from "../agent/outbound-credentials.ts";
import { log } from "../log.ts";
import { askNote } from "../approvals/gate.ts";
import { buildPreview } from "../approvals/preview.ts";
import type { ApprovalService } from "../approvals/service.ts";
import { checkArgs } from "./args.ts";
import type { ConnectorCatalog } from "./catalog.ts";

/** OAuth returns to the app through this URL (ASWebAuthenticationSession, docs/API.md). */
export const OAUTH_CALLBACK = "duet://oauth";
const RESULT_MAX_CHARS = 24_000;

const App = z.string().trim().min(1).max(80);
const Slug = z.string().trim().min(2).max(128).regex(/^[A-Za-z0-9_]+$/, "a tool slug from search_app_tools");
const schemas = {
  search_app_tools: z.object({ query: z.string().trim().min(1).max(500), apps: z.array(App).max(5).optional() }).strict(),
  get_app_tool_schemas: z.object({ tools: z.array(Slug).min(1).max(10) }).strict(),
  execute_app_tools: z.object({ calls: z.array(z.object({ tool: Slug, arguments: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1).max(10) }).strict(),
  manage_app_connections: z.object({ apps: z.array(App).min(1).max(5) }).strict(),
};
type Name = keyof typeof schemas;

const descriptions: Record<Name, string> = {
  search_app_tools: "Find tools in the user's apps (Gmail, Google Calendar, Slack, Notion, GitHub ...) for a task. Returns tool ids with the app's name, a description, whether it needs the user's approval, and whether the app is connected.",
  get_app_tool_schemas: "Get the exact arguments of app tools (ids from search_app_tools) before calling them.",
  execute_app_tools: "Run one or more app tools. Reads run now and return their data. Anything that sends, posts, creates, updates, moves, archives, pays, signs or deletes is not run: it becomes an approval card for the user and returns its approvalId. Never ask for approval in text; the card is the confirmation.",
  manage_app_connections: "Check whether apps are connected and, for those that aren't, show the user a card to connect them. Use the app's name, e.g. \"Google Calendar\".",
};

export const CONNECTOR_TOOLS: Tool[] = (Object.keys(schemas) as Name[]).map((name) => ({
  name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], { io: "input" }) as Record<string, unknown>,
}));

export interface ConnectorProviderDeps {
  /** null when COMPOSIO_API_KEY isn't set: no tools are offered */
  catalog: ConnectorCatalog | null;
  policy: PolicyService;
  approvals: ApprovalService;
}

/**
 * M11 apps per channel: which toolkits this turn's channel may use (src/access/). Search, schemas,
 * execute and manage connections ignore the others; the main thread allows every app. Without a
 * gate (tests, before index.ts wires it) every app is allowed.
 */
export type AppGate = (input: { userId: string; channelId: string }) => Promise<(toolkit: string) => boolean>;

export interface ConnectorProvider extends ToolProvider {
  setAppGate(gate: AppGate | null): void;
}

/** Wires the gate into the connectors provider among `providers` (false when there is none). */
export function gateApps(providers: readonly ToolProvider[], gate: AppGate | null): boolean {
  const provider = providers.find((p): p is ConnectorProvider => p.name === "connectors" && typeof (p as Partial<ConnectorProvider>).setAppGate === "function");
  provider?.setAppGate(gate);
  return !!provider;
}

const TURNED_OFF_NOTE = "These apps are turned off in this channel; don't use them here. The user can turn them on in the channel's settings.";

const reply = (call: ToolUseBlock, data: unknown, isError = false): { result: ToolResultBlock; endTurn: boolean } => ({
  result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
  endTurn: false,
});

const issues = (error: z.ZodError) => error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`);

/** Large app answers are cut so one call can't fill the context. */
function clip(data: unknown): unknown {
  const text = JSON.stringify(data ?? null) ?? "null";
  return text.length <= RESULT_MAX_CHARS ? data : { truncated: true, preview: text.slice(0, RESULT_MAX_CHARS) };
}

export function connectorProvider(deps: ConnectorProviderDeps): ConnectorProvider {
  const { catalog, policy, approvals } = deps;
  let gate: AppGate | null = null;

  /** The channel's app filter (every app without a gate). */
  const allowedIn = async (input: TurnInput): Promise<(toolkit: string) => boolean> => {
    if (!gate) return () => true;
    const allows = await gate({ userId: input.userId, channelId: input.channelId });
    return (toolkit) => allows(toolkit.toLowerCase());
  };
  const offNames = async (c: ConnectorCatalog, slugs: Iterable<string>) => Promise.all([...new Set(slugs)].map((s) => c.name(s)));

  async function search(input: TurnInput, args: z.infer<typeof schemas.search_app_tools>) {
    const c = catalog!;
    const allowed = await allowedIn(input);
    const toolkits: string[] = [], unknownApps: string[] = [], off = new Set<string>();
    for (const app of args.apps ?? []) {
      const toolkit = await c.resolveApp(app);
      if (!toolkit) unknownApps.push(app);
      else if (!allowed(toolkit.slug)) off.add(toolkit.slug);
      else toolkits.push(toolkit.slug);
    }
    // Every app asked for is turned off here: nothing to search (an empty list would search all apps).
    if (args.apps?.length && !toolkits.length && off.size) {
      return { tools: [], apps: [], guidance: [], turnedOffInChannel: await offNames(c, off), note: TURNED_OFF_NOTE, ...(unknownApps.length ? { unknownApps } : {}) };
    }
    const found = await c.gateway.search(input.userId, args.query, toolkits);
    for (const t of found.tools) if (!allowed(t.toolkit)) off.add(t.toolkit.toLowerCase());
    for (const s of found.connections) if (!allowed(s.toolkit)) off.add(s.toolkit.toLowerCase());
    const tools = found.tools.filter((t) => allowed(t.toolkit));
    const connections = found.connections.filter((s) => allowed(s.toolkit));
    const slugs = [...new Set([...tools.map((t) => t.toolkit), ...connections.map((s) => s.toolkit)].map((s) => s.toLowerCase()))];
    const names = await c.names(slugs);
    const modes = await policy.modes(input.userId, tools.map((t) => ({ slug: t.slug, toolkit: t.toolkit.toLowerCase() })));
    return {
      tools: tools.slice(0, 20).map((t) => ({
        tool: t.slug,
        app: names.get(t.toolkit.toLowerCase()) ?? displayName(t.toolkit),
        description: scrubSlugs(t.description, names).slice(0, 400),
        needsApproval: modes.get(t.slug) !== "always",
      })),
      apps: connections.map((s) => ({ app: names.get(s.toolkit.toLowerCase()) ?? displayName(s.toolkit), connected: s.connected })),
      guidance: found.guidance.map((g) => scrubSlugs(g, names).slice(0, 500)),
      ...(unknownApps.length ? { unknownApps } : {}),
      ...(off.size ? { turnedOffInChannel: await offNames(c, off), note: TURNED_OFF_NOTE } : {}),
    };
  }

  async function toolSchemas(input: TurnInput, args: z.infer<typeof schemas.get_app_tool_schemas>) {
    const c = catalog!;
    const allowed = await allowedIn(input);
    const wanted = [...new Set(args.tools.map((t) => t.toUpperCase()))];
    const all = await c.gateway.getTools(wanted.filter((t) => !isMetaTool(t)));
    const tools = all.filter((t) => allowed(t.toolkit));
    const off = all.filter((t) => !allowed(t.toolkit));
    const names = await c.names(tools.map((t) => t.toolkit));
    const modes = await policy.modes(input.userId, tools.map(facts));
    const known = new Set(all.map((t) => t.slug.toUpperCase()));
    return {
      tools: tools.map((t) => ({
        tool: t.slug, app: names.get(t.toolkit) ?? displayName(t.toolkit), name: toolDisplayName(t.slug, t.name, t.toolkit),
        description: scrubSlugs(t.description, names).slice(0, 1000), needsApproval: modes.get(t.slug) !== "always", arguments: t.inputSchema,
      })),
      notFound: wanted.filter((t) => !known.has(t)),
      ...(off.length ? { turnedOffInChannel: await offNames(c, off.map((t) => t.toolkit.toLowerCase())), note: TURNED_OFF_NOTE } : {}),
    };
  }

  /**
   * The multi-execute: every nested call is resolved to its tool and checked against ToolPolicy on
   * its own. "always" runs now; "ask" (writes, and anything we can't classify) goes through
   * approvals.ask() (a card, or no second card for the same call; run now when an Always rule for
   * its recipients covers it); meta tools (workbench, bash, nested multi-execute ...) and unknown
   * tools are refused. M20: in a background turn only reads that run without asking run.
   */
  async function executeCalls(input: TurnInput, args: z.infer<typeof schemas.execute_app_tools>) {
    const c = catalog!;
    const calls = args.calls.map((call) => ({ slug: call.tool.toUpperCase(), args: call.arguments }));
    const definitions = await c.gateway.getTools([...new Set(calls.map((call) => call.slug).filter((s) => !isMetaTool(s)))]);
    const bySlug = new Map(definitions.map((t) => [t.slug.toUpperCase(), t]));
    let toolkitSlugs: string[] = [];
    try { toolkitSlugs = (await c.toolkits()).map((t) => t.slug); } catch { /* resolve by tool metadata only */ }
    const resolved = calls.map((call) => {
      const tool = bySlug.get(call.slug);
      return { ...call, tool, toolkit: tool?.toolkit || toolkitOfSlug(call.slug, toolkitSlugs) };
    });
    const names = await c.names(resolved.flatMap((r) => (r.toolkit ? [r.toolkit] : [])));
    const modes = await policy.modes(input.userId, resolved.flatMap((r) => (r.tool ? [{ ...facts(r.tool), toolkit: r.toolkit }] : [])));
    const allowed = await allowedIn(input);
    const results: Record<string, unknown>[] = [];
    for (const [index, call] of resolved.entries()) {
      const app = call.toolkit ? names.get(call.toolkit) ?? displayName(call.toolkit) : "App";
      if (isMetaTool(call.slug)) { results.push({ index, status: "refused", error: "This tool is not available here." }); continue; }
      if (!call.tool) { results.push({ index, status: "error", error: "Unknown tool. Find tools with search_app_tools." }); continue; }
      if (call.toolkit && !allowed(call.toolkit)) { results.push({ index, app, status: "refused", error: `${app} is turned off in this channel. The user can turn it on in the channel's settings.` }); continue; }
      const toolName = toolDisplayName(call.tool.slug, call.tool.name, call.toolkit);
      const tool = { ...facts(call.tool), toolkit: call.toolkit || null };
      const always = modes.get(call.tool.slug) === "always";
      // M20: a background turn (brief, check-in, scan) only reads: anything else is refused here,
      // with no card (nobody is there to approve it) and nothing run.
      if (isBackgroundTurn(input) && !(always && classify(tool) === "read")) { results.push({ index, app, ...backgroundRefusal(call.tool.slug), tool: toolName }); continue; }
      const problems = checkArgs(call.tool.inputSchema, call.args);
      if (problems.length) { results.push({ index, app, tool: toolName, status: "invalid_arguments", issues: problems }); continue; }
      const runNow = async () => {
        const outcome = await c.gateway.execute(input.userId, tool.slug, call.args);
        results.push(outcome.ok
          ? { index, app, tool: toolName, status: "ok", data: clip(outcome.data) }
          : { index, app, tool: toolName, status: "error", error: scrubSlugs(outcome.error, names) || `${app} returned an error.` });
      };
      if (always) { await runNow(); continue; }
      // M20: a call carrying a credential is refused before it can become a card (the gateway's
      // guardOutbound refuses it again at execution, which is what covers "always" calls).
      const inspection = inspectArguments(call.args);
      if (!inspection.safe) {
        log.warn("connector call refused: credential in arguments", { via: "ask", tool: call.tool.slug, reason: inspection.reason, findings: inspection.findings });
        results.push({ index, app, tool: toolName, ...credentialRefusal(inspection) });
        continue;
      }
      const { kind, preview } = buildPreview({ kind: approvalKind(tool), app, toolName, args: call.args });
      // M20: one place decides (approvals/gate.ts): an Always rule for these recipients runs it now;
      // the same call waiting or just declined posts no second card.
      const outcome = await approvals.ask({
        userId: input.userId, channelId: input.channelId, taskId: input.taskId, sink: input.sink,
        slug: call.tool.slug, args: call.args, kind, preview, toolkit: tool.toolkit, tags: call.tool.tags,
      });
      if (outcome.status === "allowed") { await runNow(); continue; }
      results.push({ index, app, tool: toolName, ...askNote(outcome) });
    }
    const waiting = results.some((r) => r.status === "awaiting_approval" || r.status === "already_waiting");
    return {
      results,
      ...(waiting ? { note: "Calls awaiting approval have NOT run. The user approves or declines on the card; don't ask again in text. To change one, use update_approval with its approvalId." } : {}),
    };
  }

  async function connections(input: TurnInput, args: z.infer<typeof schemas.manage_app_connections>) {
    const c = catalog!;
    const accounts = await c.accounts(input.userId);
    const allowed = await allowedIn(input);
    const out: Record<string, unknown>[] = [];
    for (const requested of args.apps) {
      const toolkit = await c.resolveApp(requested);
      if (!toolkit) { out.push({ app: requested, status: "unknown_app" }); continue; }
      const app = displayName(toolkit.slug, toolkit.name);
      if (!allowed(toolkit.slug)) { out.push({ app, status: "turned_off_in_channel", note: TURNED_OFF_NOTE }); continue; }
      const mine = accounts.filter((a) => a.toolkit === toolkit.slug);
      const active = mine.filter((a) => a.status === "active");
      if (active.length) { out.push({ app, status: "connected", accounts: active.map((a) => a.label) }); continue; }
      const { url } = await c.gateway.authorize(input.userId, toolkit.slug, OAUTH_CALLBACK);
      await input.sink.upsertMessage({
        role: "assistant", kind: "alert",
        payload: {
          title: { key: "alert.one_thing" },
          body: { key: "connectors.connect_body", params: { app: { type: "text", value: app } } },
          action: { label: { key: "connectors.connect_action", params: { app: { type: "text", value: app } } }, type: "open_connector", url, toolkit: toolkit.slug },
        },
      });
      c.invalidateAccounts(input.userId);
      out.push({ app, status: mine.length ? "reconnect_card_shown" : "connect_card_shown" });
    }
    return { apps: out };
  }

  async function instructions(input: TurnInput): Promise<string[]> {
    if (!catalog) return ["Connected apps (Gmail, Calendar, Slack ...) aren't set up on this server yet, so there are no app tools. If the user asks for something in their apps, say so honestly."];
    let accounts;
    try {
      accounts = await catalog.accounts(input.userId);
    } catch {
      return ["The user's connected apps couldn't be reached right now; app tools may fail. Say so if they do."];
    }
    const allowed = await allowedIn(input);
    const byApp = new Map<string, string[]>();
    const off = new Set<string>();
    for (const account of accounts) {
      const app = await catalog.name(account.toolkit);
      if (!allowed(account.toolkit)) { off.add(app); continue; }
      byApp.set(app, [...(byApp.get(app) ?? []), account.status === "active" ? account.label : `${account.label} (needs reconnecting)`]);
    }
    const list = [...byApp].map(([app, labels]) => `${app} (${labels.join(", ")})`).join("; ");
    return [
      `Connected apps: ${list || "none yet"}. Always call apps by these names, never by internal ids.`,
      ...(off.size ? [`Turned off in this channel (don't use them here; the user can turn them on in the channel's settings): ${[...off].join(", ")}.`] : []),
      "To use an app: search_app_tools, then get_app_tool_schemas for exact arguments, then execute_app_tools. Reads run right away; anything that sends, posts, creates, updates, moves, archives, pays, signs or deletes becomes an approval card the user taps (never ask for approval in text). If an app isn't connected, call manage_app_connections.",
    ];
  }

  return {
    setAppGate(next) {
      gate = next;
    },
    name: "connectors",
    tools: async () => (catalog ? CONNECTOR_TOOLS : []),
    instructions,
    status: (call) => statusFor(call),
    async execute(call, input) {
      if (!catalog || !Object.hasOwn(schemas, call.name)) return reply(call, { error: "Tool is not available" }, true);
      const name = call.name as Name;
      const parsed = schemas[name].safeParse(call.input);
      if (!parsed.success) return reply(call, { error: "Invalid tool arguments", issues: issues(parsed.error) }, true);
      try {
        switch (name) {
          case "search_app_tools": return reply(call, await search(input, schemas.search_app_tools.parse(call.input)));
          case "get_app_tool_schemas": return reply(call, await toolSchemas(input, schemas.get_app_tool_schemas.parse(call.input)));
          case "execute_app_tools": return reply(call, await executeCalls(input, schemas.execute_app_tools.parse(call.input)));
          case "manage_app_connections": return reply(call, await connections(input, schemas.manage_app_connections.parse(call.input)));
        }
      } catch (error) {
        if (error instanceof GatewayError) return reply(call, { error: "The connected apps service couldn't be reached. Try again in a moment." }, true);
        throw error;
      }
    },
  };
}

const MAIL = /^(GMAIL|OUTLOOK)_/;
/** Google Calendar / Calendly, and Outlook's calendar tools. */
const CALENDAR = /^(GOOGLECALENDAR|CALENDLY)_|^OUTLOOK_.*(CALENDAR|_EVENTS?(_|$))/;
const FILES = /^(GOOGLEDRIVE|GOOGLEDOCS|GOOGLESHEETS|GOOGLESLIDES|DROPBOX|ONE_?DRIVE|BOX|NOTION)_/;

/** The status pill (L106): by the target app of the (first) call, never a slug. */
function statusFor(call: ToolUseBlock): StatusKey {
  if (call.name === "search_app_tools" || call.name === "get_app_tool_schemas") return "looking_up";
  if (call.name !== "execute_app_tools") return "checking";
  const calls = (call.input as { calls?: unknown }).calls;
  const first = Array.isArray(calls) ? (calls[0] as { tool?: unknown } | undefined)?.tool : undefined;
  const slug = typeof first === "string" ? first.toUpperCase() : "";
  if (CALENDAR.test(slug)) return "checking_calendar";
  if (MAIL.test(slug)) return classify({ slug, toolkit: null }) === "read" ? "searching_email" : "writing_draft";
  if (FILES.test(slug)) return "checking_files";
  return "checking";
}

const facts = (t: GatewayTool) => ({ slug: t.slug, toolkit: t.toolkit || null, tags: t.tags });
