// M20 (A P2-3): who a call that sends to other people goes to, so "Always" on its card covers only
// those recipients (ApprovalRule scope recipient, one row per address). The keys are our email
// card's To / Extra to / Cc / Bcc (preview.ts) plus the RECIPIENT_KEYS of CopilotKit/OpenDuet's
// server/src/plugins/share-target.ts (MIT; see THIRD_PARTY_NOTICES.md).
//
// Never remove a key. Each address is matched on its own, so a call runs without a card only when
// every recipient found here has a rule; a recipient under a key that isn't listed isn't seen, and
// that is the one way this can widen (the reference project had that bug with `recipient_email`).
// Left out on purpose: placement keys (thread_ts, team_id) say where a message goes, not who reads
// it; as a rule of their own they would let any recipient in that thread or workspace through.
import { stable } from "../agent/harness.ts";
import { BCC, CC, EXTRA_TO, TO } from "./preview.ts";

export const RECIPIENT_KEYS: readonly string[] = [...new Set([
  ...TO, ...EXTRA_TO, ...CC, ...BCC,
  // share-target.ts RECIPIENT_KEYS, in its order, without thread_ts / team_id
  "channel", "channel_id", "channelId", "conversation_id", "chat_id", "chatId", "to", "cc", "bcc", "recipient", "recipients",
  "email", "user", "users", "recipient_email", "recipient_emails", "extra_recipients", "to_email", "to_emails", "to_address",
  "to_addresses", "email_to", "send_to",
  // M20: more people a send or share can reach (texts, invites, shares). Not `user_id`: Gmail's is "me".
  "phone_number", "phone_numbers", "attendees", "participants", "email_address", "emails", "user_ids",
])];

/** A comma or semicolon outside double quotes: `"Rivera, Sam" <sam@example.com>, lee@example.com`. */
const SEPARATOR = /[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/;
const EMAIL = /[^\s<>"',;]+@[^\s<>"',;]+/;

/** Every string at the leaves of an object (an Outlook `{ emailAddress: { address } }` and the like). */
function leaves(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((v) => leaves(v, depth + 1));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((v) => leaves(v, depth + 1));
  return [];
}

/**
 * `"Sam" <Sam@Example.com>` -> ["sam@example.com"]; "#Launch" -> ["#launch"]. A part that holds
 * more than one address (`"sam@example.com" <lee@example.com>`, or two separated by a space)
 * gives every one of them, so each needs its own rule: the display name can't hide who it goes to.
 */
function normalize(part: string): string[] {
  const trimmed = part.trim();
  const addresses = trimmed.match(new RegExp(EMAIL.source, "g"));
  if (addresses?.length) return [...new Set(addresses.map((a) => a.trim().toLowerCase()))];
  const plain = trimmed.replace(/^["']+|["']+$/g, "").trim().toLowerCase();
  return plain ? [plain] : [];
}

/** The addressees one argument names: array entries, comma-separated parts, objects by their address. */
function addressees(value: unknown): string[] {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return [];
  if (Array.isArray(value)) return value.flatMap(addressees);
  if (typeof value === "string") return value.split(SEPARATOR).flatMap(normalize);
  if (typeof value === "number") return [String(value)];
  if (typeof value === "object") {
    const strings = leaves(value);
    const emails = strings.flatMap((s) => (EMAIL.test(s) ? normalize(s) : []));
    // An object without an address (a Slack `{ id }`) counts as one recipient: its JSON, lowercased.
    return emails.length ? emails : [stable(value).toLowerCase()];
  }
  return [];
}

/** The recipients of a call: lowercased, trimmed, deduplicated and sorted. */
export function recipientsOf(args: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const key of RECIPIENT_KEYS) {
    if (!Object.hasOwn(args, key)) continue;
    for (const address of addressees(args[key])) found.add(address);
  }
  return [...found].sort();
}

/** Approval.always for a per-recipient tool: null when the call names nobody (no Always row). */
export function recipientAlways(recipients: readonly string[]): { scope: "recipient"; value: string; category: null } | null {
  return recipients.length ? { scope: "recipient", value: recipients.join(", "), category: null } : null;
}
