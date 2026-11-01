// Server-sent events framing (docs/API.md "SSE"): `id`/`event`/`data` per stored event, a
// ": ping" comment every ~20 s and no-buffering headers so proxies and tunnels keep it open.
import type { DuetEvent } from "../contract/events.ts";

export const HEARTBEAT_MS = 20_000;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
} as const;

export function formatEvent(event: DuetEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface SseSink {
  send(event: DuetEvent): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Builds a streaming Response. `start` wires the sink (subscribe, replay ...) and returns a
 * cleanup that runs once, on close() or when the client goes away.
 */
export function sseResponse(start: (sink: SseSink) => (() => void) | Promise<() => void>, opts: { heartbeatMs?: number; signal?: AbortSignal } = {}): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    cleanup?.();
    try { controllerRef?.close(); } catch { /* already closed */ }
  };
  const sink: SseSink = {
    send(event) {
      if (closed || !controllerRef) return;
      try { controllerRef.enqueue(encoder.encode(formatEvent(event))); } catch { finish(); }
    },
    close: finish,
    get closed() { return closed; },
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { finish(); }
      }, opts.heartbeatMs ?? HEARTBEAT_MS);
      opts.signal?.addEventListener("abort", finish, { once: true });
      // An initial comment flushes headers through buffering proxies right away.
      controller.enqueue(encoder.encode(": connected\n\n"));
      const stop = await start(sink);
      if (closed) stop();
      else cleanup = stop;
    },
    cancel() { finish(); },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
