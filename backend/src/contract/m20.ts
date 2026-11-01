// M20: safety. New shapes only; the fields they add to older shapes (sign-in card, approval card,
// tool policy rows, features) are declared next to those shapes and point back here.
//
// Additive only, so an app built before M20 keeps decoding every message: the older enums
// (SignInMessage.state, SignInCardResponse.state, Approval.kind, ApprovalPreview.kind) keep their
// values, and everything new is an extra field with a default. A browser approval is an ordinary
// "action" card with `browser` set; a sign-in card that asks for a code stays "pending" with
// step "code"; one the user took over or dismissed reads "expired" to an older app, with `outcome`
// saying which.
import { z } from "zod";

// ---------------------------------------------------------------- sign-in card (L141)

/** Which form the pending card shows: email + password, then (only if the site asks) a code. */
export const SignInStep = z.enum(["credentials", "code"]);

/**
 * How a card that is no longer pending ended, beyond sent / failed / expired:
 * taken_over = the user chose "Take control instead" (the full-screen computer opened for them),
 * dismissed = "Not now". Both are sent with state "expired" so older apps show a closed card.
 */
export const SignInOutcome = z.enum(["taken_over", "dismissed"]);

/**
 * POST /api/computer/sign-in/:requestId/code: the verification code the site asked for after the
 * password. Handled like the password: read once, typed by the computer, never logged or stored.
 */
export const SignInCodeRequest = z.object({ code: z.string().trim().min(1).max(64) }).strict();

// ---------------------------------------------------------------- browser approvals (#4)

/**
 * What a consequential click in OpenDuet's browser would do, from the real button name in the
 * server's latest snapshot (English and Chinese word lists) or a checkout page's URL.
 * purchase: buy, pay, place order, subscribe, checkout pages. account: passwords, security
 * settings, deleting or closing the account. send: send, post, publish, reply, share.
 * delete: delete, remove. submit: submit, confirm, book, register, apply.
 */
export const BrowserActionCategory = z.enum(["purchase", "account", "send", "delete", "submit"]);
export type BrowserActionCategory = z.infer<typeof BrowserActionCategory>;

/** Categories that always ask: "Always" is never offered or stored for them. */
export const FLOOR_BROWSER_CATEGORIES: readonly BrowserActionCategory[] = ["purchase", "account"];

/** On an "action" approval card (ActionPreview.browser): the click OpenDuet wants to make. */
export const BrowserAction = z.object({
  /** registrable site, e.g. "amazon.com" */
  site: z.string().min(1),
  /** the button's accessible name exactly as the page shows it, e.g. "Place your order" */
  button: z.string(),
  category: BrowserActionCategory,
  /** how the click happens: a click, a form submit by typing, or Enter */
  via: z.enum(["click", "submit", "enter"]),
});
export type BrowserAction = z.infer<typeof BrowserAction>;

// ---------------------------------------------------------------- approval safety floor (#4, A P2-3, A P2-4)

/**
 * What "Always" on this card would cover (Approval.always). Null: the card offers no Always row
 * (floor tools and categories, and every card whose tool isn't scoped per recipient or site;
 * those tools keep their Ask / Always picker in the connector sheet).
 * recipient: this tool, only for these recipients (value: the addresses, lowercased, sorted,
 * joined with ", "). site: browser clicks of this category on this site.
 */
export const ApprovalAlways = z.object({
  scope: z.enum(["recipient", "site"]),
  value: z.string().min(1),
  /** site scope only */
  category: BrowserActionCategory.nullable(),
});
export type ApprovalAlways = z.infer<typeof ApprovalAlways>;

/**
 * Why a tool's Ask / Always picker can't be set to Always (ConnectorTool.alwaysBlocked).
 * floor: payments, passwords / credentials and security settings always ask.
 * per_recipient: it sends to other people; Always is chosen on its approval card, for that
 * recipient only.
 */
export const AlwaysBlocked = z.enum(["floor", "per_recipient"]);
export type AlwaysBlocked = z.infer<typeof AlwaysBlocked>;

// ---------------------------------------------------------------- computer as an optional deploy (§3)

/** Features.computerMode: off = not deployed on this server; otherwise the browser's mode. */
export const ComputerMode = z.enum(["off", "headless", "headed"]);
export type ComputerMode = z.infer<typeof ComputerMode>;
