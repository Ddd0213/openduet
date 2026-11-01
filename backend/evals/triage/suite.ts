// Triage: each labelled email (emails.jsonl, written by build-set.ts) is "needs_you" or
// "can_wait". --classifier current asks today's check-in turn, one email at a time;
// --classifier triage asks src/proactive/triage.ts (M23 W2), --rules-only its rules without a model.
// Scores needs_you precision and recall, accuracy, what the rules decided, and lists every
// disagreement with both reasons.
import { scoreTriage, type TriageEmail, type TriageRow, type TriageVerdict } from "../score/triage.ts";
import { readJsonl } from "../lib/fixtures.ts";
import { table } from "../lib/output.ts";
import { eachCase, problemLines, transcript, type RunOptions, type Suite } from "../lib/suite.ts";
import { currentVerdict, loadTriage, TRIAGE_MODULE, triageVerdict } from "./adapters.ts";
import { TriageEmailSchema } from "./build-set.ts";

function loadEmails(opts: Pick<RunOptions, "cases" | "limit">): TriageEmail[] {
  const all = readJsonl("triage/emails.jsonl", TriageEmailSchema);
  const picked = opts.cases ? all.filter((e) => opts.cases!.includes(e.id)) : all;
  return opts.limit !== null ? picked.slice(0, opts.limit) : picked;
}

type Row = TriageRow & { pass: boolean; note?: string };

const rowOf = (base: Omit<TriageRow, "verdict" | "reason" | "decidedBy" | "error">, v: TriageVerdict, label: TriageEmail["label"]): Row =>
  ({ ...base, ...v, pass: v.verdict === label, ...(v.verdict === null ? { note: "undecided" } : {}) });

export const triage: Suite = {
  id: "triage",
  calls: "current: 48 check-ins × 5-8 calls ≈ 240-380; triage: 1 per email the rules leave (37 of 48 today); --rules-only: 0",
  async skip(opts) {
    if (opts.rulesOnly && opts.classifier !== "triage") return "--rules-only needs --classifier triage (today's check-in has no separate rules)";
    if (opts.classifier !== "triage") return null;
    const mod = await loadTriage();
    if (mod === null) return `--classifier triage: ${TRIAGE_MODULE.replace(/^.*\/src\//, "src/")} doesn't exist yet (M23 W2 writes it)`;
    return typeof mod === "string" ? mod : null;
  },
  async run(env, opts) {
    const emails = loadEmails(opts);
    const loaded = opts.classifier === "triage" ? await loadTriage() : null;
    const mod = loaded && typeof loaded !== "string" ? loaded : null;
    const runs = await eachCase<TriageEmail, Row>(env, "triage", emails, opts, async (e, repeat) => {
      const base = { id: e.id, lang: e.lang, label: e.label, why: e.why, subject: e.subject, repeat };
      if (mod) {
        const v = await triageVerdict(env, mod, e, opts.rulesOnly);
        return { row: rowOf(base, v, e.label), turns: [] };
      }
      const { verdict: v, turn } = await currentVerdict(env, e);
      return { row: rowOf(base, v, e.label), turns: [turn] };
    });
    const rows = runs.map((r) => r.row);
    const s = scoreTriage(rows);
    const label = opts.classifier === "triage" ? (opts.rulesOnly ? "triage.ts rules only" : "triage.ts") : "current check-in";
    const langs = Object.entries(s.byLang).map(([lang, l]) => `- ${lang}: precision ${l.precision}, recall ${l.recall}, accuracy ${l.accuracy} (${l.decided} decided)`);
    const markdown = [
      `## Summary (${label})`,
      "",
      `- emails: ${s.total} (decided ${s.decided}, undecided ${s.undecided})`,
      `- needs_you precision: ${s.precision} (${s.truePositive} of ${s.truePositive + s.falsePositive} flagged really needed her)`,
      `- needs_you recall: ${s.recall} (${s.truePositive} of ${s.truePositive + s.falseNegative} that needed her were flagged)`,
      `- accuracy: ${s.accuracy}`,
      `- decided by rules: ${s.byRules} (wrong: ${s.ruleErrors})`,
      ...langs,
      "",
      "Recall matters more than precision: a missed failed payment costs more than one extra line. The set is small, invented and labelled by the same people who write the prompts: a regression check, not proof of accuracy on a real inbox.",
      ...(opts.classifier === "current" ? ["", "current: a check-in turn per email over an inbox holding only that email. A post or card = needs_you; silence (finish_checkin) or an Up next item = can_wait; a turn that failed or never read the mail is undecided."] : []),
      "",
      "## Disagreements",
      "",
      s.disagreements.length
        ? table(["id", "lang", "label", "verdict", "decided by", "subject", "why (label)", "reason (classifier)"], s.disagreements.map((d) => [d.id, d.lang, d.label, d.verdict, d.decidedBy, d.subject, d.why, d.reason]))
        : "None.",
      "",
      "## Undecided",
      "",
      rows.some((r) => r.verdict === null) ? table(["id", "label", "subject", "error"], rows.filter((r) => r.verdict === null).map((r) => [r.id, r.label, r.subject, r.error ?? ""])) : "None.",
      "",
      "## Every verdict",
      "",
      table(["id", "lang", "label", "verdict", "decided by", "reason"], rows.map((r) => [`${r.id}${opts.repeat > 1 ? ` #${r.repeat}` : ""}`, r.lang, r.label, r.verdict ?? "–", r.decidedBy, r.reason || r.error || ""])),
      ...problemLines(runs),
    ].join("\n");
    return {
      json: { classifier: label, score: s, rows: runs.map((r) => ({ ...r.row, turns: transcript(r.turns) })) },
      markdown,
      summary: `triage (${label}): precision ${s.precision}, recall ${s.recall}, accuracy ${s.accuracy}, ${s.undecided} undecided`,
      // A regression check: it "passes" when every email that needed her was flagged.
      pass: s.decided > 0 && s.falseNegative === 0,
    };
  },
};
