// M13: the voice's four tools (contract "Tools"). Each answers a plain string for the voice model;
// a bad argument or a failure is an answer too, never an HTTP error.
import type { Call as CallRow } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import { readsShared } from "../memory/layers.ts";
import type { RunHost } from "../runs/host.ts";
import type { CallCues } from "./cues.ts";
import { clip, spoken } from "./text.ts";
import { newestReply, pendingApprovals } from "./work.ts";

export const WORDS_MAX = 4_000;
export const HANDOFF_MAX = 8_000;
export const MEMORY_HITS = 10;
export const STATUS_REPLY_MAX = 300;

export type ToolName = "send_to_assistant" | "assistant_status" | "stop_assistant" | "search_memory";

export interface ToolDeps {
  db: Db;
  runs: Pick<RunHost, "send" | "stop" | "busy">;
  cues: CallCues;
  now: () => Date;
  /** M15: a hand-off reached the assistant (the false hand-off check) */
  handedOff?: (callId: string) => void;
}

/** the newest user lines a hand-off reads (the quote is capped at WORDS_MAX characters anyway) */
export const QUOTE_LINES = 200;
const MARKER = "[The user's own words on the call: ";

/** The quote's marks can't be forged: « » in the voice's text or a line become ‹ ›. */
const unquoted = (text: string): string => text.replace(/«/g, "‹").replace(/»/g, "›");
/** Nor the marker's phrase in the voice's text: its "[" becomes "(". */
const unmarked = (text: string): string => text.replace(/\[(\s*the user['’]s own words on the call\s*:)/gi, "($1");

const SendArgs = z.object({ text: z.string().trim().min(1).max(HANDOFF_MAX) });
const SearchArgs = z.object({ query: z.string().trim().min(1).max(200) });

export class CallTools {
  constructor(private readonly deps: ToolDeps) {}

  async run(call: CallRow, name: ToolName, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "send_to_assistant": return this.send(call, args);
      case "assistant_status": return this.status(call);
      case "stop_assistant": return this.stop(call);
      case "search_memory": return this.search(call, args);
    }
  }

  /**
   * A user message with callId set (in the chat as "passed on during a call", M15; the quote of the
   * user's own words only in the agent's context): the voice's text plus the user's own words since
   * the last hand-off, then a chat turn in the call's channel.
   */
  private async send(call: CallRow, args: Record<string, unknown>): Promise<string> {
    const parsed = SendArgs.safeParse(args);
    if (!parsed.success) return "send_to_assistant needs text: what to ask OpenDuet, in full sentences.";
    const { db } = this.deps;
    // Lines are stamped strictly rising per call (service.store, under the call's lock like this
    // hand-off): everything after handedAt is new. The newest ones, back in time order.
    const lines = (await db.callLine.findMany({
      where: { callId: call.id, from: "user", ...(call.handedAt ? { createdAt: { gt: call.handedAt } } : {}) },
      orderBy: [{ at: "desc" }, { createdAt: "desc" }], take: QUOTE_LINES, select: { text: true, createdAt: true },
    })).reverse();
    const newest = lines.reduce((max, l) => Math.max(max, l.createdAt.getTime()), 0);
    const words = clip(lines.map((l) => unquoted(spoken(l.text))).filter(Boolean).join(" "), WORDS_MAX);
    const own = unmarked(unquoted(parsed.data.text));
    const text = words ? `${own}\n\n${MARKER}«${words}»]` : own;
    let runId: string | null;
    try {
      const accepted = await this.deps.runs.send({
        userId: call.userId, channelId: call.channelId, text, clientId: `call-${call.id}-${randomUUID()}`, fileIds: [], skill: null, quickReply: null,
        callId: call.id,
      });
      runId = accepted.runId;
    } catch (error) {
      if (error instanceof HttpError && error.code === "usage_limited") return "OpenDuet can't take on more right now: the usage limit is reached. Tell the user it can continue after the limit resets.";
      if (error instanceof HttpError) return "Couldn't pass that to OpenDuet right now. Ask the user to try again in a moment.";
      log.error("call hand-off failed", { callId: call.id, error: { name: (error as Error).name } });
      return "Couldn't pass that to OpenDuet right now. Ask the user to try again in a moment.";
    }
    // handedAt moves to the newest line quoted (nothing quoted: it stays, so no later line is skipped).
    await db.call.update({ where: { id: call.id }, data: { ...(newest ? { handedAt: new Date(newest) } : {}), lastActiveAt: this.deps.now() } });
    this.deps.cues.turnStarted(call.id, runId);
    this.deps.handedOff?.(call.id);
    return "Sent to OpenDuet.";
  }

  /** Is a turn running, its status, a pending approval's title, the newest reply's start. */
  private async status(call: CallRow): Promise<string> {
    const { db, runs, cues } = this.deps;
    const busy = runs.busy({ userId: call.userId, channelId: call.channelId });
    const [approvals, reply] = await Promise.all([
      pendingApprovals(db, call.userId, call.channelId, 3),
      newestReply(db, call.userId, call.channelId, STATUS_REPLY_MAX),
    ]);
    const parts: string[] = [];
    if (busy) {
      const status = cues.statusOf(call.userId, call.channelId);
      parts.push(status ? `OpenDuet is working: ${status}.` : "OpenDuet is working on it.");
    } else {
      parts.push("OpenDuet isn't working on anything right now.");
    }
    for (const a of approvals) parts.push(a.title ? `A card needs the user's approval in the chat: ${a.title}.` : "A card needs the user's approval in the chat.");
    if (reply) parts.push(`OpenDuet's latest reply: «${reply}»`);
    return parts.join(" ");
  }

  private async stop(call: CallRow): Promise<string> {
    const stopped = await this.deps.runs.stop({ userId: call.userId, channelId: call.channelId });
    return stopped > 0 ? "Stopped." : "OpenDuet wasn't working on anything.";
  }

  /** Facts this channel can read (shared when it reads "About you", plus its own), at most 10. */
  private async search(call: CallRow, args: Record<string, unknown>): Promise<string> {
    const parsed = SearchArgs.safeParse(args);
    if (!parsed.success) return "search_memory needs a query: a few words to look for.";
    const { db } = this.deps;
    const channel = await db.channel.findFirst({ where: { id: call.channelId, userId: call.userId } });
    if (!channel) return "This chat is gone.";
    const layers: (string | null)[] = [];
    if (readsShared(channel)) layers.push(null);
    if (!channel.isMain) layers.push(channel.id);
    if (!layers.length) return "Nothing in memory matches that.";
    const rows = await db.memory.findMany({
      where: { userId: call.userId, kind: "fact", archivedAt: null, OR: layers.map((channelId) => ({ channelId })) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1_000, select: { text: true },
    });
    const query = parsed.data.query.toLowerCase();
    const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
    const scored = rows.flatMap((row) => {
      const text = row.text.toLowerCase();
      let score = text.includes(query) ? terms.length + 1 : 0;
      for (const term of terms) if (text.includes(term)) score += 1;
      return score > 0 ? [{ text: row.text, score }] : [];
    });
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, MEMORY_HITS).map((h) => `- ${clip(spoken(h.text), 300)}`);
    return hits.length ? hits.join("\n") : "Nothing in memory matches that.";
  }
}
