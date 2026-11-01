// M24: saved-page text, not a browser. Never execute scripts or include the injected base.
import { convert } from "html-to-text";
import { READ_ARTIFACT_MAX_CHARS } from "../contract/m24.ts";
import { stripInjected } from "../make/base.ts";

const VOID = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
const BLOCK = /^(?:h[1-6]|p|div|section|article|header|footer|main|li|ul|ol|tr|blockquote|pre)$/;

/** Visible static text: headings, list items and table rows retain their boundaries. */
export function pageText(html: string, limit = READ_ARTIFACT_MAX_CHARS): { text: string; truncated: boolean } {
  const frames: { hidden: boolean }[] = [];
  const parts: string[] = [];
  new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      const hidden = !!frames.at(-1)?.hidden || /^(?:head|script|style|template|noscript)$/.test(tag)
        || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true"
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(el.getAttribute("style") ?? "");
      if (!hidden) {
        if (BLOCK.test(tag) || tag === "br") parts.push("\n");
        if (/^h[1-6]$/.test(tag)) parts.push(`${"#".repeat(Number(tag[1]))} `);
        if (tag === "li") parts.push("- ");
        if (tag === "td" || tag === "th") parts.push(" | ");
      }
      if (VOID.test(tag)) return;
      const frame = { hidden };
      frames.push(frame);
      el.onEndTag(() => {
        if (!hidden && BLOCK.test(tag)) parts.push("\n");
        frames.splice(frames.indexOf(frame));
      });
    },
    text(chunk) { if (!frames.at(-1)?.hidden) parts.push(chunk.text); },
  }).transform(stripInjected(html));
  // Decode entities exactly once, without treating literal text as markup. html-to-text is an
  // existing dependency (web_fetch), with full named-entity support rather than a small allowlist.
  const raw = parts.join("").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const full = convert(raw, { wordwrap: false, preserveNewlines: true })
    .split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  let text = "", count = 0;
  for (const char of full) {
    if (count++ >= limit) return { text, truncated: true };
    text += char;
  }
  return { text, truncated: false };
}
