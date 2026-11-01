// OpenDuet's computer in one place, for index.ts and the tests (M6 backend A): the client (null
// without COMPUTER_URL / COMPUTER_TOKEN: "isn't set up yet"), the Workspace seam for Make builds,
// the agent's tools, the routes, the WebSocket handler Bun.serve needs, and the sweep.
import type { TurnInput, ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { FileStore } from "../files/store.ts";
import type { Model, ModelRole } from "../llm/index.ts";
import type { PolicyService } from "../policy/service.ts";
import type { ApprovalService } from "../approvals/service.ts";
import { computerRoutes } from "../routes/computer.ts";
import { Audit, type AuditSink } from "./audit.ts";
import { ComputerClient } from "./client.ts";
import { computerProvider, type ComputerProvider } from "./provider.ts";
import { ComputerService, type ContinueRun, type Notify } from "./service.ts";
import { SignInService } from "./signin.ts";
import { computerStreamHandler, type StreamSocketData } from "./stream.ts";
import { POLICY_TOOLS } from "./tools.ts";
import { createWorkspace, type ComputerWorkspace } from "./workspace-impl.ts";
import type { WebSocketHandler } from "bun";
import type { SessionConnections } from "../auth/connections.ts";

export interface ComputerModuleDeps {
  db: Db;
  events: EventBus;
  files: FileStore;
  connections?: SessionConnections;
  config: Pick<Config, "COMPUTER_URL" | "COMPUTER_TOKEN" | "COMPUTER_BOT_ID"> & Partial<Pick<Config, "COMPUTER_OWNER" | "COMPUTER_START_URL">>;
  /**
   * The legacy model layer, to tell whether this turn's models declare vision (screenshots, L140).
   * M12: a turn the resolver picked a model for carries it (TurnInput.model) and that wins; null /
   * left out = only those turns can see images.
   */
  llm?: { roleModels(role: ModelRole): Model[] } | null;
  policy: PolicyService;
  /** for computer_exec's "ask" cards; null = such calls fail with a reason */
  approvals: ApprovalService | null;
  /** Notifier.notify (L144 human checks) */
  notify?: Notify | null;
  /** starts the turn that carries on after a hand back / sign-in (RunHost.submit); settable later */
  continueRun?: ContinueRun | null;
  /** tests: a fake computer */
  fetch?: typeof fetch;
  connect?: (url: string) => WebSocket;
  audit?: AuditSink;
  now?: () => number;
  waitMs?: { chat: number; background: number };
  copyWaitMs?: number;
  signInTtlMs?: number;
  /** M20 tests: the auto hand back's idle time (default 10 minutes) and the start page */
  handBackMs?: number;
  startPageUrl?: string;
}

export interface ComputerModule {
  /** false = COMPUTER_URL / COMPUTER_TOKEN aren't set */
  configured: boolean;
  service: ComputerService;
  /** the seam for Make builds and other modules (paths relative to /workspace) */
  workspace: ComputerWorkspace;
  signIn: SignInService;
  provider: ComputerProvider;
  /** for createAgentRuntime({ providers }) */
  providers: ToolProvider[];
  /** for createApp({ routes }) */
  routes: RegisterRoutes[];
  /** for Bun.serve({ websocket }) */
  websocket: WebSocketHandler<StreamSocketData>;
  setContinueRun(continueRun: ContinueRun | null): void;
  /** which Make build runs the user started (artifacts): their "ask" tools run without a card */
  setTrustedBuild(trusted: ((runId: string) => boolean) | null): void;
  start(): void;
  stop(): void;
}

const ROLE: Record<NonNullable<TurnInput["kind"]>, ModelRole> = { chat: "chat", task: "task", build: "task", brief: "proactive", checkin: "proactive", scan: "proactive", routine: "proactive" };

export function createComputerModule(deps: ComputerModuleDeps): ComputerModule {
  const client = deps.config.COMPUTER_URL && deps.config.COMPUTER_TOKEN
    ? new ComputerClient({ baseUrl: deps.config.COMPUTER_URL, token: deps.config.COMPUTER_TOKEN, botId: deps.config.COMPUTER_BOT_ID, fetch: deps.fetch })
    : null;
  const audit = deps.audit ?? new Audit(deps.db);
  const service = new ComputerService({
    db: deps.db, events: deps.events, client, audit, notify: deps.notify ?? null, continueRun: deps.continueRun ?? null, now: deps.now, ownerUsername: deps.config.COMPUTER_OWNER ?? null,
    handBackMs: deps.handBackMs, startPageUrl: deps.startPageUrl ?? deps.config.COMPUTER_START_URL,
  });
  const workspace = createWorkspace(client, { audit, allows: (userId) => service.allows(userId) });
  const signIn = new SignInService({ db: deps.db, events: deps.events, service, audit, now: deps.now, ttlMs: deps.signInTtlMs });
  const vision = (input: TurnInput) => {
    // M12: the one model this turn runs on (there's no fallback chain any more).
    if (input.model) return input.model.vision;
    if (!deps.llm) return false;
    const models = deps.llm.roleModels(ROLE[input.kind ?? (input.taskId ? "task" : "chat")]);
    return models.length > 0 && models.every((m) => m.capabilities.vision);
  };
  let trusted: ((runId: string) => boolean) | null = null;
  const provider = computerProvider({
    db: deps.db, events: deps.events, files: deps.files, service, workspace, signIn, policy: deps.policy, approvals: deps.approvals, audit, vision,
    waitMs: deps.waitMs, copyWaitMs: deps.copyWaitMs, trustedBuild: (runId) => trusted?.(runId) ?? false,
  });
  if (deps.approvals) for (const slug of POLICY_TOOLS) deps.approvals.registerExecutor(slug, provider.executeApproved);
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    configured: !!client,
    service,
    workspace,
    signIn,
    provider,
    providers: [provider],
    routes: [computerRoutes({ service, signIn, policy: deps.policy })],
    websocket: computerStreamHandler(service, { connect: deps.connect, connections: deps.connections }),
    setContinueRun: (continueRun) => service.setContinueRun(continueRun),
    setTrustedBuild: (next) => { trusted = next; },
    start() {
      if (!client || timer) return;
      service.start();
      void signIn.recover().catch(() => undefined);
      timer = setInterval(() => { void signIn.sweep().catch(() => undefined); }, 30_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      service.stop();
    },
  };
}

export { createWorkspace, type ComputerWorkspace } from "./workspace-impl.ts";
export type { Workspace } from "./workspace.ts";
