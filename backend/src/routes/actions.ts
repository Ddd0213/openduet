// POST /api/messages/:id/action (MessageActionRequest -> MessageActionResponse): card buttons.
// Start / Hide on suggestion cards, Done on a plate row, Save skill / Not now on a skill proposal
// (registered by src/skills/ through CardActions.handle).
import type { RegisterRoutes } from "../app.ts";
import { MessageActionRequest, MessageActionResponse } from "../contract/messages.ts";
import { HttpError, readJson } from "../http.ts";
import type { CardActions } from "../tasks/cards.ts";

export function registerActionRoutes(cards: CardActions): RegisterRoutes {
  return (app) => {
    app.post("/api/messages/:id/action", async (c) => {
      const id = c.req.param("id");
      if (!id) throw new HttpError(404, "not_found", "Not found.");
      const input = await readJson(c, MessageActionRequest);
      const message = await cards.act(c.get("user").id, id, input);
      return c.json(MessageActionResponse.parse({ message }));
    });
  };
}
