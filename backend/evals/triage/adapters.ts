// The two classifiers the triage suite can ask, behind one shape (TriageVerdict):
//  - "current": today's production path. A check-in turn ("Run now") over an inbox holding only
//    this email: a post or card in the thread = needs_you, silence or an Up next item = can_wait.
//  - "triage": src/proactive/triage.ts (M23 W2), called per email like reads.ts calls it; this
//    adapter is the one place to change if its exports change.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { phrase } from "../../src/agent/phrase.ts";
import { checkinVerdict, type TriageEmail, type TriageVerdict } from "../score/triage.ts";
import { toolsOf, type TurnRecord } from "../score/types.ts";
import type { EvalEnv } from "../lib/env.ts";
import type { MailFixture } from "../lib/fixtures.ts";
import { Session } from "../lib/session.ts";

export const TRIAGE_MODULE = join(import.meta.dir, "../../src/proactive/triage.ts");

export const asMail = (e: TriageEmail): MailFixture => ({
  id: e.id, from: e.from, to: e.to, cc: e.cc, subject: e.subject, minutesAgo: e.minutesAgo, headers: e.headers, labels: e.labels, body: e.body,
});

/** Lines a check-in may post that aren't about the mail (the Friday "weekends too?" ask). */
const IGNORE = [phrase("agent.weekends_ask", "en"), phrase("agent.weekends_ask", "zh-Hans")];

/** A share_finding post (news about something the user follows) isn't a verdict on the email. */
function withoutFindings(turn: TurnRecord): TurnRecord {
  const findings = toolsOf(turn).filter((t) => t.name === "share_finding").map((t) => String(t.input.text ?? "").trim()).filter(Boolean);
  if (!findings.length) return turn;
  return { ...turn, shown: turn.shown.filter((m) => !findings.some((f) => m.text.includes(f))) };
}

export async function currentVerdict(env: EvalEnv, email: TriageEmail): Promise<{ verdict: TriageVerdict; turn: TurnRecord }> {
  env.composio.mailbox = [asMail(email)];
  env.composio.events = [];
  const session = await Session.main(env, email.lang);
  const turn = await session.checkin();
  return { verdict: checkinVerdict(withoutFindings(turn), IGNORE), turn };
}

// ---------------------------------------------------------------- src/proactive/triage.ts

/**
 * src/proactive/triage.ts as W2 wrote it (read 2026-10-29): `ruleVerdict(mail)` (the rules' "can wait",
 * else null) and `classifyMail(mail, person, model)` (rules, then one model call; throws when the
 * call fails or the answer has no verdict and reason). Loaded at run time and checked here, so this
 * file compiles whether or not triage.ts exists and a renamed export is a clear skip, not a crash.
 */
interface TriageMail { id: string; from: string; to: string[]; cc: string[]; subject: string; date?: string | null; headers: Record<string, string>; labels: string[]; body: string }
interface TriagePerson { name: string; email: string; about?: string }
const Result = z.object({ verdict: z.enum(["needs_you", "can_wait"]), reason: z.string(), decidedBy: z.string() }).passthrough();

type Fn = (...args: unknown[]) => unknown;
export interface TriageModule { ruleVerdict: Fn; classifyMail: Fn }

/** The module, or why it can't be used (null: it doesn't exist yet). */
export async function loadTriage(): Promise<TriageModule | string | null> {
  if (!existsSync(TRIAGE_MODULE)) return null;
  const mod = (await import(TRIAGE_MODULE)) as Record<string, unknown>;
  const { ruleVerdict, classifyMail } = mod;
  if (typeof ruleVerdict !== "function" || typeof classifyMail !== "function") {
    return `src/proactive/triage.ts doesn't export ruleVerdict and classifyMail (exports: ${Object.keys(mod).join(", ")}); update evals/triage/adapters.ts`;
  }
  return { ruleVerdict: ruleVerdict as Fn, classifyMail: classifyMail as Fn };
}

const asTriageMail = (e: TriageEmail): TriageMail => ({
  id: e.id, from: e.from, to: e.to, cc: e.cc, subject: e.subject, date: new Date(Date.now() - e.minutesAgo * 60_000).toISOString(),
  headers: e.headers, labels: e.labels, body: e.body,
});

function toVerdict(raw: unknown): TriageVerdict {
  const parsed = Result.safeParse(raw);
  if (!parsed.success) return { verdict: null, reason: "", decidedBy: "triage", error: `unexpected result: ${JSON.stringify(raw)?.slice(0, 200)}` };
  return { verdict: parsed.data.verdict, reason: parsed.data.reason, decidedBy: parsed.data.decidedBy };
}

/**
 * One email through triage.ts, the way the brief and check-ins call it (reads.ts): the persona as
 * the inbox's owner (with the About-you text), the resolver's utility model (the eval's model: the
 * copy has no separate utility model). A throw (a failed call, an answer without a verdict) is
 * undecided here; production lists such mail as needs you, "unsorted".
 */
export async function triageVerdict(env: EvalEnv, mod: TriageModule, email: TriageEmail, rulesOnly: boolean): Promise<TriageVerdict> {
  const mail = asTriageMail(email);
  try {
    const ruled = await mod.ruleVerdict(mail);
    if (ruled) return toVerdict(ruled);
    if (rulesOnly) return { verdict: null, reason: "", decidedBy: "rules", error: "left to the model" };
    const resolved = await env.resolver.resolve({ userId: env.user.id, channelId: null, role: "utility" });
    if (!resolved) return { verdict: null, reason: "", decidedBy: "triage", error: "no usable model" };
    const person: TriagePerson = { name: env.persona.name, email: env.persona.email, about: env.persona.about };
    const model = { llm: resolved.llm, id: resolved.model.id, thinkingLevel: resolved.thinkingLevel };
    return toVerdict(await mod.classifyMail(mail, person, model, { now: new Date() }));
  } catch (error) {
    return { verdict: null, reason: "", decidedBy: "triage", error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 200) };
  }
}
