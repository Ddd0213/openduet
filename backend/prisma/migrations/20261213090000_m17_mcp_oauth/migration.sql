-- M17: connector templates (the MCP Registry name a connector was installed from) and remote MCP
-- OAuth: the OAuth client a user registered per authorization server, and each connector's grant.
-- Tokens and client secrets are VaultSecret rows, never columns. Additive only: one nullable column
-- via ADD COLUMN and two new tables (no table is rebuilt).

-- AlterTable
ALTER TABLE "CustomConnector" ADD COLUMN "registryName" TEXT;

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "authorizationEndpoint" TEXT NOT NULL,
    "tokenEndpoint" TEXT NOT NULL,
    "registrationEndpoint" TEXT,
    "clientId" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL DEFAULT 'none',
    "redirectUri" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "clientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'needs_sign_in',
    "resource" TEXT NOT NULL,
    "scope" TEXT,
    "expiresAt" DATETIME,
    "signedInAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthGrant_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "CustomConnector" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_userId_issuer_redirectUri_key" ON "OAuthClient"("userId", "issuer", "redirectUri");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthGrant_connectorId_key" ON "OAuthGrant"("connectorId");

-- CreateIndex
CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");
