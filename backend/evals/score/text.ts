// Small text measures shared by the scorers: words (a Chinese character counts as one word),
// sentences (Chinese and English punctuation), questions, list items, the median.

const CJK_CLASS = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af";
const CJK_ALL = new RegExp(`[${CJK_CLASS}]`, "gu");
const LETTER = /[\p{L}\p{N}]/u;

/** Markdown links keep their text; emphasis, code and heading marks go. */
export function plainText(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|~]/g, " ");
}

/** Words: every CJK character counts as one, other text by whitespace-separated words. */
export function wordCount(text: string): number {
  const plain = plainText(text);
  const cjk = plain.match(CJK_ALL)?.length ?? 0;
  const rest = plain.replace(CJK_ALL, " ").split(/\s+/).filter((w) => LETTER.test(w)).length;
  return cjk + rest;
}

/** Mostly Chinese / Japanese / Korean (more than 30% of its letters). */
export function isCjk(text: string): boolean {
  const letters = [...text].filter((c) => LETTER.test(c)).length;
  const cjk = text.match(CJK_ALL)?.length ?? 0;
  return letters > 0 && cjk / letters > 0.3;
}

/** Length in characters (code points), as a person counts them. */
export const charLength = (text: string): number => [...text].length;

const END = new Set(["。", "！", "？", "!", "?", "…"]);
const SOFT_END = new Set([".", ";", "；"]);
const CLOSERS = new Set(["\"", "'", "”", "’", ")", "）", "」", "』"]);
const BULLET = /^\s*(?:[-*•·]\s+|\d{1,2}[.)](?=\s)\s*|\d{1,2}、\s*|[（(]\d{1,2}[)）]\s*)/;

/** Sentences of a reply, split per line and after sentence punctuation (not inside 3.5 or e.g.x). */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const cleaned = line.replace(BULLET, "").replace(/[*_`#>]/g, "").trim();
    if (!cleaned) continue;
    const chars = [...cleaned];
    let current = "";
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      current += c;
      const next = chars[i + 1];
      const ends = END.has(c) || (SOFT_END.has(c) && (next === undefined || /\s/.test(next)));
      if (!ends) continue;
      while (chars[i + 1] !== undefined && (CLOSERS.has(chars[i + 1]!) || END.has(chars[i + 1]!))) current += chars[++i]!;
      if (current.trim()) out.push(current.trim());
      current = "";
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

/** A question: ends with ? / ？ (closing quotes allowed), or with 吗 / 呢. */
export function isQuestion(sentence: string): boolean {
  const s = sentence.trim();
  return /[?？]\s*["'”’)）」』]*$/.test(s) || /(吗|呢)\s*[。.!！]?$/.test(s);
}

const FILLER = /^(?:let me know|tell me|just say|anything else|happy to help|sure[.!]?$|ok(?:ay)?[.!]?$|got it|sounds good|here(?:'s| is| are) (?:a few|some|the|your) options?|好的[。！!]?$|当然[。！!]?$|没问题[。！!]?$|告诉我|随时告诉我|你看呢|看你)/i;

/**
 * A sentence that says something: not a question, not filler or an invitation, not just one of the
 * chip labels, and at least 3 words (a Chinese character counts as one, so 3 characters).
 */
export function isStatement(sentence: string, labels: readonly string[] = []): boolean {
  const s = sentence.trim();
  if (!s || isQuestion(s) || FILLER.test(s)) return false;
  const bare = s.replace(/[。.!！:：]+$/, "").trim().toLowerCase();
  if (labels.some((label) => label.trim().toLowerCase() === bare)) return false;
  return wordCount(s) >= 3;
}

/** How many sentences in `text` are questions. */
export const questionCount = (text: string): number => sentences(text).filter(isQuestion).length;

const ITEM = /^\s*(?:[-*•·]\s+\S|\d{1,2}[.)](?=\s)\s*\S|\d{1,2}、\s*\S|[（(]\d{1,2}[)）]\s*\S|[一二三四五六七八九十][、.]\s*\S)/;

/** Lines that are list items (bullets, numbered, 1、 or （1）). */
export function listItems(text: string): number {
  return text.split("\n").filter((line) => ITEM.test(line)).length;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** "62.5%" (one decimal), or "n/a" without a denominator. */
export const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
