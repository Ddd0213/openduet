// The proactive engine's turns (L75, L76, L118, L119): scheduled briefs and check-ins, "Run now",
// the Up next scan behind "Show me" and the first-day scan. All of them run in the user's main
// thread with taskId null through RunHost.submit; the hooks keep per-run state (what became visible),
// filter the sink (check-ins and Up next scans stay quiet), skip a turn over the usage limit
// (the Run is "skipped", no usage-limit line), and afterwards mark a quiet check-in or an empty
// brief "resolved" and push the brief's first line.
import type { Run } from "@prisma/client";
import type { z } from "zod";
import type { TurnInput } from "../agent/types.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import type { Phrase } from "../contract/common.ts";
import { RunRecord, ScheduleInfo } from "../contract/tasks.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import type { ModelResolver } from "../llm/index.ts";
import { log } from "../log.ts";
import { firstDayTurn } from "../onboarding/welcome.ts";
import type { RunHost, TurnHooks, TurnOutcome } from "../runs/host.ts";
import { isUniqueViolation, type SlotRunner } from "../scheduler/index.ts";
import { nextSlot, specFor, type ScheduledKind } from "../scheduler/slots.ts";
import { KeyedLock } from "../tasks/lock.ts";
import type { TaskService } from "../tasks/service.ts";
import type { UsageMeter } from "../usage/meter.ts";
import { finishBrief } from "./brief.ts";
import { gate } from "./gate.ts";
import { turnPrompt } from "./prompts.ts";
import { readSources, TriageMemos, type ServerReads } from "./reads.ts";
import { upNextScanning } from "./scanning.ts";
import { filteredSink, firstLine, newTurnState, type ProactiveMode, type TurnState } from "./turns.ts";

/** The push sender (M4 backend B's Notifier.notify); never throws, title defaults to notify.title there. */
export interface NotifyInput { userId: string; channelId?: string; title: Phrase; body: Phrase; route: string }
export type Notify = (input: NotifyInput) => Promise<unknown>;

export interface ProactiveServiceDeps {
  db: Db;
  runs: RunHost;
  usage: UsageMeter;
  tasks: TaskService;
  /** null = Composio isn't configured on this server */
  catalog: ConnectorCatalog | null;
  notify: Notify;
  now?: () => Date;
  /** the welcome's pacing (default ~1.0 s and ~1.6 s); tests pass [0, 0] */
  welcomeDelaysMs?: readonly [number, number];
  /** M9: PROACTIVE_BUILTINS (ScheduleInfo.builtins); default off */
  builtins?: boolean;
  /**
   * M23: the model triage uses (role utility, else the user's default). Absent: the rules decide
   * what they can and the rest of the mail is listed as needs you (unsorted).
   */
  resolver?: ModelResolver | null;
  /** M23: to send the brief's message again once TextPayload.brief is on it (absent: stored only) */
  events?: EventBus | null;
}

type RunRecordShape = z.infer<typeof RunRecord>;
const HISTORY = 10;
const limited = () => new HttpError(429, "usage_limited", "Usage limit reached.");
const restarting = () => new HttpError(503, "internal", "The server is restarting.");

/** A Run row as the contract's RunRecord; a run cancelled by a restart shows as skipped. */
export function toRunRecord(row: Run): RunRecordShape | null {
  const parsed = RunRecord.safeParse({
    id: row.id, kind: row.kind, scheduledFor: row.scheduledFor?.toISOString() ?? null, startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status === "cancelled" ? "skipped" : row.status,
  });
  if (!parsed.success) log.warn("run does not match the contract", { runId: row.id });
  return parsed.success ? parsed.data : null;
}

export class ProactiveService implements SlotRunner {
  private readonly turns = new Map<string, TurnState>();
  private readonly lock = new KeyedLock();
  readonly now: () => Date;
  /** M23: model verdicts already reached per email, so a check-in doesn't sort the brief's mail again */
  private readonly memos: TriageMemos;

  constructor(private readonly deps: ProactiveServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.memos = new TriageMemos(() => this.now().getTime());
    // M12: a model_error card's retry of a brief / check-in runs like "Run now" (same filter and push).
    // Scans aren't retried from a card ("Show me" and onboarding start them again).
    for (const kind of ["brief", "checkin"] as const) deps.runs.retryable?.(kind, (turn) => this.hooks(kind, turn.userId, turn.channelId));
  }

  stateOf(runId: string): TurnState | undefined {
    return this.turns.get(runId);
  }

  /** "chat" for chat turns; the proactive mode of brief / checkin / scan turns; null otherwise. */
  async modeOf(input: TurnInput): Promise<ProactiveMode | "chat" | null> {
    if (input.taskId !== null) return null;
    const kind = input.kind ?? "chat";
    if (kind === "chat") return "chat";
    const state = this.turns.get(input.runId);
    if (state) return state.mode;
    if (kind === "brief" || kind === "checkin") return kind;
    if (kind !== "scan") return null;
    const run = await this.deps.db.run.findUnique({ where: { id: input.runId }, select: { scheduledFor: true } });
    return run?.scheduledFor ? "first_day" : "upnext_scan";
  }

  /** SlotRunner: the scheduler claimed this slot; the Run is created here (P2002 = taken). */
  async runScheduled(input: { userId: string; kind: ScheduledKind; scheduledFor: Date }): Promise<boolean> {
    return (await this.submit(input.userId, input.kind, input.kind, input.scheduledFor)) !== null;
  }

  /** "Run now" (POST /api/schedule/run): an on-demand run that takes no scheduled slot. */
  async runNow(userId: string, kind: ScheduledKind): Promise<RunRecordShape> {
    if ((await this.deps.usage.state(userId)).limited) throw limited();
    const runId = await this.submit(userId, kind, kind, null);
    if (!runId) throw restarting();
    const record = toRunRecord(await this.deps.db.run.findUniqueOrThrow({ where: { id: runId } }));
    if (!record) throw new Error("run does not match the contract");
    return record;
  }

  /** "Show me" (POST /api/up-next/scan): one Up next scan at a time per user. */
  async startUpNextScan(userId: string): Promise<void> {
    await this.lock.run(`scan:${userId}`, async () => {
      if (await upNextScanning(this.deps.db, userId)) return;
      if ((await this.deps.usage.state(userId)).limited) throw limited();
      if (!(await this.submit(userId, "scan", "upnext_scan", null))) throw restarting();
    });
  }

  /** The first-day scan (POST /api/onboarding/complete, once): its Run's scheduledFor is onboardedAt. */
  async startFirstDayScan(userId: string, onboardedAt: Date): Promise<boolean> {
    try {
      return (await this.submit(userId, "scan", "first_day", onboardedAt)) !== null;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * At startup, after `recoverStaleRuns`: a first-day scan that a restart cancelled before it
   * reached the model (startedAt null) is queued again, once, if onboarding was in the last 24 h.
   * Its old row gives up the unique slot and stays as history. Returns how many were re-queued.
   */
  async resumeFirstDayScans(): Promise<number> {
    const { db } = this.deps;
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
    const rows = await db.run.findMany({
      where: { kind: "scan", status: "cancelled", startedAt: null, scheduledFor: { not: null, gte: since } },
      select: { id: true, userId: true, scheduledFor: true },
    });
    let resumed = 0;
    for (const row of rows) {
      const user = await db.user.findUnique({ where: { id: row.userId }, select: { onboardedAt: true } });
      if (!user?.onboardedAt || user.onboardedAt.getTime() !== row.scheduledFor!.getTime()) continue;
      const freed = await db.run.updateMany({ where: { id: row.id, status: "cancelled", startedAt: null }, data: { scheduledFor: null } });
      if (freed.count === 1 && (await this.startFirstDayScan(row.userId, user.onboardedAt))) resumed++;
    }
    return resumed;
  }

  /** GET /api/schedule. */
  async schedule(userId: string): Promise<z.infer<typeof ScheduleInfo>> {
    const user = await this.deps.db.user.findUniqueOrThrow({ where: { id: userId } });
    const now = this.now();
    const from = user.onboardedAt && user.onboardedAt > now ? user.onboardedAt : now;
    const brief = specFor(user, "brief");
    const checkin = specFor(user, "checkin");
    return ScheduleInfo.parse({
      builtins: this.deps.builtins ?? false,
      weekendsOn: user.weekendsOn,
      brief: { time: brief.times[0], nextRunAt: nextSlot(brief, from).toISOString(), history: await this.history(userId, "brief") },
      checkin: { times: checkin.times, nextRunAt: nextSlot(checkin, from).toISOString(), history: await this.history(userId, "checkin") },
    });
  }

  /** The latest runs of a job, newest slot first (on-demand runs by when they started). */
  private async history(userId: string, kind: ScheduledKind): Promise<RunRecordShape[]> {
    const rows = await this.deps.db.run.findMany({ where: { userId, kind }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HISTORY * 3 });
    const at = (r: Run) => (r.scheduledFor ?? r.startedAt ?? r.createdAt).getTime();
    return rows.sort((a, b) => at(b) - at(a)).flatMap((r) => toRunRecord(r) ?? []).slice(0, HISTORY);
  }

  private async submit(userId: string, kind: "brief" | "checkin" | "scan", mode: ProactiveMode, scheduledFor: Date | null): Promise<string | null> {
    const { db, runs, tasks } = this.deps;
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true, name: true, language: true } });
    const channelId = await tasks.mainChannelId(userId);
    const firstName = user.firstName.trim() || user.name.trim().split(/\s+/)[0] || "";
    return runs.submit({
      userId, channelId, taskId: null, kind, scheduledFor,
      prompt: turnPrompt(mode, { firstName, language: user.language }),
      // M14b: only a scheduled brief / check-in is gated; "Run now" and scans were asked for.
      hooks: this.hooks(mode, userId, channelId, scheduledFor !== null && (mode === "brief" || mode === "checkin")),
    });
  }

  private hooks(mode: ProactiveMode, userId: string, channelId: string, gated = false): TurnHooks {
    const { db, runs, usage, catalog } = this.deps;
    return {
      // Over the limit a background turn is skipped quietly; the first-day scan still says hello.
      before: async (runId) => {
        if (mode !== "first_day" && (await usage.state(userId)).limited) return false;
        // M14b: the proactivity level, quiet hours, the daily cap and "don't interrupt" (gate.ts).
        if (gated && (mode === "brief" || mode === "checkin")) {
          const decision = await gate({ db, usage }, { userId, channelId, kind: mode, runId, now: this.now() });
          if (!decision.go) {
            log.info("proactive turn skipped", { userId, runId, kind: mode, reason: decision.reason });
            return false;
          }
        }
        this.turns.set(runId, newTurnState(mode, runId));
        return true;
      },
      around: async (input, next) => {
        const state = this.turns.get(input.runId);
        if (!state) return next(input);
        const filtered: TurnInput = { ...input, sink: filteredSink(input.sink, state, input.channelId) };
        if (mode === "first_day") return firstDayTurn({ db, runs, usage, catalog, delaysMs: this.deps.welcomeDelaysMs }, filtered, next);
        // M23: the server reads (and sorts) the mail, and for the brief today's calendar, first.
        if (mode === "brief" || mode === "checkin") state.reads = await this.read(mode, filtered);
        const result = await next(filtered);
        if (mode === "brief" && result.status === "completed" && state.reads) await this.finish(userId, state, state.reads);
        return result;
      },
      after: (outcome) => this.afterTurn(mode, userId, channelId, outcome),
    };
  }

  /** M23: what the server read for this turn; null when the reads themselves broke (the model reads instead). */
  private async read(mode: "brief" | "checkin", input: TurnInput): Promise<ServerReads | null> {
    try {
      return await readSources({ db: this.deps.db, catalog: this.deps.catalog, resolver: this.deps.resolver, memos: this.memos }, {
        userId: input.userId, runId: input.runId, mode, now: this.now(), signal: input.signal, status: (key) => input.sink.status(key),
      });
    } catch (error) {
      log.warn("proactive reads failed", { userId: input.userId, runId: input.runId, error: { name: (error as Error).name } });
      return null;
    }
  }

  /** M23: the brief's unchecked sources on its message (brief.ts); a failure here never fails the brief. */
  private async finish(userId: string, state: TurnState, reads: ServerReads): Promise<void> {
    try {
      const { language } = await this.deps.db.user.findUniqueOrThrow({ where: { id: userId }, select: { language: true } });
      await finishBrief({ db: this.deps.db, events: this.deps.events ?? null }, { userId, state, reads, lang: language });
    } catch (error) {
      log.warn("brief unchecked sources not written", { userId, runId: state.runId, error: { name: (error as Error).name } });
    }
  }

  /** A check-in or brief that showed and did nothing is "resolved"; a brief that posted is pushed. */
  private async afterTurn(mode: ProactiveMode, userId: string, channelId: string, outcome: TurnOutcome): Promise<void> {
    const state = this.turns.get(outcome.runId);
    this.turns.delete(outcome.runId);
    if (outcome.skipped || !state || outcome.result.status !== "completed") return;
    if ((mode === "checkin" || mode === "brief") && !state.visible && !state.acted) {
      await this.deps.db.run.update({ where: { id: outcome.runId }, data: { status: "resolved" } });
      return;
    }
    if (mode !== "brief") return;
    const body = firstLine(state.firstText);
    if (!body) return;
    try {
      await this.deps.notify({ userId, channelId, title: { key: "notify.title" }, body: { text: body }, route: `duet://channels/${channelId}` });
    } catch (error) {
      log.warn("brief push failed", { userId, error: { name: (error as Error).name } });
    }
  }
}
