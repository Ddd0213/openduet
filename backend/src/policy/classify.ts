// Read / write classification of a connector tool and the approval card kind it gets (L106).
// "always" only for clear reads; anything that sends, posts, creates, updates, moves, archives,
// pays, signs or deletes, and anything we can't classify, is "ask". Writes win over reads: a slug
// with both kinds of words (GET_OR_CREATE, MARK_AS_READ) is a write.
import type { z } from "zod";
import type { ApprovalKind } from "../contract/approvals.ts";
import type { PolicyMode } from "../contract/connectors.ts";

export type Access = "read" | "write" | "unknown";
type Kind = z.infer<typeof ApprovalKind>;

/** defaultMode: a built-in tool's own default (M6: OpenDuet's computer), used instead of classify() when nothing is stored. */
export interface ToolFacts { slug: string; toolkit: string | null; tags?: readonly string[]; defaultMode?: z.infer<typeof PolicyMode> }

// Verbs only: words that are also common nouns in read slugs (EMAIL, MESSAGE, ISSUE, COMMENT, RUN,
// TAG ...) are left out, so GMAIL_GET_EMAIL stays a read. A tool that only has such words and no
// read verb ends up "unknown", which asks anyway.
const WRITE = new Set([
  "SEND", "POST", "CREATE", "UPDATE", "EDIT", "MODIFY", "PATCH", "PUT", "SET", "ADD", "INSERT", "APPEND", "UPSERT", "REPLACE",
  "MOVE", "COPY", "RENAME", "ARCHIVE", "UNARCHIVE", "DELETE", "REMOVE", "TRASH", "UNTRASH", "DESTROY", "PURGE", "ERASE", "CLEAR",
  "PAY", "CHARGE", "REFUND", "TRANSFER", "PURCHASE", "BUY", "CHECKOUT", "SIGN", "APPROVE", "REJECT", "SUBMIT", "PUBLISH",
  "UNPUBLISH", "SHARE", "INVITE", "REPLY", "FORWARD", "SCHEDULE", "RESCHEDULE", "CANCEL", "BOOK", "RSVP", "ACCEPT", "DECLINE",
  "REACT", "LIKE", "UNLIKE", "STAR", "UNSTAR", "PIN", "UNPIN", "FOLLOW", "UNFOLLOW", "SUBSCRIBE", "UNSUBSCRIBE",
  "MUTE", "UNMUTE", "MARK", "ASSIGN", "UNASSIGN", "CLOSE", "REOPEN", "UNLOCK", "RESTORE", "IMPORT", "UPLOAD",
  "DEPLOY", "EXECUTE", "ENABLE", "DISABLE", "GRANT", "REVOKE", "KICK", "BAN", "UNBAN", "UNTAG", "RESOLVE", "NOTIFY",
  "RETWEET", "UNBLOCK", "DISMISS", "SNOOZE", "INSTALL", "UNINSTALL", "RESET",
]);
const READ = new Set([
  "GET", "LIST", "SEARCH", "FETCH", "READ", "FIND", "QUERY", "LOOKUP", "VIEW", "DESCRIBE", "RETRIEVE", "COUNT", "DOWNLOAD",
  "BROWSE", "PREVIEW", "INSPECT",
]);
const DELETE = new Set(["DELETE", "REMOVE", "TRASH", "DESTROY", "PURGE", "ERASE"]);
const SIGN = new Set(["SIGN", "SIGNATURE", "COUNTERSIGN", "ESIGN"]);
const MAIL_SEND = new Set(["SEND", "REPLY", "FORWARD"]);
const MAIL_TOOLKITS = new Set(["gmail", "outlook"]);
const SIGN_TOOLKITS = new Set(["docusign", "dropbox_sign", "pandadoc", "adobe_sign"]);

const tokens = (slug: string) => slug.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/** read = runs without asking by default; write and unknown = "ask". */
export function classify(tool: ToolFacts): Access {
  const tags = new Set(tool.tags ?? []);
  if (tags.has("destructiveHint") || tags.has("createHint") || tags.has("updateHint")) return "write";
  const words = tokens(tool.slug);
  if (words.some((w) => WRITE.has(w))) return "write";
  if (tags.has("readOnlyHint")) return "read";
  if (words.some((w) => READ.has(w))) return "read";
  return "unknown";
}

export const defaultMode = (access: Access): z.infer<typeof PolicyMode> => (access === "read" ? "always" : "ask");

/** The card kind an "ask" call gets: delete, sign, email (sending mail) or the generic action card. */
export function approvalKind(tool: ToolFacts): Exclude<Kind, "payment"> {
  const words = tokens(tool.slug);
  const toolkit = (tool.toolkit ?? "").toLowerCase();
  if (words.some((w) => DELETE.has(w))) return "delete";
  if (words.some((w) => SIGN.has(w)) || (SIGN_TOOLKITS.has(toolkit) && words.includes("SEND"))) return "sign";
  if (MAIL_TOOLKITS.has(toolkit) && words.some((w) => MAIL_SEND.has(w)) && !words.includes("DRAFT")) return "email";
  return "action";
}
