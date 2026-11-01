// Usage, memory, devices (push) and skills.
import { z } from "zod";
import { Id, IsoDate, Language } from "./common.ts";
import { AccessScope, MemoryFact, SkillFileInfo, SkillFileWrite, SkillSource } from "./m11.ts";

/** GET /api/usage (and the "usage" event). Limits of 0 mean no limit: the bars just show usage. */
export const UsageState = z.object({
  session: z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    /** null until a message starts the 5-hour session ("Starts when a message is sent") */
    resetsAt: IsoDate.nullable(),
  }),
  weekly: z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    resetsAt: IsoDate.nullable(),
  }),
  fullReset: z.object({
    available: z.boolean(),
    /** end of the current month ("Expires Nov 30") */
    expiresAt: IsoDate,
  }),
  limited: z.boolean(),
  /** when limited: when usage resumes */
  resumesAt: IsoDate.nullable(),
});
export type UsageState = z.infer<typeof UsageState>;

/**
 * M9: GET /api/usage/stats?range=today|7d|30d|all: the Usage panel. Counted from Run rows (every
 * run's input + output tokens, the same way for every model); days and hours in the user's
 * timezone. `estimated` is true when any counted run's tokens were estimated.
 */
export const UsageRange = z.enum(["today", "7d", "30d", "all"]);
const TokenCounts = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
});
export const UsageStats = z.object({
  range: UsageRange,
  since: IsoDate.nullable(),
  until: IsoDate,
  totals: TokenCounts,
  estimated: z.boolean(),
  /** most tokens first; `label` from models.json (the id when it has none), provider = its provider id */
  byModel: z.array(TokenCounts.extend({ model: z.string(), label: z.string(), provider: z.string().nullable() })),
  /** chat = chats; task = background tasks; build = Make; proactive = brief, check-ins, scans and routines */
  byKind: z.array(TokenCounts.extend({ kind: z.enum(["chat", "task", "build", "proactive"]) })),
  /** oldest first: hours for today, days for 7d / 30d, months for all */
  bucket: z.enum(["hour", "day", "month"]),
  series: z.array(z.object({ start: IsoDate, inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })),
});
export type UsageStats = z.infer<typeof UsageStats>;

/** GET /api/memory, PUT /api/memory { document } */
export const MemoryState = z.object({
  document: z.string(),
  /** M11: "About you" (the shared layer); facts carry source and sourceMessageId, archived ones are left out */
  facts: z.array(MemoryFact),
  updatedAt: IsoDate.nullable(),
});
export const UpdateMemoryRequest = z.object({ document: z.string().max(100_000) }).strict();

/** POST /api/devices: register this iPhone for remote push (APNs token). */
export const RegisterDeviceRequest = z
  .object({
    provider: z.literal("apns"),
    token: z.string().regex(/^[0-9a-f]{64,200}$/i),
    environment: z.enum(["production", "sandbox"]),
    locale: Language,
  })
  .strict();
export const RegisterDeviceResponse = z.object({ deviceId: Id });

/**
 * A skill: an Agent Skills folder. `instructions` is SKILL.md's body (its frontmatter is name and
 * description); `files` are the folder's other files. M11 adds where it came from and where it's on.
 */
export const Skill = z.object({
  id: Id,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string(),
  instructions: z.string(),
  createdAt: IsoDate,
  source: SkillSource.default("manual"),
  /** github: the repository or folder URL it was imported from */
  sourceUrl: z.string().nullable().default(null),
  files: z.array(SkillFileInfo).default([]),
  scope: AccessScope.default("all"),
  /** scope channels: where it's turned on */
  channelIds: z.array(Id).default([]),
});
/** GET /api/skills */
export const SkillList = z.object({ skills: z.array(Skill) });
/**
 * POST /api/skills (write one by hand) -> Skill. `channelId`: where it was written (null =
 * Everything, scope all; a channel = only there). M11: text files go with it.
 */
export const CreateSkillRequest = Skill.pick({ name: true, description: true, instructions: true }).extend({
  files: z.array(SkillFileWrite.extend({ text: z.string().max(200_000) })).max(50).optional(),
  channelId: Id.nullable().optional(),
}).strict();
/** M11: PATCH /api/skills/:id -> Skill (a file with text null is deleted). GET /api/skills/:id/export -> the folder as a zip. */
export const UpdateSkillRequest = z.object({
  description: z.string().trim().max(1024),
  instructions: z.string().trim().min(1).max(100_000),
  files: z.array(SkillFileWrite).max(50),
}).partial().strict();
