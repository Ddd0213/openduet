-- M24: artifact versions and "last opened". Additive only: one nullable column, one new table and its
-- index, two backfills (no existing value changes).
-- When the user last opened the artifact (gallery sort "Last opened"; null = "Just made", never opened).
ALTER TABLE "Artifact" ADD COLUMN "lastOpenedAt" DATETIME;

-- One saved state of an artifact's page per save (build, edit, refresh, restore); the newest row is
-- the page as it is now. At most 10 per artifact; deleted with the artifact.
CREATE TABLE "ArtifactVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "sources" TEXT NOT NULL DEFAULT '[]',
    "metrics" TEXT,
    "by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "prompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");

-- Pages made before M24 count as opened when they last changed (no "Just made" on all of them at once).
UPDATE "Artifact" SET "lastOpenedAt" = "updatedAt" WHERE "html" <> '' AND "lastOpenedAt" IS NULL;
-- Each existing page becomes its first version, so the first edit after M24 can be undone.
INSERT INTO "ArtifactVersion" ("id", "artifactId", "html", "sources", "metrics", "by", "reason", "prompt", "createdAt")
SELECT 'av' || lower(hex(randomblob(12))), "id", "html", "sources", NULL,
       CASE WHEN "startedBy" = 'claude' THEN 'claude' ELSE 'user' END, 'create', NULLIF("prompt", ''), "updatedAt"
FROM "Artifact" WHERE "html" <> '';
