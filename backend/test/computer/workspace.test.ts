// The Workspace seam (createWorkspace) and the thin client against the fake computer: token header,
// path checks, exact text and binary round trips (chunked through the real shell), symlink escapes,
// the 25 MB cap, audit rows by path / program name only, and "not configured".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, AuditSink } from "../../src/computer/audit.ts";
import { ComputerClient, ComputerError } from "../../src/computer/client.ts";
import { workspacePath, WorkspacePathError, execTarget } from "../../src/computer/paths.ts";
import { createWorkspace, WorkspaceError } from "../../src/computer/workspace-impl.ts";
import { FAKE_TOKEN, FAKE_URL, FakeComputer } from "./fake-computer.ts";

class RecordingAudit implements AuditSink {
  readonly rows: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> { this.rows.push(entry); }
}

let fake: FakeComputer;
let client: ComputerClient;
const audit = new RecordingAudit();

beforeAll(() => {
  fake = new FakeComputer();
  client = new ComputerClient({ baseUrl: FAKE_URL, token: FAKE_TOKEN, botId: "duet", fetch: fake.fetch });
});
afterAll(() => fake.cleanup());

describe("paths", () => {
  test("relative paths only", () => {
    expect(workspacePath("a/./b//c.txt")).toBe("a/b/c.txt");
    expect(workspacePath("/workspace/out/x.html")).toBe("out/x.html");
    expect(workspacePath(".", { allowRoot: true })).toBe(".");
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "~/x", "C:\\x", "a\u0000b", "", ".", "/workspace/../etc"]) {
      expect(() => workspacePath(bad)).toThrow(WorkspacePathError);
    }
  });

  test("audit target of a command is the program name only", () => {
    expect(execTarget("git clone https://user:secret@example.com/x.git")).toBe("git");
    expect(execTarget("/usr/bin/python3 -c 'print(1)'")).toBe("python3");
    expect(execTarget("FOO=secret node x.js")).toBe("shell");
  });
});

describe("client", () => {
  test("sends the token header and bot id; maps errors", async () => {
    await client.snapshot();
    const last = fake.calls.at(-1)!;
    expect(last.token).toBe(FAKE_TOKEN);
    expect(last.botId).toBe("duet");
    const wrong = new ComputerClient({ baseUrl: FAKE_URL, token: "x".repeat(30), botId: "duet", fetch: fake.fetch });
    const error = await wrong.snapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).kind).toBe("unauthorized");
    expect((error as ComputerError).message).not.toContain(FAKE_TOKEN);
    fake.takeOver();
    const busy = await client.navigate("https://example.com").catch((e: unknown) => e as ComputerError);
    expect((busy as ComputerError).kind).toBe("human_in_control");
    fake.holder = "bot"; fake.request = null;
    fake.resumeSnapshotRequired = true;
    const stale = await client.click("s1e1", undefined).catch((e: unknown) => e as ComputerError);
    expect((stale as ComputerError).kind).toBe("snapshot_required");
    fake.resumeSnapshotRequired = false;
    fake.down = true;
    expect(((await client.read().catch((e: unknown) => e)) as ComputerError).kind).toBe("unreachable");
    fake.down = false;
  });

  test("the stream URL carries the token for the internal hop only", () => {
    const url = new URL(client.streamUrl());
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("bot")).toBe("duet");
    expect(url.searchParams.get("token")).toBe(FAKE_TOKEN);
  });
});
describe("createWorkspace", () => {
  test("not configured: configured false, every call rejects", async () => {
    const none = createWorkspace(null);
    expect(none.configured).toBe(false);
    const error = await none.readFile("u1", "a.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).reason).toBe("not_configured");
    expect(((await none.exec("u1", "ls").catch((e: unknown) => e)) as WorkspaceError).reason).toBe("not_configured");
  });

  test("text round trip is exact (UTF-8, Chinese, BOM), audited by path only", async () => {
    const ws = createWorkspace(client, { audit });
    const text = "\uFEFF<h1>你好, Duet</h1>\nline 2\n";
    await ws.writeFile("u1", "site/index.html", new TextEncoder().encode(text), { runId: "run-1" });
    expect(readFileSync(join(fake.root, "site/index.html"), "utf8")).toBe(text);
    const back = await ws.readFile("u1", "/workspace/site/index.html");
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(back)).toBe(text);
    const rows = audit.rows.filter((r) => r.target === "site/index.html");
    expect(rows.map((r) => r.action)).toEqual(["computer_files_write", "computer_files_read"]);
    expect(rows.every((r) => r.outcome === "ok" && r.actor === "assistant")).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain("你好");
    expect(rows[0]!.runId).toBe("run-1");
  });

  test("binary bytes round trip exactly, in chunks through the shell", async () => {
    const ws = createWorkspace(client, { audit });
    const bytes = new Uint8Array(1_300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 8)) & 0xff;
    bytes[0] = 0x89; bytes[1] = 0x50; bytes[2] = 0x00;
    await ws.writeFile("u1", "bin/data.bin", bytes);
    expect(new Uint8Array(readFileSync(join(fake.root, "bin/data.bin")))).toEqual(bytes);
    const execsBefore = fake.calls.filter((c) => c.path === "/exec").length;
    const back = await ws.readFile("u1", "bin/data.bin");
    expect(back.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    // M20: read back through GET /files/download, not the shell.
    expect(fake.calls.at(-1)).toMatchObject({ method: "GET", path: "/files/download", body: { path: "bin/data.bin" } });
    expect(fake.calls.filter((c) => c.path === "/exec").length).toBe(execsBefore);
    // No temp folders left behind.
    expect(fake.calls.filter((c) => c.path === "/files/write").length).toBeGreaterThan(2);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(fake.root).some((n) => n.startsWith(".duet-upload-"))).toBe(false);
  });

  test("reads work while the user holds the browser (/files/download isn't an acting route)", async () => {
    const ws = createWorkspace(client, { audit });
    writeFileSync(join(fake.root, "held.bin"), Buffer.from([0, 1, 2, 0xff]));
    fake.takeOver();
    try {
      expect(Array.from(await ws.readFile("u1", "held.bin"))).toEqual([0, 1, 2, 0xff]);
      // Writes are refused by the computer itself while a person holds it (ACTING_PATHS).
      const refused = await ws.writeFile("u1", "held.txt", new TextEncoder().encode("x")).catch((e: unknown) => e);
      expect((refused as ComputerError).kind).toBe("human_in_control");
    } finally {
      fake.holder = "bot"; fake.request = null;
    }
  });

  test("an older computer without /files/download: reads fall back to the old path", async () => {
    const ws = createWorkspace(client, { audit });
    writeFileSync(join(fake.root, "old.txt"), "plain text\n");
    writeFileSync(join(fake.root, "old.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    fake.noDownload = true;
    try {
      expect(new TextDecoder().decode(await ws.readFile("u1", "old.txt"))).toBe("plain text\n");
      expect(Array.from(await ws.readFile("u1", "old.bin"))).toEqual([0x89, 0x50, 0x00, 0x01]);
      expect(fake.calls.some((c) => c.path === "/files/read" && (c.body as { path?: string }).path === "old.txt")).toBe(true);
    } finally {
      fake.noDownload = false;
    }
  });

  test("refuses escapes, symlinks and files above the cap", async () => {
    const ws = createWorkspace(client, { audit });
    expect(((await ws.readFile("u1", "../etc/passwd").catch((e: unknown) => e)) as WorkspaceError).reason).toBe("invalid_path");
    expect(((await ws.writeFile("u1", "/etc/x", new Uint8Array([1])).catch((e: unknown) => e)) as WorkspaceError).reason).toBe("invalid_path");
    const outside = join(fake.root, "..", `outside-${Date.now()}.bin`);
    writeFileSync(outside, Buffer.from([0, 1, 2, 3, 0xff]));
    symlinkSync(outside, join(fake.root, "link.bin"));
    const linked = await ws.readFile("u1", "link.bin").catch((e: unknown) => e);
    expect(linked).toBeInstanceOf(Error);
    mkdirSync(join(fake.root, "big"), { recursive: true });
    writeFileSync(join(fake.root, "big/huge.bin"), Buffer.from([0xff, 0xfe]));
    truncateSync(join(fake.root, "big/huge.bin"), 26 * 1024 * 1024);
    const big = await ws.readFile("u1", "big/huge.bin").catch((e: unknown) => e);
    expect((big as WorkspaceError).reason).toBe("too_large");
    expect(((await ws.readFile("u1", "nope.txt").catch((e: unknown) => e)) as WorkspaceError).reason).toBe("not_found");
    const { rmSync } = await import("node:fs");
    rmSync(outside, { force: true });
  });

  test("exec runs in /workspace (or a folder in it); audits the program name only", async () => {
    const ws = createWorkspace(client, { audit });
    mkdirSync(join(fake.root, "proj"), { recursive: true });
    const result = await ws.exec("u1", "pwd && echo secret-arg-123 >/dev/null && echo done", { cwd: "proj", runId: "run-2" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${fake.root}/proj`);
    const row = audit.rows.findLast((r) => r.action === "computer_exec")!;
    expect(row.target).toBe("pwd");
    expect(JSON.stringify(audit.rows)).not.toContain("secret-arg-123");
    expect(((await ws.exec("u1", "ls", { cwd: "../" }).catch((e: unknown) => e)) as WorkspaceError).reason).toBe("invalid_path");
  });
});

test("M26 workspace deletion is confined, audited, idempotent for missing files and owner-gated", async () => {
  const ws = createWorkspace(client, { audit, allows: async (id) => id === "owner" });
  writeFileSync(join(fake.root, "delete-me.txt"), "private contents");
  const before = fake.calls.length;
  const denied = await ws.deleteFileAs("other", "delete-me.txt", { actor: "user" }).catch((error: unknown) => error);
  expect((denied as WorkspaceError).reason).toBe("not_configured");
  expect(fake.calls).toHaveLength(before);
  expect(await ws.deleteFileAs("owner", "delete-me.txt", { actor: "user" })).toBe("deleted");
  expect(await ws.deleteFileAs("owner", "delete-me.txt", { actor: "user" })).toBe("missing");
  expect(audit.rows.filter((row) => row.action === "computer_files_delete").map((row) => [row.actor, row.target, row.outcome])).toEqual([
    ["user", "delete-me.txt", "error"], ["user", "delete-me.txt", "ok"], ["user", "delete-me.txt", "ok"],
  ]);
  expect(JSON.stringify(audit.rows)).not.toContain("private contents");
});
