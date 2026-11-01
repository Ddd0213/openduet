// The sign-in card (L141, M20). request_sign_in posts the card for the page that's open; the card's
// POST /api/computer/sign-in/:requestId hands the email and password to the computer's own
// /sign-in/fill (da9a3ca sign-in.ts), which finds the login form on that page itself, refuses a page
// that isn't on the card's origin (or a login that moves to another origin), types it and submits.
// When the site then asks for a one-time code the card stays pending at step "code" and /code
// types it through /sign-in/code. "Take control instead" hands the browser to the user, "Not now"
// closes the card. Pending requests live in memory only: nothing about them, and never the email,
// the password or the code, is written to the database, the logs, the audit trail or the model's
// context; the computer's own error sentences are never shown (the card gets a phrase key).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MessageDraft, RunKind } from "../agent/types.ts";
import type { Phrase } from "../contract/common.ts";
import { SignInCardRequest, type ComputerState, type SignInCardResponse } from "../contract/computer.ts";
import { SignInCodeRequest } from "../contract/m20.ts";
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import type { AuditSink } from "./audit.ts";
import { ComputerError, type SignInCodeResult, type SignInFillResult } from "./client.ts";
import { rewriteMessage } from "./files.ts";
import { domainOf } from "./paths.ts";
import type { ComputerService, TurnRef } from "./service.ts";

/** How long a card (and, after the password, its code step) stays open. */
export const SIGN_IN_TTL_MS = 10 * 60_000;

/** After the card signed the user in (password, and the code if the site asked). */
export const SIGNED_IN_PROMPT = "(OpenDuet's computer) The user signed in through the sign-in card: their details were typed into the page and submitted (you never see them). Take a fresh computer_snapshot to check the page, then carry on with what you were doing. Don't ask for the password or the code.";
/** After the user tapped "Take control instead" on the card and handed the browser back. */
export const TAKEN_OVER_PROMPT = "(OpenDuet's computer) The user took over the browser from the sign-in card to sign in themselves, and has handed it back. Take a fresh computer_snapshot to see whether they're signed in, then carry on. Don't ask for the password or the code.";
/** After "Not now" on the card. */
export const DISMISSED_PROMPT = "(OpenDuet's computer) The user said not now to the sign-in card, so they didn't sign in. Don't ask again for this site unless they ask you to: carry on without signing in if you can, or tell them briefly what signing in would let you do.";

type CardState = "pending" | "sent" | "expired" | "failed";
type Step = "credentials" | "code";
type Outcome = "taken_over" | "dismissed";
type SignInResult = z.input<typeof SignInCardResponse>;
type Done = (input: { userId: string; channelId: string; taskId: string | null; kind: RunKind }) => Promise<void>;

interface Pending {
  id: string;
  userId: string;
  channelId: string;
  taskId: string | null;
  kind: RunKind;
  messageId: string;
  domain: string;
  /** the origin of the page when the card was posted: the computer refuses any other */
  origin: string;
  expiresAt: number;
  state: CardState | "sending";
  step: Step;
  reason: Phrase | null;
  outcome: Outcome | null;
}

export interface SignInDeps {
  db: Db;
  events: EventBus;
  service: ComputerService;
  audit: AuditSink;
  now?: () => number;
  ttlMs?: number;
}

const sameSite = (page: string, domain: string) => page === domain || page.endsWith(`.${domain}`) || domain.endsWith(`.${page}`);

/** The http(s) origin of a URL, or "" (about:blank, data: ...). */
function originOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

const phrase = (key: string, domain?: string): Phrase => (domain ? { key, params: { domain: { type: "text", value: domain } } } : { key });

/**
 * One of sign-in.ts's own refusals as a phrase key. Matched on what the computer reports (the page's
 * URL against the card's origin, whether anything was submitted) and its fixed sentences; never shown.
 */
function refusal(entry: Pending, result: { submitted: boolean; url?: string; error?: string }): Phrase {
  const error = result.error ?? "";
  if (/moved to/i.test(error)) return phrase("signin.moved");
  if (/\bis not on\b/i.test(error)) return phrase("signin.wrong_page", entry.domain);
  if (/no sign-in form|not asking for a verification code|did not ask for a password/i.test(error)) return phrase("signin.no_form");
  const pageOrigin = originOf(result.url);
  if (pageOrigin && pageOrigin !== entry.origin) return phrase(result.submitted ? "signin.moved" : "signin.wrong_page", result.submitted ? undefined : entry.domain);
  return phrase("signin.failed");
}

export class SignInService {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly deps: SignInDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? SIGN_IN_TTL_MS;
  }

  /**
   * request_sign_in: the domain must be the page that's open (the card shows the real page's
   * domain, never what a page told the model); the card remembers that page's origin, the only one
   * the computer will type the login into. Returns the requestId or an error for the model.
   */
  async request(turn: TurnRef, sink: { upsertMessage(draft: MessageDraft): Promise<Message> }, input: { domain: string; pageUrl: string | null }): Promise<{ requestId: string; domain: string } | { error: string }> {
    if (!this.deps.service.client) return { error: "OpenDuet's computer isn't set up on this server." };
    const asked = input.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
    const page = domainOf(input.pageUrl);
    const origin = originOf(input.pageUrl);
    if (!page || !origin) return { error: "Open the site's sign-in page with computer_navigate first." };
    if (!sameSite(page, asked)) return { error: `The page that's open is ${page}, not ${asked}. Ask for sign-in on the page that needs it.` };
    // The browser has one page: only the newest card can still type into it, every older open
    // card (whoever's) turns expired.
    for (const other of this.pending.values()) if (this.open(other)) await this.finish(other, { state: "expired" });
    const id = randomUUID();
    const message = await sink.upsertMessage({ role: "assistant", kind: "sign_in", payload: { requestId: id, domain: page, state: "pending", step: "credentials", reason: null, outcome: null } });
    this.pending.set(id, {
      id, userId: turn.userId, channelId: turn.channelId, taskId: turn.taskId, kind: turn.kind, messageId: message.id, domain: page, origin,
      expiresAt: this.now() + this.ttlMs, state: "pending", step: "credentials", reason: null, outcome: null,
    });
    await this.deps.audit.record({ userId: turn.userId, action: "sign_in_request", actor: "assistant", target: page, outcome: "ok", runId: turn.runId });
    return { requestId: id, domain: page };
  }

  /** Still answerable: pending, or failed (Retry) at either step. */
  private open(entry: Pending): boolean {
    return entry.state === "pending" || entry.state === "failed";
  }

  private async finish(entry: Pending, change: Partial<Pick<Pending, "state" | "step" | "reason" | "outcome">> & { state: CardState }): Promise<void> {
    Object.assign(entry, change);
    const payload = { requestId: entry.id, domain: entry.domain, state: change.state, step: entry.step, reason: entry.reason, outcome: entry.outcome };
    try {
      await rewriteMessage(this.deps, entry.userId, entry.messageId, "sign_in", payload);
    } catch (error) {
      log.warn("sign-in card update failed", { error: { name: (error as Error)?.name ?? "Error" } });
    }
  }

  private answer(entry: Pending, computer: ComputerState | null = null): SignInResult {
    // "sent" + step "code" means only "the site wants a code next" (the card is still pending at
    // the code step); signed in is "sent" + "credentials", also after the code step.
    const current = entry.state;
    if (current === "pending" || current === "sending") {
      return { requestId: entry.id, state: "sent", step: entry.step, reason: entry.reason, outcome: entry.outcome, computer };
    }
    const step = current === "sent" ? "credentials" : entry.step;
    return { requestId: entry.id, state: current, step, reason: entry.reason, outcome: entry.outcome, computer };
  }

  /**
   * The card for this user, still answerable, or the answer to give instead: 404 unknown or another
   * user's; 409 while one action runs or once it was used (signed in, taken over, dismissed); past
   * its time, state "expired".
   */
  private async usable(userId: string, requestId: string): Promise<{ entry: Pending } | { done: SignInResult }> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.userId !== userId) throw new HttpError(404, "not_found", "Not found.");
    if (entry.state === "sending") throw new HttpError(409, "stale_version", "This sign-in is being sent.");
    if (entry.state === "sent" || entry.outcome) throw new HttpError(409, "stale_version", "This sign-in card was already used. Ask OpenDuet to request it again.");
    if (entry.state === "expired" || this.now() > entry.expiresAt) {
      if (entry.state !== "expired") await this.finish(entry, { state: "expired" });
      return { done: { requestId, state: "expired", step: entry.step, reason: entry.reason, outcome: null, computer: null } };
    }
    return { entry };
  }

  /** After a step ran: audit it, carry on when the user is signed in, answer the card. */
  private async settled(entry: Pending, action: string, onDone?: Done): Promise<SignInResult> {
    const signedIn = entry.state === "sent";
    await this.deps.audit.record({ userId: entry.userId, action, actor: "user", target: entry.domain, outcome: entry.state === "failed" ? "error" : "ok" });
    if (signedIn && onDone) {
      try {
        await onDone({ userId: entry.userId, channelId: entry.channelId, taskId: entry.taskId, kind: entry.kind });
      } catch (error) {
        log.warn("sign-in resume failed", { error: { name: (error as Error)?.name ?? "Error" } });
      }
    }
    return this.answer(entry);
  }

  private fillOutcome(entry: Pending, result: SignInFillResult): Partial<Pending> & { state: CardState } {
    if (result.error || !result.submitted) return { state: "failed", step: "credentials", reason: refusal(entry, result) };
    // The site took the password and sent a code: the card goes on to the code field, for a fresh 10 minutes.
    if (result.codeRequested) {
      entry.expiresAt = this.now() + this.ttlMs;
      return { state: "pending", step: "code", reason: null };
    }
    if (result.passwordFieldVisible) return { state: "failed", step: "credentials", reason: phrase("signin.rejected") };
    return { state: "sent", reason: null };
  }

  private codeOutcome(entry: Pending, result: SignInCodeResult): Partial<Pending> & { state: CardState } {
    if (result.error || !result.submitted) return { state: "failed", step: "code", reason: refusal(entry, result) };
    // Back at the site's login page: only the whole login again can help.
    if (result.passwordFieldVisible) return { state: "failed", step: "credentials", reason: phrase("signin.rejected") };
    if (result.codeFieldVisible) return { state: "failed", step: "code", reason: phrase("signin.code_rejected") };
    return { state: "sent", reason: null };
  }

  /**
   * POST /api/computer/sign-in/:requestId: the email and password, typed by the computer into the
   * card's origin. `raw` is the unparsed body; validation errors never echo it. Answers "sent" with
   * step "code" when the site asks for a code next; "failed" with a reason (the card can be retried
   * until it expires); "sent" when the user is signed in (the assistant carries on).
   */
  async submit(userId: string, requestId: string, raw: unknown, onDone?: Done): Promise<SignInResult> {
    const found = await this.usable(userId, requestId);
    if ("done" in found) return found.done;
    const entry = found.entry;
    if (entry.step === "code") throw new HttpError(400, "validation_failed", "This sign-in card is waiting for the verification code.");
    const parsed = SignInCardRequest.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "validation_failed", "Enter an email and a password.");
    const client = this.deps.service.client;
    if (!client) throw new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");
    entry.state = "sending";
    let change: Partial<Pending> & { state: CardState };
    try {
      const result = await this.deps.service.using(() => client.signInFill({ origin: entry.origin, username: parsed.data.email, password: parsed.data.password }));
      // The computer retired every ref once a form was submitted.
      if (result.submitted) this.deps.service.requireSnapshot();
      change = this.fillOutcome(entry, result);
    } catch (error) {
      log.warn("sign-in delivery failed", { kind: error instanceof ComputerError ? error.kind : "error" });
      change = { state: "failed", step: "credentials", reason: phrase("signin.failed") };
    }
    await this.finish(entry, change);
    return this.settled(entry, "sign_in", onDone);
  }

  /**
   * POST /api/computer/sign-in/:requestId/code: the code the site asked for after the password,
   * handled like the password (read once, typed by the computer, never logged or stored). 400 when
   * the card isn't at the code step. A refused code keeps the card at the code step.
   */
  async code(userId: string, requestId: string, raw: unknown, onDone?: Done): Promise<SignInResult> {
    const found = await this.usable(userId, requestId);
    if ("done" in found) return found.done;
    const entry = found.entry;
    if (entry.step !== "code") throw new HttpError(400, "validation_failed", "This sign-in card isn't asking for a code.");
    const parsed = SignInCodeRequest.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "validation_failed", "Enter the code the site sent you.");
    const client = this.deps.service.client;
    if (!client) throw new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");
    entry.state = "sending";
    let change: Partial<Pending> & { state: CardState };
    try {
      const result = await this.deps.service.using(() => client.signInCode({ origin: entry.origin, code: parsed.data.code }));
      if (result.submitted) this.deps.service.requireSnapshot();
      change = this.codeOutcome(entry, result);
    } catch (error) {
      log.warn("sign-in code delivery failed", { kind: error instanceof ComputerError ? error.kind : "error" });
      change = { state: "failed", step: "code", reason: phrase("signin.failed") };
    }
    await this.finish(entry, change);
    return this.settled(entry, "sign_in_code", onDone);
  }

  /**
   * POST /api/computer/sign-in/:requestId/take-over ("Take control instead"): the user gets the
   * browser (ComputerService.take) and the card closes (expired, outcome taken_over). The assistant carries
   * on once they hand back. A take that fails leaves the card as it was.
   */
  async takeOver(userId: string, requestId: string): Promise<SignInResult> {
    const found = await this.usable(userId, requestId);
    if ("done" in found) return found.done;
    const entry = found.entry;
    const computer = await this.deps.service.take(userId);
    await this.finish(entry, { state: "expired", outcome: "taken_over", reason: null });
    this.deps.service.pause({ userId, channelId: entry.channelId, taskId: entry.taskId, kind: entry.kind }, "user_in_control", TAKEN_OVER_PROMPT);
    await this.deps.audit.record({ userId, action: "sign_in_take_over", actor: "user", target: entry.domain, outcome: "ok" });
    return this.answer(entry, computer);
  }

  /** POST /api/computer/sign-in/:requestId/dismiss ("Not now"): the card closes; the assistant carries on, told so. */
  async dismiss(userId: string, requestId: string, onDone?: Done): Promise<SignInResult> {
    const found = await this.usable(userId, requestId);
    if ("done" in found) return found.done;
    const entry = found.entry;
    await this.finish(entry, { state: "expired", outcome: "dismissed", reason: null });
    await this.deps.audit.record({ userId, action: "sign_in_dismiss", actor: "user", target: entry.domain, outcome: "ok" });
    if (onDone) {
      try {
        await onDone({ userId, channelId: entry.channelId, taskId: entry.taskId, kind: entry.kind });
      } catch (error) {
        log.warn("sign-in resume failed", { error: { name: (error as Error)?.name ?? "Error" } });
      }
    }
    return this.answer(entry);
  }

  /**
   * After a restart: pending requests lived in memory only, so a card still "pending" in the
   * database (and not known to this process) can never be sent; it turns "expired".
   */
  async recover(): Promise<number> {
    const rows = await this.deps.db.message.findMany({ where: { kind: "sign_in" }, select: { id: true, userId: true, payload: true }, take: 500, orderBy: { createdAt: "desc" } });
    let count = 0;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
      if (payload.state !== "pending" || typeof payload.requestId !== "string" || typeof payload.domain !== "string") continue;
      if (this.pending.has(payload.requestId)) continue;
      const done = await rewriteMessage(this.deps, row.userId, row.id, "sign_in", { ...payload, state: "expired" }).catch(() => false);
      if (done) count++;
    }
    return count;
  }

  /** Expired cards turn "expired" (run by the module's sweep). */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [id, entry] of [...this.pending]) {
      if (this.open(entry) && now > entry.expiresAt) await this.finish(entry, { state: "expired" });
      if (entry.state !== "pending" && entry.state !== "sending" && entry.state !== "failed" && now > entry.expiresAt + this.ttlMs) this.pending.delete(id);
    }
  }
}
