import type { User } from "@prisma/client";
import type { Config } from "../config.ts";
import { Me } from "../contract/auth.ts";
import { searchOffered } from "../builtins/config.ts";

/** M12: what the models module knows about this user's default model (models/hooks.ts). */
export interface ModelFeatures { models: boolean; serverWebTools: boolean; /** M13: a usable realtime voice model */ voice?: boolean }

/**
 * Only a database User (not Better Auth's synthetic email) may enter this mapper. `models` (M12):
 * left out (no models module wired, e.g. tests), Features.models is its contract default (true) and
 * webSearch counts the configured provider or key-less default; Features.voice (M13) false.
 */
export function toMe(user: User, mainChannelId: string, config: Config, models?: ModelFeatures): Me {
  const [hour, minute] = user.briefTime.split(":").map(Number);
  return Me.parse({
    id: user.id,
    username: user.username,
    name: user.name,
    firstName: user.firstName,
    email: user.email,
    timezone: user.timezone,
    language: user.language,
    briefTime: { hour, minute },
    checkinMinute: user.checkinMinute,
    weekendsOn: user.weekendsOn,
    onboardedAt: user.onboardedAt?.toISOString() ?? null,
    mainChannelId,
    features: {
      connectors: !!config.COMPOSIO_API_KEY,
      webSearch: searchOffered(config) || !!models?.serverWebTools,
      push: config.NOTIFY_PROVIDER ?? null,
      computer: !!config.COMPUTER_URL,
      models: models?.models ?? true,
      voice: models?.voice ?? false,
      computerMode: config.COMPUTER_URL ? config.COMPUTER_BROWSER_MODE : "off",
      computerIdleMinutes: config.COMPUTER_BROWSER_IDLE_MS > 0 ? Math.max(1, Math.round(config.COMPUTER_BROWSER_IDLE_MS / 60_000)) : null,
    },
    createdAt: user.createdAt.toISOString(),
  });
}
