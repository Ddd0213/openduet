// Push delivery settings (L78), read from the environment and validated here so a bad setup
// names the variable. The main agent wires loadNotifyConfig() into the startup check.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigError } from "../config.ts";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const str = () => z.preprocess(blank, z.string().optional());
const httpUrl = () => z.preprocess(blank, z.url({ protocol: /^https?$/ }).optional());

const NotifyEnv = z.object({
  NOTIFY_PROVIDER: z.preprocess(blank, z.enum(["apns", "ntfy", "bark"]).optional()),
  APNS_KEY_ID: str(),
  APNS_TEAM_ID: str(),
  APNS_KEY: str(),
  APNS_CERT: str(),
  APNS_CERT_PASSWORD: str(),
  APNS_TOPIC: str(),
  APNS_ENV: z.preprocess(blank, z.enum(["production", "sandbox"]).optional()),
  NTFY_URL: httpUrl(),
  NTFY_TOPIC: z.preprocess(blank, z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "may only contain letters, digits, - and _").optional()),
  NTFY_TOKEN: str(),
  BARK_URL: httpUrl(),
  BARK_DEVICE_KEY: z.preprocess(blank, z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "is not a valid device key").optional()),
  BARK_ENCRYPTION_KEY: str(),
  BARK_ENCRYPTION_IV: str(),
});

export type NotifyConfig =
  | { provider: null }
  | { provider: "apns"; keyId: string; teamId: string; key: string; topic: string; env: "production" | "sandbox" | null }
  | { provider: "ntfy"; url: string; topic: string; token: string | null }
  | { provider: "bark"; url: string; deviceKey: string; encryptionKey: string; encryptionIv: string };

/** APNS_KEY is the .p8 contents (PEM, "\n" escapes allowed) or a path to the .p8 file. */
function readKey(value: string, problems: string[]): string {
  let pem = value.includes("BEGIN PRIVATE KEY") ? value.replace(/\\n/g, "\n") : "";
  if (!pem) {
    try {
      pem = readFileSync(value, "utf8");
    } catch {
      problems.push("APNS_KEY must be the .p8 key or a readable path to it");
      return "";
    }
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec") throw new Error("not EC");
  } catch {
    problems.push("APNS_KEY is not a valid .p8 (EC P-256) private key");
  }
  return pem;
}

/** Throws ConfigError naming every missing or bad push setting. */
export function loadNotifyConfig(env: Record<string, string | undefined> = process.env): NotifyConfig {
  const parsed = NotifyEnv.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => `${String(i.path[0] ?? "")} ${i.message}`))]);
  }
  const e = parsed.data;
  const problems: string[] = [];
  const need = (key: keyof typeof e, why: string) => {
    if (e[key] === undefined) problems.push(`${key} is required ${why}`);
  };
  switch (e.NOTIFY_PROVIDER) {
    case undefined:
      return { provider: null };
    case "apns": {
      const why = "when NOTIFY_PROVIDER=apns";
      need("APNS_TOPIC", why);
      if (e.APNS_KEY === undefined && e.APNS_CERT !== undefined) {
        // Bun's TLS ignores PKCS#12 client certificates, so only token (.p8) auth is supported.
        problems.push("APNS_CERT (.p12) isn't supported on this server; set APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY (.p8) instead");
      } else {
        need("APNS_KEY_ID", why);
        need("APNS_TEAM_ID", why);
        need("APNS_KEY", why);
      }
      const key = e.APNS_KEY !== undefined ? readKey(e.APNS_KEY, problems) : "";
      if (problems.length) throw new ConfigError(problems);
      return { provider: "apns", keyId: e.APNS_KEY_ID!, teamId: e.APNS_TEAM_ID!, key, topic: e.APNS_TOPIC!, env: e.APNS_ENV ?? null };
    }
    case "ntfy": {
      const why = "when NOTIFY_PROVIDER=ntfy";
      need("NTFY_URL", why);
      need("NTFY_TOPIC", why);
      if (problems.length) throw new ConfigError(problems);
      return { provider: "ntfy", url: e.NTFY_URL!.replace(/\/+$/, ""), topic: e.NTFY_TOPIC!, token: e.NTFY_TOKEN ?? null };
    }
    case "bark": {
      // L78 says Bark pushes are encrypted, so the key and IV are required (no plaintext mode).
      const why = "when NOTIFY_PROVIDER=bark";
      need("BARK_URL", why);
      need("BARK_DEVICE_KEY", why);
      need("BARK_ENCRYPTION_KEY", why);
      need("BARK_ENCRYPTION_IV", why);
      const key = e.BARK_ENCRYPTION_KEY;
      const iv = e.BARK_ENCRYPTION_IV;
      if (key !== undefined && ![16, 24, 32].includes(Buffer.byteLength(key))) problems.push("BARK_ENCRYPTION_KEY must be 16, 24 or 32 characters (AES-128/192/256)");
      if (iv !== undefined && Buffer.byteLength(iv) !== 16) problems.push("BARK_ENCRYPTION_IV must be 16 characters");
      if (problems.length) throw new ConfigError(problems);
      return { provider: "bark", url: e.BARK_URL!.replace(/\/+$/, ""), deviceKey: e.BARK_DEVICE_KEY!, encryptionKey: key!, encryptionIv: iv! };
    }
  }
}
