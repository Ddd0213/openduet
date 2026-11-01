// M25: skills and built-in capabilities. New leaf shapes only; what M25 adds to older shapes
// (SkillSource "upload" in m11.ts) is declared next to those shapes and points back here.
//
// Additive, so an app built before M25 keeps decoding: an "upload" skill reads as "Written by you"
// there (its source decodes tolerantly), and it never calls the new routes. Semantics: docs/API.md
// "## M25".
import { z } from "zod";
import { Skill } from "./account.ts";
import { IsoDate } from "./common.ts";

// ---------------------------------------------------------------- uploads (POST /api/skills/upload/preview)

/** A .zip or .skill upload (a .skill is a zip, as skill-creator packs it): the same cap as the zip import. */
export const SKILL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** A single SKILL.md upload (plain UTF-8 text with frontmatter): the per-file cap of a skill folder. */
export const SKILL_MD_UPLOAD_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- built-in skills (server only)

/**
 * The built-in skill that guides "Create a skill in the chat": always in the chat turns' built-in
 * index. The other built-ins are listed in backend/skills-builtin/manifest.json.
 */
export const SKILL_CREATOR = "skill-creator";

/**
 * The turns a built-in skill is listed in. chat = the main thread and channels; task = a task's own
 * session and its routine runs; build = a Make build. Briefs, check-ins and scans list none.
 */
export const BuiltinSkillTurn = z.enum(["chat", "task", "build"]);
export type BuiltinSkillTurn = z.infer<typeof BuiltinSkillTurn>;

/** An index line's description (our own short text, not the skill's frontmatter): characters. */
export const BUILTIN_INDEX_MAX_CHARS = 160;

/**
 * One entry of backend/skills-builtin/manifest.json. The folder `backend/skills-builtin/<name>/`
 * holds SKILL.md and its other files, the upstream LICENSE / NOTICE as they are, and CHANGES.md
 * when we changed anything. Read at startup; never in the Skill table, never sent by the API.
 */
export const BuiltinSkillEntry = z.object({
  /** the folder name and the name use_skill takes (Skill.name rules) */
  name: Skill.shape.name,
  /** the index line OpenDuet sees: when to load it, in our own words */
  index: z.string().trim().min(1).max(BUILTIN_INDEX_MAX_CHARS),
  turns: z.array(BuiltinSkillTurn).min(1),
  /** listed only when OpenDuet's computer is set up for the user (it runs programs there) */
  needsComputer: z.boolean().default(false),
  /** where it came from; null = written for OpenDuet */
  upstream: z.object({
    /** https://github.com/<owner>/<repo> */
    repo: z.url({ protocol: /^https$/ }),
    /** the commit it was copied from (40 hex characters) */
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** the folder or file in that repository */
    path: z.string().min(1).max(300),
    license: z.enum(["Apache-2.0", "MIT"]),
  }).strict().nullable(),
  /** what we changed, one line each (Apache-2.0 section 4); empty when copied as it is */
  changes: z.array(z.string().min(1).max(300)).max(30),
}).strict();
export type BuiltinSkillEntry = z.infer<typeof BuiltinSkillEntry>;

/** backend/skills-builtin/manifest.json: names are unique. */
export const BuiltinSkillManifest = z.object({
  skills: z.array(BuiltinSkillEntry).min(1),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  manifest.skills.forEach((skill, i) => {
    if (seen.has(skill.name)) ctx.addIssue({ code: "custom", path: ["skills", i, "name"], message: `${skill.name} is listed twice` });
    seen.add(skill.name);
  });
});
export type BuiltinSkillManifest = z.infer<typeof BuiltinSkillManifest>;

// ---------------------------------------------------------------- built-in connectors (GET /api/builtin-connectors)

/**
 * The key-less read-only tools every user has without setting anything up. The id is also the
 * tool's name. Listed in this order; an app skips an id it doesn't know.
 */
export const BuiltinConnectorId = z.enum(["web_search", "weather", "exchange_rate", "read_feed"]);
export type BuiltinConnectorId = z.infer<typeof BuiltinConnectorId>;

/**
 * on = offered to OpenDuet; off = turned off on this server (backend/.env); unreachable = offered, but
 * its last call couldn't reach the service (it answers that honestly until a call works again).
 */
export const BuiltinConnectorState = z.enum(["on", "off", "unreachable"]);
export type BuiltinConnectorState = z.infer<typeof BuiltinConnectorState>;

export const BuiltinConnector = z.object({
  id: BuiltinConnectorId,
  state: BuiltinConnectorState,
  /**
   * who answers, in the order tried: ["Exa", "Parallel"], ["Tavily"], ["Open-Meteo"],
   * ["Frankfurter"]; [] for read_feed (it reads the feed's own site) and while off
   */
  providers: z.array(z.string().min(1).max(40)).max(4),
  /** true = no key or account (the free tier / a public service); false = the server's own key */
  keyless: z.boolean(),
  /** when a call last reached (or failed to reach) the service; null = not called since the server started */
  checkedAt: IsoDate.nullable(),
});
export type BuiltinConnector = z.infer<typeof BuiltinConnector>;

/** GET /api/builtin-connectors: every built-in, in BuiltinConnectorId order, off ones included. */
export const BuiltinConnectorList = z.object({ connectors: z.array(BuiltinConnector) });
export type BuiltinConnectorList = z.infer<typeof BuiltinConnectorList>;

// ---------------------------------------------------------------- the built-in tools' limits (model-facing)

/** weather: forecast days per call (default 3). */
export const WEATHER_MAX_DAYS = 7;
/** exchange_rate: quote currencies per call. */
export const EXCHANGE_RATE_MAX_QUOTES = 10;
/** read_feed: items per call (default 10), and each item's summary in characters. */
export const READ_FEED_MAX_ITEMS = 20;
export const READ_FEED_SUMMARY_MAX_CHARS = 300;

// ---------------------------------------------------------------- region (X-Region)

/**
 * X-Region: the iPhone's region, ISO 3166-1 alpha-2 ("US", "CN"); kept in User.region (server only).
 * It picks the weather's default unit and biases its place lookup. Anything else (a UN M.49
 * number like "001", an empty header) is ignored.
 */
export const RegionCode = z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());
/** Regions that use Fahrenheit day to day (the US and its territories, and a few others); everywhere else Celsius. */
export const FAHRENHEIT_REGIONS: readonly string[] = ["US", "PR", "GU", "VI", "AS", "MP", "UM", "BS", "BZ", "KY", "PW", "FM", "MH", "LR"];
