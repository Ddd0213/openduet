// Background tasks (M3 part B): the task runner, its tools and its routes, built on the run host.
//
// index.ts wiring (owned by the main agent):
//   const providers: ToolProvider[] = [];
//   const agent = createAgentRuntime({ db, llm, config, providers });
//   const runs = new RunHost({ db, events, usage, files, agent });
//   const tasks = createTasks({ db, events, runs });
//   providers.push(...tasks.providers);           // the runtime reads providers on every turn
//   // approvals service: pass `tasks.service` as its TaskResumer
//   await tasks.service.recoverAfterRestart();    // BEFORE runs.recoverStaleRuns()
//   await runs.recoverStaleRuns();
//   const app = createApp({ ..., runs, routes: [...tasks.routes, ...] });
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import { createCardTools } from "../cards/tools.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { registerActionRoutes } from "../routes/actions.ts";
import { registerTaskRoutes } from "../routes/tasks.ts";
import { registerUpNextRoutes } from "../routes/up-next.ts";
import type { RunHost } from "../runs/host.ts";
import { CardActions } from "./cards.ts";
import { TaskService, type KnownApp } from "./service.ts";
import { createTaskTools } from "./tools.ts";

export { TaskService, type KnownApp } from "./service.ts";
export { CardActions } from "./cards.ts";

export interface Tasks {
  service: TaskService;
  cards: CardActions;
  providers: ToolProvider[];
  routes: RegisterRoutes[];
}

/** `apps`: add_update sources the catalog knows (connectors.catalog.knownApp); without it only "OpenDuet" / "OpenDuet's computer" pass. */
export function createTasks(deps: { db: Db; events: EventBus; runs: RunHost; now?: () => Date; apps?: KnownApp }): Tasks {
  const service = new TaskService(deps);
  const cards = new CardActions({ db: deps.db, events: deps.events, tasks: service });
  return {
    service,
    cards,
    // M9: ask_form / show_card (cards the assistant writes) next to the task tools.
    providers: [createTaskTools(service, deps.db), createCardTools(service, { db: deps.db, events: deps.events })],
    routes: [registerTaskRoutes(service), registerActionRoutes(cards), registerUpNextRoutes(service)],
  };
}
