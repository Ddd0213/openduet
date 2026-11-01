// Test-only harness for the M11-B tests (channels, access, skills folders, custom connectors):
// the real agent runtime + run host + tasks + connectors (FakeComposio) + skills + the channel
// system (vault, access, custom connectors, connection cards, apps per channel), wired like the
// M11-B block of index.ts on a role-scripted model. The network is a fake: `FakeNet` answers by
// hostname and resolves names through an injectable lookup; `FakeMcp` is an in-process MCP server.
import { randomBytes } from "node:crypto";
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { registerAccountRoutes } from "../../src/account/routes.ts";
import { createChannelSystem, type ChannelSystem } from "../../src/channels/index.ts";
import type { WorkspaceExecResult } from "../../src/computer/workspace.ts";
import { createConnectorsModule, type ConnectorsModule } from "../../src/connectors/module.ts";
import type { Message } from "../../src/contract/messages.ts";
import type { Lookup } from "../../src/custom-connectors/net.ts";
import type { Db } from "../../src/db.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createSkills, type Skills } from "../../src/skills/index.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { FakeWorkspace } from "../make/harness.ts";
import { json, RoleScriptedLlm } from "../tasks/harness.ts";

export { call, json, messagesOf, text } from "../tasks/harness.ts";

export const PUBLIC_IP = "93.184.216.34";

export interface SeenRequest { url: string; method: string; headers: Record<string, string>; body: string | null }
export type NetHandler = (request: SeenRequest, init: RequestInit) => Response | Promise<Response>;

/** Fake fetch by hostname + a DNS map (default: one public address); records every request. */
export class FakeNet {
  readonly requests: SeenRequest[] = [];
  readonly lookups: string[] = [];
  readonly hosts = new Map<string, NetHandler>();
  /** hostname -> addresses (default PUBLIC_IP) */
  readonly dns = new Map<string, string[]>();

  route(host: string, handler: NetHandler): void {
    this.hosts.set(host, handler);
  }

  readonly lookup: Lookup = async (hostname) => {
    this.lookups.push(hostname);
    const addresses = this.dns.get(hostname) ?? [PUBLIC_IP];
    if (!addresses.length) throw new Error("ENOTFOUND");
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  readonly fetch = async (input: URL, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : null;
    const seen: SeenRequest = { url: input.href, method: init.method ?? "GET", headers, body };
    this.requests.push(seen);
    const handler = this.hosts.get(input.hostname);
    if (!handler) throw new TypeError("fetch failed (no fake host)");
    return handler(seen, init);
  };

  to(host: string): SeenRequest[] {
    return this.requests.filter((r) => new URL(r.url).hostname === host);
  }
}

export interface FakeTool { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }
export interface McpCall { name: string; arguments: Record<string, unknown>; headers: Record<string, string> }

/** An in-process MCP server over Streamable HTTP (JSON or SSE answers, Mcp-Session-Id, paging). */
export class FakeMcp {
  tools: FakeTool[] = [];
  readonly calls: McpCall[] = [];
  readonly methods: string[] = [];
  readonly seen: SeenRequest[] = [];
  /** answer as text/event-stream (with an unrelated message first) */
  sse = false;
  /** tools per tools/list page (0 = all on one page) */
  pageSize = 0;
  /** header -> value the server requires (401 otherwise) */
  required: Record<string, string> = {};
  /** tools/call answer; default: a text block naming the tool */
  answer: (call: McpCall) => Record<string, unknown> = (call) => ({ content: [{ type: "text", text: `${call.name} done` }] });
  sessions = 0;
  closed = 0;

  readonly handler: NetHandler = async (request) => {
    this.seen.push(request);
    for (const [name, value] of Object.entries(this.required)) {
      if (request.headers[name.toLowerCase()] !== value) return new Response("{\"error\":\"unauthorized\"}", { status: 401 });
    }
    if (request.method === "DELETE") { this.closed++; return new Response(null, { status: 204 }); }
    const message = JSON.parse(request.body ?? "{}") as { id?: number; method: string; params?: Record<string, unknown> };
    this.methods.push(message.method);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method !== "initialize" && !request.headers["mcp-session-id"]) return new Response("missing session", { status: 400 });
    let result: unknown;
    const headers: Record<string, string> = {};
    if (message.method === "initialize") {
      headers["mcp-session-id"] = `sess-${++this.sessions}`;
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1" } };
    } else if (message.method === "tools/list") {
      const start = Number((message.params?.cursor as string | undefined) ?? 0);
      const size = this.pageSize || this.tools.length || 1;
      const page = this.tools.slice(start, start + size);
      result = { tools: page.map((t) => ({ inputSchema: { type: "object", properties: {} }, ...t })), ...(start + size < this.tools.length ? { nextCursor: String(start + size) } : {}) };
    } else if (message.method === "tools/call") {
      const call = { name: String(message.params?.name), arguments: (message.params?.arguments ?? {}) as Record<string, unknown>, headers: request.headers };
      this.calls.push(call);
      result = this.answer(call);
    } else {
      return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }, { headers });
    }
    const answer = { jsonrpc: "2.0", id: message.id, result };
    if (this.sse) {
      const stream = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`;
      return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } });
    }
    return Response.json(answer, { headers });
  };
}

/** FakeWorkspace that also keeps the commands it was asked to run. */
export class RecordingWorkspace extends FakeWorkspace {
  readonly commands: { userId: string; command: string; cwd: string | undefined; timeoutMs: number | undefined }[] = [];
  result: WorkspaceExecResult = { exitCode: 0, stdout: "ok\n", stderr: "" };

  override async exec(userId: string, command: string, opts: { cwd?: string; timeoutMs?: number; runId?: string } = {}): Promise<WorkspaceExecResult> {
    await super.exec(userId, command, opts);
    this.commands.push({ userId, command, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    return this.result;
  }
}
export interface ChannelApp {
  fixture: TestApp;
  llm: RoleScriptedLlm;
  fake: FakeComposio;
  net: FakeNet;
  workspace: RecordingWorkspace;
  runs: RunHost;
  tasks: Tasks;
  connectors: ConnectorsModule;
  skills: Skills;
  system: ChannelSystem;
  alex: SignedIn;
  sam: SignedIn;
  cleanup(): Promise<void>;
}

/** Everything wired like index.ts (M11-B block), on fakes. */
export async function startChannels(opts: { workspace?: boolean } = {}): Promise<ChannelApp> {
  const llm = new RoleScriptedLlm();
  const fake = new FakeComposio();
  const net = new FakeNet();
  const workspace = new RecordingWorkspace(opts.workspace ?? true);
  let built: Pick<ChannelApp, "runs" | "tasks" | "connectors" | "skills" | "system"> | undefined;
  const fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: async (core) => {
      const providers: ToolProvider[] = [];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent });
      const tasks = createTasks({ db: core.db, events: core.events, runs });
      const connectors = createConnectorsModule({ db: core.db, events: core.events, config: core.config, gateway: fake, resumer: tasks.service });
      const skills = createSkills({ db: core.db, events: core.events, cards: tasks.cards, net });
      const system = createChannelSystem({
        db: core.db, events: core.events, runs, connectors, cards: tasks.cards, skills, workspace, vault: { key: randomBytes(32) }, net,
        continueTask: (taskId, prompt) => tasks.service.continueTask(taskId, prompt),
      });
      await system.start();
      providers.push(...connectors.providers, ...tasks.providers, ...skills.providers, ...system.providers);
      built = { runs, tasks, connectors, skills, system };
      return { agent, runs, routes: [registerAccountRoutes(), ...connectors.routes, ...tasks.routes, ...skills.routes, ...system.routes] };
    },
  });
  const alex = await signUp(fixture, "alex");
  const sam = await signUp(fixture, "sam", "Sam Lee");
  return {
    fixture, llm, fake, net, workspace, alex, sam, ...built!,
    cleanup: async () => { built!.connectors.stop(); await built!.system.connectors.settled(); await fixture.cleanup(); },
  };
}

export const api = (m: ChannelApp, path: string, init: RequestInit = {}) => Promise.resolve(m.fixture.app.request(path, init));
export const get = (m: ChannelApp, user: SignedIn, path: string) => api(m, path, { headers: user.headers });

let clientSeq = 0;
/** A chat message in a channel, read until the turn's `done`. */
export async function chatIn(m: ChannelApp, user: SignedIn, channelId: string, body: string, extra: Record<string, unknown> = {}): Promise<SseFrames> {
  const response = await api(m, `/api/channels/${channelId}/messages`, json(user, "POST", { text: body, clientId: `m11b-${++clientSeq}`, ...extra }));
  if (response.status !== 200) throw new Error(`send failed: ${response.status} ${await response.text()}`);
  return readSse(response, { timeoutMs: 10_000 });
}

/** A new channel (no greeting unless asked). */
export async function newChannel(m: ChannelApp, user: SignedIn, body: Record<string, unknown> = {}): Promise<{ id: string; status: number; json: unknown }> {
  const response = await api(m, "/api/channels", json(user, "POST", { name: "Launch", icon: "chart", colorHex: "#6290C2", greet: false, ...body }));
  const data = await response.json() as { id: string };
  return { id: data.id, status: response.status, json: data };
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, what: string, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** The tool results the model got back in a request, parsed. */
export function resultsIn(request: LlmRequest | undefined): Record<string, unknown>[] {
  const last = request?.messages.at(-1);
  return (last?.content ?? []).flatMap((block) => (block.type === "tool_result" && block.content[0]?.type === "text" ? [JSON.parse(block.content[0].text) as Record<string, unknown>] : []));
}

export const toolNames = (request: LlmRequest | undefined) => (request?.tools ?? []).map((t) => t.name);

export async function thread(m: ChannelApp, user: SignedIn, channelId: string): Promise<Message[]> {
  const response = await get(m, user, `/api/channels/${channelId}/messages?limit=100`);
  return ((await response.json()) as { messages: Message[] }).messages;
}

/** Every row of every table as text (bytes as latin1), for secret-leak scans. */
export async function dumpDatabase(db: Db): Promise<string> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'");
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${name.replace(/"/g, "\"\"")}"`);
    parts.push(`${name}: ${JSON.stringify(rows, (_k, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return Buffer.from(v).toString("latin1");
      if (v && typeof v === "object" && (v as { type?: unknown }).type === "Buffer" && Array.isArray((v as { data?: unknown }).data)) return Buffer.from((v as { data: number[] }).data).toString("latin1");
      return v;
    })}`);
  }
  return parts.join("\n");
}

/** Captures what the process writes to stdout / stderr (the JSON logs) until stop(). */
export function captureOutput() {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown) => { chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8")); return true; };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    stop: () => { process.stdout.write = out; process.stderr.write = err; },
  };
}
