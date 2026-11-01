// M13: the call service (contract "The call"): start / resume with a fresh credential and the
// voice's instructions, the transcript (deduped per line id), the tools, the end (title from the
// utility model, the call's one line in the chat; idempotent), the detail, the voice settings and
// the 2 h sweep. The StepFun key only ever leaves through start()'s answer to its owner.
import type { Call as CallRow, User } from "@prisma/client";
import type { z } from "zod";
import { Call, type CallLine, type CallDetail, type StartCallRequest, type StartCallResponse, type UpdateVoiceSettingsRequest, type VoiceSettings } from "../contract/m13.ts";
import type { Message } from "../contract/messages.ts";
import { defaultProviderRegion, REGIONS_OF, voiceEndpointsOf, type ProviderRegion } from "../contract/m27voice.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import type { Fetch, ModelResolver } from "../llm/index.ts";
import { log } from "../log.ts";
import { VOICE_PROVIDER_KINDS, type RealtimeModel, type RealtimeModels } from "../models/realtime.ts";
import type { RunHost } from "../runs/host.ts";
import { loadMessage, toMessages } from "../runs/serialize.ts";
import { KeyedLock } from "../tasks/lock.ts";
import { credentialFor } from "./credentials.ts";
import { dictationOf, dictationUpdate } from "./dictation.ts";
import type { CallCues } from "./cues.ts";
import { HandoffWatch } from "./handoff.ts";
import { buildInstructions } from "./instructions.ts";
import { chatTitle, titleFor } from "./title.ts";
import { CallTools, type ToolName } from "./tools.ts";
import { defaultVoice, isVoiceOf, anyEngineHas, voiceLists, VOICE_TOOLS, type Engine } from "./voices.ts";
import { openTasks, pendingApprovals } from "./work.ts";

export const SWEEP_IDLE_MS = 2 * 60 * 60_000;
/** stored lines per call; the phone's lines beyond it are ignored (still 204, a count in the log) */
export const LINES_MAX = 5_000;
/** the newest lines read for "This call so far" (<= 3000 characters) and the title (<= 6000) */
const SO_FAR_LINES = 200;
const TITLE_LINES = 200;

type Line = z.infer<typeof CallLine>;

export interface CallServiceDeps {
  db: Db;
  events: EventBus;
  runs: Pick<RunHost, "send" | "stop" | "busy" | "releaseCall">;
  realtime: RealtimeModels;
  /** the utility model for the title (M12 resolver); null: always the fallback title */
  resolver: ModelResolver | null;
  cues: CallCues;
  fetch: Fetch;
  now: () => Date;
  sweepIdleMs?: number;
  /** M15: how long after a claimed hand-off send_to_assistant may still come (tests) */
  handoffGraceMs?: number;
}

const notFound = () => new HttpError(404, "not_found", "Not found.");
const ended = () => new HttpError(409, "conflict", "The call has ended.");

export class CallService {
  readonly tools: CallTools;
  /** M15: the voice said it passed something to the assistant; did send_to_assistant follow? */
  readonly handoffs: HandoffWatch;
  private readonly lock = new KeyedLock();

  constructor(private readonly deps: CallServiceDeps) {
    this.handoffs = new HandoffWatch({
      db: deps.db, now: () => deps.now().getTime(), notice: (callId, text) => deps.cues.notice(callId, text),
      ...(deps.handoffGraceMs !== undefined ? { graceMs: deps.handoffGraceMs } : {}),
    });
    this.tools = new CallTools({ db: deps.db, runs: deps.runs, cues: deps.cues, now: deps.now, handedOff: (id) => this.handoffs.sent(id) });
  }

  // ---------------------------------------------------------------- voice settings

  async settings(userId: string): Promise<z.infer<typeof VoiceSettings>> {
    const { db, realtime } = this.deps;
    const providers = await realtime.providers(userId);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const current = user.voiceModelId ? await realtime.realtimeEntry(userId, user.voiceModelId) : null;
    return {
      modelId: current ? current.entry.id : null, voice: user.voiceName, voices: voiceLists(), configured: await realtime.configured(userId),
      providers, dictation: dictationOf(user, providers),
      presets: VOICE_PROVIDER_KINDS.map((kind) => ({ kind, defaultRegion: defaultProviderRegion(kind, user.region),
        regions: (REGIONS_OF[kind] ?? []).map((region) => ({ region, host: new URL(voiceEndpointsOf(kind, region)!.chatBaseUrl).host })),
      })),
    };
  }

  /** modelId: a realtime entry of a gemini / stepfun provider (400 modelId); voice: one of its engine's (400 voice). */
  async updateSettings(userId: string, input: z.infer<typeof UpdateVoiceSettingsRequest>): Promise<z.infer<typeof VoiceSettings>> {
    const { db, realtime } = this.deps;
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    let modelId = user.voiceModelId;
    let engine: Engine | null = null;
    let region: ProviderRegion | null = null;
    if (input.modelId !== undefined) {
      if (input.modelId === null) modelId = null;
      else {
        const found = await realtime.realtimeEntry(userId, input.modelId);
        if (!found) throw new HttpError(400, "validation_failed", "modelId: not a realtime model of a Gemini or StepFun provider", "modelId");
        modelId = found.entry.id;
        engine = found.engine;
        region = found.provider.region === "intl" ? "intl" : null;
      }
    } else if (modelId) {
      const found = await realtime.realtimeEntry(userId, modelId);
      engine = found?.engine ?? null;
      region = found?.provider.region === "intl" ? "intl" : null;
    }
    let voice = user.voiceName;
    if (input.voice !== undefined) {
      if (input.voice !== null && !(engine ? isVoiceOf(engine, input.voice, region) : anyEngineHas(input.voice))) {
        throw new HttpError(400, "validation_failed", "voice: not a voice of this model's engine", "voice");
      }
      voice = input.voice;
    } else if (input.modelId !== undefined && voice && engine && !isVoiceOf(engine, voice, region)) {
      // a model of the other engine: its voices differ, so the old one is dropped
      voice = null;
    }
    const dictation = input.dictation ? await dictationUpdate(db, user, input.dictation) : {};
    await db.user.update({ where: { id: userId }, data: {
      ...(input.modelId !== undefined ? { voiceModelId: modelId } : {}),
      ...(input.voice !== undefined || voice !== user.voiceName ? { voiceName: voice } : {}), ...dictation,
    } });
    return this.settings(userId);
  }

  // ---------------------------------------------------------------- start / resume

  /** One start at a time per user, so two parallel starts can't both open a call. */
  start(user: User, input: z.infer<typeof StartCallRequest>): Promise<z.infer<typeof StartCallResponse>> {
    return this.lock.run(`start:${user.id}`, () => this.startLocked(user, input));
  }

  private async startLocked(user: User, input: z.infer<typeof StartCallRequest>): Promise<z.infer<typeof StartCallResponse>> {
    const { db, realtime, now } = this.deps;
    const channel = await db.channel.findFirst({ where: { id: input.channelId, userId: user.id } });
    if (!channel) throw notFound();
    let resumed: CallRow | null = null;
    let model: RealtimeModel | null;
    if (input.callId) {
      resumed = await db.call.findFirst({ where: { id: input.callId, userId: user.id } });
      if (!resumed) throw notFound();
      // (checked again under the call's lock below: an end can land while the credential is minted)
      if (resumed.status !== "open") throw ended();
      if (resumed.channelId !== channel.id) throw new HttpError(400, "validation_failed", "channelId: not this call's channel", "channelId");
      model = await realtime.usable(user.id, resumed.modelEntryId);
      if (!model) throw new HttpError(400, "not_configured", "This call's voice model isn't usable any more.");
    } else {
      const open = await db.call.findFirst({ where: { userId: user.id, status: "open" }, orderBy: { startedAt: "desc" } });
      if (open && open.channelId !== channel.id) throw new HttpError(409, "conflict", "A call is already open in another chat.");
      if (input.modelId) {
        model = await realtime.pick(user.id, input.modelId);
        if (!model) throw new HttpError(400, "validation_failed", "modelId: not a usable realtime model", "modelId");
      } else {
        model = await realtime.pick(user.id);
        if (!model) throw new HttpError(400, "not_configured", "No realtime voice model is set up.");
      }
      // A call left open in this chat (the phone lost it): it ends as usual before the new one starts.
      if (open) await this.end(user.id, open.id, { seconds: secondsBetween(open.startedAt, open.lastActiveAt), lines: [] });
    }
    const engine = model.engine;
    const region = model.provider.region === "intl" ? "intl" : null;
    const settings = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { voiceName: true } });
    if (input.voice !== undefined && !isVoiceOf(engine, input.voice, region)) throw new HttpError(400, "validation_failed", "voice: not a voice of this model's provider", "voice");
    const voice = input.voice ?? (resumed?.voice && isVoiceOf(engine, resumed.voice, region) ? resumed.voice : null) ?? (settings.voiceName && isVoiceOf(engine, settings.voiceName, region) ? settings.voiceName : defaultVoice(engine, region));

    // The credential first: a failed mint leaves no open call behind.
    const key = await realtime.key(user.id, model);
    if (!key) throw new HttpError(400, "not_configured", "The voice model's provider has no key.");
    const minted = await credentialFor({ fetch: this.deps.fetch, now }, engine, model.entry.modelId, key, region);
    if (!minted.ok) throw new HttpError(400, "not_configured", minted.reason);

    const at = now();
    let row: CallRow;
    if (resumed) {
      const id = resumed.id;
      // Under the call's lock: still open (else 409, and no watcher for an ended call), then watched.
      row = await this.lock.run(`call:${id}`, async () => {
        const kept = await db.call.updateMany({ where: { id, status: "open" }, data: { voice, lastActiveAt: at } });
        if (kept.count === 0) throw ended();
        const fresh = await db.call.findUniqueOrThrow({ where: { id } });
        this.deps.cues.watch(fresh);
        return fresh;
      });
    } else {
      row = await db.call.create({ data: {
        userId: user.id, channelId: channel.id, engine, modelEntryId: model.entry.id, modelId: model.entry.modelId, voice,
        status: "open", startedAt: at, lastActiveAt: at,
      } });
      this.deps.cues.watch(row);
    }
    // The newest lines, back in time order (the instructions keep the newest 3000 characters).
    const soFar = resumed
      ? (await db.callLine.findMany({ where: { callId: row.id }, orderBy: [{ at: "desc" }, { createdAt: "desc" }], take: SO_FAR_LINES, select: { from: true, text: true } })).reverse()
      : null;
    const [approvals, tasks] = await Promise.all([pendingApprovals(db, user.id, channel.id), openTasks(db, user.id, channel.id)]);
    const instructions = await buildInstructions(db, {
      user, channel, language: input.language, now: at, soFar,
      work: {
        running: this.deps.runs.busy({ userId: user.id, channelId: channel.id }), status: this.deps.cues.statusOf(user.id, channel.id),
        approvals, tasks,
      },
    });
    return { call: toCall(row), model: model.entry.modelId, url: minted.url, credential: minted.credential, instructions, tools: VOICE_TOOLS };
  }

  // ---------------------------------------------------------------- lines and tools

  /**
   * One lock per call (`call:<id>`) for the lines, a hand-off, the end, the sweep and a resume: a
   * hand-off lands before the end releases the call's turns, or gets 409; lines are stamped and the
   * hand-off reads the call row (handedAt) one at a time.
   */
  private locked<T>(callId: string, work: () => Promise<T>): Promise<T> {
    return this.lock.run(`call:${callId}`, work);
  }

  /** POST /lines: appended, deduped by (call, line id); 409 on an ended call. */
  addLines(userId: string, callId: string, lines: Line[]): Promise<void> {
    return this.locked(callId, async () => {
      const call = await this.open(userId, callId);
      await this.store(call.id, lines);
      await this.touch(call.id);
      this.handoffs.heard(call, lines);
    });
  }

  /** POST /tool: the request's lines first (they're the user's own words of a hand-off), then the tool. */
  async tool(userId: string, callId: string, name: ToolName | null, rawName: string, args: Record<string, unknown>, lines: Line[]): Promise<string> {
    const failed = (error: unknown) => {
      log.error("call tool failed", { callId, tool: name, error: { name: (error as Error).name } });
      return "That didn't work just now. Tell the user and try again in a moment.";
    };
    // The lines and a hand-off under the call's lock; the other tools only read or stop, after it.
    const step = await this.locked(callId, async (): Promise<{ answer: string } | { call: CallRow; name: ToolName }> => {
      const call = await this.open(userId, callId);
      await this.store(call.id, lines);
      await this.touch(call.id);
      this.handoffs.heard(call, lines);
      if (!name) return { answer: `There's no tool called ${JSON.stringify(rawName.slice(0, 64))}. The tools are send_to_assistant, assistant_status, stop_assistant and search_memory.` };
      const fresh = await this.deps.db.call.findUniqueOrThrow({ where: { id: call.id } });
      if (name !== "send_to_assistant") return { call: fresh, name };
      return { answer: await this.tools.run(fresh, name, args).catch(failed) };
    });
    if ("answer" in step) return step.answer;
    return this.tools.run(step.call, step.name, args).catch(failed);
  }

  // ---------------------------------------------------------------- end

  /** Status ended, the title, the call's one line in the chat. A second end answers the same message. */
  async end(userId: string, callId: string, input: { seconds: number; lines: Line[] }): Promise<Message> {
    return this.locked(callId, async () => {
      const { db } = this.deps;
      const call = await db.call.findFirst({ where: { id: callId, userId } });
      if (!call) throw notFound();
      if (call.status === "open") {
        await this.store(call.id, input.lines);
        return this.finish(call, input.seconds);
      }
      return (await this.callMessage(call)) ?? this.post(call, await db.callLine.count({ where: { callId: call.id } }));
    });
  }

  /** The 2 h sweep: open calls with no request, line or turn for that long end the same way. */
  async sweep(): Promise<number> {
    const { db, now } = this.deps;
    const cutoff = new Date(now().getTime() - (this.deps.sweepIdleMs ?? SWEEP_IDLE_MS));
    const stale = await db.call.findMany({ where: { status: "open", lastActiveAt: { lt: cutoff } }, take: 100 });
    let count = 0;
    for (const call of stale) {
      try {
        await this.locked(call.id, async () => {
          const row = await db.call.findFirst({ where: { id: call.id, status: "open", lastActiveAt: { lt: cutoff } } });
          if (!row) return;
          await this.finish(row, secondsBetween(row.startedAt, row.lastActiveAt));
          count += 1;
        });
      } catch (error) {
        log.warn("call sweep failed", { callId: call.id, error: { name: (error as Error).name } });
      }
    }
    return count;
  }

  /** Every open call is watched again after a restart (its cues go on when the phone reconnects). */
  async resumeWatching(): Promise<void> {
    const open = await this.deps.db.call.findMany({ where: { status: "open" }, select: { id: true, userId: true, channelId: true } });
    for (const call of open) this.deps.cues.watch(call);
  }

  // ---------------------------------------------------------------- detail

  async detail(userId: string, callId: string): Promise<z.infer<typeof CallDetail>> {
    const { db } = this.deps;
    const call = await db.call.findFirst({ where: { id: callId, userId } });
    if (!call) throw notFound();
    await this.touch(call.id);
    const [lines, rows] = await Promise.all([
      db.callLine.findMany({ where: { callId: call.id }, orderBy: [{ at: "asc" }, { createdAt: "asc" }] }),
      db.message.findMany({ where: { userId, callId: call.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    ]);
    return {
      call: toCall(call),
      lines: lines.map((l) => ({ id: l.lineId, from: l.from === "voice" ? "voice" : "user", text: l.text, at: l.at.toISOString() })),
      messages: await toMessages(db, rows),
    };
  }

  // ---------------------------------------------------------------- internals

  private async open(userId: string, callId: string): Promise<CallRow> {
    const call = await this.deps.db.call.findFirst({ where: { id: callId, userId } });
    if (!call) throw notFound();
    if (call.status !== "open") throw ended();
    return call;
  }

  /**
   * Appends lines once per (call, id): repeats in the request or already stored are skipped. At
   * most LINES_MAX per call; the rest are dropped (a count in the log). Runs under the call's lock.
   */
  private async store(callId: string, lines: Line[]): Promise<void> {
    if (!lines.length) return;
    const { db } = this.deps;
    const unique = [...new Map(lines.map((l) => [l.id, l])).values()];
    const known = new Set((await db.callLine.findMany({ where: { callId, lineId: { in: unique.map((l) => l.id) } }, select: { lineId: true } })).map((r) => r.lineId));
    const fresh = unique.filter((l) => !known.has(l.id));
    if (!fresh.length) return;
    const room = Math.max(0, LINES_MAX - (await db.callLine.count({ where: { callId } })));
    if (fresh.length > room) log.warn("call lines over the cap dropped", { callId, dropped: fresh.length - room });
    // createdAt rises strictly per call: send_to_assistant splits "since the last hand-off" on it.
    const newest = await db.callLine.findFirst({ where: { callId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    let stamp = Math.max(this.deps.now().getTime(), (newest?.createdAt.getTime() ?? 0) + 1);
    for (const line of fresh.slice(0, room)) {
      const createdAt = new Date(stamp++);
      try {
        await db.callLine.create({ data: { callId, lineId: line.id, from: line.from, text: line.text, at: new Date(line.at), createdAt } });
      } catch (error) {
        // a parallel request stored the same line first (unique callId + lineId)
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
    }
  }

  /** lastActiveAt on every request (an ended call keeps its own). */
  private async touch(callId: string): Promise<void> {
    await this.deps.db.call.updateMany({ where: { id: callId, status: "open" }, data: { lastActiveAt: this.deps.now() } });
  }

  /**
   * Under the call's lock: ended first (a start elsewhere sees no open call, lines and hand-offs get
   * 409), then its turns released and the watcher gone, then the title and the call's one line.
   */
  private async finish(call: CallRow, seconds: number): Promise<Message> {
    const { db } = this.deps;
    await db.call.update({ where: { id: call.id }, data: { status: "ended", endedAt: this.deps.now(), seconds: Math.max(0, Math.round(seconds)) } });
    this.deps.runs.releaseCall(call.id);
    this.deps.cues.unwatch(call.id);
    this.handoffs.forget(call.id);
    const [lineCount, newest, user] = await Promise.all([
      db.callLine.count({ where: { callId: call.id } }),
      db.callLine.findMany({ where: { callId: call.id }, orderBy: [{ at: "desc" }, { createdAt: "desc" }], take: TITLE_LINES, select: { from: true, text: true } }),
      db.user.findUniqueOrThrow({ where: { id: call.userId }, select: { language: true } }),
    ]);
    const title = await titleFor({ resolver: this.deps.resolver }, { userId: call.userId, language: user.language, lines: newest.reverse() });
    const row = await db.call.update({ where: { id: call.id }, data: { title } });
    return this.post(row, lineCount);
  }

  /** The call's one line: kind call, role system, callId null (it shows in the chat). */
  private async post(call: CallRow, lineCount: number): Promise<Message> {
    const { db, events } = this.deps;
    const payload = { callId: call.id, seconds: call.seconds, title: chatTitle(call.title), lineCount };
    const created = await db.message.create({ data: {
      userId: call.userId, channelId: call.channelId, taskId: null, role: "system", kind: "call", text: "", payload: JSON.stringify(payload), status: "sent",
    } });
    const message = await loadMessage(db, created.id);
    if (!message) throw new Error("call message does not match the contract");
    await events.emit(call.userId, call.channelId, "message", { message });
    return message;
  }

  private async callMessage(call: CallRow): Promise<Message | null> {
    const row = await this.deps.db.message.findFirst({
      where: { userId: call.userId, channelId: call.channelId, kind: "call", payload: { contains: `"callId":${JSON.stringify(call.id)}` } },
      orderBy: { createdAt: "asc" },
    });
    return row ? loadMessage(this.deps.db, row.id) : null;
  }
}

export function toCall(row: CallRow): z.infer<typeof Call> {
  return Call.parse({
    id: row.id, channelId: row.channelId, engine: row.engine, modelEntryId: row.modelEntryId, modelId: row.modelId, voice: row.voice,
    status: row.status === "ended" ? "ended" : "open", startedAt: row.startedAt.toISOString(), endedAt: row.endedAt?.toISOString() ?? null,
    seconds: row.seconds, title: row.title,
  });
}

const secondsBetween = (from: Date, to: Date): number => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
