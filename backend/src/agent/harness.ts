// M14a: the turn loop's notes and small pure helpers (how a turn ends, the context budget inside a
// turn, the post-turn claim check). Model-facing English; nothing here is shown to the user.
import type { ContentBlock, Message, ToolResultBlock } from "../llm/index.ts";

/** A turn that needs no words passes; short stage directions also pass after a stored reaction. */
export const PASS = "(pass)";
const FULL_WIDTH_PASS = "（pass）";
const PARENTHETICAL_MAX = 24;
const CLOSING_PUNCTUATION = /[\s.!?。！？…，,;；:：]+$/u;

export function isPass(text: string, reacted = false): boolean {
  const lead = text.trim();
  if (lead === PASS || lead === FULL_WIDTH_PASS) return true;
  if (!reacted) return false;
  const whole = lead.replace(CLOSING_PUNCTUATION, "");
  if (!/^(?:\([^()（）]*\)|（[^()（）]*）)$/u.test(whole)) return false;
  const inside = whole.slice(1, -1);
  return inside.trim().length > 0 && [...inside].length <= PARENTHETICAL_MAX;
}

/** Hold a new streaming bubble while it can still become a pass, not just after it is complete. */
export function couldBePass(text: string, reacted = false): boolean {
  const lead = text.trim();
  if (!lead) return false;
  if (PASS.startsWith(lead) || FULL_WIDTH_PASS.startsWith(lead)) return true;
  if (!reacted) return false;
  if (isPass(lead, true)) return true;
  return /^[（(][^()（）]*$/u.test(lead) && [...lead.slice(1)].length <= PARENTHETICAL_MAX;
}

export const EMPTY_REPLY_NOTE = "[Your reply was empty. Answer the user, or reply exactly (pass) if no reply is needed.]";
export const WRAP_UP_NOTE = "You have reached the maximum number of steps for this turn. Do not call any more tools. Summarize for the user what you accomplished, what is still pending, and what they should do next.";
/** codync-harness #17: a provider tool that threw may or may not have done its write. */
export const TOOL_THREW = "The tool failed on the server; it may or may not have taken effect. Check before trying it again.";
export const CLAIM_NOTE = "[Your reply says something was made, done or set up, but no tool in this turn did it. Do it now with the right tool, or correct your reply.]";
export const repeatNote = (name: string): string => `[You've called ${name} with the same input 3 times; the answer won't change. Use what you have or try something else.]`;
/** Identical calls in one turn before the repeat note is added to the result. */
export const REPEAT_LIMIT = 3;

/** Key order doesn't make two inputs different. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Adds a note to the trailing user message (after tool results), or as a new user message. */
export function pushNote(messages: Message[], note: string): void {
  const last = messages.at(-1);
  if (last?.role === "user") messages[messages.length - 1] = { ...last, content: [...last.content, { type: "text", text: note }] };
  else messages.push({ role: "user", content: [{ type: "text", text: note }] });
}

// ---- B4: context budget inside a turn (nanomuse-harness-2 N2) ----
export const RESULT_MAX = 20_000;
export const RESULT_HEAD = 14_000;
export const RESULT_TAIL = 4_000;
export const KEEP_IMAGE_MESSAGES = 4;
export const IMAGE_OMITTED = "[image omitted to save context]";

/** A tool_result text over RESULT_MAX chars keeps its head and tail with a marker between. */
export function capToolResult(block: ToolResultBlock): ToolResultBlock {
  if (!block.content.some(part => part.type === "text" && part.text.length > RESULT_MAX)) return block;
  return {
    ...block,
    content: block.content.map(part => {
      if (part.type !== "text" || part.text.length <= RESULT_MAX) return part;
      const cut = part.text.length - RESULT_HEAD - RESULT_TAIL;
      return { type: "text" as const, text: `${part.text.slice(0, RESULT_HEAD)}\n[… ${cut} characters cut …]\n${part.text.slice(-RESULT_TAIL)}` };
    }),
  };
}

/**
 * Caps every tool_result already in `messages` (in place). The runtime calls it right before it
 * pushes a round's new results, so the model sees each result whole once (a deliberate 100 KB
 * read_skill_file, a long page) and only its head and tail on later calls in the turn.
 */
export function capOlderResults(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "user" || !message.content.some(block => block.type === "tool_result" && block.content.some(part => part.type === "text" && part.text.length > RESULT_MAX))) continue;
    messages[i] = { ...message, content: message.content.map(block => (block.type === "tool_result" ? capToolResult(block) : block)) };
  }
}

const hasImage = (message: Message): boolean => message.content.some(block => block.type === "image" || (block.type === "tool_result" && block.content.some(part => part.type === "image")));
/**
 * Images stay only in the newest KEEP_IMAGE_MESSAGES messages that carry any; in older ones each
 * image becomes a short text note. Changes `messages` in place (an image once dropped never returns).
 */
export function trimImages(messages: Message[]): void {
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!hasImage(message)) continue;
    if (kept < KEEP_IMAGE_MESSAGES) { kept++; continue; }
    const omitted = { type: "text" as const, text: IMAGE_OMITTED };
    messages[i] = {
      ...message,
      content: message.content.map((block): ContentBlock => {
        if (block.type === "image") return omitted;
        if (block.type === "tool_result" && block.content.some(part => part.type === "image")) return { ...block, content: block.content.map(part => (part.type === "image" ? omitted : part)) };
        return block;
      }),
    };
  }
}

// ---- B5: the post-turn claim check (plan M14 交付核查; nanomuse-harness-2 N4/N5; codync-harness #14) ----
// A small bilingual pattern set for "it's made / done / sent / set up" and "I'll remind you".
// An ordinary answer must not match: "Here's the difference between X and Y", "Here's the weather"
// after web_search, "两个版本都添加了夜间模式", "该功能已经添加到 iOS 18". So "here's ..." counts only
// with a making verb ("here's the doc I made"), and zh "已 + verb" only when the verb ends the claim
// (好 / 完 / 妥 / 成功 / 给 / 你 / 您, or 了 at the end of a clause) or "I / for you" says who did it.
const ZH_DONE_VERB = "(?:完成|做|创建|生成|设置|设|安排|发送|发出|发|建|保存|提交|预约|订|加|添加)";
const CLAIM_ZH = new RegExp([
  `已经?${ZH_DONE_VERB}(?:好|完|妥|成功|给|你|您|了(?=$|[\\s，。！？,.!?]))`,
  `(?:我|帮你|帮您|给你|给您|为你|为您)(?:已经?|刚刚?)${ZH_DONE_VERB}|(?:我)?已经?(?:帮|给|为)(?:你|您)${ZH_DONE_VERB}`,
  "(?:做好|搞定|弄好|写好|建好|设好|发好|安排好)了",
  "我(?:会|将)(?:按时)?提醒|到时(?:候)?(?:会)?提醒",
].join("|"));
const EN_DONE_VERB = "(?:created|made|built|generated|set up|scheduled|sent|added|saved|started|finished|completed|booked|posted|drafted|written|put together)";
const CLAIM_EN = new RegExp([
  `\\bI(?:'ve| have)\\s+(?:just\\s+|already\\s+|now\\s+)?${EN_DONE_VERB}\\b`,
  // "here's" alone introduces any answer; only "here's the X I made" claims a deliverable
  `\\bhere(?:'s| is) (?:your|the)\\b[^.!?\\n]{0,60}?\\bI(?:'ve| have)?\\s+(?:just\\s+)?${EN_DONE_VERB}\\b`,
  "\\bI(?:'ll| will) remind you\\b",
  "\\b(?:has|have) been (?:created|made|built|generated|set up|scheduled|sent|added|saved|started|completed|booked|posted)\\b",
  "\\ball done\\b",
  "\\bis all set\\b",
].join("|"), "i");
export const claimsDeliverable = (text: string): boolean => CLAIM_ZH.test(text) || CLAIM_EN.test(text);
/** Tools that only read: a success of one of these doesn't back a "made / done / set up" claim. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // M29: load_tools (agent/loading.ts) only makes tools callable.
  "web_search", "web_fetch", "search_past_chats", "quick_replies", "react", "search_app_tools", "get_app_tool_schemas", "read_skill_file", "load_tools",
  "weather", "exchange_rate", "read_feed",
  "computer_screenshot", "computer_snapshot", "computer_read", "computer_navigate", "computer_scroll", "computer_files_list", "computer_files_read", "computer_files_search",
]);
/**
 * Tools whose success already put something the user sees in the thread (a reaction, quick
 * replies, a card) without ending the turn: after one of them an empty final reply is complete, so
 * it gets no empty-reply nudge. Any other tool (web_search, a lookup) followed by an empty reply is
 * nudged once. Tools that post and end the turn (ask_user, propose_tasks, start_task...) never reach
 * the nudge.
 */
// M22: show_tasks and propose_soul_setup post a card too.
export const VISIBLE_TOOLS: ReadonlySet<string> = new Set(["react", "quick_replies", "show_card", "ask_form", "withdraw_card", "show_tasks", "propose_soul_setup"]);
