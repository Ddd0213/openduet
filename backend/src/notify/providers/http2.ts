// APNs only speaks HTTP/2 and Bun's fetch doesn't, so requests go through node:http2 with one
// session per origin (Apple asks for long-lived connections). close() ends them on shutdown.
import { connect, type ClientHttp2Session } from "node:http2";
import { PUSH_TIMEOUT_MS } from "./retry.ts";

export interface Http2Request { origin: string; path: string; headers: Record<string, string>; body: string }
export interface Http2Response { status: number; body: string }

export interface Http2Transport {
  request(req: Http2Request): Promise<Http2Response>;
  close(): Promise<void>;
}

export function createHttp2Transport(timeoutMs = PUSH_TIMEOUT_MS): Http2Transport {
  const sessions = new Map<string, ClientHttp2Session>();

  const session = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const created = connect(origin);
    const forget = () => {
      if (sessions.get(origin) === created) sessions.delete(origin);
    };
    created.on("error", forget);
    created.on("goaway", forget);
    created.on("close", forget);
    sessions.set(origin, created);
    return created;
  };

  return {
    request: (req) =>
      new Promise<Http2Response>((resolve, reject) => {
        let stream;
        try {
          stream = session(req.origin).request({ ":method": "POST", ":path": req.path, ...req.headers, "content-type": "application/json" });
        } catch (error) {
          reject(error as Error);
          return;
        }
        let status = 0;
        let body = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error || status === 0) reject(error ?? new Error("no response"));
          else resolve({ status, body });
        };
        const timer = setTimeout(() => {
          stream.close();
          finish(new Error("timeout"));
        }, timeoutMs);
        stream.setEncoding("utf8");
        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        stream.on("data", (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        stream.on("end", () => finish());
        stream.on("close", () => finish());
        stream.on("error", (error: Error) => finish(error));
        stream.end(req.body);
      }),
    close: async () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
