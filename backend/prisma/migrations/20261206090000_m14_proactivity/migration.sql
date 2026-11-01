-- M14b: how often Claude reaches out on its own and the quiet hours (minutes after local midnight;
-- defaults 22:30-08:30), and the due time of a dated memory ("followup" is a new Memory.kind value,
-- no column change). Additive only: columns via ADD COLUMN (no table is rebuilt).

-- AlterTable
ALTER TABLE "Memory" ADD COLUMN "dueAt" DATETIME;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "proactivity" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "User" ADD COLUMN "quietStart" INTEGER NOT NULL DEFAULT 1350;
ALTER TABLE "User" ADD COLUMN "quietEnd" INTEGER NOT NULL DEFAULT 510;
