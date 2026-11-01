-- CreateTable
CREATE TABLE "ChannelFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ChannelFile_channelId_createdAt_idx" ON "ChannelFile"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelFile_messageId_idx" ON "ChannelFile"("messageId");
