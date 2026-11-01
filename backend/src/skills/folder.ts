// Agent Skills folders (M11): SKILL.md (frontmatter name + description, body = instructions) plus
// the folder's other files (scripts/, references/, assets/). Limits: <= 100 files, <= 1 MB each,
// <= 5 MB per skill; paths relative without ".."; name matches Skill.name (an import normalizes it
// or skips the folder with a warning); description <= 1024 characters.
import { Skill } from "../contract/account.ts";
import type { ArchiveFile } from "./archive.ts";

export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;
export const MAX_DESCRIPTION = 1024;
export const MAX_INSTRUCTIONS = 100_000;
export const NAME = Skill.shape.name;

export interface SkillFolder {
  name: string;
  description: string;
  instructions: string;
  /** every file but SKILL.md */
  files: { path: string; bytes: Uint8Array; text: boolean }[];
}

const strict = new TextDecoder("utf-8", { fatal: true });

/** The file as text when it is valid UTF-8 without NUL bytes, else null (binary). */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/** "My Skill!" -> "my-skill"; null when nothing usable is left. */
export function normalizeName(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/^\/+/, "").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return NAME.safeParse(slug).success ? slug : null;
}

const unquote = (value: string) => {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
    try { return String(JSON.parse(v)); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
};

/** SKILL.md -> its frontmatter (simple `key: value`, quoted values and `|` / `>` blocks) and body. */
export function parseSkillMd(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!match) return { meta: {}, body: src.trim() };
  const meta: Record<string, string> = {};
  const lines = match[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let value = m[2]!;
    if (/^[|>][+-]?$/.test(value.trim())) {
      const folded = value.trim().startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = folded ? block.join(" ").replace(/\s+/g, " ") : block.join("\n");
    } else value = unquote(value);
    meta[key] = value.trim();
  }
  return { meta, body: src.slice(match[0].length).trim() };
}

/** SKILL.md as exported: frontmatter with name and description, then the instructions. */
export function renderSkillMd(skill: { name: string; description: string; instructions: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions.trim()}\n`;
}

/** Why this folder's files don't fit, or null. */
export function overLimit(files: readonly { path: string; bytes: Uint8Array }[]): string | null {
  if (files.length > MAX_FILES) return `more than ${MAX_FILES} files`;
  const big = files.find((f) => f.bytes.length > MAX_FILE_BYTES);
  if (big) return `${big.path} is over 1 MB`;
  if (files.reduce((n, f) => n + f.bytes.length, 0) > MAX_SKILL_BYTES) return "over 5 MB in total";
  return null;
}

export const hasScripts = (files: readonly { path: string }[]) => files.some((f) => f.path.startsWith("scripts/"));

/**
 * The skill folders under `base` ("" = the archive's root): every folder with a SKILL.md is one
 * candidate (its files are the ones not inside a deeper skill folder). Skipped folders and files
 * become warnings; nothing is thrown for one bad folder.
 */
export function collectSkills(all: readonly ArchiveFile[], base: string): { skills: SkillFolder[]; warnings: string[] } {
  const prefix = base ? `${base}/` : "";
  const files = all.filter((f) => !prefix || f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes }));
  const roots = files.filter((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md")).map((f) => f.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
  roots.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const warnings: string[] = [];
  const skills: SkillFolder[] = [];
  const seen = new Set<string>();
  const inside = (path: string, root: string) => !root || path.startsWith(`${root}/`);
  for (const root of roots) {
    // Warnings name the folder as it is in the archive / repository.
    const label = [base, root].filter(Boolean).join("/") || "the root";
    const deeper = roots.filter((r) => r !== root && inside(r, root) && r.length > root.length);
    const mine = files.filter((f) => inside(f.path, root) && !deeper.some((d) => inside(f.path, d)));
    const skillMd = mine.find((f) => f.path === (root ? `${root}/SKILL.md` : "SKILL.md"));
    const text = skillMd ? textOf(skillMd.bytes) : null;
    if (text === null) { warnings.push(`${label}: SKILL.md isn't text`); continue; }
    const { meta, body } = parseSkillMd(text);
    const folderName = (root || base).split("/").pop() ?? "";
    const name = normalizeName(meta.name || folderName);
    if (!name) { warnings.push(`${label}: no usable name`); continue; }
    if (seen.has(name)) { warnings.push(`${label}: another folder is already named ${name}`); continue; }
    if (!body) { warnings.push(`${label}: SKILL.md has no instructions`); continue; }
    if (body.length > MAX_INSTRUCTIONS) { warnings.push(`${label}: SKILL.md is too long`); continue; }
    let description = (meta.description ?? "").replace(/\s+/g, " ").trim();
    if (description.length > MAX_DESCRIPTION) {
      description = description.slice(0, MAX_DESCRIPTION);
      warnings.push(`${label}: description shortened to ${MAX_DESCRIPTION} characters`);
    }
    const rest = mine.filter((f) => f !== skillMd).map((f) => ({ path: root ? f.path.slice(root.length + 1) : f.path, bytes: f.bytes }));
    const problem = overLimit(rest);
    if (problem) { warnings.push(`${label}: too large (${problem})`); continue; }
    if (meta.name && meta.name !== name) warnings.push(`${label}: name "${meta.name.slice(0, 64)}" imported as ${name}`);
    seen.add(name);
    skills.push({ name, description, instructions: body, files: rest.map((f) => ({ ...f, text: textOf(f.bytes) !== null })) });
  }
  // Top-level folders with no SKILL.md anywhere ("docs/: no SKILL.md").
  if (!roots.includes("")) {
    const tops = [...new Set(files.filter((f) => f.path.includes("/")).map((f) => f.path.split("/")[0]!))];
    for (const top of tops) if (!roots.some((r) => r === top || r.startsWith(`${top}/`))) warnings.push(`${prefix}${top}/: no SKILL.md`);
  }
  return { skills, warnings };
}
