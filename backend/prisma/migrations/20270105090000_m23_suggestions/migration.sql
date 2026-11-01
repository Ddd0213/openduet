-- M23: suggestions and memory sources. Additive only.
-- Up next: normalised title (dedupe), when it was hidden (14 days no repeat), where it came from, its card.
ALTER TABLE "Suggestion" ADD COLUMN "titleKey" TEXT;
ALTER TABLE "Suggestion" ADD COLUMN "hiddenAt" DATETIME;
ALTER TABLE "Suggestion" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "Suggestion" ADD COLUMN "messageId" TEXT;
CREATE INDEX "Suggestion_userId_titleKey_idx" ON "Suggestion"("userId", "titleKey");
-- Hidden before M23: counted as hidden when they last changed.
UPDATE "Suggestion" SET "hiddenAt" = "updatedAt" WHERE "status" = 'hidden' AND "hiddenAt" IS NULL;
-- Memory: where a fact saved in the background was read.
ALTER TABLE "Memory" ADD COLUMN "sourceRef" TEXT;
