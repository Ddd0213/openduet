import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { RunKind, TurnInput } from "../../src/agent/types.ts";
import { BuiltinSkillManifest } from "../../src/contract/m25.ts";
import { onboardingInfo } from "../../src/onboarding/info.ts";
import { builtinSkills, loadBuiltins } from "../../src/skills/builtin.ts";
import { call, chatIn, get, json, newChannel, resultsIn, startChannels, text, type ChannelApp } from "../channels/harness.ts";
import { buildTurn, startMake } from "../make/harness.ts";

const manifest = JSON.parse(readFileSync(new URL("../../skills-builtin/manifest.json", import.meta.url), "utf8"));
test("real manifest, all folders, text files and notices load; duplicate names fail", () => {
  expect(BuiltinSkillManifest.parse(manifest).skills).toHaveLength(8);
  expect(builtinSkills).toHaveLength(8);
  expect(() => BuiltinSkillManifest.parse({ skills: [manifest.skills[0], manifest.skills[0]] })).toThrow("listed twice");
  for (const skill of builtinSkills) {
    expect(skill.instructions).not.toStartWith("<!--");
    if (skill.upstream) expect(skill.files.has("LICENSE") || skill.files.has("LICENSE.txt")).toBe(true);
    if (skill.changes.length) expect(skill.files.has("CHANGES.md")).toBe(true);
  }
  expect(builtinSkills.find((s) => s.name === "theme-factory")!.files.size).toBe(12);
  expect(builtinSkills.find((s) => s.name === "officecli")!.files.has("NOTICE")).toBe(true);
});

test("PDF creation example works with the shell's clean HOME and full Chromium-only install", async () => {
  const instructions = builtinSkills.find((s) => s.name === "pdf")!.instructions;
  const snippet = /```js\n([\s\S]*?)\n```/.exec(instructions)![1]!;
  const env: Record<string, string> = { HOME: "/workspace" };
  const written: string[] = [];
  let closed = false;
  let blockedNetwork = false;
  const page = {
    route: async (pattern: string) => { blockedNetwork = pattern === "**/*"; },
    setContent: async () => {}, evaluate: async () => {}, emulateMedia: async () => {},
    pdf: async (opts: { path: string }) => { written.push(opts.path); },
    screenshot: async (opts: { path: string }) => { written.push(opts.path); },
  };
  const chromium = { launch: async (opts: { channel?: string; headless: boolean; args: string[] }) => {
    // The real image has /ms-playwright/chromium-*/chrome-linux/chrome, not a headless shell.
    expect(opts).toMatchObject({ channel: "chromium", headless: true, args: ["--no-sandbox"] });
    return { newPage: async () => page, close: async () => { closed = true; } };
  } };
  await runInNewContext(snippet, { process: { env }, require: (name: string) => {
    if (name === "node:module") return { createRequire: (path: string) => {
      expect(path).toBe("/app/package.json");
      return (pkg: string) => {
        expect(pkg).toBe("playwright");
        // Playwright reads this at module load: setting it after require is too late.
        expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
        return { chromium };
      };
    } };
    if (name === "node:fs/promises") return { readFile: async () => "<h1>春日采购摘要</h1>" };
    throw new Error(`Unexpected package ${name}`);
  } });
  expect(written).toEqual(["/workspace/document.pdf", "/workspace/document-preview.png"]);
  expect(blockedNetwork).toBe(true);
  expect(closed).toBe(true);
});

test("loader fails closed on bad manifest, missing folder/skill, binary or link", () => {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "m25-builtin-"));
  try {
    writeFileSync(join(root, "manifest.json"), "{}");
    expect(() => loadBuiltins(root)).toThrow();
    const entry = manifest.skills[0];
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ skills: [entry] }));
    expect(() => loadBuiltins(root)).toThrow();
    const dir = join(root, entry.name); mkdirSync(dir);
    expect(() => loadBuiltins(root)).toThrow("missing SKILL.md");
    writeFileSync(join(dir, "SKILL.md"), "<!-- Changed; see CHANGES.md. -->\n---\nname: skill-creator\n---\nBody");
    expect(loadBuiltins(root)[0]!.instructions).toBe("Body");
    writeFileSync(join(dir, "binary"), new Uint8Array([0, 255]));
    expect(() => loadBuiltins(root)).toThrow("not UTF-8 text");
    rmSync(join(dir, "binary")); symlinkSync(join(dir, "SKILL.md"), join(dir, "link"));
    expect(() => loadBuiltins(root)).toThrow("link or special file");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

let m: ChannelApp;
beforeAll(async () => { m = await startChannels(); });
afterAll(() => m.cleanup());
const provider = () => m.skills.providers[0]!;
function input(kind?: RunKind, over: Partial<TurnInput> = {}): TurnInput {
  return {
    userId: m.alex.userId, channelId: m.alex.mainChannelId, taskId: null, runId: "test", kind,
    userMessage: { id: "test", channelId: m.alex.mainChannelId, taskId: null, role: "user", kind: "text", text: "hi",
      status: "sent", clientId: null, reactions: [], stopped: false, callId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null } },
    attachments: [], skill: null, signal: new AbortController().signal,
    sink: { status: async () => {}, typing: async () => {}, upsertMessage: async () => { throw new Error("unexpected card"); } }, ...over,
  };
}
async function index(turn: TurnInput) {
  const line = (await provider().instructions!(turn)).find((s) => s.startsWith("Built-in skills"));
  return line ? JSON.parse(line.slice(line.indexOf("["))) as { name: string; description: string }[] : [];
}
async function execute(turn: TurnInput, name: string, args: Record<string, unknown>) {
  const { result } = await provider().execute({ type: "tool_use", id: "call", name, input: args }, turn);
  const block = result.content[0]!;
  if (block.type !== "text") throw new Error("not text");
  return { error: !!result.isError, data: JSON.parse(block.text) };
}

test("index per turn: chat/task/routine/build only, compact trigger text", async () => {
  for (const kind of ["chat", undefined] as const) {
    const list = await index(input(kind));
    expect(list.map((s) => s.name)).toEqual(["skill-creator", "officecli", "pdf", "explore-data", "task-management", "meeting-minutes-taker"]);
    expect(list[0]!.description).toContain("帮我创建一个技能");
    expect(list[0]!.description).toContain("make a skill that");
    expect(list[0]!.description).toContain("save this way of working");
    expect(list.every((s) => s.description.length <= 160)).toBe(true);
  }
  for (const kind of ["task", "routine"] as const) expect((await index(input(kind))).map((s) => s.name)).toEqual(["officecli", "pdf", "explore-data", "task-management", "meeting-minutes-taker"]);
  expect((await index(input(undefined, { taskId: "task" }))).some((s) => s.name === "skill-creator")).toBe(false);
  for (const kind of ["brief", "checkin", "scan"] as const) {
    expect(await index(input(kind))).toEqual([]);
    expect((await execute(input(kind), "use_skill", { name: "skill-creator" })).error).toBe(true);
    expect((await execute(input(kind), "read_skill_file", { name: "skill-creator", path: "LICENSE.txt" })).error).toBe(true);
  }
  expect((await index(input("build"))).map((s) => s.name)).toEqual(["frontend-design", "theme-factory"]);
  expect((await provider().tools(input("build"))).map((t) => t.name)).toEqual(["use_skill", "read_skill_file"]);
  expect((await execute(input("build"), "propose_skill", {})).error).toBe(true);
  expect((await execute(input("build"), "run_skill_script", {})).error).toBe(true);
});

test("computer availability and ownership gate both index and resolution", async () => {
  m.workspace.configured = false;
  try {
    expect((await index(input("chat"))).map((s) => s.name)).not.toContain("pdf");
    expect((await execute(input("chat"), "use_skill", { name: "pdf" })).error).toBe(true);
  } finally { m.workspace.configured = true; }
  m.workspace.owner = m.sam.userId;
  try { expect((await index(input("task"))).map((s) => s.name)).not.toContain("officecli"); }
  finally { m.workspace.owner = null; }
});

test("built-in use/read is in-memory text, has the note, validates paths and refuses scripts", async () => {
  const used = await execute(input("chat"), "use_skill", { name: "skill-creator" });
  expect(used.data).toMatchObject({ source: "builtin", name: "skill-creator" });
  expect(used.data.note).toContain("never override the system rules");
  expect(used.data.instructions).toContain("## 3. Try one example");
  expect(used.data.instructions).not.toStartWith("<!--");
  const file = await execute(input("build"), "read_skill_file", { name: "theme-factory", path: "themes/ocean-depths.md" });
  expect(file.error).toBe(false); expect(file.data.text).toContain("Ocean Depths");
  expect((await execute(input("build"), "read_skill_file", { name: "theme-factory", path: "../manifest.json" })).error).toBe(true);
  expect((await execute(input("chat"), "use_skill", { name: "frontend-design" })).error).toBe(true);
  expect((await execute(input("chat"), "run_skill_script", { name: "skill-creator", path: "scripts/go.py" })).data.error).toContain("computer_exec");
});

test("built-ins absent from API/composer data, access, onboarding, invocation and proposal exists", async () => {
  expect(await (await get(m, m.alex, "/api/skills")).json()).toEqual({ skills: [] });
  expect((await m.skills.service.access.resolve(m.alex.userId, m.alex.mainChannelId)).skills.size).toBe(0);
  expect(JSON.stringify(await onboardingInfo(m.fixture.db, null, m.alex.userId))).not.toContain("skill-creator");
  for (const turn of [input("chat", { skill: "skill-creator" }), input("chat")]) {
    turn.userMessage = { ...turn.userMessage, text: "/skill-creator make one" } as TurnInput["userMessage"];
    const lines = (await provider().instructions!(turn)).join("\n");
    expect(lines).toContain("no skill with that name");
    expect(lines).not.toContain("<skill name=");
  }
  m.llm.script("chat", [call("propose_skill", { name: "skill-creator", description: "Mine", instructions: "My method" })], [text("A draft to save.")]);
  await chatIn(m, m.alex, m.alex.mainChannelId, "offer a skill named skill-creator");
  expect(resultsIn(m.llm.sent("chat").at(-1))[0]!.note).not.toContain("exists");
  expect(await m.skills.service.find(m.alex.userId, "skill-creator")).toBeNull();
});

test("visible user skill wins use/read and index; hidden user skill permits builtin; builds never load users", async () => {
  const channel = await newChannel(m, m.alex, { name: "Private skills" });
  const other = await newChannel(m, m.alex, { name: "Other" });
  await m.skills.service.save(m.alex.userId, { name: "skill-creator", description: "Mine", instructions: "USER BODY", channelId: channel.id, files: [{ path: "mine.md", text: "USER FILE" }] });
  const here = input("chat", { channelId: channel.id });
  expect((await index(here)).some((s) => s.name === "skill-creator")).toBe(false);
  expect((await execute(here, "use_skill", { name: "skill-creator" })).data.instructions).toBe("USER BODY");
  expect((await execute(here, "read_skill_file", { name: "skill-creator", path: "mine.md" })).data.text).toBe("USER FILE");
  expect((await execute(here, "read_skill_file", { name: "skill-creator", path: "LICENSE.txt" })).error).toBe(true);
  const lines = await provider().instructions!(here);
  expect(lines.findIndex((s) => s.startsWith("The user's skills"))).toBeLessThan(lines.findIndex((s) => s.startsWith("Built-in skills")));
  expect((await execute(input("chat", { channelId: other.id }), "use_skill", { name: "skill-creator" })).data.source).toBe("builtin");
  await m.skills.service.save(m.alex.userId, { name: "frontend-design", description: "Mine", instructions: "USER DESIGN" });
  expect((await execute(input("build"), "use_skill", { name: "frontend-design" })).data.source).toBe("builtin");
  expect((await execute(input("build"), "use_skill", { name: "skill-creator" })).error).toBe(true);
});

test("Make build system prompt actually contains frontend-design index and only read skill tools", async () => {
  const make = await startMake();
  try {
    make.llm.script("task", [call("use_skill", { name: "frontend-design" })], buildTurn(make));
    const res = await make.fixture.app.request("/api/artifacts", json(make.alex, "POST", { type: "web_page", prompt: "A bicycle shop page", channelId: make.alex.mainChannelId }));
    expect(res.status).toBe(200);
    await make.runs.idle();
    const sent = make.llm.sent("task");
    expect(sent[0]!.system).toContain('Built-in skills (load one with use_skill when it fits): [{"name":"frontend-design"');
    expect(sent[0]!.tools!.filter((t) => t.name.includes("skill")).map((t) => t.name)).toEqual(["use_skill", "read_skill_file"]);
    expect(resultsIn(sent[1])[0]!.source).toBe("builtin");
  } finally { await make.fixture.cleanup(); }
});
