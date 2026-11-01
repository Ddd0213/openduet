// What each proactive turn tells the model (never stored, never shown): the turn's own request
// (the submitted prompt) and the live data for it (provider instructions, read when the turn
// starts). The fixed sentences come from i18n in User.language via phrase(); the model writes the
// rest in User.language too (agent/context.ts already states the language, date and memory).
import { phrase } from "../agent/phrase.ts";
import { markUntrusted } from "../agent/untrusted.ts";
import type { Db } from "../db.ts";
import { dueFollowUps } from "../memory/layers.ts";
import { findingRefusal, followedTitles, recentFindings } from "./findings.ts";
import type { ServerReads, SortedMail } from "./reads.ts";
import type { ProactiveMode } from "./turns.ts";

const q = (value: string) => JSON.stringify(value);
const named = (text: string, name: string) => text.replaceAll("{name}", name);

// M20: describes the boundary agent/read-only.ts enforces in code; it isn't the boundary itself.
const READ_ONLY = "This turn can only read, and the server enforces it: look things up with search_app_tools, then execute_app_tools with read tools only. Never send, post, create, update or delete anything; such a call (and OpenDuet's computer, web_fetch of a page your web_search didn't return, a custom connector write) is refused without running and without an approval card. Offer it to the user instead, with the tools this turn has for that (add_up_next, propose_task / propose_tasks).";

/** The submitted prompt of each proactive turn, in English (the output language is stated separately). */
export function turnPrompt(mode: ProactiveMode, user: { firstName: string; language: string }): string {
  const lang = user.language;
  const name = user.firstName.trim() || "there";
  const write = `Write everything for the user in ${lang}.`;
  switch (mode) {
    case "brief":
      return [
        "[Scheduled morning brief. This is not a message from the user; nobody is waiting in the chat.]",
        `The server already read the user's email and sorted it (needsYou / canWait, each with a reason), read today's calendar, and listed their open tasks: all in the instructions. Use the read tools only to open one of them in full, or for a source the instructions say the server couldn't read. ${READ_ONLY}`,
        "Then post the brief in the main thread as plain text:",
        `1. One line starting exactly with ${q(named(phrase("agent.morning_greeting", lang), name))} followed by the three things that matter most today as short sentences (\"A. B. C.\").`,
        `2. A blank line, then ${q(phrase("agent.updates", lang))} and a numbered list; every item starts with a bold run-in (**Topic**) and one or two sentences.`,
        "Every needsYou email is in the brief (reword it, never drop it); canWait mail gets at most one short line with how many there are. A source the instructions say wasn't read is never \"nothing new\": leave it out, and don't write that you couldn't check it either (the server adds that line under the brief).",
        "Where a first step is clear (for example a reply that should be drafted), call start_first_step for it (at most 3): it starts a background task; mention it in the brief with its link [title](duet://tasks/<id>).",
        "If there is nothing at all to brief on (no mail, no events, no open tasks) and every source was read or isn't connected, call skip_brief and write nothing. When a source couldn't be read, post a short brief instead.",
        "If ask_weekends is offered, call it once at the very end, after the brief.",
        write,
      ].join("\n");
    case "checkin":
      // M18c: a priority order (follow-ups, today's things, mail and events, then at most one
      // finding a day, rarely a light pick-up line); silent unless one of them really needs the user.
      return [
        "[Scheduled check-in. This is not a message from the user; nobody is waiting in the chat.]",
        `Look at what changed since the last check-in (time in the instructions): new email (the server already read and sorted it: see the instructions), upcoming events, the open tasks. ${READ_ONLY} web_search is fine, and web_fetch for a page it returned.`,
        "Stay silent by default: text you write in this turn is NOT shown to the user. Act only when something really needs them, in this order:",
        "1. A follow-up that's due (listed in the instructions): bring it up like a friend who remembers (ask how it went, or remind them) with post_message, then call followed_up with its id.",
        "2. Today's things that need them: tasks waiting on them, approvals, scheduled-task results, finished work to look at.",
        "3. New email and upcoming events: only needsYou email, never one the server put under canWait.",
        "4. Only when nothing above needs them, and at most once a day: look up something they follow (listed in the instructions) on the web, and if there's real news, share_finding.",
        "5. Rarely, when yesterday's chat left something open: one light line that picks it up or offers a small help (post_message). Never an empty \"how are you\".",
        "Otherwise call finish_checkin with nothingNeeded true. Never post just to say all is well.",
        "Tools for acting:",
        "- post_message: a short message in the main thread;",
        "- add_up_next: an item for the Up next list (work you could take on that isn't urgent);",
        "- propose_task: one task card you could start right away.",
        "If ask_weekends is offered, you may call it once at the end.",
        write,
      ].join("\n");
    case "upnext_scan":
      return [
        "[Up next scan: the user tapped \"Show me\" in Tasks > Up next. They are not in the chat.]",
        `Check the user's connected apps for work you could take off their plate (unanswered email, upcoming meetings that need prep, documents waiting on them). ${READ_ONLY}`,
        "Add 3 to 5 concrete items with add_up_next: a short title, a body saying why it matters, the prompt a task would start with, and the app's display name.",
        "Don't write in the chat; text you write here is not shown. Skip anything already in Up next (listed in the instructions). If no apps are connected or nothing turns up, stop without adding anything.",
        write,
      ].join("\n");
    case "first_day":
      return [
        "[First-day scan, right after onboarding. The user just read OpenDuet's welcome and is waiting in the main thread.]",
        `Get to know them, in this order: call check_memory; then search their Gmail (who they are, who they work with, what's going on); then their Google Calendar and recent Google Drive files, when connected. ${READ_ONLY}`,
        "Then write, as plain text in the main thread:",
        "1. A short profile read of the user (role, what they're working on, the people around them), warm and specific.",
        `2. ${q(phrase("agent.how_ill_help", lang))} followed by exactly 3 bullets.`,
        `3. Call confirm_profile (it posts ${q(phrase("agent.sound_off", lang))} with the quick replies ${q(phrase("agent.sounds_right", lang))} / ${q(phrase("agent.something_off", lang))}).`,
        `4. ${q(phrase("agent.on_your_plate", lang))} followed by a short list of what's on their plate.`,
        `5. Call propose_tasks with exactly 3 tasks you could start (leave lead out: the card reads ${q(phrase("agent.places_to_start", lang))}).`,
        "Use only what you actually found; never invent people, mail or meetings. If a tool fails or an app isn't connected, work with what you have.",
        write,
      ].join("\n");
  }
}

const OPEN = ["working", "needs_input", "ready_for_review", "scheduled"];

async function openTasks(db: Db, userId: string): Promise<string> {
  const rows = await db.task.findMany({
    where: { userId, archivedAt: null, status: { in: OPEN } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20,
    select: { id: true, title: true, status: true, updatedAt: true, channel: { select: { name: true, isMain: true } } },
  });
  return JSON.stringify(rows.map((t) => ({ id: t.id, title: t.title, status: t.status, channel: t.channel.isMain ? "main" : t.channel.name, updatedAt: t.updatedAt.toISOString() })));
}

async function upNextTitles(db: Db, userId: string): Promise<string> {
  const rows = await db.suggestion.findMany({ where: { userId, status: "open" }, orderBy: { createdAt: "desc" }, take: 30, select: { title: true } });
  return JSON.stringify(rows.map((r) => r.title));
}

const mailEntry = (m: SortedMail, snippet: boolean) => ({
  id: m.mail.id, from: m.mail.from, subject: m.mail.subject, ...(m.mail.date ? { at: m.mail.date } : {}),
  reason: m.result.reason, decidedBy: m.result.decidedBy, ...(snippet ? { snippet: [...m.mail.body.replace(/\s+/g, " ").trim()].slice(0, 240).join("") } : {}),
});

/**
 * M23: what the server read and sorted (reads.ts), for the brief and check-ins. The sorted mail is
 * outside content (senders, subjects, and reasons a model wrote after reading it), so it goes in the
 * untrusted envelope; the lines around it are ours.
 */
export function readsLines(reads: ServerReads | null | undefined): string[] {
  if (reads === undefined) return [];
  if (reads === null) return ["The server couldn't read the user's apps for this turn: read their email (and, for the brief, today's calendar) yourself with the read tools."];
  const lines: string[] = [];
  const brief = reads.mode === "brief";
  const unread = (app: string) => reads.unchecked.find((u) => u.app === app);
  if (reads.mail) {
    const needs = reads.mail.filter((m) => m.result.verdict === "needs_you");
    const later = reads.mail.filter((m) => m.result.verdict === "can_wait");
    const data = { needsYou: needs.map((m) => mailEntry(m, true)), canWait: { count: later.length, examples: later.slice(0, 15).map((m) => ({ from: m.mail.from, subject: m.mail.subject })) } };
    lines.push(
      `Mail triage, computed by the server for mail since ${reads.since} (${reads.mail.length} read). needsYou: what may need the user, each with why (decidedBy "unsorted" = the server couldn't sort it, so it is there to be safe: look at it before you bring it up). canWait: mail that needs nothing from them. ${brief ? "The brief keeps every needsYou email." : "Only needsYou mail may be worth a post_message, an Up next item or a task card; never post about canWait mail."} Naming one as a source (add_up_next, propose_task): kind \"email\" with its id.`,
      markUntrusted(JSON.stringify(data), "Gmail"),
    );
    if (reads.mailCapped) lines.push(`Only the newest ${reads.mailCapped.read} of about ${reads.mailCapped.about} emails since then were read and sorted; ${brief ? "say in the brief that older ones weren't checked." : "older ones weren't checked."}`);
  } else {
    const why = unread(reads.apps.mail)?.reason;
    lines.push(`${reads.apps.mail} wasn't read for this ${brief ? "brief" : "check-in"} (${why === "expired" ? "its connection expired" : why === "read_failed" ? "the read failed" : "not connected"}). Never say there's no new mail.`);
  }
  if (brief) {
    if (reads.events) {
      lines.push(`Today's calendar, read by the server (${reads.events.length} events; naming one as a source: kind "event" with its id):`, markUntrusted(JSON.stringify(reads.events), reads.apps.calendar));
    } else {
      const why = unread(reads.apps.calendar)?.reason;
      lines.push(`${reads.apps.calendar} wasn't read for this brief (${why === "expired" ? "its connection expired" : why === "read_failed" ? "the read failed" : "not connected"}). Never say the calendar is empty.`);
    }
  }
  return lines;
}

/** Live data for the turn (user data, not instructions). M23: `reads`, what the server read for it. */
export async function turnInstructions(db: Db, mode: ProactiveMode, userId: string, runId: string, now: Date = new Date(), reads?: ServerReads | null): Promise<string[]> {
  const lines: string[] = [];
  if (mode === "brief" || mode === "checkin") lines.push(`Open tasks (user data, newest first; link one as [title](duet://tasks/<id>)): ${await openTasks(db, userId)}`);
  if (mode === "brief" || mode === "checkin") lines.push(...readsLines(reads));
  if (mode === "checkin") {
    const last = await db.run.findFirst({
      where: { userId, kind: "checkin", id: { not: runId }, status: { in: ["completed", "resolved"] } },
      orderBy: { createdAt: "desc" }, select: { startedAt: true, createdAt: true },
    });
    lines.push(`Last check-in: ${last ? (last.startedAt ?? last.createdAt).toISOString() : "none yet"}.`);
    // M18c: what a finding may be about, what was already shared, and the follow-ups due now.
    const [follows, shared, due, refusal] = await Promise.all([
      followedTitles(db, userId, now), recentFindings(db, userId), dueFollowUps(db, userId, now, [null]), findingRefusal(db, userId, runId, now),
    ]);
    lines.push(
      `What the user follows (user data; their tasks and scheduled tasks, newest first): ${JSON.stringify(follows)}. Their About-you facts in the memory section count too.`,
      `Findings you shared recently (don't repeat them): ${JSON.stringify(shared)}`,
      `Follow-ups due now (user data; About-you facts with dueAt; after bringing one up, call followed_up with its id): ${JSON.stringify(due)}`,
    );
    if (refusal) lines.push(`No share_finding in this check-in: ${refusal}`);
  }
  if (mode === "checkin" || mode === "upnext_scan") lines.push(`Already in Up next (user data): ${await upNextTitles(db, userId)}`);
  return lines;
}
