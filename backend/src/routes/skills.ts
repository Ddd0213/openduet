// /api/skills (L156, M11): the user's skills (the composer lists them after "/"), write one, edit
// one (PATCH: description, instructions, text files), delete one, read a text file, export the
// folder as a zip, and import Agent Skills folders from GitHub or a zip (preview first, kept for
// 15 minutes; nothing is saved until POST /api/skills/import).
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { Skill, SkillList } from "../contract/account.ts";
import { SkillFileContent, SkillImportPreview, SkillImportRequest } from "../contract/m11.ts";
import { SKILL_UPLOAD_MAX_BYTES } from "../contract/m25.ts";
import type { NetDeps } from "../custom-connectors/net.ts";
import { errorBody, HttpError, readJson } from "../http.ts";
import { safeRelative } from "../skills/archive.ts";
import { hasScripts, type SkillFolder } from "../skills/folder.ts";
import { fromGitHub, fromUpload, fromZip, ImportError, ImportStore, MAX_DOWNLOAD_BYTES, type PendingImport } from "../skills/importer.ts";
import { SkillInput, SkillPatch, type SkillService } from "../skills/service.ts";

const EXCERPT = 300;
/** Multipart framing around one file is small; anything far above the cap is refused early. */
const MULTIPART_SLACK = 64 * 1024;

const zipLimit = bodyLimit({
  maxSize: MAX_DOWNLOAD_BYTES + MULTIPART_SLACK,
  onError: (c) => c.json(errorBody("too_large", "Zips can be up to 20 MB."), 413),
});

const uploadLimit = bodyLimit({
  maxSize: SKILL_UPLOAD_MAX_BYTES + MULTIPART_SLACK,
  onError: (c) => c.json(errorBody("too_large", "Skills can be up to 20 MB."), 413),
});

export interface SkillRouteDeps {
  /** tests inject fetch + DNS lookup (no network) */
  net?: NetDeps;
  imports?: ImportStore;
}

const notFound = () => new HttpError(404, "not_found", "Not found.");

function importFailure(error: unknown, field: string): never {
  if (error instanceof ImportError) {
    if (error.status === 413) throw new HttpError(413, "too_large", error.message);
    if (error.status === 502) throw new HttpError(502, "internal", error.message);
    throw new HttpError(400, "validation_failed", `${field}: ${error.message}`, field);
  }
  throw error;
}

const idOf = (c: Context<AppEnv>) => {
  const id = c.req.param("id");
  if (!id) throw notFound();
  return id;
};

export function registerSkillRoutes(skills: SkillService, deps: SkillRouteDeps = {}): RegisterRoutes {
  const imports = deps.imports ?? new ImportStore();

  async function preview(userId: string, pending: PendingImport) {
    const existing = new Set((await skills.list(userId)).map((s) => s.name));
    const importId = imports.put(userId, pending);
    return SkillImportPreview.parse({
      importId, source: pending.source, sourceUrl: pending.sourceUrl, warnings: pending.warnings,
      skills: pending.skills.map((s: SkillFolder) => ({
        name: s.name, description: s.description,
        excerpt: s.instructions.length <= EXCERPT ? s.instructions : `${s.instructions.slice(0, EXCERPT - 1)}…`,
        files: s.files.map((f) => ({ path: f.path, size: f.bytes.byteLength, text: f.text })),
        hasScripts: hasScripts(s.files), exists: existing.has(s.name),
      })),
    });
  }

  return (app) => {
    app.get("/api/skills", async (c) => c.json(SkillList.parse({ skills: await skills.list(c.get("user").id) })));

    app.post("/api/skills", async (c) => {
      const body = await readJson(c, SkillInput);
      return c.json(Skill.parse(await skills.save(c.get("user").id, body)));
    });

    // Imports first: "github" / "zip" / "import" are never skill ids.
    app.get("/api/skills/github/preview", async (c) => {
      const url = (c.req.query("url") ?? "").trim();
      if (!url) throw new HttpError(400, "validation_failed", "url: required", "url");
      if (url.length > 2000) throw new HttpError(400, "validation_failed", "url: too long", "url");
      let found;
      try {
        found = await fromGitHub(url, deps.net);
      } catch (error) {
        importFailure(error, "url");
      }
      return c.json(await preview(c.get("user").id, { source: "github", ...found }));
    });

    app.post("/api/skills/zip/preview", zipLimit, async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new HttpError(400, "validation_failed", "file: expected multipart/form-data", "file");
      }
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "validation_failed", "file: missing", "file");
      if (file.size > MAX_DOWNLOAD_BYTES) throw new HttpError(413, "too_large", "Zips can be up to 20 MB.");
      if (file.size === 0) throw new HttpError(400, "validation_failed", "file: empty", "file");
      let found;
      try {
        found = fromZip(new Uint8Array(await file.arrayBuffer()));
      } catch (error) {
        importFailure(error, "file");
      }
      return c.json(await preview(c.get("user").id, { source: "zip", sourceUrl: null, ...found }));
    });

    app.post("/api/skills/upload/preview", uploadLimit, async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new HttpError(400, "validation_failed", "file: expected multipart/form-data", "file");
      }
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "validation_failed", "file: missing", "file");
      if (file.size > SKILL_UPLOAD_MAX_BYTES) throw new HttpError(413, "too_large", "Skills can be up to 20 MB.");
      let found;
      try {
        found = fromUpload(new Uint8Array(await file.arrayBuffer()), file.name);
      } catch (error) {
        importFailure(error, "file");
      }
      return c.json(await preview(c.get("user").id, { source: "upload", sourceUrl: null, ...found }));
    });

    app.post("/api/skills/import", async (c) => {
      const body = await readJson(c, SkillImportRequest);
      const userId = c.get("user").id;
      const pending = imports.get(userId, body.importId);
      if (!pending) throw new HttpError(404, "not_found", "This preview expired. Preview the skills again.");
      const byName = new Map(pending.skills.map((s) => [s.name, s]));
      const unknown = body.names.find((name) => !byName.has(name));
      if (unknown) throw new HttpError(400, "validation_failed", `names: ${unknown} isn't in this preview`, "names");
      const chosen = [...new Set(body.names)].map((name) => byName.get(name)!);
      const imported = await skills.importFolders(userId, { source: pending.source, sourceUrl: pending.sourceUrl, skills: chosen, channelId: body.channelId });
      return c.json(SkillList.parse({ skills: imported }));
    });

    app.patch("/api/skills/:id", async (c) => {
      const id = idOf(c);
      const body = await readJson(c, SkillPatch);
      return c.json(Skill.parse(await skills.update(c.get("user").id, id, body)));
    });

    app.delete("/api/skills/:id", async (c) => {
      await skills.remove(c.get("user").id, idOf(c));
      return c.body(null, 204);
    });

    app.get("/api/skills/:id/files/*", async (c) => {
      const id = idOf(c);
      // /api/skills/<id>/files/<path...>: the rest of the URL, segment by segment.
      let path: string | null;
      try {
        path = safeRelative(c.req.path.split("/").slice(5).map(decodeURIComponent).join("/"));
      } catch {
        path = null;
      }
      if (!path) throw notFound();
      return c.json(SkillFileContent.parse(await skills.file(c.get("user").id, id, path)));
    });

    app.get("/api/skills/:id/export", async (c) => {
      const { name, zip } = await skills.exportZip(c.get("user").id, idOf(c));
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${name}.zip"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  };
}
