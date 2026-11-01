// Onboarding with real data (L77): GET /api/onboarding (page 2's chips, page 5's Slack row) and
// POST /api/onboarding/complete (onboardedAt once + the assistant's welcome and the first-day scan as
// events; calling it again changes nothing and starts nothing).
import type { RegisterRoutes } from "../app.ts";
import { toMe } from "../auth/me.ts";
import { modelFeatures } from "../auth/middleware.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import { OnboardingCompleteResponse, OnboardingInfo } from "../contract/auth.ts";
import { completeOnboarding, onboardingInfo, type FirstDayStarter } from "../onboarding/info.ts";
import type { TaskService } from "../tasks/service.ts";

export interface OnboardingRouteDeps {
  catalog: ConnectorCatalog | null;
  scans: FirstDayStarter;
  tasks: Pick<TaskService, "mainChannelId">;
}

export function registerOnboardingRoutes(deps: OnboardingRouteDeps): RegisterRoutes {
  return (app) => {
    app.get("/api/onboarding", async (c) => {
      const { db } = c.get("deps");
      return c.json(OnboardingInfo.parse(await onboardingInfo(db, deps.catalog, c.get("user").id)));
    });

    app.post("/api/onboarding/complete", async (c) => {
      const { db, config } = c.get("deps");
      const userId = c.get("user").id;
      const { user, scanStarted } = await completeOnboarding(db, deps.scans, userId);
      const me = toMe(user, await deps.tasks.mainChannelId(userId), config, await modelFeatures(db, userId));
      return c.json(OnboardingCompleteResponse.parse({ user: me, scanStarted }));
    });
  };
}
