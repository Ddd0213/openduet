// Thin HTTP client for OpenDuet's computer (OpenBot agent-computer, pinned commit da9a3ca), in the
// spirit of OpenDots' computer-service.ts. The token travels only in the x-openbot-computer-token
// header (and in the internal /stream URL built here); it never leaves the backend process and is
// never logged. Request bodies (typed text, file contents, commands, logins) are never logged either.
// The schemas are tolerant (passthrough): a newer computer adds fields without breaking us.
import { z } from "zod";

export interface ComputerClientOptions {
  baseUrl: string;
  token: string;
  botId: string;
  fetch?: typeof fetch;
  /** default per-request timeout (navigation and exec pass their own) */
  timeoutMs?: number;
}

/**
 * What went wrong, in terms the tools can act on. `detail` is the computer's own short message
 * (for the model only; never logged, it can quote page text).
 */
export type ComputerFailure =
  | "unreachable" | "timeout" | "unauthorized" | "human_in_control" | "snapshot_required"
  | "stale_ref" | "conflict" | "bad_request" | "forbidden" | "not_found" | "too_large" | "failed";

export class ComputerError extends Error {
  constructor(
    readonly kind: ComputerFailure,
    readonly status: number | null,
    readonly detail: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    // The message is the kind only, so a stray log line can't carry page text.
    super(`computer: ${kind}`);
    this.name = "ComputerError";
  }
}

const Challenge = z.object({
  kind: z.enum(["cloudflare", "visible-challenge"]),
  reason: z.string().optional(),
  requestId: z.string().optional(),
}).passthrough();
export type Challenge = z.infer<typeof Challenge>;

export const ControlState = z.object({
  holder: z.enum(["bot", "human"]),
  requested: z.boolean().optional(),
  request: z.object({ id: z.string(), status: z.string(), source: z.string().optional() }).passthrough().optional(),
  transitioning: z.boolean().optional(),
  resumeSnapshotRequired: z.boolean().optional(),
  /**
   * da9a3ca: true only after a restart or stop interrupted a page a person was driving (a request
   * nobody took no longer sets it). The computer refuses the assistant's actions until someone takes the
   * browser and hands it back.
   */
  recoveryRequired: z.boolean().optional(),
}).passthrough();
export type ControlState = z.infer<typeof ControlState>;

const Page = z.object({
  url: z.string(),
  title: z.string().optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  challenge: Challenge.nullish(),
}).passthrough();
export type PageResult = z.infer<typeof Page>;

const Snapshot = z.object({
  snapshotId: z.number().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  elements: z.array(z.object({ ref: z.string(), role: z.string(), name: z.string() }).passthrough()).optional(),
  truncated: z.boolean().optional(),
  challenge: Challenge.nullish(),
}).passthrough();
export type SnapshotResult = z.infer<typeof Snapshot>;

const Action = z.object({ url: z.string().optional() }).passthrough();
export type ActionResult = z.infer<typeof Action>;

const Screenshot = z.object({ base64: z.string(), width: z.number().optional(), height: z.number().optional(), url: z.string().optional() }).passthrough();
const FileList = z.object({
  path: z.string().optional(),
  entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "folder"]), bytes: z.number().optional() })),
  truncated: z.boolean().optional(),
});
const FileRead = z.object({ path: z.string().optional(), text: z.string(), truncated: z.boolean().optional(), bytes: z.number().optional() });
const FileWrite = z.object({ path: z.string().optional(), bytes: z.number().optional() }).passthrough();
const Exec = z.object({
  exitCode: z.number().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  truncated: z.boolean().optional(),
  timedOut: z.boolean().optional(),
}).passthrough();
export type ExecResult = { exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };
const Health = z.object({ status: z.literal("ok"), browser: z.boolean().optional() }).passthrough();
/** /sign-in/fill (da9a3ca sign-in.ts): `error` is one of the module's own sentences, never a value. */
const SignInFill = z.object({
  submitted: z.boolean(),
  passwordFieldVisible: z.boolean().optional(),
  codeRequested: z.boolean().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
}).passthrough();
export type SignInFillResult = z.infer<typeof SignInFill>;
const SignInCode = z.object({
  submitted: z.boolean(),
  codeFieldVisible: z.boolean().optional(),
  passwordFieldVisible: z.boolean().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
}).passthrough();
export type SignInCodeResult = z.infer<typeof SignInCode>;
const Stopped = z.object({ stopped: z.boolean().optional(), wasRunning: z.boolean().optional() }).passthrough();
/** M27 browser (patch 0006): the tab state; entries are checked one by one in browser-bar.ts. */
const Tabs = z.object({ tabs: z.array(z.unknown()) }).passthrough();
export type TabsResult = z.infer<typeof Tabs>;
export type TabActionBody =
  | { action: "new"; url?: string }
  | { action: "activate"; tabId: string }
  | { action: "close"; tabId: string; replaceWith?: string };
/** The computer waits up to 15 s for a page to commit, plus a new tab's start. */
const TAB_ACTION_TIMEOUT_MS = 25_000;

const DEFAULT_TIMEOUT_MS = 30_000;
/** sign-in.ts waits up to 15 s per step (two steps, a submit, a settle): the reference server allows 75 s */
const SIGN_IN_TIMEOUT_MS = 75_000;
export const NAVIGATE_TIMEOUT_MS = 60_000;
/** the computer's own shell limits (request-validation.ts) */
export const EXEC_MIN_TIMEOUT_MS = 1_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
const DETAIL_MAX = 500;

export class ComputerClient {
  private readonly doFetch: typeof fetch;
  private readonly base: URL;

  constructor(private readonly options: ComputerClientOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.base = new URL(options.baseUrl);
  }

  get baseUrl(): string {
    return this.base.toString();
  }

  /** ws(s)://.../stream?bot=..&token=..: the computer reads the token from the query on the upgrade only. Internal use only. */
  streamUrl(): string {
    const url = new URL("/stream", this.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("bot", this.options.botId);
    url.searchParams.set("token", this.options.token);
    return url.toString();
  }

  private async request<S extends z.ZodTypeAny>(
    method: "GET" | "POST", path: string, schema: S,
    opts: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<z.output<S>> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let response: Response;
    try {
      response = await this.doFetch(new URL(path, this.base), {
        method,
        headers: {
          "x-openbot-computer-token": this.options.token,
          "x-openbot-bot-id": this.options.botId,
          accept: "application/json",
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : "";
      throw new ComputerError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable", null, "");
    }
    const raw: unknown = await response.json().catch(() => null);
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!response.ok) throw failure(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ComputerError("failed", response.status, "The computer sent an unexpected answer.", null);
    return parsed.data;
  }

  /** GET /health (the only route without the token). */
  async health(signal?: AbortSignal): Promise<{ browser: boolean }> {
    const body = await this.request("GET", "/health", Health, { timeoutMs: 5_000, signal });
    return { browser: body.browser ?? false };
  }

  navigate(url: string, toolCallId?: string, signal?: AbortSignal): Promise<PageResult> {
    return this.request("POST", "/navigate", Page, { body: { url, ...(toolCallId ? { toolCallId } : {}) }, timeoutMs: NAVIGATE_TIMEOUT_MS, signal });
  }

  read(signal?: AbortSignal): Promise<PageResult> {
    return this.request("GET", "/read", Page, { signal });
  }

  snapshot(signal?: AbortSignal): Promise<SnapshotResult> {
    return this.request("POST", "/snapshot", Snapshot, { signal });
  }

  click(ref: string, snapshotId: number | undefined, signal?: AbortSignal): Promise<ActionResult> {
    return this.request("POST", "/click", Action, { body: { ref, ...(snapshotId === undefined ? {} : { snapshotId }) }, signal });
  }

  /** The text is sent once and never returned, logged or audited. */
  type(ref: string, text: string, opts: { submit?: boolean; snapshotId?: number }, signal?: AbortSignal): Promise<ActionResult> {
    return this.request("POST", "/type", Action, {
      body: { ref, text, submit: opts.submit === true, ...(opts.snapshotId === undefined ? {} : { snapshotId: opts.snapshotId }) }, signal,
    });
  }

  key(key: string, ref: string | undefined, snapshotId: number | undefined, signal?: AbortSignal): Promise<ActionResult> {
    return this.request("POST", "/key", Action, { body: { key, ...(ref ? { ref } : {}), ...(snapshotId === undefined ? {} : { snapshotId }) }, signal });
  }

  scroll(deltaY: number | undefined, signal?: AbortSignal): Promise<ActionResult> {
    return this.request("POST", "/scroll", Action, { body: deltaY === undefined ? {} : { deltaY }, signal });
  }

  async screenshot(signal?: AbortSignal): Promise<{ png: Uint8Array; width: number; height: number; url: string | null }> {
    const body = await this.request("GET", "/screenshot", Screenshot, { signal });
    return { png: new Uint8Array(Buffer.from(body.base64, "base64")), width: body.width ?? 0, height: body.height ?? 0, url: body.url ?? null };
  }

  listFiles(path: string | undefined, signal?: AbortSignal): Promise<z.output<typeof FileList>> {
    return this.request("POST", "/files/list", FileList, { body: path === undefined ? {} : { path }, signal });
  }

  /** UTF-8 text, at most the computer's read limit (64 KB); `truncated` says when there is more. */
  readText(path: string, signal?: AbortSignal): Promise<z.output<typeof FileRead>> {
    return this.request("POST", "/files/read", FileRead, { body: { path }, signal });
  }

  /** UTF-8 text, at most the computer's write limit (1 MB); creates parent folders. */
  writeText(path: string, contents: string, opts: { append?: boolean } = {}, signal?: AbortSignal): Promise<z.output<typeof FileWrite>> {
    return this.request("POST", "/files/write", FileWrite, { body: { path, contents, append: opts.append === true }, signal });
  }

  async exec(command: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs === undefined ? undefined : Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(EXEC_MIN_TIMEOUT_MS, Math.round(opts.timeoutMs)));
    const body = await this.request("POST", "/exec", Exec, {
      body: { command, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      timeoutMs: (timeoutMs ?? 120_000) + 15_000,
      signal: opts.signal,
    });
    return { exitCode: body.exitCode ?? -1, stdout: body.stdout ?? "", stderr: body.stderr ?? "", truncated: body.truncated ?? false, timedOut: body.timedOut ?? false };
  }

  control(signal?: AbortSignal): Promise<ControlState> {
    return this.request("GET", "/control", ControlState, { signal });
  }

  requestControl(reason: string, signal?: AbortSignal): Promise<ControlState> {
    return this.request("POST", "/control/request", ControlState, { body: { reason }, signal });
  }

  take(requestId: string, signal?: AbortSignal): Promise<ControlState> {
    return this.request("POST", "/control/take", ControlState, { body: { requestId }, signal });
  }

  release(requestId: string, signal?: AbortSignal): Promise<ControlState> {
    return this.request("POST", "/control/release", ControlState, { body: { requestId }, signal });
  }

  cancel(requestId: string, signal?: AbortSignal): Promise<ControlState> {
    return this.request("POST", "/control/cancel", ControlState, { body: { requestId }, signal });
  }

  /**
   * M27 browser (patch 0006): the browser's tabs, read without starting it (an empty list when none
   * runs). A computer from before 0006 answers 404 (ComputerError "not_found" without noSuchTab).
   */
  tabs(signal?: AbortSignal): Promise<TabsResult> {
    return this.request("GET", "/human/tabs", Tabs, { timeoutMs: 5_000, signal });
  }

  /**
   * M27 browser: a tab action while the user drives (409 "conflict" otherwise; 404 with noSuchTab
   * for a tab that has closed). Addresses are http(s), already resolved by the caller. Answers the
   * tabs as they are after.
   */
  tabAction(body: TabActionBody, signal?: AbortSignal): Promise<TabsResult> {
    return this.request("POST", "/human/tabs", Tabs, { body, timeoutMs: TAB_ACTION_TIMEOUT_MS, signal });
  }

  /** M27 browser: the active tab goes to an address, or back, forward or reloads; the same terms. */
  browserNavigate(body: { url: string } | { action: "back" | "forward" | "reload" }, signal?: AbortSignal): Promise<TabsResult> {
    return this.request("POST", "/human/navigate", Tabs, { body, timeoutMs: TAB_ACTION_TIMEOUT_MS, signal });
  }

  /**
   * POST /sign-in/fill: the computer finds the login form on the open page itself and types the
   * login into it, refusing a page that isn't on `origin` (or that moves to another origin between
   * the username and the password). The values are sent once and never returned or logged.
   */
  signInFill(input: { origin: string; username?: string; password: string }, signal?: AbortSignal): Promise<SignInFillResult> {
    return this.request("POST", "/sign-in/fill", SignInFill, { body: input, timeoutMs: SIGN_IN_TIMEOUT_MS, signal });
  }

  /** POST /sign-in/code: the one-time code the site asked for after the password, on the same terms. */
  signInCode(input: { origin: string; code: string }, signal?: AbortSignal): Promise<SignInCodeResult> {
    return this.request("POST", "/sign-in/code", SignInCode, { body: input, timeoutMs: SIGN_IN_TIMEOUT_MS, signal });
  }

  /** POST /computers/stop: closes the browser now (profile kept); the next request starts it again. */
  async stopBrowser(signal?: AbortSignal): Promise<{ wasRunning: boolean }> {
    const body = await this.request("POST", "/computers/stop", Stopped, { body: {}, signal });
    return { wasRunning: body.wasRunning ?? false };
  }

  /**
   * GET /files/download?path=: a /workspace file's exact bytes (any type, no text limit; the
   * computer caps one download at 100 MB). Not an acting route: it works while the user drives.
   * Larger than `maxBytes` is ComputerError("too_large") without reading the body.
   */
  async download(path: string, opts: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    const url = new URL("/files/download", this.base);
    url.searchParams.set("path", path);
    // A large file needs longer than a JSON call: 30 s plus a second per MB allowed.
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS + Math.ceil(opts.maxBytes / 1_000_000) * 1_000);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "GET",
        headers: { "x-openbot-computer-token": this.options.token, "x-openbot-bot-id": this.options.botId, accept: "application/octet-stream" },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : "";
      throw new ComputerError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable", null, "");
    }
    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => null);
      throw failure(response.status, raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ComputerError("too_large", response.status, `The file is ${declared} bytes; the limit is ${opts.maxBytes}.`);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new ComputerError("timeout", response.status, "");
    }
    if (bytes.byteLength > opts.maxBytes) throw new ComputerError("too_large", response.status, `The file is ${bytes.byteLength} bytes; the limit is ${opts.maxBytes}.`);
    return bytes;
  }
}

function failure(status: number, body: Record<string, unknown> | null): ComputerError {
  const detail = typeof body?.error === "string" ? body.error.slice(0, DETAIL_MAX) : "";
  if (status === 401) return new ComputerError("unauthorized", status, "", null);
  if (status === 409 && body?.humanHasControl === true) return new ComputerError("human_in_control", status, detail, body);
  if (status === 409 && body?.snapshotRequired === true) return new ComputerError("snapshot_required", status, detail, body);
  if (status === 409 && body?.stale === true) return new ComputerError("stale_ref", status, detail, body);
  if (status === 409) return new ComputerError("conflict", status, detail, body);
  if (status === 400) return new ComputerError("bad_request", status, detail, body);
  if (status === 403) return new ComputerError("forbidden", status, detail, body);
  if (status === 404) return new ComputerError("not_found", status, detail, body);
  if (status === 413) return new ComputerError("too_large", status, detail, body);
  return new ComputerError("failed", status, detail, body);
}
