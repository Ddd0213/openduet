// M24: Make quality. New leaf shapes only; the fields M24 adds to older shapes (ArtifactSummary
// .lastOpenedAt, the checklist item's id, the line_chart block, the check / uncheck actions) are
// declared next to those shapes and point back here.
//
// Additive, so an app built before M24 keeps decoding: every new field is nullable with a null
// default, and a line_chart block reads as CardBlock.unsupported (skipped). Semantics: docs/API.md
// "## M24".
import { z } from "zod";
import { Id, IsoDate } from "./common.ts";

/** Versions kept per artifact; saving an 11th deletes the oldest. */
export const MAX_ARTIFACT_VERSIONS = 10;

/** Who caused a save: the user in the app (Create, ✎, ↻, Retry, restore) or OpenDuet (chat, task, schedule). */
export const ArtifactVersionBy = z.enum(["user", "assistant"]);
export type ArtifactVersionBy = z.infer<typeof ArtifactVersionBy>;

/**
 * What the save was: the first build (or a Retry of it), an edit, a refresh, a restore. M27: "data" =
 * update_artifact_data saves (one run's within 10 minutes merged into one row; m27.ts); the page is the
 * same as the row before it. An app built before M27 reads "data" as an unknown reason.
 */
export const ArtifactVersionReason = z.enum(["create", "edit", "refresh", "restore", "data"]);
export type ArtifactVersionReason = z.infer<typeof ArtifactVersionReason>;

/**
 * One saved state of an artifact's page, as listed (the page itself never comes in the list). Every
 * save writes one; the newest is the page as it is now. Restoring an older one saves it again as the
 * newest (reason "restore"), so a restore can be undone like any other change.
 */
export const ArtifactVersion = z.object({
  id: Id,
  artifactId: Id,
  by: ArtifactVersionBy,
  reason: ArtifactVersionReason,
  /** create: the artifact's request; edit: the change asked for (several queued edits: joined); null otherwise */
  prompt: z.string().max(8000).nullable(),
  /** M27 reason "data": when the first merged update was saved; the row holds the state after the last one */
  createdAt: IsoDate,
  /** M27: reason "data": how many data updates this row holds (1+, merged); 0 for every other reason */
  dataUpdates: z.number().int().nonnegative().default(0),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

/** GET /api/artifacts/:id/versions: newest first, at most MAX_ARTIFACT_VERSIONS; empty before the first page is saved. */
export const ArtifactVersionList = z.object({ versions: z.array(ArtifactVersion).max(MAX_ARTIFACT_VERSIONS) });
export type ArtifactVersionList = z.infer<typeof ArtifactVersionList>;

/** POST /api/artifacts/:id/restore -> ArtifactResponse. Undo = restore versions[1]. */
export const RestoreArtifactRequest = z.object({ versionId: Id }).strict();
export type RestoreArtifactRequest = z.infer<typeof RestoreArtifactRequest>;

/**
 * show_card's line chart (messages.ts CardBlock "line_chart"): a trend over 2-24 points with 1-3
 * series sharing the labels. Each series has one value per label; null is a gap (no data that day).
 */
export const LineChartBlock = z
  .object({
    type: z.literal("line_chart"),
    /** the x axis, in order ("Mon", "Oct 21", "W43") */
    labels: z.array(z.string().min(1).max(24)).min(2).max(24),
    series: z.array(z.object({
      /** the legend; with one series the card's title usually says it */
      name: z.string().min(1).max(40),
      values: z.array(z.number().nullable()).min(2).max(24),
    })).min(1).max(3),
    /** shown on the axis and in values ("kg", "$", "steps"); null for plain numbers */
    unit: z.string().max(20).nullable().default(null),
  })
  .superRefine((block, ctx) => {
    block.series.forEach((s, i) => {
      if (s.values.length !== block.labels.length) {
        ctx.addIssue({ code: "custom", path: ["series", i, "values"], message: `needs ${block.labels.length} values, one per label` });
      }
    });
  });
export type LineChartBlock = z.infer<typeof LineChartBlock>;

/** read_artifact: how much of the page's text one call returns (characters; the rest is cut and `truncated` is true). */
export const READ_ARTIFACT_MAX_CHARS = 20_000;
