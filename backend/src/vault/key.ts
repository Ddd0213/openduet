// The vault key (M11): VAULT_KEY (base64 of 32 bytes) when set, else a key file next to the SQLite
// database (/data/db/vault.key in Docker), created with mode 0600 on first use, and only while no
// secret is stored (secrets without their key are a startup error, never a silent new key). A key
// of the wrong length is a startup error. The key itself is never logged.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { log } from "../log.ts";

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

/** The key file of a `file:` DATABASE_URL. Prisma resolves relative SQLite paths against prisma/. */
export function keyFilePath(databaseUrl: string): string {
  const raw = (databaseUrl.replace(/^file:/, "").split("?")[0] ?? "").trim();
  const db = isAbsolute(raw) ? raw : resolve(import.meta.dir, "../../prisma", raw || "duet.db");
  return join(dirname(db), "vault.key");
}

export function decodeKey(value: string, source: string): Buffer {
  const text = value.trim();
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new VaultKeyError(`${source} must be the base64 of 32 bytes (it decodes to ${key.length} bytes).`);
  return key;
}

export interface VaultKeySource {
  /** VAULT_KEY; blank = use the key file */
  env?: string | undefined;
  databaseUrl: string;
}

/** True when a key already exists (VAULT_KEY or the file): index.ts loads it at startup to fail fast. */
export function keyExists(source: VaultKeySource): boolean {
  return (source.env !== undefined && source.env.trim() !== "") || existsSync(keyFilePath(source.databaseUrl));
}

/**
 * VAULT_KEY wins; else the key file, generated (0600) the first time a secret is stored.
 * `storedSecrets`: how many VaultSecret rows exist. A new key is generated only when that is 0
 * (left out = don't generate): a fresh key can't open rows sealed with the lost one, and
 * storing more under it would mix two keys in one table.
 */
export function loadVaultKey(source: VaultKeySource, storedSecrets?: number): Buffer {
  if (source.env !== undefined && source.env.trim() !== "") return decodeKey(source.env, "VAULT_KEY");
  const file = keyFilePath(source.databaseUrl);
  if (existsSync(file)) return decodeKey(readFileSync(file, "utf8"), file);
  if (storedSecrets !== 0) {
    const missing = `The vault key is missing: VAULT_KEY isn't set and ${file} doesn't exist.`;
    if (storedSecrets === undefined) throw new VaultKeyError(missing);
    const rows = `${storedSecrets} secret${storedSecrets === 1 ? "" : "s"}`;
    throw new VaultKeyError(`${missing} The database holds ${rows} sealed with that key, and a new key can't open them: put vault.key back (scripts/restore.sh restores it from a backup) or set VAULT_KEY to it.`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  try {
    // wx: if another process wrote it first, use theirs.
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, `${key.toString("base64")}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return decodeKey(readFileSync(file, "utf8"), file);
    throw error;
  }
  chmodSync(file, 0o600);
  log.info("vault key generated", { path: file, note: "back it up with scripts/backup.sh; without it stored secrets can't be read" });
  return key;
}
