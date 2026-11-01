// M15: the "false hand-off" check. The voice model sometimes says it passed something to the assistant
// without calling send_to_assistant (修改意见 3: both calls had handedAt null, and the voice admitted
// it when asked). When a voice line claims a hand-off and no send_to_assistant lands within a short
// window around it, the voice gets a notice cue: nothing reached the assistant, call the tool now or say
// so. At most a few per call; the check lives in memory (a restart drops a pending one).
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { toSoul } from "../soul/service.ts";
import { clip } from "./text.ts";

/** How long after a claim the hand-off may still come (the voice often speaks first). */
export const HANDOFF_GRACE_MS = 20_000;
/** A hand-off this soon before a claim backs it (the claim is the voice telling the user). */
export const HANDOFF_BEFORE_MS = 30_000;
/** Nudges per call at most (a voice that keeps claiming isn't nagged without end). */
export const NUDGES_MAX = 3;

// zh: a verb of passing on; a preposition before the name that needs a saying verb after it
// ("跟 OpenDuet 说了"); "not" just before the verb; an offer or a question.
const ZH_DONE = /(转达|转告|转交|交给|交由|转给|发给|传给|告诉|通知)/g;
const ZH_PREP = /(跟|和|向)\s*$/;
const ZH_SAID = /^\s*\S{0,6}?(说了|讲了|提了|说一声|讲一声|反映了|交代了)/;
const ZH_NOT = /(没|未|不|别|无法|无需|没法)/;
const ZH_OFFER = /(要不要|需不需要|是否|可以帮你|要我|想让我|需要我|[吗么呢][。！？!?.]*$)/;
// en: "I've passed that on to OpenDuet", "sent it to OpenDuet", "I'll let OpenDuet know".
const EN_VERB = /\b(pass(?:ed|ing)?|sen[dt]|sending|forward(?:ed|ing)?|relay(?:ed|ing)?|hand(?:ed|ing)?(?: (?:it|that|this|them))? (?:off|over)|told|tell(?:ing)?|let(?:ting)?|ask(?:ed|ing)?)\b/gi;
const EN_NOT = /\b(not|never|haven't|hasn't|didn't|don't|can't|cannot|couldn't|won't|wasn't|isn't|no)\b/i;
const EN_OFFER = /\b(should i|shall i|do you want|would you like|want me to|if you (?:want|like)|(?:i|we) (?:can|could))\b/i;
/** Cheap first test: a line with none of these needs no closer look. */
const ANY_VERB = /(转达|转告|转交|交给|交由|转给|发给|传给|告诉|通知|跟|和|向|pass|sen[dt]|forward|relay|hand|told|tell|let|ask)/i;
const CJK = /[\u4e00-\u9fff]/;

/** The sentences of a line, each with its end mark (a question is told apart by it). */
function sentences(text: string): string[] {
  return text.match(/[^。！？!?.\n]+[。！？!?.]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The sentence of a voice line that says the request was (or is being) passed to the assistant, or null.
 * `names`: what the voice calls the assistant ("OpenDuet", "Duet", the soul's name). A question or an offer ("要我
 * 转达给 OpenDuet 吗？", "Should I pass it to OpenDuet?", "I can pass it to OpenDuet") and a "not"
 * ("还没有转达给 OpenDuet", "I haven't sent it to OpenDuet") don't count. The verb comes before the name:
 * "OpenDuet 告诉我…" is the assistant speaking.
 */
export function handoffClaim(text: string, names: string[]): string | null {
  const known = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!known.length) return null;
  // Spaces inside a name match any run of spaces ("Open  Duet" from speech recognition, "OpenDuet").
  const pattern = (n: string) => n.split(/\s+/).map(escape).join("\\s*");
  const name = new RegExp(known.map((n) => (/^[\w\s.-]+$/.test(n) ? `\\b${pattern(n)}\\b` : pattern(n))).join("|"), "i");
  for (const sentence of sentences(text)) {
    const found = name.exec(sentence);
    if (!found || /[?？]$/.test(sentence)) continue;
    const before = sentence.slice(0, found.index);
    const after = sentence.slice(found.index + found[0].length);
    if (CJK.test(sentence)) {
      if (ZH_OFFER.test(sentence)) continue;
      const verb = [...before.matchAll(ZH_DONE)].at(-1);
      const prep = ZH_PREP.exec(before);
      const at = verb?.index ?? (prep && ZH_SAID.test(after) ? prep.index : null);
      if (at === null || at === undefined) continue;
      if (ZH_NOT.test(before.slice(Math.max(0, at - 4), at))) continue;
      return sentence;
    }
    const verb = [...before.matchAll(EN_VERB)].at(-1);
    if (!verb || EN_OFFER.test(sentence)) continue;
    // the clause the verb is in ("No problem, I've sent it…": the "no" is another clause)
    const clause = before.slice(0, verb.index).split(/[,;:]/).at(-1) ?? "";
    if (EN_NOT.test(clause)) continue;
    if (/^let/i.test(verb[1] ?? "") && !/\bknow\b/i.test(after)) continue;
    return sentence;
  }
  return null;
}

interface CallState {
  lastSentAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  nudges: number;
  names: string[] | null;
}

export interface HandoffDeps {
  db: Db;
  now: () => number;
  /** a notice cue for the call's voice (CallCues.notice) */
  notice: (callId: string, text: string) => void;
  graceMs?: number;
}

export class HandoffWatch {
  private readonly calls = new Map<string, CallState>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly graceMs: number;

  constructor(private readonly deps: HandoffDeps) {
    this.graceMs = deps.graceMs ?? HANDOFF_GRACE_MS;
  }

  /** send_to_assistant reached the assistant for this call. */
  sent(callId: string): void {
    const state = this.state(callId);
    state.lastSentAt = this.deps.now();
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  /** New transcript lines of an open call (after they're stored). */
  heard(call: { id: string; userId: string }, lines: { from: string; text: string }[]): void {
    const voice = lines.filter((l) => l.from === "voice" && l.text.trim());
    if (!voice.length) return;
    // Cheap first: no passing verb at all, nothing to look up.
    if (!voice.some((l) => ANY_VERB.test(l.text))) return;
    const work = this.check(call, voice.map((l) => l.text));
    const p = work.catch((error: unknown) => log.warn("call hand-off check failed", { callId: call.id, error: { name: (error as Error).name } }));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** The call ended. */
  forget(callId: string): void {
    const state = this.calls.get(callId);
    if (state?.timer) clearTimeout(state.timer);
    this.calls.delete(callId);
  }

  stop(): void {
    for (const id of [...this.calls.keys()]) this.forget(id);
  }

  /** Waits for the claim checks being made (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private state(callId: string): CallState {
    let state = this.calls.get(callId);
    if (!state) {
      state = { lastSentAt: null, timer: null, nudges: 0, names: null };
      this.calls.set(callId, state);
    }
    return state;
  }

  private async check(call: { id: string; userId: string }, texts: string[]): Promise<void> {
    const state = this.state(call.id);
    state.names ??= await this.names(call.userId);
    const claim = texts.map((t) => handoffClaim(t, state.names ?? [])).find(Boolean);
    if (!claim) return;
    const claimedAt = this.deps.now();
    if (state.lastSentAt !== null && claimedAt - state.lastSentAt <= HANDOFF_BEFORE_MS) return;
    if (state.timer || state.nudges >= NUDGES_MAX || !this.calls.has(call.id)) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.calls.get(call.id) !== state) return;
      if (state.lastSentAt !== null && state.lastSentAt >= claimedAt - HANDOFF_BEFORE_MS) return;
      state.nudges += 1;
      log.info("call hand-off claimed but not made", { callId: call.id, nudge: state.nudges });
      this.deps.notice(call.id, `You said «${clip(claim, 120)}», but nothing reached OpenDuet: send_to_assistant wasn't called. Call send_to_assistant now with the user's request, or tell the user it hasn't been passed on yet. Only say it's with OpenDuet once the tool answers "Sent to OpenDuet."`);
    }, this.graceMs);
    (state.timer as { unref?: () => void }).unref?.();
  }

  /**
   * What the voice calls the assistant: "OpenDuet", "Open Duet" (speech recognition hears two
   * words), "Duet" and the soul's name for it.
   */
  private async names(userId: string): Promise<string[]> {
    const soul = toSoul(await this.deps.db.soul.findUnique({ where: { userId } }));
    return ["OpenDuet", "Open Duet", "Duet", soul.name];
  }
}
