// Synthetic silent audio only; never contacts a provider.
export function wav(seconds = 1, opts: { extensible?: boolean; extra?: boolean; rate?: number; channels?: number; bits?: number; encoding?: number } = {}): Buffer {
  const rate = opts.rate ?? 16000, channels = opts.channels ?? 1, bits = opts.bits ?? 16;
  const fmt = Buffer.alloc(opts.extensible ? 40 : 16);
  fmt.writeUInt16LE(opts.encoding ?? (opts.extensible ? 0xfffe : 1), 0);
  fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * bits / 8, 8); fmt.writeUInt16LE(channels * bits / 8, 12); fmt.writeUInt16LE(bits, 14);
  if (opts.extensible) { fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(bits, 18); Buffer.from([1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113]).copy(fmt, 24); }
  const chunk = (name: string, value: Buffer) => { const head = Buffer.alloc(8); head.write(name); head.writeUInt32LE(value.length, 4); return Buffer.concat([head, value, Buffer.alloc(value.length % 2)]); };
  const chunks = [chunk("fmt ", fmt), ...(opts.extra ? [chunk("JUNK", Buffer.from("odd")), chunk("LIST", Buffer.from("metadata"))] : []), chunk("data", Buffer.alloc(Math.round(seconds * rate * channels * bits / 8)))];
  const body = Buffer.concat(chunks), head = Buffer.alloc(12);
  head.write("RIFF"); head.writeUInt32LE(body.length + 4, 4); head.write("WAVE", 8);
  return Buffer.concat([head, body]);
}
