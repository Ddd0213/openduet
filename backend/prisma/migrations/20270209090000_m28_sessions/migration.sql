-- M28: login sessions (security review M4). Additive only: five new nullable columns and two
-- indexes, no backfill, no table rebuild, no existing column changed. A server before M28 ignores
-- them, so a rollback keeps the database usable (docs/API.md "M28 sessions": a rollback signs every
-- phone out once, because the old server looks sessions up by the raw token, which M28 no longer
-- keeps). The server itself (not this SQL) fills tokenHash at startup and on every sign-in.

-- sha256(bearer token) as 64 lowercase hex characters; the only copy of the credential the server
-- keeps. null = a row from before M28 the server hasn't converted yet (it converts at startup, before
-- it serves a request). SQLite's UNIQUE allows any number of NULLs.
ALTER TABLE "Session" ADD COLUMN "tokenHash" TEXT;
-- When the session last made a request (written at most every 5 minutes); null = not since M28.
ALTER TABLE "Session" ADD COLUMN "lastUsedAt" DATETIME;
-- The client IP of that request (the same resolution as sign-in's ipAddress); null = not since M28.
ALTER TABLE "Session" ADD COLUMN "lastIp" TEXT;
-- The app's X-Device-Name header (e.g. iPhone 15 Pro); null = the app never sent one.
ALTER TABLE "Session" ADD COLUMN "deviceName" TEXT;

-- The session that registered this push token (POST /api/devices), so revoking a session also stops
-- its pushes. A plain column, not a foreign key: SQLite can only add a foreign key by rebuilding the
-- table. The server deletes the rows itself (docs/API.md "M28 sessions"). null = registered before M28.
ALTER TABLE "DeviceToken" ADD COLUMN "sessionId" TEXT;

CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "DeviceToken_sessionId_idx" ON "DeviceToken"("sessionId");
