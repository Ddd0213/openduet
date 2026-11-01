// Deletes one account and everything that belongs to it (every relation to User cascades).
// Used by scripts/smoke.sh to remove its throwaway user. Usage:
//   bun run user:delete --username <u> --yes
import { parseArgs } from "node:util";
import { z } from "zod";
import { ConfigError, loadConfig } from "../config.ts";
import { openDatabase, type Db } from "../db.ts";
import { Username } from "../auth/validation.ts";

export async function deleteUser(db: Db, username: string): Promise<boolean> {
  const name = Username.parse(username);
  const result = await db.user.deleteMany({ where: { username: name } });
  return result.count > 0;
}

async function main(args = process.argv.slice(2)): Promise<number> {
  let db: Db | undefined;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
        username: { type: "string" },
        yes: { type: "boolean", default: false },
      } }));
    } catch {
      process.stderr.write("Invalid arguments. Use --username <u> --yes\n");
      return 1;
    }
    if (typeof values.username !== "string") { process.stderr.write("--username is required.\n"); return 1; }
    if (values.yes !== true) {
      process.stderr.write(`This deletes "${values.username}" and all of their chats, tasks and files. Add --yes to confirm.\n`);
      return 1;
    }
    const config = loadConfig();
    db = await openDatabase(config.DATABASE_URL);
    if (!(await deleteUser(db, values.username))) {
      process.stderr.write(`Username "${values.username.toLowerCase()}" does not exist.\n`);
      return 1;
    }
    process.stdout.write(`Deleted user "${values.username.toLowerCase()}".\n`);
    return 0;
  } catch (error) {
    const message = error instanceof ConfigError ? error.message
      : error instanceof z.ZodError ? error.issues.map((issue) => `username: ${issue.message}`).join("\n")
      : "Account operation failed. Check the database configuration and applied migrations.";
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    try { await db?.$disconnect(); } catch { /* Do not print database errors that may contain credentials. */ }
  }
}

if (import.meta.main) process.exitCode = await main();
