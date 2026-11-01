-- M20: safety. Approval.fingerprint (the same call while one is pending, or soon after "Not now",
-- posts no second card), Approval.why / .always (the card's "Why am I asked?" and what an Always on
-- it would cover, JSON) and ApprovalRule (an "Always" for one recipient, or one site and kind of
-- browser click). Additive only: three nullable columns via ADD COLUMN, one new table, two indexes.

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN "always" TEXT;
ALTER TABLE "Approval" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "Approval" ADD COLUMN "why" TEXT;

-- CreateTable
CREATE TABLE "ApprovalRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "toolSlug" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeValue" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRule_userId_toolSlug_scopeKind_scopeValue_category_key" ON "ApprovalRule"("userId", "toolSlug", "scopeKind", "scopeValue", "category");

-- CreateIndex
CREATE INDEX "Approval_userId_fingerprint_status_idx" ON "Approval"("userId", "fingerprint", "status");

