// GET /api/usage, GET /api/usage/stats (M9) and POST /api/usage/full-reset (L79, L166).
// The numbers come from UsageMeter; the stats panel from Run rows (usage/stats.ts).
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { UsageRange, UsageState, UsageStats } from "../contract/account.ts";
import { HttpError } from "../http.ts";
import { usageStats, type ModelLabels } from "../usage/stats.ts";

export const getUsage: Handler<AppEnv> = async (c) => c.json(UsageState.parse(await c.get("deps").usage.state(c.get("user").id)));

/** ?range=today|7d|30d|all (default 7d); anything else is 400 validation_failed (field "range"). */
export function getUsageStats(labels: ModelLabels): Handler<AppEnv> {
  return async (c) => {
    const range = UsageRange.safeParse(c.req.query("range") ?? "7d");
    if (!range.success) throw new HttpError(400, "validation_failed", "range: must be today, 7d, 30d or all", "range");
    const { db, usage } = c.get("deps");
    const user = c.get("user");
    return c.json(UsageStats.parse(await usageStats(db, user, range.data, usage.clock(), labels)));
  };
}

/** One free Full reset per calendar month in the user's timezone; a second one is 409 stale_version. */
export const fullReset: Handler<AppEnv> = async (c) => {
  const { events, usage, runs } = c.get("deps");
  const userId = c.get("user").id;
  if (!(await usage.fullReset(userId))) {
    throw new HttpError(409, "stale_version", "The free full reset was already used this month.");
  }
  const state = UsageState.parse(await usage.state(userId));
  await events.emit(userId, null, "usage", { usage: state });
  // Old "Usage limit reached" lines collapse to "Usage limit lifted" (L166).
  await runs.liftIfAvailable(userId);
  return c.json(state);
};
