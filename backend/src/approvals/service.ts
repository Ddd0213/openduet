// Approvals (L106, L157, L163, L182). Nothing a card describes happens until the user taps:
// Approve runs exactly the stored arguments (once, even on a double tap), Decline marks it, an
// edit by chat stores a new version that a stale Approve can't skip, and payment / spend request
// cards expire. Every change rewrites the card message's payload and emits `message` + `approval`
// on the card's channel. Task approvals tell the task runner (TaskResumer) once decided; M21: a
// chat's cards carry the chat on the same way (ChatResumer, once per turn).
import type { Approval as ApprovalRow } from "@prisma/client";
import type { MessageDraft, TaskResumer } from "../agent/types.ts";
import { ApprovalPreview, type Approval } from "../contract/approvals.ts";
import type { Phrase } from "../contract/common.ts";
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import { loadMessage, payloadSchemaFor } from "../runs/serialize.ts";
import { render, RunRecorder } from "../runs/steps.ts";
import type { GatewayExecution, GatewayFailureKind } from "../composio/gateway.ts";
import { FLOOR_BROWSER_CATEGORIES, type ApprovalAlways } from "../contract/m20.ts";
import { alwaysBlockedFor } from "../policy/floor.ts";
import { browserFingerprintOf, fingerprintOf } from "./fingerprint.ts";
import { toMinorUnits } from "./money.ts";
import { changedFields, type Preview } from "./preview.ts";
import { BROWSER_ACTION_SLUG, type AskInput, type AskOutcome, type BrowserActionInput } from "./gate.ts";
import { recipientAlways, recipientsOf } from "./recipients.ts";
import { storedArgs, summarize, toApproval, toSpendRequest } from "./serialize.ts";

/** request_payment without an item: the payment card is valid this long. */
export const PAYMENT_TTL_MS = 15 * 60_000;
/** request_payment with an item: the Link-style spend request is valid this long. */
export const SPEND_REQUEST_TTL_MS = 30 * 60_000;
/** How often start() looks for expired cards (reads also expire them lazily). */
export const SWEEP_INTERVAL_MS = 30_000;
/** Approval.toolSlug of request_payment cards: approving them never calls any payment service. */
export const PAYMENT_TOOL = "duet:request_payment";
/** M20: a declined call is refused without a card this long, unless the user writes in that thread. */
export const DECLINE_MEMORY_MS = 24 * 60 * 60_000;

/** One ApprovalRule row (userId aside). */
interface RuleKey { toolSlug: string; scopeKind: "recipient" | "site"; scopeValue: string; category: string }

/** How a decided card ended, as the resumers get it (TaskResumer's outcome). */
export type ApprovalOutcome = Parameters<TaskResumer["resumeAfterApproval"]>[1];

/**
 * M21 (#12): carries a conversation on after the cards one of its turns posted were decided (a
 * card without a task). The task runner implements it next to TaskResumer, so the resumer
 * index.ts already wires covers both; a resumer without it (tests) carries nothing on.
 */
export interface ChatResumer {
  resumeChatAfterApproval(input: { userId: string; channelId: string; outcomes: ApprovalOutcome[] }): Promise<void>;
}

const isChatResumer = (value: unknown): value is ChatResumer =>
  typeof value === "object" && value !== null && typeof (value as Partial<ChatResumer>).resumeChatAfterApproval === "function";

/** Turns whose cards carry the conversation on: chat and a routine's (or brief's) channel turn; never a check-in, scan or build. */
const CHAT_RESUME_KINDS: ReadonlySet<string> = new Set(["chat", "routine", "brief"]);

/** The carried-on chat turn's request (never stored): what became of each card, then carry on. */
export function chatResumeNote(outcomes: readonly ApprovalOutcome[]): string {
  const lines = outcomes.map((outcome) => {
    const what = outcome.status === "approved"
      ? (outcome.ok ? "approved it and it was carried out" : "approved it, but carrying it out failed")
      : outcome.status === "declined" ? "declined it, so it was not carried out" : "didn't decide in time; it expired and was not carried out";
    const summary = outcome.summary.trim();
    return `Approval ${outcome.approvalId}: the user ${what}.${summary ? ` Outcome: ${summary}` : ""}`;
  });
  return [
    "[Server note, not from the user] The approval cards from your last turn were decided:",
    ...lines,
    "Carry the conversation on from there in one short message: say what happened (it is done only where it was carried out); after a decline, don't ask for the same thing again; offer another way only if it helps.",
  ].join("\n");
}

/** Runs one approved connector call with exactly the stored arguments. */
export type Executor = (userId: string, slug: string, args: Record<string, unknown>) => Promise<GatewayExecution>;

/**
 * Runs an approved call of a built-in tool (M6: computer_exec) instead of the connector gateway.
 * `error` is the reason line shown on the card (approval.failed).
 */
export type LocalExecutor = (call: { userId: string; approvalId: string; taskId: string | null; slug: string; args: Record<string, unknown> }) => Promise<{ ok: true; output?: unknown } | { ok: false; error: string }>;

/** The run records (M8): a decided card updates the step that posted it. */
export type ApprovalSteps = Pick<RunRecorder, "approvalDecided">;

export interface ApprovalDeps {
  db: Db;
  events: EventBus;
  /** null when Composio isn't configured: approving a connector card then fails with a reason */
  execute?: Executor | null;
  now?: () => Date;
  resumer?: TaskResumer | null;
  /** default: a RunRecorder without the server's secrets (index.ts passes the shared one) */
  steps?: ApprovalSteps;
}

/** What running an approved call gave: the stored result ({ ok, error }) plus its output for the run record. */
interface RunOutcome { ok: boolean; error: Phrase | null; output?: unknown }

/** Where a new card goes: the turn's sink (it knows the channel and the task session). */
export interface CardSink { upsertMessage(draft: MessageDraft): Promise<Message> }

export type EditResult =
  | { ok: true; approval: Approval; changed: boolean }
  | { ok: false; reason: "not_found" | "not_pending" | "not_editable" | "invalid"; message: string };

const REASONS: Record<GatewayFailureKind | "not_configured", { en: string; zh: string }> = {
  not_connected: { en: "{app} isn't connected anymore. Reconnect it and try again.", zh: "{app} 已断开连接，请重新连接后再试。" },
  invalid_arguments: { en: "{app} didn't accept the details. Edit them and try again.", zh: "{app} 没有接受这些内容，请修改后再试。" },
  not_found: { en: "{app} couldn't find what this refers to.", zh: "{app} 找不到要操作的对象。" },
  provider: { en: "{app} returned an error.", zh: "{app} 返回了错误。" },
  unavailable: { en: "Couldn't reach {app}. Try again in a moment.", zh: "暂时连不上 {app}，请稍后再试。" },
  not_configured: { en: "Connected apps aren't set up on this server.", zh: "这台服务器还没有设置连接的 App。" },
};
export class ApprovalService {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, Promise<Approval>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private resumer: TaskResumer | null;
  private readonly local = new Map<string, LocalExecutor>();
  private readonly steps: ApprovalSteps;
  /** M21: runs (or lone cards) whose chat was already carried on after their cards were decided */
  private readonly chatResumed = new Set<string>();

  constructor(private readonly deps: ApprovalDeps) {
    this.now = deps.now ?? (() => new Date());
    this.resumer = deps.resumer ?? null;
    this.steps = deps.steps ?? new RunRecorder({ db: deps.db, now: this.now });
  }

  /** index.ts wires the task runner in after building it (it needs the agent runtime first). */
  setResumer(resumer: TaskResumer | null): void {
    this.resumer = resumer;
  }

  /** A built-in tool whose approved calls run here instead of through the connector gateway. */
  registerExecutor(slug: string, executor: LocalExecutor): void {
    this.local.set(slug, executor);
  }

  /** Serializes every change of one approval (approve, decline, edit, expiry). */
  private locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const tail = next.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.then(() => { if (this.tails.get(id) === tail) this.tails.delete(id); });
    return next;
  }

  private async row(userId: string, id: string): Promise<ApprovalRow> {
    const row = await this.deps.db.approval.findFirst({ where: { id, userId } });
    if (!row) throw new HttpError(404, "not_found", "Not found.");
    return row;
  }

  /**
   * Approve with the version the card showed. 404 not the user's, 410 expired (marked expired),
   * 409 stale_version when the card is behind (or the approval was declined). A double tap joins
   * the call already running; approving again after success returns the stored result without
   * running anything. A failed run stays pending with result.ok false: Retry approves again.
   */
  approve(userId: string, id: string, version: number, always = false): Promise<Approval> {
    const key = `${userId}:${id}:${version}${always ? ":always" : ""}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const attempt = this.locked(id, () => this.approveNow(userId, id, version, always)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, attempt);
    return attempt;
  }

  /**
   * M20 Approve with Always: the card's `always` scope becomes ApprovalRule rows (one per recipient,
   * or the site + category), written in the same transaction as the approval's result. 400
   * validation_failed when the card offers no Always. Stored even when the run fails: the user
   * chose it, and Retry runs the same call.
   */
  private async approveNow(userId: string, id: string, version: number, always: boolean): Promise<Approval> {
    const started = performance.now();
    let row = await this.expireIfDue(await this.row(userId, id));
    const rules = always ? this.rulesFor(row) : [];
    if (always && !rules.length) throw new HttpError(400, "validation_failed", "always: this card has no Always.", "always");
    if (row.status === "expired") throw new HttpError(410, "expired", "This request has expired.");
    if (row.status === "approved" && row.version === version) {
      if (rules.length) await this.deps.db.$transaction(rules.map((rule) => this.upsertRule(userId, rule)));
      return toApproval(row);
    }
    if (row.version !== version || row.status !== "pending") throw new HttpError(409, "stale_version", "This card has changed. Reload it to see the latest version.");
    const ran = performance.now();
    const outcome = await this.run(row);
    const runMs = Math.round(performance.now() - ran);
    const data = { status: outcome.ok ? "approved" : "pending", result: JSON.stringify({ ok: outcome.ok, error: outcome.error }) };
    const approvalId = row.id;
    if (rules.length) {
      const written = await this.deps.db.$transaction([...rules.map((rule) => this.upsertRule(userId, rule)), this.deps.db.approval.update({ where: { id: approvalId }, data })]);
      row = written.at(-1) as ApprovalRow;
    } else {
      row = await this.deps.db.approval.update({ where: { id: approvalId }, data });
    }
    if (outcome.ok) await this.syncSpend(row.id, "approved");
    const approval = await this.publish(row);
    // A failed attempt marks the step failed (with the reason); a Retry that works turns it ok.
    await this.decided(row, "approved", outcome);
    if (outcome.ok) this.resume(row, approval, "approved");
    // M29: how long the tap waited (the card's spinner) and how much of it was the call itself.
    log.info("approval decided", { approvalId: row.id, slug: row.toolSlug, ok: outcome.ok, runMs, totalMs: Math.round(performance.now() - started) });
    return approval;
  }

  /** Executes the stored call. Payments are test mode: approving one never calls anything. */
  private async run(row: ApprovalRow): Promise<RunOutcome> {
    if (row.toolSlug === PAYMENT_TOOL) return { ok: true, error: null };
    const local = this.local.get(row.toolSlug);
    if (local) {
      try {
        const outcome = await local({ userId: row.userId, approvalId: row.id, taskId: row.taskId, slug: row.toolSlug, args: storedArgs(row) });
        return outcome.ok ? { ok: true, error: null, output: outcome.output } : { ok: false, error: { key: "approval.failed", params: { reason: { type: "text", value: outcome.error } } } };
      } catch (error) {
        log.warn("approved call failed", { approvalId: row.id, error: { name: (error as Error)?.name ?? "Error" } });
        return { ok: false, error: await this.reason(row, "unavailable") };
      }
    }
    if (!this.deps.execute) return { ok: false, error: await this.reason(row, "not_configured") };
    let result: GatewayExecution;
    try {
      result = await this.deps.execute(row.userId, row.toolSlug, storedArgs(row));
    } catch (error) {
      log.warn("approved call failed", { approvalId: row.id, error: { name: (error as Error)?.name ?? "Error" } });
      result = { ok: false, kind: "unavailable", error: "" };
    }
    return result.ok ? { ok: true, error: null, output: result.data } : { ok: false, error: await this.reason(row, result.kind) };
  }

  /** Tells the run record how the card ended; never fails the decision. */
  private async decided(row: ApprovalRow, status: "approved" | "declined" | "expired", outcome?: RunOutcome): Promise<void> {
    try {
      let output = outcome?.output;
      if (outcome && !outcome.ok && outcome.error) {
        const user = await this.deps.db.user.findUnique({ where: { id: row.userId }, select: { language: true } });
        output = render(outcome.error, user?.language ?? "en");
      }
      await this.steps.approvalDecided({ approvalId: row.id, status, ok: outcome?.ok ?? false, output, slug: row.toolSlug });
    } catch (error) {
      log.warn("run step update failed", { approvalId: row.id, error: { name: (error as Error)?.name ?? "Error" } });
    }
  }

  /** approval.failed + a short reason in the user's language; never the provider's own message. */
  private async reason(row: ApprovalRow, kind: GatewayFailureKind | "not_configured"): Promise<Phrase> {
    const user = await this.deps.db.user.findUnique({ where: { id: row.userId }, select: { language: true } });
    const preview = ApprovalPreview.safeParse(JSON.parse(row.preview));
    const app = preview.success && "app" in preview.data ? preview.data.app : "The app";
    const text = REASONS[kind][user?.language === "zh-Hans" ? "zh" : "en"].replace("{app}", app);
    return { key: "approval.failed", params: { reason: { type: "text", value: text } } };
  }

  /** Decline (Not now). Accepted with any version and answers the latest; a decided card stays as it is. */
  decline(userId: string, id: string, _version: number): Promise<Approval> {
    return this.locked(id, async () => {
      const row = await this.expireIfDue(await this.row(userId, id));
      if (row.status !== "pending") return toApproval(row);
      const declined = await this.deps.db.approval.update({ where: { id: row.id }, data: { status: "declined", result: null } });
      await this.syncSpend(row.id, "declined");
      const approval = await this.publish(declined);
      await this.decided(declined, "declined");
      this.resume(declined, approval, "declined");
      return approval;
    });
  }

  /** Lazy expiry: a pending card past its expiresAt turns expired (card, events, resumer). */
  private async expireIfDue(row: ApprovalRow): Promise<ApprovalRow> {
    if (row.status !== "pending" || !row.expiresAt || row.expiresAt.getTime() > this.now().getTime()) return row;
    const expired = await this.deps.db.approval.update({ where: { id: row.id }, data: { status: "expired" } });
    await this.syncSpend(row.id, "expired");
    const approval = await this.publish(expired);
    await this.decided(expired, "expired");
    this.resume(expired, approval, "expired");
    return expired;
  }

  /** Expires every due card (all users, or one). Returns how many turned expired. */
  async sweep(userId?: string): Promise<number> {
    const due = await this.deps.db.approval.findMany({
      where: { status: "pending", expiresAt: { lte: this.now() }, ...(userId ? { userId } : {}) },
      select: { id: true, userId: true }, take: 200,
    });
    let count = 0;
    for (const { id, userId: owner } of due) {
      try {
        const row = await this.locked(id, async () => this.expireIfDue(await this.row(owner, id)));
        if (row.status === "expired") count++;
      } catch (error) {
        log.warn("approval expiry failed", { approvalId: id, error: { name: (error as Error)?.name ?? "Error" } });
      }
    }
    return count;
  }

  /** The background sweep; index.ts starts it after listen and stops it on shutdown. */
  start(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async syncSpend(approvalId: string, status: "approved" | "declined" | "expired"): Promise<void> {
    await this.deps.db.spendRequest.updateMany({ where: { approvalId }, data: { status } });
  }

  /** Rewrites the card message from the row and emits `message` then `approval` on its channel. */
  private async publish(row: ApprovalRow): Promise<Approval> {
    const approval = toApproval(row);
    let channelId: string | null = null;
    if (row.messageId) {
      const message = await this.deps.db.message.findFirst({ where: { id: row.messageId, userId: row.userId } });
      if (message && (message.kind === "approval" || message.kind === "spend_request")) {
        channelId = message.channelId;
        let payload: Record<string, unknown> = { approval };
        if (message.kind === "spend_request") {
          const spend = await this.deps.db.spendRequest.findFirst({ where: { approvalId: row.id } });
          payload = spend ? { spendRequest: toSpendRequest(spend) } : JSON.parse(message.payload);
        }
        payloadSchemaFor(message.kind).parse(payload);
        await this.deps.db.message.update({ where: { id: message.id }, data: { payload: JSON.stringify(payload) } });
        const shaped = await loadMessage(this.deps.db, message.id);
        if (shaped) await this.deps.events.emit(row.userId, channelId, "message", { message: shaped });
      }
    }
    await this.deps.events.emit(row.userId, channelId, "approval", { approval });
    return approval;
  }

  /**
   * Tells the task runner (a task's card) or, M21, carries the chat on (a card without a task);
   * failures never undo the decision or fail the route.
   */
  private resume(row: ApprovalRow, approval: Approval, status: "approved" | "declined" | "expired"): void {
    if (!this.resumer) return;
    const outcome = { approvalId: row.id, status, ok: status === "approved" && approval.result?.ok === true, summary: summarize(approval) };
    const failed = (error: unknown) => log.warn(row.taskId ? "task resume failed" : "chat resume failed", { approvalId: row.id, error: { name: (error as Error)?.name ?? "Error" } });
    try {
      if (row.taskId) void this.resumer.resumeAfterApproval(row.taskId, outcome).catch(failed);
      else void this.resumeChat(row, outcome).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /**
   * M21 (#12): a card without a task (the chat, a routine's turn in its channel) was decided: the
   * conversation carries on the way a task's session does, through the resumer (index.ts wires the
   * task runner, which also implements ChatResumer). The cards one turn posted are answered
   * together: nothing happens while another card of that turn (its run, through the run record)
   * still waits, and that turn is carried on once, with every card's outcome. Turns that aren't a
   * conversation (a check-in, a scan, a build) aren't carried on.
   */
  private async resumeChat(row: ApprovalRow, outcome: ApprovalOutcome): Promise<void> {
    const resumer = this.resumer;
    if (!isChatResumer(resumer) || !row.messageId) return;
    const { db } = this.deps;
    const card = await db.message.findFirst({ where: { id: row.messageId, userId: row.userId }, select: { channelId: true, taskId: true } });
    if (!card || card.taskId !== null) return;
    const step = await db.runStep.findFirst({ where: { approvalId: row.id }, select: { runId: true, run: { select: { kind: true, userId: true } } } });
    // No step row yet: the tool call that posted the card hasn't returned (its run is still going
    // and gets the outcome in the tool result), or the run record failed. Without the run we can't
    // tell its kind or its other cards, so nothing is carried on (the user's next message is).
    if (!step || step.run.userId !== row.userId || !CHAT_RESUME_KINDS.has(step.run.kind)) return;
    const steps = await db.runStep.findMany({ where: { runId: step.runId, approvalId: { not: null } }, select: { approvalId: true } });
    const ids = [...new Set(steps.flatMap((s) => (s.approvalId ? [s.approvalId] : [])))];
    const rows = await db.approval.findMany({ where: { id: { in: ids }, userId: row.userId, taskId: null }, orderBy: { createdAt: "asc" } });
    if (rows.some((r) => r.status === "pending")) return;
    const outcomes: ApprovalOutcome[] = rows.map((r) => {
      const shown = toApproval(r);
      return { approvalId: r.id, status: r.status as ApprovalOutcome["status"], ok: r.status === "approved" && shown.result?.ok === true, summary: summarize(shown) };
    });
    // Once per turn (two cards decided at the same moment both get here): claimed synchronously.
    const key = step.runId;
    if (this.chatResumed.has(key)) return;
    this.chatResumed.add(key);
    // Bounded: the oldest claims go first (a card decided that long after is long past its turn).
    if (this.chatResumed.size > 2000) for (const old of [...this.chatResumed].slice(0, 500)) this.chatResumed.delete(old);
    await resumer.resumeChatAfterApproval({ userId: row.userId, channelId: card.channelId, outcomes });
  }

  /**
   * An "ask" call becomes a card: row first, then the card message, then messageId written back.
   * M20: the row carries its fingerprint (default: slug + arguments, so cards made here before a
   * caller moves to ask() still count as "the same call"), `why` and `always`. Prefer ask().
   */
  async createToolApproval(input: {
    userId: string; taskId: string | null; sink: CardSink;
    slug: string; args: Record<string, unknown>; kind: Approval["kind"]; preview: Preview;
    fingerprint?: string; why?: Phrase | null; always?: ApprovalAlways | null;
  }): Promise<Approval> {
    const preview = ApprovalPreview.parse(input.preview);
    const row = await this.deps.db.approval.create({
      data: {
        userId: input.userId, taskId: input.taskId, kind: input.kind, toolSlug: input.slug, arguments: JSON.stringify(input.args), preview: JSON.stringify(preview),
        fingerprint: input.fingerprint ?? fingerprintOf(input.slug, input.args),
        why: input.why ? JSON.stringify(input.why) : null,
        always: input.always ? JSON.stringify(input.always) : null,
      },
    });
    return this.attachCard(row, () => input.sink.upsertMessage({ role: "assistant", kind: "approval", payload: { approval: toApproval(row) } }));
  }

  /**
   * M20 (approvals/gate.ts): every "ask" call comes through here instead of createToolApproval.
   * A tool that sends to other people runs when every recipient has an Always rule; the same call
   * (fingerprint) still waiting posts no second card; one the user declined is refused until they
   * write again in that thread (at most 24 h); otherwise a card with `why` (floor tools) and
   * `always` (the recipients, for tools that send to other people).
   */
  async ask(input: AskInput): Promise<AskOutcome> {
    const blocked = alwaysBlockedFor({ slug: input.slug, toolkit: input.toolkit ?? null, ...(input.tags ? { tags: input.tags } : {}) });
    const recipients = blocked === "per_recipient" ? recipientsOf(input.args) : [];
    const fingerprint = fingerprintOf(input.slug, input.args, input.identity);
    return this.gate(input, fingerprint, {
      allowed: () => this.recipientsAllowed(input.userId, input.slug, recipients),
      create: () => this.createToolApproval({
        userId: input.userId, taskId: input.taskId, sink: input.sink, slug: input.slug, args: input.args, kind: input.kind, preview: input.preview,
        fingerprint, why: blocked === "floor" ? { key: "approval.why_floor" } : null, always: recipientAlways(recipients),
      }),
    });
  }

  /** Every recipient (there is at least one) has an Always rule for this tool. */
  private async recipientsAllowed(userId: string, slug: string, recipients: readonly string[]): Promise<boolean> {
    if (!recipients.length) return false;
    const covered = await this.deps.db.approvalRule.count({ where: { userId, toolSlug: slug, scopeKind: "recipient", category: "", scopeValue: { in: [...recipients] } } });
    return covered === recipients.length;
  }

  /**
   * The order gate.ts describes, under one lock per user + fingerprint so two identical asks at the
   * same moment can't both post a card (the second one finds the first one's card waiting).
   */
  private gate(scope: { userId: string; channelId: string; taskId: string | null }, fingerprint: string, steps: { allowed: () => Promise<boolean>; create: () => Promise<Approval> }): Promise<AskOutcome> {
    return this.locked(`ask:${scope.userId}:${fingerprint}`, async () => {
      if (await steps.allowed()) return { status: "allowed" };
      const waiting = await this.waitingFor(scope.userId, fingerprint);
      if (waiting) return { status: "already_waiting", approval: toApproval(waiting) };
      const declined = await this.declinedFor(scope, fingerprint);
      if (declined) return { status: "declined", approval: toApproval(declined) };
      return { status: "created", approval: await steps.create() };
    });
  }

  /** This user's pending card of the same call (not past its expiry), if any. */
  private async waitingFor(userId: string, fingerprint: string): Promise<ApprovalRow | null> {
    const rows = await this.deps.db.approval.findMany({ where: { userId, fingerprint, status: "pending" }, orderBy: { createdAt: "desc" }, take: 5 });
    const now = this.now().getTime();
    return rows.find((r) => !r.expiresAt || r.expiresAt.getTime() > now) ?? null;
  }

  /**
   * The same call declined in the last 24 h (by the declined row's updatedAt) with no user message
   * in this channel and task (the thread the call comes from) since then.
   */
  private async declinedFor(scope: { userId: string; channelId: string; taskId: string | null }, fingerprint: string): Promise<ApprovalRow | null> {
    const since = new Date(this.now().getTime() - DECLINE_MEMORY_MS);
    const row = await this.deps.db.approval.findFirst({ where: { userId: scope.userId, fingerprint, status: "declined", updatedAt: { gt: since } }, orderBy: { updatedAt: "desc" } });
    if (!row) return null;
    const spoke = await this.deps.db.message.findFirst({
      where: { userId: scope.userId, channelId: scope.channelId, taskId: scope.taskId, role: "user", createdAt: { gte: row.updatedAt } },
      select: { id: true },
    });
    return spoke ? null : row;
  }

  /** The ApprovalRule rows an Approve with Always stores for this card (none: it offers no Always). */
  private rulesFor(row: ApprovalRow): RuleKey[] {
    const always = toApproval(row).always;
    if (!always) return [];
    if (always.scope === "site") {
      if (!always.category || FLOOR_BROWSER_CATEGORIES.includes(always.category)) return [];
      return [{ toolSlug: BROWSER_ACTION_SLUG, scopeKind: "site", scopeValue: always.value, category: always.category }];
    }
    // The stored call is what runs, so its recipients are what the rule covers (edits keep `always` in step).
    return recipientsOf(storedArgs(row)).map((address) => ({ toolSlug: row.toolSlug, scopeKind: "recipient", scopeValue: address, category: "" }));
  }

  private upsertRule(userId: string, rule: RuleKey) {
    const key = { userId, ...rule };
    return this.deps.db.approvalRule.upsert({ where: { userId_toolSlug_scopeKind_scopeValue_category: key }, create: key, update: {} });
  }

  /**
   * M20: a consequential click in the assistant's browser (computer/consequential.ts found it). The card
   * shows the site, the button's real name and why it asks; Always is by site + category and never
   * for purchase / account (nor on a checkout page, whatever its button's category). It runs
   * without a card when an Always rule covers this site + category; the same click still waiting
   * or just declined posts no card, like ask(), by site + category + button + via (refs change
   * between snapshots) and what the call carries besides its ref.
   */
  async requestBrowserAction(input: BrowserActionInput): Promise<AskOutcome> {
    const site = input.site.trim().toLowerCase();
    const floor = input.checkoutPage || FLOOR_BROWSER_CATEGORIES.includes(input.category);
    const toolName = input.via === "click" ? "Click in the browser" : "Submit in the browser";
    const preview: Preview = {
      kind: "action", app: "OpenDuet's computer", toolName,
      rows: [{ label: "Site", value: input.site }, { label: "Button", value: input.button }],
      browser: { site: input.site, button: input.button, category: input.category, via: input.via },
    };
    const fingerprint = browserFingerprintOf({ site, category: input.category, button: input.button, via: input.via, slug: input.slug, args: input.args });
    return this.gate(input, fingerprint, {
      allowed: async () => !floor && (await this.deps.db.approvalRule.count({ where: { userId: input.userId, toolSlug: BROWSER_ACTION_SLUG, scopeKind: "site", scopeValue: site, category: input.category } })) > 0,
      create: () => this.createToolApproval({
        userId: input.userId, taskId: input.taskId, sink: input.sink, slug: input.slug, args: input.args, kind: "action", preview, fingerprint,
        why: { key: input.checkoutPage ? "approval.why_checkout" : `approval.why_${input.category}` },
        always: floor ? null : { scope: "site", value: site, category: input.category },
      }),
    });
  }

  /** request_payment (test mode): a payment card, or with an item a Link-style spend request card. */
  async createPayment(input: {
    userId: string; channelId: string; taskId: string | null; sink: CardSink;
    amount: number; currency: string; merchant: string; description: string; item: string | null;
  }): Promise<{ approval: Approval; spendRequestId: string | null }> {
    const currency = input.currency.toUpperCase();
    const amount = toMinorUnits(input.amount, currency);
    const spend = !!input.item;
    const expiresAt = new Date(this.now().getTime() + (spend ? SPEND_REQUEST_TTL_MS : PAYMENT_TTL_MS));
    const preview = ApprovalPreview.parse({ kind: "payment", amount, currency, merchant: input.merchant, description: input.description, testMode: true });
    const args = { amount, currency, merchant: input.merchant, description: input.description, item: input.item };
    const row = await this.deps.db.approval.create({
      data: { userId: input.userId, taskId: input.taskId, kind: "payment", toolSlug: PAYMENT_TOOL, arguments: JSON.stringify(args), preview: JSON.stringify(preview), expiresAt },
    });
    if (!spend) {
      const approval = await this.attachCard(row, () => input.sink.upsertMessage({ role: "assistant", kind: "approval", payload: { approval: toApproval(row) } }));
      return { approval, spendRequestId: null };
    }
    const spendRow = await this.deps.db.spendRequest.create({
      data: { userId: input.userId, channelId: input.channelId, approvalId: row.id, amount, currency, merchant: input.merchant, description: input.description, item: input.item ?? "", expiresAt },
    });
    try {
      const approval = await this.attachCard(row, async () => {
        const message = await input.sink.upsertMessage({ role: "assistant", kind: "spend_request", payload: { spendRequest: toSpendRequest(spendRow) } });
        await this.deps.db.spendRequest.update({ where: { id: spendRow.id }, data: { messageId: message.id } });
        return message;
      });
      return { approval, spendRequestId: spendRow.id };
    } catch (error) {
      await this.deps.db.spendRequest.deleteMany({ where: { id: spendRow.id } });
      throw error;
    }
  }

  private async attachCard(row: ApprovalRow, post: () => Promise<Message>): Promise<Approval> {
    let message: Message;
    try {
      message = await post();
    } catch (error) {
      // No card, no approval: nothing would ever let the user decide it.
      await this.deps.db.approval.deleteMany({ where: { id: row.id } });
      throw error;
    }
    const linked = await this.deps.db.approval.update({ where: { id: row.id }, data: { messageId: message.id } });
    return this.publish(linked);
  }

  /**
   * Edit by chat (L163): `change` turns the stored call into the new one (merged arguments and a
   * rebuilt preview). Only pending connector cards can change; the version goes up and the card
   * glows changedFields. A failed attempt's result is cleared (the new version hasn't run).
   */
  edit(userId: string, id: string, change: (current: { slug: string; args: Record<string, unknown>; approval: Approval }) =>
    Promise<{ args: Record<string, unknown>; kind: Approval["kind"]; preview: Preview } | { error: string }>): Promise<EditResult> {
    return this.locked(id, async () => {
      const found = await this.deps.db.approval.findFirst({ where: { id, userId } });
      if (!found) return { ok: false, reason: "not_found", message: "No approval card with this id." };
      const row = await this.expireIfDue(found);
      if (row.status !== "pending") return { ok: false, reason: "not_pending", message: `This card is already ${row.status}; ask again with a new card if needed.` };
      if (row.toolSlug === PAYMENT_TOOL) return { ok: false, reason: "not_editable", message: "Payment cards can't be edited; request a new payment instead." };
      const current = toApproval(row);
      // M20: a browser click is the button the user saw; a new one needs a fresh snapshot and its own card.
      if (current.preview.kind === "action" && current.preview.browser) return { ok: false, reason: "not_editable", message: "Browser click cards can't be edited; take a new snapshot and try the click again instead." };
      const next = await change({ slug: row.toolSlug, args: storedArgs(row), approval: current });
      if ("error" in next) return { ok: false, reason: "invalid", message: next.error };
      const preview = ApprovalPreview.parse(next.preview);
      const argsJson = JSON.stringify(next.args);
      if (argsJson === row.arguments && JSON.stringify(preview) === row.preview) return { ok: true, approval: current, changed: false };
      const fields = changedFields(current.preview, preview);
      // M20: the edited call is a different call (fingerprint), and a recipient Always covers its recipients.
      const always = current.always?.scope === "recipient" ? recipientAlways(recipientsOf(next.args)) : current.always;
      const updated = await this.deps.db.approval.update({
        where: { id: row.id },
        data: {
          arguments: argsJson, preview: JSON.stringify(preview), kind: next.kind, version: { increment: 1 }, changedFields: JSON.stringify(fields), result: null,
          fingerprint: fingerprintOf(row.toolSlug, next.args), always: always ? JSON.stringify(always) : null,
        },
      });
      return { ok: true, approval: await this.publish(updated), changed: true };
    });
  }

  /**
   * Pending cards and the ones decided in the last day, for the system prompt: a task turn sees its
   * task's cards, a chat turn the cards shown in its channel thread. Due cards expire first.
   */
  async forContext(userId: string, scope: { channelId: string; taskId: string | null }, limit = 12): Promise<{ approval: Approval; slug: string; args: Record<string, unknown> }[]> {
    await this.sweep(userId);
    const since = new Date(this.now().getTime() - 24 * 60 * 60_000);
    const rows = await this.deps.db.approval.findMany({
      where: { userId, messageId: { not: null }, ...(scope.taskId ? { taskId: scope.taskId } : {}), OR: [{ status: "pending" }, { updatedAt: { gte: since } }] },
      orderBy: { createdAt: "desc" }, take: 50,
    });
    const messages = await this.deps.db.message.findMany({ where: { id: { in: rows.flatMap((r) => (r.messageId ? [r.messageId] : [])) } }, select: { id: true, channelId: true, taskId: true } });
    const where = new Map(messages.map((m) => [m.id, m]));
    return rows
      .filter((r) => { const m = r.messageId ? where.get(r.messageId) : undefined; return !!m && m.channelId === scope.channelId && (scope.taskId ? true : m.taskId === null); })
      .slice(0, limit)
      .map((r) => ({ approval: toApproval(r), slug: r.toolSlug, args: storedArgs(r) }));
  }
}
