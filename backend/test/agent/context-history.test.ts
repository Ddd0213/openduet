// M21 buildContext history: earlier messages name the files sent with them (item 4: "that PDF I
// sent earlier" has something to point at) and a reply cut short by Stop says so (item 7).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { STOPPED_MARK, attachedLine, buildContext, historyText } from "../../src/agent/context.ts";
import type { Db } from "../../src/db.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { now, turnFixture } from "./fixtures.ts";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  cleanup = database.cleanup;
});
afterAll(() => cleanup());

const at = (minutes: number) => new Date(now().getTime() - minutes * 60_000);
const textOf = (message: { content: { type: string; text?: string }[] }) => message.content.map((b) => b.text ?? "").join("\n");

describe("earlier attachments in the history", () => {
  test("a user message names its files; one without text reads as the files, not [attachment]", async () => {
    const { input } = await turnFixture(db);
    const { userId, channelId } = input;
    const message = (role: string, text: string, minutes: number, payload: Record<string, unknown> = { skill: null }, kind = "text") =>
      db.message.create({ data: { userId, channelId, role, kind, text, payload: JSON.stringify(payload), createdAt: at(minutes) } });
    const file = (messageId: string | null, name: string, mime: string, minutes: number) =>
      db.channelFile.create({ data: { userId, channelId, messageId, path: `${crypto.randomUUID()}.bin`, name, mime, size: 10, source: "user", createdAt: at(minutes) } });

    const withText = await message("user", "Keep this for later", 30);
    await file(withText.id, "Q3 report.pdf", "application/pdf", 30);
    await file(withText.id, "chart.png", "image/png", 30);
    await message("assistant", "Got it.", 29);
    const bare = await message("user", "", 20);
    await file(bare.id, "notes.txt", "text/plain", 20);
    await message("assistant", "Saved.", 19);
    // Claude's own shared file names the file (its card payload), with the caption.
    await message("assistant", "", 10, { file: { id: "f_1", name: "summary.csv", mime: "text/csv" }, caption: "Here's the table." }, "file");
    // A draft upload (not sent yet) never shows up.
    await file(null, "draft.pdf", "application/pdf", 5);

    const ctx = await buildContext(db, input, now());
    const joined = ctx.messages.map(textOf).join("\n---\n");
    expect(joined).toContain('Keep this for later\n[Attached: "Q3 report.pdf" (application/pdf), "chart.png" (image/png)]');
    expect(joined).toContain('[Attached: "notes.txt" (text/plain)]');
    expect(joined).not.toContain("[attachment]");
    expect(joined).toContain('[file "summary.csv" (text/csv)] Here\'s the table.');
    expect(joined).not.toContain("draft.pdf");
    // The current turn is untouched: still just the user's text.
    expect(textOf(ctx.messages.at(-1)!)).toBe("帮我看看");
  });

  test("the files of a task session's messages are named the same way", async () => {
    const { input } = await turnFixture(db, true);
    const { userId, channelId, taskId } = input;
    const row = await db.message.create({ data: { userId, channelId, taskId, role: "user", text: "Use this contract", payload: JSON.stringify({ skill: null }), createdAt: at(15) } });
    await db.channelFile.create({ data: { userId, channelId, messageId: row.id, path: "c.bin", name: "contract.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 10, source: "user" } });
    const ctx = await buildContext(db, input, now());
    expect(ctx.messages.map(textOf).join("\n")).toContain('Use this contract\n[Attached: "contract.docx" (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]');
  });

  test("the line names at most five files", () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ name: `p${i}.jpg`, mime: "image/jpeg" }));
    expect(attachedLine(files)).toBe('[Attached: "p0.jpg" (image/jpeg), "p1.jpg" (image/jpeg), "p2.jpg" (image/jpeg), "p3.jpg" (image/jpeg), "p4.jpg" (image/jpeg) and 2 more]');
    expect(historyText("text", "", {}, undefined, [])).toBe("[attachment]");
    expect(historyText("image", "", {})).toBe("[image]");
  });
});

describe("a reply cut short by Stop", () => {
  test("is marked in the history the next turn reads; a finished reply isn't", async () => {
    const { input } = await turnFixture(db);
    const { userId, channelId } = input;
    await db.message.create({ data: { userId, channelId, role: "user", text: "Write me a long plan", payload: JSON.stringify({ skill: null }), createdAt: at(10) } });
    await db.message.create({ data: { userId, channelId, role: "assistant", text: "Step one: book the", payload: JSON.stringify({ skill: null, stopped: true }), createdAt: at(9) } });
    await db.message.create({ data: { userId, channelId, role: "user", text: "Actually, shorter", payload: JSON.stringify({ skill: null }), createdAt: at(8) } });
    await db.message.create({ data: { userId, channelId, role: "assistant", text: "Sure.", payload: JSON.stringify({ skill: null }), createdAt: at(7) } });
    const ctx = await buildContext(db, input, now());
    const assistant = ctx.messages.filter((m) => m.role === "assistant").map(textOf);
    expect(assistant.join("\n")).toContain(`Step one: book the\n${STOPPED_MARK}`);
    expect(assistant.join("\n").match(/stopped by the user/g)).toHaveLength(1);
    expect(historyText("text", "", { stopped: true })).toBe(STOPPED_MARK);
  });
});

test("M26 deleted cards and attachments have explicit model-history labels", async () => {
  const { input } = await turnFixture(db);
  const { userId, channelId } = input;
  const file = { name: "x.csv", mime: "text/csv", deletedAt: now().toISOString() };
  expect(historyText("file", "", { file })).toBe('[file "x.csv" (text/csv), deleted by the user]');
  expect(historyText("image", "", { file })).toBe('[image "x.csv" (text/csv), deleted by the user]');
  expect(attachedLine([file])).toBe('[Attached: "x.csv" (text/csv, deleted)]');
  const message = await db.message.create({ data: { userId, channelId, role: "user", text: "Use this", createdAt: at(10) } });
  await db.channelFile.create({ data: { userId, channelId, messageId: message.id, path: "gone.csv", name: file.name, mime: file.mime, size: 10, source: "user", deletedAt: now() } });
  const ctx = await buildContext(db, input, now());
  expect(ctx.messages.map(textOf).join("\n")).toContain('[Attached: "x.csv" (text/csv, deleted)]');
});

test("assistant-withdrawn forms and connection requests have explicit history labels", () => {
  expect(historyText("form", "", { title: "Notion page location", state: "dismissed", closedBy: "assistant" })).toBe('[form "Notion page location" (you withdrew it)]');
  expect(historyText("form", "", { title: "Old question", state: "dismissed" })).toBe('[form "Old question" (the user skipped it)]');
  expect(historyText("connection_request", "", { name: "Notion", state: "dismissed", closedBy: "assistant" })).toBe('[connection_request "Notion" (you withdrew it)]');
  expect(historyText("connection_request", "", { name: "GitHub", state: "open" })).toBe('[connection_request "GitHub" (waiting for the user\'s response)]');
});
