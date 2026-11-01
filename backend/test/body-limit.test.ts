import { expect, test } from "bun:test";
import { Hono } from "hono";
import { apiBodyLimit, JSON_BODY_BYTES, SIGN_IN_BODY_BYTES, MAX_REQUEST_BODY_BYTES } from "../src/body-limit.ts";
import { createTestApp } from "./helpers/app.ts";
import { createApp } from "../src/app.ts";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";

test("sign-in cap precedes validation, auth and the limiter for length and streamed bodies", async () => {
  const fixture = await createTestApp();
  try {
    const limiter = new LoginRateLimiter();
    const app = createApp({ ...fixture, loginRateLimiter: limiter });
    for (const declared of [true, false]) {
      const bytes = new Uint8Array(SIGN_IN_BODY_BYTES + 1).fill(120);
      const response = await app.request("/api/session", { method: "POST", headers: declared ? { "content-length": String(bytes.length) } : {}, body: declared ? bytes : new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: { code: "request_too_large", message: "Request body is too large." } });
      expect(limiter.size).toBe(0);
    }
  } finally { await fixture.cleanup(); }
});
test("JSON boundaries, exact POST upload exemptions and transport cap", async () => {
  const app = new Hono(); app.use("/api/*", apiBodyLimit); app.all("*", async c => c.text(String((await c.req.arrayBuffer()).byteLength)));
  const post = (path: string, size: number, method = "POST") => app.request(path, { method, body: "x".repeat(size) });
  expect((await post("/api/session", SIGN_IN_BODY_BYTES)).status).toBe(200);
  expect((await post("/api/skills", JSON_BODY_BYTES)).status).toBe(200);
  expect((await post("/api/skills", JSON_BODY_BYTES + 1)).status).toBe(413);
  for (const path of ["/api/channels/abc/files", "/api/skills/zip/preview", "/api/skills/upload/preview", "/api/transcriptions"]) {
    expect((await post(path, JSON_BODY_BYTES + 1)).status).toBe(200);
    expect((await post(path, JSON_BODY_BYTES + 1, "PUT")).status).toBe(413);
  }
  expect((await post("/api/skills/upload/preview/extra", JSON_BODY_BYTES + 1)).status).toBe(413);
  expect(MAX_REQUEST_BODY_BYTES).toBe(30 * 1024 * 1024);
});
