// M11: GET / PUT /api/soul (Everything). Behind the session middleware like every module route.
// M22: POST /api/soul/intro ("Set up in chat"): the setup in the chat, started now (soul/setup.ts).
import type { RegisterRoutes } from "../app.ts";
import { Soul, UpdateSoulRequest } from "../contract/m11.ts";
import { SoulIntroResponse } from "../contract/m22.ts";
import { readJson } from "../http.ts";
import type { SoulService } from "./service.ts";
import { startIntro } from "./setup.ts";

export function registerSoulRoutes(soul: SoulService): RegisterRoutes {
  return (app) => {
    app.get("/api/soul", async (c) => c.json(Soul.parse(await soul.get(c.get("user").id))));
    app.put("/api/soul", async (c) => {
      const input = await readJson(c, UpdateSoulRequest);
      return c.json(Soul.parse(await soul.update(c.get("user").id, input)));
    });
    // 202: the turn is queued in the main thread (behind one running there); its events follow on SSE.
    app.post("/api/soul/intro", async (c) => {
      const { db, runs } = c.get("deps");
      return c.json(SoulIntroResponse.parse(await startIntro({ db, runs }, c.get("user").id)), 202);
    });
  };
}
