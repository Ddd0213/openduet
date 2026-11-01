// M18: what a task posts in its channel's chat (main timeline, taskId null) when its turn ends:
// the result (a done task's final text, with taskResult on the payload), or one line with the
// task's link when it failed or waits for the user. Pure text helpers; TaskService posts them.
import type { Task as TaskRow } from "@prisma/client";

/** The longest text a user can send (SendMessageRequest.text); a result is kept under it too. */
export const RESULT_MAX = 32_000;
/** a waiting notice's question */
export const QUESTION_MAX = 140;
/** a failed notice's reason */
export const REASON_MAX = 200;

/**
 * A phrase template with the task link filled in: {title} with markdown link brackets escaped,
 * {id}, and any extra {name}. One pass with function replacements, so "$" or a literal "{id}"
 * inside a title, a reason or a question is kept as written.
 */
export function fillTemplate(template: string, task: Pick<TaskRow, "id" | "title">, extra: Record<string, string> = {}): string {
  const title = task.title.replace(/[\\[\]]/g, (c) => `\\${c}`);
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name === "title") return title;
    if (name === "id") return task.id;
    return Object.hasOwn(extra, name) ? extra[name]! : whole;
  });
}

/** Markdown marks and line breaks out, for a one-line excerpt. */
function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*•]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts to max characters with "…" (at a word boundary when one is near). */
export function clipLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The text ends with a question mark (? or ？), ignoring closing quotes, brackets and markdown marks. */
export function endsWithQuestion(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim().replace(/[\s*_`~"'”’」』)\]）]+$/u, "");
  return /[?？]$/.test(trimmed);
}

/** The last sentence of a text (one line, ≤ QUESTION_MAX characters), or "" when there is none. */
export function lastSentence(text: string | null | undefined): string {
  const line = plainLine(text ?? "");
  if (!line) return "";
  // Sentences end at . ! ? 。！？ (followed by a space for the Latin ones, so "3.5" stays whole).
  const parts = line.split(/(?<=[.!?])\s+|(?<=[。！？])/u).map((s) => s.trim()).filter(Boolean);
  return clipLine(parts.at(-1) ?? line, QUESTION_MAX);
}

/** A reason / question for a notice line: one line, capped. */
export function noticeExcerpt(text: string, max: number): string {
  return clipLine(plainLine(text), max);
}

/**
 * The result message's text, at most RESULT_MAX characters: a longer one is cut at the last
 * paragraph break that fits (else the last line break, else hard) and ends with "…".
 */
export function clipResult(text: string, max = RESULT_MAX): string {
  if (text.length <= max) return text;
  // room for the "\n\n…" ending
  const room = text.slice(0, max - 3);
  const paragraph = room.lastIndexOf("\n\n");
  const line = room.lastIndexOf("\n");
  const cut = paragraph > max / 2 ? paragraph : line > max / 2 ? line : room.length;
  return `${room.slice(0, cut).trimEnd()}\n\n…`;
}
