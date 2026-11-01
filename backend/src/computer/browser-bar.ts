// M27 browser: what the app's own tab strip and address bar show, made from the computer's tab
// state (patch 0006: GET/POST /human/tabs, POST /human/navigate, the "tabs" message on /stream),
// and what the address field's text means. docs/API.md "## M27 browser".
import { type BrowserBar, MAX_ADDRESS_LENGTH, MAX_BROWSER_TABS } from "../contract/m27browser.ts";
import { HttpError } from "../http.ts";

/** A web search engine: the start page a new tab opens and where typed words are looked up. */
export type WebEngine = { startPage: string; searchUrl: string };

/** Bing answers in mainland China too (Google doesn't), picks the local market itself, needs no login. */
export const BING: WebEngine = { startPage: "https://www.bing.com/", searchUrl: "https://www.bing.com/search?q=" };
export const GOOGLE: WebEngine = { startPage: "https://www.google.com/", searchUrl: "https://www.google.com/search?q=" };

/** Bing's search, for a user in mainland China or of unknown region (see engineFor). */
export const SEARCH_URL = BING.searchUrl;

/**
 * C2: the engine for the user's region (User.region, from the app's X-Region): mainland China
 * ("CN") or unknown (an app before M25 sends none) -> Bing, any other region -> Google.
 */
export function engineFor(region: string | null | undefined): WebEngine {
  const code = region?.trim().toUpperCase();
  return !code || code === "CN" ? BING : GOOGLE;
}

/** A bar for a computer from before M27 (no tab routes): the app shows the address only. */
export const UNSUPPORTED_BAR: BrowserBar = { supported: false, browserBarInFrame: false, tabs: [], canGoBack: false, canGoForward: false };

const BLANK = (url: string) => url === "" || url === "about:blank" || url.startsWith("chrome://newtab") || url.startsWith("chrome://new-tab-page");

/** A scheme the way an address field reads one: letters then ":", but not "host:port". */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HOST_PORT = /^[^\s/?#:]+:\d+(?:[/?#]|$)/;
/**
 * A bare host, perhaps with a port and a path: a dotted name whose last label has a letter
 * ("3.14" is a search), an IPv4 address, localhost or a bracketed IPv6 address.
 */
const BARE_HOST =
  /^(?:\[[0-9a-f:.]+\]|(?:[^\s/?#:@.]+\.)+[^\s/?#:@.]*\p{L}[^\s/?#:@.]*|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

export type Resolved = { url: string; search: boolean };

/** One thing the user did with the bar (routes/computer.ts -> ComputerService.browserAct). */
export type BarAction =
  | { kind: "new"; address?: string }
  | { kind: "activate"; tabId: string }
  | { kind: "close"; tabId: string }
  | { kind: "navigate"; address: string }
  | { kind: "back" | "forward" | "reload" };

/** The AuditLog action of each (actor "user", target the page's domain, never what was typed). */
export const BAR_AUDIT: Record<BarAction["kind"], string> = {
  new: "browser_new_tab", activate: "browser_switch_tab", close: "browser_close_tab",
  navigate: "browser_navigate", back: "browser_back", forward: "browser_forward", reload: "browser_reload",
};

/**
 * What the user typed in the address field, as a desktop browser's bar reads it: an http(s)
 * address as it is, a bare host as https, words as a search with `searchUrl` (the user's
 * engine, engineFor). Any other scheme (file:, javascript:, chrome:, data:, mailto: ...) is
 * refused: the browser opens web pages only.
 */
export function resolveAddress(typed: string, searchUrl: string = SEARCH_URL): Resolved {
  const text = typed.trim();
  if (!text) throw new HttpError(400, "validation_failed", "address: type an address or something to search for", "address");
  // Recheck P2-5: half a surrogate pair would make encodeURIComponent throw (a 500); it isn't an address.
  if (!text.isWellFormed()) throw new HttpError(400, "validation_failed", "address: not a valid web address", "address");
  if (text.length > MAX_ADDRESS_LENGTH) throw new HttpError(400, "validation_failed", "address: too long", "address");
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw new HttpError(400, "validation_failed", "address: not a valid web address", "address");
    }
    if (!parsed.hostname) throw new HttpError(400, "validation_failed", "address: not a valid web address", "address");
    return fits({ url: parsed.toString(), search: false }, parsed);
  }
  // "note: buy milk" is words, not a scheme; "javascript:alert(1)" is a scheme and is refused.
  if (scheme && !HOST_PORT.test(text) && !/\s/.test(text))
    throw new HttpError(400, "validation_failed", "address: only web addresses (http or https) can be opened", "address");
  if (!/\s/.test(text) && BARE_HOST.test(text)) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(`https://${text}`);
    } catch {
      // Not a host after all (e.g. a bad port): searched for below.
    }
    if (parsed) return fits({ url: parsed.toString(), search: false }, parsed);
  }
  return fits({ url: `${searchUrl}${encodeURIComponent(text)}`, search: true });
}

/**
 * Recheck R2 and R3: an address with credentials in it (`https://bank.com@evil.com/` opens
 * evil.com) is refused, as custom connectors refuse it; and the resolved URL must fit the
 * computer's own cap (MAX_ADDRESS_LENGTH), so a long search says "too long", not "not a web
 * address" (about 220 CJK characters already make a 2000-character search URL).
 */
function fits(resolved: Resolved, parsed?: URL): Resolved {
  if (parsed && (parsed.username || parsed.password))
    throw new HttpError(400, "validation_failed", "address: addresses with a user name or password can't be opened", "address");
  if (resolved.url.length > MAX_ADDRESS_LENGTH)
    throw new HttpError(400, "validation_failed", resolved.search ? "address: too long to search for" : "address: too long", "address");
  return resolved;
}

const str = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * Recheck R1: page titles and URLs are the page's to choose and reach the app as they are, so
 * they're cleaned here, on the one path all three uses share (the bar routes, the actions'
 * answers, the stream). Hidden characters go: C0/C1 controls and DEL, zero-width space, the
 * direction marks and overrides (U+202E would make "gnp.exe" read "exe.png"), the isolates, the
 * word joiner and the BOM. ZWJ and ZWNJ stay (emoji sequences and several scripts need them).
 */
const SPACES = /[\t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
/**
 * Recheck P2-3: every control and default-ignorable character (soft hyphen, Hangul fillers, the tag
 * characters that can carry invisible ASCII, U+180E, U+206A-U+206F ...) plus the prepended format
 * marks, except what visible text needs: ZWNJ and ZWJ, the variation selectors and the Mongolian
 * free variation selectors. Tag characters survive only inside a flag (U+1F3F4, tags, U+E007F).
 */
const HIDDEN = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\ufff9-\ufffb]/gu;
const VISIBLE_NEEDS = /^[\u200c\u200d\u180b-\u180d\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]$/u;
const FLAG_TAGS = /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})/u;

function stripHidden(text: string): string {
  // split with a capturing group: odd parts are whole flag sequences, kept as they are.
  return text
    .split(FLAG_TAGS)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(HIDDEN, (ch) => (VISIBLE_NEEDS.test(ch) ? ch : ""))))
    .join("");
}

/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/.test(value[max - 1] ?? "") ? max - 1 : max;
  return value.slice(0, end);
}

/** A page title as the strip may show it: well-formed, one line, no hidden characters, at most 300 units. */
export function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = stripHidden(value.slice(0, 4 * TITLE_MAX).toWellFormed().replace(SPACES, " ")).replace(/ {2,}/g, " ").trim();
  return cut(text, TITLE_MAX).trimEnd();
}

/**
 * A tab's address as the bar may show it: an http(s) URL in its parsed form (ASCII, punycode,
 * percent-encoded), without user name or password; anything else (another scheme, junk, too
 * long) reads "" and the app shows a new tab.
 */
export function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > URL_MAX) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  // Recheck P2-4: a blob: page reads as the origin that made it, as desktop Chrome shows it.
  if (parsed.protocol === "blob:") return /^https?:\/\//.test(parsed.origin) ? `${parsed.origin}/` : "";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  parsed.username = "";
  parsed.password = "";
  const href = parsed.href;
  return href.length > URL_MAX ? "" : href;
}

const TITLE_MAX = 300;
const URL_MAX = 4096;
const TAB_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The computer's tab state as the app's bar: blank pages read "", a title that only repeats the
 * address reads "", at most MAX_BROWSER_TABS tabs with the active one always among them, and only
 * one active. Tolerant: entries without an id are dropped.
 */
export function barFromComputer(raw: unknown): BrowserBar {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  let activeSeen = false;
  const all = (Array.isArray(body.tabs) ? body.tabs : []).flatMap((entry) => {
    const tab = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    // Recheck R1/R2: an id the routes would refuse is dropped; the URL and title are cleaned.
    const id = str(tab.id, 201);
    if (!TAB_ID.test(id) || seen.has(id)) return [];
    seen.add(id);
    const rawUrl = str(tab.url, URL_MAX + 1);
    const url = BLANK(rawUrl) ? "" : cleanUrl(rawUrl);
    const rawTitle = cleanTitle(tab.title);
    // Recheck P2-4: no address shown (a blank tab, about:, data: ...) means no title either, so a page
    // can't put "PayPal - Log In" on what reads as a new tab; the app then shows its own "New tab".
    const title = !url || rawTitle === rawUrl || rawTitle === url || BLANK(rawTitle) ? "" : rawTitle;
    const active = tab.active === true && !activeSeen;
    if (active) activeSeen = true;
    return [{ id, url, title, active }];
  });
  let tabs = all.slice(0, MAX_BROWSER_TABS);
  const active = all.find((tab) => tab.active);
  if (active && !tabs.includes(active)) tabs = [...tabs.slice(0, MAX_BROWSER_TABS - 1), active];
  return {
    supported: true,
    browserBarInFrame: body.browserBarInFrame === true,
    tabs,
    canGoBack: body.canGoBack === true,
    canGoForward: body.canGoForward === true,
  };
}

/** The active tab's address, or null when there is none (no browser, or a blank tab). */
export function activeUrl(bar: BrowserBar): string | null {
  return bar.tabs.find((tab) => tab.active)?.url || null;
}
