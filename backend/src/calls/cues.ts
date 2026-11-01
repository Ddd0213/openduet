// M13: the cue watcher (contract "Cues"). While a call is open it turns its channel's events into
// `call` SSE events for the user: the assistant's text reply of a chat turn (every bubble of it, joined)
// -> reply (<= 600 characters, cut at a sentence end); a new approval card -> notice; a failed turn -> notice; a
// status change while a turn runs -> progress (at most one per 15 s, only when it changed, "OpenDuet
// is still working" after 45 s of nothing). `seq` comes from the clock, strictly rising per call.
// M15: a Make build in the call's channel (started -> progress; ready or failed -> notice) and a
// task there (started -> progress; needs input, ready for review or done -> notice), each on a
// change of its status only, so the voice can tell the user what came of what it passed on.
// It also keeps what each channel's chat turn is doing (assistant_status, the instructions) and bumps
// the call's lastActiveAt on the channel's turn events (throttled). Only runs of kind chat are the
// channel's turn: a build or a routine in the same channel (taskId null too) is ignored here.
import type { DuetEvent } from "../contract/events.ts";
import type { Phrase, StatusKey } from "../contract/common.ts";
import type { RunKind } from "../agent/types.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { renderPhrase } from "../tasks/phrases.ts";
import { approvalNotice, approvalTitle, clip, shortenForSpeech, statusText } from "./text.ts";

export const REPLY_MAX = 600;
export const PROGRESS_GAP_MS = 15_000;
export const IDLE_MS = 45_000;
const TOUCH_GAP_MS = 30_000;

export interface CueDeps {
  db: Db;
  events: EventBus;
  /**
   * The kind of a queued or running run (RunHost.kindOf): only kind chat is the channel's turn; a
   * build (taskId null, its own queue) or a routine there isn't. null (unknown here): counted as chat.
   */
  kindOf?: (runId: string) => RunKind | null;
  now?: () => number;
  progressGapMs?: number;
  idleMs?: number;
}

interface Watched {
  callId: string;
  userId: string;
  channelId: string;
  seq: number;
  /** a chat turn of the channel is running (from submit, typing or status) */
  running: boolean;
  runId: string | null;
  /** the running turn's assistant text per bubble (message id), in order: joined, the `reply` when it completes */
  replies: Map<string, string>;
  lastProgressAt: number;
  lastProgress: string | null;
  idle: ReturnType<typeof setTimeout> | null;
  noticed: Set<string>;
  touchedAt: number;
  /** M15: the last status seen of each build and task in the channel (cues only on a change) */
  work: Map<string, string>;
}

type Kind = "reply" | "notice" | "progress";

export class CallCues {
  /** userId + channelId -> the open call there (a user has at most one open call) */
  private readonly watched = new Map<string, Watched>();
  /** userId + channelId -> the chat turn running there and its status (every channel, call or not) */
  private readonly activity = new Map<string, { runId: string; status: StatusKey | null }>();
  private readonly pending = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly idleMs: number;

  constructor(private readonly deps: CueDeps) {
    this.now = deps.now ?? Date.now;
    this.gapMs = deps.progressGapMs ?? PROGRESS_GAP_MS;
    this.idleMs = deps.idleMs ?? IDLE_MS;
  }

  start(): void {
    this.unsubscribe ??= this.deps.events.onPublish(({ userId, event }) => this.onEvent(userId, event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const w of this.watched.values()) this.clearIdle(w);
    this.watched.clear();
  }

  /** Waits for the cues being written (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  watch(call: { id: string; userId: string; channelId: string }): void {
    const key = keyOf(call.userId, call.channelId);
    const current = this.watched.get(key);
    if (current?.callId === call.id) return;
    if (current) this.clearIdle(current);
    const active = this.activity.get(key);
    this.watched.set(key, {
      callId: call.id, userId: call.userId, channelId: call.channelId, seq: 0, running: !!active, runId: active?.runId ?? null,
      replies: new Map(), lastProgressAt: 0, lastProgress: null, idle: null, noticed: new Set(), touchedAt: this.now(),
      work: new Map(),
    });
  }

  unwatch(callId: string): void {
    for (const [key, w] of this.watched) {
      if (w.callId !== callId) continue;
      this.clearIdle(w);
      this.watched.delete(key);
    }
  }

  /** send_to_assistant queued a chat turn for the call. */
  turnStarted(callId: string, runId: string | null): void {
    const w = [...this.watched.values()].find((x) => x.callId === callId);
    if (!w) return;
    w.running = true;
    if (runId && !w.runId) w.runId = runId;
    this.armIdle(w);
  }

  /** A notice for the call's voice from OpenDuet itself (M15: a hand-off it claimed but didn't make). */
  notice(callId: string, text: string): void {
    const w = [...this.watched.values()].find((x) => x.callId === callId);
    if (w) this.cue(w, "notice", text);
  }

  /** What the channel's chat turn is doing, in a few words (null: nothing known). */
  statusOf(userId: string, channelId: string): string | null {
    return statusText(this.activity.get(keyOf(userId, channelId))?.status);
  }

  /** A turn event of a run that isn't the channel's chat turn (a build, a routine): not the call's. */
  private notChat(event: DuetEvent): boolean {
    if (event.type !== "status" && event.type !== "typing" && event.type !== "done") return false;
    if (event.payload.taskId !== null) return false;
    const kind = this.deps.kindOf?.(event.payload.runId) ?? null;
    return kind !== null && kind !== "chat";
  }

  private onEvent(userId: string, event: DuetEvent): void {
    if (event.type === "call" || !event.channelId) {
      if (event.type === "approval") this.track(this.onApproval(userId, event));
      return;
    }
    if (this.notChat(event)) return;
    const key = keyOf(userId, event.channelId);
    this.trackActivity(key, event);
    const w = this.watched.get(key);
    if (!w) {
      if (event.type === "approval") this.track(this.onApproval(userId, event));
      return;
    }
    switch (event.type) {
      case "status": {
        if (event.payload.taskId !== null) return;
        this.claim(w, event.payload.runId);
        if (event.payload.status) this.progress(w, statusText(event.payload.status));
        this.touch(w);
        return;
      }
      case "typing": {
        if (event.payload.taskId !== null || !event.payload.typing) return;
        this.claim(w, event.payload.runId);
        this.touch(w);
        return;
      }
      case "message": {
        const m = event.payload.message;
        // per bubble: a long answer is split into several; an update of one replaces its text in place
        if (m.taskId === null && m.role === "assistant" && m.kind === "text" && w.running && m.text.trim()) w.replies.set(m.id, m.text);
        return;
      }
      case "approval":
        this.track(this.onApproval(userId, event));
        return;
      case "artifact":
        this.onArtifact(w, event.payload.artifact, event.payload.buildStatus);
        return;
      case "task":
        this.onTask(w, event.payload.task);
        return;
      case "done": {
        const p = event.payload;
        if (p.taskId !== null || (w.runId && w.runId !== p.runId)) return;
        const text = [...w.replies.values()].join("\n\n");
        w.running = false;
        w.runId = null;
        w.replies.clear();
        w.lastProgress = null;
        this.clearIdle(w);
        if (p.status === "failed") {
          const reason = p.error ? renderPhrase(p.error) : "";
          this.cue(w, "notice", reason ? `OpenDuet couldn't finish that: ${reason}` : "OpenDuet couldn't finish that.");
        } else if (p.status === "completed" && text) {
          this.cue(w, "reply", shortenForSpeech(text, REPLY_MAX));
        }
        this.touch(w, true);
        return;
      }
      default:
        return;
    }
  }

  private trackActivity(key: string, event: DuetEvent): void {
    if (event.type === "status" && event.payload.taskId === null) {
      this.activity.set(key, { runId: event.payload.runId, status: event.payload.status });
    } else if (event.type === "typing" && event.payload.taskId === null && event.payload.typing && !this.activity.has(key)) {
      this.activity.set(key, { runId: event.payload.runId, status: null });
    } else if (event.type === "done" && event.payload.taskId === null && this.activity.get(key)?.runId === event.payload.runId) {
      this.activity.delete(key);
    }
  }

  /** A turn event of the channel's chat: the call's turn is running. */
  private claim(w: Watched, runId: string): void {
    if (!w.running) {
      w.running = true;
      w.lastProgress = null;
    }
    w.runId ??= runId;
    if (!w.idle) this.armIdle(w);
  }

  /** A Make build in the call's channel: started (progress), then ready or failed (notice). */
  private onArtifact(w: Watched, artifact: { id: string; title: string; status: string }, buildStatus: Phrase | null): void {
    const key = `artifact:${artifact.id}`;
    const before = w.work.get(key);
    if (before === artifact.status) return;
    w.work.set(key, artifact.status);
    const title = JSON.stringify(clip(artifact.title, 80));
    if (artifact.status === "building") {
      this.cue(w, "progress", `OpenDuet is building ${title} in Make.`);
    } else if (artifact.status === "ready" && before === "building") {
      this.cue(w, "notice", `${title} is ready: the card is in the chat.`);
    } else if (artifact.status === "failed" && before !== undefined) {
      const reason = buildStatus ? renderPhrase(buildStatus) : "";
      this.cue(w, "notice", reason ? `${title} couldn't be built: ${clip(reason, 200)}` : `${title} couldn't be built.`);
    }
  }

  /** A task of the call's channel: working (progress), then needs input, ready for review or done (notice). */
  private onTask(w: Watched, task: { id: string; title: string; status: string; latestUpdate: { text: Phrase } | null }): void {
    const key = `task:${task.id}`;
    const before = w.work.get(key);
    if (before === task.status) return;
    w.work.set(key, task.status);
    const title = JSON.stringify(clip(task.title, 80));
    const update = task.latestUpdate ? clip(renderPhrase(task.latestUpdate.text), 200) : "";
    switch (task.status) {
      case "working":
        if (before === undefined || before === "scheduled") this.cue(w, "progress", `OpenDuet is working on the task ${title}.`);
        return;
      case "needs_input":
        this.cue(w, "notice", `The task ${title} needs the user${update ? `: ${update}` : "."}`);
        return;
      case "ready_for_review":
        this.cue(w, "notice", `The task ${title} is done and ready for the user to review${update ? `: ${update}` : "."}`);
        return;
      case "resolved":
        if (before !== undefined) this.cue(w, "notice", `The task ${title} is done.`);
        return;
      default:
        return;
    }
  }

  /** A new pending approval card in the call's channel (its chat or one of its tasks). */
  private async onApproval(userId: string, event: Extract<DuetEvent, { type: "approval" }>): Promise<void> {
    const { approval } = event.payload;
    if (approval.status !== "pending") return;
    const channelId = await this.channelOfApproval(userId, approval.messageId, approval.taskId, event.channelId);
    const w = channelId ? this.watched.get(keyOf(userId, channelId)) : undefined;
    if (!w || w.noticed.has(approval.id)) return;
    w.noticed.add(approval.id);
    this.cue(w, "notice", approvalNotice(approvalTitle(approval)).replace(/\.$/, ""));
  }

  private async channelOfApproval(userId: string, messageId: string | null, taskId: string | null, fallback: string | null): Promise<string | null> {
    const { db } = this.deps;
    if (messageId) {
      const m = await db.message.findFirst({ where: { id: messageId, userId }, select: { channelId: true } });
      if (m) return m.channelId;
    }
    if (taskId) {
      const t = await db.task.findFirst({ where: { id: taskId, userId }, select: { channelId: true } });
      if (t) return t.channelId;
    }
    return fallback;
  }

  /** progress: only a change, at most one per gap; any status resets the 45 s timer. */
  private progress(w: Watched, label: string | null): void {
    this.armIdle(w);
    if (!label || label === w.lastProgress) return;
    const now = this.now();
    if (now - w.lastProgressAt < this.gapMs) return;
    w.lastProgress = label;
    this.cue(w, "progress", `OpenDuet is ${label}.`);
  }

  private armIdle(w: Watched): void {
    this.clearIdle(w);
    w.idle = setTimeout(() => {
      w.idle = null;
      if (!w.running || this.watched.get(keyOf(w.userId, w.channelId)) !== w) return;
      this.cue(w, "progress", "OpenDuet is still working.");
      this.armIdle(w);
    }, this.idleMs);
    (w.idle as { unref?: () => void }).unref?.();
  }

  private clearIdle(w: Watched): void {
    if (w.idle) clearTimeout(w.idle);
    w.idle = null;
  }

  private cue(w: Watched, kind: Kind, text: string): void {
    const now = this.now();
    w.seq = Math.max(now, w.seq + 1);
    if (kind === "progress") w.lastProgressAt = now;
    const payload = { callId: w.callId, kind, text: clip(text, 2_000), seq: w.seq };
    this.track(this.deps.events.emit(w.userId, w.channelId, "call", payload));
  }

  /** lastActiveAt on the channel's turn events (the 2 h sweep), at most once per 30 s unless forced. */
  private touch(w: Watched, force = false): void {
    const now = this.now();
    if (!force && now - w.touchedAt < TOUCH_GAP_MS) return;
    w.touchedAt = now;
    this.track(this.deps.db.call.updateMany({ where: { id: w.callId, status: "open" }, data: { lastActiveAt: new Date(now) } }));
  }

  private track(work: Promise<unknown>): void {
    const p = work.catch((error: unknown) => log.warn("call cue failed", { error: { name: (error as Error).name } }));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
}

const keyOf = (userId: string, channelId: string) => `${userId}\u0000${channelId}`;
