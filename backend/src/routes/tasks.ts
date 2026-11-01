// The Tasks tab and task detail (docs/API.md "Routes", L116-L121): the list (a channel or
// Everything, never archived), the + FAB, one task, Mark complete / Archive, and the task's own
// session (paged messages, and replies answered with SSE until that turn's `done`). Someone
// else's task or channel is always 404.
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { Id } from "../contract/common.ts";
import { MessagePage, SendMessageRequest, StopResponse } from "../contract/messages.ts";
import { RESOLVED_KEEP_DAYS } from "../contract/m22.ts";
import { CreateTaskRequest, TaskDetail, TaskList, UpdateTaskRequest } from "../contract/tasks.ts";
import { HttpError, readJson } from "../http.ts";
import { toMessages } from "../runs/serialize.ts";
import { tapTask } from "../runs/stream.ts";
import { titleFromPrompt, toTaskDetail, toTaskSummaries } from "../tasks/serialize.ts";
import type { TaskService } from "../tasks/service.ts";

const notFound = () => new HttpError(404, "not_found", "Not found.");

const PageQuery = z.object({
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const DAY_MS = 24 * 60 * 60_000;
const SEARCH_MAX = 100;
/** M22: "<resolvedAt ISO>|<id>", as nextCursor wrote it. */
const Cursor = z.string().max(200).transform((raw, ctx) => {
  const bar = raw.indexOf("|");
  const at = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (bar < 1 || Number.isNaN(at.getTime()) || !Id.safeParse(id).success) {
    ctx.addIssue({ code: "custom", message: "not a cursor from this list" });
    return z.NEVER;
  }
  return { at, id };
});
/** M22 GET /api/tasks: ?resolved=older[&cursor][&limit] pages the older resolved tasks; ?q= searches. */
const ListQuery = z.object({
  resolved: z.literal("older").optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // an empty ?q= (search cleared) is the normal list
  q: z.string().trim().max(200).optional().transform((v) => (v ? v : undefined)),
}).superRefine((v, ctx) => {
  if (v.cursor && v.resolved !== "older") ctx.addIssue({ code: "custom", path: ["cursor"], message: "only with resolved=older" });
  if (v.q !== undefined && v.resolved !== undefined) ctx.addIssue({ code: "custom", path: ["q"], message: "not with resolved" });
});

export function registerTaskRoutes(tasks: TaskService): RegisterRoutes {
  async function ownTask(c: Context<AppEnv>) {
    // Guard explicitly: Prisma treats `id: undefined` as "any id".
    const id = c.req.param("id");
    if (!id) throw notFound();
    const row = await tasks.own(c.get("user").id, id);
    if (!row) throw notFound();
    return row;
  }

  return (app) => {
    app.get("/api/tasks", async (c) => {
      const { db } = c.get("deps");
      const userId = c.get("user").id;
      const query = ListQuery.safeParse({ resolved: c.req.query("resolved"), cursor: c.req.query("cursor"), limit: c.req.query("limit"), q: c.req.query("q") });
      if (!query.success) {
        const field = query.error.issues[0]?.path.join(".") || "query";
        throw new HttpError(400, "validation_failed", `${field}: ${query.error.issues[0]?.message ?? "invalid"}`, field);
      }
      const scope = c.req.query("channelId");
      let channelId: string | undefined;
      if (scope !== undefined && scope !== "" && scope !== "everything") {
        const channel = await db.channel.findFirst({ where: { id: scope, userId }, select: { id: true } });
        if (!channel) throw notFound();
        channelId = channel.id;
      }
      const base = { userId, archivedAt: null, ...(channelId ? { channelId } : {}) };
      const { resolved, cursor, limit, q } = query.data;
      // M22: the 7-day window (contract/m22.ts RESOLVED_KEEP_DAYS); older resolved tasks page in below.
      const cutoff = new Date(tasks.now().getTime() - RESOLVED_KEEP_DAYS * DAY_MS);
      const older = { status: "resolved", resolvedAt: { lt: cutoff } };
      if (q !== undefined) {
        // ?q=: title or prompt, any age, newest first (SQLite LIKE: case-insensitive for ASCII).
        const rows = await db.task.findMany({ where: { ...base, OR: [{ title: { contains: q } }, { prompt: { contains: q } }] }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: SEARCH_MAX });
        return c.json(TaskList.parse({ tasks: toTaskSummaries(rows), olderResolved: 0, nextCursor: null }));
      }
      if (resolved === "older") {
        const after = cursor ? { OR: [{ resolvedAt: { lt: cursor.at } }, { resolvedAt: cursor.at, id: { lt: cursor.id } }] } : {};
        const rows = await db.task.findMany({ where: { AND: [base, older, after] }, orderBy: [{ resolvedAt: "desc" }, { id: "desc" }], take: limit + 1 });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const nextCursor = rows.length > limit && last?.resolvedAt ? `${last.resolvedAt.toISOString()}|${last.id}` : null;
        return c.json(TaskList.parse({ tasks: toTaskSummaries(page), olderResolved: 0, nextCursor }));
      }
      // Unfinished, or resolved within the window (a resolved row without resolvedAt counts as recent).
      const recent = { OR: [{ status: { not: "resolved" } }, { resolvedAt: null }, { resolvedAt: { gte: cutoff } }] };
      const rows = await db.task.findMany({ where: { ...base, ...recent }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
      const olderResolved = await db.task.count({ where: { ...base, ...older } });
      // M9: pinned tasks first (newest pin first), then the rest by updatedAt (stable sort).
      const pinned = rows.filter((r) => r.pinnedAt).sort((a, b) => b.pinnedAt!.getTime() - a.pinnedAt!.getTime());
      return c.json(TaskList.parse({ tasks: toTaskSummaries([...pinned, ...rows.filter((r) => !r.pinnedAt)]), olderResolved, nextCursor: null }));
    });

    app.post("/api/tasks", async (c) => {
      const input = await readJson(c, CreateTaskRequest);
      const { db } = c.get("deps");
      const userId = c.get("user").id;
      const channel = await db.channel.findFirst({ where: { id: input.channelId, userId, archived: false }, select: { id: true } });
      if (!channel) throw notFound();
      const row = await tasks.create({ userId, channelId: channel.id, title: titleFromPrompt(input.prompt), prompt: input.prompt });
      return c.json(toTaskDetail(row));
    });

    app.get("/api/tasks/:id", async (c) => c.json(toTaskDetail(await ownTask(c))));

    app.patch("/api/tasks/:id", async (c) => {
      const row = await ownTask(c);
      const input = await readJson(c, UpdateTaskRequest);
      return c.json(TaskDetail.parse(toTaskDetail(await tasks.update(row, input))));
    });

    // M9: delete a task (a running turn is cancelled first). 204; someone else's task is 404.
    app.delete("/api/tasks/:id", async (c) => {
      await tasks.remove(await ownTask(c));
      return c.body(null, 204);
    });

    app.get("/api/tasks/:id/messages", async (c) => {
      const task = await ownTask(c);
      const query = PageQuery.safeParse({ before: c.req.query("before"), limit: c.req.query("limit") });
      if (!query.success) {
        const field = query.error.issues[0]?.path.join(".") ?? "query";
        throw new HttpError(400, "validation_failed", `${field}: invalid`, field);
      }
      const { db, runs } = c.get("deps");
      const { before, limit } = query.data;
      let cursor = {};
      if (before) {
        const anchor = await db.message.findFirst({ where: { id: before, taskId: task.id } });
        if (!anchor) throw new HttpError(400, "validation_failed", "before: unknown message", "before");
        cursor = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] };
      }
      if (!before && (await db.message.count({ where: { userId: task.userId, kind: "usage_limit" } })) > 0) {
        await runs.liftIfAvailable(task.userId);
      }
      const rows = await db.message.findMany({ where: { taskId: task.id, userId: task.userId, ...cursor }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
      const hasMore = rows.length > limit;
      return c.json(MessagePage.parse({ messages: await toMessages(db, rows.slice(0, limit).reverse()), hasMore }));
    });

    // M22: Try again on a failed task (409 not_retryable / task_running), Reopen on a resolved one (409 not_resolved).
    app.post("/api/tasks/:id/retry", async (c) => c.json(toTaskDetail(await tasks.retry(await ownTask(c)))));
    app.post("/api/tasks/:id/reopen", async (c) => c.json(toTaskDetail(await tasks.reopen(await ownTask(c)))));

    // M10 Stop: the current turn of the task's own session; 409 conflict when none is running or queued.
    app.post("/api/tasks/:id/stop", async (c) => {
      const stopped = await tasks.stop(await ownTask(c));
      if (stopped === 0) throw new HttpError(409, "conflict", "Nothing is running in this task.");
      return c.json(StopResponse.parse({ stopped }));
    });

    app.post("/api/tasks/:id/messages", async (c) => {
      const task = await ownTask(c);
      const input = await readJson(c, SendMessageRequest);
      const { events, heartbeatMs, connections } = c.get("deps");
      const tap = tapTask(events, task.userId, task.id);
      try {
        const { runId } = await tasks.reply(task, input);
        return tap.respond(runId, { heartbeatMs, signal: c.req.raw.signal, session: { sessionId: c.get("session").id, connections } });
      } catch (error) {
        tap.stop();
        throw error;
      }
    });
  };
}
