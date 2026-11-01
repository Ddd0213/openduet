// The vault (M11): secrets the user typed in the app (custom connector keys and secret headers;
// M12 model keys later), AES-256-GCM with the server's vault key. Each row has a random 12-byte
// nonce, and its id, userId, ownerKind, ownerId and name are the additional data: a ciphertext
// copied to another row, or a row edited to another user / owner / name, doesn't open.
// `ciphertext` = encrypted data + the 16-byte tag. Values are only ever read server-side (get /
// values); nothing here is logged, returned by a route, put in a prompt, a tool result, a run
// record or an audit row. Reads elsewhere get `info`: set + the last 4 characters.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { keyExists, loadVaultKey, type VaultKeySource } from "./key.ts";

export { keyExists, keyFilePath, loadVaultKey, VaultKeyError, type VaultKeySource } from "./key.ts";

/** connector: CustomConnector.id; provider: ModelProvider.id (M12); oauth_client: OAuthClient.id (M17, its client secret) */
export type OwnerKind = "connector" | "provider" | "oauth_client";
export interface SecretInfo { set: boolean; last4: string | null }

/** A row that doesn't decrypt (wrong key, or data moved between rows). */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

const TAG_BYTES = 16;
/** Short values show no tail: four characters of a six-character secret is most of it. */
const LAST4_MIN_LENGTH = 8;

export function last4Of(value: string): string | null {
  return value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null;
}

/** What a sealed value is bound to: its row and the row's user, owner and name. */
export interface SecretSlot { id: string; userId: string; ownerKind: string; ownerId: string; name: string }

/** The AAD: a JSON array of the five fields, so no field's text can shift into the next one. */
function aadOf(slot: SecretSlot): Buffer {
  return Buffer.from(JSON.stringify([slot.id, slot.userId, slot.ownerKind, slot.ownerId, slot.name]), "utf8");
}

export function seal(key: Buffer, slot: SecretSlot, value: string): { ciphertext: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer> } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadOf(slot));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  // Prisma's Bytes columns take plain ArrayBuffer-backed arrays.
  return { ciphertext: new Uint8Array(Buffer.concat([data, cipher.getAuthTag()])), nonce: new Uint8Array(nonce) };
}

/** `slot`: the row as stored now; a row moved or edited since it was sealed doesn't open. */
export function open(key: Buffer, slot: SecretSlot, ciphertext: Uint8Array, nonce: Uint8Array): string {
  const bytes = Buffer.from(ciphertext);
  if (bytes.length < TAG_BYTES || nonce.length !== 12) throw new VaultError("malformed vault row");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce));
    decipher.setAAD(aadOf(slot));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError("a vault secret could not be decrypted");
  }
}

type Tx = Pick<Db, "vaultSecret">;

export class Vault {
  private key: Buffer | null = null;

  /** `key`: a fixed key (tests); else VAULT_KEY / the key file, loaded on first use. */
  constructor(private readonly db: Db, private readonly source: VaultKeySource | { key: Buffer }) {
    if ("key" in source && source.key.length !== 32) throw new Error("vault key must be 32 bytes");
  }

  /**
   * The key, loaded once. With no VAULT_KEY and no key file, a key is generated only while the
   * table is empty; rows without their key throw VaultKeyError (never a silent new key).
   * `tx`: count through the caller's transaction (SQLite has one writer).
   */
  private async secretKey(tx: Tx = this.db): Promise<Buffer> {
    if (this.key) return this.key;
    if ("key" in this.source) return (this.key = this.source.key);
    const stored = keyExists(this.source) ? undefined : await tx.vaultSecret.count();
    return (this.key = loadVaultKey(this.source, stored));
  }

  /** Stores (or replaces) a secret; answers only its last 4 characters. `tx` joins a transaction. */
  async put(userId: string, ownerKind: OwnerKind, ownerId: string, name: string, value: string, tx: Tx = this.db): Promise<{ last4: string | null }> {
    const where = { userId_ownerKind_ownerId_name: { userId, ownerKind, ownerId, name } };
    const existing = await tx.vaultSecret.findUnique({ where, select: { id: true } });
    const id = existing?.id ?? randomUUID();
    // The same five fields on create and on replace (the row keeps its id, user, owner and name).
    const { ciphertext, nonce } = seal(await this.secretKey(tx), { id, userId, ownerKind, ownerId, name }, value);
    const last4 = last4Of(value);
    if (existing) await tx.vaultSecret.update({ where: { id }, data: { ciphertext, nonce, last4: last4 ?? "" } });
    else await tx.vaultSecret.create({ data: { id, userId, ownerKind, ownerId, name, ciphertext, nonce, last4: last4 ?? "" } });
    return { last4 };
  }

  /** The plaintext, server-side only (never into a response, prompt, log or record). Null when unset. */
  async get(userId: string, ownerKind: OwnerKind, ownerId: string, name: string): Promise<string | null> {
    const row = await this.db.vaultSecret.findUnique({ where: { userId_ownerKind_ownerId_name: { userId, ownerKind, ownerId, name } } });
    return row ? open(await this.secretKey(), row, row.ciphertext, row.nonce) : null;
  }

  /** name -> plaintext for every secret of an owner (server-side only). */
  async values(userId: string, ownerKind: OwnerKind, ownerId: string): Promise<Map<string, string>> {
    const rows = await this.db.vaultSecret.findMany({ where: { userId, ownerKind, ownerId } });
    if (!rows.length) return new Map();
    const key = await this.secretKey();
    return new Map(rows.map((row) => [row.name, open(key, row, row.ciphertext, row.nonce)]));
  }

  async info(userId: string, ownerKind: OwnerKind, ownerId: string, name: string): Promise<SecretInfo> {
    const row = await this.db.vaultSecret.findUnique({ where: { userId_ownerKind_ownerId_name: { userId, ownerKind, ownerId, name } }, select: { last4: true } });
    return row ? { set: true, last4: row.last4 || null } : { set: false, last4: null };
  }

  /** ownerId -> name -> info, for listing many owners in one query. */
  async infos(userId: string, ownerKind: OwnerKind, ownerIds: readonly string[]): Promise<Map<string, Map<string, SecretInfo>>> {
    const out = new Map<string, Map<string, SecretInfo>>();
    if (!ownerIds.length) return out;
    const rows = await this.db.vaultSecret.findMany({ where: { userId, ownerKind, ownerId: { in: [...ownerIds] } }, select: { ownerId: true, name: true, last4: true } });
    for (const row of rows) {
      const names = out.get(row.ownerId) ?? new Map<string, SecretInfo>();
      names.set(row.name, { set: true, last4: row.last4 || null });
      out.set(row.ownerId, names);
    }
    return out;
  }

  async remove(userId: string, ownerKind: OwnerKind, ownerId: string, name: string, tx: Tx = this.db): Promise<void> {
    await tx.vaultSecret.deleteMany({ where: { userId, ownerKind, ownerId, name } });
  }

  async deleteOwner(userId: string, ownerKind: OwnerKind, ownerId: string, tx: Tx = this.db): Promise<void> {
    await tx.vaultSecret.deleteMany({ where: { userId, ownerKind, ownerId } });
  }

  /** M17: an owner's rows whose name starts with `prefix` (e.g. "header:" keeps the "oauth:" ones). */
  async deletePrefix(userId: string, ownerKind: OwnerKind, ownerId: string, prefix: string, tx: Tx = this.db): Promise<void> {
    await tx.vaultSecret.deleteMany({ where: { userId, ownerKind, ownerId, name: { startsWith: prefix } } });
  }

  /** Every stored value of a user (for redacting answers that might echo one back). */
  async allValues(userId: string, ownerKind: OwnerKind, ownerId: string): Promise<string[]> {
    return [...(await this.values(userId, ownerKind, ownerId)).values()];
  }
}
