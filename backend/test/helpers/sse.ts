// Reads an SSE response body into frames: events (id/event/data) and comment lines (": ping").
import { DuetEvent } from "../../src/contract/events.ts";

export interface SseFrames { events: DuetEvent[]; comments: string[]; ids: number[] }

function parseBlock(block: string, out: SseFrames): void {
  let id: number | null = null;
  let type: string | null = null;
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) out.comments.push(line.slice(1).trim());
    else if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("event: ")) type = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return;
  const event = DuetEvent.parse(JSON.parse(data));
  if (event.id !== id || event.type !== type) throw new Error(`frame header mismatch: id ${id} event ${type}`);
  out.events.push(event);
  out.ids.push(event.id);
}

/**
 * Reads until the stream ends, `until` returns true, or `timeoutMs` passes; then cancels the
 * reader (which is what an app closing the connection looks like to the server).
 */
export async function readSse(response: Response, opts: { until?: (frames: SseFrames) => boolean; timeoutMs?: number } = {}): Promise<SseFrames> {
  const out: SseFrames = { events: [], comments: [], ids: [] };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
      ]);
      clearTimeout(timer);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        parseBlock(buffer.slice(0, end), out);
        buffer = buffer.slice(end + 2);
      }
      if (opts.until?.(out)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}
