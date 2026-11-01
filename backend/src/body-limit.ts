// Byte caps before JSON parsing/auth. Upload routes retain their smaller, route-specific caps.
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorBody } from "./http.ts";

// Files 25 MiB + 64 KiB framing; skills ZIP/upload 20 MiB + 64 KiB; WAV 8 MiB + 64 KiB.
export const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024;
// Skills JSON can carry a 5 MiB folder. 6 MiB covers that plus instructions/framing;
// messages (32k chars), dashboard data (64 KiB) and connector configuration also fit.
export const JSON_BODY_BYTES = 6 * 1024 * 1024;
export const SIGN_IN_BODY_BYTES = 16 * 1024;
const limit = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json(errorBody("request_too_large", "Request body is too large."), 413) });
const jsonLimit = limit(JSON_BODY_BYTES);
const signInLimit = limit(SIGN_IN_BODY_BYTES);
export const apiBodyLimit: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  if (c.req.method === "POST") {
    if (path === "/api/session") return signInLimit(c, next);
    if (/^\/api\/channels\/[^/]+\/files$/.test(path) || ["/api/skills/zip/preview", "/api/skills/upload/preview", "/api/transcriptions"].includes(path)) return next();
  }
  return jsonLimit(c, next);
};
