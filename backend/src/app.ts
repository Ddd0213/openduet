// Route registration. Only server-info and sign-in are public API endpoints.
import type { Session, User } from "@prisma/client";
import { Hono, type Context } from "hono";
import { createAuth, type Auth } from "./auth/auth.ts";
import { createDynamicClientIpResolver, socketIp } from "./auth/client-ip.ts";
import { requireSession } from "./auth/middleware.ts";
import { LoginRateLimiter } from "./auth/rate-limit.ts";
import { SessionConnections } from "./auth/connections.ts";
import { apiBodyLimit } from "./body-limit.ts";
import type { AgentRuntime } from "./agent/types.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { EventBus } from "./events/bus.ts";
import { HEARTBEAT_MS } from "./events/sse.ts";
import type { WorkspaceFileDelete } from "./computer/workspace.ts";
import { FileStore } from "./files/store.ts";
import { errorBody, errorResponse, HttpError } from "./http.ts";
import { log } from "./log.ts";
import { deleteChannel, listChannels, listMessages, markRead, stopChannel, updateChannel } from "./routes/channels.ts";
import { streamEvents } from "./routes/events.ts";
import { deleteFile, fileContent, listFiles, uploadFile, uploadLimit } from "./routes/files.ts";
import { getMe } from "./routes/me.ts";
import { sendMessage } from "./routes/messages.ts";
import { getRun, listRuns } from "./routes/runs.ts";
import { serverInfo } from "./routes/server-info.ts";
import { signIn, signOut } from "./routes/session.ts";
import { deleteSession, getSessions, revokeOthers } from "./routes/sessions.ts";
import { RunHost, unavailableAgent } from "./runs/host.ts";
import { UsageMeter } from "./usage/meter.ts";

export type AppDeps = {
  config: Config;
  db: Db;
  auth?: Auth;
  loginRateLimiter?: LoginRateLimiter;
  clientIp?: (c: Context<AppEnv>) => string | Promise<string>;
  events?: EventBus;
  connections?: SessionConnections;
  usage?: UsageMeter;
  files?: FileStore;
  /** M26: DELETE /api/files/:id?alsoWorkspace=true removes the file from OpenDuet's computer too; without it, 503 not_configured */
  fileWorkspace?: WorkspaceFileDelete;
  /** the agent runtime; without one every chat turn fails with a grey system line */
  agent?: AgentRuntime;
  /** built from the deps above unless given (index.ts passes its own to recover and shut down) */
  runs?: RunHost;
  /** SSE heartbeat interval (tests use a short one) */
  heartbeatMs?: number;
  /**
   * Route modules that own their services (approvals, connectors, tasks ...): each registers its
   * handlers on the app after the session middleware and before the 404 handler.
   */
  routes?: RegisterRoutes[];
};

/** Registers a module's routes; handlers close over the module's own services. */
export type RegisterRoutes = (app: Hono<AppEnv>) => void;

type ResolvedAppDeps = AppDeps & {
  auth: Auth;
  loginRateLimiter: LoginRateLimiter;
  clientIp: (c: Context<AppEnv>) => string | Promise<string>;
  events: EventBus;
  connections: SessionConnections;
  usage: UsageMeter;
  files: FileStore;
  runs: RunHost;
  heartbeatMs: number;
};
export type AppEnv = { Variables: { deps: ResolvedAppDeps; user: User; session: Session } };

export function createApp(input: AppDeps): Hono<AppEnv> {
  const resolveIp = createDynamicClientIpResolver(input.config.TRUSTED_PROXIES);
  const events = input.events ?? new EventBus(input.db);
  const usage = input.usage ?? new UsageMeter(input.db, input.config);
  const files = input.files ?? new FileStore(input.config.FILES_DIR);
  const deps: ResolvedAppDeps = {
    ...input,
    auth: input.auth ?? createAuth(input.config, input.db),
    loginRateLimiter: input.loginRateLimiter ?? new LoginRateLimiter(),
    clientIp: input.clientIp ?? ((c) => resolveIp(socketIp(c), c.req.header("X-Forwarded-For"))),
    events,
    connections: input.connections ?? new SessionConnections(input.db),
    usage,
    files,
    runs: input.runs ?? new RunHost({ db: input.db, events, usage, files, agent: input.agent ?? unavailableAgent }),
    heartbeatMs: input.heartbeatMs ?? HEARTBEAT_MS,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("/api/*", apiBodyLimit);
  app.use("/api/*", requireSession);
  app.get("/api/server-info", serverInfo);
  app.post("/api/session", signIn);
  app.delete("/api/session", signOut);
  app.get("/api/sessions", getSessions);
  app.delete("/api/sessions/:id", deleteSession);
  app.post("/api/sessions/revoke-others", revokeOthers);
  app.get("/api/me", getMe);
  app.get("/api/events", streamEvents);
  app.get("/api/channels", listChannels);
  app.patch("/api/channels/:id", updateChannel);
  app.delete("/api/channels/:id", deleteChannel);
  app.post("/api/channels/:id/read", markRead);
  app.get("/api/channels/:id/messages", listMessages);
  app.post("/api/channels/:id/messages", sendMessage);
  app.post("/api/channels/:id/stop", stopChannel);
  app.post("/api/channels/:id/files", uploadLimit, uploadFile);
  app.get("/api/channels/:id/files", listFiles);
  app.get("/api/files/:id/content", fileContent);
  app.delete("/api/files/:id", deleteFile);
  app.get("/api/runs", listRuns);
  app.get("/api/runs/:id", getRun);
  for (const register of input.routes ?? []) register(app);

  app.notFound((c) => c.json(errorBody("not_found", "Not found."), 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      // A 401 is never cached (requireSession answers it before a route's own no-store, e.g. /api/calls).
      if (err.status === 401) c.header("Cache-Control", "no-store");
      return errorResponse(c, err);
    }
    // Third-party error messages can contain secrets; log only the error class.
    log.error("unhandled error", { method: c.req.method, path: c.req.path, error: { name: err.name } });
    return c.json(errorBody("internal", "Something went wrong."), 500);
  });
  return app;
}
