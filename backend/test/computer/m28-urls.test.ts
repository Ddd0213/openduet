// M28 R5/P2-7: full addresses stay with Claude and the live bar; persisted state is origin + path.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { modelPageUrl, publicPageUrl } from "../../src/computer/paths.ts";
import { computerStreamHandler, streamData } from "../../src/computer/stream.ts";
import { call, computerRig, text, type ComputerRig } from "./harness.ts";

let rig: ComputerRig | null = null;
afterEach(async () => { await rig?.cleanup(); rig = null; });

const full = "https://a.example/cb?code=SECRET#x";
const raw = "https://test-user:test-pass@a.example/cb?code=SECRET#x";
const short = "https://a.example/cb";

describe("page address views", () => {
  test("removes credentials from both views, retaining query and fragment only for Claude", () => {
    for (const input of [full, raw, "https://test-user@a.example/cb?code=SECRET#x", "https://:test-pass@a.example/cb?code=SECRET#x"]) {
      expect(modelPageUrl(input)).toBe(full);
      expect(publicPageUrl(input)).toBe(short);
    }
    expect(publicPageUrl("http://u:p@[::1]:8080/a%20b?secret=x#y")).toBe("http://[::1]:8080/a%20b");
    expect(modelPageUrl(`https://a.example/?q=${"x".repeat(5000)}`)?.length).toBeGreaterThan(5000);
  });

  test("invalid and non-web addresses cannot enter public state; Claude recognizes a blank page", () => {
    for (const input of [null, undefined, "", "not a url", "data:text/plain,private", "file:///private", "javascript:alert(1)"]) {
      expect(modelPageUrl(input)).toBeNull();
      expect(publicPageUrl(input)).toBeNull();
    }
    expect(modelPageUrl("about:blank")).toBe("about:blank");
    expect(publicPageUrl("about:blank")).toBeNull();
  });
});

for (const input of [full, raw]) {
  test(`Claude's navigation, read, snapshot, action and screenshot keep the full credential-free URL (${input === raw ? "userinfo" : "callback"})`, async () => {
    rig = await computerRig();
    const logs: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => { logs.push(String(chunk)); return true; });
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => { logs.push(String(chunk)); return true; });
    try {
      rig.llm.script("chat",
        [call("computer_navigate", { url: input })],
        [call("computer_read", {})],
        [call("computer_snapshot", {})],
        [call("computer_scroll", {})],
        [call("computer_screenshot", {})],
        [text("Done.")],
      );
      const states: unknown[] = [];
      const stop = rig.computer.service.subscribe((state) => states.push(state));
      const frames = await rig.send(rig.alex, "Browse the callback page");
      stop();
      expect(rig.results).toHaveLength(5);
      for (const result of rig.results) expect(result.data.url).toBe(full);
      expect(rig.computer.service.pageUrl).toBe(full);
      expect(await (await rig.api(rig.alex, "/api/computer")).json()).toMatchObject({ url: short, domain: "a.example" });
      const events = frames.events.filter((event) => event.type === "computer");
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.payload.computer.url).toBe(short);
      expect(states.at(-1)).toMatchObject({ url: short, domain: "a.example" });
      const stored = await rig.fixture.db.event.findMany({ where: { type: "computer" } });
      expect(stored.some((row) => JSON.parse(row.payload).computer.url === short)).toBe(true);
      const replay = (await rig.fixture.events.replay(rig.alex.userId, 0)).filter((event) => event.type === "computer");
      expect(replay.at(-1)?.payload.computer.url).toBe(short);
      const audits = await rig.fixture.db.auditLog.findMany();
      expect(audits).toHaveLength(5);
      expect(audits.every((entry) => entry.target === "a.example")).toBe(true);
      const persisted = JSON.stringify([stored, replay, audits, states]);
      for (const sensitive of ["SECRET", "test-user", "test-pass", "#x"]) {
        expect(persisted).not.toContain(sensitive);
        expect(logs.join("\n")).not.toContain(sensitive);
      }
      // GET /tabs is a live, credential-free full address, and never creates a replay event.
      const before = await rig.fixture.db.event.count({ where: { type: "computer" } });
      const bar = await (await rig.api(rig.alex, "/api/computer/tabs")).json() as { tabs: { url: string }[] };
      expect(bar.tabs[0]?.url).toBe(full);
      expect(await rig.fixture.db.event.count({ where: { type: "computer" } })).toBe(before);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
}

test("all state update paths sanitize before broadcast, including human checks and the start page", async () => {
  rig = await computerRig({ env: { COMPUTER_START_URL: full } });
  const service = rig.computer.service;
  await service.openStartPage();
  expect(service.pageUrl).toBe(full);
  expect(service.state().url).toBe(short);
  for (const update of [() => service.notePage(raw), () => service.noteSnapshot(42, raw), () => service.acted(raw)]) {
    await update();
    expect(service.pageUrl).toBe(full);
    expect(service.state()).toMatchObject({ url: short, domain: "a.example" });
  }
  rig.llm.script("chat", [call("computer_navigate", { url: "https://u:p@captcha.example/check?code=SECRET#x" })]);
  await rig.send(rig.alex, "Open the page with a human check");
  expect(service.pageUrl).toBe("https://captcha.example/check?code=SECRET#x");
  expect(service.state()).toMatchObject({ url: "https://captcha.example/check", blocked: "human_check" });
});

test("the user's streamed bar keeps the full URL while state and Event use origin + path", async () => {
  rig = await computerRig();
  await rig.computer.service.take(rig.alex.userId);
  const sent: string[] = [];
  const upstream = { onmessage: null as ((event: { data: string }) => void) | null, close() {} };
  const handler = computerStreamHandler(rig.computer.service, { connect: () => upstream as unknown as WebSocket });
  const ws = { data: streamData(rig.alex.userId, "session-m28-urls"), send: (value: unknown) => { sent.push(String(value)); return 1; }, close() {}, getBufferedAmount: () => 0 };
  handler.open!(ws as never);
  try {
    upstream.onmessage!({ data: JSON.stringify({ type: "tabs", tabs: [{ id: "A", url: raw, title: "Callback", active: true }] }) });
    await rig.computer.service.changed();
    const messages = sent.map((value) => JSON.parse(value));
    expect(messages.filter((message) => message.type === "state").at(-1).computer.url).toBe(short);
    expect(messages.find((message) => message.type === "browser_bar").bar.tabs[0].url).toBe(full);
    expect(rig.computer.service.pageUrl).toBe(full);
    const events = await rig.fixture.db.event.findMany({ where: { type: "computer" } });
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(JSON.parse(events.at(-1)!.payload).computer.url).toBe(short);
  } finally {
    handler.close!(ws as never, 1000, "done");
  }
});

test("computer patch navigation failure logs never quote Playwright's raw URL", async () => {
  // Execute the actual patched functions on a throwing page, without a browser or upstream checkout.
  const patch = readFileSync(new URL("../../../computer/patches/0006-bot-tabs-portrait.patch", import.meta.url), "utf8");
  const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
  const goto = added.slice(added.indexOf("async function humanGoto("), added.indexOf("/** OpenDuet patch 0006: a tab put in front"));
  const navigate = added.slice(added.indexOf("async function humanNavigate("), added.indexOf("/*\n * OpenDuet patch 0006: the attach"));
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`${goto}\n${navigate}\n}`);
  const messages: string[] = [];
  const error = new Error(`page.goto: net::ERR_FAILED at ${raw}`);
  const page = { goto: async () => { throw error; }, reload: async () => { throw error; }, goBack: async () => { throw error; }, goForward: async () => { throw error; }, isClosed: () => true };
  const functions = new Function("currentPage", "console", "ERROR_PAGE", "HUMAN_NAVIGATION_MS", "ERROR_PAGE_MS", `${source}\nreturn { humanGoto, humanNavigate };`)(
    async () => page, { info: (message: string) => messages.push(message) }, "chrome-error://", 15_000, 0,
  ) as { humanGoto(page: unknown, address: string): Promise<void>; humanNavigate(bot: string, action: unknown): Promise<boolean> };
  await functions.humanGoto(page, raw);
  for (const action of ["reload", "back", "forward"]) await functions.humanNavigate("test", { action });
  expect(messages).toHaveLength(4);
  expect(JSON.parse(messages[0]!).reason).toBe("net::ERR_FAILED");
  for (const sensitive of ["SECRET", "test-user", "test-pass", "https://", "#x"]) expect(messages.join("\n")).not.toContain(sensitive);
});
