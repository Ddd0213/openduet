// The proactive engine (M4 backend A): scheduled morning briefs and check-ins (L75), the first-day
// scan (L76, L77), Tasks > Scheduled and Run now (L118), the Up next scan (L119).
//
// index.ts wiring (owned by the main agent), after tasks and connectors exist:
//   const proactive = createProactive({ db, runs, usage, tasks: tasks.service, catalog: connectors.catalog,
//     notify: (input) => notifier.notify(input), resolver: modelsModule.resolver, events });  // M23: resolver, events
//   providers.push(...proactive.providers);            // the runtime reads providers on every turn
//   await tasks.service.recoverAfterRestart();
//   await runs.recoverStaleRuns();                      // cancels runs a previous process left
//   await proactive.scheduler.start();                  // ticks once now (missed slots), then every 30 s
//   const app = createApp({ ..., routes: [...proactive.routes, ...] });
//   // shutdown: server.stop() -> proactive.scheduler.stop() -> runs.shutdown() -> db.$disconnect()
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { ModelResolver } from "../llm/index.ts";
import { registerOnboardingRoutes } from "../routes/onboarding.ts";
import { registerRoutineRoutes, registerScheduleRoutes } from "../routes/schedule.ts";
import { registerUpNextScanRoutes } from "../routes/up-next.ts";
import { RoutineService } from "../routines/service.ts";
import { createRoutineTools } from "../routines/tools.ts";
import type { RunHost } from "../runs/host.ts";
import { Scheduler } from "../scheduler/index.ts";
import type { TaskService } from "../tasks/service.ts";
import type { UsageMeter } from "../usage/meter.ts";
import { createProactiveProvider } from "./provider.ts";
import { ProactiveService, type Notify } from "./service.ts";

export { ProactiveService, toRunRecord, type Notify, type NotifyInput } from "./service.ts";

export interface ProactiveDeps {
  db: Db;
  runs: RunHost;
  usage: UsageMeter;
  tasks: TaskService;
  catalog: ConnectorCatalog | null;
  notify: Notify;
  now?: () => Date;
  tickMs?: number;
  welcomeDelaysMs?: readonly [number, number];
  /**
   * M9: the built-in morning brief and check-ins (config PROACTIVE_BUILTINS, default off): the
   * scheduler runs them, GET /api/schedule says builtins: true and chat offers set_weekends. The
   * first-day scan and routines run either way.
   */
  builtins?: boolean;
  /** M23: triage's model (modelsModule.resolver; role utility, else the user's default) */
  resolver?: ModelResolver | null;
  /** M23: re-sends the brief's message with TextPayload.brief */
  events?: EventBus | null;
}

export interface Proactive {
  service: ProactiveService;
  scheduler: Scheduler;
  /** M9: scheduled tasks (schedule_task), ticked by the same scheduler */
  routines: RoutineService;
  providers: ToolProvider[];
  routes: RegisterRoutes[];
}

/** GET/POST /api/schedule*, POST /api/up-next/scan, GET /api/onboarding, POST /api/onboarding/complete. */
export function registerProactiveRoutes(deps: { service: ProactiveService; catalog: ConnectorCatalog | null; tasks: TaskService }): RegisterRoutes {
  const routes = [
    registerScheduleRoutes(deps.service),
    registerUpNextScanRoutes(deps.service),
    registerOnboardingRoutes({ catalog: deps.catalog, scans: deps.service, tasks: deps.tasks }),
  ];
  return (app) => { for (const register of routes) register(app); };
}

export function createProactive(deps: ProactiveDeps): Proactive {
  const builtins = deps.builtins ?? false;
  const service = new ProactiveService({ ...deps, builtins });
  const routines = new RoutineService({ db: deps.db, runs: deps.runs, usage: deps.usage, tasks: deps.tasks, now: service.now });
  const scheduler = new Scheduler({ db: deps.db, runner: service, now: service.now, tickMs: deps.tickMs, builtins, routines });
  const provider = createProactiveProvider({
    db: deps.db, tasks: deps.tasks, now: service.now, builtins,
    modeOf: (input) => service.modeOf(input), stateOf: (runId) => service.stateOf(runId),
  });
  return {
    service, scheduler, routines, providers: [provider, createRoutineTools({ tasks: deps.tasks, routines })],
    routes: [
      registerProactiveRoutes({ service, catalog: deps.catalog, tasks: deps.tasks }),
      registerRoutineRoutes({ routines, tasks: deps.tasks }),
    ],
  };
}
