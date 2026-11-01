// Small archive readers and a writer for skill folders (M11), no dependency: tar (GitHub's
// codeload tar.gz, after node:zlib gunzip), zip (central directory + inflateRawSync, with zip-bomb
// limits) and a stored (uncompressed) zip for export. Every entry path is checked: relative, no
// "..", no leading "/", no drive letters or backslashes. Symlinks and other special entries are
// skipped and reported; a path that tries to leave the folder, a file path that appears twice or a
// bad tar entry size rejects the whole archive.
import { inflateRawSync } from "node:zlib";

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ArchiveFile { path: string; bytes: Uint8Array }
export interface ArchiveContents { files: ArchiveFile[]; skipped: string[] }

/** "a/b.txt" for a safe relative path, else null ("../x", "/etc/passwd", "C:\\x", "a//b" ...). */
export function safeRelative(raw: string): string | null {
  if (!raw || raw.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.at(-1) === "") parts.pop();
  if (!parts.length) return null;
  for (const part of parts) if (part === "" || part === "." || part === "..") return null;
  return parts.join("/");
}

const decoder = new TextDecoder("utf-8");
const cString = (bytes: Uint8Array, start: number, length: number) => {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};
const octal = (bytes: Uint8Array, start: number, length: number) => {
  const text = cString(bytes, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
};

/** pax extended header records: "<len> key=value\n". */
function paxPath(data: Uint8Array): string | null {
  const text = decoder.decode(data);
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset += length;
  }
  return null;
}

export interface TarLimits { maxEntries: number; maxBytes: number }

/** A ustar / GNU / pax tar. Directories are implied; links and devices are skipped. */
export function readTar(tar: Uint8Array, limits: TarLimits): ArchiveContents {
  const files: ArchiveFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let offset = 0, entries = 0, total = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (sum !== octal(header, 148, 8)) throw new ArchiveError("The archive is damaged (bad tar header).");
    const size = octal(header, 124, 12);
    // parseInt takes "-1": a negative (or unreadable) size would stall the offset below, forever.
    if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError("The archive is damaged (bad entry size).");
    const type = String.fromCharCode(header[156] || 48);
    const magic = cString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? cString(header, 345, 155) : "";
    const name = cString(header, 0, 100);
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw new ArchiveError("The archive is damaged (truncated).");
    const data = tar.subarray(dataStart, dataStart + size);
    // size >= 0, so every entry moves the offset on by at least its 512-byte header.
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = cString(data, 0, data.length); continue; }
    if (type === "x") { longName = paxPath(data) ?? longName; continue; }
    if (type === "g") continue;
    const raw = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (++entries > limits.maxEntries) throw new ArchiveError(`The archive has more than ${limits.maxEntries} entries.`);
    if (type === "5") continue;
    const path = safeRelative(raw);
    if (!path) throw new ArchiveError(`Unsafe path in the archive: ${raw.slice(0, 120)}`);
    if (type !== "0" && type !== "7") { skipped.push(path); continue; }
    if (seen.has(path)) throw new ArchiveError(`The archive has ${path.slice(0, 120)} twice.`);
    seen.add(path);
    total += size;
    if (total > limits.maxBytes) throw new ArchiveError(`The archive unpacks to more than ${Math.round(limits.maxBytes / 1048576)} MB.`);
    files.push({ path, bytes: data.slice() });
  }
  return { files, skipped };
}

export interface ZipLimits { maxEntries: number; maxBytes: number }

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** A zip: entries from the central directory, stored or deflated; zip64 and encryption are refused. */
export function readZip(zip: Uint8Array, limits: ZipLimits): ArchiveContents {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError("This isn't a zip file.");
  const count = u16(zip, eocd + 10);
  const cdSize = u32(zip, eocd + 12);
  const cdOffset = u32(zip, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ArchiveError("Zip64 archives aren't supported.");
  if (count > limits.maxEntries) throw new ArchiveError(`The zip has more than ${limits.maxEntries} entries.`);
  if (cdOffset + cdSize > zip.length) throw new ArchiveError("The zip is damaged.");
  const files: ArchiveFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0, p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || u32(zip, p) !== 0x02014b50) throw new ArchiveError("The zip is damaged.");
    const flags = u16(zip, p + 8);
    const method = u16(zip, p + 10);
    const compressed = u32(zip, p + 20);
    const size = u32(zip, p + 24);
    const nameLength = u16(zip, p + 28), extraLength = u16(zip, p + 30), commentLength = u16(zip, p + 32);
    const madeBy = u16(zip, p + 4) >> 8;
    const external = u32(zip, p + 38);
    const local = u32(zip, p + 42);
    const raw = decoder.decode(zip.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (raw.endsWith("/")) continue;
    if (raw.startsWith("__MACOSX/") || raw.split("/").pop() === ".DS_Store") continue;
    const path = safeRelative(raw);
    if (!path) throw new ArchiveError(`Unsafe path in the zip: ${raw.slice(0, 120)}`);
    // Unix symlinks (S_IFLNK in the high 16 bits of the external attributes).
    if (madeBy === 3 && ((external >>> 16) & 0o170000) === 0o120000) { skipped.push(path); continue; }
    if (flags & 1) throw new ArchiveError("Encrypted zips aren't supported.");
    if (method !== 0 && method !== 8) throw new ArchiveError(`${path}: unsupported compression.`);
    if (seen.has(path)) throw new ArchiveError(`The zip has ${path.slice(0, 120)} twice.`);
    seen.add(path);
    total += size;
    if (total > limits.maxBytes) throw new ArchiveError(`The zip unpacks to more than ${Math.round(limits.maxBytes / 1048576)} MB.`);
    if (local + 30 > zip.length || u32(zip, local) !== 0x04034b50) throw new ArchiveError("The zip is damaged.");
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    if (start + compressed > zip.length) throw new ArchiveError("The zip is damaged.");
    const body = zip.subarray(start, start + compressed);
    let bytes: Uint8Array;
    if (method === 0) bytes = body.slice();
    else {
      try {
        // maxOutputLength: a lying size field can't inflate past what was declared.
        bytes = new Uint8Array(inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }));
      } catch {
        throw new ArchiveError(`${path}: couldn't be unpacked.`);
      }
    }
    if (bytes.length !== size) throw new ArchiveError(`${path}: size doesn't match.`);
    files.push({ path, bytes });
  }
  return { files, skipped };
}

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip of these files, UTF-8 names. */
export function writeZip(files: readonly ArchiveFile[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, file.bytes.length, true); lv.setUint32(22, file.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, file.bytes.length, true); cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, file.bytes);
    centrals.push(central);
    offset += local.length + file.bytes.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}
