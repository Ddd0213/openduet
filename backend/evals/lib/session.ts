// One conversation in the eval world: a fresh channel (or the main thread), the user's messages
// and quick-reply taps sent the way POST /api/channels/:id/messages sends them (RunHost.send), a
// check-in run the way "Run now" does, and each turn recorded as a TurnRecord: what the runtime
// streamed (text and tool calls), the rows that reached the thread, and what the fakes saw.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@prisma/client";
import type { ShownMessage, TurnRecord } from "../score/types.ts";
import { emptyTurn, quickRepliesOf } from "../score/types.ts";
import type { EvalEnv } from "./env.ts";
import type { Lang } from "./fixtures.ts";

/** A turn longer than this is stopped and recorded as "timeout". */
export const TURN_TIMEOUT_MS = 5 * 60_000;

export const CHANNEL_NAME: Record<Lang, string> = { en: "Chat", "zh-Hans": "聊天" };

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const shownOf = (row: Message): ShownMessage => ({ id: row.id, role: row.role as "assistant" | "system", kind: row.kind, text: row.text, payload: parsePayload(row.payload) });

/** The run's error phrase key (Run.error is JSON {key, params}). */
function errorKey(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { key?: unknown };
    return typeof value.key === "string" ? value.key : raw.slice(0, 120);
  } catch {
    return raw.slice(0, 120);
  }
}

/** What a turn produced in one channel, read back once the run host is idle. */
interface Mark { channelId: string; since: Date; calls: number; apps: number; web: number; computer: number; t0: number }

export class Session {
  private constructor(readonly env: EvalEnv, readonly channelId: string) {}

  /** A new channel ("Chat" / "聊天") on the eval's model, like one the user just made (no greeting). */
  static async fresh(env: EvalEnv, lang: Lang): Promise<Session> {
    await env.setLanguage(lang);
    const row = await env.db.channel.create({ data: { userId: env.user.id, isMain: false, name: CHANNEL_NAME[lang], modelId: env.model.id } });
    return new Session(env, row.id);
  }

  /** The main thread (soul setup and check-ins happen there; it runs on the user's default model). */
  static async main(env: EvalEnv, lang: Lang): Promise<Session> {
    await env.setLanguage(lang);
    return new Session(env, env.mainChannelId);
  }

  private mark(): Mark {
    const { env } = this;
    env.meter.beginTurn();
    return { channelId: this.channelId, since: new Date(), calls: env.meter.calls, apps: env.composio.calls.length, web: env.web.calls.length, computer: env.computer.calls.length, t0: Date.now() };
  }

  /** Waits until every queued run (the turn, a build it started, its follow-ups) has finished. */
  private async settle(): Promise<boolean> {
    const { env } = this;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      env.runs.idle().then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), TURN_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      await env.runs.cancel({ userId: env.user.id, channelId: this.channelId });
      await env.runs.idle();
    }
    return !timedOut;
  }

  private async record(mark: Mark, runId: string | null, kind: string, userText: string, finished: boolean): Promise<TurnRecord> {
    const { env } = this;
    const run = runId ? await env.db.run.findUnique({ where: { id: runId } }) : null;
    const rows = await env.db.message.findMany({
      where: { userId: env.user.id, channelId: mark.channelId, taskId: null, role: { in: ["assistant", "system"] }, createdAt: { gte: mark.since } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const status = !finished ? "timeout" : !run ? "failed" : run.status === "resolved" ? "completed" : run.status;
    return {
      runId, kind, userText, status, error: errorKey(run?.error ?? null),
      timeline: runId ? (env.agent.log(runId)?.timeline ?? []) : [],
      shown: rows.map(shownOf),
      modelCalls: env.meter.calls - mark.calls,
      ms: Date.now() - mark.t0,
      apps: env.composio.calls.slice(mark.apps),
      web: env.web.calls.slice(mark.web),
      computer: env.computer.calls.slice(mark.computer),
    };
  }

  private async sendWith(text: string, quickReply: { messageId: string; option: string } | null): Promise<TurnRecord> {
    const { env } = this;
    const mark = this.mark();
    let runId: string | null = null;
    try {
      const accepted = await env.runs.send({
        userId: env.user.id, channelId: this.channelId, text, clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply,
      });
      runId = accepted.runId;
    } catch (error) {
      const turn = await this.record(mark, null, "chat", text, true);
      return { ...turn, status: "failed", error: `not sent: ${(error as Error).message}` };
    }
    const finished = await this.settle();
    return this.record(mark, runId, "chat", text, finished);
  }

  /** The user types a message. */
  say(text: string): Promise<TurnRecord> {
    return this.sendWith(text, null);
  }

  /**
   * The user taps a chip of the newest open quick-reply card in `turn` (`option`: its text, or
   * "#1" / "#2" ... for the nth option, "#last" for the last). Null when that turn has no such card.
   */
  async tap(turn: TurnRecord, option: string): Promise<TurnRecord | null> {
    const card = [...turn.shown].reverse().find((m) => m.kind === "quick_replies" && m.role === "assistant");
    return card ? this.tapCard(card, option) : null;
  }

  /** The user taps `option` (as in tap()) on this quick-reply card. Null when it has no such option. */
  async tapCard(card: ShownMessage, option: string): Promise<TurnRecord | null> {
    const options = quickRepliesOf(emptyTurn({ shown: [card] }))[0]?.options ?? [];
    const pick = option === "#last" ? options.at(-1) : /^#\d+$/.test(option) ? options[Number(option.slice(1)) - 1] : options.find((o) => o.trim() === option.trim());
    if (!pick) return null;
    return this.sendWith(pick, { messageId: card.id, option: pick });
  }

  /** A stored message of this thread as the scorers see it. */
  async shown(messageId: string): Promise<ShownMessage> {
    return shownOf(await this.env.db.message.findUniqueOrThrow({ where: { id: messageId } }));
  }

  /** A check-in turn now, like "Run now" (POST /api/schedule/run): main thread, no user message. */
  async checkin(): Promise<TurnRecord> {
    const { env } = this;
    const mark = { ...this.mark(), channelId: env.mainChannelId };
    let runId: string | null = null;
    try {
      runId = (await env.proactive.service.runNow(env.user.id, "checkin")).id;
    } catch (error) {
      const turn = await this.record(mark, null, "checkin", "", true);
      return { ...turn, status: "failed", error: `not started: ${(error as Error).message}` };
    }
    const finished = await this.settle();
    return this.record(mark, runId, "checkin", "", finished);
  }
}

/**
 * Whether production offers a tool yet (some suites wait for a later milestone): a source file under
 * src/ declares it as a tool name ("name": or a schema key). Read-only, no model.
 */
export function toolExists(name: string, srcDir = join(import.meta.dir, "../../src")): boolean {
  const pattern = new RegExp(`(?:^|[\\s{,])${name}\\s*:\\s*z\\.|["']${name}["']`, "m");
  const walk = (dir: string): boolean => readdirSync(dir).some((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") && pattern.test(readFileSync(path, "utf8"));
  });
  return walk(srcDir);
}
