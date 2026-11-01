// Run records (M8): GET /api/runs (a task's runs, a channel's own runs, or every run of the user;
// newest first, paged by ?before=<runId>) and GET /api/runs/:id (one run with its steps). Only the
// signed-in user's runs; anyone else's run, task or channel is 404. No SSE: the app polls the detail
// while a run is queued or running.
import type { Handler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { Id } from "../contract/common.ts";
import { RunList } from "../contract/runs.ts";
import { HttpError } from "../http.ts";
import { RUN_INCLUDE, toRunDetail, toRunSummaries } from "../runs/records.ts";

const notFound = () => new HttpError(404, "not_found", "Not found.");
const blank = (v: unknown) => (v === "" ? undefined : v);

const ListQuery = z.object({
  taskId: z.preprocess(blank, Id.optional()),
  channelId: z.preprocess(blank, Id.optional()),
  before: z.preprocess(blank, Id.optional()),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(100).default(30)),
});

export const listRuns: Handler<AppEnv> = async (c) => {
  const query = ListQuery.safeParse({ taskId: c.req.query("taskId"), channelId: c.req.query("channelId"), before: c.req.query("before"), limit: c.req.query("limit") });
  if (!query.success) {
    const field = query.error.issues[0]?.path.join(".") || "query";
    throw new HttpError(400, "validation_failed", `${field}: invalid`, field);
  }
  const { db } = c.get("deps");
  const userId = c.get("user").id;
  const { taskId, channelId, before, limit } = query.data;
  const where: Record<string, unknown> = { userId };
  if (taskId) {
    // A task's runs: its own session's turns.
    if (!(await db.task.findFirst({ where: { id: taskId, userId }, select: { id: true } }))) throw notFound();
    where.taskId = taskId;
  } else if (channelId) {
    // A channel's runs: its chat, brief / check-in / scan and build runs (task runs are under their task).
    if (!(await db.channel.findFirst({ where: { id: channelId, userId }, select: { id: true } }))) throw notFound();
    Object.assign(where, { channelId, taskId: null });
  }
  if (before) {
    const anchor = await db.run.findFirst({ where: { id: before, userId }, select: { id: true, createdAt: true } });
    if (!anchor) throw new HttpError(400, "validation_failed", "before: unknown run", "before");
    where.OR = [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }];
  }
  const rows = await db.run.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, include: RUN_INCLUDE });
  const runs = await toRunSummaries(db, rows.slice(0, limit));
  return c.json(RunList.parse({ runs, hasMore: rows.length > limit }));
};

export const getRun: Handler<AppEnv> = async (c) => {
  const id = c.req.param("id");
  if (!id) throw notFound();
  const { db } = c.get("deps");
  const row = await db.run.findFirst({ where: { id, userId: c.get("user").id }, include: RUN_INCLUDE });
  if (!row) throw notFound();
  const detail = await toRunDetail(db, row);
  if (!detail) throw notFound();
  return c.json(detail);
};
