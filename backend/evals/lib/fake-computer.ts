// Eval-only OpenDuet's computer: the agent-computer HTTP API served through the fetch the computer
// client is given (no port, no container). The browser "renders" the canned pages; commands, file
// writes, clicks and typing are recorded and answered with canned results. Nothing runs.
import { PROBE_COMMAND } from "../../src/agent/environment.ts";
import type { FakeWeb } from "./fake-web.ts";
import { posix } from "node:path";

export const COMPUTER_URL = "http://computer.eval.invalid:4100";

export interface ComputerCall { path: string; body: Record<string, unknown> }

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PROBE_OUT = ["bash", "node", "bun", "npm", "curl", "git", "python3", "pip3", "jq", "sqlite3", "unzip"].map((p) => `has ${p}`).join("\n") + "\n4294967296\n";

export class FakeComputer {
  readonly calls: ComputerCall[] = [];
  private url = "about:blank";
  private snapshot = 0;
  private browser = false;

  readonly files = new Map<string, string>();
  constructor(private readonly web: FakeWeb, private readonly opts: { fileStore?: boolean } = {}) {}
  enableFileStore(enabled: boolean): void { this.opts.fileStore = enabled; }

  private filePath(path: unknown): string | null {
    const raw = String(path ?? ".").replace(/^\/workspace(?:\/|$)/, "");
    if (raw.startsWith("/") || raw.split("/").includes("..")) return null;
    return posix.normalize(raw);
  }

  private page() {
    const page = this.web.page(this.url);
    if (page) return { url: this.url, title: page.browser.title, text: page.browser.text, login: page.browser.login === true };
    return { url: this.url, title: "Page", text: this.url === "about:blank" ? "" : `Rendered text of ${this.url}.`, login: false };
  }

  private elements(login: boolean) {
    const els = login
      ? [{ role: "textbox", name: "Email" }, { role: "textbox", name: "Password" }, { role: "button", name: "Sign in" }]
      : [{ role: "link", name: "Home" }, { role: "button", name: "Menu" }];
    return els.map((e, i) => ({ ref: `s${this.snapshot}e${i + 1}`, ...e }));
  }

  private control() {
    return { holder: "bot", since: new Date(0).toISOString(), requested: false, transitioning: false, resumeSnapshotRequired: false, recoveryRequired: false };
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname;
    const probe = path === "/exec" && body.command === PROBE_COMMAND;
    if (!["/health", "/control"].includes(path) && !probe) {
      // Typed text, written contents and sign-in values are never kept, only their size.
      const kept = { ...body };
      for (const key of ["text", "contents", "password", "username", "code"]) if (typeof kept[key] === "string") kept[key] = `[${(kept[key] as string).length} chars]`;
      this.calls.push({ path, body: kept });
    }
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    if (this.opts.fileStore && path.startsWith("/files/")) {
      const file = this.filePath(path === "/files/download" ? url.searchParams.get("path") : body.path);
      if (file === null) return json({ error: "Path leaves /workspace." }, 400);
      if (path === "/files/write") {
        const text = String(body.contents ?? "");
        this.files.set(file, (body.append ? this.files.get(file) ?? "" : "") + text);
        return json({ path: file, bytes: Buffer.byteLength(text) });
      }
      if (path === "/files/read" || path === "/files/download") {
        const text = this.files.get(file);
        if (text === undefined) return json({ error: "No such file." }, 404);
        return path === "/files/download" ? new Response(text) : json({ path: file, text, bytes: Buffer.byteLength(text), truncated: false });
      }
      if (path === "/files/list") {
        const prefix = file === "." ? "" : file + "/";
        const entries = [...this.files.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, text]) => ({ path: name, kind: "file", bytes: Buffer.byteLength(text) }));
        return json({ path: file, entries, truncated: false });
      }
    }
    switch (path) {
      case "/health": return json({ status: "ok", browser: this.browser });
      case "/control": case "/control/request": case "/control/take": case "/control/release": case "/control/cancel": return json(this.control());
      case "/navigate": {
        this.url = String(body.url ?? "about:blank");
        this.browser = true;
        this.snapshot++;
        const p = this.page();
        return json({ url: p.url, title: p.title, text: p.text, truncated: false });
      }
      case "/read": { const p = this.page(); return json({ url: p.url, title: p.title, text: p.text, truncated: false }); }
      case "/snapshot": { this.snapshot++; const p = this.page(); return json({ snapshotId: this.snapshot, url: p.url, title: p.title, elements: this.elements(p.login), truncated: false }); }
      case "/click": case "/type": case "/key": case "/scroll": return json({ action: path.slice(1), url: this.url });
      case "/screenshot": return json({ base64: PNG_1X1, width: 1, height: 1, url: this.url });
      case "/files/list": return json({ path: body.path ?? ".", entries: [], truncated: false });
      case "/files/read": return json({ error: "No such file." }, 404);
      case "/files/write": return json({ path: body.path, bytes: typeof body.contents === "string" ? Buffer.byteLength(body.contents) : 0 });
      case "/exec": return json(probe ? { exitCode: 0, stdout: PROBE_OUT, stderr: "" } : this.opts.fileStore
        ? { exitCode: 1, stdout: "", stderr: "This eval workspace stores files only; use computer_files_write, computer_files_read and computer_files_list, not shell commands.", truncated: false, timedOut: false }
        : { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false });
      case "/sign-in/fill": return json({ submitted: true, passwordFieldVisible: false, codeRequested: false, url: this.url });
      case "/sign-in/code": return json({ submitted: true, codeFieldVisible: false, passwordFieldVisible: false, url: this.url });
      case "/computers/stop": this.browser = false; return json({ stopped: true, wasRunning: true });
      default: return json({ error: "Not found." }, 404);
    }
  }) as typeof fetch;
}
