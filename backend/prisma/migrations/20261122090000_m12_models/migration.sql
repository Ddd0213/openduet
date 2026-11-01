-- M12: model providers and the models picked from them, the user's model defaults and a channel's own model.
-- Additive only: two new tables, and nullable columns via ADD COLUMN (no table is rebuilt).
-- Keys are VaultSecret rows (ownerKind "provider"); existing users import models.json once, lazily.

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN "modelId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "thinkingLevel" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "defaultModelId" TEXT;
ALTER TABLE "User" ADD COLUMN "defaultThinking" TEXT;
ALTER TABLE "User" ADD COLUMN "modelsImportedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "utilityModelId" TEXT;

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "auth" TEXT,
    "headers" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "importKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'chat',
    "modelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL,
    "thinkingLevels" TEXT NOT NULL DEFAULT '[]',
    "thinkingFormat" TEXT NOT NULL DEFAULT 'none',
    "defaultThinking" TEXT,
    "tools" BOOLEAN NOT NULL DEFAULT true,
    "vision" BOOLEAN NOT NULL DEFAULT false,
    "serverWebTools" BOOLEAN NOT NULL DEFAULT false,
    "promptCaching" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "edited" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelEntry_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ModelProvider_userId_idx" ON "ModelProvider"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProvider_userId_name_key" ON "ModelProvider"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProvider_userId_importKey_key" ON "ModelProvider"("userId", "importKey");

-- CreateIndex
CREATE INDEX "ModelEntry_userId_idx" ON "ModelEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelEntry_providerId_modelId_key" ON "ModelEntry"("providerId", "modelId");

