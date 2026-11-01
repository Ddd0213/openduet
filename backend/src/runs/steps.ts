// Run records (M8): every run's steps, written while it runs. The run host opens a StepRecorder per
// run and hands it to the agent as TurnInput.steps; the agent reports text / thinking segments and
// tool calls, the host the failure. Writes are queued per run (never awaited by the turn) and a
// write that fails is logged without content: recording never fails or slows a run. The approval
// service reports decided cards (approvalDecided), so an "ask" step shows how it ended.
import type { RunSteps, StepHandle } from "../agent/types.ts";
import type { Phrase } from "../contract/common.ts";
import type { Db } from "../db.ts";
import en from "../i18n/en.json";
import zh from "../i18n/zh-Hans.json";
import type { ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { log } from "../log.ts";
import { approvedOutput, describeCall, describeResult, execFailureDetail } from "./describe.ts";
import { Redactor } from "./redact.ts";

/** Steps of runs older than this are deleted (the Run rows stay). */
export const STEP_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
/** A streaming segment is saved at most this often while it grows (and always when it ends). */
const SAVE_EVERY_MS = 1500;

export interface RunRecorderDeps {
  db: Db;
  /** the server's own secrets (redact.ts secretValues), replaced wherever they appear */
  secrets?: readonly string[];
  now?: () => Date;
}

/** How a decided approval card ended, for its step. */
export interface ApprovalStepOutcome {
  approvalId: string;
  status: "approved" | "declined" | "expired";
  ok: boolean;
  /** what the approved call returned (stored like the tool's live output), or why it failed (text) */
  output?: unknown;
  /** the approved tool's slug (decides how its output is stored, e.g. files_read capped to 2 KB) */
  slug?: string;
}

export class RunRecorder {
  readonly redact: Redactor;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RunRecorderDeps) {
    this.redact = new Redactor(deps.secrets ?? []);
    this.now = deps.now ?? (() => new Date());
  }

  /** M12: a provider key decrypted or typed at run time is redacted from every record from now on. */
  addSecret(secret: string): void {
    this.redact.add(secret);
  }

  /** The record of one run (the Run row exists already). */
  open(runId: string, userId: string): StepRecorder {
    return new StepRecorder(this.deps.db, this.redact, runId, userId, this.now);
  }

  /** A card was decided (and its call run): the step that posted it shows the outcome. */
  async approvalDecided(outcome: ApprovalStepOutcome): Promise<void> {
    try {
      const status = outcome.status === "approved" ? (outcome.ok ? "ok" : "error") : "denied";
      const output = outcome.output === undefined ? undefined : approvedOutput(outcome.slug ?? "", outcome.output, this.redact);
      const detail = outcome.slug === "computer_exec" && outcome.ok ? execFailureDetail(outcome.output, this.redact) : null;
      await this.deps.db.runStep.updateMany({
        where: { approvalId: outcome.approvalId },
        data: { status, finishedAt: this.now(), ...(output !== undefined ? { output } : {}), ...(detail ? { detail } : {}) },
      });
    } catch (error) {
      log.warn("run step update failed", { approvalId: outcome.approvalId, error: { name: (error as Error)?.name ?? "Error" } });
    }
  }

  /** Deletes the steps of runs older than the retention window; returns how many. */
  async prune(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - STEP_RETENTION_MS);
    const { count } = await this.deps.db.runStep.deleteMany({ where: { run: { createdAt: { lt: cutoff } } } });
    if (count > 0) log.info("run steps pruned", { count });
    return count;
  }

  /** Prunes now (startup) and once a day; index.ts starts it after listen and stops it on shutdown. */
  start(intervalMs = PRUNE_INTERVAL_MS): void {
    if (this.timer) return;
    const tick = () => void this.prune().catch((error: unknown) => log.warn("run step pruning failed", { error: { name: (error as Error)?.name ?? "Error" } }));
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

interface Segment { id: string; kind: "text" | "thinking"; body: string; savedAt: number; saved: string }
interface OpenCall { id: string; index: number; call: ToolUseBlock; detail: string }

export class StepRecorder implements RunSteps {
  private next = 0;
  private chain: Promise<void> = Promise.resolve();
  private segment: Segment | null = null;
  private readonly calls = new Map<StepHandle, OpenCall>();

  constructor(
    private readonly db: Db,
    private readonly redact: Redactor,
    private readonly runId: string,
    private readonly userId: string,
    private readonly now: () => Date,
  ) {}

  text(delta: string): void {
    this.append("text", delta);
  }

  thinking(delta: string): void {
    this.append("thinking", delta);
  }

  endRound(): void {
    this.guard(() => this.closeSegment());
  }

  toolStart(call: ToolUseBlock): StepHandle {
    const id = crypto.randomUUID();
    this.guard(() => {
      this.closeSegment();
      const view = describeCall(call, this.redact);
      const index = this.next++;
      this.calls.set(id, { id, index, call, detail: view.detail });
      const startedAt = this.now();
      this.write(() => this.db.runStep.create({ data: {
        id, runId: this.runId, index, kind: "tool", tool: view.tool, app: view.app, title: JSON.stringify(view.title),
        detail: view.detail, status: "running", input: view.input, startedAt,
      } }));
    });
    return id;
  }

  toolEnd(handle: StepHandle, outcome: ToolResultBlock | "cancelled" | "failed"): void {
    this.guard(() => {
      const open = this.calls.get(handle);
      if (!open) return;
      this.calls.delete(handle);
      const finishedAt = this.now();
      if (outcome === "cancelled" || outcome === "failed") {
        this.write(() => this.db.runStep.update({ where: { id: open.id }, data: { status: "error", finishedAt, output: outcome === "cancelled" ? "Stopped: the server shut down." : null } }));
        return;
      }
      const view = describeResult(open.call, outcome, this.redact);
      const [first, ...more] = view.nested ?? [];
      const head = first ?? view;
      const data: Record<string, unknown> = {
        status: head.status, output: head.output, approvalId: head.approvalId,
        // An "ask" step is finished once the card is decided (approvalDecided).
        finishedAt: head.status === "awaiting_approval" ? null : finishedAt,
      };
      if (first) Object.assign(data, { tool: first.tool, app: first.app, title: JSON.stringify(first.title), detail: first.detail, input: first.input });
      else if (view.detail && (!open.detail || open.call.name === "computer_exec")) data.detail = view.detail;
      this.write(() => this.db.runStep.update({ where: { id: open.id }, data }));
      if (head.approvalId) this.reconcile(open.id, head.approvalId);
      for (const extra of more) {
        const id = crypto.randomUUID();
        const index = this.next++;
        this.write(() => this.db.runStep.create({ data: {
          id, runId: this.runId, index, kind: "tool", tool: extra.tool, app: extra.app, title: JSON.stringify(extra.title), detail: extra.detail,
          status: extra.status, input: extra.input, output: extra.output, approvalId: extra.approvalId,
          startedAt: finishedAt, finishedAt: extra.status === "awaiting_approval" ? null : finishedAt,
        } }));
        if (extra.approvalId) this.reconcile(id, extra.approvalId);
      }
    });
  }

  /** The run failed: an error step (after anything still open is closed). */
  error(phrase: Phrase): void {
    this.guard(() => {
      this.closeOpen();
      const index = this.next++;
      const startedAt = this.now();
      this.write(async () => {
        const user = await this.db.user.findUnique({ where: { id: this.userId }, select: { language: true } });
        await this.db.runStep.create({ data: {
          id: crypto.randomUUID(), runId: this.runId, index, kind: "error", tool: null, app: null, title: JSON.stringify({ key: "run.step.error" }),
          detail: this.redact.line(render(phrase, user?.language ?? "en")), status: "error", input: null, output: null, startedAt, finishedAt: startedAt,
        } });
      });
    });
  }

  /** The run is over: close what's open and wait for every write (never throws). */
  async finish(): Promise<void> {
    this.guard(() => this.closeOpen());
    await this.chain;
  }

  private append(kind: "text" | "thinking", delta: string): void {
    this.guard(() => {
      if (!delta) return;
      if (this.segment && this.segment.kind !== kind) this.closeSegment();
      const at = this.now().getTime();
      if (!this.segment) {
        const segment: Segment = { id: crypto.randomUUID(), kind, body: "", savedAt: at, saved: "" };
        this.segment = segment;
        const index = this.next++;
        segment.body = delta;
        const { input, detail } = this.segmentFields(segment);
        segment.saved = segment.body;
        this.write(() => this.db.runStep.create({ data: {
          id: segment.id, runId: this.runId, index, kind, tool: null, app: null, title: JSON.stringify({ key: kind === "text" ? "run.step.text" : "run.step.thinking" }),
          detail, status: "running", input, startedAt: new Date(at),
        } }));
        return;
      }
      const segment = this.segment;
      // Past what's stored there is nothing to add (the body is capped when written).
      if (segment.body.length < 64 * 1024) segment.body += delta;
      if (at - segment.savedAt >= SAVE_EVERY_MS) this.save(segment, "running");
    });
  }

  private segmentFields(segment: Segment): { input: string | null; detail: string } {
    return { input: this.redact.plain(segment.body), detail: this.redact.line(segment.body) };
  }

  private save(segment: Segment, status: "running" | "ok"): void {
    if (status === "running" && segment.body === segment.saved) return;
    segment.savedAt = this.now().getTime();
    segment.saved = segment.body;
    const { input, detail } = this.segmentFields(segment);
    const finishedAt = status === "ok" ? this.now() : null;
    this.write(() => this.db.runStep.update({ where: { id: segment.id }, data: { input, detail, status, finishedAt } }));
  }

  private closeSegment(): void {
    const segment = this.segment;
    if (!segment) return;
    this.segment = null;
    this.save(segment, "ok");
  }

  /** Closes the open segment, and fails tool steps that never got a result. */
  private closeOpen(): void {
    this.closeSegment();
    for (const handle of [...this.calls.keys()]) this.toolEnd(handle, "failed");
  }

  /**
   * A card decided before this step said "awaiting_approval" would leave it waiting forever: once
   * written, the step takes the approval's current state (approvalDecided may have run first).
   */
  private reconcile(stepId: string, approvalId: string): void {
    this.write(async () => {
      const row = await this.db.approval.findUnique({ where: { id: approvalId }, select: { status: true, result: true } });
      if (!row || (row.status === "pending" && !row.result)) return;
      let ok = false;
      try { ok = (JSON.parse(row.result ?? "null") as { ok?: unknown } | null)?.ok === true; } catch { /* unreadable result: failed */ }
      const status = row.status === "approved" ? (ok ? "ok" : "error") : row.status === "pending" ? "error" : "denied";
      await this.db.runStep.updateMany({ where: { id: stepId, status: "awaiting_approval" }, data: { status, finishedAt: this.now() } });
    });
  }

  private write(op: () => Promise<unknown>): void {
    this.chain = this.chain.then(op).then(
      () => undefined,
      (error: unknown) => { log.warn("run step write failed", { runId: this.runId, error: { name: (error as Error)?.name ?? "Error" } }); },
    );
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      log.warn("run step recording failed", { runId: this.runId, error: { name: (error as Error)?.name ?? "Error" } });
    }
  }
}

/** A phrase as text in the user's language (the error step's grey line). */
export function render(phrase: Phrase, language: string): string {
  if (phrase.text !== undefined) return phrase.text;
  const key = phrase.key ?? "";
  const table = (language === "zh-Hans" ? zh.phrases : en.phrases) as Record<string, string>;
  const template = table[key] ?? (en.phrases as Record<string, string>)[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const param = phrase.params?.[name];
    if (!param) return match;
    return "value" in param ? String(param.value) : `${param.seconds} s`;
  });
}
