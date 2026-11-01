// M17: a pasted MCP config (Claude / Cursor / VS Code / Zed: {"mcpServers": {...}}, {"servers": {...}},
// {"mcp": {"servers": {...}}}, {"context_servers": {...}}, a bare name -> entry map, or one entry)
// becomes custom connectors, like Codync's import_connectors. Only remote entries are added (an https
// url + headers); stdio entries (a command) are skipped, since a hosted server can't run the user's
// local programs. Header values that look like credentials (an Authorization / key / token / secret
// header, a "Bearer ..." value, or a long random-looking value) go to the vault. Entries are added one
// by one through create() (probe for OAuth sign-in, else verify): one that fails is skipped with the
// reason, the rest still go in. At most 20 entries per paste.
import type { z } from "zod";
import type { CustomConnector } from "../contract/m11.ts";
import type { ImportSkipReason } from "../contract/m17.ts";
import { HttpError } from "../http.ts";
import { RESERVED_HEADERS } from "./mcp.ts";
import { checkHttpsUrl, NetError } from "./net.ts";
import { asObject } from "./outbound.ts";
import type { ConnectorService } from "./service.ts";

type Shape = z.infer<typeof CustomConnector>;
type Skip = { name: string; reason: z.infer<typeof ImportSkipReason>; message: string };

const MAX_ENTRIES = 20;
const MAX_HEADERS = 10;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_NAME = /(authorization|auth|token|secret|key|password|passwd|credential|cookie|session|signature)/i;
const PLACEHOLDER = /\$\{[^}]*\}/;

/** A value that is (or contains) a credential: Bearer / Basic / Token ..., or long and random-looking. */
export function looksSecret(name: string, value: string): boolean {
  if (SECRET_NAME.test(name)) return true;
  if (/^(bearer|basic|token|bot)\s+\S/i.test(value)) return true;
  return value.length >= 20 && /^[A-Za-z0-9._~+/=-]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** The named server entries of a pasted config. */
export function configEntries(doc: unknown): [string, Record<string, unknown>][] {
  const root = asObject(doc);
  if (!root) return [];
  const map = asObject(root.mcpServers) ?? asObject(root.servers) ?? asObject(asObject(root.mcp)?.servers) ?? asObject(root.context_servers);
  const pick = (source: Record<string, unknown>) => Object.entries(source).flatMap(([name, value]) => {
    const entry = asObject(value);
    return entry ? [[name, entry] as [string, Record<string, unknown>]] : [];
  });
  if (map) return pick(map);
  if (typeof root.url === "string" || typeof root.serverUrl === "string" || typeof root.httpUrl === "string" || typeof root.command === "string") {
    return [[typeof root.name === "string" ? root.name : "Custom", root]];
  }
  // {"github": {"url": ...}}: the map without its wrapper.
  return pick(root).filter(([, e]) => ["url", "serverUrl", "httpUrl", "command", "type"].some((k) => k in e));
}

const nameOf = (raw: string) => raw.trim().slice(0, 80) || "Custom";

export async function importConfig(service: ConnectorService, userId: string, json: string): Promise<{ connectors: Shape[]; skipped: Skip[] }> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new HttpError(400, "validation_failed", "json: that isn't JSON", "json");
  }
  const entries = configEntries(doc);
  if (!entries.length) throw new HttpError(400, "validation_failed", "json: no MCP servers in that config (expected mcpServers or servers)", "json");
  const known = await service.mcpUrls(userId);
  const connectors: Shape[] = [];
  const skipped: Skip[] = [];
  for (const [index, [rawName, entry]] of entries.entries()) {
    const name = nameOf(rawName);
    if (index >= MAX_ENTRIES) {
      skipped.push({ name, reason: "invalid", message: `At most ${MAX_ENTRIES} servers per paste; add this one again.` });
      continue;
    }
    const url = [entry.url, entry.serverUrl, entry.httpUrl].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim();
    const type = typeof entry.type === "string" ? entry.type.toLowerCase() : null;
    if (!url && (typeof entry.command === "string" || type === "stdio")) {
      skipped.push({ name, reason: "stdio", message: "It runs a program on your own computer, which a hosted server can't do. Use its hosted URL if it has one." });
      continue;
    }
    if (!url) {
      skipped.push({ name, reason: "invalid", message: "It has no url." });
      continue;
    }
    if (PLACEHOLDER.test(url)) {
      skipped.push({ name, reason: "invalid", message: "Its url has ${...} placeholders; fill them in and paste it again." });
      continue;
    }
    let checked: string;
    try {
      checked = checkHttpsUrl(url).href;
    } catch (error) {
      skipped.push({ name, reason: "invalid", message: error instanceof NetError ? error.message : "That isn't a valid URL." });
      continue;
    }
    const rawHeaders = asObject(entry.headers) ?? {};
    const headers: { name: string; value: string; secret: boolean }[] = [];
    let problem: string | null = null;
    for (const [header, value] of Object.entries(rawHeaders)) {
      if (typeof value !== "string" || !value.trim()) { problem = `The ${header.slice(0, 64)} header has no value.`; break; }
      if (!HEADER_NAME.test(header)) { problem = "A header name has characters headers can't have."; break; }
      if (RESERVED_HEADERS.has(header.toLowerCase())) { problem = `${header} is set by the server.`; break; }
      if (PLACEHOLDER.test(value)) { problem = `The ${header} header has \${...} placeholders; fill them in and paste it again.`; break; }
      if (/[\r\n\0]/.test(value) || value.length > 4000) { problem = `The ${header} header must be one line.`; break; }
      headers.push({ name: header, value: value.trim(), secret: looksSecret(header, value) });
    }
    if (!problem && headers.length > MAX_HEADERS) problem = `At most ${MAX_HEADERS} headers.`;
    if (problem) {
      skipped.push({ name, reason: "invalid", message: problem });
      continue;
    }
    if (known.has(checked)) {
      skipped.push({ name, reason: "exists", message: "A connector with this URL is added already." });
      continue;
    }
    try {
      const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 500) : "";
      connectors.push(await service.create(userId, { kind: "mcp", name, description, url: checked, headers }, { allowSignIn: true }));
      known.add(checked);
    } catch (error) {
      // create()'s 400 carries plain words with the entry's secret values redacted.
      if (error instanceof HttpError && error.status === 400) skipped.push({ name, reason: "failed", message: error.message.replace(/^[a-z]+: /, "") });
      else throw error;
    }
  }
  return { connectors, skipped };
}
