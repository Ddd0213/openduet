// Bytes of channel files on disk: FILES_DIR/<userId>/<uuid>.<ext>. The stored path is always a
// generated name; the user's file name is only kept as the display name in ChannelFile.name.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DOCX_MIME } from "./sniff.ts";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf", [DOCX_MIME]: "docx",
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv",
};

export class FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Writes the bytes under a fresh safe name; returns the path relative to the root. */
  async save(userId: string, mime: string, bytes: Uint8Array): Promise<string> {
    const path = join(safeSegment(userId), `${randomUUID()}.${EXTENSIONS[mime] ?? "bin"}`);
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, bytes, { mode: 0o600 });
    return path;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(path)));
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolve(path), { force: true });
  }

  /** Absolute path inside the root; anything that would escape it is refused. */
  private resolve(path: string): string {
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("file path escapes FILES_DIR");
    return full;
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("unsafe path segment");
  return value;
}
