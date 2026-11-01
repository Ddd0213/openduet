-- M13: realtime voice calls (the transcript and the call's state), the voice settings, and the
-- callId that hides a call's hand-offs and Claude's replies in those turns from the chat.
-- Additive only: two new tables, nullable columns via ADD COLUMN, one new index (no table is rebuilt).

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "callId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "voiceModelId" TEXT;
ALTER TABLE "User" ADD COLUMN "voiceName" TEXT;

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "modelEntryId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL DEFAULT '',
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Call_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallLine_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Call_userId_status_idx" ON "Call"("userId", "status");

-- CreateIndex
CREATE INDEX "Call_channelId_idx" ON "Call"("channelId");

-- CreateIndex
CREATE INDEX "CallLine_callId_at_idx" ON "CallLine"("callId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "CallLine_callId_lineId_key" ON "CallLine"("callId", "lineId");

-- CreateIndex
CREATE INDEX "Message_callId_idx" ON "Message"("callId");

