// Server info, sign-in and the signed-in user's profile.
import { z } from "zod";
import { Id, IsoDate, Language, LocalTime } from "./common.ts";
import { ComputerMode } from "./m20.ts";

/** GET /api/server-info (unauthenticated; nothing secret). */
export const ServerInfo = z.object({
  name: z.string(),
  version: z.string(),
  apiVersion: z.number().int().positive(),
});

/** POST /api/session request. */
export const SignInRequest = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

/** Optional services; when one is off the app shows its "isn't set up yet" state. */
export const Features = z.object({
  connectors: z.boolean(), // COMPOSIO_API_KEY
  webSearch: z.boolean(), // SEARCH_PROVIDER, M25's key-less default (Exa / Parallel) or a model with serverWebTools
  push: z.enum(["apns", "ntfy", "bark"]).nullable(), // NOTIFY_PROVIDER
  computer: z.boolean(), // COMPUTER_URL
  models: z.boolean().default(true), // M12: a usable default chat model is set up
  voice: z.boolean().default(false), // M13: a usable realtime voice model is set up
  /** M20: off = OpenDuet's computer isn't deployed on this server (computer false); else its browser mode */
  computerMode: ComputerMode.default("off"),
  /** M20: the browser closes after this many idle minutes (COMPUTER_BROWSER_IDLE_MS); null = never */
  computerIdleMinutes: z.number().int().positive().nullable().default(null),
});

/** The signed-in user (GET /api/me, PATCH /api/me, inside SignInResponse). */
export const Me = z.object({
  id: Id,
  username: z.string(),
  name: z.string(),
  firstName: z.string(),
  /** the real address from a connected mail account; null until there is one */
  email: z.string().nullable(),
  timezone: z.string(),
  language: Language,
  briefTime: LocalTime,
  checkinMinute: z.number().int().min(0).max(59),
  weekendsOn: z.boolean(),
  onboardedAt: IsoDate.nullable(),
  mainChannelId: Id,
  features: Features,
  createdAt: IsoDate,
});
export type Me = z.infer<typeof Me>;

/** POST /api/session response. The token goes to the Keychain and into Authorization: Bearer. */
export const SignInResponse = z.object({
  token: z.string().min(1),
  user: Me,
});

/** PATCH /api/me request (profile sheet > Notifications, and the name OpenDuet uses). */
export const UpdateMeRequest = z
  .object({
    firstName: z.string().trim().min(1).max(64),
    briefTime: LocalTime,
    weekendsOn: z.boolean(),
  })
  .partial()
  .strict();

/** GET /api/onboarding: page 2's chips from the user's real setup. */
export const OnboardingChip = z.object({
  kind: z.enum(["app", "channel", "skill"]),
  label: z.string(),
  /** Composio toolkit slug for kind "app" (the app picks the logo); never shown as text */
  toolkit: z.string().optional(),
});
export const OnboardingInfo = z.object({
  chips: z.array(OnboardingChip),
  slack: z.object({ connected: z.boolean() }),
});

/** POST /api/onboarding/complete response: the scan runs in the background (see events). */
export const OnboardingCompleteResponse = z.object({
  user: Me,
  scanStarted: z.boolean(),
});
