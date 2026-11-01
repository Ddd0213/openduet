// M27 browser: the full-screen view's own tab strip and address bar. What the address field means,
// the bar made from the computer's tab state, the routes (read any time; act only after Take over,
// audited, counted as the user's input), an older computer without tab routes, and the stream's
// browser_bar message. The computer is test/computer/fake-computer.ts (patch 0006's routes).
import { afterEach, describe, expect, test } from "bun:test";
import { activeUrl, barFromComputer, BING, cleanTitle, cleanUrl, engineFor, GOOGLE, resolveAddress, SEARCH_URL } from "../../src/computer/browser-bar.ts";
import { BAR_RATE_MAX, BAR_RATE_WINDOW_MS, MAX_OPEN_TABS, START_PAGE_URL } from "../../src/computer/service.ts";
import { BrowserBar, ComputerServerMessage, NavigateRequest, NewTabRequest } from "../../src/contract/index.ts";
import { HttpError } from "../../src/http.ts";
import { signUp } from "../helpers/session.ts";
import { computerRig, sleep, type ComputerRig } from "./harness.ts";

let rig: ComputerRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const refused = (typed: string) => {
  try {
    resolveAddress(typed);
    return null;
  } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.code} ${error.field}` : String(error);
  }
};

describe("the address field", () => {
  test("an http(s) address as it is, a bare host as https", () => {
    expect(resolveAddress(" https://example.com/a?b=1 ")).toEqual({ url: "https://example.com/a?b=1", search: false });
    expect(resolveAddress("example.com")).toEqual({ url: "https://example.com/", search: false });
    expect(resolveAddress("news.ycombinator.com/item?id=1").url).toBe("https://news.ycombinator.com/item?id=1");
    expect(resolveAddress("localhost:3000").url).toBe("https://localhost:3000/");
    expect(resolveAddress("192.168.1.1").url).toBe("https://192.168.1.1/");
    expect(resolveAddress("例子.中国").url).toBe("https://xn--fsqu00a.xn--fiqs8s/");
  });

  test("words are a Bing search, the query encoded", () => {
    expect(resolveAddress("weather in paris")).toEqual({ url: `${SEARCH_URL}weather%20in%20paris`, search: true });
    expect(resolveAddress("github").search).toBe(true);
    expect(resolveAddress("3.14").search).toBe(true);
    expect(resolveAddress("note: buy milk").url).toBe(`${SEARCH_URL}note%3A%20buy%20milk`);
    expect(resolveAddress("a@b.com").search).toBe(true);
  });

  test("C2: the engine by region: mainland China or unknown -> Bing, any other region -> Google", () => {
    for (const region of [null, undefined, "", " ", "CN", "cn"]) expect(engineFor(region)).toBe(BING);
    for (const region of ["US", "GB", "DE", "JP", "HK", "TW", "us"]) expect(engineFor(region)).toBe(GOOGLE);
    expect(BING).toEqual({ startPage: "https://www.bing.com/", searchUrl: "https://www.bing.com/search?q=" });
    expect(GOOGLE).toEqual({ startPage: "https://www.google.com/", searchUrl: "https://www.google.com/search?q=" });
    expect(SEARCH_URL).toBe(BING.searchUrl);
    expect(START_PAGE_URL).toBe(BING.startPage);
    expect(resolveAddress("weather in paris", GOOGLE.searchUrl)).toEqual({ url: "https://www.google.com/search?q=weather%20in%20paris", search: true });
    // An address stays an address whatever the engine; a refused scheme stays refused.
    expect(resolveAddress("example.com", GOOGLE.searchUrl)).toEqual({ url: "https://example.com/", search: false });
    expect(() => resolveAddress("javascript:alert(1)", GOOGLE.searchUrl)).toThrow(HttpError);
  });

  test("any other scheme is refused: the browser opens web pages only", () => {
    for (const typed of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://settings", "about:blank", "mailto:a@b.com", "view-source:https://a.com"]) {
      expect(refused(typed)).toBe("400 validation_failed address");
    }
    expect(refused("http://")).toBe("400 validation_failed address");
    expect(refused("   ")).toBe("400 validation_failed address");
    expect(refused(`https://a.com/${"x".repeat(2000)}`)).toBe("400 validation_failed address");
  });
});

describe("the bar from the computer's tab state", () => {
  test("blank pages and titles that repeat the address read empty; one active; tolerant of junk", () => {
    const bar = barFromComputer({
      tabs: [
        { id: "A", url: "about:blank", title: "about:blank", active: false },
        { id: "B", url: "https://a.example/", title: "https://a.example/", active: true },
        { id: "C", url: "chrome://newtab/", title: "New Tab", active: true },
        { id: "", url: "https://dropped.example/" },
        "junk",
        { id: "B", url: "https://duplicate.example/" },
      ],
      canGoBack: true,
      canGoForward: "yes",
      browserBarInFrame: true,
    });
    expect(bar).toEqual({
      supported: true,
      browserBarInFrame: true,
      tabs: [
        { id: "A", url: "", title: "", active: false },
        { id: "B", url: "https://a.example/", title: "", active: true },
        { id: "C", url: "", title: "", active: false },
      ],
      canGoBack: true,
      canGoForward: false,
    });
    expect(BrowserBar.safeParse(bar).success).toBe(true);
    expect(activeUrl(bar)).toBe("https://a.example/");
    expect(barFromComputer(null)).toMatchObject({ supported: true, tabs: [] });
  });

  test("at most 50 tabs, and the active one is always among them", () => {
    const tabs = Array.from({ length: 60 }, (_, index) => ({ id: `T${index}`, url: `https://${index}.example/`, title: `${index}`, active: index === 57 }));
    const bar = barFromComputer({ tabs, canGoBack: false, canGoForward: false });
    expect(bar.tabs.length).toBe(50);
    expect(bar.tabs.at(-1)).toMatchObject({ id: "T57", active: true });
    expect(BrowserBar.safeParse(bar).success).toBe(true);
  });

  test("the contract: requests and the stream message", () => {
    expect(NewTabRequest.safeParse({}).success).toBe(true);
    expect(NewTabRequest.safeParse({ address: "example.com" }).success).toBe(true);
    expect(NewTabRequest.safeParse({ url: "https://a.com" }).success).toBe(false);
    expect(NavigateRequest.safeParse({ address: "a.com" }).success).toBe(true);
    expect(NavigateRequest.safeParse({ action: "back" }).success).toBe(true);
    expect(NavigateRequest.safeParse({ action: "home" }).success).toBe(false);
    expect(NavigateRequest.safeParse({ address: "a.com", action: "back" }).success).toBe(false);
    const bar = { supported: true, browserBarInFrame: false, tabs: [], canGoBack: false, canGoForward: false };
    expect(ComputerServerMessage.safeParse({ type: "browser_bar", bar }).success).toBe(true);
  });
});

type Bar = { supported: boolean; tabs: { id: string; url: string; title: string; active: boolean }[]; canGoBack: boolean; canGoForward: boolean };
const barOf = async (response: Response): Promise<Bar> => {
  expect(response.status).toBe(200);
  return BrowserBar.parse(await response.json()) as Bar;
};
const codeOf = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
const active = (bar: Bar) => bar.tabs.find((tab) => tab.active);

describe("GET / POST /api/computer/tabs, /tabs/:id/activate|close, /navigate", () => {
  test("reading works while Claude drives and starts nothing; acting needs Take over (409 take_over_first)", async () => {
    rig = await computerRig();
    const bar = await barOf(await rig.api(rig.alex, "/api/computer/tabs"));
    expect(bar).toMatchObject({ supported: true, tabs: [{ id: "T1", url: "", title: "", active: true }], canGoBack: false });
    expect(rig.fake.browser).toBe(false);
    for (const [path, body] of [["/api/computer/tabs", {}], ["/api/computer/tabs/T1/activate", undefined], ["/api/computer/tabs/T1/close", undefined], ["/api/computer/navigate", { address: "example.com" }], ["/api/computer/navigate", { action: "reload" }]] as const) {
      expect(await codeOf(await rig.api(rig.alex, path, { method: "POST", ...(body ? { body } : {}) }))).toEqual([409, "take_over_first"]);
    }
    expect(rig.fake.calls.filter((c) => c.method === "POST" && c.path.startsWith("/human/"))).toEqual([]);
    expect(await rig.fixture.db.auditLog.count({ where: { action: { startsWith: "browser_" } } })).toBe(0);
  });

  test("after Take over: new tab, type an address, back / forward, switch, close (the last opens the start page)", async () => {
    let now = Date.now();
    rig = await computerRig({ now: () => now });
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    const service = rig.computer.service;
    const post = (path: string, body?: unknown) => rig!.api(rig!.alex, path, { method: "POST", ...(body === undefined ? {} : { body }) });

    // + with nothing typed: the start page, in front.
    let bar = await barOf(await post("/api/computer/tabs", {}));
    expect(bar.tabs.map((t) => [t.id, t.active])).toEqual([["T1", false], ["T2", true]]);
    expect(active(bar)?.url).toBe(START_PAGE_URL);
    expect(rig.fake.calls.at(-1)).toMatchObject({ path: "/human/tabs", body: { action: "new", url: START_PAGE_URL } });

    // Words in the address field: a search; a host: https. The top bar's domain follows.
    bar = await barOf(await post("/api/computer/navigate", { address: "best ramen" }));
    expect(active(bar)?.url).toBe(`${SEARCH_URL}best%20ramen`);
    bar = await barOf(await post("/api/computer/navigate", { address: "example.com" }));
    expect(active(bar)).toMatchObject({ url: "https://example.com/", title: "Title of example.com" });
    expect(bar.canGoBack).toBe(true);
    expect(service.state()).toMatchObject({ controller: "user", url: "https://example.com/", domain: "example.com" });
    bar = await barOf(await post("/api/computer/navigate", { action: "back" }));
    expect(active(bar)?.url).toBe(`${SEARCH_URL}best%20ramen`);
    expect(bar.canGoForward).toBe(true);
    bar = await barOf(await post("/api/computer/navigate", { action: "forward" }));
    expect(active(bar)?.url).toBe("https://example.com/");
    await barOf(await post("/api/computer/navigate", { action: "reload" }));

    // Switch back to the first tab; Claude will carry on in the tab picked last.
    bar = await barOf(await post("/api/computer/tabs/T1/activate"));
    expect(active(bar)?.id).toBe("T1");
    expect(rig.fake.activeTab).toBe("T1");

    // Close the active tab: its neighbour takes over. Close the last: the start page opens first.
    bar = await barOf(await post("/api/computer/tabs/T1/close"));
    expect(bar.tabs.map((t) => t.id)).toEqual(["T2"]);
    bar = await barOf(await post("/api/computer/tabs/T2/close"));
    expect(bar.tabs.length).toBe(1);
    expect(active(bar)).toMatchObject({ url: START_PAGE_URL });
    expect(rig.fake.calls.at(-1)).toMatchObject({ path: "/human/tabs", body: { action: "close", tabId: "T2", replaceWith: START_PAGE_URL } });

    // Each is the user's input (the auto hand back stays away) and an audit row with the domain only.
    now += 9 * 60_000;
    await barOf(await post("/api/computer/navigate", { action: "reload" }));
    now += 9 * 60_000;
    expect(await service.autoHandBack()).toBe(false);
    const rows = await rig.fixture.db.auditLog.findMany({ where: { action: { startsWith: "browser_" } }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.action, r.actor, r.target, r.outcome])).toEqual([
      ["browser_new_tab", "user", "www.bing.com", "ok"],
      ["browser_navigate", "user", "www.bing.com", "ok"],
      ["browser_navigate", "user", "example.com", "ok"],
      ["browser_back", "user", "www.bing.com", "ok"],
      ["browser_forward", "user", "example.com", "ok"],
      ["browser_reload", "user", "example.com", "ok"],
      ["browser_switch_tab", "user", "", "ok"],
      ["browser_close_tab", "user", "", "ok"],
      ["browser_close_tab", "user", "example.com", "ok"],
      ["browser_reload", "user", "www.bing.com", "ok"],
    ]);
    // What was typed never reaches the audit log.
    expect(JSON.stringify(rows)).not.toContain("ramen");
  });

  test("refusals: another scheme (400, nothing sent), a tab that closed or never was (404), bad bodies (400)", async () => {
    rig = await computerRig();
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    const before = rig.fake.calls.length;
    const post = (path: string, body?: unknown) => rig!.api(rig!.alex, path, { method: "POST", ...(body === undefined ? {} : { body }) });
    expect(await codeOf(await post("/api/computer/navigate", { address: "javascript:alert(1)" }))).toEqual([400, "validation_failed"]);
    expect(await codeOf(await post("/api/computer/tabs", { address: "file:///etc/passwd" }))).toEqual([400, "validation_failed"]);
    expect(rig.fake.calls.slice(before).filter((c) => c.path.startsWith("/human/"))).toEqual([]);
    expect(await codeOf(await post("/api/computer/tabs/NOPE/activate"))).toEqual([404, "not_found"]);
    expect(await codeOf(await post("/api/computer/tabs/..%2Fx/close"))).toEqual([404, "not_found"]);
    expect(await codeOf(await post("/api/computer/navigate", { action: "home" }))).toEqual([400, "validation_failed"]);
    expect(await codeOf(await post("/api/computer/navigate", {}))).toEqual([400, "validation_failed"]);
    expect(await codeOf(await post("/api/computer/tabs", { url: "https://a.com" }))).toEqual([400, "validation_failed"]);
    // The computer took the wheel back meanwhile (its own hand back): 409, and the state catches up.
    rig.fake.holder = "bot";
    expect(await codeOf(await post("/api/computer/navigate", { action: "reload" }))).toEqual([409, "take_over_first"]);
    await sleep(50);
    expect(rig.computer.service.state().controller).toBe("assistant");
  });

  test("C2: the start page and the search follow the user's region (X-Region): Google elsewhere, Bing for CN", async () => {
    rig = await computerRig();
    const post = (path: string, region: string, body?: unknown) =>
      rig!.api(rig!.alex, path, { method: "POST", headers: { "X-Region": region }, ...(body === undefined ? {} : { body }) });
    expect((await post("/api/computer/take", "US")).status).toBe(200);

    // A phone in the US: a new tab opens Google, words are a Google search, the last tab closed is Google.
    let bar = await barOf(await post("/api/computer/tabs", "US", {}));
    expect(active(bar)?.url).toBe(GOOGLE.startPage);
    expect(rig.fake.calls.at(-1)).toMatchObject({ path: "/human/tabs", body: { action: "new", url: "https://www.google.com/" } });
    bar = await barOf(await post("/api/computer/navigate", "US", { address: "best ramen" }));
    expect(active(bar)?.url).toBe("https://www.google.com/search?q=best%20ramen");
    await barOf(await post("/api/computer/tabs/T1/close", "US"));
    bar = await barOf(await post("/api/computer/tabs/T2/close", "US"));
    expect(rig.fake.calls.at(-1)).toMatchObject({ path: "/human/tabs", body: { action: "close", tabId: "T2", replaceWith: "https://www.google.com/" } });
    expect(active(bar)?.url).toBe(GOOGLE.startPage);

    // The same account, now in mainland China: Bing.
    bar = await barOf(await post("/api/computer/navigate", "CN", { address: "best ramen" }));
    expect(active(bar)?.url).toBe("https://www.bing.com/search?q=best%20ramen");
    bar = await barOf(await post("/api/computer/tabs", "CN", {}));
    expect(active(bar)?.url).toBe(BING.startPage);
    expect(await rig.fixture.db.user.findUniqueOrThrow({ where: { id: rig.alex.userId }, select: { region: true } })).toEqual({ region: "CN" });
  });

  test("C2: COMPUTER_START_URL wins over the region for the start page; the search still follows the region", async () => {
    rig = await computerRig({ env: { COMPUTER_START_URL: "https://start.example/" } });
    const post = (path: string, body?: unknown) =>
      rig!.api(rig!.alex, path, { method: "POST", headers: { "X-Region": "US" }, ...(body === undefined ? {} : { body }) });
    expect((await post("/api/computer/take")).status).toBe(200);
    let bar = await barOf(await post("/api/computer/tabs", {}));
    expect(active(bar)?.url).toBe("https://start.example/");
    bar = await barOf(await post("/api/computer/navigate", { address: "best ramen" }));
    expect(active(bar)?.url).toBe("https://www.google.com/search?q=best%20ramen");
  });

  test("C2: a woken blank browser opens the owner's region's start page (Google outside CN, Bing when unknown)", async () => {
    rig = await computerRig();
    await rig.computer.service.openStartPage();
    expect(rig.fake.url).toBe(BING.startPage);
    rig.fake.url = "about:blank";
    await rig.fixture.db.user.update({ where: { id: rig.alex.userId }, data: { region: "DE" } });
    await rig.computer.service.openStartPage();
    expect(rig.fake.url).toBe(GOOGLE.startPage);
    expect(rig.fake.calls.filter((c) => c.path === "/navigate").map((c) => (c.body as { url: string }).url)).toEqual([BING.startPage, GOOGLE.startPage]);
  });

  test("an older computer (no tab routes): supported false, and actions answer 501 tabs_unsupported", async () => {
    rig = await computerRig();
    rig.fake.noTabs = true;
    expect(await barOf(await rig.api(rig.alex, "/api/computer/tabs"))).toEqual({ supported: false, browserBarInFrame: false, tabs: [], canGoBack: false, canGoForward: false } as never);
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    expect(await codeOf(await rig.api(rig.alex, "/api/computer/navigate", { method: "POST", body: { address: "a.com" } }))).toEqual([501, "tabs_unsupported"]);
  });

  test("another account sees no computer (503); a computer that is down is 502", async () => {
    rig = await computerRig();
    const sam = await signUp(rig.fixture, "sam");
    expect(await codeOf(await rig.api(sam, "/api/computer/tabs"))).toEqual([503, "not_configured"]);
    expect(await codeOf(await rig.api(sam, "/api/computer/tabs", { method: "POST", body: {} }))).toEqual([503, "not_configured"]);
    expect((await rig.api(null, "/api/computer/tabs")).status).toBe(401);
    rig.fake.down = true;
    expect(await codeOf(await rig.api(rig.alex, "/api/computer/tabs"))).toEqual([502, "internal"]);
  });
});

const message = (typed: string, searchUrl?: string) => {
  try {
    resolveAddress(typed, searchUrl);
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.message : String(error);
  }
};

describe("recheck R1-R3: what a page chose is cleaned, credentials and overlong addresses are refused", () => {
  test("R1 titles: hidden and direction characters go, one line, never half an emoji, always well-formed", () => {
    expect(cleanTitle("\u202Egnp.exe\u0007\n\r\u2026")).toBe("gnp.exe \u2026");
    expect(cleanTitle("a\u200bb\u2066c\u2069d\ufeffe\u200ef\u061cg\u0085h")).toBe("abcdefg h");
    expect(cleanTitle("  a\t\tb  \u3000 c  ")).toBe("a b c");
    // ZWJ stays: a family emoji is one sequence.
    expect(cleanTitle("\u{1F468}\u200d\u{1F469}\u200d\u{1F467}")).toBe("\u{1F468}\u200d\u{1F469}\u200d\u{1F467}");
    // 299 units then an emoji: the cut drops the whole emoji, not half of it.
    const atCut = cleanTitle(`${"x".repeat(299)}\u{1F600}tail`);
    expect(atCut).toBe("x".repeat(299));
    expect(atCut.isWellFormed()).toBe(true);
    // A lone surrogate the page already had becomes U+FFFD.
    expect(cleanTitle("a\ud83db")).toBe("a\ufffdb");
    expect(cleanTitle(42)).toBe("");
    for (const title of [cleanTitle("\u{1F600}".repeat(400)), cleanTitle("y".repeat(5000))]) {
      expect(title.length).toBeLessThanOrEqual(300);
      expect(title.isWellFormed()).toBe(true);
    }
  });

  test("R1/R2 URLs: parsed http(s) only, without credentials; anything else reads empty", () => {
    expect(cleanUrl("https://user:pass@evil.example/x?a=1")).toBe("https://evil.example/x?a=1");
    expect(cleanUrl("https://bank.example@evil.example/")).toBe("https://evil.example/");
    expect(cleanUrl("https://ex\u00e4mple.de/\u00fc")).toBe("https://xn--exmple-cua.de/%C3%BC");
    for (const raw of ["javascript:alert(1)", "chrome-error://chromewebdata/", "data:text/html,x", "not a url", "", `https://a.example/${"x".repeat(5000)}`]) {
      expect(cleanUrl(raw)).toBe("");
    }
  });

  test("R1 the bar: cleaned titles and URLs, malformed tab ids dropped, still the contract", () => {
    const bar = barFromComputer({
      tabs: [
        { id: "A", url: "https://bank.example@evil.example/", title: "\u202Elanigiro", active: true },
        { id: "../x", url: "https://dropped.example/", title: "t" },
        { id: "x".repeat(201), url: "https://dropped.example/", title: "t" },
        { id: "B", url: "https://b.example/", title: `${"z".repeat(299)}\u{1F600}` },
      ],
    });
    expect(bar.tabs).toEqual([
      { id: "A", url: "https://evil.example/", title: "lanigiro", active: true },
      { id: "B", url: "https://b.example/", title: "z".repeat(299), active: false },
    ]);
    expect(BrowserBar.safeParse(bar).success).toBe(true);
    expect(JSON.stringify(bar)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
  });

  test("R2 typed credentials are refused; R3 an address or search too long for the computer says so", () => {
    expect(refused("https://bank.example@evil.example/")).toBe("400 validation_failed address");
    expect(refused("https://user:pass@evil.example/")).toBe("400 validation_failed address");
    expect(message("https://user:pass@evil.example/")).toBe("address: addresses with a user name or password can't be opened");
    // "a@b.com" without a scheme is still a search (no credentials are opened).
    expect(resolveAddress("a@b.com").search).toBe(true);
    // 300 CJK characters are well under the 2000-character field but encode past the computer's cap.
    expect(message("\u4e2d".repeat(300))).toBe("address: too long to search for");
    expect(message("\u4e2d".repeat(300), GOOGLE.searchUrl)).toBe("address: too long to search for");
    expect(resolveAddress("\u4e2d".repeat(200)).url.length).toBeLessThanOrEqual(2000);
    expect(message(`https://a.example/${"\u00fc".repeat(500)}`)).toBe("address: too long");
  });

  test("P2-3 titles: every control and default-ignorable character goes; what visible text needs stays", () => {
    const tags = (ascii: string) => [...ascii].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0)!)).join("");
    // Invisible ASCII smuggled in tag characters is removed.
    expect(cleanTitle(`Bank login${tags("IGNORE PREVIOUS")}`)).toBe("Bank login");
    // A title of fillers only reads empty (the strip falls back to the domain).
    expect(cleanTitle("\u3164\u3164\u115f\uffa0")).toBe("");
    expect(cleanTitle("a\u00adb\u034fc\u180ed\u2065e\u206af\ufffbg\u0600h")).toBe("abcdefgh");
    // Kept: the England flag (tags inside a flag), a variation selector, the ZWJ family, ZWNJ, Mongolian FVS.
    const england = `\u{1F3F4}${tags("gbeng")}\u{E007F}`;
    expect(cleanTitle(`${england} News`)).toBe(`${england} News`);
    expect(cleanTitle("\u2764\ufe0f \u{1F468}\u200d\u{1F469}\u200d\u{1F467}")).toBe("\u2764\ufe0f \u{1F468}\u200d\u{1F469}\u200d\u{1F467}");
    expect(cleanTitle("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645");
    expect(cleanTitle("\u1820\u180b\u1821")).toBe("\u1820\u180b\u1821");
    expect(cleanTitle("\u05e2\u05d1\u05e8\u05d9\u05ea \u0639\u0631\u0628\u064a")).toBe("\u05e2\u05d1\u05e8\u05d9\u05ea \u0639\u0631\u0628\u064a");
  });

  test("P2-4 pages that aren't http(s): blob: reads as its origin; no address means no title", () => {
    const bar = barFromComputer({
      tabs: [
        { id: "A", url: "blob:https://evil.example/2f1c-uuid", title: "Sign in - Google Accounts", active: true },
        { id: "B", url: "about:blank", title: "PayPal - Log In" },
        { id: "C", url: "data:text/html,<h1>x</h1>", title: "Bank" },
        { id: "D", url: "blob:null/abc", title: "x" },
      ],
    });
    expect(bar.tabs.map((t) => [t.id, t.url, t.title])).toEqual([
      ["A", "https://evil.example/", "Sign in - Google Accounts"],
      ["B", "", ""],
      ["C", "", ""],
      ["D", "", ""],
    ]);
  });

  test("P2-5 half a surrogate pair typed in the field is a 400, not a 500", async () => {
    expect(refused("abc\ud83d")).toBe("400 validation_failed address");
    expect(message("\udc00 search")).toBe("address: not a valid web address");
    rig = await computerRig();
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    expect(await codeOf(await rig.api(rig.alex, "/api/computer/navigate", { method: "POST", body: { address: "x\ud83d" } }))).toEqual([400, "validation_failed"]);
  });
});

describe("recheck R4: a cap on open tabs and on how often the bar acts", () => {
  test(`at most ${MAX_OPEN_TABS} tabs from the bar (409 conflict, nothing sent); other actions still work`, async () => {
    let now = Date.now();
    rig = await computerRig({ now: () => now });
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    const post = (path: string, body?: unknown) => rig!.api(rig!.alex, path, { method: "POST", ...(body === undefined ? {} : { body }) });
    let bar = await barOf(await rig.api(rig.alex, "/api/computer/tabs"));
    while (bar.tabs.length < MAX_OPEN_TABS) {
      now += BAR_RATE_WINDOW_MS;
      bar = await barOf(await post("/api/computer/tabs", {}));
    }
    const before = rig.fake.calls.length;
    expect(await codeOf(await post("/api/computer/tabs", {}))).toEqual([409, "conflict"]);
    expect(rig.fake.calls.slice(before).filter((c) => c.method === "POST" && c.path.startsWith("/human/"))).toEqual([]);
    expect((await barOf(await post("/api/computer/navigate", { action: "reload" }))).tabs.length).toBe(MAX_OPEN_TABS);
    bar = await barOf(await post(`/api/computer/tabs/${bar.tabs[0]!.id}/close`));
    expect(bar.tabs.length).toBe(MAX_OPEN_TABS - 1);
    expect((await barOf(await post("/api/computer/tabs", {}))).tabs.length).toBe(MAX_OPEN_TABS);
  });

  test(`at most ${BAR_RATE_MAX} bar actions in ${BAR_RATE_WINDOW_MS / 1000} s (429 rate_limited), then fine again`, async () => {
    let now = Date.now();
    rig = await computerRig({ now: () => now });
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    const reload = () => rig!.api(rig!.alex, "/api/computer/navigate", { method: "POST", body: { action: "reload" } });
    for (let i = 0; i < BAR_RATE_MAX; i++) expect((await reload()).status).toBe(200);
    expect(await codeOf(await reload())).toEqual([429, "rate_limited"]);
    // Reading the bar is never limited.
    expect((await rig.api(rig.alex, "/api/computer/tabs")).status).toBe(200);
    now += BAR_RATE_WINDOW_MS;
    expect((await reload()).status).toBe(200);
  });

  test("P2-2 concurrent + can't pass the cap, and after a restart the cap asks the computer", async () => {
    let now = Date.now();
    rig = await computerRig({ now: () => now });
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    const post = (path: string, body?: unknown) => rig!.api(rig!.alex, path, { method: "POST", ...(body === undefined ? {} : { body }) });
    let bar = await barOf(await rig.api(rig.alex, "/api/computer/tabs"));
    while (bar.tabs.length < MAX_OPEN_TABS - 1) {
      now += BAR_RATE_WINDOW_MS;
      bar = await barOf(await post("/api/computer/tabs", {}));
    }
    now += BAR_RATE_WINDOW_MS;
    // Five + at once with one place left: exactly one opens.
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => post("/api/computer/tabs", {})))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(rig.fake.tabs.length).toBe(MAX_OPEN_TABS);
    // A backend that holds no bar yet (as after a restart) reads the tabs before it decides.
    (rig.computer.service as unknown as { lastBar: unknown }).lastBar = null;
    const before = rig.fake.calls.length;
    expect(await codeOf(await post("/api/computer/tabs", {}))).toEqual([409, "conflict"]);
    expect(rig.fake.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /human/tabs"]);
    expect(rig.fake.tabs.length).toBe(MAX_OPEN_TABS);
  });
});
