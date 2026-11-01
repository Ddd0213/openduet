// M25 built-ins: packaged instructions, never Skill rows. Fail closed at startup.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuiltinSkillManifest, type BuiltinSkillEntry } from "../contract/m25.ts";
import { parseSkillMd, textOf } from "./folder.ts";

export interface BuiltinSkill extends BuiltinSkillEntry {
  description: string;
  instructions: string;
  files: ReadonlyMap<string, string>;
}

const ROOT = fileURLToPath(new URL("../../skills-builtin/", import.meta.url));
const stripChange = (text: string) => text.replace(/^<!--[^]*?CHANGES\.md[^]*?-->\s*/i, "");

/** Synchronous so bad deploys fail before the server accepts requests; no cwd dependency. */
export function loadBuiltins(root = ROOT): readonly BuiltinSkill[] {
  const manifest = BuiltinSkillManifest.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
  return manifest.skills.map((entry) => {
    const files = new Map<string, string>();
    const folder = join(root, entry.name);
    const walk = (dir: string, prefix = "") => {
      if (!lstatSync(dir).isDirectory()) throw new Error(`Built-in skill folder is not a directory: ${dir}`);
      for (const file of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${prefix}${file.name}`;
        if (file.isDirectory()) walk(join(dir, file.name), `${path}/`);
        else if (file.isFile()) {
          const text = textOf(readFileSync(join(dir, file.name)));
          if (text === null) throw new Error(`Built-in skill file is not UTF-8 text: ${entry.name}/${path}`);
          files.set(path, stripChange(text));
        } else throw new Error(`Built-in skill contains a link or special file: ${entry.name}/${path}`);
      }
    };
    walk(folder);
    const md = files.get("SKILL.md");
    if (!md) throw new Error(`Built-in skill is missing SKILL.md: ${entry.name}`);
    const { meta, body } = parseSkillMd(md);
    if (meta.name !== entry.name || !body) throw new Error(`Invalid built-in SKILL.md: ${entry.name}`);
    files.delete("SKILL.md");
    return { ...entry, description: meta.description ?? entry.index, instructions: body, files };
  });
}

// ES modules evaluate once. No file reads on turns or tool calls.
export const builtinSkills = loadBuiltins();
