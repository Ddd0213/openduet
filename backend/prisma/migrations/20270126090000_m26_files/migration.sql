-- M26: the Files page groups by origin, and a file can be deleted after it was sent. Additive only:
-- four nullable columns, then a one-time backfill of rows made before M26 (no existing value changes).
-- How the file got here: send | write | screenshot | upload; null = not known (the page's "Other").
ALTER TABLE "ChannelFile" ADD COLUMN "origin" TEXT;
-- Its path in /workspace, relative to /workspace; null = none (screenshots, old uploads).
ALTER TABLE "ChannelFile" ADD COLUMN "workspacePath" TEXT;
-- The task whose own session made it; null for chat, channel and routine turns, and for uploads.
ALTER TABLE "ChannelFile" ADD COLUMN "taskId" TEXT;
-- Deleted by the user: the row stays as a tombstone (its chat card shows "Deleted").
ALTER TABLE "ChannelFile" ADD COLUMN "deletedAt" DATETIME;

-- Backfill Claude's files from the tool call that made each one: the AuditLog row of the same user
-- by Claude with outcome ok, less than 50 ms away, whose target names the file (send_file /
-- computer_files_write: the path, ending in the file name; computer_screenshot: the target is the
-- page's domain and the name is "<host>-YYYY-MM-DDTHH-MM-SS.png"). The nearest one wins (ties: the
-- smaller id). Rows with no such call keep nulls.
-- Step 1 keeps the matched AuditLog id in "workspacePath" for a moment; step 2 replaces it on every
-- row it was set on. (The nearest match is MIN over a packed "<ms, 3 digits><id>" key: an outer
-- column can't be used in a correlated subquery's ORDER BY.)
UPDATE "ChannelFile" SET "workspacePath" = (
  SELECT substr(min(printf('%03d', abs("ChannelFile"."createdAt" - a."createdAt")) || a."id"), 4)
  FROM "AuditLog" a
  WHERE a."userId" = "ChannelFile"."userId" AND a."actor" = 'claude' AND a."outcome" = 'ok'
    AND a."createdAt" > "ChannelFile"."createdAt" - 50 AND a."createdAt" < "ChannelFile"."createdAt" + 50
    AND (
      (a."action" IN ('send_file', 'computer_files_write')
        AND (a."target" = "ChannelFile"."name"
          OR (length(a."target") > length("ChannelFile"."name")
            AND substr(a."target", -length("ChannelFile"."name") - 1) = '/' || "ChannelFile"."name")))
      OR (a."action" = 'computer_screenshot'
        AND "ChannelFile"."name" GLOB '*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9].png')
    )
)
WHERE "source" = 'claude' AND "origin" IS NULL AND "workspacePath" IS NULL;

-- Step 2: origin from the action; the path for sends and writes (none for screenshots); the task
-- from the card's own message (a task session's thread), else from the run when it was a task run.
UPDATE "ChannelFile" SET
  "origin" = (SELECT CASE a."action" WHEN 'send_file' THEN 'send' WHEN 'computer_files_write' THEN 'write' ELSE 'screenshot' END
              FROM "AuditLog" a WHERE a."id" = "ChannelFile"."workspacePath"),
  "taskId" = COALESCE(
    (SELECT m."taskId" FROM "Message" m WHERE m."id" = "ChannelFile"."messageId"),
    (SELECT r."taskId" FROM "AuditLog" a JOIN "Run" r ON r."id" = a."runId"
     WHERE a."id" = "ChannelFile"."workspacePath" AND r."kind" = 'task')),
  "workspacePath" = (SELECT CASE WHEN a."action" = 'computer_screenshot' THEN NULL ELSE a."target" END
                     FROM "AuditLog" a WHERE a."id" = "ChannelFile"."workspacePath")
WHERE "source" = 'claude' AND "origin" IS NULL AND "workspacePath" IS NOT NULL;

-- The user's own files are composer uploads (their /workspace copy isn't known, so no path).
UPDATE "ChannelFile" SET "origin" = 'upload' WHERE "source" = 'user' AND "origin" IS NULL;
