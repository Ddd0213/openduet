// Redaction and size caps for run records (M8). Everything a RunStep stores goes through here:
// secret-looking keys and values (Authorization, x-api-key, Bearer ..., sk-..., the server's own
// LLM / COMPUTER / COMPOSIO / search keys) are replaced before the body is capped (8 KB; 2 KB for a
// file the computer read). Run records never hold typed text, file contents written, sign-in
// details or images; see describe.ts for what each tool stores.
import type { Config } from "../config.ts";
import type { ModelConfig } from "../llm/index.ts";

export const STEP_MAX_BYTES = 8 * 1024;
export const FILE_READ_MAX_BYTES = 2 * 1024;
export const DETAIL_MAX_CHARS = 200;
export const REDACTED = "[redacted]";

/**
 * Keys whose values are never stored, whatever they hold (case-insensitive, separators ignored).
 * Matched as a suffix, so compound names count too (db_password, aws_secret_access_key, api_token,
 * x-goog-api-key, github_token); `passwordHint`, `max_tokens` or `tokenCount` don't end in one.
 */
const SECRET_KEY = /(authorization|cookie|password|passwd|pwd|secret|secretkey|apikey|accesskey|privatekey|token|credentials?)$/;
const normalKey = (key: string) => key.toLowerCase().replace(/[^a-z]/g, "");

/**
 * A name=value / "name": value pair whose name contains a secret word, with any prefix or suffix
 * (env style DB_PASSWORD=…, STRIPE_SECRET_KEY=…, X_API_KEY=…, ?token=…). Counts such as
 * max_tokens / input_tokens / token_count are left alone.
 */
const SECRET_PAIR = /(?<![\w-])([\w-]*?(?:api[-_]?key|access[-_]?key|private[-_]?key|secret|password|passwd|token(?!s\b|s?[-_]?(?:count|limit|usage|used))|credentials?)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;

/** Long base64 / base64url runs (images, attachments, data: URIs, MIME lines) are never stored. */
const BASE64_RUN = /(?:data:[\w/+.-]+;base64,)?(?:[A-Za-z0-9+/_-]{60,}={0,2}(?:\r?\n|$)){8,}|(?:data:[\w/+.-]+;base64,)?[A-Za-z0-9+/_-]{512,}={0,2}/g;
export const BINARY = "[binary data]";

/** Secret-looking text inside bodies (headers, query strings, URLs, well-known key formats). */
const PATTERNS: [RegExp, string | ((match: string, ...groups: string[]) => string)][] = [
  [BASE64_RUN, BINARY],
  [/(?<![\w-])((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;}]+/gi, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`],
  [SECRET_PAIR, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`],
  // user:password@ in URLs (postgres://app:hunter2@db, https://u:p@host)
  [/(\/\/[^\s:/@]+:)[^\s@/]+@/g, (_m, head: string) => `${head}${REDACTED}@`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

/** The server's own secrets (values from config and the providers' key variables), for exact-match redaction. */
export function secretValues(config: Partial<Config>, models?: ModelConfig | null, env: Record<string, string | undefined> = process.env): string[] {
  const values = [config.LLM_API_KEY, config.COMPOSIO_API_KEY, config.COMPUTER_TOKEN, config.SEARCH_API_KEY, config.BETTER_AUTH_SECRET];
  for (const provider of models?.providers ?? []) if (provider.apiKeyEnv) values.push(env[provider.apiKeyEnv]);
  return values.filter((v): v is string => typeof v === "string" && v.trim().length >= 8);
}

export class Redactor {
  private secrets: string[];

  constructor(secrets: readonly string[] = []) {
    // Longest first, so a key that contains another is replaced whole.
    this.secrets = [...new Set(secrets.filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length);
  }

  /**
   * M12: a secret learned at run time (a provider key decrypted from the vault, or one just typed
   * in the app) joins the exact-match set from now on.
   */
  add(secret: string): void {
    const value = secret.trim();
    if (value.length < 8 || this.secrets.includes(value)) return;
    this.secrets = [...this.secrets, value].sort((a, b) => b.length - a.length);
  }

  /** Secret values and secret-looking patterns replaced in free text. */
  text(value: string): string {
    let out = value;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as never);
    return out;
  }

  /** A deep copy with secret keys' values replaced and every string redacted. */
  value(input: unknown, depth = 0): unknown {
    if (depth > 12) return "[…]";
    if (typeof input === "string") {
      // A whole value that is base64 (line-wrapped or a data: URI) is dropped; text() catches runs inside.
      const packed = input.replace(/^data:[\w/+.-]+;base64,/, "").replace(/\r?\n/g, "");
      return packed.length > 512 && BASE64.test(packed) ? BINARY : this.text(input);
    }
    if (Array.isArray(input)) return input.map((v) => this.value(v, depth + 1));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) out[k] = SECRET_KEY.test(normalKey(k)) && v !== null && v !== "" ? REDACTED : this.value(v, depth + 1);
      return out;
    }
    return input;
  }

  /**
   * A body for RunStep.input / output: objects (or JSON text) pretty-printed after redaction, other
   * text redacted as is; capped to `max` UTF-8 bytes. null and "" stay null.
   */
  body(input: unknown, max = STEP_MAX_BYTES): string | null {
    if (input === null || input === undefined) return null;
    if (typeof input === "string") {
      if (!input.trim()) return null;
      const json = parseJson(input);
      if (json === undefined) return this.plain(input, max);
      return capBytes(JSON.stringify(this.value(json), null, 2), max);
    }
    const text = JSON.stringify(this.value(input), null, 2) ?? "";
    return text ? capBytes(text, max) : null;
  }

  /** Free text as is (file contents, command output, reply text): redacted, capped; "" -> null. */
  plain(input: string, max = STEP_MAX_BYTES): string | null {
    if (!input.trim()) return null;
    // Whatever lies far past the cap is never stored, so it isn't scanned either.
    return capBytes(this.text(input.length > max * 8 ? input.slice(0, max * 8) : input), max);
  }

  /** One grey line: the first non-empty line, whitespace collapsed, redacted, at most 200 chars. */
  line(input: unknown): string {
    if (typeof input !== "string") return "";
    const first = input.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return capChars(this.text(first.replace(/\s+/g, " ")), DETAIL_MAX_CHARS);
  }
}

/** Long base64 / base64url runs (images, attachments) are never worth storing. */
const BASE64 = /^[A-Za-z0-9+/=_-]+$/;

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** At most `max` UTF-8 bytes, cut on a character boundary, with "…" when cut. */
export function capBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return text;
  const cut = new TextDecoder().decode(bytes.slice(0, Math.max(0, max - 3))).replace(/\uFFFD+$/, "");
  return `${cut}…`;
}

export function capChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
