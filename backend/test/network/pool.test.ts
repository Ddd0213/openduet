// M29 net: the pooled outbound transport (src/network/pool.ts). No internet: in-process http /
// https servers on 127.0.0.1, an injected lookup and an allow-list that lets the test server in.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { send } from "../../src/custom-connectors/net.ts";
import { createLlm, loadModelConfig } from "../../src/llm/index.ts";
import { createModelFetch } from "../../src/llm/net.ts";
import { createPool, type Lookup, type Pool } from "../../src/network/pool.ts";
import { webFetch } from "../../src/web/fetch.ts";
import { anthropicText, collect, env, openaiText, rawConfig, request, settings } from "../llm/fixtures.ts";

const LOOPBACK = "127.0.0.1";
const allow = (address: string) => address === LOOPBACK;
const counting = (answer: (host: string, call: number) => string[]) => {
  const calls: string[] = [];
  const lookup: Lookup = async host => { calls.push(host); return answer(host, calls.length).map(address => ({ address, family: address.includes(":") ? 6 : 4 })); };
  return { lookup, calls };
};
const causeOf = (error: unknown) => (error as { cause?: { kind?: string; code?: string; message?: string } }).cause;

type Route = (q: http.IncomingMessage, r: http.ServerResponse) => void;
const routes: Record<string, Route> = {
  "/": (_q, r) => r.end("hello"),
  "/close": (_q, r) => { r.setHeader("connection", "close"); r.end("bye"); },
  "/redirect": (_q, r) => { r.writeHead(302, { location: "/target" }); r.end(); },
  "/target": (_q, r) => r.end("followed"),
  "/stream": (_q, r) => { r.writeHead(200, { "content-type": "text/event-stream" }); r.write("data: one\n\n"); setTimeout(() => { r.write("data: two\n\n"); r.end(); }, 300); },
  "/big": (_q, r) => r.end("x".repeat(300_000)),
};
interface Server { port: number; sockets: number; hits: string[]; close(): void }
async function serve(make: (handler: http.RequestListener) => http.Server, table: Record<string, Route> = routes): Promise<Server> {
  const state = { sockets: 0, hits: [] as string[] };
  const server = make((q, r) => { state.hits.push(q.url ?? ""); (table[q.url ?? ""] ?? ((_q, res) => { res.writeHead(404); res.end(); }))(q, r); });
  server.on("connection", () => { state.sockets++; });
  await new Promise<void>(done => server.listen(0, LOOPBACK, () => done()));
  return { port: (server.address() as { port: number }).port, get sockets() { return state.sockets; }, hits: state.hits, close: () => server.close() };
}

let plain: Server;
beforeAll(async () => { plain = await serve(handler => http.createServer(handler)); });
afterAll(() => plain.close());
const at = (path: string, host = "app.test") => `http://${host}:${plain.port}${path}`;

describe("the pool's connection check", () => {
  test("the lookup that runs is ours (Bun's built-in undici stand-in would skip it)", async () => {
    const { lookup, calls } = counting(() => [LOOPBACK]);
    const pool = createPool({ lookup, allow });
    try {
      expect(await (await pool.fetch(at("/", "real-lookup.test"))).text()).toBe("hello");
      expect(calls).toEqual(["real-lookup.test"]);
    } finally { await pool.close(); }
  });

  test("a new connection to a private / reserved answer is refused before connecting", async () => {
    const before = plain.sockets;
    for (const answers of [["10.0.0.1"], [LOOPBACK, "192.168.1.5"], ["169.254.169.254"]]) {
      const pool = createPool({ lookup: counting(() => answers).lookup, allow });
      try {
        const error = await pool.fetch(at("/"), { signal: AbortSignal.timeout(3000) }).catch(e => e);
        expect(causeOf(error)).toMatchObject({ kind: "blocked", code: "EADDRBLOCKED" });
      } finally { await pool.close(); }
    }
    const literal = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow: () => false });
    try { expect(causeOf(await literal.fetch(`http://${LOOPBACK}:${plain.port}/`).catch(e => e))).toMatchObject({ kind: "blocked" }); } finally { await literal.close(); }
    expect(plain.sockets).toBe(before);
  });

  test("DNS rebinding: once the name points inside, the next new connection is refused", async () => {
    const { lookup, calls } = counting((_host, call) => call === 1 ? [LOOPBACK] : ["10.0.0.1"]);
    const pool = createPool({ lookup, allow });
    const before = plain.sockets;
    try {
      // The server closes this connection, so the next request needs a new one.
      expect(await (await pool.fetch(at("/close", "rebind.test"))).text()).toBe("bye");
      const error = await pool.fetch(at("/", "rebind.test"), { signal: AbortSignal.timeout(3000) }).catch(e => e);
      expect(causeOf(error)).toMatchObject({ kind: "blocked" });
      expect(calls).toEqual(["rebind.test", "rebind.test"]);
      expect(plain.sockets - before).toBe(1);
    } finally { await pool.close(); }
  });

  test("a name that doesn't resolve is not_found", async () => {
    const pool = createPool({ lookup: async () => { throw new Error("ENOTFOUND"); }, allow });
    try { expect(causeOf(await pool.fetch(at("/", "nowhere.test")).catch(e => e))).toMatchObject({ kind: "not_found" }); } finally { await pool.close(); }
  });
});

describe("reuse and transport behaviour", () => {
  test("back-to-back requests share one connection (one lookup, one socket)", async () => {
    const { lookup, calls } = counting(() => [LOOPBACK]);
    const pool = createPool({ lookup, allow });
    const before = plain.sockets;
    try {
      for (let i = 0; i < 5; i++) expect(await (await pool.fetch(at("/", "reuse.test"))).text()).toBe("hello");
      expect(await (await pool.fetch(at("/big", "reuse.test"))).arrayBuffer()).toHaveProperty("byteLength", 300_000);
      expect(plain.sockets - before).toBe(1);
      expect(calls).toEqual(["reuse.test"]);
    } finally { await pool.close(); }
  });

  test("redirects are never followed (manual answers the 3xx, anything else fails)", async () => {
    const pool = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow });
    try {
      const manual = await pool.fetch(at("/redirect"), { redirect: "manual" });
      expect(manual.status).toBe(302);
      expect(manual.headers.get("location")).toBe("/target");
      for (const redirect of ["error", "follow", undefined] as const) {
        await expect(pool.fetch(at("/redirect"), redirect ? { redirect } : {})).rejects.toThrow(TypeError);
      }
      expect(plain.hits).not.toContain("/target");
    } finally { await pool.close(); }
  });

  test("a streamed body arrives as it's sent; Bun's own Response, Headers and ReadableStream", async () => {
    const pool = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow });
    try {
      const response = await pool.fetch(at("/stream"));
      expect(response).toBeInstanceOf(Response);
      expect(response.headers).toBeInstanceOf(Headers);
      expect(response.body).toBeInstanceOf(ReadableStream);
      const reader = response.body!.getReader();
      const started = performance.now();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n");
      expect(performance.now() - started).toBeLessThan(250);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: two\n\n");
      expect((await reader.read()).done).toBe(true);
    } finally { await pool.close(); }
  });

  test("abort and timeout signals reject with their reason", async () => {
    const pool = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(pool.fetch(at("/"), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      const reading = await pool.fetch(at("/stream"), { signal: AbortSignal.timeout(100) });
      await expect(reading.text()).rejects.toMatchObject({ name: "TimeoutError" });
    } finally { await pool.close(); }
  });
});
// A throwaway CA + a leaf for good.test (generated per run; no key material in the repo).
const openssl = Bun.which("openssl");
let tls: { dir: string; ca: string; key: string; cert: string } | undefined;
if (openssl) {
  const dir = mkdtempSync(join(tmpdir(), "od-pool-"));
  const run = (...args: string[]) => execFileSync(openssl, args, { cwd: dir, stdio: "ignore" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=pool test CA");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=good.test");
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:good.test\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "ext.cnf");
  tls = { dir, ca: readFileSync(join(dir, "ca.pem"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8"), cert: readFileSync(join(dir, "leaf.pem"), "utf8") };
}
afterAll(() => { if (tls) rmSync(tls.dir, { recursive: true, force: true }); });

describe.skipIf(!tls)("TLS: the certificate is checked for the hostname", () => {
  let secure: Server;
  let pool: Pool;
  beforeAll(async () => {
    secure = await serve(handler => https.createServer({ key: tls!.key, cert: tls!.cert }, handler));
    pool = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow, ca: tls!.ca });
  });
  afterAll(async () => { await pool.close(); secure.close(); });

  test("good.test connects (and is reused); another name or the bare IP is refused", async () => {
    for (let i = 0; i < 3; i++) expect(await (await pool.fetch(`https://good.test:${secure.port}/`)).text()).toBe("hello");
    for (const url of [`https://bad.test:${secure.port}/`, `https://${LOOPBACK}:${secure.port}/`]) {
      expect(causeOf(await pool.fetch(url).catch(e => e))?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    }
  });

  test("an untrusted CA is refused", async () => {
    const strict = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow });
    try { expect(causeOf(await strict.fetch(`https://good.test:${secure.port}/`).catch(e => e))?.code).toMatch(/UNABLE_TO_VERIFY|SELF_SIGNED|CERT/); } finally { await strict.close(); }
  });
});
// Both SDKs on the pool through the real adapters (secureFetch → createModelFetch with an injected
// transport): SSE split over packets, and a 429's Retry-After read from Bun's Headers.
const chunks = (body: string, parts = 4) => Array.from({ length: parts }, (_, i) => body.slice(Math.floor(i * body.length / parts), Math.floor((i + 1) * body.length / parts)));
let llmCalls = 0;
const streamed = (body: string): Route => (q, r) => {
  q.resume();
  q.on("end", async () => {
    if (++llmCalls <= 2) { r.writeHead(429, { "retry-after": "3", "content-type": "application/json" }); r.end("{\"error\":{\"message\":\"slow down\"}}"); return; }
    r.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of chunks(body)) { r.write(part); await Bun.sleep(20); }
    r.end();
  });
};
describe.skipIf(!tls)("OpenAI and Anthropic SDKs over the pool", () => {
  let gateway: Server;
  let pool: Pool;
  beforeAll(async () => {
    gateway = await serve(handler => https.createServer({ key: tls!.key, cert: tls!.cert }, handler), { "/v1/chat/completions": streamed(openaiText()), "/v1/messages": streamed(anthropicText()) });
    pool = createPool({ lookup: counting(() => [LOOPBACK]).lookup, allow, ca: tls!.ca });
  });
  afterAll(async () => { await pool.close(); gateway.close(); });

  for (const protocol of ["openai", "anthropic"] as const) {
    test(`${protocol}: streamed text and Retry-After`, async () => {
      llmCalls = 0;
      // The model guard sees a public answer; the pool (the real transport here) connects to the test server.
      const transport = Object.assign((input: string | URL | Request, init?: RequestInit) => pool.fetch(input, init), { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
      const raw = { ...rawConfig(protocol), providers: [{ ...rawConfig(protocol).providers[0]!, baseUrl: `https://good.test:${gateway.port}/v1/` }] };
      const config = loadModelConfig(settings, env, () => JSON.stringify(raw));
      const waits: number[] = [];
      const events = await collect(createLlm(config, { fetch: transport, env, sleep: async ms => { waits.push(ms); } }).stream(request));
      expect(events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("")).toBe("Hello 世界");
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
      expect(waits).toEqual([3000, 3000]);
      expect(llmCalls).toBe(3);
    });
  }
});

describe("callers map a refused connection to their own errors", () => {
  const privateDns: Lookup = async () => [{ address: "10.0.0.1", family: 4 }];
  const missing: Lookup = async () => { throw new Error("ENOTFOUND"); };

  test("send(): blocked / unreachable NetError, nothing connected", async () => {
    const init = { method: "GET", headers: {}, timeoutMs: 5000 };
    await expect(send(new URL("https://inside.example/x"), init, { lookup: privateDns })).rejects.toMatchObject({ kind: "blocked", message: "inside.example points to a private or reserved address." });
    await expect(send(new URL("https://missing.example/x"), init, { lookup: missing })).rejects.toMatchObject({ kind: "unreachable", message: "missing.example couldn't be found." });
  });

  test("createModelFetch(): blocked NetError (the SDKs see a failed fetch)", async () => {
    const guarded = createModelFetch({ lookup: privateDns });
    await expect(guarded("https://gateway.example/v1/models")).rejects.toMatchObject({ kind: "blocked", message: "gateway.example points to a private or reserved address." });
  });

  test("webFetch(): the same refusal text as before, the lookup is the one injected", async () => {
    const seen: string[] = [];
    const lookup: Lookup = async host => { seen.push(host); return [{ address: "10.0.0.1", family: 4 }]; };
    expect(await webFetch("https://inside.example/", { lookup })).toEqual({ isError: true, error: "Private or reserved addresses are not allowed" });
    expect(seen).toEqual(["inside.example"]);
  });
});
