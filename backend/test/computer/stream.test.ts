// The live screen (L143): WS /api/computer/stream through a short-lived Bun.serve on a random
// localhost port (the real app + the module's websocket handler), with a fake upstream socket in
// place of the computer's /stream. Plus the gesture -> computer input mapping as plain functions.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { START_PAGE_URL } from "../../src/computer/service.ts";
import { toComputerInput } from "../../src/computer/stream.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { FAKE_TOKEN } from "./fake-computer.ts";
import { computerRig, sleep, type ComputerRig } from "./harness.ts";
import { SignInResponse } from "../../src/contract/auth.ts";
import { sessionTokenHash } from "../../src/contract/m28.ts";
import { TEST_PASSWORD } from "../helpers/session.ts";

describe("toComputerInput", () => {
  const size = { width: 1001, height: 501 };
  test("tap, drag, scroll, text and keys become the computer's pixel input", () => {
    expect(toComputerInput({ type: "tap", x: 0.5, y: 1 }, size)).toEqual([
      { type: "mouse", event: "moved", x: 500, y: 500 },
      { type: "mouse", event: "pressed", x: 500, y: 500, button: "left", clickCount: 1 },
      { type: "mouse", event: "released", x: 500, y: 500, button: "left", clickCount: 1 },
    ]);
    const drag = toComputerInput({ type: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, size);
    expect(drag[0]).toEqual({ type: "mouse", event: "moved", x: 0, y: 0 });
    expect(drag[1]).toMatchObject({ event: "pressed", x: 0, y: 0 });
    expect(drag.at(-1)).toEqual({ type: "mouse", event: "released", x: 1000, y: 500, button: "left", clickCount: 1 });
    expect(drag.length).toBe(7);
    expect(toComputerInput({ type: "scroll", dx: 0, dy: 99_999 }, size)).toEqual([{ type: "wheel", x: 501, y: 251, deltaX: 0, deltaY: 5000 }]);
    expect(toComputerInput({ type: "text", text: "héllo 你好" }, size)).toEqual([{ type: "text", text: "héllo 你好" }]);
    expect(toComputerInput({ type: "text", text: "" }, size)).toEqual([]);
    expect(toComputerInput({ type: "key", key: "Enter" }, size)).toEqual([
      { type: "key", event: "down", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
      { type: "key", event: "up", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    ]);
  });

  test("anything outside the contract is dropped", () => {
    for (const bad of [null, "tap", { type: "tap", x: 2, y: 0 }, { type: "key", key: "F5" }, { type: "eval", code: "x" }, { type: "text", text: "x".repeat(4001) }]) {
      expect(toComputerInput(bad, size)).toEqual([]);
    }
  });
});

/** Stands in for the computer's /stream socket. */
class FakeUpstream {
  readyState: number = WebSocket.OPEN;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.closed = true; this.readyState = WebSocket.CLOSED; }
  frame(bytes: Uint8Array, width: number, height: number): void {
    this.onmessage?.({ data: JSON.stringify({ type: "frame", data: Buffer.from(bytes).toString("base64"), width, height }) });
  }
  end(): void { this.readyState = WebSocket.CLOSED; this.onclose?.({}); }
}

/** The phone's side of the socket: every text frame (parsed) and binary frame, in order. */
interface Phone {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  binaries: Uint8Array[];
  closed: Promise<number>;
}

let rig: ComputerRig | null = null;
let server: Server<unknown> | null = null;
let phones: WebSocket[] = [];
afterEach(async () => {
  for (const ws of phones) try { ws.close(); } catch { /* closed */ }
  phones = [];
  server?.stop(true);
  server = null;
  await rig?.cleanup();
  rig = null;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

async function start(opts: { configured?: boolean } = {}) {
  const upstreams: FakeUpstream[] = [];
  rig = await computerRig({ configured: opts.configured, connect: (url) => { const up = new FakeUpstream(url); upstreams.push(up); return up as unknown as WebSocket; } });
  const r = rig;
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, srv) => r.fixture.app.fetch(req, srv),
    websocket: r.computer.websocket as never,
  });
  const url = `ws://127.0.0.1:${server.port}/api/computer/stream`;
  const connect = (who: SignedIn): Promise<Phone> => new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: who.headers } as never);
    ws.binaryType = "arraybuffer";
    phones.push(ws);
    const phone: Phone = { ws, texts: [], binaries: [], closed: new Promise((done) => { ws.onclose = (e) => done(e.code); }) };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") phone.texts.push(JSON.parse(e.data) as Record<string, unknown>);
      else phone.binaries.push(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onopen = () => resolve(phone);
    ws.onerror = () => reject(new Error("socket error"));
  });
  return { r, upstreams, connect, url };
}

describe("WS /api/computer/stream (L143)", () => {
  test("only a signed-in phone, only as a WebSocket upgrade; 503 when not set up", async () => {
    const { r } = await start();
    expect((await r.fixture.app.request("/api/computer/stream")).status).toBe(401);
    expect((await r.fixture.app.request("/api/computer/stream", { headers: { Upgrade: "websocket" } })).status).toBe(401);
    // A session token in the query string is not a credential: Bearer only, like requireSession.
    expect((await r.fixture.app.request(`/api/computer/stream?token=${r.alex.token}`, { headers: { Upgrade: "websocket" } })).status).toBe(401);
    // Signed in but not an upgrade (and no Bun server behind app.request): a plain 400.
    expect((await r.api(r.alex, "/api/computer/stream")).status).toBe(400);
    server?.stop(true);
    server = null;
    await r.cleanup();
    rig = null;
    const off = await computerRig({ configured: false });
    rig = off;
    expect((await off.api(off.alex, "/api/computer/stream", { headers: { Upgrade: "websocket" } })).status).toBe(503);
  });

  test("state first, then frames: frame_meta only on a size change, bytes as binary; the token stays on the server", async () => {
    const { upstreams, connect } = await start();
    const phone = await connect(rig!.alex);
    await until(() => phone.texts.length >= 1 && upstreams.length === 1);
    expect(phone.texts[0]).toMatchObject({ type: "state", computer: { available: true, controller: "assistant" } });
    const upstream = upstreams[0]!;
    expect(new URL(upstream.url).pathname).toBe("/stream");
    expect(new URL(upstream.url).searchParams.get("token")).toBe(FAKE_TOKEN);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    upstream.frame(jpeg, 390, 844);
    upstream.frame(jpeg, 390, 844);
    upstream.frame(Uint8Array.from([0xff, 0xd8, 9, 0xff, 0xd9]), 844, 390);
    await until(() => phone.binaries.length === 3);
    expect(phone.binaries[0]).toEqual(jpeg);
    expect(phone.texts.filter((t) => t.type === "frame_meta")).toEqual([{ type: "frame_meta", width: 390, height: 844 }, { type: "frame_meta", width: 844, height: 390 }]);
    // Junk from upstream is dropped, never forwarded.
    upstream.onmessage?.({ data: "not json" });
    upstream.onmessage?.({ data: JSON.stringify({ type: "log", data: "x" }) });
    await sleep(50);
    expect(phone.binaries.length).toBe(3);
    expect(JSON.stringify(phone.texts)).not.toContain(FAKE_TOKEN);
  });
  test("another account can't watch: the upgrade is refused like a server without a computer", async () => {
    const { r, connect } = await start();
    const sam = await signUp(r.fixture, "sam");
    expect((await r.api(sam, "/api/computer/stream", { headers: { Upgrade: "websocket" } })).status).toBe(503);
    expect(await connect(sam).then(() => "open", () => "refused")).toBe("refused");
  });

  test("taps reach the computer only while this user drives (Take over), mapped to the frame's pixels", async () => {
    const { r, upstreams, connect } = await start();
    const phone = await connect(r.alex);
    await until(() => upstreams.length === 1);
    const [mine] = upstreams as [FakeUpstream];
    mine.frame(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 391, 845);
    await until(() => phone.binaries.length === 1);
    // Claude is driving: the phone is a viewer.
    phone.ws.send(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
    await sleep(80);
    expect(mine.sent).toEqual([]);
    expect((await r.api(r.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    await until(() => phone.texts.some((t) => t.type === "state" && (t.computer as { controller: string }).controller === "user"));
    phone.ws.send(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
    phone.ws.send(JSON.stringify({ type: "text", text: "hello" }));
    phone.ws.send("not json");
    phone.ws.send(JSON.stringify({ type: "eval", code: "alert(1)" }));
    await until(() => mine.sent.length >= 4);
    await sleep(50);
    expect(mine.sent).toEqual([
      { type: "mouse", event: "moved", x: 195, y: 422 },
      { type: "mouse", event: "pressed", x: 195, y: 422, button: "left", clickCount: 1 },
      { type: "mouse", event: "released", x: 195, y: 422, button: "left", clickCount: 1 },
      { type: "text", text: "hello" },
    ]);
    // Handed back: input stops again.
    expect((await r.api(r.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    await until(() => phone.texts.some((t) => t.type === "state" && (t.computer as { controller: string }).controller === "assistant" && phone.texts.indexOf(t) > 1));
    phone.ws.send(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
    await sleep(80);
    expect(mine.sent.length).toBe(4);
  });

  test("M20: opening the live screen on a blank browser opens the start page; an open page stays", async () => {
    const { connect } = await start();
    const navigations = () => rig!.fake.calls.filter((c) => c.path === "/navigate").map((c) => (c.body as { url: string }).url);
    await connect(rig!.alex);
    await until(() => navigations().length === 1);
    expect(navigations()).toEqual([START_PAGE_URL]);
    expect(rig!.fake.url).toBe(START_PAGE_URL);
    // A second viewer on a page that isn't blank: nothing is opened.
    await connect(rig!.alex);
    await sleep(100);
    expect(navigations()).toEqual([START_PAGE_URL]);
  });

  test("M27 browser: the computer's tabs go to the phone as browser_bar, normalised, only when they change", async () => {
    const { r, upstreams, connect } = await start();
    const phone = await connect(r.alex);
    await until(() => upstreams.length === 1);
    const up = upstreams[0]!;
    const tabs = (url: string) => up.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [{ id: "A", url, title: url, active: true }, { id: "B", url: "about:blank", title: "", active: false }], canGoBack: true, canGoForward: false, browserBarInFrame: false }) });
    tabs("https://a.example/");
    tabs("https://a.example/");
    await until(() => phone.texts.some((t) => t.type === "browser_bar"));
    await sleep(50);
    const bars = () => phone.texts.filter((t) => t.type === "browser_bar");
    expect(bars()).toEqual([{ type: "browser_bar", bar: { supported: true, browserBarInFrame: false, tabs: [{ id: "A", url: "https://a.example/", title: "", active: true }, { id: "B", url: "", title: "", active: false }], canGoBack: true, canGoForward: false } }]);
    // While Claude drives the top bar's page is Claude's; after Take over it follows the user's tab.
    expect(r.computer.service.state().url).not.toBe("https://a.example/");
    expect((await r.api(r.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    tabs("https://b.example/x");
    await until(() => bars().length === 2);
    expect(r.computer.service.state()).toMatchObject({ url: "https://b.example/x", domain: "b.example" });
    await until(() => phone.texts.some((t) => t.type === "state" && (t.computer as { domain: string | null }).domain === "b.example"));
  });

  test("M28: revoking a session closes its WebSocket with 4001 and leaves another session open", async () => {
    const { r, upstreams, connect } = await start();
    const response = await r.fixture.app.request("/api/session", { method: "POST",
      body: JSON.stringify({ username: "alex", password: TEST_PASSWORD }) });
    const signedIn = SignInResponse.parse(await response.json());
    const other = { ...r.alex, token: signedIn.token, headers: { Authorization: `Bearer ${signedIn.token}` } };
    const first = await connect(r.alex);
    const second = await connect(other);
    await until(() => upstreams.length === 2);
    const row = await r.fixture.db.session.findUniqueOrThrow({ where: { tokenHash: sessionTokenHash(r.alex.token) } });
    expect((await r.api(other, `/api/sessions/${row.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await first.closed).toBe(4001);
    await until(() => upstreams[0]!.closed);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(upstreams[1]!.closed).toBe(false);
    expect((await r.api(r.alex, "/api/me")).status).toBe(401);
  });
  test("closing either side closes the other", async () => {
    const { upstreams, connect } = await start();
    const phone = await connect(rig!.alex);
    await until(() => upstreams.length === 1);
    phone.ws.close();
    await until(() => upstreams[0]!.closed);
    const second = await connect(rig!.alex);
    await until(() => upstreams.length === 2);
    upstreams[1]!.end();
    expect(await second.closed).toBe(1011);
  });
});
