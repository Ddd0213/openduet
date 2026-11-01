// M12: what the providers / entries / deletes parts of the models module share, and the request
// checks they use (400 validation_failed with a field, 404 for another user's ids, 409 conflict).
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { normalizeBaseUrl, type Fetch } from "../llm/index.ts";
import { checkModelAddress } from "../llm/net.ts";
import type { Lookup } from "../custom-connectors/net.ts";
import type { KeyedLock } from "../tasks/lock.ts";
import type { Vault } from "../vault/index.ts";
import type { ModelsDevCatalog } from "./catalog.ts";
import { CREDENTIAL_HEADER, RESERVED_HEADERS, type Protocol } from "./presets.ts";
import type { Header } from "./rows.ts";

export interface ModelsCtx {
  db: Db;
  events: EventBus;
  vault: Vault;
  catalog: ModelsDevCatalog;
  fetch: Fetch;
  /** one change at a time per user (names, defaults, deletes) */
  lock: KeyedLock;
  /** LLM_ALLOW_INSECURE_HOSTS */
  insecureHosts: readonly string[];
  privateHosts?: readonly string[];
  lookup?: Lookup;
  verifyTimeoutMs: number;
  /** a key typed or decrypted here joins the run records' redaction set */
  onSecret: (secret: string) => void;
}

export const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);
export const notFound = () => new HttpError(404, "not_found", "Not found.");
export const conflict = (message: string) => new HttpError(409, "conflict", message);

/** The existing normalizeBaseUrl rules (https, or http for localhost / LLM_ALLOW_INSECURE_HOSTS). */
export async function checkBaseUrl(value: string, protocol: Protocol, insecureHosts: readonly string[], privateHosts: readonly string[] = [], lookup?: Lookup): Promise<string> {
  try {
    const normalized = normalizeBaseUrl(value, protocol, insecureHosts);
    await checkModelAddress(new URL(normalized), { insecureHosts, privateHosts, lookup });
    return normalized;
  } catch (error) {
    throw invalid("baseUrl", (error as Error).message);
  }
}

/**
 * Extra headers: names that look like credentials (llm/config.ts's rule) or that the HTTP client owns
 * are refused, as are a name given twice (any case) and a value with a line break.
 */
export function checkHeaders(headers: readonly Header[]): Header[] {
  const seen = new Set<string>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (CREDENTIAL_HEADER.test(header.name)) throw invalid("headers", `${header.name} looks like a credential; put the key in key`);
    if (RESERVED_HEADERS.has(name)) throw invalid("headers", `${header.name} is set by the server`);
    if (seen.has(name)) throw invalid("headers", `${header.name} is given twice`);
    if (/[\r\n\0]/.test(header.value)) throw invalid("headers", `${header.name} has a line break in its value`);
    // What HTTP carries as is: tab and printable ASCII (anything else fails inside fetch later).
    if (/[^\t\x20-\x7e]/.test(header.value)) throw invalid("headers", `${header.name} can only use plain ASCII characters`);
    seen.add(name);
  }
  return headers.map((h) => ({ name: h.name, value: h.value }));
}

export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
