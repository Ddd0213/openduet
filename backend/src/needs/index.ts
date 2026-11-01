// M22 (#22, show_tasks): Needs you (GET /api/needs-you) and the show_tasks tool.
//
// index.ts wiring:
//   const needs = createNeeds({ db });
//   providers.push(...needs.providers);  routes: [...needs.routes]
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { Db } from "../db.ts";
import { registerNeedsRoutes } from "./routes.ts";
import { showTasksProvider } from "./tools.ts";

export { needsYou, approvalSummary } from "./service.ts";
export { buildTaskBoard, type Board, type BoardCounts } from "./board.ts";
export { SHOW_TASKS } from "./tools.ts";

export interface Needs { providers: ToolProvider[]; routes: RegisterRoutes[] }

export function createNeeds(deps: { db: Db; now?: () => Date }): Needs {
  return {
    providers: [showTasksProvider(deps)],
    routes: [registerNeedsRoutes(deps.now ? { now: deps.now } : {})],
  };
}
