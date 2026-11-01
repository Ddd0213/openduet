-- AlterTable
ALTER TABLE "Run" ADD COLUMN "title" TEXT;

-- CreateTable
CREATE TABLE "RunStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "tool" TEXT,
    "app" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "input" TEXT,
    "output" TEXT,
    "approvalId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "RunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RunStep_runId_index_idx" ON "RunStep"("runId", "index");

-- CreateIndex
CREATE INDEX "RunStep_approvalId_idx" ON "RunStep"("approvalId");
