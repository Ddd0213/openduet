// Tasks > Scheduled (L118): GET /api/schedule (the Morning brief and Check-in rows with their next
// run and history) and POST /api/schedule/run ("Run now": an on-demand run that takes no slot).
// M9 routines: POST /api/tasks/:id/run (a routine's Run now) and GET /api/tasks/:id/runs (its history).
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { RoutineRuns, RunNowRequest, RunNowResponse } from "../contract/tasks.ts";
import { HttpError, readJson } from "../http.ts";
import type { ProactiveService } from "../proactive/service.ts";
import type { RoutineService } from "../routines/service.ts";
import type { TaskService } from "../tasks/service.ts";

export function registerScheduleRoutes(proactive: ProactiveService): RegisterRoutes {
  return (app) => {
    app.get("/api/schedule", async (c) => c.json(await proactive.schedule(c.get("user").id)));

    app.post("/api/schedule/run", async (c) => {
      const { kind } = await readJson(c, RunNowRequest);
      const run = await proactive.runNow(c.get("user").id, kind);
      return c.json(RunNowResponse.parse({ run }));
    });
  };
}

/** Someone else's task is 404; a task that isn't a routine is 400 validation_failed. */
export function registerRoutineRoutes(deps: { routines: RoutineService; tasks: TaskService }): RegisterRoutes {
  async function ownTask(c: Context<AppEnv>) {
    const id = c.req.param("id");
    if (!id) throw new HttpError(404, "not_found", "Not found.");
    const row = await deps.tasks.own(c.get("user").id, id);
    if (!row) throw new HttpError(404, "not_found", "Not found.");
    return row;
  }
  return (app) => {
    app.post("/api/tasks/:id/run", async (c) => c.json(RunNowResponse.parse({ run: await deps.routines.runNow(await ownTask(c)) })));
    app.get("/api/tasks/:id/runs", async (c) => c.json(RoutineRuns.parse({ runs: await deps.routines.history(await ownTask(c)) })));
  };
}
