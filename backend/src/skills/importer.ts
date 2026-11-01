// Skill imports (M11): a GitHub URL (https://github.com/<owner>/<repo>[/tree/<ref>/<path>] or
// .../blob/<ref>/<path>/SKILL.md) is fetched as codeload's tar.gz (<= 20 MB, public addresses
// only, redirects only to GitHub's own hosts), gunzipped with node:zlib and read with skills/
// archive.ts; a zip upload (<= 20 MB) is read the same way (<= 200 entries, <= 20 MB unpacked).
// Previews are kept in memory for 15 minutes per user and importId; nothing is saved until import.
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ArchiveError, readTar, readZip, safeRelative, type ArchiveFile } from "./archive.ts";
import { collectSkills, MAX_DESCRIPTION, normalizeName, parseSkillMd, textOf, type SkillFolder } from "./folder.ts";
import { SKILL_MD_UPLOAD_MAX_BYTES, SKILL_UPLOAD_MAX_BYTES } from "../contract/m25.ts";
import { checkHttpsUrl, NetError, readCapped, send, type NetDeps } from "../custom-connectors/net.ts";

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 200;
export const MAX_ZIP_UNPACKED = 20 * 1024 * 1024;
const MAX_TAR_ENTRIES = 20_000;
const MAX_TAR_UNPACKED = 200 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60_000;
const PREVIEWS_PER_USER = 10;
const MAX_WARNINGS = 30;
const GITHUB_HOSTS = new Set(["codeload.github.com", "github.com", "objects.githubusercontent.com"]);

/** Something the user can fix (bad URL, nothing found, too large): 400 with this message. */
export class ImportError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 502 = 400) {
    super(message);
    this.name = "ImportError";
  }
}

export interface GitHubSource { owner: string; repo: string; ref: string | null; path: string }

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/** The repository, ref and folder of a GitHub URL; null when it isn't one we accept. */
export function parseGitHubUrl(raw: string): GitHubSource | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com") || url.username || url.password) return null;
  const parts = url.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  const [owner, rawRepo, kind, ref, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo) || owner.startsWith(".") || repo.startsWith(".")) return null;
  if (kind === undefined) return { owner, repo, ref: null, path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref || !/^[A-Za-z0-9_./-]{1,200}$/.test(ref) || ref.includes("..")) return null;
  let path = rest.join("/");
  if (kind === "blob") {
    if (rest.at(-1) !== "SKILL.md") return null;
    path = rest.slice(0, -1).join("/");
  }
  if (path && !safeRelative(path)) return null;
  return { owner, repo, ref, path };
}

async function download(source: GitHubSource, deps: NetDeps): Promise<Uint8Array> {
  let url = new URL(`https://codeload.github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/tar.gz/${source.ref ? source.ref.split("/").map(encodeURIComponent).join("/") : "HEAD"}`);
  for (let hop = 0; hop < 4; hop++) {
    const { response, done, signal } = await send(url, { method: "GET", headers: { "user-agent": "OpenDuet/1.0 (skill import)", accept: "application/x-gzip, application/octet-stream" }, timeoutMs: 60_000 }, deps);
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const next = response.headers.get("location");
        if (!next) throw new ImportError("GitHub sent a redirect without a destination.", 502);
        const target = checkHttpsUrl(new URL(next, url).href);
        if (!GITHUB_HOSTS.has(target.hostname)) throw new ImportError("GitHub redirected somewhere else; not followed.", 502);
        url = target;
        continue;
      }
      if (response.status === 404) { void response.body?.cancel().catch(() => {}); throw new ImportError("That repository or branch wasn't found (private repositories can't be imported)."); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ImportError(`GitHub answered ${response.status}.`, 502); }
      return await readCapped(response, MAX_DOWNLOAD_BYTES, signal);
    } catch (error) {
      if (error instanceof NetError && error.kind === "too_large") throw new ImportError("The repository is larger than 20 MB.", 413);
      throw error;
    } finally {
      done();
    }
  }
  throw new ImportError("Too many redirects from GitHub.", 502);
}

/** The skill folders of a GitHub URL. */
export async function fromGitHub(raw: string, deps: NetDeps = {}): Promise<{ sourceUrl: string; skills: SkillFolder[]; warnings: string[] }> {
  const source = parseGitHubUrl(raw);
  if (!source) throw new ImportError("Use a GitHub link like https://github.com/owner/repo or https://github.com/owner/repo/tree/main/folder.");
  let packed: Uint8Array;
  try {
    packed = await download(source, deps);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (error instanceof NetError) throw new ImportError(`GitHub couldn't be reached: ${error.message}`, 502);
    throw error;
  }
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(packed, { maxOutputLength: MAX_TAR_UNPACKED + 1024 * 1024 }));
  } catch {
    throw new ImportError("The download isn't a readable archive (or it unpacks to more than 200 MB).");
  }
  const contents = unpack(() => readTar(tar, { maxEntries: MAX_TAR_ENTRIES, maxBytes: MAX_TAR_UNPACKED }));
  // codeload puts everything under one "<repo>-<sha>/" folder.
  const files: ArchiveFile[] = contents.files.flatMap((f) => {
    const slash = f.path.indexOf("/");
    return slash === -1 ? [] : [{ path: f.path.slice(slash + 1), bytes: f.bytes }];
  }).filter((f) => f.path);
  // Two top folders could hold the same path once that folder is dropped.
  const paths = new Set<string>();
  for (const f of files) {
    if (paths.has(f.path)) throw new ImportError(`The download has ${f.path.slice(0, 120)} twice.`);
    paths.add(f.path);
  }
  const found = collectSkills(files, source.path);
  if (!found.skills.length) throw new ImportError(source.path ? `No SKILL.md in ${source.path}/ (or none could be imported).` : "No SKILL.md in this repository (or none could be imported).");
  const sourceUrl = `https://github.com/${source.owner}/${source.repo}${source.ref ? `/tree/${source.ref}${source.path ? `/${source.path}` : ""}` : ""}`;
  // Skipped links: repo-relative like the files, and only those under the chosen folder.
  const skipped = contents.skipped
    .map((path) => path.slice(path.indexOf("/") + 1))
    .filter((path) => path && (!source.path || path.startsWith(`${source.path}/`)));
  return { sourceUrl, skills: found.skills, warnings: [...skippedWarnings(skipped), ...found.warnings].slice(0, MAX_WARNINGS) };
}

/** The skill folders of an uploaded zip (one skill at the root, or folders of skills). */
export function fromZip(bytes: Uint8Array): { skills: SkillFolder[]; warnings: string[] } {
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new ImportError("Zips can be up to 20 MB.", 413);
  const contents = unpack(() => readZip(bytes, { maxEntries: MAX_ZIP_ENTRIES, maxBytes: MAX_ZIP_UNPACKED }));
  const found = collectSkills(contents.files, "");
  if (!found.skills.length) throw new ImportError("No SKILL.md in this zip (or none could be imported).");
  return { skills: found.skills, warnings: [...skippedWarnings(contents.skipped), ...found.warnings].slice(0, MAX_WARNINGS) };
}

/** M25: content, not the filename or MIME type, decides the upload format. */
export function fromUpload(bytes: Uint8Array, fileName: string): { skills: SkillFolder[]; warnings: string[] } {
  if (bytes.length > SKILL_UPLOAD_MAX_BYTES) throw new ImportError("Skills can be up to 20 MB.", 413);
  if (!bytes.length) throw new ImportError("The file is empty.");
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
  return zip ? fromZip(bytes) : fromSkillMd(bytes, fileName);
}

/** A standalone SKILL.md has no accompanying files; names follow folder import rules. */
export function fromSkillMd(bytes: Uint8Array, fileName: string): { skills: SkillFolder[]; warnings: string[] } {
  if (bytes.length > SKILL_MD_UPLOAD_MAX_BYTES) throw new ImportError("SKILL.md files can be up to 1 MB.", 413);
  const text = textOf(bytes);
  if (text === null) throw new ImportError("Upload a .zip, a .skill or a SKILL.md file.");
  const { meta, body } = parseSkillMd(text);
  const base = fileName.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? "";
  const rawName = meta.name || (/^skill$/i.test(base) ? "" : base);
  const name = normalizeName(rawName);
  if (!name) throw new ImportError("SKILL.md needs a name in its frontmatter.");
  if (!body) throw new ImportError("SKILL.md has no instructions.");
  const warnings: string[] = [];
  if (rawName !== name) warnings.push(`name "${rawName.slice(0, 64)}" imported as ${name}`);
  let description = (meta.description ?? "").replace(/\s+/g, " ").trim();
  if (description.length > MAX_DESCRIPTION) {
    description = description.slice(0, MAX_DESCRIPTION);
    warnings.push(`description shortened to ${MAX_DESCRIPTION} characters`);
  }
  return { skills: [{ name, description, instructions: body, files: [] }], warnings };
}

function unpack<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ArchiveError) throw new ImportError(error.message);
    throw error;
  }
}

const skippedWarnings = (skipped: readonly string[]) => skipped.slice(0, 10).map((path) => `${path}: links aren't imported`);

export interface PendingImport { source: "github" | "zip" | "upload"; sourceUrl: string | null; skills: SkillFolder[]; warnings: string[] }

/** Previews waiting for POST /api/skills/import, per user, for 15 minutes. */
export class ImportStore {
  private readonly entries = new Map<string, PendingImport & { userId: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const cutoff = this.now() - PREVIEW_TTL_MS;
    for (const [id, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(id);
  }

  put(userId: string, pending: PendingImport): string {
    this.prune();
    const mine = [...this.entries].filter(([, e]) => e.userId === userId).sort((a, b) => a[1].at - b[1].at);
    while (mine.length >= PREVIEWS_PER_USER) this.entries.delete(mine.shift()![0]);
    const id = `imp_${randomUUID().replace(/-/g, "")}`;
    this.entries.set(id, { ...pending, userId, at: this.now() });
    return id;
  }

  /** Someone else's or an expired importId is the same as an unknown one. */
  get(userId: string, id: string): PendingImport | null {
    this.prune();
    const entry = this.entries.get(id);
    return entry && entry.userId === userId ? entry : null;
  }
}
