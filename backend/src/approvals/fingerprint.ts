// M20 (#32 dedup, A P1-2): what makes two "ask" calls "the same call", so one still waiting on its
// card, or declined a moment ago, posts no second card (ApprovalService.ask / requestBrowserAction).
// A sha256 over the tool slug and its arguments in a stable key order (agent/harness.ts stable()),
// without the keys that change between two tries of the same action (the idea follows
// CopilotKit/OpenDuet's server/src/approvals/service.ts equivalenceOf, MIT).
import { createHash } from "node:crypto";
import { stable } from "../agent/harness.ts";

/**
 * Dropped from every call's arguments (at any depth): ids of the attempt, not of the action.
 * snapshotId: the page read the click was planned on; toolCallId / tool_call_id: the model's call
 * id; signal: an abort signal that leaked into arguments.
 */
export const VOLATILE_KEYS: readonly string[] = ["snapshotId", "snapshot_id", "toolCallId", "tool_call_id", "signal"];

/**
 * Also dropped for OpenDuet's computer tools (computer_*): `ref`, the element ref of the latest
 * snapshot (e12), renumbered on every snapshot. Not for connectors: there `ref` is real data
 * (a GitHub branch or tag), and two different branches are two different calls.
 */
export const COMPUTER_VOLATILE_KEYS: readonly string[] = ["ref"];

const isComputerTool = (slug: string) => /^computer_/.test(slug);

function strip(value: unknown, drop: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => strip(entry, drop, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !drop.has(key)).map(([key, entry]) => [key, strip(entry, drop, depth + 1)]));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The arguments as they count for "the same call" (volatile keys removed). */
export function stableArgs(slug: string, args: Record<string, unknown>): unknown {
  const drop = new Set([...VOLATILE_KEYS, ...(isComputerTool(slug) ? COMPUTER_VOLATILE_KEYS : [])]);
  return strip(args, drop);
}

/**
 * Approval.fingerprint of a tool call. `identity` (optional) is what the call acts on when its
 * arguments can't say it: a computer click / type has only a ref (dropped above), so the caller
 * adds the page's site and the element's role and name, and "Not now" on one button doesn't
 * refuse every other click.
 */
export function fingerprintOf(slug: string, args: Record<string, unknown>, identity?: Record<string, unknown> | null): string {
  return sha256(stable(identity ? ["tool", slug, stableArgs(slug, args), identity] : ["tool", slug, stableArgs(slug, args)]));
}

/**
 * Approval.fingerprint of a consequential browser click: the site, the kind of click, the button's
 * name and how it happens (refs change between snapshots), plus what the call carries besides its
 * ref (the text typed before a submit, the key), so a different comment posted with the same
 * button isn't "the same call" as a declined one.
 */
export function browserFingerprintOf(input: { site: string; category: string; button: string; via: string; slug: string; args: Record<string, unknown> }): string {
  const button = input.button.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return sha256(stable(["browser", input.site.trim().toLowerCase(), input.category, button, input.via, input.slug, stableArgs(input.slug, input.args)]));
}
