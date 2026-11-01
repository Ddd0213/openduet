// M20 (#5, review-misc "P2 出站连接器调用的凭据检查"): a connector call never carries a credential
// out. inspectArguments() scans a call's arguments before they leave this server (every Composio
// execution: composio/gateway.ts guardOutbound; every custom MCP / API call:
// custom-connectors/provider.ts) for
//  - field names: password, secret, api_key, token, private_key, client_secret, authorization ...
//    in any case / separator spelling (apiKey, api-key, X-Api-Key, API_KEY);
//  - Authorization-style values (Basic <user:pass in base64>, Bearer <token>);
//  - known key formats (sk-..., sk-ant-..., ghp_ / gho_ / github_pat_, AKIA..., xox[abp]-..., AIza...,
//    -----BEGIN ... PRIVATE KEY-----).
// It detects credentials, not PII: emails, phone numbers and ordinary text pass. A hit refuses the
// whole call with a fixed model-facing reason; findings carry only a category and a structural path,
// never the value (and a key name that itself looks like a credential shows as "[credential]").
// The header a custom connector's own auth setup sends (configured by the user) isn't a tool
// argument and is never passed here.
//
// Adapted from CopilotKit/OpenDuet (MIT) openbot/server/src/plugins/content-governance.ts
// inspectToolArguments. The key formats are the ones runs/redact.ts redacts from run records
// (that file keeps its pattern table private; these are anchored copies, keep both in step).

export type CredentialCategory = "credential_field" | "authorization_header" | "provider_token" | "private_key";

export interface CredentialFinding { category: CredentialCategory; path: string }

export type ArgumentInspection =
  | { safe: true }
  | { safe: false; reason: "credential" | "inspection_limit"; findings: CredentialFinding[] };

/** Normalised field names (lower case, `-` `.` space -> `_`, a leading `x_` dropped) that hold a credential. */
const FIELD_NAMES = new Set([
  "password", "passwd", "pwd", "passphrase",
  "secret", "api_secret", "apisecret", "client_secret", "clientsecret", "secret_key", "secretkey",
  "api_key", "apikey", "access_key", "accesskey", "private_key", "privatekey", "signing_key", "signingkey", "ssh_key", "sshkey",
  "token", "access_token", "accesstoken", "refresh_token", "refreshtoken", "auth_token", "authtoken", "bearer_token", "bearertoken",
  "id_token", "idtoken", "session_token", "sessiontoken",
  "authorization", "credential", "credentials",
]);

/** Known key formats (runs/redact.ts redacts the same families). */
const KEY_FORMATS: readonly RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
/** A whole value that is an Authorization header value, or "Authorization: ..." inside text. */
const BASIC = /^\s*Basic\s+([A-Za-z0-9+/]{4,}={0,2})\s*$/i;
const BEARER = /^\s*Bearer\s+([A-Za-z0-9._~+/-]{16,}=*)\s*$/i;
const HEADER_LINE = /\b(?:proxy-)?authorization\s*[:=]\s*["']?(?:Basic|Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/i;

const MAX_NODES = 10_000;
const MAX_DEPTH = 32;
const MAX_STRING = 1_000_000;
const MAX_FINDINGS = 20;

export function normalizedFieldName(name: string): string {
  const normal = name.trim().toLowerCase().replace(/[-.\s]+/g, "_");
  return normal.startsWith("x_") ? normal.slice(2) : normal;
}

/** "Basic <base64>" that decodes to printable "user:password". */
function isBasic(encoded: string): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
    return decoded.includes(":") && decoded.length >= 3 && !/\p{Cc}/u.test(decoded);
  } catch {
    return false;
  }
}

/** A Bearer token, not a phrase ("Bearer authentication"): digits / symbols, or mixed case. */
const looksLikeToken = (token: string) => /[0-9._~+/=-]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1)));

function categoryOf(value: string): CredentialCategory | null {
  if (PRIVATE_KEY.test(value)) return "private_key";
  const basic = BASIC.exec(value)?.[1];
  if (basic && isBasic(basic)) return "authorization_header";
  const bearer = BEARER.exec(value)?.[1];
  if (bearer && looksLikeToken(bearer)) return "authorization_header";
  if (HEADER_LINE.test(value)) return "authorization_header";
  if (KEY_FORMATS.some((pattern) => pattern.test(value))) return "provider_token";
  return null;
}

/** A path is audit metadata: ordinary schema-like names stay, anything else is a structural marker. */
function childPath(parent: string, key: string, credentialKey: boolean): string {
  if (credentialKey) return `${parent}.[credential]`;
  return `${parent}.${/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ? key : "[property]"}`;
}

/** A value under a credential field name counts unless it's empty (booleans are flags, not secrets). */
const holdsValue = (value: unknown): boolean =>
  (typeof value === "string" && value.trim() !== "") || typeof value === "number" || typeof value === "bigint"
  || (Array.isArray(value) && value.length > 0) || (!!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);

/**
 * Scans JSON-shaped call arguments. Fails closed: too deep, too large or cyclic = not safe
 * ("inspection_limit", no findings).
 */
export function inspectArguments(args: unknown): ArgumentInspection {
  const findings: CredentialFinding[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  const add = (category: CredentialCategory, path: string) => { if (findings.length < MAX_FINDINGS) findings.push({ category, path }); };

  const visit = (value: unknown, path: string, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (typeof value === "string") {
      if (value.length > MAX_STRING) return false;
      const category = categoryOf(value);
      if (category) add(category, path);
      return true;
    }
    if (value === null || typeof value !== "object") return true;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.every((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    for (const [key, child] of Object.entries(value)) {
      if (key.length > MAX_STRING) return false;
      const keyCategory = categoryOf(key);
      const here = childPath(path, key, keyCategory !== null);
      if (keyCategory) add(keyCategory, here);
      if (FIELD_NAMES.has(normalizedFieldName(key)) && holdsValue(child)) {
        add("credential_field", here);
        continue;
      }
      if (!visit(child, here, depth + 1)) return false;
    }
    return true;
  };

  try {
    if (!visit(args, "$", 0)) return { safe: false, reason: "inspection_limit", findings: [] };
  } catch {
    return { safe: false, reason: "inspection_limit", findings: [] };
  }
  return findings.length ? { safe: false, reason: "credential", findings } : { safe: true };
}

/** What the model is told when a call was refused (fixed English, model-facing; no value in it). */
export const CREDENTIAL_REFUSED = "Not sent: the arguments look like they contain a password, key or token (see findings). Credentials never leave this server through a connector call. Leave them out; if the service needs one, the user sets it up in the connector's settings.";
export const INSPECTION_REFUSED = "Not sent: the arguments are too large or too deeply nested to check for credentials. Send a smaller call.";

/** The refusal of an unsafe inspection, as tool-result data (category + path only). */
export function credentialRefusal(inspection: Exclude<ArgumentInspection, { safe: true }>): { status: "refused"; error: string; findings: CredentialFinding[] } {
  return { status: "refused", error: inspection.reason === "credential" ? CREDENTIAL_REFUSED : INSPECTION_REFUSED, findings: inspection.findings };
}

/** One short text of the findings for a log line or an error string: "credential_field at $.password". */
export const describeFindings = (findings: readonly CredentialFinding[]): string => findings.map((f) => `${f.category} at ${f.path}`).join(", ");
