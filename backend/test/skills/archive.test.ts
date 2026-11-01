// M11 skill archives: safe paths, the tar reader (traversal rejects the archive, links are
// skipped), the zip reader (stored + deflated, symlinks skipped, zip-bomb limits, a lying size
// field), the stored-zip writer round trip, and collecting skill folders from an archive.
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { ArchiveError, readTar, readZip, safeRelative, writeZip } from "../../src/skills/archive.ts";
import { collectSkills, parseSkillMd } from "../../src/skills/folder.ts";
import { fromZip, ImportError, parseGitHubUrl } from "../../src/skills/importer.ts";
import { skillMd, tar, zip } from "./archives.ts";

const LIMITS = { maxEntries: 200, maxBytes: 20 * 1024 * 1024 };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("safeRelative", () => {
  test("keeps relative paths, refuses traversal, absolute paths, drive letters and backslashes", () => {
    expect(safeRelative("scripts/report.py")).toBe("scripts/report.py");
    expect(safeRelative("dir/")).toBe("dir");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a//b", "./a", "", "a/\u0000b"]) expect(safeRelative(bad)).toBeNull();
  });
});

describe("readTar", () => {
  test("files and pax-free ustar headers; directories implied; symlinks skipped and reported", () => {
    const out = readTar(tar([
      { path: "repo-abc/", type: "dir" },
      { path: "repo-abc/SKILL.md", data: "hello" },
      { path: "repo-abc/link", type: "symlink", link: "/etc/passwd" },
    ]), LIMITS);
    expect(out.files.map((f) => [f.path, text(f.bytes)])).toEqual([["repo-abc/SKILL.md", "hello"]]);
    expect(out.skipped).toEqual(["repo-abc/link"]);
  });

  test("a path that leaves the folder rejects the whole archive; limits hold", () => {
    expect(() => readTar(tar([{ path: "repo/../../evil.sh", data: "x" }]), LIMITS)).toThrow(ArchiveError);
    expect(() => readTar(tar([{ path: "/etc/cron.d/x", data: "x" }]), LIMITS)).toThrow(ArchiveError);
    expect(() => readTar(tar([{ path: "a", data: "1" }, { path: "b", data: "2" }]), { maxEntries: 1, maxBytes: 100 })).toThrow(/more than 1 entries/);
    expect(() => readTar(tar([{ path: "a", data: "x".repeat(200) }]), { maxEntries: 10, maxBytes: 100 })).toThrow(/unpacks to more than/);
    const damaged = tar([{ path: "a", data: "x" }]);
    damaged[0] = 0x7a;
    expect(() => readTar(damaged, LIMITS)).toThrow(/damaged/);
  });

  test("a negative or unreadable entry size is a damaged archive (it used to loop forever on x / L / g)", () => {
    // One header with this type and size field, the checksum recomputed so only the size is wrong.
    const crafted = (type: string, size: string) => {
      const out = tar([{ path: "x", data: "" }, { path: "after.txt", data: "after" }]);
      const header = out.subarray(0, 512);
      header.fill(0, 124, 136);
      header.set(new TextEncoder().encode(size), 124);
      header[156] = type.charCodeAt(0);
      header.fill(32, 148, 156);
      let sum = 0;
      for (const byte of header) sum += byte;
      header.fill(0, 148, 156);
      header.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
      return out;
    };
    // -1000 puts the next offset back on this header: an endless loop before the fix.
    for (const type of ["x", "L", "g"]) {
      for (const size of ["-1000", "-1", "-0000001000"]) expect(() => readTar(crafted(type, size), LIMITS)).toThrow(/bad entry size/);
    }
    for (const size of ["-1", "zz", "99999999999999999999"]) expect(() => readTar(crafted("0", size), LIMITS)).toThrow(ArchiveError);
    // the same header with a real size still reads
    expect(readTar(crafted("0", "0000000"), LIMITS).files.map((f) => f.path)).toEqual(["x", "after.txt"]);
  });

  test("a file path twice rejects the archive (a link with a file's path is still just skipped)", () => {
    expect(() => readTar(tar([{ path: "s/a.txt", data: "1" }, { path: "s/a.txt", data: "2" }]), LIMITS)).toThrow(/s\/a\.txt twice/);
    const out = readTar(tar([{ path: "s/a.txt", data: "1" }, { path: "s/a.txt", type: "symlink", link: "b" }]), LIMITS);
    expect([out.files.map((f) => f.path), out.skipped]).toEqual([["s/a.txt"], ["s/a.txt"]]);
  });
});

describe("readZip", () => {
  test("stored and deflated entries; __MACOSX and directories ignored; symlinks skipped", () => {
    const out = readZip(zip([
      { path: "skill/SKILL.md", data: "stored body" },
      { path: "skill/scripts/run.py", data: "print('hi')\n".repeat(50), deflate: true },
      { path: "skill/link", data: "/etc/passwd", symlink: true },
      { path: "__MACOSX/skill/._SKILL.md", data: "junk" },
    ]), LIMITS);
    expect(out.files.map((f) => f.path)).toEqual(["skill/SKILL.md", "skill/scripts/run.py"]);
    expect(text(out.files[1]!.bytes)).toBe("print('hi')\n".repeat(50));
    expect(out.skipped).toEqual(["skill/link"]);
  });

  test("zip-bomb limits: too many entries, too much unpacked, a size field that lies; traversal rejects", () => {
    const many = zip(Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.txt`, data: "x" })));
    expect(() => readZip(many, LIMITS)).toThrow(/more than 200 entries/);
    // 21 MB of zeros deflates to a few KB; refused from the declared size before inflating.
    const bomb = new Uint8Array(21 * 1024 * 1024);
    const packed = zip([{ path: "big.bin", data: new Uint8Array(deflateRawSync(bomb)), declaredSize: bomb.length }]);
    expect(packed.length).toBeLessThan(200_000);
    expect(() => readZip(packed, LIMITS)).toThrow(/unpacks to more than 20 MB/);
    // Declares 10 bytes, inflates to 1000: never more than declared is inflated.
    expect(() => readZip(zip([{ path: "liar.txt", data: "a".repeat(1000), deflate: true, declaredSize: 10 }]), LIMITS)).toThrow(ArchiveError);
    expect(() => readZip(zip([{ path: "../evil", data: "x" }]), LIMITS)).toThrow(/Unsafe path/);
    expect(() => readZip(new TextEncoder().encode("not a zip at all"), LIMITS)).toThrow(/isn't a zip/);
  });

  test("a file path twice rejects the zip (it used to hit the unique constraint on save)", () => {
    expect(() => readZip(zip([{ path: "s/a.txt", data: "1" }, { path: "s/a.txt", data: "2", deflate: true }]), LIMITS)).toThrow(/s\/a\.txt twice/);
    expect(() => fromZip(zip([{ path: "SKILL.md", data: skillMd("x", "X", "Body") }, { path: "a.md", data: "1" }, { path: "a.md", data: "2" }]))).toThrow(ImportError);
  });

  test("writeZip round trip", () => {
    const files = [{ path: "a/SKILL.md", bytes: new TextEncoder().encode("---\nname: a\n---\nbody") }, { path: "a/bin.dat", bytes: new Uint8Array([0, 1, 2, 255]) }];
    const out = readZip(writeZip(files), LIMITS);
    expect(out.files.map((f) => [f.path, [...f.bytes]])).toEqual(files.map((f) => [f.path, [...f.bytes]]));
  });
});

describe("skill folders", () => {
  test("every folder with a SKILL.md is a candidate; names normalized or skipped with warnings", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const found = collectSkills([
      { path: "skills/pdf-tools/SKILL.md", bytes: enc(skillMd("pdf-tools", "Work with PDFs", "Use the scripts.")) },
      { path: "skills/pdf-tools/scripts/fill.py", bytes: enc("print(1)") },
      { path: "skills/Odd Name/SKILL.md", bytes: enc(skillMd("Odd Name!", "x", "Body")) },
      { path: "skills/empty/SKILL.md", bytes: enc(skillMd("empty", "x", "")) },
      { path: "docs/readme.md", bytes: enc("# docs") },
    ], "");
    expect(found.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["odd-name", []], ["pdf-tools", ["scripts/fill.py"]]]);
    expect(found.warnings).toEqual(expect.arrayContaining(["skills/empty: SKILL.md has no instructions", "docs/: no SKILL.md"]));
    expect(found.warnings.some((w) => w.includes("imported as odd-name"))).toBe(true);
    expect(parseSkillMd(skillMd("a", "long\ndesc", "Body")).meta.description).toBe("long\ndesc");
  });

  test("fromZip: one skill at the root; a zip without SKILL.md is a 400 ImportError", () => {
    const one = fromZip(zip([{ path: "SKILL.md", data: skillMd("root-skill", "At the root", "Do it.") }]));
    expect(one.skills.map((s) => s.name)).toEqual(["root-skill"]);
    expect(() => fromZip(zip([{ path: "readme.txt", data: "x" }]))).toThrow(ImportError);
  });

  test("GitHub URLs: repo, tree/<ref>/<path>, blob/.../SKILL.md; anything else refused", () => {
    expect(parseGitHubUrl("https://github.com/acme/skills")).toEqual({ owner: "acme", repo: "skills", ref: null, path: "" });
    expect(parseGitHubUrl("https://github.com/acme/skills/tree/main/pdf")).toEqual({ owner: "acme", repo: "skills", ref: "main", path: "pdf" });
    expect(parseGitHubUrl("https://github.com/acme/skills/blob/v1/pdf/SKILL.md")).toEqual({ owner: "acme", repo: "skills", ref: "v1", path: "pdf" });
    for (const bad of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/tree/main/x%2F..%2F..%2Fy", "https://user:pw@github.com/a/b", "https://github.com/a/b/blob/main/README.md"]) {
      expect(parseGitHubUrl(bad)).toBeNull();
    }
  });
});
