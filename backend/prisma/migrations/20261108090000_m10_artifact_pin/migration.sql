-- M10: pin an artifact in Make (sorts first, newest pin first), separate from pinnedToTabBar.
-- Additive only: one new nullable column; no table is rebuilt and no row changes.

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN "pinnedAt" DATETIME;
