// M11 vault: AES-256-GCM round trip, id|userId|ownerKind|ownerId|name as AAD (a ciphertext copied
// to another row, or a row edited to another user / owner / name, fails), the key file (created
// 0600 next to the database, never over stored secrets), VAULT_KEY winning, and a bad key failing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "../../src/auth/users.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { loadConfig } from "../../src/config.ts";
import type { Db } from "../../src/db.ts";
import { checkVaultKey } from "../../src/channels/index.ts";
import { keyFilePath, loadVaultKey, Vault, VaultError, VaultKeyError, type OwnerKind } from "../../src/vault/index.ts";
import { createTestDatabase, testEnv } from "../helpers/db.ts";

let db: Db;
let cleanup: () => Promise<void>;
let userId: string;
let otherUserId: string;
const dirs: string[] = [];

beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  cleanup = database.cleanup;
  const config = loadConfig(testEnv({ DATABASE_URL: database.url }));
  const auth = createAuth(config, db);
  userId = (await createUser(db, auth, { username: "vaulty", name: "Val T", password: "test-only correct horse battery staple", timezone: "UTC" })).id;
  otherUserId = (await createUser(db, auth, { username: "vaulty2", name: "Other V", password: "test-only correct horse battery staple", timezone: "UTC" })).id;
});
afterAll(async () => {
  await cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "duet-vault-"));
  dirs.push(dir);
  return dir;
};

describe("vault", () => {
  test("round trip; info shows set + last 4 only; replace keeps the row id", async () => {
    const vault = new Vault(db, { key: randomBytes(32) });
    expect(await vault.put(userId, "connector", "cc_1", "key", "sk-live-abcdef123456")).toEqual({ last4: "3456" });
    expect(await vault.get(userId, "connector", "cc_1", "key")).toBe("sk-live-abcdef123456");
    expect(await vault.info(userId, "connector", "cc_1", "key")).toEqual({ set: true, last4: "3456" });
    expect(await vault.info(userId, "connector", "cc_1", "nope")).toEqual({ set: false, last4: null });
    const before = await db.vaultSecret.findFirstOrThrow({ where: { ownerId: "cc_1" } });
    expect(Buffer.from(before.ciphertext).toString("utf8")).not.toContain("sk-live");
    expect(before.nonce.length).toBe(12);
    // data + 16-byte tag
    expect(before.ciphertext.length).toBe("sk-live-abcdef123456".length + 16);
    await vault.put(userId, "connector", "cc_1", "key", "short");
    const after = await db.vaultSecret.findFirstOrThrow({ where: { ownerId: "cc_1" } });
    expect(after.id).toBe(before.id);
    expect(Buffer.from(after.nonce).equals(Buffer.from(before.nonce))).toBe(false);
    // short secrets show no tail
    expect(await vault.info(userId, "connector", "cc_1", "key")).toEqual({ set: true, last4: null });
    expect(await vault.get(userId, "connector", "cc_1", "key")).toBe("short");
    await vault.deleteOwner(userId, "connector", "cc_1");
    expect(await vault.get(userId, "connector", "cc_1", "key")).toBeNull();
  });

  test("the AAD is id|userId|ownerKind|ownerId|name: a ciphertext copied to another row doesn't decrypt", async () => {
    const vault = new Vault(db, { key: randomBytes(32) });
    await vault.put(userId, "connector", "cc_a", "key", "secret-for-a-123456");
    await vault.put(userId, "connector", "cc_b", "key", "secret-for-b-654321");
    const a = await db.vaultSecret.findFirstOrThrow({ where: { ownerId: "cc_a" } });
    const b = await db.vaultSecret.findFirstOrThrow({ where: { ownerId: "cc_b" } });
    await db.vaultSecret.update({ where: { id: b.id }, data: { ciphertext: a.ciphertext, nonce: a.nonce } });
    await expect(vault.get(userId, "connector", "cc_b", "key")).rejects.toBeInstanceOf(VaultError);
    expect(await vault.get(userId, "connector", "cc_a", "key")).toBe("secret-for-a-123456");
    // another key can't open it either
    await expect(new Vault(db, { key: randomBytes(32) }).get(userId, "connector", "cc_a", "key")).rejects.toBeInstanceOf(VaultError);
  });

  test("a row moved to another id, user, owner or name doesn't open; put back, it does", async () => {
    const vault = new Vault(db, { key: randomBytes(32) });
    await vault.put(userId, "connector", "cc_move", "header:X-Token", "moved-secret-123456");
    const row = await db.vaultSecret.findFirstOrThrow({ where: { ownerId: "cc_move" } });
    const at = { userId, ownerKind: "connector", ownerId: "cc_move", name: "header:X-Token" };
    const read = (where: typeof at) => vault.get(where.userId, where.ownerKind as OwnerKind, where.ownerId, where.name);
    const edits: Array<Partial<typeof at> & { id?: string }> = [
      { id: `${row.id}-moved` },
      { userId: otherUserId },
      { ownerKind: "provider" },
      { ownerId: "cc_other" },
      { name: "key" },
    ];
    for (const edit of edits) {
      const { id: newId, ...fields } = edit;
      await db.vaultSecret.update({ where: { id: row.id }, data: edit });
      await expect(read({ ...at, ...fields })).rejects.toBeInstanceOf(VaultError);
      await db.vaultSecret.update({ where: { id: newId ?? row.id }, data: { id: row.id, ...at } });
      expect(await read(at)).toBe("moved-secret-123456");
    }
    // a replace keeps all five fields, so the new value opens too
    await vault.put(userId, "connector", "cc_move", "header:X-Token", "replaced-secret-654321");
    expect(await read(at)).toBe("replaced-secret-654321");
    await vault.deleteOwner(userId, "connector", "cc_move");
  });

  test("the key file is created next to the database with mode 0600, then reused", async () => {
    // a key is generated only while no secret is stored (the tests above left rows behind)
    await db.vaultSecret.deleteMany();
    const dir = tempDir();
    const databaseUrl = `file:${join(dir, "duet.db")}`;
    const file = keyFilePath(databaseUrl);
    expect(file).toBe(join(dir, "vault.key"));
    expect(existsSync(file)).toBe(false);
    const vault = new Vault(db, { databaseUrl });
    // nothing is created until a secret is stored
    expect(existsSync(file)).toBe(false);
    await vault.put(userId, "connector", "cc_file", "key", "file-backed-secret-1");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const key = loadVaultKey({ databaseUrl });
    expect(key.length).toBe(32);
    expect(Buffer.from(readFileSync(file, "utf8").trim(), "base64").equals(key)).toBe(true);
    // a second process reads the same key
    expect(await new Vault(db, { databaseUrl }).get(userId, "connector", "cc_file", "key")).toBe("file-backed-secret-1");
  });

  test("no VAULT_KEY and no key file while secrets are stored: no new key, a VaultKeyError (put, get, startup)", async () => {
    // a stored row (sealed with some other key)
    await new Vault(db, { key: randomBytes(32) }).put(userId, "connector", "cc_lost", "key", "sealed-with-lost-key");
    const stored = await db.vaultSecret.count();
    expect(stored).toBeGreaterThan(0);
    const dir = tempDir();
    const databaseUrl = `file:${join(dir, "duet.db")}`;
    const file = keyFilePath(databaseUrl);
    const vault = new Vault(db, { databaseUrl });
    await expect(vault.put(userId, "connector", "cc_new", "key", "would-be-sealed-1")).rejects.toBeInstanceOf(VaultKeyError);
    await expect(vault.get(userId, "connector", "cc_lost", "key")).rejects.toBeInstanceOf(VaultKeyError);
    await expect(checkVaultKey({ databaseUrl }, db)).rejects.toBeInstanceOf(VaultKeyError);
    expect(() => loadVaultKey({ databaseUrl }, stored)).toThrow(VaultKeyError);
    // left out = don't generate either
    expect(() => loadVaultKey({ databaseUrl })).toThrow(VaultKeyError);
    expect(existsSync(file)).toBe(false);
    expect(await db.vaultSecret.count({ where: { ownerId: "cc_new" } })).toBe(0);
    // the message names the file and VAULT_KEY, never a key
    const message = await checkVaultKey({ databaseUrl }, db).then(() => "", (error: Error) => error.message);
    expect(message).toContain(file);
    expect(message).toContain("VAULT_KEY");
    expect(message).toContain(`${stored} secret`);
    // a bad VAULT_KEY still fails the startup check; a good one passes
    await expect(checkVaultKey({ env: "c2hvcnQ=", databaseUrl }, db)).rejects.toBeInstanceOf(VaultKeyError);
    await checkVaultKey({ env: randomBytes(32).toString("base64"), databaseUrl }, db);
    // an empty table: startup passes and creates nothing; the first put makes the key
    await db.vaultSecret.deleteMany();
    await checkVaultKey({ databaseUrl }, db);
    expect(existsSync(file)).toBe(false);
    await vault.put(userId, "connector", "cc_new", "key", "first-secret-ok-1");
    expect(existsSync(file)).toBe(true);
  });

  test("VAULT_KEY wins over the key file; a wrong-length key is an error", async () => {
    const dir = tempDir();
    const databaseUrl = `file:${join(dir, "duet.db")}`;
    writeFileSync(keyFilePath(databaseUrl), `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    const env = randomBytes(32).toString("base64");
    expect(loadVaultKey({ env, databaseUrl }).equals(Buffer.from(env, "base64"))).toBe(true);
    const vault = new Vault(db, { env, databaseUrl });
    await vault.put(userId, "connector", "cc_env", "key", "env-backed-secret-1");
    // the file's key can't open it: VAULT_KEY was used
    await expect(new Vault(db, { databaseUrl }).get(userId, "connector", "cc_env", "key")).rejects.toBeInstanceOf(VaultError);
    expect(() => loadVaultKey({ env: randomBytes(16).toString("base64"), databaseUrl })).toThrow(VaultKeyError);
    expect(() => loadVaultKey({ env: "not base64!!", databaseUrl })).toThrow(VaultKeyError);
    writeFileSync(keyFilePath(databaseUrl), "c2hvcnQ=\n");
    expect(() => loadVaultKey({ databaseUrl })).toThrow(VaultKeyError);
  });
});
