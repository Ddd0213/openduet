// M11: the channel system. The soul (one per user, plus a per-channel addendum), two memory layers
// ("About you", shared; one private memory per channel), Agent Skills folders with imports, custom
// connectors (MCP servers and domain-bound API keys, secrets in the server's vault) and which
// skills / connectors / apps each channel can use. Semantics: .pi/handoff/m11-contract.md.
import { z } from "zod";
import { AppName, Id, IsoDate } from "./common.ts";
import { PolicyMode } from "./connectors.ts";
import { AlwaysBlocked } from "./m20.ts";
import { SourceRef } from "./m23.ts";

// ---------------------------------------------------------------- soul

/**
 * GET /api/soul, PUT /api/soul (Everything). Who OpenDuet is for this user. `name` is what OpenDuet
 * calls itself in replies; the app keeps showing "OpenDuet". Empty strings mean the defaults.
 */
export const Soul = z.object({
  /** what OpenDuet calls itself in its replies (empty = OpenDuet) */
  name: z.string().max(40),
  /** how OpenDuet addresses the user (empty = their first name) */
  addressAs: z.string().max(80),
  /** who OpenDuet is for this user, in their words */
  identity: z.string().max(2000),
  /** character and habits */
  persona: z.string().max(4000),
  /** tone of voice */
  tone: z.string().max(1000),
  updatedAt: IsoDate.nullable(),
});
export const UpdateSoulRequest = Soul.omit({ updatedAt: true }).partial().strict();

// ---------------------------------------------------------------- memory

export const MemorySource = z.enum(["user", "assistant", "dreaming"]);
/** One saved fact. `sourceMessageId`: the message it came from (null when typed by the user). */
export const MemoryFact = z.object({
  id: Id,
  text: z.string(),
  source: MemorySource.default("assistant"),
  sourceMessageId: Id.nullable().default(null),
  /** M23 (m23.ts SourceRef): where a fact saved in the background was read (an email, an event); null otherwise */
  sourceRef: SourceRef.nullable().default(null),
  createdAt: IsoDate,
});
/** GET /api/channels/:id/memory, PUT /api/channels/:id/memory { document }: the channel's own memory. */
export const ChannelMemoryState = z.object({
  channelId: Id,
  /** whether this channel also reads "About you" (Channel.useSharedMemory) */
  useSharedMemory: z.boolean(),
  document: z.string(),
  facts: z.array(MemoryFact),
  updatedAt: IsoDate.nullable(),
});
/**
 * POST /api/memory/facts -> { fact }: the user adds a fact. channelId null = "About you".
 * PATCH /api/memory/facts/:id { text } -> { fact }; DELETE /api/memory/facts/:id -> 204 (archived).
 */
export const CreateMemoryFactRequest = z.object({ channelId: Id.nullable(), text: z.string().trim().min(1).max(2000) }).strict();
export const UpdateMemoryFactRequest = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
export const MemoryFactResponse = z.object({ fact: MemoryFact });
/**
 * GET /api/memory/overview (Everything): the shared layer is GET /api/memory; this lists every
 * channel's purpose and how it's going, never the channel's private memory text.
 */
export const MemoryOverview = z.object({
  channels: z.array(z.object({
    channelId: Id,
    name: z.string(),
    purpose: z.string(),
    useSharedMemory: z.boolean(),
    factCount: z.number().int().nonnegative(),
    lastMessageAt: IsoDate.nullable(),
    /** the first 160 characters of OpenDuet's latest text message there, markdown stripped */
    recent: z.string().nullable(),
  })),
});

// ---------------------------------------------------------------- access (skills, connectors, apps per channel)

/**
 * What a channel can use. `skill` = Skill.id, `connector` = CustomConnector.id, `app` = a Composio
 * toolkit slug. The main thread (Everything) can always use everything.
 */
export const AccessKind = z.enum(["skill", "connector", "app"]);
export const AccessRef = z.object({ kind: AccessKind, id: z.string().min(1).max(128) }).strict();
/** all = every channel unless a channel turns it off; channels = only where turned on. */
export const AccessScope = z.enum(["all", "channels"]);
/** GET /api/channels/:id/access: everything this user has, resolved for the channel. */
export const ChannelAccess = z.object({
  channelId: Id,
  items: z.array(z.object({
    kind: AccessKind,
    id: z.string(),
    name: z.string(),
    description: z.string(),
    /** the item's own default */
    scope: AccessScope,
    /** usable in this channel right now */
    enabled: z.boolean(),
  })),
});
/** PUT /api/channels/:id/access: turn items on or off for this channel -> ChannelAccess. 400 on the main thread. */
export const UpdateChannelAccessRequest = z.object({
  changes: z.array(AccessRef.extend({ enabled: z.boolean() }).strict()).min(1).max(100),
}).strict();
/** PUT /api/access/scope { ref, scope }: an item's default ("Share with all channels" = all) -> 204. */
export const UpdateAccessScopeRequest = z.object({ ref: AccessRef, scope: AccessScope }).strict();

// ---------------------------------------------------------------- skills (Agent Skills folders)

/**
 * M25: "upload" = from Add skill › Upload a skill (a .zip, a .skill or a single SKILL.md, POST
 * /api/skills/upload/preview; m25.ts). Skills imported from a zip before M25 keep "zip".
 */
export const SkillSource = z.enum(["manual", "github", "zip", "assistant", "upload"]);
/** A file in the skill folder other than SKILL.md: scripts/, references/, assets/. */
export const SkillFileInfo = z.object({
  path: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  /** false for binary files (they can't be shown or edited in the app) */
  text: z.boolean(),
});
/** GET /api/skills/:id/files/*path -> SkillFileContent (text files only; binary 400). */
export const SkillFileContent = z.object({ path: z.string(), text: z.string() });
/** Skill text file written in the app or by OpenDuet. `text: null` deletes it (PATCH only). */
export const SkillFileWrite = z.object({ path: z.string().min(1).max(200), text: z.string().max(200_000).nullable() }).strict();

/**
 * GET /api/skills/github/preview?url= and POST /api/skills/zip/preview (multipart "file"). Nothing is saved.
 * M25: POST /api/skills/upload/preview (multipart "file": .zip, .skill or SKILL.md) answers source "upload".
 */
export const SkillImportPreview = z.object({
  /** pass back to POST /api/skills/import; valid for 15 minutes */
  importId: Id,
  source: z.enum(["github", "zip", "upload"]),
  sourceUrl: z.string().nullable(),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    /** the start of SKILL.md's body, for the summary */
    excerpt: z.string(),
    files: z.array(SkillFileInfo),
    /** has scripts/: they run on OpenDuet's computer, and the first run asks the user */
    hasScripts: z.boolean(),
    /** a skill with this name exists: importing replaces it */
    exists: z.boolean(),
  })).min(1),
  /** what was skipped and why ("No SKILL.md in docs/", "Too large") */
  warnings: z.array(z.string()),
});
/** POST /api/skills/import -> SkillList (the imported skills). */
export const SkillImportRequest = z.object({
  importId: Id,
  names: z.array(z.string().min(1).max(64)).min(1).max(50),
  /** where it was imported: null = Everything (scope all); a channel = only that channel (scope channels) */
  channelId: Id.nullable(),
}).strict();

// ---------------------------------------------------------------- custom connectors and the vault

/** A secret held by the server's vault: never sent back, only whether it's set and its last 4 characters. */
export const SecretInfo = z.object({ set: z.boolean(), last4: z.string().max(4).nullable() });
/** An MCP request header. Secret values live in the vault; plain ones are returned as they are. */
export const ConnectorHeader = z.object({
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  secret: z.boolean(),
  /** plain headers only; null for secret ones */
  value: z.string().max(2000).nullable(),
  /** secret headers only */
  secretInfo: SecretInfo.nullable(),
});
/**
 * M17: a remote MCP server's OAuth sign-in (null when the server doesn't use one). Tokens never
 * leave the server; this says only whether they're there. `needsSignIn`: the app shows "Sign in".
 */
export const ConnectorOAuthState = z.object({
  signedIn: z.boolean(),
  needsSignIn: z.boolean(),
  /** when the access token runs out (the server renews it on its own); null = unknown / signed out */
  expiresAt: IsoDate.nullable(),
});
export const CustomConnectorTool = z.object({
  /** the server's tool name, also the ToolPolicy key "<connectorId>:<name>" */
  name: z.string(),
  description: z.string(),
  access: z.enum(["read", "write"]),
  mode: PolicyMode,
  /** M20: as ConnectorTool (the safety floor, or Always per recipient on the approval card) */
  alwaysAllowed: z.boolean().default(true),
  alwaysBlocked: AlwaysBlocked.nullable().default(null),
});
export const CustomConnector = z.object({
  id: Id,
  kind: z.enum(["mcp", "api_key"]),
  name: AppName,
  description: z.string(),
  /** mcp: the server URL (https) */
  url: z.string().nullable(),
  /** api_key: the domain the key is bound to (it's sent only to this host and its subdomains) */
  domain: z.string().nullable(),
  /** api_key: the header the key goes in ("Authorization", "X-Api-Key") and an optional value prefix ("Bearer ") */
  headerName: z.string().nullable(),
  valuePrefix: z.string().nullable(),
  /** api_key: the key */
  secret: SecretInfo.nullable(),
  /** mcp: request headers */
  headers: z.array(ConnectorHeader),
  status: z.enum(["active", "failed"]),
  /** the last check's failure, in plain words */
  error: z.string().nullable(),
  /** mcp: the tools the server lists (refreshed on create, test and every 24 h) */
  tools: z.array(CustomConnectorTool),
  scope: AccessScope,
  /** scope channels: where it's turned on */
  channelIds: z.array(Id),
  createdAt: IsoDate,
  /** M17: the MCP Registry name it was installed from (a template); null when added by hand. Optional for older samples. */
  registryName: z.string().nullable().optional(),
  /** M17: the OAuth sign-in, null when the server doesn't use one. `status` stays active | failed (a connector waiting for sign-in is failed with an error). */
  oauth: ConnectorOAuthState.nullable().optional(),
});
/** GET /api/custom-connectors */
export const CustomConnectorList = z.object({ connectors: z.array(CustomConnector) });
/** POST /api/custom-connectors (Everything, "Add connector"); verified before it's saved (400 with the reason). */
export const CreateCustomConnectorRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mcp"),
    name: AppName,
    description: z.string().max(500).default(""),
    url: z.string().max(2000),
    headers: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: z.string().min(1).max(4000), secret: z.boolean() }).strict()).max(10).default([]),
    /**
     * M17: true = a server that asks for OAuth sign-in (401 without user credentials, or protected
     * resource metadata) is saved needing sign-in instead of failing (then POST .../oauth/start).
     */
    allowSignIn: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("api_key"),
    name: AppName,
    description: z.string().max(500).default(""),
    domain: z.string().max(253),
    headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"),
    valuePrefix: z.string().max(20).default("Bearer "),
    key: z.string().min(1).max(4000),
  }).strict(),
]);
/**
 * PATCH /api/custom-connectors/:id: rename, describe, replace a key or headers (a header with
 * value null keeps its stored value). Verified again when anything but name / description changed.
 */
export const UpdateCustomConnectorRequest = z.object({
  name: AppName,
  description: z.string().max(500),
  url: z.string().max(2000),
  domain: z.string().max(253),
  headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  valuePrefix: z.string().max(20),
  key: z.string().min(1).max(4000),
  headers: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: z.string().min(1).max(4000).nullable(), secret: z.boolean() }).strict()).max(10),
}).partial().strict();
/** POST /api/custom-connectors/:id/test -> CustomConnectorResponse (status / error / tools refreshed). DELETE -> 204. */
export const CustomConnectorResponse = z.object({ connector: CustomConnector });
/** PUT /api/custom-connectors/:id/policy (like the apps' UpdatePolicyRequest; tool null = all its tools). */

/** POST /api/messages/:id/connect: the user's answer to a connection_request card (values go to the vault). */
export const ConnectRequestSubmit = z.object({
  /** edited prefill; omitted = the card's */
  name: AppName.optional(),
  url: z.string().max(2000).optional(),
  domain: z.string().max(253).optional(),
  /** the card's field key -> what the user typed */
  values: z.record(z.string().min(1).max(64), z.string().max(4000)),
}).strict();
