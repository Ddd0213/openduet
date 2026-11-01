-- M11: soul, two memory layers, Agent Skills folders, channel access, custom connectors and the vault.
-- Additive only: new tables, and new columns with defaults via ADD COLUMN (no table is rebuilt).
-- Existing Memory rows keep channelId NULL, i.e. they become "About you" (the shared layer).

-- CreateTable
CREATE TABLE "MemoryCuration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "status" TEXT NOT NULL,
    "added" INTEGER NOT NULL DEFAULT 0,
    "archived" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "cursorAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Soul" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "addressAs" TEXT NOT NULL DEFAULT '',
    "identity" TEXT NOT NULL DEFAULT '',
    "persona" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Soul_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SkillFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" BLOB NOT NULL,
    "isText" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SkillFile_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccessRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ChannelAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CustomConnector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "domain" TEXT,
    "headerName" TEXT,
    "valuePrefix" TEXT,
    "headers" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "tools" TEXT NOT NULL DEFAULT '[]',
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CustomConnector_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VaultSecret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ownerKind" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ciphertext" BLOB NOT NULL,
    "nonce" BLOB NOT NULL,
    "last4" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VaultSecret_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable (M11 columns; SQLite ADD COLUMN with constant defaults)
ALTER TABLE "Channel" ADD COLUMN "soulExtra" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Channel" ADD COLUMN "useSharedMemory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Memory" ADD COLUMN "channelId" TEXT;
ALTER TABLE "Memory" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE "Memory" ADD COLUMN "sourceMessageId" TEXT;
ALTER TABLE "Memory" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "Skill" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Skill" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Skill" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Skill" ADD COLUMN "approvedVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Memory_userId_channelId_archivedAt_idx" ON "Memory"("userId", "channelId", "archivedAt");
-- CreateIndex
CREATE INDEX "MemoryCuration_userId_channelId_createdAt_idx" ON "MemoryCuration"("userId", "channelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Soul_userId_key" ON "Soul"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillFile_skillId_path_key" ON "SkillFile"("skillId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRule_userId_kind_refId_key" ON "AccessRule"("userId", "kind", "refId");

-- CreateIndex
CREATE INDEX "ChannelAccess_userId_kind_refId_idx" ON "ChannelAccess"("userId", "kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccess_channelId_kind_refId_key" ON "ChannelAccess"("channelId", "kind", "refId");

-- CreateIndex
CREATE INDEX "CustomConnector_userId_idx" ON "CustomConnector"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultSecret_userId_ownerKind_ownerId_name_key" ON "VaultSecret"("userId", "ownerKind", "ownerId", "name");

