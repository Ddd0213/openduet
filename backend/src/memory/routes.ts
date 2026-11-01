// M11 memory routes (all behind the session; another user's ids are 404):
//   GET / PUT /api/channels/:id/memory   a channel's own memory (the main thread: 400, its layer is /api/memory)
//   POST      /api/memory/facts          the user adds a fact (channelId null = "About you"), source user
//   PATCH     /api/memory/facts/:id      edit an active fact's text
//   DELETE    /api/memory/facts/:id      archive it -> 204 (already archived: 204 too)
//   GET       /api/memory/overview       every non-main, non-archived channel's purpose and how it's going
// GET / PUT /api/memory ("About you") stay in account/memory.ts.
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { UpdateMemoryRequest } from "../contract/account.ts";
import { ChannelMemoryState, CreateMemoryFactRequest, MemoryFactResponse, MemoryOverview, UpdateMemoryFactRequest } from "../contract/m11.ts";
import { HttpError, readJson } from "../http.ts";
import { channelSummaries, layerState, putDocument, toFact } from "./layers.ts";

const notFound = () => new HttpError(404, "not_found", "Not found.");

/** The caller's channel from the path (Prisma treats `id: undefined` as any id, so guard it). */
async function pathChannel(c: Context<AppEnv>) {
  const id = c.req.param("id");
  if (!id) throw notFound();
  const row = await c.get("deps").db.channel.findFirst({ where: { id, userId: c.get("user").id } });
  if (!row) throw notFound();
  if (row.isMain) throw new HttpError(400, "validation_failed", "id: the main thread's memory is \"About you\" (/api/memory)", "id");
  return row;
}

async function channelMemory(c: Context<AppEnv>, channel: { id: string; useSharedMemory: boolean }) {
  const state = await layerState(c.get("deps").db, c.get("user").id, channel.id);
  return ChannelMemoryState.parse({ channelId: channel.id, useSharedMemory: channel.useSharedMemory, ...state });
}

/** An active fact of the caller's (any layer), else 404. */
async function ownFact(c: Context<AppEnv>, opts: { archived?: boolean } = {}) {
  const id = c.req.param("id");
  if (!id) throw notFound();
  const row = await c.get("deps").db.memory.findFirst({
    where: { id, userId: c.get("user").id, kind: "fact", ...(opts.archived ? {} : { archivedAt: null }) },
  });
  if (!row) throw notFound();
  return row;
}

export function registerMemoryRoutes(): RegisterRoutes {
  return (app) => {
    app.get("/api/memory/overview", async (c) => {
      const channels = await channelSummaries(c.get("deps").db, c.get("user").id);
      return c.json(MemoryOverview.parse({ channels }));
    });

    app.post("/api/memory/facts", async (c) => {
      const input = await readJson(c, CreateMemoryFactRequest);
      const { db } = c.get("deps");
      const userId = c.get("user").id;
      if (input.channelId !== null) {
        const channel = await db.channel.findFirst({ where: { id: input.channelId, userId } });
        if (!channel) throw notFound();
        if (channel.isMain) throw new HttpError(400, "validation_failed", "channelId: use null for \"About you\" (the main thread's memory)", "channelId");
      }
      const row = await db.memory.create({ data: { userId, kind: "fact", channelId: input.channelId, text: input.text, source: "user", sourceMessageId: null } });
      return c.json(MemoryFactResponse.parse({ fact: toFact(row) }));
    });

    app.patch("/api/memory/facts/:id", async (c) => {
      const fact = await ownFact(c);
      const input = await readJson(c, UpdateMemoryFactRequest);
      const row = await c.get("deps").db.memory.update({ where: { id: fact.id }, data: { text: input.text } });
      return c.json(MemoryFactResponse.parse({ fact: toFact(row) }));
    });

    app.delete("/api/memory/facts/:id", async (c) => {
      const fact = await ownFact(c, { archived: true });
      if (!fact.archivedAt) await c.get("deps").db.memory.update({ where: { id: fact.id }, data: { archivedAt: new Date() } });
      return c.body(null, 204);
    });

    app.get("/api/channels/:id/memory", async (c) => c.json(await channelMemory(c, await pathChannel(c))));

    app.put("/api/channels/:id/memory", async (c) => {
      const channel = await pathChannel(c);
      const { document } = await readJson(c, UpdateMemoryRequest);
      await putDocument(c.get("deps").db, c.get("user").id, channel.id, document);
      return c.json(await channelMemory(c, channel));
    });
  };
}
