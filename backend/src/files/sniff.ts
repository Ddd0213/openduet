// Real file type from the bytes (L179). The client's declared type and file name are only hints:
// binary formats must match their magic bytes, and text has no magic bytes, so it must be valid
// UTF-8 without NUL bytes and is typed by its extension.
import { fileTypeFromBuffer } from "file-type";

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"] as const;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const BINARY_MIMES = new Set<string>([...IMAGE_MIMES, "application/pdf", DOCX_MIME]);

const TEXT_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain", text: "text/plain", log: "text/plain",
  md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv",
};

/** Declared types that are only a vague claim; any detected type is accepted with them. */
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png",
  "image/heic-sequence": "image/heic", "image/heif-sequence": "image/heif",
  "text/x-markdown": "text/markdown", "application/csv": "text/csv", "text/comma-separated-values": "text/csv",
  "application/x-pdf": "application/pdf",
};

export type SniffResult = { ok: true; mime: string } | { ok: false };

function normalize(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return ALIASES[base] ?? base;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The allowed real type of an upload, or not ok (-> 415 unsupported_type). */
export async function sniff(bytes: Uint8Array, declaredMime: string, fileName: string): Promise<SniffResult> {
  const declared = normalize(declaredMime);
  const detected = await fileTypeFromBuffer(bytes);
  if (detected) {
    const real = normalize(detected.mime);
    if (!BINARY_MIMES.has(real)) return { ok: false };
    if (!GENERIC.has(declared) && declared !== real) return { ok: false };
    return { ok: true, mime: real };
  }
  const textMime = TEXT_BY_EXTENSION[extensionOf(fileName)];
  if (!textMime || !isUtf8Text(bytes)) return { ok: false };
  // Clients label markdown and CSV inconsistently; any text/* claim (or none) is fine for text.
  if (!GENERIC.has(declared) && !declared.startsWith("text/")) return { ok: false };
  return { ok: true, mime: textMime };
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/");
}
