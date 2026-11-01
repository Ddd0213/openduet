// WS /api/computer/stream (L143): the phone's live screen and input, proxied to the computer's
// /stream. The phone authenticates with its own session (Bearer, like requireSession) on the
// upgrade; the computer URL and token stay in this process. Server -> phone: binary JPEG frames and
// ComputerServerMessage text frames; phone -> server: ComputerClientMessage while the user drives.
// M27 browser: the computer's "tabs" message (patch 0006) goes on as "browser_bar", when it changed.
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ComputerClientMessage, type ComputerState } from "../contract/computer.ts";
import { log } from "../log.ts";
import { barFromComputer } from "./browser-bar.ts";
import type { ComputerService } from "./service.ts";
import type { SessionConnections } from "../auth/connections.ts";
import { SESSION_ENDED_CLOSE_CODE } from "../contract/m28.ts";

export interface StreamSocketData {
  kind: "computer_stream";
  userId: string;
  sessionId: string;
  unregisterSession?: () => void;
  upstream?: WebSocket;
  unsubscribe?: () => void;
  width: number;
  height: number;
  /** what was last told to the phone, so frame_meta goes out only on a change */
  sentWidth: number;
  sentHeight: number;
  /** M27 browser: the bar last told to the phone (JSON), so browser_bar goes out only on a change */
  sentBar?: string;
}

/** Frames are dropped while the phone's socket is this far behind (a slow network). */
const BACKPRESSURE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" }, Backspace: { code: "Backspace", vk: 8 }, Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 }, ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
};

type InputMessage = Record<string, unknown> & { type: "mouse" | "wheel" | "key" | "text" };

/** The phone's gesture (0...1 fractions of the frame) as the computer's input messages (pixels). */
export function toComputerInput(raw: unknown, size: { width: number; height: number }): InputMessage[] {
  const parsed = ComputerClientMessage.safeParse(raw);
  if (!parsed.success) return [];
  const message = parsed.data;
  const px = (p: { x: number; y: number }) => ({ x: Math.round(p.x * (size.width - 1)), y: Math.round(p.y * (size.height - 1)) });
  switch (message.type) {
    case "tap": {
      const at = px(message);
      return [
        { type: "mouse", event: "moved", ...at },
        { type: "mouse", event: "pressed", ...at, button: "left", clickCount: 1 },
        { type: "mouse", event: "released", ...at, button: "left", clickCount: 1 },
      ];
    }
    case "drag": {
      const from = px(message.from), to = px(message.to);
      const steps = [0.25, 0.5, 0.75, 1].map((t) => ({ type: "mouse" as const, event: "moved", x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t), button: "left" }));
      return [{ type: "mouse", event: "moved", ...from }, { type: "mouse", event: "pressed", ...from, button: "left", clickCount: 1 }, ...steps, { type: "mouse", event: "released", ...to, button: "left", clickCount: 1 }];
    }
    case "scroll": {
      const clamp = (v: number) => Math.max(-5000, Math.min(5000, Math.round(v)));
      return [{ type: "wheel", x: Math.round(size.width / 2), y: Math.round(size.height / 2), deltaX: clamp(message.dx), deltaY: clamp(message.dy) }];
    }
    case "text":
      return message.text ? [{ type: "text", text: message.text }] : [];
    case "key": {
      const key = KEYS[message.key]!;
      return [
        { type: "key", event: "down", key: message.key, code: key.code, windowsVirtualKeyCode: key.vk, ...(key.text ? { text: key.text } : {}) },
        { type: "key", event: "up", key: message.key, code: key.code, windowsVirtualKeyCode: key.vk },
      ];
    }
  }
}

function sendState(ws: ServerWebSocket<StreamSocketData>, computer: ComputerState): void {
  try { ws.send(JSON.stringify({ type: "state", computer })); } catch { /* closing */ }
}

/**
 * Bun.serve's `websocket` handler for the computer stream. `connect` opens the upstream socket
 * (tests inject a fake); the default dials the computer's /stream with the token in its query.
 */
export function computerStreamHandler(service: ComputerService, opts: { connect?: (url: string) => WebSocket; connections?: SessionConnections } = {}): WebSocketHandler<StreamSocketData> {
  const connect = opts.connect ?? ((url: string) => new WebSocket(url));
  return {
    maxPayloadLength: MAX_INPUT_BYTES,
    open(ws) {
      const client = service.client;
      if (!client) { ws.close(1011, "not configured"); return; }
      ws.data.unregisterSession = opts.connections?.register(ws.data.sessionId, () => ws.close(SESSION_ENDED_CLOSE_CODE, "session ended"));
      ws.data.unsubscribe = service.subscribe((state) => sendState(ws, state));
      sendState(ws, service.state());
      let upstream: WebSocket;
      try {
        upstream = connect(client.streamUrl());
      } catch {
        ws.close(1011, "unavailable");
        return;
      }
      ws.data.upstream = upstream;
      upstream.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let frame: { type?: unknown; data?: unknown; width?: unknown; height?: unknown };
        try { frame = JSON.parse(event.data) as typeof frame; } catch { return; }
        if (frame.type === "tabs") {
          const bar = service.noteBar(barFromComputer(frame));
          const text = JSON.stringify(bar);
          if (text === ws.data.sentBar) return;
          ws.data.sentBar = text;
          try { ws.send(JSON.stringify({ type: "browser_bar", bar })); } catch { /* closing */ }
          return;
        }
        if (frame.type !== "frame" || typeof frame.data !== "string") return;
        const width = typeof frame.width === "number" && frame.width > 0 ? Math.round(frame.width) : ws.data.width;
        const height = typeof frame.height === "number" && frame.height > 0 ? Math.round(frame.height) : ws.data.height;
        ws.data.width = width;
        ws.data.height = height;
        if (ws.getBufferedAmount() > BACKPRESSURE_BYTES) return;
        try {
          if (width !== ws.data.sentWidth || height !== ws.data.sentHeight) {
            ws.send(JSON.stringify({ type: "frame_meta", width, height }));
            ws.data.sentWidth = width;
            ws.data.sentHeight = height;
          }
          ws.send(Buffer.from(frame.data, "base64"));
        } catch { /* closing */ }
      };
      upstream.onclose = () => { try { ws.close(1011, "stream ended"); } catch { /* closed */ } };
      upstream.onerror = () => { log.warn("computer stream upstream error", {}); };
      // M20: opening the live screen counts as the user being there (auto hand back), and a blank
      // browser gets the start page so there's something to look at (best effort, in the background).
      if (service.canDrive(ws.data.userId)) service.noteUserInput();
      void service.openStartPage();
    },
    message(ws, raw) {
      // Input only while this user drives; the typed text is never logged.
      if (!service.canDrive(ws.data.userId)) return;
      if (typeof raw !== "string" || raw.length > MAX_INPUT_BYTES) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      const upstream = ws.data.upstream;
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      const inputs = toComputerInput(parsed, { width: ws.data.width, height: ws.data.height });
      for (const input of inputs) upstream.send(JSON.stringify(input));
      // M20: real input keeps the auto hand back away.
      if (inputs.length) service.noteUserInput();
    },
    close(ws) {
      ws.data.unsubscribe?.();
      ws.data.unregisterSession?.();
      try { ws.data.upstream?.close(); } catch { /* closed */ }
    },
  };
}

/** The socket data for a phone that passed requireSession. */
export const streamData = (userId: string, sessionId: string): StreamSocketData => ({ kind: "computer_stream", userId, sessionId, width: 1280, height: 800, sentWidth: 0, sentHeight: 0 });
