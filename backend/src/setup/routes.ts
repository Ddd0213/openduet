// M22 (#47): GET /api/setup -> SetupInfo; POST /api/setup/check -> SetupInfo after trying each
// set-up row, 429 rate_limited within 30 s of the user's last check (Retry-After in seconds).
import type { RegisterRoutes } from "../app.ts";
import { SetupInfo } from "../contract/m22.ts";
import { errorBody } from "../http.ts";
import type { SetupService } from "./service.ts";

export function registerSetupRoutes(setup: Pick<SetupService, "info" | "check">): RegisterRoutes {
  return (app) => {
    app.get("/api/setup", async (c) => c.json(SetupInfo.parse(await setup.info(c.get("user").id))));

    app.post("/api/setup/check", async (c) => {
      const answer = await setup.check(c.get("user").id);
      if (answer.limited) {
        c.header("Retry-After", String(answer.retryAfterSeconds));
        return c.json(errorBody("rate_limited", "Checked a moment ago. Try again in a few seconds."), 429);
      }
      return c.json(SetupInfo.parse(answer.info));
    });
  };
}
