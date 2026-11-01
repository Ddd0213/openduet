// M27 WAV validation: walk RIFF chunks (including odd-sized ancillary chunks), never convert.
import { TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MAX_SECONDS, TRANSCRIPTION_MIN_SECONDS, TRANSCRIPTION_SAMPLE_RATES } from "../contract/m27voice.ts";
import { HttpError } from "../http.ts";

const invalid = () => new HttpError(400, "validation_failed", "file: send a readable WAV recording of at least 0.3 seconds", "file");
const unsupported = () => new HttpError(415, "unsupported_type", "Send a WAV file (16-bit PCM, 1-2 channels, 8000-48000 Hz).", "file");
export const clipTooLarge = () => new HttpError(413, "too_large", "Dictation clips can be up to 120 seconds and 8 MB.");
const PCM_GUID = [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];

export function readWav(audio: Uint8Array): { seconds: number } {
  if (audio.length < 12) throw invalid();
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const four = (offset: number) => String.fromCharCode(...audio.subarray(offset, offset + 4));
  if (four(0) !== "RIFF" || four(8) !== "WAVE") throw unsupported();
  const end = view.getUint32(4, true) + 8;
  if (end < 12 || end > audio.length) throw invalid();
  let fmt: { offset: number; size: number } | null = null, dataBytes = 0, hasData = false;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) throw invalid();
    const name = four(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > end) throw invalid();
    if (name === "fmt ") {
      if (fmt || size < 16) throw invalid();
      fmt = { offset: start, size };
    }
    if (name === "data") { hasData = true; dataBytes += size; }
    offset = start + size + (size % 2);
    if (offset > end) throw invalid();
  }
  if (!fmt || !hasData || !dataBytes) throw invalid();
  const p = fmt.offset, encoding = view.getUint16(p, true), channels = view.getUint16(p + 2, true);
  const rate = view.getUint32(p + 4, true), byteRate = view.getUint32(p + 8, true);
  const align = view.getUint16(p + 12, true), bits = view.getUint16(p + 14, true);
  if (encoding === 0xfffe) {
    if (fmt.size < 40 || view.getUint16(p + 16, true) < 22) throw invalid();
    if (view.getUint16(p + 18, true) !== 16 || !PCM_GUID.every((b, i) => audio[p + 24 + i] === b)) throw unsupported();
  } else if (encoding !== 1) throw unsupported();
  if (bits !== 16 || channels < 1 || channels > 2 || rate < TRANSCRIPTION_SAMPLE_RATES.min || rate > TRANSCRIPTION_SAMPLE_RATES.max) throw unsupported();
  if (align !== channels * 2 || byteRate !== rate * align || dataBytes % align !== 0) throw invalid();
  const seconds = dataBytes / byteRate;
  if (seconds < TRANSCRIPTION_MIN_SECONDS) throw invalid();
  if (audio.length > TRANSCRIPTION_MAX_BYTES || seconds > TRANSCRIPTION_MAX_SECONDS) throw clipTooLarge();
  return { seconds };
}
