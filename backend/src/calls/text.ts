// M13: small text helpers for what the voice reads or says (model-facing English; the voice speaks
// it in the user's language). Nothing here is shown in the app.
import type { Approval } from "../contract/approvals.ts";
import type { StatusKey } from "../contract/common.ts";
import { stripMarkdown } from "../runs/quote.ts";

/** At most `max` characters (code points), with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Plain, one-paragraph text: markdown stripped, whitespace folded. */
export function spoken(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, " ").trim();
}

/**
 * Shortened for speech: at most `max` characters, cut after the last sentence end that fits
 * (. ! ? 。 ！ ？ …), else at the last space, else hard.
 */
export function shortenForSpeech(text: string, max: number): string {
  const plain = spoken(text);
  const chars = [...plain];
  if (chars.length <= max) return plain;
  const head = chars.slice(0, max).join("");
  let cut = -1;
  for (const match of head.matchAll(/[.!?。！？…](?=\s|$|["'”’)\]])|[。！？]/g)) cut = match.index + match[0].length;
  if (cut >= Math.floor(max / 3)) return head.slice(0, cut).trim();
  const space = head.lastIndexOf(" ");
  return `${(space > max / 3 ? head.slice(0, space) : chars.slice(0, max - 1).join("")).trim()}…`;
}

/** What the assistant is doing, in a few words (StatusKey -> the English the app shows). */
const STATUS_TEXT: Record<StatusKey, string> = {
  thinking: "thinking it through",
  checking_memory: "checking memory",
  searching_email: "searching your email",
  checking_files: "checking recent files",
  checking_calendar: "checking your calendar",
  searching_web: "searching the web",
  looking_up: "looking something up",
  writing_draft: "writing a draft",
  starting_task: "starting a task",
  working_tasks: "working on your tasks",
  working: "working on it",
  checking: "checking",
  reading_now: "reading",
  working_browser: "working in your browser",
  waking_workspace: "waking its workspace",
};

export const statusText = (status: StatusKey | null | undefined): string | null => (status ? STATUS_TEXT[status] ?? null : null);

/** The card's title for "<title> needs your approval on the card in the chat". */
export function approvalTitle(approval: Pick<Approval, "preview">): string | null {
  const p = approval.preview;
  switch (p.kind) {
    case "email": return p.subject.trim() || (p.to.length ? `An email to ${p.to.join(", ")}` : null);
    case "payment": return p.merchant.trim() ? `A payment to ${p.merchant.trim()}` : null;
    case "sign":
    case "delete": return p.title.trim() || null;
    case "action": return p.toolName.trim() || null;
  }
}

export const approvalNotice = (title: string | null): string =>
  title ? `${title} needs your approval on the card in the chat.` : "Something needs your approval on the card in the chat.";
