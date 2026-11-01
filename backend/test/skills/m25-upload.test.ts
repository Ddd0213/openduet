import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SkillList } from "../../src/contract/account.ts";
import { SkillImportPreview } from "../../src/contract/m11.ts";
import { SKILL_MD_UPLOAD_MAX_BYTES, SKILL_UPLOAD_MAX_BYTES } from "../../src/contract/m25.ts";
import { fromSkillMd, fromUpload } from "../../src/skills/importer.ts";
import { needsApproval } from "../../src/skills/scripts.ts";
import { errorOf } from "../helpers/http.ts";
import { call, chatIn, get, json, startChannels, text, type ChannelApp } from "../channels/harness.ts";
import { skillMd, zip } from "./archives.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const packed = () => zip([{ path: "uploaded/SKILL.md", data: skillMd("uploaded", "Uploaded", "Run scripts/go.sh") }, { path: "uploaded/scripts/go.sh", data: "echo ok" }]);

describe("M25 upload bytes and names", () => {
  test("zip bytes named md, skill package, and text named zip", () => {
    expect(fromUpload(packed(), "SKILL.md").skills[0]!.files).toHaveLength(1);
    expect(fromUpload(packed(), "tool.skill").skills[0]!.name).toBe("uploaded");
    expect(fromUpload(bytes(skillMd("My Notes!", "Notes", "Write notes")), "tool.zip").skills[0]).toMatchObject({ name: "my-notes", files: [] });
    expect(() => fromUpload(zip([]), "empty.skill")).toThrow("No SKILL.md in this zip");
  });
  test("frontmatter wins; filename fallback, reserved SKILL, unusable names and absent body", () => {
    expect(fromSkillMd(bytes("Do this"), "My Notes.md").skills[0]!.name).toBe("my-notes");
    expect(fromSkillMd(bytes(skillMd("chosen", "", "Body")), "other.md").skills[0]!.name).toBe("chosen");
    for (const name of ["SKILL.md", "skill.MD", "SKILL", "!!!.md"]) expect(() => fromSkillMd(bytes("Body"), name)).toThrow("SKILL.md needs a name in its frontmatter.");
    expect(() => fromSkillMd(bytes(skillMd("!!!", "", "Body")), "valid.md")).toThrow("needs a name");
    expect(() => fromSkillMd(bytes("---\nname: empty\n---\n \n"), "empty.md")).toThrow("no instructions");
    expect(fromSkillMd(bytes("\ufeff---\r\nname: BOM\r\n---\r\nBody"), "SKILL.md").skills[0]!.name).toBe("bom");
  });
  test("strict UTF-8 without NUL, empty and size caps", () => {
    for (const data of [new Uint8Array([0xff]), new Uint8Array([65, 0, 66])]) expect(() => fromUpload(data, "x.md")).toThrow("Upload a .zip, a .skill or a SKILL.md file.");
    expect(() => fromUpload(bytes(""), "x.md")).toThrow("empty");
    expect(() => fromUpload(new Uint8Array(SKILL_UPLOAD_MAX_BYTES + 1), "x.skill")).toThrow("20 MB");
    expect(() => fromUpload(bytes("x".repeat(SKILL_MD_UPLOAD_MAX_BYTES + 1)), "x.md")).toThrow("1 MB");
    // The standalone upload contract allows the full 1 MB (including frontmatter).
    expect(fromSkillMd(bytes(" ".repeat(SKILL_MD_UPLOAD_MAX_BYTES - 1) + "x"), "x.md").skills[0]!.instructions).toBe("x");
    expect(fromSkillMd(bytes("x".repeat(SKILL_MD_UPLOAD_MAX_BYTES)), "x.md").skills[0]!.instructions.length).toBe(SKILL_MD_UPLOAD_MAX_BYTES);
    expect(needsApproval({ source: "upload", version: 1, approvedVersion: 0 })).toBe(true);
  });
});

let m: ChannelApp;
beforeAll(async () => { m = await startChannels(); });
afterAll(() => m.cleanup());
const upload = (data: Uint8Array, name = "SKILL.md", field = "file") => {
  const form = new FormData();
  form.append(field, new File([data], name));
  return m.fixture.app.request("/api/skills/upload/preview", { method: "POST", headers: m.alex.headers, body: form });
};

test("upload preview/import retains source upload and scripts really ask before running", async () => {
  const res = await upload(packed());
  expect(res.status).toBe(200);
  const preview = SkillImportPreview.parse(await res.json());
  expect(preview).toMatchObject({ source: "upload", sourceUrl: null, skills: [{ name: "uploaded", hasScripts: true, exists: false }] });
  expect(await m.skills.service.list(m.alex.userId)).toEqual([]);
  const imported = await m.fixture.app.request("/api/skills/import", json(m.alex, "POST", { importId: preview.importId, names: ["uploaded"], channelId: null }));
  expect(SkillList.parse(await imported.json()).skills[0]!.source).toBe("upload");
  expect(SkillList.parse(await (await get(m, m.alex, "/api/skills")).json()).skills[0]!.source).toBe("upload");
  m.llm.script("chat", [call("run_skill_script", { name: "uploaded", path: "scripts/go.sh" })], [text("Waiting for approval.")]);
  await chatIn(m, m.alex, m.alex.mainChannelId, "run uploaded");
  const approval = await m.fixture.db.approval.findFirstOrThrow({ where: { userId: m.alex.userId, toolSlug: "duet:run_skill_script", status: "pending" } });
  expect(approval.preview).toContain("a skill from an upload");
  expect(m.workspace.commands).toHaveLength(0);
});

test("route classifies text named zip, returns field file / 413 and requires auth", async () => {
  const good = SkillImportPreview.parse(await (await upload(bytes(skillMd("solo", "Solo", "Body")), "x.zip")).json());
  expect(good.skills[0]).toMatchObject({ name: "solo", files: [], hasScripts: false });
  for (const data of [bytes("Body"), bytes(""), bytes("\0bad"), bytes("---\nname: empty\n---\n")]) {
    const res = await upload(data);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "validation_failed", field: "file" });
  }
  expect((await upload(bytes("x"), "x.md", "other")).status).toBe(400);
  expect((await upload(new Uint8Array(SKILL_UPLOAD_MAX_BYTES + 1), "x.skill")).status).toBe(413);
  expect((await upload(bytes("x".repeat(SKILL_MD_UPLOAD_MAX_BYTES + 1)), "x.md")).status).toBe(413);
  expect((await m.fixture.app.request("/api/skills/upload/preview", { method: "POST" })).status).toBe(401);
});
