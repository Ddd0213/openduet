// Shared CLI I/O. Terminal input is raw and never echoed or retained in history.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ConfigError, loadConfig } from "../config.ts";
import { openDatabase } from "../db.ts";
import { createAuth } from "./auth.ts";
import { createUser, setPassword, validatePassword } from "./users.ts";
import { Language } from "../contract/common.ts";
import { Timezone, Username } from "./validation.ts";

class CliInputError extends Error {}

function hiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) {
    throw new CliInputError("Use a terminal for hidden password entry, or pipe one line with --password-stdin.");
  }
  process.stderr.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new CliInputError("Password input ended."));
    const onError = () => finish(new CliInputError("Could not read password."));
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003" || char === "\u0004") { finish(new CliInputError("Cancelled.")); return; }
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " " && char !== "\u001b") value += char;
        if (value.length > 4096) { finish(new CliInputError("Password is too long.")); return; }
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function readPassword(fromStdin: boolean): Promise<string> {
  if (!fromStdin) {
    const password = await hiddenLine("Password: ");
    if (password !== await hiddenLine("Confirm password: ")) throw new CliInputError("Passwords do not match.");
    return password;
  }
  if (process.stdin.isTTY) throw new CliInputError("--password-stdin requires piped input; omit it for hidden terminal entry.");
  const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    throw new CliInputError("Expected one password line on stdin.");
  } finally {
    lines.close();
    process.stdin.pause();
  }
}

export async function runUserCli(mode: "create" | "password", args = process.argv.slice(2)): Promise<number> {
  let db;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
        username: { type: "string" },
        "password-stdin": { type: "boolean", default: false },
        ...(mode === "create" ? {
          name: { type: "string" as const }, first: { type: "string" as const },
          language: { type: "string" as const }, timezone: { type: "string" as const },
        } : {}),
      } }));
    } catch {
      throw new CliInputError("Invalid arguments. Use --username <u>" +
        (mode === "create" ? ' --name "<Full Name>" [--first <name>] [--language en|zh-Hans] [--timezone <IANA>]' : "") +
        " [--password-stdin]. Passwords cannot be passed as arguments.");
    }
    if (typeof values.username !== "string") throw new CliInputError("--username is required.");
    if (mode === "create" && typeof values.name !== "string") throw new CliInputError("--name is required.");
    const input = z.object({
      username: Username,
      name: z.string().trim().min(1).max(200).optional(),
      firstName: z.string().trim().min(1).max(64).optional(),
      language: Language.optional(),
      timezone: Timezone.optional(),
    }).parse({ ...values, firstName: values.first });
    const config = loadConfig();
    db = await openDatabase(config.DATABASE_URL);
    const auth = createAuth(config, db);
    const password = await validatePassword(auth, await readPassword(values["password-stdin"] === true));
    if (mode === "create") {
      const user = await createUser(db, auth, {
        ...input, name: input.name!, password,
      });
      process.stdout.write(`Created user "${user.username}". Sign in to the App with server address + username + password.\n`);
    } else {
      await setPassword(db, auth, input.username, password);
      process.stdout.write(`Password changed for "${input.username}". All sessions have been revoked.\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof ConfigError || error instanceof CliInputError ? error.message
      : error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("\n")
      : error instanceof Error && /^Username ".*" (already exists|does not exist)\.$/.test(error.message) ? error.message
      : "Account operation failed. Check the database configuration and applied migrations.";
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    try { await db?.$disconnect(); } catch { /* Do not print database errors that may contain credentials. */ }
  }
}
