// M13: the voice model's instructions (contract "Instructions"): its relay role, the language
// rule, approvals, the tools, then the background (each section capped,
// <= 12000 characters in all; the recent messages newest first into what's left, so an overflow
// drops the oldest) and, on a resume, "This call so far" (newest lines, <= 3000).
// Model-facing English; the voice answers in the user's language.
import type { Channel as ChannelRow, User } from "@prisma/client";
import type { Db } from "../db.ts";
import { activeFacts, layerDocument, readsShared } from "../memory/layers.ts";
import { toSoul } from "../soul/service.ts";
import { clip, spoken } from "./text.ts";

export const BACKGROUND_MAX = 12_000;
export const CALL_SO_FAR_MAX = 3_000;
export const RECENT_MESSAGES = 20;
const CAP = { now: 200, soul: 600, aboutYou: 3_000, channel: 3_000, work: 1_500, recent: 4_000 } as const;
const MESSAGE_MAX = 300;
const FACTS = 40;

export interface WorkState {
  /** a turn of this channel's chat is running or queued, and what it's doing (a few words) */
  running: boolean;
  status: string | null;
  approvals: { title: string | null }[];
  tasks: { title: string; status: string }[];
}

export interface InstructionsInput {
  user: Pick<User, "id" | "firstName" | "timezone" | "language">;
  channel: ChannelRow;
  /** the phone's language (before the user has spoken), else User.language */
  language: string | undefined;
  work: WorkState;
  /** a resume: the call's lines so far (oldest first) */
  soFar: { from: string; text: string }[] | null;
  now: Date;
}

const ROLE = [
  "You are OpenDuet's voice on a live voice call. Your role is to relay the user's requests and report replies and progress; OpenDuet does the actual work in the chat.",
  "- When the user asks for something to be done, looked up, written, changed or remembered, pass it on with send_to_assistant. Only once it answers \"Sent to OpenDuet.\" say briefly that it has the request. Never say you passed something on without calling send_to_assistant; if it fails, tell the user it didn't go through.",
  "- When OpenDuet's reply or progress reaches you (a message starting with [OpenDuet replied] or [Progress]), relay it briefly and naturally. A [Notice] is from OpenDuet itself: act on it.",
  "- When a request is missing something OpenDuet needs (who, what, when), ask the user for it before passing it on.",
  "- Speak of OpenDuet in the third person ('OpenDuet is checking', 'OpenDuet says'). Never claim you did, saw, sent or found anything yourself.",
  "- Use assistant_status when the user asks how it's going, stop_assistant when they want it to stop, search_memory to look up what it remembers.",
  "- Keep answers short: this is a spoken conversation.",
].join("\n");

const APPROVALS = "Approvals: you can never approve, confirm or decline anything for the user, and a spoken yes never approves anything. When a card waits for approval, say once that there's a card to approve in the chat; the user taps it there.";

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function nowLine(now: Date, timezone: string): string {
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(now);
  } catch {
    local = now.toISOString();
  }
  return `Now: ${local} (${timezone}).`;
}

const section = (title: string, lines: string[], cap: number): string => (lines.length ? clip(`${title}\n${lines.join("\n")}`, cap) : "");

const RECENT_TITLE = "The latest messages in this chat (oldest first):";

/** The newest messages that fit in `budget` characters (rows newest first), shown oldest first. */
function recentSection(rows: { role: string; text: string }[], budget: number): string {
  const kept: string[] = [];
  let size = [...RECENT_TITLE].length;
  for (const m of rows) {
    const line = `${m.role === "user" ? "User" : "OpenDuet"}: ${clip(spoken(m.text), MESSAGE_MAX)}`;
    const length = [...line].length + 1;
    if (size + length > budget) break;
    kept.push(line);
    size += length;
  }
  return kept.length ? `${RECENT_TITLE}\n${kept.reverse().join("\n")}` : "";
}

/** The background sections (memory, the channel, current work, recent messages) read from the database. */
export async function buildInstructions(db: Db, input: InstructionsInput): Promise<string> {
  const { user, channel, work } = input;
  const shared = readsShared(channel);
  const [soulRow, sharedDoc, sharedFacts, ownDoc, ownFacts, recentRows] = await Promise.all([
    db.soul.findUnique({ where: { userId: user.id } }),
    shared ? layerDocument(db, user.id, null) : null,
    shared ? activeFacts(db, user.id, null, FACTS) : [],
    channel.isMain ? null : layerDocument(db, user.id, channel.id),
    channel.isMain ? [] : activeFacts(db, user.id, channel.id, FACTS),
    db.message.findMany({
      where: { userId: user.id, channelId: channel.id, taskId: null, role: { in: ["user", "assistant"] }, kind: "text", text: { not: "" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: RECENT_MESSAGES, select: { role: true, text: true },
    }),
  ]);
  const soul = toSoul(soulRow);
  const language = input.language?.trim() || user.language;

  const parts: string[] = [
    ROLE,
    `Language: always answer in the language the user is speaking right now. Before the user has said anything, speak ${languageName(language)} (${language}).`,
    APPROVALS,
  ];

  const memoryLines = (doc: { text: string } | null, facts: { text: string }[]) => [
    ...(doc?.text.trim() ? [clip(spoken(doc.text), 1_500)] : []),
    ...facts.map((f) => `- ${clip(spoken(f.text), 300)}`),
  ];
  const background = [
    section("Background:", [nowLine(input.now, user.timezone)], CAP.now),
    section("Who's who:", [
      `The assistant's name: ${JSON.stringify(soul.name.trim() || "OpenDuet")}. Refer to it by that name.`,
      `Address the user as: ${JSON.stringify(soul.addressAs.trim() || user.firstName)}.`,
    ], CAP.soul),
    shared ? section("About you (what OpenDuet knows about the user):", memoryLines(sharedDoc, sharedFacts), CAP.aboutYou) : "",
    section("This chat:", [
      channel.isMain ? "The user's main thread with OpenDuet." : `The channel ${JSON.stringify(channel.name)}.`,
      ...(channel.purpose.trim() ? [`Purpose: ${clip(spoken(channel.purpose), 500)}`] : []),
      ...(!channel.isMain ? memoryLines(ownDoc, ownFacts).map((l, i) => (i === 0 ? `Its memory: ${l}` : l)) : []),
    ], CAP.channel),
    section("Current work:", [
      work.running ? `OpenDuet is working on a reply right now${work.status ? ` (${work.status})` : ""}.` : "OpenDuet isn't working on anything in this chat right now.",
      ...work.approvals.map((a) => `A card waits for the user's approval in the chat${a.title ? `: ${a.title}` : ""}.`),
      ...work.tasks.map((t) => `Task ${JSON.stringify(t.title)}: ${t.status === "needs_input" ? "needs the user's input" : "OpenDuet is working on it"}.`),
    ], CAP.work),
  ].filter(Boolean);
  // The recent messages get what's left of the 12000 (at most their own cap): filled newest first,
  // so an overflow drops the oldest messages, never the newest.
  const used = background.reduce((n, s) => n + [...s].length + 2, 0);
  const recent = recentSection(recentRows, Math.min(CAP.recent, BACKGROUND_MAX - used));
  if (recent) background.push(recent);
  parts.push(clip(background.join("\n\n"), BACKGROUND_MAX));

  if (input.soFar?.length) {
    const kept: string[] = [];
    let size = 0;
    for (const line of [...input.soFar].reverse()) {
      const text = `${line.from === "user" ? "User" : "You"}: ${spoken(line.text)}`;
      if (size + text.length + 1 > CALL_SO_FAR_MAX) break;
      kept.unshift(text);
      size += text.length + 1;
    }
    if (kept.length) parts.push(`This call so far (the connection dropped and is back; carry on from here, don't start over):\n${kept.join("\n")}`);
  }
  return parts.join("\n\n");
}
