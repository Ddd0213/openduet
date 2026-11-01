// M27 browser (contract C, C2): the full-screen "OpenDuet's computer" view draws its own browser bar,
// a row of tabs (title, close, a + at the end) and under it back / forward / reload and an address
// field, above the live page. The page is landscape, 1280 x 800 CSS px at scale 1 (C2: the
// default again, so OpenDuet's screenshots are wide); COMPUTER_BROWSER_SCREEN=portrait is an option
// (430 x 660 at scale 2, frames 860 x 1320, `frame_meta` 430 x 660).
//
// Additive, so an app from before M27 keeps working: the stream's new "browser_bar" message is
// dropped by its decoder (ComputerStream decodes text frames with try?), and the routes are new. An older
// computer (patches 0001-0005) answers the tab routes 404: GET /api/computer/tabs then says
// supported: false and the app's bar shows only the page's address (ComputerState.url).
//
// Semantics, decisions and why: docs/API.md "## M27 browser".
import { z } from "zod";

/** Tabs listed at most; the active one is always among them. */
export const MAX_BROWSER_TABS = 50;
/** What the address field may send (as the computer's own limit). */
export const MAX_ADDRESS_LENGTH = 2000;

/**
 * One tab. `id` is the browser's own (a DevTools target id) and stays the same for the life of the
 * tab. `url` is what the address field shows: "" for a blank new tab, and on Chromium's error page
 * the address that failed. `title` is "" when the page has none (the app shows the domain, or "New
 * tab"). No site icon in M27 (the owner's decision): the strip shows titles only; see docs/API.md.
 */
export const BrowserTab = z.object({
  id: z.string().min(1).max(200),
  url: z.string().max(4096),
  title: z.string().max(300),
  active: z.boolean(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

/**
 * What the bar shows. GET /api/computer/tabs, the answer of every tab and navigate action, and the
 * stream's { type: "browser_bar", bar } message (sent when it changes; the first once the screen
 * is up). `supported` false = the computer predates M27 (no tab strip; the bar shows the
 * address only, read-only). `browserBarInFrame` true = the frames are Chrome's whole window
 * (COMPUTER_BROWSER_MODE=headed), whose own tab strip and address bar are in the picture: the app
 * then draws no bar of its own. `tabs` is in the browser's order; empty while no browser runs.
 * `canGoBack` / `canGoForward` are the active tab's history.
 */
export const BrowserBar = z.object({
  supported: z.boolean(),
  browserBarInFrame: z.boolean().default(false),
  tabs: z.array(BrowserTab).max(MAX_BROWSER_TABS),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});
export type BrowserBar = z.infer<typeof BrowserBar>;

/**
 * POST /api/computer/tabs: a new tab, in front, which OpenDuet follows from then on. `address` is
 * what the user typed (resolved as in NavigateRequest); without one the new tab opens the start
 * page (COMPUTER_START_URL, else by the user's region: Bing for mainland China or unknown, Google
 * elsewhere) and the app focuses the address field.
 */
export const NewTabRequest = z
  .object({ address: z.string().trim().min(1).max(MAX_ADDRESS_LENGTH).optional() })
  .strict();
export type NewTabRequest = z.infer<typeof NewTabRequest>;

/**
 * POST /api/computer/navigate on the active tab: what the user typed in the address field, or a
 * button. An address is resolved on the server: http(s) as it is, a bare host ("example.com",
 * "localhost:3000") as https, words or anything else without a scheme as a search (Bing for a user
 * in mainland China or of unknown region, Google elsewhere); any other scheme (file:, javascript:,
 * chrome:, data: ...) is refused with 400 validation_failed.
 */
export const NavigateRequest = z.union([
  z.object({ address: z.string().trim().min(1).max(MAX_ADDRESS_LENGTH) }).strict(),
  z.object({ action: z.enum(["back", "forward", "reload"]) }).strict(),
]);
export type NavigateRequest = z.infer<typeof NavigateRequest>;
