// M20 seam between the tool providers and the approval service (contract step; W3 implements).
//
// Every "ask" call goes through ApprovalService.ask() instead of createToolApproval(), so one place
// decides, before any card is posted:
//  - an Always rule for this recipient (ApprovalRule, scope recipient) lets the call run: "allowed";
//  - the same call (fingerprint: slug + arguments without volatile keys) still waiting on a card:
//    no second card, "already_waiting";
//  - the same call declined and the user hasn't written since: "declined" (their decision, not a
//    limit; don't retry it or an equivalent unless they ask);
//  - otherwise a new card: "created".
// A consequential click in the assistant's browser goes through requestBrowserAction() the same way, with
// Always rules by site + category (never for the floor categories purchase and account).
//
// Callers: on "allowed" run the call now; otherwise reply to the model with askNote(outcome).
import type { Approval } from "../contract/approvals.ts";
import type { BrowserActionCategory } from "../contract/m20.ts";
import type { CardSink } from "./service.ts";
import type { Preview } from "./preview.ts";

/** ApprovalRule.toolSlug of browser click rules (scope site). */
export const BROWSER_ACTION_SLUG = "duet:browser_action";

export type AskOutcome =
  | { status: "allowed" }
  | { status: "created"; approval: Approval }
  | { status: "already_waiting"; approval: Approval }
  | { status: "declined"; approval: Approval };

export interface AskInput {
  userId: string;
  channelId: string;
  taskId: string | null;
  sink: CardSink;
  slug: string;
  args: Record<string, unknown>;
  kind: Approval["kind"];
  preview: Preview;
  /**
   * M20 W3 (optional, additive): the tool's toolkit and Composio tags, for the safety floor
   * (policy/floor.ts alwaysBlockedFor). Callers that leave them out are judged by the slug alone.
   */
  toolkit?: string | null;
  tags?: readonly string[];
  /**
   * M20 (optional): what the call acts on when its arguments don't say it (approvals/fingerprint.ts
   * fingerprintOf): OpenDuet's computer passes the site and the element of a ref. Only for "the same
   * call"; never stored as arguments or run.
   */
  identity?: Record<string, unknown> | null;
}

export interface BrowserActionInput {
  userId: string;
  channelId: string;
  taskId: string | null;
  sink: CardSink;
  /** the computer tool that would run on Approve (computer_click / computer_type / computer_key) */
  slug: string;
  /** its exact arguments, run as stored on Approve */
  args: Record<string, unknown>;
  /** registrable site, e.g. "amazon.com" */
  site: string;
  /** the button's accessible name from the server's latest snapshot */
  button: string;
  category: BrowserActionCategory;
  via: "click" | "submit" | "enter";
  /** true when the page itself looks like a checkout (the "why" then says so) */
  checkoutPage: boolean;
}

/** What the model is told when an ask didn't run the call (English, model-facing). */
export function askNote(outcome: Exclude<AskOutcome, { status: "allowed" }>): Record<string, unknown> {
  switch (outcome.status) {
    case "created":
      return { status: "awaiting_approval", approvalId: outcome.approval.id, note: "Shown to the user as an approval card; it runs only when they approve, and you'll see the result on your next turn. Don't ask again in text." };
    case "already_waiting":
      return { status: "already_waiting", approvalId: outcome.approval.id, note: "The same request is already waiting for the user's decision on its card. Nothing was run and no second card was posted." };
    case "declined":
      return { status: "declined_by_user", approvalId: outcome.approval.id, note: "The user declined this exact request. That is their decision, not a limit or an error: don't try it or an equivalent again unless they ask you to." };
  }
}
