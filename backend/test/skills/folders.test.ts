// M11 Agent Skills folders through the API and the model: GitHub import (a fake fetch serving a
// built tar.gz, SSRF guards, redirects, 413), zip upload (multipart, limits), import (replace by
// name, version + 1, source / sourceUrl, channel scope), file contents, PATCH, export round trip,
// and the tools: use_skill, read_skill_file, run_skill_script (first run of an imported version
// asks, the second doesn't, a new version asks again, manual skills never ask).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Skill, SkillList } from "../../src/contract/account.ts";
import { SkillFileContent, SkillImportPreview } from "../../src/contract/m11.ts";
import { readZip } from "../../src/skills/archive.ts";
import { errorOf } from "../helpers/http.ts";
import { offeredNames } from "../helpers/offered.ts";
import { call, chatIn, get, json, newChannel, resultsIn, startChannels, text, toolNames, type ChannelApp } from "../channels/harness.ts";
import { skillMd, tar, zip } from "./archives.ts";

let m: ChannelApp;
beforeAll(async () => { m = await startChannels(); });
afterAll(() => m.cleanup());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const big = "x".repeat(120 * 1024);

function repo(version = "1") {
  return gzipSync(tar([
    { path: "skills-abc123/", type: "dir" },
    { path: "skills-abc123/README.md", data: "# repo" },
    { path: "skills-abc123/skills/pdf-tools/SKILL.md", data: skillMd("pdf-tools", "Fill and read PDF forms", `Use scripts/fill.py to fill a form. v${version}`) },
    { path: "skills-abc123/skills/pdf-tools/scripts/fill.py", data: `print("filled v${version}")\n` },
    { path: "skills-abc123/skills/pdf-tools/references/fields.md", data: big },
    { path: "skills-abc123/skills/pdf-tools/assets/logo.png", data: PNG },
    { path: "skills-abc123/skills/pdf-tools/escape", type: "symlink", link: "../../../../etc/passwd" },
    { path: "skills-abc123/skills/brand/SKILL.md", data: skillMd("Brand Voice", "Our tone", "Warm, short sentences.") },
    { path: "skills-abc123/skills/notes.txt", data: "not a skill" },
  ]));
}

let served = repo();
const preview = async (url: string, user = m.alex) => get(m, user, `/api/skills/github/preview?url=${encodeURIComponent(url)}`);
const importNames = (body: Record<string, unknown>, user = m.alex) => m.fixture.app.request("/api/skills/import", json(user, "POST", body));
const uploadZip = (bytes: Uint8Array, user = m.alex, field = "file") => {
  const form = new FormData();
  form.append(field, new File([bytes], "skills.zip", { type: "application/zip" }));
  return m.fixture.app.request("/api/skills/zip/preview", { method: "POST", headers: user.headers, body: form });
};

beforeAll(() => {
  m.net.route("codeload.github.com", (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/acme/skills/tar.gz/main") return new Response(served, { headers: { "content-type": "application/x-gzip" } });
    if (path === "/acme/moved/tar.gz/HEAD") return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.tar.gz" } });
    if (path === "/acme/huge/tar.gz/HEAD") return new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } });
    return new Response("Not Found", { status: 404 });
  });
});

describe("GitHub import", () => {
  let importId = "";
  test("preview: codeload tar.gz of the ref, every folder with a SKILL.md under the path, warnings", async () => {
    const res = await preview("https://github.com/acme/skills/tree/main/skills");
    expect(res.status).toBe(200);
    const body = SkillImportPreview.parse(await res.json());
    importId = body.importId;
    expect(m.net.to("codeload.github.com").at(-1)!.url).toBe("https://codeload.github.com/acme/skills/tar.gz/main");
    expect(body).toMatchObject({ source: "github", sourceUrl: "https://github.com/acme/skills/tree/main/skills" });
    expect(body.skills.map((s) => [s.name, s.hasScripts, s.exists])).toEqual([["brand-voice", false, false], ["pdf-tools", true, false]]);
    const pdf = body.skills.find((s) => s.name === "pdf-tools")!;
    expect(pdf.files.map((f) => [f.path, f.text]).sort()).toEqual([["assets/logo.png", false], ["references/fields.md", true], ["scripts/fill.py", true]]);
    expect(pdf.excerpt).toContain("Use scripts/fill.py");
    expect(body.warnings).toEqual(expect.arrayContaining(["skills/pdf-tools/escape: links aren't imported"]));
    expect(body.warnings).toContain("skills/brand: name \"Brand Voice\" imported as brand-voice");
    // Nothing saved by a preview.
    expect(await m.fixture.db.skill.count({ where: { userId: m.alex.userId } })).toBe(0);
  });

  test("import: chosen names, source + sourceUrl, files; again = same id, version + 1; unknown names 400, foreign importId 404", async () => {
    const res = await importNames({ importId, names: ["pdf-tools"], channelId: null });
    expect(res.status).toBe(200);
    const [pdf] = SkillList.parse(await res.json()).skills;
    expect(pdf).toMatchObject({ name: "pdf-tools", source: "github", sourceUrl: "https://github.com/acme/skills/tree/main/skills", scope: "all", channelIds: [] });
    expect(pdf!.instructions).toContain("v1");
    expect(pdf!.files.map((f) => f.path)).toEqual(["assets/logo.png", "references/fields.md", "scripts/fill.py"]);
    const row = await m.fixture.db.skill.findUniqueOrThrow({ where: { id: pdf!.id } });
    expect([row.version, row.approvedVersion]).toEqual([1, 0]);

    expect((await importNames({ importId, names: ["nope"], channelId: null })).status).toBe(400);
    expect((await importNames({ importId, names: ["pdf-tools"], channelId: null }, m.sam)).status).toBe(404);
    expect((await importNames({ importId: "imp_unknown", names: ["pdf-tools"], channelId: null })).status).toBe(404);

    served = repo("2");
    const again = SkillImportPreview.parse(await (await preview("https://github.com/acme/skills/tree/main/skills")).json());
    expect(again.skills.find((s) => s.name === "pdf-tools")!.exists).toBe(true);
    const [replaced] = SkillList.parse(await (await importNames({ importId: again.importId, names: ["pdf-tools"], channelId: null })).json()).skills;
    expect(replaced!.id).toBe(pdf!.id);
    expect(replaced!.instructions).toContain("v2");
    expect((await m.fixture.db.skill.findUniqueOrThrow({ where: { id: pdf!.id } })).version).toBe(2);
    served = repo("1");
  });

  test("bad URLs 400; a missing repo 400; private addresses and foreign redirects refused (502); over 20 MB 413", async () => {
    expect((await get(m, m.alex, "/api/skills/github/preview")).status).toBe(400);
    for (const url of ["https://gitlab.com/a/b", "http://github.com/a/b", "not a url"]) {
      const res = await preview(url);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).field).toBe("url");
    }
    const missing = await preview("https://github.com/acme/none");
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toContain("wasn't found");

    const fetches = m.net.requests.length;
    m.net.dns.set("codeload.github.com", ["10.0.0.7"]);
    const blocked = await preview("https://github.com/acme/skills/tree/main/skills");
    m.net.dns.delete("codeload.github.com");
    expect(blocked.status).toBe(502);
    expect((await errorOf(blocked)).message).toContain("private or reserved");
    expect(m.net.requests.length).toBe(fetches);

    const moved = await preview("https://github.com/acme/moved");
    expect(moved.status).toBe(502);
    expect(m.net.to("evil.example.com")).toHaveLength(0);

    const huge = await preview("https://github.com/acme/huge");
    expect(huge.status).toBe(413);
    expect((await errorOf(huge)).code).toBe("too_large");
  });

  test("a download with a file path twice (also once the top folder is dropped) is 400 field url; nothing saved", async () => {
    const before = await m.fixture.db.skill.count();
    const md = skillMd("twice", "Twice", "Body");
    for (const archive of [
      tar([{ path: "r-1/twice/SKILL.md", data: md }, { path: "r-1/twice/a.txt", data: "1" }, { path: "r-1/twice/a.txt", data: "2" }]),
      tar([{ path: "r-1/twice/SKILL.md", data: md }, { path: "r-2/twice/SKILL.md", data: md }]),
    ]) {
      served = gzipSync(archive);
      const res = await preview("https://github.com/acme/skills/tree/main/twice");
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.field).toBe("url");
      expect(error.message).toMatch(/twice\/(a\.txt|SKILL\.md) twice\.$/);
    }
    served = repo("1");
    expect(await m.fixture.db.skill.count()).toBe(before);
  });
});
describe("zip import, files, PATCH, export", () => {
  let skillId = "";
  test("zip preview (multipart file) + import into a channel: scope channels, on only there", async () => {
    const res = await uploadZip(zip([
      { path: "report/SKILL.md", data: skillMd("report", "Weekly report", "Run scripts/build.sh then summarize.") },
      { path: "report/scripts/build.sh", data: "echo built\n", deflate: true },
      { path: "report/assets/logo.png", data: PNG },
    ]));
    expect(res.status).toBe(200);
    const body = SkillImportPreview.parse(await res.json());
    expect(body).toMatchObject({ source: "zip", sourceUrl: null });
    expect(body.skills.map((s) => [s.name, s.hasScripts])).toEqual([["report", true]]);
    const channel = await newChannel(m, m.alex, { name: "Reports" });
    const other = await newChannel(m, m.alex, { name: "Other" });
    const [skill] = SkillList.parse(await (await importNames({ importId: body.importId, names: ["report"], channelId: channel.id })).json()).skills;
    skillId = skill!.id;
    expect(skill).toMatchObject({ source: "zip", sourceUrl: null, scope: "channels", channelIds: [channel.id] });
    expect((await m.skills.service.visible(m.alex.userId, channel.id)).map((s) => s.name)).toContain("report");
    expect((await m.skills.service.visible(m.alex.userId, other.id)).map((s) => s.name)).not.toContain("report");
    expect((await m.skills.service.visible(m.alex.userId, m.alex.mainChannelId)).map((s) => s.name)).toContain("report");
  });

  test("zip limits: too many entries 400, over 20 MB 413, empty / missing / not a zip 400", async () => {
    const many = await uploadZip(zip(Array.from({ length: 201 }, (_, i) => ({ path: `s/f${i}.txt`, data: "x" }))));
    expect(many.status).toBe(400);
    expect((await errorOf(many)).message).toContain("more than 200 entries");
    const huge = await uploadZip(new Uint8Array(21 * 1024 * 1024));
    expect(huge.status).toBe(413);
    expect((await errorOf(huge)).code).toBe("too_large");
    expect((await uploadZip(new Uint8Array())).status).toBe(400);
    expect((await uploadZip(zip([{ path: "SKILL.md", data: "x" }]), m.alex, "other")).status).toBe(400);
    const notZip = await uploadZip(new TextEncoder().encode("hello"));
    expect(notZip.status).toBe(400);
    expect((await errorOf(notZip)).field).toBe("file");
  });

  test("a zip with a file path twice is 400 field file; importFolders checks every folder first and saves all or nothing", async () => {
    const before = await m.fixture.db.skill.count();
    const dup = await uploadZip(zip([
      { path: "dup/SKILL.md", data: skillMd("dup", "Dup", "Body") },
      { path: "dup/scripts/a.sh", data: "echo 1\n" },
      { path: "dup/scripts/a.sh", data: "echo 2\n", deflate: true },
    ]));
    expect(dup.status).toBe(400);
    const error = await errorOf(dup);
    expect(error.field).toBe("file");
    expect(error.message).toContain("dup/scripts/a.sh twice");
    expect(await m.fixture.db.skill.count()).toBe(before);

    // Straight to the service: the second folder is bad, so the first isn't saved either.
    const file = (path: string) => ({ path, bytes: new TextEncoder().encode("x"), text: true });
    const folders = [
      { name: "first-ok", description: "", instructions: "Body", files: [file("a.md")] },
      { name: "second-bad", description: "", instructions: "Body", files: [file("b.md"), file("b.md")] },
    ];
    const failed = await m.skills.service.importFolders(m.alex.userId, { source: "zip", sourceUrl: null, skills: folders, channelId: null }).then(() => null, (e: unknown) => e as { status?: number; field?: string });
    expect(failed).toMatchObject({ status: 400, field: "file" });
    const twice = await m.skills.service.importFolders(m.alex.userId, { source: "zip", sourceUrl: null, skills: [folders[0]!, folders[0]!], channelId: null }).then(() => null, (e: unknown) => e as { status?: number; field?: string });
    expect(twice).toMatchObject({ status: 400, field: "names" });
    expect(await m.fixture.db.skill.count({ where: { userId: m.alex.userId, name: { in: ["first-ok", "second-bad"] } } })).toBe(0);
    expect(await m.fixture.db.skill.count()).toBe(before);
  });

  test("GET files/*path: text 200, binary 400, unknown or traversal 404, someone else's 404", async () => {
    const script = await get(m, m.alex, `/api/skills/${skillId}/files/scripts/build.sh`);
    expect(script.status).toBe(200);
    expect(SkillFileContent.parse(await script.json())).toEqual({ path: "scripts/build.sh", text: "echo built\n" });
    expect((await get(m, m.alex, `/api/skills/${skillId}/files/assets/logo.png`)).status).toBe(400);
    expect((await get(m, m.alex, `/api/skills/${skillId}/files/scripts/nope.sh`)).status).toBe(404);
    expect((await get(m, m.alex, `/api/skills/${skillId}/files/scripts%2F..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await get(m, m.sam, `/api/skills/${skillId}/files/scripts/build.sh`)).status).toBe(404);
  });

  test("PATCH: description / instructions; file writes and deletes bump the version; bad paths 400", async () => {
    const before = (await m.fixture.db.skill.findUniqueOrThrow({ where: { id: skillId } })).version;
    const meta = Skill.parse(await (await m.fixture.app.request(`/api/skills/${skillId}`, json(m.alex, "PATCH", { description: "Weekly status report" }))).json());
    expect(meta.description).toBe("Weekly status report");
    expect((await m.fixture.db.skill.findUniqueOrThrow({ where: { id: skillId } })).version).toBe(before);
    const files = Skill.parse(await (await m.fixture.app.request(`/api/skills/${skillId}`, json(m.alex, "PATCH", { files: [{ path: "references/notes.md", text: "# Notes" }, { path: "assets/logo.png", text: null }] }))).json());
    expect(files.files.map((f) => f.path)).toEqual(["references/notes.md", "scripts/build.sh"]);
    expect((await m.fixture.db.skill.findUniqueOrThrow({ where: { id: skillId } })).version).toBe(before + 1);
    for (const path of ["../x.md", "/abs.md", "SKILL.md", "a//b"]) {
      const bad = await m.fixture.app.request(`/api/skills/${skillId}`, json(m.alex, "PATCH", { files: [{ path, text: "x" }] }));
      expect(bad.status).toBe(400);
    }
    expect((await m.fixture.app.request(`/api/skills/${skillId}`, json(m.sam, "PATCH", { description: "x" }))).status).toBe(404);
  });

  test("export: a stored zip of <name>/SKILL.md (frontmatter) + files that imports back the same", async () => {
    const res = await get(m, m.alex, `/api/skills/${skillId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"report.zip\"");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const entries = readZip(bytes, { maxEntries: 200, maxBytes: 20 * 1024 * 1024 }).files;
    expect(entries.map((e) => e.path)).toEqual(["report/SKILL.md", "report/references/notes.md", "report/scripts/build.sh"]);
    const md = new TextDecoder().decode(entries[0]!.bytes);
    expect(md).toStartWith("---\nname: report\ndescription: \"Weekly status report\"\n---\n");
    expect(md).toContain("Run scripts/build.sh then summarize.");
    const back = SkillImportPreview.parse(await (await uploadZip(bytes, m.sam)).json());
    expect(back.skills.map((s) => [s.name, s.description, s.files.map((f) => f.path)])).toEqual([["report", "Weekly status report", ["references/notes.md", "scripts/build.sh"]]]);
    expect((await get(m, m.sam, `/api/skills/${skillId}/export`)).status).toBe(404);
  });
});
describe("model tools", () => {
  const sentSince = (n: number) => m.llm.sent("chat").slice(n);
  const pendingScripts = () => m.fixture.db.approval.findMany({ where: { userId: m.alex.userId, toolSlug: "duet:run_skill_script", status: "pending" }, orderBy: { createdAt: "asc" } });
  const approve = (id: string) => m.fixture.app.request(`/api/approvals/${id}/approve`, json(m.alex, "POST", { version: 1 }));

  test("the index lists the channel's skills; use_skill gives SKILL.md's body + files; read_skill_file reads text (<= 100 KB)", async () => {
    const before = m.llm.sent("chat").length;
    m.llm.script("chat",
      [call("use_skill", { name: "/pdf-tools" })],
      [call("read_skill_file", { name: "pdf-tools", path: "references/fields.md" }), call("read_skill_file", { name: "pdf-tools", path: "assets/logo.png" }), call("read_skill_file", { name: "pdf-tools", path: "nope.md" })],
      [text("Done.")],
    );
    await chatIn(m, m.alex, m.alex.mainChannelId, "fill my PDF form");
    const sent = sentSince(before);
    expect(sent[0]!.system).toContain("\"/pdf-tools\",\"description\":\"Fill and read PDF forms\"");
    expect(offeredNames(sent[0])).toEqual(expect.arrayContaining(["propose_skill", "use_skill", "read_skill_file", "run_skill_script"]));
    const [used] = resultsIn(sent[1]);
    expect(used).toMatchObject({ name: "/pdf-tools", source: "github" });
    expect(used!.instructions).toContain("Use scripts/fill.py");
    expect((used!.files as { path: string }[]).map((f) => f.path)).toEqual(["assets/logo.png", "references/fields.md", "scripts/fill.py"]);
    const [read, binary, missing] = resultsIn(sent[2]);
    expect(read).toMatchObject({ path: "references/fields.md", truncated: true, size: big.length });
    expect((read!.text as string).length).toBe(100 * 1024);
    expect(binary!.error).toContain("binary");
    expect(missing!.error).toContain("has no file");
  });

  test("run_skill_script: the first run of an imported version asks; approving runs it; the second doesn't ask; a new version asks again", async () => {
    const row = await m.fixture.db.skill.findFirstOrThrow({ where: { userId: m.alex.userId, name: "pdf-tools" } });
    const runs = m.workspace.commands.length;
    m.llm.script("chat", [call("run_skill_script", { name: "pdf-tools", path: "scripts/fill.py", args: ["form 1.pdf"] })], [text("Waiting for your OK.")]);
    let before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "fill it");
    expect(resultsIn(sentSince(before)[1])[0]).toMatchObject({ status: "awaiting_approval" });
    const [card] = await pendingScripts();
    expect(card).toMatchObject({ kind: "action" });
    // The card says what approving allows: the scripts of this skill version, not only this one run.
    expect(JSON.parse(card!.preview).rows).toContainEqual({ label: "Allows", value: expect.stringContaining(`Scripts of /pdf-tools v${row.version} (first run of this version)`) });
    expect(card!.preview).toContain(`/pdf-tools v${row.version}`);
    expect(JSON.parse(card!.arguments)).toEqual({ skillId: row.id, name: "pdf-tools", version: row.version, path: "scripts/fill.py", args: ["form 1.pdf"] });
    expect(m.workspace.commands.length).toBe(runs);

    expect((await approve(card!.id)).status).toBe(200);
    expect((await m.fixture.db.skill.findUniqueOrThrow({ where: { id: row.id } })).approvedVersion).toBe(row.version);
    expect(m.workspace.commands.slice(runs)).toEqual([{ userId: m.alex.userId, command: "python3 './scripts/fill.py' 'form 1.pdf'", cwd: ".skills/pdf-tools", timeoutMs: 300_000 }]);
    expect(m.workspace.get(m.alex.userId, ".skills/pdf-tools/scripts/fill.py")).toContain("filled");
    expect(m.workspace.get(m.alex.userId, ".skills/pdf-tools/SKILL.md")).toStartWith("---\nname: pdf-tools\n");
    // The approved result reaches the model on the next turn.
    m.llm.script("chat", [call("run_skill_script", { name: "pdf-tools", path: "scripts/fill.py" })], [text("Ran it again.")]);
    before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "again please");
    expect(sentSince(before)[0]!.system).toContain("Skill scripts the user approved since your last turn");
    expect(resultsIn(sentSince(before)[1])[0]).toMatchObject({ status: "ran", exitCode: 0, stdout: "ok\n", folder: "/workspace/.skills/pdf-tools" });
    expect(m.workspace.commands.length).toBe(runs + 2);
    expect(await pendingScripts()).toHaveLength(0);

    // A new version (a script edit) asks again.
    await m.fixture.app.request(`/api/skills/${row.id}`, json(m.alex, "PATCH", { files: [{ path: "scripts/fill.py", text: "print('v3')\n" }] }));
    m.llm.script("chat", [call("run_skill_script", { name: "pdf-tools", path: "scripts/fill.py" })], [text("Needs your OK.")]);
    before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "and once more");
    expect(resultsIn(sentSince(before)[1])[0]).toMatchObject({ status: "awaiting_approval" });
    expect(await pendingScripts()).toHaveLength(1);
    expect(m.workspace.commands.length).toBe(runs + 2);
  });

  test("manual skills run without a card; Claude's proposed skill (files saved with it) asks first", async () => {
    const manual = await m.fixture.app.request("/api/skills", json(m.alex, "POST", { name: "my-tool", description: "Mine", instructions: "Run scripts/go.sh", files: [{ path: "scripts/go.sh", text: "echo go\n" }] }));
    expect(Skill.parse(await manual.json())).toMatchObject({ source: "manual", files: [{ path: "scripts/go.sh", size: 8, text: true }] });
    const runs = m.workspace.commands.length;
    m.llm.script("chat", [call("run_skill_script", { name: "my-tool", path: "scripts/go.sh", args: ["--fast"] })], [text("Done.")]);
    let before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "run my tool");
    expect(resultsIn(sentSince(before)[1])[0]).toMatchObject({ status: "ran" });
    expect(m.workspace.commands.at(-1)!.command).toBe("bash './scripts/go.sh' '--fast'");
    expect(m.workspace.commands.length).toBe(runs + 1);

    // A stored path that looks like an option runs as a file: ./<path>, never `node --require=…`.
    const dashed = await m.fixture.app.request("/api/skills", json(m.alex, "POST", { name: "dash-tool", description: "Dash", instructions: "Run it", files: [{ path: "--require=x.js", text: "console.log(1)\n" }] }));
    expect(dashed.status).toBe(200);
    m.llm.script("chat", [call("run_skill_script", { name: "dash-tool", path: "--require=x.js" })], [text("Done.")]);
    before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "run the dash tool");
    expect(resultsIn(sentSince(before)[1])[0]).toMatchObject({ status: "ran" });
    expect(m.workspace.commands.at(-1)).toMatchObject({ command: "node './--require=x.js'", cwd: ".skills/dash-tool" });
    expect(m.workspace.commands.length).toBe(runs + 2);

    m.llm.script("chat", [call("propose_skill", { name: "csv-clean", description: "Clean CSVs", instructions: "Run scripts/clean.py on the file.", files: [{ path: "scripts/clean.py", text: "print('clean')\n" }] })], [text("Want me to keep it?")]);
    before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "always clean my CSVs this way");
    const card = await m.fixture.db.message.findFirstOrThrow({ where: { userId: m.alex.userId, kind: "skill_proposal" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(card.payload).files).toEqual([{ path: "scripts/clean.py", text: "print('clean')\n" }]);
    const saved = await m.fixture.app.request(`/api/messages/${card.id}/action`, json(m.alex, "POST", { action: "save_skill" }));
    expect(saved.status).toBe(200);
    const skill = await m.fixture.db.skill.findFirstOrThrow({ where: { userId: m.alex.userId, name: "csv-clean" }, include: { files: true } });
    expect([skill.source, skill.files.map((f) => f.path)]).toEqual(["assistant", ["scripts/clean.py"]]);
    m.llm.script("chat", [call("run_skill_script", { name: "csv-clean", path: "scripts/clean.py" })], [text("Needs your OK.")]);
    before = m.llm.sent("chat").length;
    await chatIn(m, m.alex, m.alex.mainChannelId, "clean data.csv");
    expect(resultsIn(sentSince(before)[1])[0]).toMatchObject({ status: "awaiting_approval" });
    // nothing ran for it (the two runs above: my-tool and dash-tool)
    expect(m.workspace.commands.length).toBe(runs + 2);
  });

  test("without Claude's computer there is no run_skill_script", async () => {
    m.workspace.configured = false;
    try {
      m.llm.script("chat", [text("ok")]);
      await chatIn(m, m.alex, m.alex.mainChannelId, "hi");
      const names = offeredNames(m.llm.sent("chat").at(-1));
      expect(names).toContain("use_skill");
      expect(names).not.toContain("run_skill_script");
    } finally {
      m.workspace.configured = true;
    }
  });
});
