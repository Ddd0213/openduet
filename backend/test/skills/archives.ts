// Test-only archive builders for the M11 skill import tests: a ustar tar (regular files, symlinks,
// directories, any path, including unsafe ones) and a zip (stored or deflated entries, Unix
// symlink attributes, a lying size field). No dependency: node:zlib only.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../src/skills/archive.ts";

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array) => (typeof data === "string" ? encoder.encode(data) : data);

export interface TarEntry { path: string; data?: string | Uint8Array; type?: "file" | "dir" | "symlink"; link?: string }

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  block.set(encoder.encode(value).subarray(0, length), offset);
}
const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;

export function tar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data = entry.type === "file" || entry.type === undefined ? bytesOf(entry.data ?? "") : new Uint8Array();
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.path);
    writeString(header, 100, 8, octal(0o644, 8));
    writeString(header, 108, 8, octal(0, 8));
    writeString(header, 116, 8, octal(0, 8));
    writeString(header, 124, 12, octal(data.length, 12));
    writeString(header, 136, 12, octal(0, 12));
    header[156] = (entry.type === "dir" ? "5" : entry.type === "symlink" ? "2" : "0").charCodeAt(0);
    if (entry.link) writeString(header, 157, 100, entry.link);
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export interface ZipEntry { path: string; data: string | Uint8Array; deflate?: boolean; symlink?: boolean; declaredSize?: number }

export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = bytesOf(entry.data);
    const body = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = encoder.encode(entry.path);
    const size = entry.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, entry.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, (3 << 8) | 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, entry.deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((entry.symlink ? 0o120777 : 0o100644) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

export const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
