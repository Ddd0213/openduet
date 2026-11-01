-- M29: rename the assistant protocol value. Scalar rows are backfilled; JSON payloads and
-- replay events are normalized at read time so user text and display labels remain unchanged.
-- The Memory table is rebuilt because SQLite cannot alter a column default in place.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Memory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "channelId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'assistant',
    "sourceMessageId" TEXT,
    "archivedAt" DATETIME,
    "dueAt" DATETIME,
    "sourceRef" TEXT,
    CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Memory" ("archivedAt", "channelId", "createdAt", "dueAt", "id", "kind", "source", "sourceMessageId", "sourceRef", "text", "updatedAt", "userId") SELECT "archivedAt", "channelId", "createdAt", "dueAt", "id", "kind", "source", "sourceMessageId", "sourceRef", "text", "updatedAt", "userId" FROM "Memory";
DROP TABLE "Memory";
ALTER TABLE "new_Memory" RENAME TO "Memory";
CREATE INDEX "Memory_userId_kind_idx" ON "Memory"("userId", "kind");
CREATE INDEX "Memory_userId_channelId_archivedAt_idx" ON "Memory"("userId", "channelId", "archivedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

UPDATE "Message" SET "role" = 'assistant' WHERE "role" = 'claude';
UPDATE "Memory" SET "source" = 'assistant' WHERE "source" = 'claude';
UPDATE "Artifact" SET "startedBy" = 'assistant' WHERE "startedBy" = 'claude';
UPDATE "ArtifactVersion" SET "by" = 'assistant' WHERE "by" = 'claude';
UPDATE "Reaction" SET "by" = 'assistant' WHERE "by" = 'claude';
UPDATE "ChannelFile" SET "source" = 'assistant' WHERE "source" = 'claude';
UPDATE "AuditLog" SET "actor" = 'assistant' WHERE "actor" = 'claude';
UPDATE "Skill" SET "source" = 'assistant' WHERE "source" = 'claude';
