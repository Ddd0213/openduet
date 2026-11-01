// Composer uploads (L179 server side): signed-in only, real type, 25 MB cap, safe names, owner-only
// bytes, and what the agent receives (image blocks, extracted PDF/DOCX/text).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TurnInput, TurnResult } from "../../src/agent/types.ts";
import { ChannelFileList, MAX_UPLOAD_BYTES } from "../../src/contract/channels.ts";
import { UploadFileResponse } from "../../src/contract/messages.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { PNG, docxWithText, pdfWithText, uploadForm } from "../helpers/files.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { MODEL, stubAgent, usage } from "../helpers/stub-agent.ts";

const agent = stubAgent(async (): Promise<TurnResult> => ({ status: "completed", error: null, usage: usage(1, 1), model: MODEL }));
let fixture: TestApp;
let alex: SignedIn;
let sam: SignedIn;

beforeAll(async () => {
  fixture = await createTestApp({}, { agent });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const upload = (who: SignedIn, bytes: Uint8Array, name: string, type: string) =>
  fixture.app.request(`/api/channels/${who.mainChannelId}/files`, { method: "POST", headers: who.headers, body: uploadForm(bytes, name, type) });
async function uploaded(bytes: Uint8Array, name: string, type: string) {
  const response = await upload(alex, bytes, name, type);
  expect(response.status).toBe(200);
  return UploadFileResponse.parse(await response.json()).file;
}
const sendWith = (fileIds: string[], text = "Have a look") =>
  fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, {
    method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId: crypto.randomUUID(), fileIds }),
  });

describe("POST /api/channels/:id/files", () => {
  test("needs a signed-in session", async () => {
    const response = await fixture.app.request(`/api/channels/${alex.mainChannelId}/files`, { method: "POST", body: uploadForm(PNG, "a.png", "image/png") });
    expect(response.status).toBe(401);
  });

  test("stores the real type under a generated name, outside the user's file name", async () => {
    const file = await uploaded(PNG, "../../etc/passwd.png", "image/png");
    expect(file).toMatchObject({ name: "passwd.png", mime: "image/png", size: PNG.length, source: "user", origin: "upload", workspacePath: null, taskId: null, messageId: null, url: `/api/files/${file.id}/content` });
    const row = await fixture.db.channelFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.path).toMatch(new RegExp(`^${alex.userId}/[0-9a-f-]{36}\\.png$`));
    expect(existsSync(join(fixture.config.FILES_DIR, row.path))).toBe(true);
  });

  test("a PDF declared as image/png is refused, and so are types outside the list", async () => {
    const lying = await upload(alex, pdfWithText("not an image"), "photo.png", "image/png");
    expect(lying.status).toBe(415);
    expect((await errorOf(lying)).code).toBe("unsupported_type");
    const zip = await upload(alex, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "a.zip", "application/zip");
    expect(zip.status).toBe(415);
    // Long enough to dodge a Bun 1.3.6 multipart quirk that cuts parts of <= 8 bytes at the first NUL.
    const binaryText = await upload(alex, new Uint8Array(64).fill(0x41).fill(0, 10, 20), "notes.txt", "text/plain");
    expect(binaryText.status).toBe(415);
  });

  test("files over 25 MB are too_large", async () => {
    const response = await upload(alex, new Uint8Array(MAX_UPLOAD_BYTES + 1), "big.pdf", "application/pdf");
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("too_large");
  });

  test("only the owner gets the bytes, with the real type, nosniff and a UTF-8 file name", async () => {
    const file = await uploaded(new TextEncoder().encode("# 季度报告\n- 收入"), "季度 报告.md", "text/x-markdown");
    const own = await fixture.app.request(file.url, { headers: alex.headers });
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(own.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(own.headers.get("Cache-Control")).toStartWith("private");
    expect(own.headers.get("Content-Disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("季度 报告.md")}`);
    expect(await own.text()).toBe("# 季度报告\n- 收入");
    expect((await fixture.app.request(file.url, { headers: sam.headers })).status).toBe(404);
    expect((await fixture.app.request(file.url)).status).toBe(401);
  });

  test("unsent and sent uploads can both be removed", async () => {
    const draft = await uploaded(PNG, "draft.png", "image/png");
    const row = await fixture.db.channelFile.findUniqueOrThrow({ where: { id: draft.id } });
    expect((await fixture.app.request(`/api/files/${draft.id}`, { method: "DELETE", headers: sam.headers })).status).toBe(404);
    expect((await fixture.app.request(`/api/files/${draft.id}`, { method: "DELETE", headers: alex.headers })).status).toBe(200);
    expect(existsSync(join(fixture.config.FILES_DIR, row.path))).toBe(false);

    const sent = await uploaded(PNG, "sent.png", "image/png");
    await readSse(await sendWith([sent.id]));
    expect((await fixture.app.request(`/api/files/${sent.id}`, { method: "DELETE", headers: alex.headers })).status).toBe(200);
  });
});

describe("attachments reach the agent", () => {
  test("images as base64 image blocks, PDF/DOCX/CSV as extracted text, and the echo lists them", async () => {
    const files = [
      await uploaded(PNG, "chart.png", "image/png"),
      await uploaded(pdfWithText("Revenue grew 12 percent"), "q3.pdf", "application/pdf"),
      await uploaded(docxWithText(["Meeting notes", "会议纪要"]), "notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      await uploaded(new TextEncoder().encode("name,amount\nrent,1200\n"), "budget.csv", "text/csv"),
    ];
    const frames = await readSse(await sendWith(files.map((f) => f.id)));
    const turn: TurnInput = agent.turns.at(-1)!;
    const [image, pdf, docx, csv] = turn.attachments;
    expect(image).toMatchObject({ type: "image", mediaType: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(pdf).toMatchObject({ type: "text", name: "q3.pdf", truncated: false });
    expect(pdf?.type === "text" && pdf.text).toContain("Revenue grew 12 percent");
    expect(docx?.type === "text" && docx.text).toContain("会议纪要");
    expect(csv?.type === "text" && csv.text).toBe("name,amount\nrent,1200\n");

    const echo = frames.events.find((e) => e.type === "message" && e.payload.message.role === "user");
    const message = echo?.type === "message" ? echo.payload.message : null;
    expect(message?.kind === "text" && message.payload.attachments.map((a) => a.name)).toEqual(["chart.png", "q3.pdf", "notes.docx", "budget.csv"]);
    const listed = await fixture.app.request(`/api/channels/${alex.mainChannelId}/files`, { headers: alex.headers });
    const names = ChannelFileList.parse(await listed.json()).files.map((f) => f.name);
    expect(names.slice(0, 4)).toEqual(["budget.csv", "notes.docx", "q3.pdf", "chart.png"]);
  });

  test("a file can be sent only once, only in its own channel", async () => {
    const file = await uploaded(PNG, "once.png", "image/png");
    await readSse(await sendWith([file.id]));
    const again = await sendWith([file.id]);
    expect(again.status).toBe(400);
    expect((await errorOf(again)).field).toBe("fileIds");
  });
});
