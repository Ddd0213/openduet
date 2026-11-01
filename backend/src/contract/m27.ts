// M27 contract A: live dashboard data, kept apart from the page. New leaf shapes only; what M27 adds to
// older shapes (ArtifactSummary.pageUpdatedAt / dataVersion in artifacts.ts, the version reason "data"
// and ArtifactVersion.dataUpdates in m24.ts) is declared next to those shapes and points back here.
//
// Additive, so an app built before M27 keeps working: the new fields have defaults, a data change
// moves the wire's `updatedAt` (the old viewer reloads the page, which carries the new data), and a
// version row with reason "data" reads as an unknown reason ("Changed by OpenDuet"). Only dashboards get
// data; every artifact before M27 has none and behaves exactly as before. Semantics: docs/API.md "## M27".
import { z } from "zod";
import { Id, IsoDate } from "./common.ts";

// ---------------------------------------------------------------- limits

/** The data's size: UTF-8 bytes of its compact JSON text (JSON.stringify without spaces). */
export const MAX_ARTIFACT_DATA_BYTES = 64 * 1024;
/** How deep a value may sit below the top-level object: in {"a": {"b": [1]}} the 1 is at depth 3. Deeper is refused. */
export const MAX_ARTIFACT_DATA_DEPTH = 8;
/** An object key: 1-200 characters, never one of FORBIDDEN_DATA_KEYS. */
export const MAX_ARTIFACT_DATA_KEY = 200;
/** Keys refused anywhere in the data and in a path (no prototype games in the page or the server). */
export const FORBIDDEN_DATA_KEYS = ["__proto__", "prototype", "constructor"] as const;
/** At most this many ops in one update_artifact_data call (they apply in order, all or nothing). */
export const MAX_DATA_OPS = 50;
/** A path has 1-MAX_DATA_PATH segments (object keys or array indexes). */
export const MAX_DATA_PATH = MAX_ARTIFACT_DATA_DEPTH;
/** `append`'s `max`: the array keeps at most this many items, the oldest dropped first. */
export const MAX_DATA_APPEND_KEEP = 1000;
/** Saved updates per artifact per minute; one more is refused with too_frequent (no-op updates don't count). */
export const DATA_UPDATES_PER_MINUTE = 20;
/** update_artifact_data saves of one run within this window of its row's first save merge into one version. */
export const DATA_VERSION_MERGE_MS = 10 * 60_000;
/** Of MAX_ARTIFACT_VERSIONS (10), at most this many rows are data updates (reason "data"). */
export const MAX_DATA_VERSIONS = 4;

// ---------------------------------------------------------------- how the page reads it

/**
 * The served page (GET /api/artifacts/:id/html, the viewer, the thumbnails) carries the data in
 * `<script type="application/json" id="duet-data" data-version="<dataVersion>">` (the JSON with "<"
 * written as \u003c) right after the base's head blocks, then a small base runtime that defines
 * `window.duetData` (the parsed object) and `window.duetOnData(fn)` (fn(data) now and after every
 * update). Only a dashboard with data gets either; the stored page itself never holds them.
 */
export const DATA_ELEMENT_ID = "duet-data";
/** The data element's attribute holding the dataVersion its JSON is. */
export const DATA_VERSION_ATTR = "data-version";
/**
 * The DOM event the app fires on `document` after it put newer JSON into the data element. The page
 * runtime then re-reads the element (it never trusts the event's detail) and calls every duetOnData fn.
 */
export const DATA_EVENT = "duet:data";

// ---------------------------------------------------------------- the data

const FORBIDDEN: ReadonlySet<string> = new Set(FORBIDDEN_DATA_KEYS);

/** Why `value` can't be an artifact's data (said to the model), or null when it can. */
export function artifactDataProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "The data must be a JSON object ({...}).";
  const walk = (node: unknown, depth: number, at: string): string | null => {
    if (depth > MAX_ARTIFACT_DATA_DEPTH) return `${at}: nested deeper than ${MAX_ARTIFACT_DATA_DEPTH} levels.`;
    if (node === null || typeof node === "boolean" || typeof node === "string") return null;
    if (typeof node === "number") return Number.isFinite(node) ? null : `${at}: numbers must be finite.`;
    if (typeof node !== "object") return `${at}: only JSON values (objects, arrays, strings, numbers, true / false, null).`;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const problem = walk(node[i], depth + 1, `${at}[${i}]`);
        if (problem) return problem;
      }
      return null;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!key.length || key.length > MAX_ARTIFACT_DATA_KEY) return `${at}: keys are 1-${MAX_ARTIFACT_DATA_KEY} characters.`;
      if (FORBIDDEN.has(key)) return `${at}: the key "${key}" isn't allowed.`;
      const problem = walk(child, depth + 1, at === "data" ? key : `${at}.${key}`);
      if (problem) return problem;
    }
    return null;
  };
  const problem = walk(value, 0, "data");
  if (problem) return problem;
  const bytes = artifactDataBytes(value);
  return bytes > MAX_ARTIFACT_DATA_BYTES ? `The data is ${bytes} bytes; at most ${MAX_ARTIFACT_DATA_BYTES}. Keep only what the page shows.` : null;
}

/** UTF-8 bytes of the data's compact JSON text (what is stored and what counts against the limit). */
export function artifactDataBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * A dashboard's data: a JSON object, at most MAX_ARTIFACT_DATA_BYTES as compact JSON, nested at most
 * MAX_ARTIFACT_DATA_DEPTH levels, keys 1-200 characters and never __proto__ / prototype / constructor,
 * finite numbers. Refused, not trimmed. Stored as compact JSON text with its keys in the order given;
 * the page must not depend on key order (use arrays for anything ordered).
 * Built on z.unknown() on purpose: z.record / z.object copy keys and silently drop "__proto__".
 */
export const ArtifactData = z.unknown()
  .superRefine((value, ctx) => {
    const problem = artifactDataProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .meta({ type: "object", description: "A JSON object with every number, row and label the page shows." } as Record<string, unknown>);
export type ArtifactData = Record<string, unknown>;

// ---------------------------------------------------------------- update_artifact_data (model-facing)

/** One step of a path: an object key (1-200 characters, not a forbidden key) or an array index (0+). */
export const DataPathSegment = z.union([
  z.string().min(1).max(MAX_ARTIFACT_DATA_KEY).refine((key) => !FORBIDDEN.has(key), { message: "this key isn't allowed" }),
  z.number().int().min(0).max(1_000_000),
]);
/** Where in the data, from the top: ["counts", "total"], ["items", 0, "title"]. */
export const DataPath = z.array(DataPathSegment).min(1).max(MAX_DATA_PATH);
export type DataPath = z.infer<typeof DataPath>;

/**
 * The ops, applied in order to a copy of the stored data; any op that can't apply refuses the whole
 * call (invalid_op, nothing saved). A missing object on the way is created for `set`, `increment` and
 * `append` (never an array: an index must already exist).
 *  - set: put `value` (any JSON) at `path`;
 *  - increment: add `by` (default 1, may be negative) to the number at `path` (missing = 0);
 *  - append: add `value` at the end of the array at `path` (missing = []); `max` keeps the newest `max` items;
 *  - remove: delete the key or array item at `path` (missing = nothing to do).
 */
export const DataOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: DataPath, value: z.unknown().refine((v) => v !== undefined, { message: "value is required" }) }).strict(),
  z.object({ op: z.literal("increment"), path: DataPath, by: z.number().finite().default(1) }).strict(),
  z.object({
    op: z.literal("append"), path: DataPath, value: z.unknown().refine((v) => v !== undefined, { message: "value is required" }),
    max: z.number().int().min(1).max(MAX_DATA_APPEND_KEEP).nullable().default(null),
  }).strict(),
  z.object({ op: z.literal("remove"), path: DataPath }).strict(),
]);
export type DataOp = z.infer<typeof DataOp>;

/** The chat card's headline numbers (as finish_build's metrics): 2-4, replacing the card's. */
export const DataMetric = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.number().finite(),
  unit: z.string().trim().max(20).nullable().default(null),
}).strict();

/**
 * update_artifact_data's arguments (chat, task and routine turns; never a build or a proactive turn).
 * Exactly one of `ops` (path changes) or `data` (the whole object, replacing it). `expectedVersion`:
 * the dataVersion the call was written against (read_artifact or the last result); another value is
 * refused with version_conflict. `metrics`: the chat card's numbers after this change.
 */
export const UpdateArtifactDataInput = z.object({
  artifactId: Id,
  ops: z.array(DataOp).min(1).max(MAX_DATA_OPS).nullable().default(null),
  data: ArtifactData.nullable().default(null),
  expectedVersion: z.number().int().min(0).nullable().default(null),
  metrics: z.array(DataMetric).min(2).max(4).nullable().default(null),
}).strict().superRefine((input, ctx) => {
  if ((input.ops === null) === (input.data === null)) ctx.addIssue({ code: "custom", path: ["ops"], message: "pass either ops or data, not both" });
});
export type UpdateArtifactDataInput = z.infer<typeof UpdateArtifactDataInput>;

/** Why update_artifact_data saved nothing (the tool result's `code`; isError: true). */
export const DataRefusalCode = z.enum([
  /** no artifact with that id for this user */
  "not_found",
  /** not a dashboard: only dashboards have live data (edit_artifact / refresh_artifact for the rest) */
  "not_dashboard",
  /** a dashboard built before M27 or without data: the page doesn't read data (edit_artifact turns it into one) */
  "no_data",
  /** the first build hasn't saved a page yet (or failed): try again once its card is in the thread */
  "not_ready",
  /** expectedVersion isn't the current dataVersion: read_artifact again and redo the change */
  "version_conflict",
  /** the result would be over MAX_ARTIFACT_DATA_BYTES */
  "too_large",
  /** the result isn't valid data (too deep, a forbidden key, a non-finite number), or `data` isn't */
  "invalid_data",
  /** an op can't apply (an index past the end, increment on a non-number, append on a non-array, a path through a value) */
  "invalid_op",
  /** more than DATA_UPDATES_PER_MINUTE saved updates of this artifact in the last minute */
  "too_frequent",
]);
export type DataRefusalCode = z.infer<typeof DataRefusalCode>;

/**
 * update_artifact_data's result. Saved: `updated` (dataVersion +1, the event went out) or `unchanged`
 * (the ops left the data as it was: nothing saved, no event, dataVersion as before). Refused: `error`
 * (for the model) and `code`; `dataVersion` is the current one when known (version_conflict always).
 */
export const UpdateArtifactDataResult = z.union([
  z.object({
    status: z.enum(["updated", "unchanged"]),
    artifactId: Id,
    title: z.string(),
    dataVersion: z.number().int().min(0),
    /** the stored data's size (UTF-8 bytes of its compact JSON) */
    bytes: z.number().int().min(0).max(MAX_ARTIFACT_DATA_BYTES),
    note: z.string(),
  }).strict(),
  z.object({
    error: z.string().min(1),
    code: DataRefusalCode,
    dataVersion: z.number().int().min(0).nullable().default(null),
    /** too_frequent: when the next update can be saved */
    retryAfterMs: z.number().int().min(0).nullable().default(null),
  }).strict(),
]);
export type UpdateArtifactDataResult = z.infer<typeof UpdateArtifactDataResult>;

// ---------------------------------------------------------------- the app's fetch

/**
 * GET /api/artifacts/:id/data: the data as it is now, for an open viewer whose `artifact` event says a
 * newer dataVersion. `json` is the exact compact JSON text the page carries (no re-encoding, so key
 * order and numbers never change on the way); null when the artifact has no data. Not "opened" (no
 * lastOpenedAt), like /html. 404 for another user's artifact.
 */
export const ArtifactDataResponse = z.object({
  artifactId: Id,
  dataVersion: z.number().int().min(0),
  dataUpdatedAt: IsoDate.nullable(),
  json: z.string().max(MAX_ARTIFACT_DATA_BYTES).nullable()
    .refine((text) => text === null || (() => { try { return artifactDataProblem(JSON.parse(text)) === null; } catch { return false; } })(), { message: "json must be the text of valid artifact data" }),
});
export type ArtifactDataResponse = z.infer<typeof ArtifactDataResponse>;
