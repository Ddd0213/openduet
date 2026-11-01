-- M21: reliability. Additive only.
-- Who started an artifact's first build (user | claude): Retry rebuilds it with the same trust.
ALTER TABLE "Artifact" ADD COLUMN "startedBy" TEXT NOT NULL DEFAULT 'user';
-- The task status the last "needs you" push was sent for: a restart doesn't push it again.
ALTER TABLE "Task" ADD COLUMN "lastNotifiedStatus" TEXT;
