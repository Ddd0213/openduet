-- M9: pinned tasks, routines (scheduled tasks) and their slot claims. Additive only: new columns
-- with defaults / nullable, and new indexes; no table is rebuilt and no row changes.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "pinnedAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "routine" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "routinePaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "routineQuiet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "nextRunAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "lastRunAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "lastRunStatus" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "slotKey" TEXT;

-- CreateIndex
CREATE INDEX "Task_routine_nextRunAt_idx" ON "Task"("routine", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "Run_slotKey_key" ON "Run"("slotKey");
