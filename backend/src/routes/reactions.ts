// PUT / DELETE /api/messages/:id/reactions/:emoji (L157) -> ReactionResponse. PUT is idempotent;
// DELETE removes only the user's own reaction (the assistant's stays).
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { ReactionResponse } from "../contract/messages.ts";
import { HttpError } from "../http.ts";
import { Emoji, type ReactionService } from "../reactions/service.ts";

function params(c: Context<AppEnv>): { id: string; emoji: string } {
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  let raw = c.req.param("emoji") ?? "";
  // Hono decodes path params; decode once more only if a client double-encoded it.
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch { /* keep as is: validation below rejects it */ }
  }
  const emoji = Emoji.safeParse(raw.normalize("NFC"));
  if (!emoji.success) throw new HttpError(400, "validation_failed", "emoji: must be a single emoji", "emoji");
  return { id, emoji: emoji.data };
}

export function registerReactionRoutes(reactions: ReactionService): RegisterRoutes {
  return (app) => {
    app.put("/api/messages/:id/reactions/:emoji", async (c) => {
      const { id, emoji } = params(c);
      return c.json(ReactionResponse.parse({ message: await reactions.set(c.get("user").id, id, emoji, true) }));
    });
    app.delete("/api/messages/:id/reactions/:emoji", async (c) => {
      const { id, emoji } = params(c);
      return c.json(ReactionResponse.parse({ message: await reactions.set(c.get("user").id, id, emoji, false) }));
    });
  };
}
