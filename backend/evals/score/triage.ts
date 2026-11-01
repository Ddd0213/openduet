// Triage: each labelled email is "needs_you" or "can_wait". Scores needs_you precision and recall,
// accuracy, how many the rules decided (and got wrong), and lists every disagreement with both
// reasons. Recall matters more than precision: a missed failed payment costs more than one extra line.
import { pct } from "./text.ts";
import { toolsOf, type TurnRecord } from "./types.ts";

export type Label = "needs_you" | "can_wait";

export interface TriageEmail {
  id: string;
  lang: "en" | "zh-Hans";
  label: Label;
  /** why a careful assistant labels it so (a person would accept it) */
  why: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** minutes before the run */
  minutesAgo: number;
  headers: Record<string, string>;
  /** Gmail labels: INBOX, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS ... */
  labels: string[];
  body: string;
}

/** What a classifier said about one email; null verdict = it couldn't decide (an error). */
export interface TriageVerdict { verdict: Label | null; reason: string; decidedBy: string; error?: string }

export interface TriageRow { id: string; lang: string; label: Label; why: string; subject: string; verdict: Label | null; reason: string; decidedBy: string; error?: string; repeat: number }

export interface TriageScore {
  total: number;
  decided: number;
  undecided: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: string;
  recall: string;
  accuracy: string;
  byRules: number;
  ruleErrors: number;
  byLang: Record<string, { decided: number; precision: string; recall: string; accuracy: string }>;
  disagreements: TriageRow[];
}

function counts(rows: readonly TriageRow[]) {
  const decided = rows.filter((r) => r.verdict !== null);
  const tp = decided.filter((r) => r.label === "needs_you" && r.verdict === "needs_you").length;
  const fp = decided.filter((r) => r.label === "can_wait" && r.verdict === "needs_you").length;
  const fn = decided.filter((r) => r.label === "needs_you" && r.verdict === "can_wait").length;
  const tn = decided.filter((r) => r.label === "can_wait" && r.verdict === "can_wait").length;
  return { decided: decided.length, tp, fp, fn, tn };
}

export function scoreTriage(rows: readonly TriageRow[]): TriageScore {
  const c = counts(rows);
  const byRules = rows.filter((r) => r.verdict !== null && r.decidedBy.startsWith("rule:"));
  const byLang: TriageScore["byLang"] = {};
  for (const lang of [...new Set(rows.map((r) => r.lang))].sort()) {
    const l = counts(rows.filter((r) => r.lang === lang));
    byLang[lang] = { decided: l.decided, precision: pct(l.tp, l.tp + l.fp), recall: pct(l.tp, l.tp + l.fn), accuracy: pct(l.tp + l.tn, l.decided) };
  }
  return {
    total: rows.length, decided: c.decided, undecided: rows.length - c.decided,
    truePositive: c.tp, falsePositive: c.fp, falseNegative: c.fn, trueNegative: c.tn,
    precision: pct(c.tp, c.tp + c.fp), recall: pct(c.tp, c.tp + c.fn), accuracy: pct(c.tp + c.tn, c.decided),
    byRules: byRules.length, ruleErrors: byRules.filter((r) => r.label !== r.verdict).length, byLang,
    disagreements: rows.filter((r) => r.verdict !== null && r.verdict !== r.label),
  };
}

const MAIL_READ = /^(?:GMAIL|OUTLOOK)_(?:FETCH|LIST|GET|SEARCH|READ)/;
const MAIL_IN_CALL = /\b(?:GMAIL|OUTLOOK)_(?:FETCH|LIST|GET|SEARCH|READ)/;
/** Message kinds a check-in can put in front of the user (contract/messages.ts MESSAGE_KINDS). */
const VISIBLE = new Set(["text", "quick_replies", "task_suggestions", "proactive_suggestion", "card", "form", "alert", "plate"]);

/**
 * "current" classifier: what today's check-in turn did with an inbox holding only this email.
 * Posting to the user (post_message, a task card, a finding) = needs_you; staying silent
 * (finish_checkin nothingNeeded, or an Up next item only) = can_wait. A turn that failed or never
 * read the mail decides nothing.
 */
export function checkinVerdict(turn: TurnRecord, ignore: readonly string[] = []): TriageVerdict {
  if (turn.status !== "completed") return { verdict: null, reason: "", decidedBy: "checkin", error: `turn ${turn.status}${turn.error ? ` (${turn.error})` : ""}` };
  const calls = toolsOf(turn);
  const readMail = turn.apps.some((a) => MAIL_READ.test(a.slug))
    || calls.some((c) => c.name === "execute_app_tools" && MAIL_IN_CALL.test(JSON.stringify(c.input).toUpperCase()));
  if (!readMail) return { verdict: null, reason: "", decidedBy: "checkin", error: "the check-in never read the mail" };
  // `ignore`: fixed lines that aren't about the mail (the Friday "check in on weekends too?" ask).
  const shown = turn.shown.filter((m) => m.role === "assistant" && VISIBLE.has(m.kind) && !ignore.includes(m.text.trim()));
  if (shown.length) {
    const text = shown.map((m) => m.text).find((t) => t.trim()) ?? shown[0]!.kind;
    return { verdict: "needs_you", reason: oneLine(text), decidedBy: "checkin:posted" };
  }
  const upNext = calls.find((c) => c.name === "add_up_next");
  if (upNext) return { verdict: "can_wait", reason: oneLine(String(upNext.input.title ?? upNext.input.body ?? "Up next item")), decidedBy: "checkin:up_next" };
  const said = turn.timeline.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(" ");
  return { verdict: "can_wait", reason: oneLine(said) || "stayed silent", decidedBy: "checkin:silent" };
}

const oneLine = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
};
