// M24: all statically observable page-quality issues in one pass; never executes page JS.
// This is advisory layout analysis, not a sanitizer. checkHtml/CSP remain independent gates.
import { CHANGED_ATTR, stripInjected } from "./base.ts";
import { lintDeclarations, lintStylesheet } from "./lint-css.ts";
import type { ArtifactType, BuildMode } from "./prompts.ts";

export const SLIDE_WORD_LIMIT = 35;
export const SLIDE_BULLET_LIMIT = 4;
export interface PageIssue { code: string; path: string; message: string }
export interface PageLint { errors: PageIssue[]; warnings: PageIssue[] }
export interface PageLintOptions {
  type: ArtifactType;
  mode?: BuildMode;
  /** undefined/null means unavailable or retained metadata, not an empty metrics submission. */
  metrics?: readonly unknown[] | null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK = /^(?:h[1-6]|p|div|section|article|header|footer|main|li|ul|ol|br|td|th|tr)$/;
const HIDDEN = /^(?:head|script|style|template|noscript)$/;
const FLUID = /^(?:table|img|svg|canvas|video)$/;

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (all, name: string) => {
    if (name[0] !== "#") return ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? all;
    const n = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
  });
}

/** Two CJK characters occupy roughly one short Latin word; count mixed-language slides too. */
export function slideWords(text: string): number {
  const decoded = decode(text);
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const chars = [...decoded.matchAll(cjk)].length;
  return Math.ceil(chars / 2) + (decoded.replace(cjk, " ").match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0);
}

interface Slide { text: string; bullets: number }
interface Frame {
  tag: string; path: string; hidden: boolean; code: boolean; text: string;
  slide?: Slide; chart?: string;
}

export function lintPage(html: string, options: PageLintOptions): PageLint {
  const result: PageLint = { errors: [], warnings: [] };
  const add = (level: keyof PageLint, code: string, path: string, message: string) => result[level].push({ code, path, message });
  const own = stripInjected(html);
  if (!own.trim()) add("errors", "html.empty", "page", "The page is empty. Write its content before saving.");
  const frames: Frame[] = [], slides: Slide[] = [], scripts: string[] = [];
  const ids = new Set<string>(), charts = new Map<string, Frame>();
  let visible = "", titles = "", changed = false, elements = 0, styleIndex = 0;
  const append = (text: string, frame?: Frame) => {
    if (!frame || frame.hidden) return;
    if (!frame.code) visible += text;
    if (frame.slide) frame.slide.text += text;
  };
  // Bun's string transform is synchronous. Text handlers receive raw entities, decoded above.
  new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase(), parent = frames.at(-1);
      const id = el.getAttribute("id"), style = el.getAttribute("style") ?? "";
      const path = id ? `${tag}#${id}` : `${tag}[${++elements}]`;
      const hidden = !!parent?.hidden || HIDDEN.test(tag) || el.hasAttribute("hidden") || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(style);
      const frame: Frame = { tag, path, hidden, code: !!parent?.code || /^(?:code|pre|samp|kbd)$/.test(tag), text: "", slide: parent?.slide };
      if (id) ids.add(id);
      if (!hidden) {
        changed ||= el.hasAttribute(CHANGED_ATTR);
        result.errors.push(...lintDeclarations(style, `${path}/@style`, FLUID.test(tag), tag === "table"));
        if (el.getAttribute("class")?.split(/\s+/).includes("duet-slide")) {
          frame.slide = { text: "", bullets: 0 };
          slides.push(frame.slide);
        }
        if (tag === "li" && frame.slide) frame.slide.bullets++;
        if (id?.endsWith("-chart") && tag === "div") { frame.chart = id; charts.set(id, frame); }
        if (parent?.chart) { charts.delete(parent.chart); frame.chart = parent.chart; } // already rendered content
      }
      if (BLOCK.test(tag)) append(" ", frame);
      if (VOID.has(tag)) return;
      frames.push(frame);
      const sheetPath = tag === "style" ? `style[${++styleIndex}]` : "";
      el.onEndTag(() => {
        if (tag === "style") result.errors.push(...lintStylesheet(frame.text, sheetPath));
        if (tag === "script") scripts.push(frame.text);
        if ((tag === "title" && !parent?.hidden) || (tag === "h1" && !hidden)) titles += frame.text.trim();
        // <title> normally lives in the intentionally hidden <head>.
        if (tag === "title" && parent?.tag === "head") titles += frame.text.trim();
        if (frame.chart && frame.text.trim()) charts.delete(frame.chart);
        if (BLOCK.test(tag)) append(" ", frame);
        frames.splice(frames.indexOf(frame));
      });
    },
    text(chunk) {
      const frame = frames.at(-1);
      if (!frame || !chunk.text) return;
      frame.text += chunk.text;
      append(chunk.text, frame);
      // Nested formatting in a heading still counts as its title text.
      if (frame.tag !== "h1") {
        const heading = frames.findLast((f) => f.tag === "h1");
        if (heading) heading.text += chunk.text;
      }
    },
  }).transform(own);
  if (own.trim() && elements === 0 && ids.size === 0) add("errors", "html.not_html", "page", "Write the page as HTML, not plain text.");
  const text = decode(visible).replace(/\s+/g, " ");
  if (/\blorem\s+ipsum\b/i.test(text)) add("errors", "content.lorem_ipsum", "page/text", "Replace lorem ipsum with the user's actual content.");
  // TODO lists, input placeholder attributes, code samples and design-system states are not filler.
  if (/\b(?:TODO|TBD)\s*:/.test(text) || /\bplaceholder\s+(?:text|content)\b/i.test(text)) {
    add("warnings", "content.unfinished", "page/text", "Possible unfinished copy; confirm TODO/TBD or placeholder content is intentional.");
  }
  if (!titles.trim()) add("warnings", "content.title", "page", "No non-empty h1 or title was found; add a clear page title.");
  if (options.mode === "edit" && !changed) add("warnings", "edit.unmarked", "page", `No ${CHANGED_ATTR} was found; mark the passages you changed.`);
  if (options.type === "slides") {
    if (!slides.length) add("warnings", "slides.structure", "page", "Use .duet-slide sections so each slide can fit the screen and print separately.");
    slides.forEach((slide, i) => {
      const path = `.duet-slide[${i + 1}]`, words = slideWords(slide.text);
      if (words > SLIDE_WORD_LIMIT) add("errors", "slides.words", path, `${words} word-equivalents; at most ${SLIDE_WORD_LIMIT} (two CJK characters count as one). Split this slide.`);
      if (slide.bullets > SLIDE_BULLET_LIMIT) add("errors", "slides.bullets", path, `${slide.bullets} list items; at most ${SLIDE_BULLET_LIMIT}. Split this slide.`);
    });
  }
  if (options.type === "dashboard") {
    if (options.metrics && (options.metrics.length < 2 || options.metrics.length > 4)) add("errors", "dashboard.metrics", "finish_build.metrics", "Pass 2–4 real headline metrics; never invent missing data to fill the card.");
    const calls = new Set<string>();
    const js = scripts.join("\n").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    // A chart may be created lazily (e.g. only after there are recorded nights). Literal DOM
    // ids in script-built markup/assignments are enough to avoid declaring that target missing.
    for (const match of js.matchAll(/<[a-z][^<>]*\bid\s*=\s*["']([\w-]+)["']|\.id\s*=\s*["']([\w-]+)["']|\.setAttribute\(\s*["']id["']\s*,\s*["']([\w-]+)["']/gi)) {
      ids.add((match[1] ?? match[2] ?? match[3])!);
    }
    for (const match of js.matchAll(/\bduetBars\s*\(\s*["']#([\w-]+)["']/g)) calls.add(match[1]!);
    for (const match of js.matchAll(/\bduetBars\s*\(\s*document\.(?:getElementById\(\s*["']([\w-]+)["']|querySelector\(\s*["']#([\w-]+)["'])/g)) calls.add((match[1] ?? match[2])!);
    for (const id of calls) if (!ids.has(id)) add("errors", "dashboard.chart_target", `#${id}`, "duetBars refers to an id that is not in the HTML.");
    // Dynamic JS cannot be proven wrong statically; leave it alone. An empty, unrendered chart
    // with no duetBars at all is only a warning (it might use intentional custom SVG / canvas).
    if (!/\bduetBars\s*\(/.test(js)) for (const id of charts.keys()) {
      add("warnings", "dashboard.chart_empty", `#${id}`, "Empty chart container with no duetBars call; confirm it is rendered.");
    }
  }
  return result;
}
