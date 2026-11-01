// GET / PUT /api/memory: "About you" (M11: the shared memory layer, channelId null). The document
// (one row of kind "document") the user views and edits, plus its dated facts (kind "fact"),
// newest first, with who wrote them. Archived (forgotten) facts and channels' own memories are
// left out; those are GET /api/channels/:id/memory (src/memory/routes.ts).
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { MemoryState, UpdateMemoryRequest } from "../contract/account.ts";
import type { Db } from "../db.ts";
import { readJson } from "../http.ts";
import { layerState, putDocument } from "../memory/layers.ts";

export async function memoryState(db: Db, userId: string) {
  return MemoryState.parse(await layerState(db, userId, null));
}

export const getMemory: Handler<AppEnv> = async (c) => c.json(await memoryState(c.get("deps").db, c.get("user").id));

export const putMemory: Handler<AppEnv> = async (c) => {
  const { document } = await readJson(c, UpdateMemoryRequest);
  const { db } = c.get("deps");
  const userId = c.get("user").id;
  await putDocument(db, userId, null, document);
  return c.json(await memoryState(db, userId));
};
