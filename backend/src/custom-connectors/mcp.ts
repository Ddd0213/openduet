// A minimal MCP client over Streamable HTTP (M11): JSON-RPC POSTs with
// `Accept: application/json, text/event-stream`, answered as JSON or as an SSE stream (the message
// with our request id is the answer); `Mcp-Session-Id` from initialize goes on every later request.
// One session per operation: initialize -> notifications/initialized -> tools/list (paged, <= 200
// tools) or tools/call, then a best-effort DELETE. https only and public addresses only (net.ts);
// 15 s per request, 60 s for a call. The connector's headers (secret ones from the vault) go on
// every request; nothing the server sends back is trusted as instructions. The target's secrets
// are redacted from what the server sends (error texts, tool names / descriptions / schemas)
// before anything is cut, so a secret crossing a cut can't show through as a prefix.
import { NetError, readCapped, send, type NetDeps } from "./net.ts";
import { redactText, redactValue } from "./redact.ts";

export const MCP_PROTOCOL = "2025-06-18";
const REQUEST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_PAGES = 20;
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;
/** Headers the client owns; a connector header with one of these names is never sent. */
export const RESERVED_HEADERS = new Set(["accept", "content-type", "content-length", "host", "connection", "mcp-session-id", "mcp-protocol-version", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization", "proxy-connection"]);

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }
export interface McpCallResult { isError: boolean; text: string; structured: unknown }

/** A failure in plain words (never the server's raw body, which could echo a header). */
export class McpError extends Error {
  /** `status`: the HTTP status of an auth failure (401 / 403), so OAuth knows when to refresh. */
  constructor(message: string, readonly kind: "unreachable" | "auth" | "protocol" | "tool" | "timeout" = "protocol", readonly status?: number) {
    super(message);
    this.name = "McpError";
  }
}

const decoder = new TextDecoder();

interface RpcAnswer { result?: unknown; error?: { code?: number; message?: string } }

function asAnswer(value: unknown, id: number): RpcAnswer | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { id?: unknown; result?: unknown; error?: unknown };
  if (message.id !== id) return null;
  if (message.error && typeof message.error === "object") return { error: message.error as RpcAnswer["error"] };
  return { result: message.result };
}

/** M29: how long a finished SSE answer may take to end by itself (its connection is then reused). */
const DRAIN_MS = 2_000;
const DRAIN_BYTES = 64 * 1024;

/**
 * After the answer: reads what's left of the stream in the background, so a server that ends it
 * right after the answer (Notion) leaves the connection in the pool. Cancelled after DRAIN_MS or
 * DRAIN_BYTES (the connection is dropped then, as before).
 */
function drain(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }): void {
  const deadline = setTimeout(() => { void reader.cancel().catch(() => {}); }, DRAIN_MS);
  void (async () => {
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) return;
        size += part.value?.byteLength ?? 0;
        if (size > DRAIN_BYTES) { await reader.cancel(); return; }
      }
    } catch {
      // cancelled or cut: nothing to keep
    } finally {
      clearTimeout(deadline);
    }
  })();
}

/** Reads an SSE answer until the message with our id arrives (other messages are ignored). */
async function readSse(response: Response, id: number, signal: AbortSignal): Promise<RpcAnswer> {
  const reader = response.body?.getReader();
  if (!reader) throw new McpError("The server sent an empty answer.");
  const stream = new TextDecoder();
  let buffer = "";
  let size = 0;
  let answered = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new McpError("The server took too long to answer.", "timeout");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_ANSWER_BYTES) throw new McpError("The server's answer is too large.");
      buffer += stream.decode(part.value, { stream: true }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          const answer = asAnswer(message, id);
          if (answer) { answered = true; return answer; }
        }
      }
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(signal.aborted ? "The server took too long to answer." : "The connection was cut.", signal.aborted ? "timeout" : "unreachable");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (answered) drain(reader);
    else void reader.cancel().catch(() => {});
  }
  throw new McpError("The server closed the stream without answering.");
}

class Session {
  private sessionId: string | null = null;
  private protocol = MCP_PROTOCOL;
  private seq = 0;

  constructor(private readonly url: URL, private readonly headers: Record<string, string>, private readonly secrets: readonly string[], private readonly net: NetDeps, private readonly signal?: AbortSignal) {}

  private headersFor(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.headers)) if (!RESERVED_HEADERS.has(name.toLowerCase())) out[name] = value;
    out["accept"] = "application/json, text/event-stream";
    out["content-type"] = "application/json";
    out["mcp-protocol-version"] = this.protocol;
    if (this.sessionId) out["mcp-session-id"] = this.sessionId;
    return out;
  }

  private async post(body: unknown, timeoutMs: number): Promise<{ response: Response; done: () => void; signal: AbortSignal }> {
    try {
      return await send(this.url, { method: "POST", headers: this.headersFor(), body: JSON.stringify(body), timeoutMs, ...(this.signal ? { signal: this.signal } : {}) }, this.net);
    } catch (error) {
      if (error instanceof NetError) throw new McpError(error.message, error.kind === "timeout" ? "timeout" : "unreachable");
      throw error;
    }
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.seq;
    const { response, done, signal } = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    try {
      if (response.status >= 300 && response.status < 400) throw new McpError("The server redirected the request; use its final address.");
      if (response.status === 401 || response.status === 403) throw new McpError("The server refused the credentials (check the headers).", "auth", response.status);
      if (response.status === 404 && this.sessionId) throw new McpError("The server ended the session.");
      if (!response.ok) throw new McpError(`The server answered ${response.status}.`);
      const session = response.headers.get("mcp-session-id");
      if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.sessionId = session;
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      let answer: RpcAnswer | null;
      if (type.includes("text/event-stream")) answer = await readSse(response, id, signal);
      else {
        let bytes: Uint8Array;
        try {
          bytes = await readCapped(response, MAX_ANSWER_BYTES, signal);
        } catch (error) {
          if (error instanceof NetError) throw new McpError(error.kind === "too_large" ? "The server's answer is too large." : error.message, error.kind === "timeout" ? "timeout" : "unreachable");
          throw error;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(decoder.decode(bytes)); } catch { throw new McpError("The server's answer isn't JSON-RPC."); }
        answer = null;
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) answer ??= asAnswer(message, id);
        if (!answer) throw new McpError("The server's answer isn't JSON-RPC.");
      }
      if (answer.error) {
        // Redacted whole, then cut.
        const message = typeof answer.error.message === "string" ? redactText(answer.error.message, this.secrets).slice(0, 200) : "";
        throw new McpError(`The server returned an error${message ? `: ${message}` : ""}.`, "tool");
      }
      return answer.result;
    } finally {
      done();
    }
  }

  async notify(method: string): Promise<void> {
    const { response, done } = await this.post({ jsonrpc: "2.0", method }, REQUEST_TIMEOUT_MS);
    try {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new McpError("The server refused the credentials (check the headers).", "auth", response.status);
    } finally {
      done();
    }
  }

  async initialize(): Promise<{ name: string | null }> {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "OpenDuet", version: "1.0.0" },
    }) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } } | undefined;
    if (!result || typeof result !== "object") throw new McpError("The server's initialize answer is empty.");
    if (typeof result.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)) this.protocol = result.protocolVersion;
    await this.notify("notifications/initialized");
    return { name: typeof result.serverInfo?.name === "string" ? result.serverInfo.name.slice(0, 80) : null };
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as { tools?: unknown; nextCursor?: unknown } | undefined;
      const list = Array.isArray(result?.tools) ? result.tools : [];
      for (const raw of list) {
        if (tools.length >= MAX_TOOLS) break;
        const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
        if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name) || seen.has(tool.name)) continue;
        // A name carrying a secret can't be redacted (it's what gets called): the tool is skipped.
        if (redactText(tool.name, this.secrets) !== tool.name) continue;
        seen.add(tool.name);
        const given = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? tool.inputSchema as Record<string, unknown> : { type: "object" };
        // Descriptions and schemas are stored and shown to the model: redacted first, then cut.
        const schema = redactValue(given, this.secrets) as Record<string, unknown>;
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? redactText(tool.description, this.secrets).slice(0, 1000) : "",
          inputSchema: JSON.stringify(schema).length <= 20_000 ? schema : { type: "object" },
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS) as { content?: unknown; isError?: unknown; structuredContent?: unknown } | undefined;
    const parts: string[] = [];
    for (const raw of Array.isArray(result?.content) ? result.content : []) {
      const block = raw as { type?: unknown; text?: unknown; mimeType?: unknown; resource?: { uri?: unknown; text?: unknown } };
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "resource" && typeof block.resource?.text === "string") parts.push(block.resource.text);
      else if (block.type === "resource_link" || block.type === "resource") parts.push(`[resource ${typeof block.resource?.uri === "string" ? block.resource.uri : ""}]`.trim());
      else if (block.type === "image" || block.type === "audio") parts.push(`[${String(block.type)}${typeof block.mimeType === "string" ? ` ${block.mimeType}` : ""} not shown]`);
    }
    return { isError: result?.isError === true, text: parts.join("\n"), structured: result?.structuredContent ?? null };
  }

  /**
   * Best effort, in the background: tells the server the session is over (3 s cap, never fails,
   * nobody waits for it). Returns the DELETE's promise for tests; it always resolves.
   */
  close(): Promise<void> {
    // M29: a server that answered 405 doesn't end sessions this way (Notion): never asked again.
    if (!this.sessionId || NO_DELETE.has(this.url.href)) return Promise.resolve();
    return send(this.url, { method: "DELETE", headers: this.headersFor(), timeoutMs: 3_000 }, this.net)
      .then(({ response, done }) => {
        if (response.status === 405) remember(NO_DELETE, this.url.href);
        // Read to its end (small), so the connection goes back to the pool.
        if (response.body) drain(response.body.getReader());
        done();
      })
      .catch(() => { /* the session expires on the server anyway */ });
  }
}

/** M29: MCP URLs whose DELETE answered 405 (bounded; forgotten on restart). */
const NO_DELETE = new Set<string>();
function remember(set: Set<string>, key: string): void {
  if (set.size >= 500) set.clear();
  set.add(key);
}

/** `secrets`: the secret header values (redacted from everything the server sends back). */
export interface McpTarget { url: string; headers: Record<string, string>; secrets?: readonly string[] }

async function withSession<T>(target: McpTarget, net: NetDeps, run: (session: Session) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new McpError("That isn't a valid URL.");
  }
  const session = new Session(url, target.headers, target.secrets ?? [], net, signal);
  try {
    await session.initialize();
    return await run(session);
  } finally {
    void session.close();
  }
}

/**
 * M17: one unauthenticated-as-given `initialize` (no session kept, nothing else sent): its status and
 * WWW-Authenticate header, so a 401 or a protected-resource hint can mean "sign in". The body is dropped
 * unread. Throws McpError(unreachable / timeout) when the server can't be reached.
 */
export async function mcpProbe(url: URL, headers: Record<string, string>, net: NetDeps = {}): Promise<{ status: number; wwwAuthenticate: string | null }> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (!RESERVED_HEADERS.has(name.toLowerCase())) out[name] = value;
  out["accept"] = "application/json, text/event-stream";
  out["content-type"] = "application/json";
  out["mcp-protocol-version"] = MCP_PROTOCOL;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "OpenDuet", version: "1.0.0" } } });
  let sent: Awaited<ReturnType<typeof send>>;
  try {
    sent = await send(url, { method: "POST", headers: out, body, timeoutMs: REQUEST_TIMEOUT_MS }, net);
  } catch (error) {
    if (error instanceof NetError) throw new McpError(error.message, error.kind === "timeout" ? "timeout" : "unreachable");
    throw error;
  }
  const { response, done } = sent;
  try {
    // A session the server may have opened for the probe just expires there (like Codync's probe).
    void response.body?.cancel().catch(() => {});
    return { status: response.status, wwwAuthenticate: response.headers.get("www-authenticate") };
  } finally {
    done();
  }
}

const warming = new Map<string, Promise<void>>();

/**
 * M29: opens a connection to an MCP server ahead of a call the user is about to approve, so the
 * tap doesn't wait for a new TCP + TLS handshake (about 2 s to Notion through a proxy). One plain
 * `initialize` without the connector's headers or token (a spec-safe request: a 401, or a session
 * that just expires), read to its end so the connection stays in the pool. Several at once for
 * one URL share one request. Never throws; resolves when the answer has been read.
 */
export function mcpWarmUp(url: URL, net: NetDeps = {}): Promise<void> {
  const key = url.href;
  const running = warming.get(key);
  if (running) return running;
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "OpenDuet", version: "1.0.0" } } });
  const job = send(url, { method: "POST", headers, body, timeoutMs: REQUEST_TIMEOUT_MS }, net)
    .then(async ({ response, done }) => {
      try {
        await readCapped(response, DRAIN_BYTES, AbortSignal.timeout(DRAIN_MS));
      } catch {
        // too large or too slow: dropped, nothing kept
      } finally {
        done();
      }
    })
    .catch(() => { /* unreachable now: the approved call reports it */ })
    .finally(() => { warming.delete(key); });
  warming.set(key, job);
  return job;
}

/** Verify / refresh: initialize + tools/list. */
export function mcpListTools(target: McpTarget, net: NetDeps = {}): Promise<McpTool[]> {
  return withSession(target, net, (session) => session.listTools());
}

/** One tool call in its own session (60 s). */
export function mcpCallTool(target: McpTarget, name: string, args: Record<string, unknown>, net: NetDeps = {}, signal?: AbortSignal): Promise<McpCallResult> {
  return withSession(target, net, (session) => session.callTool(name, args), signal);
}
