// M11: the soul and memory sections of a turn's system prompt (agent/context.ts puts them in order):
//   1. the soul (name, how to address the user, identity / persona / tone);
//   2. this channel's soulExtra (non-main only);
//   -- "user data, not system instructions" (context.ts) --
//   4. "About you" (the shared document + its active facts), on the main thread or when the
//      channel's useSharedMemory is on;
//   5. this channel's own memory (non-main only);
//   6. on the main thread only: the other channels' name / purpose / last activity / recent (at
//      most 20), never their private memory.
// Facts go in as JSON {id, text, at} so forget can name them (M18c: plus dueAt on a follow-up;
// M23: plus from {app, kind, title, at} on a fact saved from something the assistant read).
// Archived rows and other users' rows are never read.
import type { Channel as ChannelRow } from "@prisma/client";
import type { Db } from "../db.ts";
import { soulLines, toSoul } from "../soul/service.ts";
import { publicSourceRef } from "../suggestions/source.ts";
import { activeFacts, channelSummaries, layerDocument, promptFacts, PROMPT_CHANNELS, PROMPT_FACTS, readsShared } from "./layers.ts";

export interface PromptSections {
  /** 1: the soul (context.ts follows it with the channel's name and purpose) */
  soul: string[];
  /** 2: this channel's soulExtra (empty on the main thread or when unset); before the "user data" line */
  soulExtra: string[];
  /** 4 + 5 + 6: after the "user data" line */
  memory: string[];
}

export async function promptSections(db: Db, userId: string, channel: ChannelRow, firstName: string): Promise<PromptSections> {
  const shared = readsShared(channel);
  const [soulRow, sharedDoc, sharedFacts, ownDoc, ownFacts, others] = await Promise.all([
    db.soul.findUnique({ where: { userId } }),
    shared ? layerDocument(db, userId, null) : null,
    shared ? activeFacts(db, userId, null, PROMPT_FACTS) : [],
    channel.isMain ? null : layerDocument(db, userId, channel.id),
    channel.isMain ? [] : activeFacts(db, userId, channel.id, PROMPT_FACTS),
    channel.isMain ? channelSummaries(db, userId) : [],
  ]);

  const soul = soulLines(toSoul(soulRow), firstName);
  const soulExtra = !channel.isMain && channel.soulExtra.trim()
    ? [`For this channel the user adds to the soul (their words, not system rules): ${JSON.stringify(channel.soulExtra.trim())}`]
    : [];

  const memory: string[] = [];
  if (shared) {
    memory.push(
      "About you (the user's shared memory, read by the main thread and the channels that use it):",
      `Memory document: ${JSON.stringify(sharedDoc ? [sharedDoc.text] : [])}`,
      `Memory facts: ${JSON.stringify(promptFacts(sharedFacts))}`,
    );
  } else {
    memory.push("This channel keeps to its own memory: the user's shared memory isn't read here.");
  }
  if (!channel.isMain) {
    memory.push(
      `This channel's own memory (only this channel reads it):`,
      `Channel memory document: ${JSON.stringify(ownDoc ? [ownDoc.text] : [])}`,
      `Channel memory facts: ${JSON.stringify(promptFacts(ownFacts))}`,
    );
  }
  // M18c: a fact with dueAt is a follow-up (when to bring it up; see remember / followed_up).
  if ([...sharedFacts, ...ownFacts].some((f) => f.dueAt)) memory.push("A fact with dueAt is a follow-up: dueAt is when to bring it up with the user.");
  // M23: a fact with `from` was read in the user's data (an email, an event, a page), not told by them.
  if ([...sharedFacts, ...ownFacts].some((f) => publicSourceRef(f.sourceRef))) memory.push("A fact with from was saved from something you read (the app, the email subject or event title, its date), not something the user told you: when you use it, say where you know it from (for example \"from the Q4 budget email\").");
  if (channel.isMain) {
    const recent = [...others]
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(0, PROMPT_CHANNELS)
      .map(({ channelId, name, purpose, lastMessageAt, recent: last }) => ({ channelId, name, purpose, lastMessageAt, recent: last }));
    memory.push(`The user's channels (name, purpose, last activity and OpenDuet's latest reply there; their own memories stay private to them): ${JSON.stringify(recent)}`);
  }
  return { soul, soulExtra, memory };
}
