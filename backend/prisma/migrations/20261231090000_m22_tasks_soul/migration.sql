-- M22: tasks, "needs you", Setup and "who Claude is" in the chat. Additive only.
-- What the user has to do next (JSON TaskNextStep) and why the last run failed (JSON TaskFailure).
ALTER TABLE "Task" ADD COLUMN "nextStep" TEXT;
ALTER TABLE "Task" ADD COLUMN "failure" TEXT;
-- When the task was last resolved: Active keeps resolved tasks for 7 days.
ALTER TABLE "Task" ADD COLUMN "resolvedAt" DATETIME;
-- Routines: failed runs in a row, who paused it (user | failures), what the last run saw (JSON).
ALTER TABLE "Task" ADD COLUMN "routineFailStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "routinePausedBy" TEXT;
ALTER TABLE "Task" ADD COLUMN "routineState" TEXT;
-- The app of the suggestion a task was started from ("From Gmail" on the row).
ALTER TABLE "Task" ADD COLUMN "sourceApp" TEXT;
-- Up next suggestions the user kept with "Save for Up next".
ALTER TABLE "Suggestion" ADD COLUMN "fromUser" BOOLEAN NOT NULL DEFAULT false;
-- When Claude first offered to set up "who Claude is" in the chat.
ALTER TABLE "User" ADD COLUMN "soulIntroAt" DATETIME;
-- Tasks resolved before M22 count as resolved when they last changed.
UPDATE "Task" SET "resolvedAt" = "updatedAt" WHERE "status" = 'resolved' AND "resolvedAt" IS NULL;
CREATE INDEX "Task_userId_resolvedAt_idx" ON "Task"("userId", "resolvedAt");
