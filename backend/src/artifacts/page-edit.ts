// M21 (#10, review-make P0-2): small edits and the shrink guard for Make edits and refreshes.
//  - replaceText: edit_page's exact old_string -> new_string on the page HTML (unique unless
//    replaceAll), so a small change doesn't rewrite (and maybe truncate) the whole page.
//  - pageSize / shrank: finish_build refuses a new page much smaller than the one the build
//    started from. A page counts by its markup (long data: URIs count as a few characters, so
//    dropping one image isn't "content lost") and its visible text; it has shrunk when BOTH fell
//    under SHRINK_RATIO of the old page, and the old page was at least SHRINK_MIN_CHARS of markup.
//    What edit_page removed on purpose is credited first (an asked-for deletion goes through).
// Pure functions; ArtifactService keeps the per-build state.

/** The old page must be at least this big (markup characters, data: URIs collapsed) to be guarded. */
export const SHRINK_MIN_CHARS = 4_000;
/** A new page under this share of the old one, by markup and by visible text, is refused. */
export const SHRINK_RATIO = 0.5;

export interface PageSize {
  /** characters of markup, each long data: URI counted as a few */
  markup: number;
  /** characters of visible text (no scripts, styles, tags; whitespace collapsed) */
  text: number;
}

const DATA_URI = /data:[^\s"'()<>]{200,}/gi;
const HIDDEN = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi;

export function pageSize(html: string): PageSize {
  const markup = html.replace(DATA_URI, "data:…");
  const text = markup.replace(HIDDEN, " ").replace(/<[^>]*>/g, " ").replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, "x").replace(/\s+/g, " ").trim();
  return { markup: markup.length, text: text.length };
}

/** What a replacement took out of the page on purpose (never negative), in pageSize units. */
export function removedBy(before: string, after: string): PageSize {
  const a = pageSize(before);
  const b = pageSize(after);
  return { markup: Math.max(0, a.markup - b.markup), text: Math.max(0, a.text - b.text) };
}

/**
 * Whether `next` lost much of `old` beyond what was cut on purpose. Both measures have to fall
 * under SHRINK_RATIO: a refresh with a shorter data array (markup only) or a page that dropped a
 * big image (markup only) goes through; a rewrite from a read that was cut off loses both.
 */
export function shrank(old: PageSize, next: PageSize, cut: PageSize = { markup: 0, text: 0 }): boolean {
  const markup = old.markup - cut.markup;
  const text = old.text - cut.text;
  if (markup < SHRINK_MIN_CHARS) return false;
  const lostMarkup = next.markup < markup * SHRINK_RATIO;
  // A page with almost no text (a design that's mostly SVG) is judged by its markup alone.
  const lostText = text < 200 ? true : next.text < text * SHRINK_RATIO;
  return lostMarkup && lostText;
}

export type Replaced = { ok: true; html: string; replacements: number } | { ok: false; error: string };

const loose = (s: string) => s.replace(/\s+/g, " ").trim();

/** edit_page: exact match, unique unless replaceAll. Errors are said to the model. */
export function replaceText(html: string, oldString: string, newString: string, replaceAll = false): Replaced {
  if (oldString === newString) return { ok: false, error: "old_string and new_string are the same; nothing would change." };
  const count = html.split(oldString).length - 1;
  if (count === 0) {
    const hint = loose(oldString) && loose(html).includes(loose(oldString))
      ? " The text is there with different spaces or line breaks: copy old_string exactly from the file (computer_files_read), including its whitespace."
      : " Read the page again (computer_files_read) and copy old_string exactly from it.";
    return { ok: false, error: `old_string was not found in the page.${hint}` };
  }
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `old_string appears ${count} times in the page. Add more of the surrounding text so it matches exactly once, or pass replace_all: true to change every one.` };
  }
  if (replaceAll) return { ok: true, html: html.split(oldString).join(newString), replacements: count };
  const at = html.indexOf(oldString);
  return { ok: true, html: `${html.slice(0, at)}${newString}${html.slice(at + oldString.length)}`, replacements: 1 };
}
