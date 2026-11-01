import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComputerClient } from "../../src/computer/client.ts";
import { FILE_TEXT_MAX, readFileText } from "../../src/computer/file-tools.ts";
import { schemas } from "../../src/computer/tools.ts";
import { describeCall } from "../../src/runs/describe.ts";
import { Redactor } from "../../src/runs/redact.ts";
import { FAKE_TOKEN, FAKE_URL, FakeComputer } from "./fake-computer.ts";

let fake: FakeComputer, client: ComputerClient;
beforeEach(() => {
  fake = new FakeComputer();
  client = new ComputerClient({ baseUrl: FAKE_URL, token: FAKE_TOKEN, botId: "test", fetch: fake.fetch });
});
afterEach(() => fake.cleanup());
const put = (path: string, body: string | Uint8Array) => writeFileSync(join(fake.root, path), body);

describe("M27 ranged file read", () => {
  test("reads line 20,000 of a 30,000-line CSV with byte and range metadata", async () => {
    const body = Array.from({ length: 30_000 }, (_, n) => `${n + 1},value\n`).join("");
    put("data.csv", body);
    expect(await readFileText(client, { path: "/workspace/data.csv", offset: 20_000, limit: 2 })).toEqual({
      path: "data.csv", text: "20000,value\n20001,value\n", fromLine: 20_000, toLine: 20_001, totalLines: 30_000, truncated: true, bytes: Buffer.byteLength(body),
    });
    expect(fake.calls.map(c => c.path)).toEqual(["/files/download"]);
  });
  test("no range keeps the beginning; limit alone and offset alone work", async () => {
    put("notes.md", "one\r\ntwo\nthree");
    expect(await readFileText(client, { path: "notes.md" })).toMatchObject({ text: "one\r\ntwo\nthree", fromLine: 1, toLine: 3, totalLines: 3, truncated: false });
    expect(await readFileText(client, { path: "notes.md", limit: 1 })).toMatchObject({ text: "one\r\n", toLine: 1, truncated: true });
    expect(await readFileText(client, { path: "notes.md", offset: 2 })).toMatchObject({ text: "two\nthree", fromLine: 2, toLine: 3, truncated: false });
  });
  test("past EOF and empty file are empty, not truncated; trailing newline is not an extra line", async () => {
    put("notes.md", "one\ntwo\n");
    expect(await readFileText(client, { path: "notes.md", offset: 9 })).toMatchObject({ text: "", fromLine: 9, toLine: 2, totalLines: 2, truncated: false });
    put("empty", "");
    expect(await readFileText(client, { path: "empty" })).toMatchObject({ text: "", fromLine: 1, toLine: 0, totalLines: 0, truncated: false });
  });
  test("character cap, including a single long line", async () => {
    put("large", "x".repeat(FILE_TEXT_MAX + 100));
    const read = await readFileText(client, { path: "large" });
    expect(read.text.length).toBe(FILE_TEXT_MAX);
    expect(read).toMatchObject({ totalLines: 1, toLine: 1, truncated: true });
  });
  test("refuses invalid UTF-8, files above 10 MiB, missing files and symlink escapes", async () => {
    put("binary", new Uint8Array([0xc3, 0x28]));
    await expect(readFileText(client, { path: "binary" })).rejects.toThrow("not valid UTF-8");
    put("large", ""); truncateSync(join(fake.root, "large"), 10 * 1024 * 1024 + 1);
    await expect(readFileText(client, { path: "large" })).rejects.toThrow("too_large");
    await expect(readFileText(client, { path: "missing" })).rejects.toThrow("not_found");
    symlinkSync("/", join(fake.root, "escape"));
    await expect(readFileText(client, { path: "escape/etc/passwd" })).rejects.toThrow("forbidden");
    expect(fake.calls.some(c => c.path === "/files/read")).toBe(false);
  });
  test("old computer falls back only for a missing route and refuses any offset", async () => {
    fake.noDownload = true; put("notes", "one\ntwo\n");
    expect(await readFileText(client, { path: "notes", limit: 1 })).toMatchObject({ text: "one\n", totalLines: 2, truncated: true });
    await expect(readFileText(client, { path: "notes", offset: 1 })).rejects.toThrow("older computer");
    expect(fake.calls.filter(c => c.path === "/files/read").length).toBe(1);
    put("large", "x\n".repeat(40_000));
    expect(await readFileText(client, { path: "large" })).toMatchObject({ totalLines: null, truncated: true, bytes: 80_000 });
  });
  test("schema refuses zero, negative and fractional ranges; run detail shows path and range", () => {
    for (const args of [{ offset: 0 }, { offset: -1 }, { limit: 0 }, { limit: 1.5 }]) expect(schemas.computer_files_read.safeParse({ path: "notes", ...args }).success).toBe(false);
    const view = describeCall({ type: "tool_use", id: "read", name: "computer_files_read", input: { path: "notes", offset: 20, limit: 3 } }, new Redactor());
    expect(view.detail).toBe("notes (lines 20–22)");
  });
});
