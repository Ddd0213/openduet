// Skills (L156, M11): Agent Skills folders. SKILL.md's body is `instructions` (its frontmatter is
// name + description); the folder's other files are SkillFile rows. Saving a name that exists
// replaces it (one skill per name, same id). `version` goes up whenever the files change or an
// import replaces the skill: a script of a github / zip / assistant skill asks once per version.
// Where a skill was made decides where it's on (src/access/): in a channel -> only there; on the
// main thread -> every channel. The skill_proposal card ("Save this as a skill?") stores one on
// Save skill (source assistant, with the text files the assistant proposed) and collapses on Not now.
import { Prisma, type Message as MessageRow, type Skill as SkillRow } from "@prisma/client";
import { z } from "zod";
import { AccessService } from "../access/service.ts";
import { CreateSkillRequest, Skill, UpdateSkillRequest } from "../contract/account.ts";
import type { Message } from "../contract/messages.ts";
import { SkillProposalMessage } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import type { Action } from "../tasks/cards.ts";
import { loadMessage } from "../runs/serialize.ts";
import { storedPayload, updatePayload } from "../tasks/thread.ts";
import { safeRelative, writeZip, type ArchiveFile } from "./archive.ts";
import { MAX_DESCRIPTION, MAX_FILE_BYTES, MAX_FILES, MAX_INSTRUCTIONS, MAX_SKILL_BYTES, renderSkillMd, textOf, type SkillFolder } from "./folder.ts";

type SkillShape = z.infer<typeof Skill>;
export type SkillSource = "manual" | "github" | "zip" | "assistant" | "upload";

/** A skill name as typed after "/": lowercase letters, digits and hyphens (contract: Skill.name). */
export const SkillName = Skill.shape.name;

/** A file path inside the folder: relative, no "..", not SKILL.md itself. */
export const SkillFilePath = z.string().min(1).max(200).refine((p) => safeRelative(p) === p && p !== "SKILL.md", "a relative path inside the skill folder (no .., not SKILL.md)");

/** POST /api/skills: the contract's CreateSkillRequest with the folder limits. */
export const SkillInput = CreateSkillRequest.extend({
  description: z.string().trim().max(MAX_DESCRIPTION),
  instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS),
  files: z.array(z.object({ path: SkillFilePath, text: z.string().max(200_000) }).strict()).max(50).optional(),
}).strict();
export type SkillInput = z.infer<typeof SkillInput>;

/** PATCH /api/skills/:id: the contract's UpdateSkillRequest with checked paths. */
export const SkillPatch = UpdateSkillRequest.extend({
  files: z.array(z.object({ path: SkillFilePath, text: z.string().max(200_000).nullable() }).strict()).max(50),
}).partial().strict();
export type SkillPatch = z.infer<typeof SkillPatch>;

/** Files the assistant proposes with propose_skill (kept in the card's payload until Save skill). */
export const ProposedFiles = z.array(z.object({ path: SkillFilePath, text: z.string().max(50_000) }).strict()).max(20);

/** "/my-writing-style rewrite this" -> "my-writing-style". */
export function slashSkill(text: string): string | null {
  const m = /^\/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/.exec(text.trimStart());
  return m ? m[1]! : null;
}

const encoder = new TextEncoder();
const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);
const notFound = () => new HttpError(404, "not_found", "Not found.");
const sourceOf = (value: string): SkillSource => (value === "github" || value === "zip" || value === "assistant" || value === "upload" ? value : "manual");

/** A folder's files must fit: <= 100 files, <= 1 MB each, <= 5 MB in total (400 field files). */
function checkLimits(files: readonly { path: string; size: number }[]): void {
  if (files.length > MAX_FILES) throw invalid("files", `a skill can have up to ${MAX_FILES} files`);
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  if (big) throw invalid("files", `${big.path} is over 1 MB`);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_SKILL_BYTES) throw invalid("files", "a skill can be up to 5 MB");
}

interface FileInfo { path: string; size: number; text: boolean }

export class SkillService {
  readonly access: AccessService;

  constructor(private readonly deps: { db: Db; events: EventBus; access?: AccessService }) {
    this.access = deps.access ?? new AccessService(deps.db);
  }

  /** skillId -> its files (path, size, text), without reading their bytes. */
  private async fileInfos(userId: string, skillId?: string): Promise<Map<string, FileInfo[]>> {
    const rows = await this.deps.db.$queryRaw<{ skillId: string; path: string; size: bigint | number; isText: bigint | number | boolean }[]>(Prisma.sql`
      SELECT f."skillId" AS "skillId", f."path" AS "path", length(f."content") AS "size", f."isText" AS "isText"
      FROM "SkillFile" f JOIN "Skill" s ON s."id" = f."skillId"
      WHERE s."userId" = ${userId} ${skillId ? Prisma.sql`AND s."id" = ${skillId}` : Prisma.empty}
      ORDER BY f."path"`);
    const out = new Map<string, FileInfo[]>();
    for (const row of rows) {
      out.set(row.skillId, [...(out.get(row.skillId) ?? []), { path: row.path, size: Number(row.size), text: Boolean(Number(row.isText)) }]);
    }
    return out;
  }

  private async shape(userId: string, rows: SkillRow[], one?: string): Promise<SkillShape[]> {
    const [files, scopes, channels] = await Promise.all([this.fileInfos(userId, one), this.access.scopes(userId), this.access.enabledChannels(userId, "skill")]);
    return rows.map((row) => {
      const scope = scopes.get(`skill:${row.id}`) ?? "all";
      return Skill.parse({
        id: row.id, name: row.name, description: row.description, instructions: row.instructions, createdAt: row.createdAt.toISOString(),
        source: sourceOf(row.source), sourceUrl: row.sourceUrl, files: files.get(row.id) ?? [],
        scope, channelIds: scope === "channels" ? channels.get(row.id) ?? [] : [],
      });
    });
  }

  async list(userId: string): Promise<SkillShape[]> {
    return this.shape(userId, await this.deps.db.skill.findMany({ where: { userId }, orderBy: { name: "asc" } }));
  }

  async get(userId: string, id: string): Promise<SkillShape> {
    const row = await this.own(userId, id);
    return (await this.shape(userId, [row], row.id))[0]!;
  }

  private async own(userId: string, id: string): Promise<SkillRow> {
    const row = id ? await this.deps.db.skill.findFirst({ where: { id, userId } }) : null;
    if (!row) throw notFound();
    return row;
  }

  /** A channel of this user's (not 404: it's a body field) for "made here". */
  private async channelFor(userId: string, channelId: string | null | undefined, field: string): Promise<string | null> {
    if (!channelId) return null;
    const channel = await this.deps.db.channel.findFirst({ where: { id: channelId, userId }, select: { id: true, isMain: true } });
    if (!channel) throw invalid(field, "unknown channel");
    return channel.isMain ? null : channel.id;
  }

  /**
   * Writes one by hand (or the assistant's, on Save skill). An existing name keeps its id: description and
   * instructions are replaced, and its files only when `files` is given (the whole folder then).
   */
  async save(userId: string, input: SkillInput, opts: { source?: "manual" | "assistant" } = {}): Promise<SkillShape> {
    const { db } = this.deps;
    const channelId = await this.channelFor(userId, input.channelId, "channelId");
    const files = input.files?.map((f) => ({ path: f.path, bytes: encoder.encode(f.text) }));
    if (files) {
      if (new Set(files.map((f) => f.path)).size !== files.length) throw invalid("files", "two files have the same path");
      checkLimits(files.map((f) => ({ path: f.path, size: f.bytes.length })));
    }
    const existing = await this.find(userId, input.name);
    const source = opts.source ?? "manual";
    const row = await db.$transaction(async (tx) => {
      const saved = existing
        ? await tx.skill.update({
          where: { id: existing.id },
          data: {
            description: input.description, instructions: input.instructions,
            ...(files ? { source, sourceUrl: null, version: { increment: 1 } } : {}),
          },
        })
        : await tx.skill.create({ data: { userId, name: input.name, description: input.description, instructions: input.instructions, source } });
      if (files) {
        await tx.skillFile.deleteMany({ where: { skillId: saved.id } });
        if (files.length) await tx.skillFile.createMany({ data: files.map((f) => ({ skillId: saved.id, path: f.path, content: new Uint8Array(f.bytes), isText: true })) });
      }
      return saved;
    });
    await this.access.created(userId, { kind: "skill", id: row.id }, channelId, { replaced: !!existing });
    return this.get(userId, row.id);
  }

  /** PATCH: description, instructions, text files (text null deletes one). File changes bump the version. */
  async update(userId: string, id: string, patch: SkillPatch): Promise<SkillShape> {
    const { db } = this.deps;
    const row = await this.own(userId, id);
    const writes = patch.files ?? [];
    if (new Set(writes.map((f) => f.path)).size !== writes.length) throw invalid("files", "two changes name the same path");
    if (writes.length) {
      const current = (await this.fileInfos(userId, row.id)).get(row.id) ?? [];
      const next = new Map(current.map((f) => [f.path, f.size]));
      for (const write of writes) {
        if (write.text === null) next.delete(write.path);
        else next.set(write.path, encoder.encode(write.text).length);
      }
      checkLimits([...next].map(([path, size]) => ({ path, size })));
    }
    await db.$transaction(async (tx) => {
      for (const write of writes) {
        if (write.text === null) await tx.skillFile.deleteMany({ where: { skillId: row.id, path: write.path } });
        else {
          const content = encoder.encode(write.text);
          await tx.skillFile.upsert({
            where: { skillId_path: { skillId: row.id, path: write.path } },
            create: { skillId: row.id, path: write.path, content, isText: true },
            update: { content, isText: true },
          });
        }
      }
      await tx.skill.update({
        where: { id: row.id },
        data: {
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          ...(writes.length ? { version: { increment: 1 } } : {}),
        },
      });
    });
    return this.get(userId, row.id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.deps.db.skill.deleteMany({ where: { id, userId } });
    if (count === 0) throw notFound();
    await this.access.forget(userId, { kind: "skill", id });
  }

  async find(userId: string, name: string): Promise<SkillRow | null> {
    return this.deps.db.skill.findUnique({ where: { userId_name: { userId, name } } });
  }

  /** The skills this channel can use (disabled ones are invisible there), by name. */
  async visible(userId: string, channelId: string): Promise<SkillRow[]> {
    const grant = await this.access.resolve(userId, channelId);
    if (!grant.skills.size) return [];
    return this.deps.db.skill.findMany({ where: { userId, id: { in: [...grant.skills] } }, orderBy: { name: "asc" } });
  }

  /** A skill by name, only if this channel can use it. */
  async findVisible(userId: string, channelId: string, name: string): Promise<SkillRow | null> {
    const row = await this.find(userId, name);
    if (!row) return null;
    const grant = await this.access.resolve(userId, channelId);
    return grant.skills.has(row.id) ? row : null;
  }

  /** One file's text (GET /api/skills/:id/files/*path). Binary files are 400; unknown 404. */
  async file(userId: string, id: string, path: string): Promise<{ path: string; text: string }> {
    const row = await this.own(userId, id);
    const file = await this.deps.db.skillFile.findUnique({ where: { skillId_path: { skillId: row.id, path } } });
    if (!file) throw notFound();
    const text = file.isText ? textOf(file.content) : null;
    if (text === null) throw invalid("path", "binary files can't be shown");
    return { path: file.path, text };
  }

  /** One stored file of a skill (server-side; the caller checked the skill is visible). */
  async rawFile(skillId: string, path: string) {
    return this.deps.db.skillFile.findUnique({ where: { skillId_path: { skillId, path } } });
  }

  /** Every file of the folder (SKILL.md first), for export and for OpenDuet's computer. */
  async folder(row: SkillRow): Promise<ArchiveFile[]> {
    const files = await this.deps.db.skillFile.findMany({ where: { skillId: row.id }, orderBy: { path: "asc" } });
    return [{ path: "SKILL.md", bytes: encoder.encode(renderSkillMd(row)) }, ...files.map((f) => ({ path: f.path, bytes: new Uint8Array(f.content) }))];
  }

  /** The folder as a stored zip: <name>/SKILL.md (with frontmatter) and its files. */
  async exportZip(userId: string, id: string): Promise<{ name: string; zip: Uint8Array<ArrayBuffer> }> {
    const row = await this.own(userId, id);
    const files = await this.folder(row);
    return { name: row.name, zip: writeZip(files.map((f) => ({ path: `${row.name}/${f.path}`, bytes: f.bytes }))) };
  }

  /**
   * Imports chosen folders of a preview. A name that exists is replaced (same id, version + 1, its
   * files replaced); source / sourceUrl are recorded. channelId: where it was imported.
   * All or nothing: every folder is checked first (no name twice, no file path twice in a folder),
   * then all of them are saved in one transaction.
   */
  async importFolders(userId: string, input: { source: "github" | "zip" | "upload"; sourceUrl: string | null; skills: SkillFolder[]; channelId: string | null }): Promise<SkillShape[]> {
    const { db } = this.deps;
    const channelId = await this.channelFor(userId, input.channelId, "channelId");
    const names = new Set<string>();
    for (const folder of input.skills) {
      if (names.has(folder.name)) throw invalid("names", `${folder.name} is chosen twice`);
      names.add(folder.name);
      const paths = new Set<string>();
      for (const file of folder.files) {
        if (paths.has(file.path)) throw invalid("file", `${folder.name} has ${file.path.slice(0, 120)} twice`);
        paths.add(file.path);
      }
    }
    // A big GitHub import can take a while to write; it's still one transaction.
    const saved = await db.$transaction(async (tx) => {
      const out: { id: string; replaced: boolean }[] = [];
      for (const folder of input.skills) {
        const existing = await tx.skill.findUnique({ where: { userId_name: { userId, name: folder.name } }, select: { id: true } });
        const data = { description: folder.description, instructions: folder.instructions, source: input.source, sourceUrl: input.sourceUrl };
        const row = existing
          ? await tx.skill.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
          : await tx.skill.create({ data: { userId, name: folder.name, ...data } });
        await tx.skillFile.deleteMany({ where: { skillId: row.id } });
        if (folder.files.length) {
          await tx.skillFile.createMany({ data: folder.files.map((f) => ({ skillId: row.id, path: f.path, content: new Uint8Array(f.bytes), isText: f.text })) });
        }
        out.push({ id: row.id, replaced: !!existing });
      }
      return out;
    }, { timeout: 60_000 });
    const ids: string[] = [];
    for (const { id, replaced } of saved) {
      await this.access.created(userId, { kind: "skill", id }, channelId, { replaced });
      ids.push(id);
    }
    const rows = await db.skill.findMany({ where: { userId, id: { in: ids } }, orderBy: { name: "asc" } });
    return this.shape(userId, rows);
  }

  /** Save skill / Not now on a skill_proposal card; a decided card answers as it is. */
  async act(row: MessageRow, action: Action): Promise<Message> {
    const { db, events } = this.deps;
    if (action.action !== "save_skill" && action.action !== "dismiss") {
      throw new HttpError(400, "validation_failed", `action: this card has no ${action.action} action`, "action");
    }
    const raw = storedPayload(row.payload);
    const payload = SkillProposalMessage.shape.payload.parse(raw);
    if (payload.state !== "open") {
      const current = await loadMessage(db, row.id);
      if (!current) throw new Error("stored card does not match the contract");
      return current;
    }
    if (action.action === "dismiss") return updatePayload(db, events, row.userId, row.id, "skill_proposal", { ...raw, state: "dismissed" });
    const files = ProposedFiles.safeParse(raw.files ?? []);
    const channel = await db.channel.findFirst({ where: { id: row.channelId, userId: row.userId }, select: { id: true } });
    const input = SkillInput.parse({
      name: payload.name, description: payload.description, instructions: payload.instructions,
      files: files.success ? files.data : [], channelId: channel?.id ?? null,
    });
    const skill = await this.save(row.userId, input, { source: "assistant" });
    return updatePayload(db, events, row.userId, row.id, "skill_proposal", { ...raw, state: "saved", skillId: skill.id });
  }
}
