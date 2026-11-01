-- AlterTable
ALTER TABLE "Task" ADD COLUMN "spawnMessageId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toolSlug" TEXT NOT NULL,
    "arguments" TEXT NOT NULL DEFAULT '{}',
    "preview" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" DATETIME,
    "result" TEXT,
    "changedFields" TEXT NOT NULL DEFAULT '[]',
    "taskId" TEXT,
    "messageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Approval" ("arguments", "createdAt", "expiresAt", "id", "kind", "messageId", "preview", "result", "status", "taskId", "toolSlug", "updatedAt", "userId", "version") SELECT "arguments", "createdAt", "expiresAt", "id", "kind", "messageId", "preview", "result", "status", "taskId", "toolSlug", "updatedAt", "userId", "version" FROM "Approval";
DROP TABLE "Approval";
ALTER TABLE "new_Approval" RENAME TO "Approval";
CREATE INDEX "Approval_userId_status_idx" ON "Approval"("userId", "status");
CREATE INDEX "Approval_taskId_idx" ON "Approval"("taskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
