// M20 safety floor: which tools can never be set to Always, and why.
//  - "floor": payments, passwords / credentials and security settings (write tools only; reads stay
//    as they are; the computer's own files and shell aren't account actions);
//  - "per_recipient": tools that send to other people (send / post / reply / forward / share /
//    comment, drafts excluded): Always is chosen on the approval card for one recipient
//    (ApprovalRule), never for the whole tool.
// PolicyService treats a stored "always" on such a tool (or its toolkit's "All tools") as "ask";
// PUT .../policy with mode "always" for one is a 400 always_not_allowed; the tool rows of every
// Ask / Always sheet carry alwaysAllowed / alwaysBlocked from here.
//
// Pure word lists over the slug's tokens, like classify.ts. Deliberately broad (the idea and the
// three categories follow CopilotKit/OpenDuet's server/src/approvals/policy.ts SAFETY_REQUIREMENTS
// and server/src/plugins/share-target.ts, MIT; see THIRD_PARTY_NOTICES.md): a tool wrongly on the
// floor costs the user a tap, one wrongly off it can cost them money or their account.
import { COMPUTER_TOOLKIT } from "../computer/tools.ts";
import type { AlwaysBlocked } from "../contract/m20.ts";
import { HttpError } from "../http.ts";
import { classify, type ToolFacts } from "./classify.ts";

/** "sendMessage" / "SEND_MESSAGE" / "abc123:send_message" -> ["SEND", "MESSAGE", ...]. */
const tokens = (slug: string) => slug.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
const set = (...words: string[]) => new Set(words);
const any = (words: readonly string[], list: ReadonlySet<string>) => words.some((w) => list.has(w));
/** Both a word of `a` and a word of `b` (e.g. API + KEY, SECURITY + SETTINGS). */
const pair = (words: readonly string[], a: ReadonlySet<string>, b: ReadonlySet<string>) => any(words, a) && any(words, b);

// ---- payments and money movement
const PAYMENT = set("PAY", "PAYS", "PAYMENT", "PAYMENTS", "PAYOUT", "PAYOUTS", "CHARGE", "CHARGES", "REFUND", "REFUNDS",
  "TRANSFER", "TRANSFERS", "PURCHASE", "PURCHASES", "BUY", "CHECKOUT", "WITHDRAW", "WITHDRAWAL", "DEPOSIT", "REMIT", "WIRE");
const INVOICE = set("INVOICE", "INVOICES");
const INVOICE_GO = set("SEND", "FINALIZE", "PAY", "ISSUE", "CHARGE");
const SUBSCRIPTION = set("SUBSCRIPTION", "SUBSCRIPTIONS");
const SUBSCRIPTION_CHANGE = set("CREATE", "UPDATE", "UPGRADE", "DOWNGRADE", "RENEW", "RESUME", "ADD", "CHANGE");
const ORDER = set("ORDER", "ORDERS");
const ORDER_PLACE = set("PLACE", "SUBMIT");
/** Every write of these toolkits moves money or changes billing. */
const MONEY_TOOLKITS = set("stripe", "paypal", "square", "wise", "braintree", "adyen", "razorpay", "mollie", "paddle",
  "gocardless", "plaid", "coinbase", "revolut", "venmo", "klarna", "chargebee", "recurly", "lemonsqueezy", "lemon_squeezy",
  "mercury", "brex", "ramp", "payoneer", "checkout");

// ---- passwords, credentials, keys, tokens
const CREDENTIAL = set("PASSWORD", "PASSWORDS", "PASSWD", "PASSCODE", "PASSPHRASE", "PASSKEY", "PASSKEYS", "CREDENTIAL",
  "CREDENTIALS", "SECRET", "SECRETS", "TOKEN", "TOKENS", "APIKEY", "APIKEYS", "2FA", "MFA", "TOTP", "OTP", "TWOFACTOR");
/** KEY only with what kind of key it is: a record's "key" isn't a credential. */
const KEY = set("KEY", "KEYS");
const KEY_KIND = set("API", "SSH", "GPG", "PGP", "DEPLOY", "ACCESS", "PRIVATE", "SECRET", "SIGNING", "ENCRYPTION", "RECOVERY", "SECURITY");
const RECOVERY = set("RECOVERY", "BACKUP");
const RECOVERY_WHAT = set("CODE", "CODES", "EMAIL", "PHONE", "KEY", "KEYS");
const FACTOR = set("FACTOR");
const FACTOR_KIND = set("TWO", "MULTI", "SECOND");

// ---- security settings: permissions, roles, sharing, admin, auth / SSO, member access
const SECURITY = set("PERMISSION", "PERMISSIONS", "ROLE", "ROLES", "ADMIN", "ADMINS", "ADMINISTRATOR", "SECURITY",
  "SHARING", "AUTH", "SSO", "SAML", "OAUTH", "OIDC", "SCIM", "AUTHORIZATION", "AUTHENTICATION", "COLLABORATOR",
  "COLLABORATORS", "OWNERSHIP", "VISIBILITY", "PROTECTION", "DELEGATE", "DELEGATES", "DELEGATION", "FORWARDING", "ACL", "ACLS");
/** Who can get in: a member / user / guest gaining or losing access. */
const MEMBER = set("MEMBER", "MEMBERS", "MEMBERSHIP", "MEMBERSHIPS", "USER", "USERS", "GUEST", "GUESTS", "SEAT", "SEATS");
const MEMBER_CHANGE = set("ADD", "REMOVE", "INVITE", "GRANT", "REVOKE", "KICK", "BAN", "UNBAN", "PROMOTE", "DEMOTE",
  "SUSPEND", "UNSUSPEND", "DEACTIVATE", "REACTIVATE", "ACTIVATE", "PROVISION", "DEPROVISION");
const ACCESS = set("ACCESS");
const ACCESS_CHANGE = set("GRANT", "REVOKE", "ADD", "REMOVE", "UPDATE", "SET", "CHANGE", "LEVEL", "REQUEST");
const SETTINGS = set("SETTING", "SETTINGS", "POLICY", "POLICIES");
const SETTINGS_KIND = set("PRIVACY", "ACCESS", "LOGIN", "SIGNIN");
/** Every write of these toolkits is identity, password or secret management. */
const SECURITY_TOOLKITS = set("okta", "auth0", "onelogin", "jumpcloud", "1password", "onepassword", "bitwarden", "lastpass",
  "dashlane", "keeper", "doppler", "hashicorp_vault", "infisical");

/** Payments, credentials or security settings (the caller has already ruled out reads). */
function onFloor(words: readonly string[], toolkit: string): boolean {
  if (MONEY_TOOLKITS.has(toolkit) || SECURITY_TOOLKITS.has(toolkit)) return true;
  if (any(words, PAYMENT) || pair(words, INVOICE, INVOICE_GO) || pair(words, SUBSCRIPTION, SUBSCRIPTION_CHANGE) || pair(words, ORDER, ORDER_PLACE)) return true;
  if (any(words, CREDENTIAL) || pair(words, KEY, KEY_KIND) || pair(words, RECOVERY, RECOVERY_WHAT) || pair(words, FACTOR, FACTOR_KIND)) return true;
  return any(words, SECURITY) || pair(words, MEMBER, MEMBER_CHANGE) || pair(words, ACCESS, ACCESS_CHANGE) || pair(words, SETTINGS, SETTINGS_KIND);
}

// ---- sends to other people
/** Verbs that deliver something to someone, whatever else the name says. */
const SEND = set("SEND", "SENDS", "REPLY", "RESPOND", "FORWARD", "SHARE", "SHARES", "INVITE", "INVITES", "NOTIFY", "TWEET", "RETWEET");
/** What other people read: writing one of these (create, post, schedule, edit) reaches them. */
const CONTENT = set("POST", "POSTS", "MESSAGE", "MESSAGES", "COMMENT", "COMMENTS", "REPLIES", "DM", "DMS", "TWEETS");
/** Writes that only tidy the user's own view of messages: nobody else sees them. */
const KEEP = set("DELETE", "DELETES", "REMOVE", "TRASH", "UNTRASH", "DESTROY", "PURGE", "ERASE", "ARCHIVE", "UNARCHIVE",
  "MOVE", "MODIFY", "MARK", "LABEL", "LABELS", "TAG", "UNTAG", "STAR", "UNSTAR", "PIN", "UNPIN", "MUTE", "UNMUTE",
  "SNOOZE", "SAVE", "UNSAVE", "HIDE", "UNHIDE", "IMPORT", "EXPORT", "DOWNLOAD", "REACT", "REACTION", "REACTIONS",
  "LIKE", "UNLIKE", "BOOKMARK", "FLAG", "UNFLAG", "BLOCK", "UNBLOCK", "REPORT");
/** A draft sends nothing (yet); sending it does. */
const DRAFT = set("DRAFT", "DRAFTS");
const DRAFT_SEND = set("SEND", "SENDS");
/** Social toolkits: any write that isn't tidying publishes to other people (likes and saves excluded). */
const SOCIAL_TOOLKITS = set("twitter", "linkedin", "reddit", "facebook", "instagram", "threads", "mastodon", "bluesky",
  "youtube", "tiktok", "pinterest", "tumblr");
/** Chat toolkits: uploading or scheduling there posts into a conversation. */
const CHAT_TOOLKITS = set("slack", "slackbot", "discord", "discordbot", "telegram", "whatsapp", "microsoft_teams", "teams",
  "googlechat", "google_chat", "mattermost", "rocketchat", "zulip", "intercom", "twilio");
const CHAT_POSTS = set("UPLOAD", "SCHEDULE", "SCHEDULES", "BROADCAST");

function sendsToOthers(words: readonly string[], toolkit: string): boolean {
  if (any(words, DRAFT)) return any(words, DRAFT_SEND);
  if (any(words, SEND)) return true;
  if (any(words, KEEP)) return false;
  if (any(words, CONTENT) || SOCIAL_TOOLKITS.has(toolkit)) return true;
  return CHAT_TOOLKITS.has(toolkit) && any(words, CHAT_POSTS);
}

/**
 * Built-in tools that aren't account actions: OpenDuet's computer (its own files, shell and browser;
 * consequential clicks have their own check) and the duet: cards (payments, skill scripts, browser
 * actions), which never get an Ask / Always picker.
 */
const notAccountAction = (tool: ToolFacts) => tool.toolkit?.toLowerCase() === COMPUTER_TOOLKIT || /^computer_/.test(tool.slug) || tool.slug.startsWith("duet:");

/** Why Always is refused for this tool; null = Always is allowed. Reads are never blocked. */
export function alwaysBlockedFor(tool: ToolFacts): AlwaysBlocked | null {
  if (notAccountAction(tool) || classify(tool) === "read") return null;
  const words = tokens(tool.slug);
  const toolkit = (tool.toolkit ?? "").toLowerCase();
  if (onFloor(words, toolkit)) return "floor";
  if (sendsToOthers(words, toolkit)) return "per_recipient";
  return null;
}

/** The ConnectorTool fields for a tool row. */
export function alwaysFields(tool: ToolFacts): { alwaysAllowed: boolean; alwaysBlocked: AlwaysBlocked | null } {
  const blocked = alwaysBlockedFor(tool);
  return { alwaysAllowed: blocked === null, alwaysBlocked: blocked };
}

/** The 400 of a PUT .../policy that sets Always on a tool where alwaysBlockedFor isn't null. */
export function alwaysNotAllowed(blocked: AlwaysBlocked): HttpError {
  const message = blocked === "floor"
    ? "Payments, passwords and security settings always ask."
    : "This tool sends to other people: choose Always on its approval card, for that recipient.";
  return new HttpError(400, "always_not_allowed", message, "mode");
}
