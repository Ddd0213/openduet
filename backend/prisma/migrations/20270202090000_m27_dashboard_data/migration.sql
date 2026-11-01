-- M27: live dashboard data, kept apart from the page. Additive only: six new columns (four nullable,
-- two INTEGER NOT NULL DEFAULT 0), no backfill: every artifact before M27 has no data and keeps working
-- exactly as before (whole-page refresh), and every existing version row keeps its page.
-- A dashboard's live data: compact JSON object text (at most 64 KB, contract/m27.ts); null = none.
ALTER TABLE "Artifact" ADD COLUMN "data" TEXT;
-- +1 whenever the data changes (update_artifact_data, a build that saves data, a restore).
ALTER TABLE "Artifact" ADD COLUMN "dataVersion" INTEGER NOT NULL DEFAULT 0;
-- When the data last changed; null while it never had any. Writing only the data keeps updatedAt.
ALTER TABLE "Artifact" ADD COLUMN "dataUpdatedAt" DATETIME;

-- The data at that save, so a restore brings back page and data together; null = none.
ALTER TABLE "ArtifactVersion" ADD COLUMN "data" TEXT;
-- reason "data" (new value; reason has no CHECK): how many data updates were merged into the row.
ALTER TABLE "ArtifactVersion" ADD COLUMN "dataUpdates" INTEGER NOT NULL DEFAULT 0;
-- reason "data": the run whose updates the row collects (the merge key; server only).
ALTER TABLE "ArtifactVersion" ADD COLUMN "runId" TEXT;
