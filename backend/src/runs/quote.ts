// Quote reply (M8): the excerpt a user message keeps of the assistant message it answers, and the
// line the model reads before that user turn.
export const EXCERPT_MAX = 160;

/** Markdown removed (links keep their text, code keeps its content), whitespace collapsed. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The quoted message's first 160 characters without markdown (cards without text get their kind). */
export function quoteExcerpt(text: string, kind = "text"): string {
  const plain = stripMarkdown(text);
  const body = plain || (kind === "text" ? "" : `[${kind}]`);
  return [...body].slice(0, EXCERPT_MAX).join("");
}

/** What the model reads before a user turn that quotes one of the assistant's messages (model-facing English). */
export function replyLine(excerpt: string): string {
  return `The user is replying to this earlier message of yours: «${excerpt}»`;
}
