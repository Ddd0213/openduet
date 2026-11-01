// M17: the official MCP Registry (https://registry.modelcontextprotocol.io/v0/servers) as connector
// templates, after Codync's host/src/market/registry.rs + install.rs. Only hosted remotes are kept
// (streamable-http first, then sse): stdio packages don't fit a hosted multi-user server. Every
// remote URL must pass the outbound guard (https, a public host name) with its `{variables}` filled
// with a placeholder; a server whose remote needs a secret in its URL, a header we can't send or
// two placeholders in one header value is left out. Requests go through outbound.ts (guarded,
// capped, with a deadline); `net` is injected so tests answer with a fake registry.
import { NetError, type NetDeps } from "../custom-connectors/net.ts";
import { RESERVED_HEADERS } from "../custom-connectors/mcp.ts";
import { asObject, guardUrl, requestJson, textOf } from "../custom-connectors/outbound.ts";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const PAGE_LIMIT = 100;
const TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_SERVER_BYTES = 512 * 1024;

/**
 * The curated featured servers, in this order, by registry name (as Codync lists them; Playwright
 * is dropped: it's a local package). Names that aren't in the registry or have no remote are skipped.
 */
export const FEATURED = [
  "io.github.ComposioHQ/composio",
  "io.github.github/github-mcp-server",
  "app.linear/linear",
  "com.notion/mcp",
  // M25: hosted entries verified in the official registry; everyday design, tasks and currencies.
  "com.canva.mcp/mcp",
  "net.todoist/mcp",
  "io.github.lineofflight/frankfurter",
  "com.figma.mcp/mcp",
  "com.stripe/mcp",
  "com.vercel/vercel-mcp",
  "com.supabase/mcp",
  "com.cloudflare.mcp/mcp",
  "com.atlassian/atlassian-mcp-server",
  "io.github.upstash/context7",
] as const;

const SERVER_NAME = /^[A-Za-z0-9.-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const VARIABLE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PLACEHOLDER = /\{([^{}]{1,64})\}/g;

export interface TemplateHeader {
  name: string;
  description: string;
  secret: boolean;
  required: boolean;
  /** a value with one `{x}` the user's value fills; null = the user's value is the whole value */
  template: string | null;
  /** sent as it is (not an input) */
  fixed: string | null;
  default: string | null;
}
export interface TemplateVariable { name: string; description: string; required: boolean; default: string | null }

export interface Template {
  name: string;
  title: string;
  description: string;
  website: string | null;
  iconUrl: string | null;
  remote: { type: "streamable-http" | "sse"; url: string };
  headers: TemplateHeader[];
  variables: TemplateVariable[];
}

/** The inputs the user fills in: URL variables, then the headers that aren't fixed. */
export function inputsOf(template: Template): { name: string; description: string; secret: boolean; required: boolean; kind: "header" | "urlVariable" }[] {
  return [
    ...template.variables.map((v) => ({ name: v.name, description: v.description, secret: false, required: v.required, kind: "urlVariable" as const })),
    ...template.headers.filter((h) => h.fixed === null).map((h) => ({ name: h.name, description: h.description, secret: h.secret, required: h.required, kind: "header" as const })),
  ];
}

/** "com.notion/mcp" -> "Notion", "io.github.upstash/context7" -> "Context7" (registry.rs title_from_name). */
export function titleFromName(name: string): string {
  const [org = "", last = name] = name.includes("/") ? name.split("/", 2) as [string, string] : ["", name];
  let words = last.split(/[-_.]/).filter((w) => w && w !== "mcp" && w !== "server");
  if (!words.length) words = [org.split(".").find((l) => !["com", "io", "app", "ai", "dev", "org", "github"].includes(l)) ?? org];
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 80) || name.slice(0, 80);
}

const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const descriptionOf = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 500) : "");

function httpsOrNull(value: unknown): string | null {
  const raw = textOf(value, 2000);
  if (!raw) return null;
  try {
    return guardUrl(raw).href;
  } catch {
    return null;
  }
}

/** The remote's URL is allowed once its `{variables}` are filled (with a stand-in here). */
function checkRemoteUrl(url: string): boolean {
  try {
    guardUrl(url.replace(PLACEHOLDER, "x"));
    return true;
  } catch {
    return false;
  }
}

function parseRemote(raw: unknown): Pick<Template, "remote" | "headers" | "variables"> | null {
  const remote = asObject(raw);
  const type = remote?.type;
  const url = textOf(remote?.url, 2000);
  if ((type !== "streamable-http" && type !== "sse") || !url || !checkRemoteUrl(url)) return null;
  const variables: TemplateVariable[] = [];
  const declared = asObject(remote!.variables) ?? {};
  const used = new Set([...url.matchAll(PLACEHOLDER)].map((m) => m[1]!));
  for (const name of used) {
    const spec = asObject(declared[name]) ?? {};
    // A URL is stored and shown in plain: a secret can't live in it.
    if (!VARIABLE_NAME.test(name) || spec.isSecret === true) return null;
    const fallback = textOf(spec.default, 500);
    variables.push({ name, description: descriptionOf(spec.description), required: flag(spec.isRequired, true) && fallback === null, default: fallback });
  }
  const headers: TemplateHeader[] = [];
  for (const entry of Array.isArray(remote!.headers) ? remote!.headers : []) {
    const header = asObject(entry);
    const name = textOf(header?.name, 64);
    if (!header || !name || !HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) return null;
    const value = typeof header.value === "string" ? header.value : null;
    const placeholders = value ? [...new Set([...value.matchAll(PLACEHOLDER)].map((m) => m[1]!))] : [];
    if (placeholders.length > 1 || (value !== null && /[\r\n\0]/.test(value))) return null;
    const fallback = textOf(header.default, 500);
    const fixed = value !== null && !placeholders.length ? value : null;
    headers.push({
      name, description: descriptionOf(header.description),
      // Header values are credentials unless the registry says otherwise.
      secret: flag(header.isSecret, true), required: fixed === null && flag(header.isRequired, false) && fallback === null,
      template: placeholders.length ? value : null, fixed, default: fallback,
    });
  }
  const names = [...variables.map((v) => v.name), ...headers.map((h) => h.name.toLowerCase())];
  if (new Set(names).size !== names.length) return null;
  return { remote: { type, url }, headers, variables };
}

/** A registry entry ({server, _meta} or the bare server) as a template, or null when we can't run it. */
export function parseServer(entry: unknown): Template | null {
  const wrapper = asObject(entry);
  const server = asObject(wrapper?.server) ?? wrapper;
  const name = textOf(server?.name, 200);
  if (!server || !name || !SERVER_NAME.test(name)) return null;
  const official = asObject(asObject(wrapper?._meta)?.["io.modelcontextprotocol.registry/official"]);
  const status = official?.status ?? server.status;
  if (typeof status === "string" && status !== "active") return null;
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  // streamable-http first (what our client speaks), then sse.
  const ordered = [...remotes.filter((r) => asObject(r)?.type === "streamable-http"), ...remotes.filter((r) => asObject(r)?.type === "sse")];
  let parsed: ReturnType<typeof parseRemote> = null;
  for (const remote of ordered) if ((parsed = parseRemote(remote))) break;
  if (!parsed) return null;
  const icons = Array.isArray(server.icons) ? server.icons : [];
  const iconUrl = icons.map((i) => httpsOrNull(asObject(i)?.src)).find((u) => u !== null) ?? null;
  return {
    name,
    title: textOf(server.title, 80) ?? titleFromName(name),
    description: descriptionOf(server.description),
    website: httpsOrNull(server.websiteUrl) ?? httpsOrNull(asObject(server.repository)?.url),
    iconUrl,
    ...parsed,
  };
}

/** The registry couldn't be reached or answered something unusable. */
export class RegistryError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "RegistryError";
  }
}

async function getRegistry(url: URL, net: NetDeps, maxBytes: number): Promise<{ status: number; json: unknown }> {
  try {
    const answer = await requestJson(url, { timeoutMs: TIMEOUT_MS, maxBytes }, net);
    return { status: answer.status, json: answer.json };
  } catch (error) {
    if (error instanceof NetError) throw new RegistryError(`The MCP Registry couldn't be reached (${error.kind}).`);
    throw error;
  }
}

/** One page of the registry (a search, or everything), the next cursor (null at the end). */
export async function fetchPage(net: NetDeps, search: string, cursor: string): Promise<{ templates: Template[]; nextCursor: string | null }> {
  const url = new URL(REGISTRY_URL);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("version", "latest");
  if (search) url.searchParams.set("search", search);
  if (cursor) url.searchParams.set("cursor", cursor);
  const { status, json } = await getRegistry(url, net, MAX_PAGE_BYTES);
  const body = asObject(json);
  if (status !== 200 || !body || !Array.isArray(body.servers)) throw new RegistryError(`The MCP Registry answered ${status}.`, status);
  const seen = new Set<string>();
  const templates: Template[] = [];
  for (const entry of body.servers) {
    const template = parseServer(entry);
    if (!template || seen.has(template.name)) continue;
    seen.add(template.name);
    templates.push(template);
  }
  const next = textOf(asObject(body.metadata)?.nextCursor, 500);
  return { templates, nextCursor: next && next !== cursor ? next : null };
}

/**
 * One server by its exact name (latest version): `GET /v0/servers/<name>/versions/latest`, with a
 * search for the exact name as the fallback. null = not in the registry, or nothing we can run.
 */
export async function fetchServer(net: NetDeps, name: string): Promise<Template | null> {
  if (!SERVER_NAME.test(name)) return null;
  const url = new URL(`${REGISTRY_URL}/${encodeURIComponent(name)}/versions/latest`);
  const { status, json } = await getRegistry(url, net, MAX_SERVER_BYTES);
  if (status === 200 && asObject(json)) return parseServer(json);
  if (status !== 404 && status !== 400 && status !== 405) throw new RegistryError(`The MCP Registry answered ${status}.`, status);
  const page = await fetchPage(net, name, "");
  return page.templates.find((t) => t.name === name) ?? null;
}
