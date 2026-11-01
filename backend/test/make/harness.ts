// Test-only harness for the M6 backend B tests (Make, artifacts, skills, reactions): the
// real agent runtime + run host + tasks + every B module on a role-scripted model, an in-memory
// Workspace (no computer, no network) and an adjustable clock. The build model's computer tools
// (backend A) are stood in for by the scripted turn writing the page into the fake workspace.
import type { ToolProvider } from "../../src/agent/types.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { ApprovalService } from "../../src/approvals/service.ts";
import { createArtifacts, type Artifacts } from "../../src/artifacts/index.ts";
import type { ArtifactDeps } from "../../src/artifacts/service.ts";
import type { Workspace, WorkspaceExecResult } from "../../src/computer/workspace.ts";
import type { Message } from "../../src/contract/messages.ts";
import type { LlmRequest } from "../../src/llm/index.ts";
import { createReactions, type Reactions } from "../../src/reactions/index.ts";
import { approvalRoutes } from "../../src/routes/approvals.ts";
import { RunHost } from "../../src/runs/host.ts";
import { createSkills, type Skills } from "../../src/skills/index.ts";
import { createTasks, type Tasks } from "../../src/tasks/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import type { ScriptTurn } from "../helpers/scripted-model.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, RoleScriptedLlm, text } from "../tasks/harness.ts";

export { call, json, lastEventId, messagesOf, ofType, storedEvents, text } from "../tasks/harness.ts";

/** In-memory /workspace per user; refuses absolute paths and "..", like the real one. */
export class FakeWorkspace implements Workspace {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: { op: "read" | "write" | "exec"; userId: string; path: string; runId?: string }[] = [];
  constructor(public configured = true) {}
  /** the computer's owner; null = every user (Workspace.allows) */
  owner: string | null = null;

  async allows(userId: string): Promise<boolean> {
    return this.configured && (this.owner === null || this.owner === userId);
  }

  private key(userId: string, path: string): string {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("path outside /workspace");
    return `${userId}\u0000${path}`;
  }

  put(userId: string, path: string, content: string): void {
    this.files.set(this.key(userId, path), new TextEncoder().encode(content));
  }

  get(userId: string, path: string): string | null {
    const bytes = this.files.get(this.key(userId, path));
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async readFile(userId: string, path: string, opts: { maxBytes?: number; runId?: string } = {}): Promise<Uint8Array> {
    this.calls.push({ op: "read", userId, path, runId: opts.runId });
    if (!this.configured) throw new Error("not configured");
    const bytes = this.files.get(this.key(userId, path));
    if (!bytes) throw new Error("ENOENT");
    if (bytes.byteLength > (opts.maxBytes ?? 25 * 1024 * 1024)) throw new Error("too large");
    return bytes;
  }

  async writeFile(userId: string, path: string, bytes: Uint8Array, opts: { runId?: string } = {}): Promise<void> {
    this.calls.push({ op: "write", userId, path, runId: opts.runId });
    if (!this.configured) throw new Error("not configured");
    this.files.set(this.key(userId, path), bytes);
  }

  async exec(userId: string, command: string, opts: { cwd?: string; runId?: string } = {}): Promise<WorkspaceExecResult> {
    this.calls.push({ op: "exec", userId, path: opts.cwd ?? "", runId: opts.runId });
    void command;
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

export interface MakeApp {
  fixture: TestApp;
  llm: RoleScriptedLlm;
  workspace: FakeWorkspace;
  runs: RunHost;
  tasks: Tasks;
  artifacts: Artifacts;
  skills: Skills;
  reactions: Reactions;
  approvals: ApprovalService;
  alex: SignedIn;
  /** null = real time */
  clock: { now: Date | null };
}

export async function startMake(opts: { configured?: boolean; notify?: ArtifactDeps["notify"] } = {}): Promise<MakeApp> {
  const llm = new RoleScriptedLlm();
  const workspace = new FakeWorkspace(opts.configured ?? true);
  const clock: { now: Date | null } = { now: null };
  const now = () => clock.now ?? new Date();
  let built: Omit<MakeApp, "fixture" | "llm" | "workspace" | "alex" | "clock"> | undefined;
  const fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const providers: ToolProvider[] = [];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent });
      const tasks = createTasks({ db: core.db, events: core.events, runs });
      const artifacts = createArtifacts({ db: core.db, events: core.events, runs, usage: core.usage, workspace, now, notify: opts.notify });
      const skills = createSkills({ db: core.db, events: core.events, cards: tasks.cards });
      const reactions = createReactions({ db: core.db, events: core.events });
      const approvals = new ApprovalService({ db: core.db, events: core.events, now });
      providers.push(...tasks.providers, ...artifacts.providers, ...skills.providers, ...reactions.providers);
      built = { runs, tasks, artifacts, skills, reactions, approvals };
      return { agent, runs, routes: [...tasks.routes, ...artifacts.routes, ...skills.routes, ...reactions.routes, approvalRoutes(approvals)] };
    },
  });
  const alex = await signUp(fixture, "alex");
  return { fixture, llm, workspace, alex, clock, ...built! };
}

export const PAGE = `<!doctype html><html lang="en"><head><title>Bike shop</title></head><body><main class="duet-page"><h1>Book a tune-up</h1><p>Open 9 to 6.</p></main></body></html>`;

/** The artifact id in the build prompt (the turn's message names /workspace/artifacts/<id>/index.html). */
export function artifactIdIn(request: LlmRequest): string {
  const all = [...JSON.stringify(request.messages).matchAll(/\/workspace\/artifacts\/([A-Za-z0-9_-]+)\/index\.html/g)];
  const id = all.at(-1)?.[1];
  if (!id) throw new Error("no artifact path in the build prompt");
  return id;
}

export interface BuildTurnOptions {
  html?: string;
  title?: string;
  sources?: { name: string; app: string | null; detail: string }[];
  metrics?: { label: string; value: number; unit: string | null }[];
  refreshSchedule?: { cadence: "daily" | "weekdays" | "hourly"; hour: number; minute: number };
  step?: string;
  data?: unknown;
  /** the path passed to finish_build (default: the right one) */
  path?: (id: string) => string;
  /** false: don't write the page (finish_build then can't read it) */
  write?: boolean;
}

/** One build round: "writes" the page as the computer tools would, then calls finish_build. */
export function buildTurn(m: Pick<MakeApp, "workspace" | "alex">, opts: BuildTurnOptions = {}): ScriptTurn {
  return (request) => {
    const id = artifactIdIn(request);
    if (opts.write !== false) m.workspace.put(m.alex.userId, `artifacts/${id}/index.html`, opts.html ?? PAGE);
    const args: Record<string, unknown> = { path: opts.path ? opts.path(id) : `/workspace/artifacts/${id}/index.html` };
    if (opts.title) args.title = opts.title;
    if (opts.sources) args.sources = opts.sources;
    if (opts.metrics) args.metrics = opts.metrics;
    if (opts.refreshSchedule) args.refreshSchedule = opts.refreshSchedule;
    if (opts.data !== undefined) args.data = opts.data;
    return [text(`${opts.step ?? "Laying out the page"}\n`), call("finish_build", args)];
  };
}

/** A chat message from alex, read until the turn's `done`. */
export async function chat(m: MakeApp, body: string, clientId: string, extra: Record<string, unknown> = {}) {
  return readSse(await m.fixture.app.request(`/api/channels/${m.alex.mainChannelId}/messages`, json(m.alex, "POST", { text: body, clientId, ...extra })));
}

/** The main channel's timeline as the app loads it. */
export async function timeline(m: MakeApp, user: SignedIn = m.alex): Promise<Message[]> {
  const res = await m.fixture.app.request(`/api/channels/${user.mainChannelId}/messages?limit=100`, { headers: user.headers });
  if (res.status !== 200) throw new Error(`messages: ${res.status}`);
  return ((await res.json()) as { messages: Message[] }).messages;
}

/** Text of every tool result the model got back in a request (to check errors). */
export function toolResults(request: LlmRequest | undefined): string {
  return JSON.stringify(request?.messages ?? []);
}
