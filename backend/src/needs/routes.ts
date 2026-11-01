// M22 (#22): GET /api/needs-you -> NeedsYou {count, items}: everything waiting on the user, newest
// first (service.ts). `count` is the Tasks tab badge; the app refetches after task, message,
// approval and resync events.
import type { RegisterRoutes } from "../app.ts";
import { NeedsYou } from "../contract/tasks.ts";
import { needsYou } from "./service.ts";

export function registerNeedsRoutes(deps: { now?: () => Date } = {}): RegisterRoutes {
  return (app) => {
    app.get("/api/needs-you", async (c) => {
      const { db } = c.get("deps");
      return c.json(NeedsYou.parse(await needsYou(db, c.get("user").id, deps.now ? { now: deps.now() } : {})));
    });
  };
}
