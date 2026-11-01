// Setting up who OpenDuet is in the chat (M22). The thread is put where a new user's first day leaves
// it: a first-day scan Run, OpenDuet's profile read and the fixed "Sounds right / Something's off"
// line (no model for that part). Then the user taps "Sounds right" and answers each round from the
// case's script ("#1" taps the first chip, "#last" the last, anything else is typed). OpenDuet should
// ask one question per turn with its chips after it, at most 3 rounds, then post a soul_setup card.
import { z } from "zod";
import { phrase } from "../../src/agent/phrase.ts";
import { scoreSoul, MAX_ROUNDS, type SoulRow } from "../score/soul.ts";
import { quickRepliesOf, replyOf, type TurnRecord } from "../score/types.ts";
import type { EvalEnv } from "../lib/env.ts";
import type { Lang } from "../lib/fixtures.ts";
import { table } from "../lib/output.ts";
import { Session, toolExists } from "../lib/session.ts";
import { eachCase, loadCases, mark, problemLines, transcript, useFixtures, type Suite } from "../lib/suite.ts";

export const Case = z.object({
  id: z.string(),
  lang: z.enum(["en", "zh-Hans"]),
  profile: z.string().min(1),
  bullets: z.array(z.string().min(1)).length(3),
  answers: z.array(z.string().min(1)).min(1).max(MAX_ROUNDS + 1),
}).strict();
type Case = z.infer<typeof Case>;

/** "Use the default" in every language: a quick-reply card ending with it is a setup question. */
const DEFAULTS = [phrase("soul.setup_default", "en"), phrase("soul.setup_default", "zh-Hans")];

/** The first day as onboarding leaves it, up to the "Sounds right" chips. Returns that card's id. */
async function firstDay(env: EvalEnv, c: Case, index: number): Promise<string> {
  const { db } = env;
  const userId = env.user.id;
  const channelId = env.mainChannelId;
  // A distinct onboardedAt per case: Run (userId, kind, scheduledFor) is unique.
  const onboardedAt = new Date(Date.now() - 120_000 - index * 1000);
  await db.user.update({ where: { id: userId }, data: { soulIntroAt: null, onboardedAt } });
  await db.run.create({ data: { userId, kind: "scan", status: "completed", channelId, scheduledFor: onboardedAt, startedAt: onboardedAt, finishedAt: new Date(onboardedAt.getTime() + 60_000) } });
  const at = (s: number) => new Date(onboardedAt.getTime() + s * 1000);
  const lang: Lang = c.lang;
  await db.message.create({ data: { userId, channelId, role: "assistant", kind: "text", text: c.profile, createdAt: at(30) } });
  await db.message.create({ data: { userId, channelId, role: "assistant", kind: "text", text: `${phrase("agent.how_ill_help", lang)}\n${c.bullets.map((b) => `- ${b}`).join("\n")}`, createdAt: at(31) } });
  const card = await db.message.create({ data: {
    userId, channelId, role: "assistant", kind: "quick_replies", text: phrase("agent.sound_off", lang), createdAt: at(32),
    payload: JSON.stringify({ options: [phrase("agent.sounds_right", lang), phrase("agent.something_off", lang)], chosen: null }),
  } });
  return card.id;
}

export const soul: Suite = {
  id: "soul",
  calls: "2 cases × 4-5 turns × 1-3 calls ≈ 10-25",
  skip: async () => (toolExists("propose_soul_setup") ? null : "propose_soul_setup isn't in src/ yet (M22 chat setup)"),
  async run(env, opts) {
    const cases = loadCases<Case>("soul", Case, opts);
    let index = 0;
    const runs = await eachCase<Case, SoulRow>(env, "soul", cases, opts, async (c) => {
      useFixtures(env);
      const session = await Session.main(env, c.lang);
      const cardId = await firstDay(env, c, index++);
      const turns: TurnRecord[] = [];
      const first = await session.tapCard(await session.shown(cardId), phrase("agent.sounds_right", c.lang));
      if (first) turns.push(first);
      // One scripted answer per round; one extra turn when the card hasn't come after the last answer.
      for (const answer of [...c.answers, "#last"]) {
        const last = turns.at(-1);
        if (!last || last.status !== "completed") break;
        if (last.shown.some((m) => m.kind === "soul_setup")) break;
        if (env.meter.exhausted) break;
        const card = quickRepliesOf(last).length > 0;
        const tapped = card && answer.startsWith("#") ? await session.tap(last, answer) : null;
        turns.push(tapped ?? (await session.say(answer.startsWith("#") ? fallback(c.lang) : answer)));
      }
      return { row: scoreSoul({ id: c.id, lang: c.lang, firstReply: phrase("agent.sounds_right", c.lang), answers: c.answers }, turns, DEFAULTS), turns };
    });
    const failed = runs.filter((r) => !r.row.pass);
    const pass = runs.length > 0 && failed.length === 0;
    const markdown = [
      "## Summary",
      "",
      `- cases that asked one question per turn, chips after it, ≤ ${MAX_ROUNDS} rounds, then a soul_setup card: ${runs.length - failed.length}/${runs.length}`,
      `- suite: ${pass ? "PASS" : "FAIL"}`,
      "",
      "## Cases",
      "",
      table(["case", "rounds", "card", "problems", "result"], runs.map((r) => [`${r.case.id}${opts.repeat > 1 ? ` #${r.repeat}` : ""}`, r.row.rounds, mark(r.row.card), r.row.problems.join("; "), mark(r.row.pass)])),
      "",
      "## Turns",
      "",
      table(["case", "turn", "user", "questions", "chips", "chips after question", "reply"], runs.flatMap((r) => r.turns.map((t, i) => [
        r.case.id, i + 1, t.userText, r.row.turns[i]?.questions ?? "", (r.row.turns[i]?.chips ?? []).join(" / "), mark(r.row.turns[i]?.chipsAfterQuestion ?? null), replyOf(t),
      ]))),
      ...problemLines(runs),
    ].join("\n");
    return {
      json: { rows: runs.map((r) => ({ ...r.row, repeat: r.repeat, turns: transcript(r.turns), scored: r.row.turns })) },
      markdown,
      summary: `soul: ${runs.length - failed.length}/${runs.length} set up in ≤ ${MAX_ROUNDS} rounds with a card → ${pass ? "PASS" : "FAIL"}`,
      pass,
    };
  },
};

/** Typed when the script says "tap" but the turn has no chips: what a user would type instead. */
const fallback = (lang: Lang) => (lang === "zh-Hans" ? "就按你说的来吧。" : "Whatever you think is best.");
