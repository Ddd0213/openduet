// Composer attachments -> what the agent hands the model (L179): images as base64 image blocks
// (the agent decides whether the model has vision), documents as extracted text.
import type { ChannelFile as FileRow } from "@prisma/client";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import type { Attachment } from "../agent/types.ts";
import type { FileStore } from "../files/store.ts";
import { DOCX_MIME, isTextMime } from "../files/sniff.ts";
import { log } from "../log.ts";

/** Images above this go to the model as a short note instead of pixels. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Extracted text per file is cut to about this many characters. */
export const MAX_TEXT_CHARS = 50_000;

const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type ModelImageType = Extract<Attachment, { type: "image" }>["mediaType"];

function note(row: FileRow, text: string): Attachment {
  return { fileId: row.id, name: row.name, mime: row.mime, type: "text", text, truncated: false };
}

function capped(row: FileRow, text: string): Attachment {
  const truncated = text.length > MAX_TEXT_CHARS;
  return { fileId: row.id, name: row.name, mime: row.mime, type: "text", text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}

async function extract(row: FileRow, bytes: Uint8Array): Promise<string | null> {
  if (row.mime === "application/pdf") return (await extractText(bytes, { mergePages: true })).text;
  if (row.mime === DOCX_MIME) return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  if (isTextMime(row.mime)) return new TextDecoder("utf-8").decode(bytes);
  return null;
}

export async function resolveAttachment(files: FileStore, row: FileRow): Promise<Attachment> {
  try {
    if (row.mime.startsWith("image/")) {
      if (!MODEL_IMAGE_TYPES.has(row.mime)) return note(row, `[Image ${row.name} (${row.mime}) can't be shown to the model in this format.]`);
      if (row.size > MAX_IMAGE_BYTES) return note(row, `[Image ${row.name} is too large to show to the model (${Math.round(row.size / 1024 / 1024)} MB).]`);
      const bytes = await files.read(row.path);
      return { fileId: row.id, name: row.name, mime: row.mime, type: "image", mediaType: row.mime as ModelImageType, data: Buffer.from(bytes).toString("base64") };
    }
    const text = await extract(row, await files.read(row.path));
    if (text === null) return note(row, `[File ${row.name} (${row.mime}) has no readable text.]`);
    return capped(row, text.trim().length > 0 ? text : `[File ${row.name} has no text (it may be scanned images).]`);
  } catch (error) {
    // A broken document must not fail the turn; the model hears that it couldn't be read.
    log.warn("attachment could not be read", { fileId: row.id, mime: row.mime, error: { name: (error as Error).name } });
    return note(row, `[File ${row.name} couldn't be read.]`);
  }
}

export function resolveAttachments(files: FileStore, rows: FileRow[]): Promise<Attachment[]> {
  return Promise.all(rows.map((row) => resolveAttachment(files, row)));
}
