// M14b: how alike two memory lines are, for write-time dedupe (remember, dreaming) and for
// "forgetting sticks". Words for Latin text, character pairs for CJK (a Chinese fact has no
// spaces), compared as sets (Jaccard). Pure; no model, no database.

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** NFKC, lower case, punctuation folded to spaces (so "Leeds." and "leeds" match). */
export function normalFact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Latin words (two letters or more, or any number) plus CJK character pairs (a lone CJK character as itself). */
export function factTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of normalFact(text).split(" ")) {
    if (!part) continue;
    let latin = "";
    let cjk = "";
    const flushLatin = () => {
      if (latin.length >= 2 || /\d/.test(latin)) tokens.add(latin);
      latin = "";
    };
    const flushCjk = () => {
      const chars = [...cjk];
      if (chars.length === 1) tokens.add(chars[0]!);
      for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i]! + chars[i + 1]!);
      cjk = "";
    };
    for (const ch of part) {
      if (CJK.test(ch)) {
        flushLatin();
        cjk += ch;
      } else {
        flushCjk();
        latin += ch;
      }
    }
    flushLatin();
    flushCjk();
  }
  return tokens;
}

/** 1 = the same line after normalising; otherwise the Jaccard overlap of the token sets (0..1). */
export function factSimilarity(a: string, b: string): number {
  if (normalFact(a) === normalFact(b)) return 1;
  const x = factTokens(a);
  const y = factTokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const token of x) if (y.has(token)) shared++;
  return shared / (x.size + y.size - shared);
}

/** At or above: the same fact said again (dedupe; a forgotten fact coming back). */
export const SAME_FACT = 0.8;
/** At or above: worth showing the model as "similar" so it can pass `replaces`. */
export const SIMILAR_FACT = 0.5;

/**
 * The share of the fact's tokens the user's own text contains (0..1): a forgotten fact may come back
 * only when the user says it again in this turn's message, not from old chat history.
 */
export function coveredBy(fact: string, userText: string): number {
  const tokens = factTokens(fact);
  if (tokens.size === 0) return 0;
  const said = factTokens(userText);
  let hit = 0;
  for (const token of tokens) if (said.has(token)) hit++;
  return hit / tokens.size;
}
