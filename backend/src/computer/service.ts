// OpenDuet's computer as one shared state machine (one computer per deployment): the browser (off /
// starting / ready), who drives it (the assistant, or the user after Take over), the current page, human
// checks, each run's live browser card, and turns paused until the user hands the browser back.
import type { MessageDraft, RunKind } from "../agent/types.ts";
import type { ComputerState } from "../contract/computer.ts";
import type { BrowserBar } from "../contract/m27browser.ts";
import type { Message } from "../contract/messages.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import type { NotifyInput } from "../notify/notifier.ts";
import { collapseIdFor } from "../notify/triggers.ts";
import { postMessage } from "../tasks/thread.ts";
import type { AuditActor, AuditSink } from "./audit.ts";
import { activeUrl, BAR_AUDIT, type BarAction, barFromComputer, BING, engineFor, resolveAddress, UNSUPPORTED_BAR, type WebEngine } from "./browser-bar.ts";
import { ComputerError, type Challenge, type ComputerClient, type ControlState, type TabsResult } from "./client.ts";
import { rewriteMessage } from "./files.ts";
import { maskElements } from "./masking.ts";
import { domainOf, modelPageUrl, publicPageUrl } from "./paths.ts";

/** Starts a background turn that carries on after the user handed back or signed in (index.ts wires RunHost.submit). */
export type ContinueRun = (input: { userId: string; channelId: string; taskId: string | null; kind: RunKind; prompt: string }) => Promise<void>;
export type Notify = (input: NotifyInput) => Promise<unknown>;

export interface ComputerServiceDeps {
  db: Db;
  events: EventBus;
  client: ComputerClient | null;
  audit: AuditSink;
  notify?: Notify | null;
  continueRun?: ContinueRun | null;
  now?: () => number;
  /** after this long without an action the browser may have closed: probe /health first */
  probeAfterMs?: number;
  /** a live browser card with no action for this long turns "ended" */
  liveIdleMs?: number;
  /** COMPUTER_OWNER: the username the computer belongs to; unset = the first account */
  ownerUsername?: string | null;
  /** after Take over, this long with no input from the user's stream hands the browser back (tests: short) */
  handBackMs?: number;
  /** COMPUTER_START_URL: the start page for every region; unset = the user's engine's (engineFor) */
  startPageUrl?: string;
  /** a run holding the browser with no call for this long gives it to the next one waiting (tests: short) */
  leaseIdleMs?: number;
}

export interface TurnRef { userId: string; channelId: string; taskId: string | null; kind: RunKind; runId: string }
type CardSink = { upsertMessage(draft: MessageDraft): Promise<Message> };

interface LiveCard { messageId: string; userId: string; channelId: string; domain: string; lastAt: number }
interface Pause { channelId: string; taskId: string | null; kind: RunKind; reason: "user_in_control" | "human_check"; prompt?: string }

/** An element of the latest snapshot as the server keeps it (value already masked). */
export interface PageElement { ref: string; role: string; name: string; value?: unknown }

export const RESUME_PROMPT = "(OpenDuet's computer) The user handed the browser back to you. Take a fresh computer_snapshot first, then carry on with what you were doing. Don't repeat steps that are already done.";

/** M20: after Take over, this long without any input from the user hands the browser back. */
export const AUTO_HAND_BACK_MS = 10 * 60_000;

/**
 * M20: what a woken browser with no page (about:blank) opens, so the user who takes over sees a
 * page with a search box instead of white; also a new tab with nothing typed and the tab that
 * replaces the last one closed (M27). agent-computer only opens http(s) pages and has no page of
 * its own, so it's a real site. C2: by the user's region (engineFor): Bing for mainland China or
 * an unknown region (Bing answers there, Google and DuckDuckGo don't), Google elsewhere. This is
 * Bing's, the fallback. COMPUTER_START_URL picks one page for every region.
 */
export const START_PAGE_URL = BING.startPage;

/** Recent enough that the assistant is probably between two browser calls of the same turn. */
const BUSY_GRACE_MS = 15_000;

/**
 * One run uses the browser at a time (claimBrowser). Its refs, focus and the page are the run's
 * until its turn ends; a run that holds it this long without a browser call (thinking, other
 * tools) gives it to the next one waiting.
 */
export const BROWSER_LEASE_IDLE_MS = 3 * 60_000;

/** How long a tapped card (Approve, a sign-in card's Send) waits for a run using the browser; the tap's request is open meanwhile. */
export const CARD_BROWSER_WAIT_MS = 20_000;

/** The thread a run's refs carry over in: a task's own session, or a channel's thread. */
export const browserThread = (ref: { channelId: string; taskId: string | null }): string => (ref.taskId ? `task:${ref.taskId}` : `channel:${ref.channelId}`);

interface BrowserLease { owner: string; scope: string; calls: number; lastAt: number }
interface LeaseWaiter { owner: string; scope: string; grant: (granted: boolean) => void }

/** Recheck R4: the user's bar may open at most this many tabs (the assistant's own tabs count too). */
export const MAX_OPEN_TABS = 20;
/** Recheck R4: at most BAR_RATE_MAX bar actions in any BAR_RATE_WINDOW_MS (429 rate_limited). */
export const BAR_RATE_MAX = 30;
export const BAR_RATE_WINDOW_MS = 10_000;

const BLANK = (url: string | null | undefined) => !url || url === "about:blank" || url.startsWith("chrome://newtab") || url.startsWith("chrome://new-tab-page");

const unreachable = () => new HttpError(502, "internal", "OpenDuet's computer couldn't be reached. Try again in a moment.");

/** M27 browser: what a failed tab or navigate action tells the app. */
function barError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (!(error instanceof ComputerError)) return unreachable();
  if (error.kind === "conflict" || error.kind === "human_in_control") return new HttpError(409, "take_over_first", "Take over the browser first.");
  if (error.kind === "not_found") {
    return error.body?.noSuchTab === true
      ? new HttpError(404, "not_found", "That tab has closed.")
      : new HttpError(501, "tabs_unsupported", "OpenDuet's computer needs an update for tabs.");
  }
  if (error.kind === "bad_request") return new HttpError(400, "validation_failed", "address: not a web address", "address");
  return unreachable();
}

export class ComputerService {
  private browser: ComputerState["browser"] = "off";
  private reachable = true;
  private controller: ComputerState["controller"] = "assistant";
  /** Full address without credentials, kept in memory for the assistant and page checks. */
  private url: string | null = null;
  /** Origin + path only: the address that may leave this service as ComputerState. */
  private stateUrl: string | null = null;
  private blocked: ComputerState["blocked"] = null;
  /** the user who took over */
  private holder: string | null = null;
  /** the computer's handoff request id while the user drives */
  private requestId: string | null = null;
  /** the user whose app gets `computer` events (the last one who used it) */
  private owner: string | null = null;
  private lastActionAt = 0;
  private snapshotNeeded = false;
  private snapshotId: number | undefined;
  private waiting = 0;
  private readonly releaseWaiters = new Set<(handedBack: boolean) => void>();
  private readonly listeners = new Set<(state: ComputerState) => void>();
  private readonly live = new Map<string, LiveCard>();
  private readonly alerted = new Set<string>();
  /** user id -> thread (browserThread) -> the turn that stopped there, oldest first: each is carried on at the hand back */
  private readonly pauses = new Map<string, Map<string, Pause>>();
  private lastEmitted = "";
  private emitting: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly probeAfterMs: number;
  private readonly liveIdleMs: number;
  /** M20: the latest snapshot's elements by ref (values masked) and its page, for the consequential-click check */
  private elements = new Map<string, PageElement>();
  private snapshotUrl: string | null = null;
  /**
   * what the last type / click focused: a ref, or "unknown" (a key moved focus, or a snapshot /
   * navigation / hand back since: the page's focus is somewhere the server can't name)
   */
  private focused: string = "unknown";
  /** browser / shell calls running right now (sleep refuses while any is) */
  private inFlight = 0;
  /** when the user last sent input through the live screen (auto hand back) */
  private lastUserInputAt = 0;
  private startingPage = false;
  private readonly handBackMs: number;
  /** COMPUTER_START_URL, when set: wins over the region's start page */
  private readonly startPageOverride: string | null;
  /** the run (or approved call / sign-in card) using the browser now, and the ones waiting, first come first */
  private lease: BrowserLease | null = null;
  private leaseWaiters: LeaseWaiter[] = [];
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly leaseIdleMs: number;
  /** the thread that used the browser last: a claim from another thread gets a fresh page */
  private lastLeaseScope: string | null = null;
  /** owners whose idle lease went to someone else: their refs are stale if they come back */
  private readonly leaseTakenFrom = new Set<string>();
  /**
   * Another thread used the browser since the model last saw the page (a snapshot or a navigation
   * shown to it). Unlike needsSnapshot, a silent snapshot doesn't clear it: the model still holds
   * the old refs.
   */
  private handedOver = false;

  constructor(private readonly deps: ComputerServiceDeps) {
    this.leaseIdleMs = deps.leaseIdleMs ?? BROWSER_LEASE_IDLE_MS;
    this.now = deps.now ?? Date.now;
    this.probeAfterMs = deps.probeAfterMs ?? 60_000;
    this.liveIdleMs = deps.liveIdleMs ?? 3 * 60_000;
    this.handBackMs = deps.handBackMs ?? AUTO_HAND_BACK_MS;
    this.startPageOverride = deps.startPageUrl || null;
  }

  /**
   * C2: the search engine for `userId`'s region, else (a woken browser, nobody named) the user in
   * control or the computer's owner. Bing when the region is unknown or can't be read.
   */
  private async engineOf(userId?: string | null): Promise<WebEngine> {
    const id = userId ?? this.holder ?? this.owner ?? this.ownerId ?? await this.resolveOwner().catch(() => null);
    if (!id) return BING;
    const row = await this.deps.db.user.findUnique({ where: { id }, select: { region: true } }).catch(() => null);
    return engineFor(row?.region);
  }

  /** The start page: COMPUTER_START_URL, else the region's engine's. */
  private startPageOf(engine: WebEngine): string {
    return this.startPageOverride ?? engine.startPage;
  }

  get configured(): boolean {
    return !!this.deps.client;
  }

  /** the resolved owner's user id (cached; looked up again when another account asks) */
  private ownerId: string | null = null;

  /**
   * One owner per deployment (prompt L46, L138): the browser, its logins and /workspace are one
   * person's, so only that account gets the computer. Everyone else sees it as not set up.
   */
  async allows(userId: string): Promise<boolean> {
    if (!this.deps.client) return false;
    if (this.ownerId === userId) return true;
    this.ownerId = await this.resolveOwner();
    return this.ownerId === userId;
  }

  private async resolveOwner(): Promise<string | null> {
    const username = this.deps.ownerUsername;
    const row = username
      ? await this.deps.db.user.findUnique({ where: { username }, select: { id: true } })
      : await this.deps.db.user.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    return row?.id ?? null;
  }

  /** What another account (or a server without a computer) is shown. */
  static offState(): ComputerState {
    return { available: false, browser: "off", controller: "assistant", url: null, domain: null, blocked: null };
  }

  get client(): ComputerClient | null {
    return this.deps.client;
  }

  setContinueRun(continueRun: ContinueRun | null): void {
    this.deps.continueRun = continueRun;
  }

  state(): ComputerState {
    return {
      available: this.configured && this.reachable,
      browser: this.configured && this.reachable ? this.browser : "off",
      controller: this.controller,
      url: this.stateUrl,
      domain: domainOf(this.stateUrl),
      blocked: this.blocked,
    };
  }

  /** The user drives the browser (Take over): the assistant's tools pause. */
  get userInControl(): boolean {
    return this.controller === "user";
  }

  get isBlocked(): boolean {
    return this.blocked !== null;
  }

  /** After a hand back (or the computer's 409): the next action takes a fresh snapshot first. */
  get needsSnapshot(): boolean {
    return this.snapshotNeeded;
  }

  get latestSnapshotId(): number | undefined {
    return this.snapshotId;
  }

  subscribe(listener: (state: ComputerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  noteOwner(userId: string): void {
    this.owner = userId;
  }

  /**
   * Emits `computer` to the owner (and the user in control) and tells the stream sockets, when something changed.
   * An unchanged state waits for the last emit, so `await changed()` after a fire-and-forget one (noteBar)
   * still means the event is stored.
   */
  async changed(): Promise<void> {
    const state = this.state();
    const text = JSON.stringify(state);
    if (text === this.lastEmitted) return this.emitting;
    this.lastEmitted = text;
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* a closed socket */ }
    }
    this.emitting = this.emitState(state);
    return this.emitting;
  }

  private async emitState(state: ComputerState): Promise<void> {
    for (const userId of new Set([this.owner, this.holder].filter((u): u is string => !!u))) {
      await this.deps.events.emit(userId, null, "computer", { computer: state }).catch((error: unknown) => {
        log.warn("computer event failed", { error: { name: (error as Error)?.name ?? "Error" } });
      });
    }
  }

  /** GET /api/computer: health + control from the computer. Never throws. */
  async refresh(userId?: string): Promise<ComputerState> {
    if (userId && !this.owner) this.owner = userId;
    const client = this.deps.client;
    if (!client) return this.state();
    try {
      const health = await client.health();
      this.reachable = true;
      this.browser = health.browser ? "ready" : "off";
      this.syncControl(await client.control());
    } catch (error) {
      if (error instanceof ComputerError && (error.kind === "unreachable" || error.kind === "timeout" || error.kind === "unauthorized")) this.reachable = false;
    }
    await this.changed();
    return this.state();
  }

  /**
   * da9a3ca recoveryRequired: a restart or stop interrupted a page the user was driving, and the
   * computer refuses the assistant's actions until someone takes the browser and hands it back (no longer
   * set for a request nobody took). The assistant stops and asks the user to look.
   */
  private recovering = false;
  get needsRecovery(): boolean {
    return this.recovering;
  }

  /** Mirrors the computer's own control state (it persists across restarts). */
  syncControl(control: ControlState): void {
    const wasUser = this.controller === "user";
    this.recovering = control.holder === "bot" && control.recoveryRequired === true;
    if (control.holder === "human") {
      this.controller = "user";
      if (control.request?.id) this.requestId = control.request.id;
      // Held since before a restart: the idle clock starts now, not at 0.
      if (!wasUser && this.lastUserInputAt === 0) this.lastUserInputAt = this.now();
    } else {
      this.controller = "assistant";
      this.holder = null;
      this.requestId = null;
      if (wasUser) this.wakeWaiters();
    }
    if (this.blocked && control.holder === "bot" && !control.requested) this.blocked = null;
    // A help request the computer opened itself for a challenge (Cloudflare / visible CAPTCHA).
    const source = control.request?.source;
    if (control.holder === "bot" && control.requested && (source === "cloudflare" || source === "visible-challenge")) this.blocked = "human_check";
    if (control.resumeSnapshotRequired) this.requireSnapshot();
  }

  /**
   * Before a browser action: probes the browser when it may have closed while idle. Returns true when
   * it's starting up (status "Waking OpenDuet's workspace").
   */
  async wake(): Promise<boolean> {
    const client = this.deps.client;
    if (!client) return false;
    if (this.browser === "ready" && this.now() - this.lastActionAt < this.probeAfterMs) return false;
    try {
      const health = await client.health();
      this.reachable = true;
      this.browser = health.browser ? "ready" : "starting";
    } catch {
      return false;
    }
    await this.changed();
    return this.browser === "starting";
  }

  /** Every source of a page address updates both views at the same boundary. */
  private rememberUrl(url: string | null | undefined): void {
    if (!url) return;
    this.url = modelPageUrl(url);
    this.stateUrl = publicPageUrl(this.url);
  }

  /** After a successful browser action. */
  async acted(url: string | null | undefined): Promise<void> {
    this.reachable = true;
    this.browser = "ready";
    this.lastActionAt = this.now();
    this.rememberUrl(url);
    await this.changed();
  }

  async failed(error: unknown): Promise<void> {
    if (error instanceof ComputerError && (error.kind === "unreachable" || error.kind === "timeout")) {
      this.reachable = error.kind === "timeout";
      if (error.kind === "unreachable") this.browser = "off";
      await this.changed();
    }
  }

  /**
   * A fresh snapshot: its id (refs are checked against it), its page and, M20, its elements by ref
   * (values masked), which the consequential-click check reads. Without elements the old ones are
   * dropped: refs from before don't name anything any more.
   */
  noteSnapshot(snapshotId: number | undefined, url?: string | null, elements?: readonly PageElement[]): void {
    this.snapshotNeeded = false;
    if (snapshotId !== undefined) this.snapshotId = snapshotId;
    this.rememberUrl(url);
    this.snapshotUrl = this.url;
    this.elements = new Map(maskElements(elements ?? []).map((e) => [e.ref, { ref: e.ref, role: e.role, name: e.name, ...(e.value === undefined ? {} : { value: e.value }) }]));
    // A snapshot doesn't move focus, but it renames every ref: whatever was focused has no name now.
    this.focused = "unknown";
  }

  /** A navigation opened a new document: the computer retired every ref, so the server forgets them too. */
  notePage(url: string | null | undefined): void {
    this.rememberUrl(url);
    this.snapshotUrl = this.url;
    this.elements = new Map();
    this.focused = "unknown";
  }

  /** The computer said a fresh snapshot is needed (409 after a hand back or restart): old refs are gone. */
  requireSnapshot(): void {
    this.snapshotNeeded = true;
    this.elements = new Map();
    this.focused = "unknown";
  }

  /** The latest snapshot's element for this ref; null when that snapshot has none (stale or unknown). */
  elementOf(ref: string): PageElement | null {
    return this.elements.get(ref) ?? null;
  }

  /** The latest snapshot's elements (for re-finding a button by role and name). */
  get snapshotElements(): PageElement[] {
    return [...this.elements.values()];
  }

  /** The page the latest snapshot (or action) was on. */
  get pageUrl(): string | null {
    return this.url ?? this.snapshotUrl;
  }

  /** After a type / click: that element has focus (a bare Enter acts on it). "unknown" after a key moved focus. */
  noteFocus(ref: string | "unknown"): void {
    this.focused = ref;
  }

  get focusedRef(): string {
    return this.focused;
  }

  // ------------------------------------------------------------------ busy (sleep) and the start page

  /** Runs one browser / shell call, counted as in flight (sleep and the start page wait for none). */
  async using<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await run();
    } finally {
      this.inFlight--;
    }
  }

  /** Is someone using the browser: a call in flight, a tool waiting, the user driving, a human check, or the assistant mid-turn? */
  get busy(): boolean {
    return this.inFlight > 0 || this.waiting > 0 || this.controller === "user" || this.blocked !== null
      || (this.lastActionAt > 0 && this.now() - this.lastActionAt < BUSY_GRACE_MS);
  }

  /**
   * POST /api/computer/sleep: closes the browser now (agent-computer /computers/stop; the profile
   * and its logins stay). 409 computer_busy while the assistant uses it or the user is in control.
   */
  async sleep(userId: string): Promise<ComputerState> {
    const client = this.need();
    if (this.holder && this.holder !== userId) throw new HttpError(409, "computer_busy", "Someone else is using OpenDuet's computer right now.");
    await this.refresh(userId).catch(() => undefined);
    if (this.busy) throw new HttpError(409, "computer_busy", this.controller === "user" ? "You're using OpenDuet's browser. Hand it back first." : "OpenDuet is using its browser right now. Try again when it's done.");
    await this.call(() => client.stopBrowser());
    this.browser = "off";
    // The computer retires every ref and wants a fresh snapshot before the next page action.
    this.requireSnapshot();
    for (const [runId, card] of [...this.live]) if (card.userId === userId) await this.endLive(runId);
    this.owner = userId;
    await this.deps.audit.record({ userId, action: "sleep", actor: "user", target: domainOf(this.url) ?? "", outcome: "ok" });
    await this.changed();
    return this.state();
  }

  /**
   * A woken browser with no page opens the start page, so whoever takes over sees something to
   * start from. Only while the assistant holds the browser, nothing else is running and the page is blank
   * (the computer itself puts a handoff's page back when there is one). Best effort, never throws.
   */
  async openStartPage(): Promise<void> {
    const client = this.deps.client;
    if (!client || this.startingPage || this.busy || this.recovering) return;
    this.startingPage = true;
    try {
      const page = await this.using(() => client.read());
      if (!BLANK(page.url) || this.busy) return;
      const control = await client.control();
      if (control.holder !== "bot" || control.requested || control.recoveryRequired) return;
      // C2: the owner's region picks the page (one owner per deployment, see allows()).
      const startPage = this.startPageOf(await this.engineOf());
      const opened = await this.using(async () => {
        // After a restart the computer wants a snapshot before a navigation; a blank page's is cheap.
        if (control.resumeSnapshotRequired) {
          const snap = await client.snapshot();
          this.noteSnapshot(snap.snapshotId, snap.url);
        }
        return client.navigate(startPage);
      });
      // The page changed under any refs the assistant had: its next ref-based call takes a fresh look.
      this.requireSnapshot();
      this.reachable = true;
      this.browser = "ready";
      this.rememberUrl(opened.url);
      await this.changed();
    } catch (error) {
      log.warn("start page failed", { kind: error instanceof ComputerError ? error.kind : "error" });
    } finally {
      this.startingPage = false;
    }
  }

  // ------------------------------------------------------------------ take over / hand back

  private need(): ComputerClient {
    if (!this.deps.client) throw new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");
    return this.deps.client;
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ComputerError) {
        if (error.kind === "conflict") throw new HttpError(409, "stale_version", "OpenDuet's computer is busy. Try again in a moment.");
        throw unreachable();
      }
      throw error;
    }
  }

  /** POST /api/computer/take: the user drives; the assistant's tools wait. */
  async take(userId: string): Promise<ComputerState> {
    const client = this.need();
    if (this.holder && this.holder !== userId) throw new HttpError(409, "stale_version", "Someone else is using OpenDuet's computer right now.");
    let control = await this.call(() => client.control());
    if (control.holder !== "human") {
      let request = control.request && control.request.status === "waiting" ? control.request : undefined;
      if (!request) {
        control = await this.call(() => client.requestControl("The user took over from the app."));
        request = control.request && (control.request.status === "waiting" || control.request.status === "taken") ? control.request : undefined;
      }
      if (!request) throw unreachable();
      const id = request.id;
      control = control.holder === "human" ? control : await this.call(() => client.take(id));
    }
    this.syncControl(control);
    this.controller = "user";
    this.holder = userId;
    this.owner = userId;
    this.requestId = control.request?.id ?? this.requestId;
    this.lastUserInputAt = this.now();
    await this.deps.audit.record({ userId, action: "take_over", actor: "user", target: domainOf(this.url) ?? "", outcome: "ok" });
    await this.changed();
    return this.state();
  }

  /** POST /api/computer/release: back to the assistant, who takes a fresh snapshot before acting. */
  release(userId: string): Promise<ComputerState> {
    return this.handBack(userId, "user");
  }

  /** The user's taps, typing and scrolls on the live screen (keeps the auto hand back away). */
  noteUserInput(): void {
    this.lastUserInputAt = this.now();
  }

  // ------------------------------------------------------------------ M27 browser: the app's own bar

  private lastBar: BrowserBar | null = null;
  /** Recheck R4: when the user's last bar actions ran (a sliding window, BAR_RATE_*). */
  private barActs: number[] = [];
  /** Recheck P2-2: bar "new tab" requests sent to the computer and not answered yet. */
  private newTabsInFlight = 0;

  /**
   * GET /api/computer/tabs: what the bar shows, at any time (read-only while the assistant drives); starts
   * nothing. A computer from before patch 0006 answers 404: supported false (address only).
   */
  async browserBar(): Promise<BrowserBar> {
    const client = this.need();
    try {
      return this.noteBar(barFromComputer(await client.tabs()));
    } catch (error) {
      if (error instanceof ComputerError && error.kind === "not_found") return UNSUPPORTED_BAR;
      throw unreachable();
    }
  }

  /**
   * The bar as the computer last told it (an answer or the stream). While the user drives, their
   * page is the computer's page: the top bar's domain follows it, and the assistant's refs from before are
   * gone (it takes a fresh snapshot after the hand back either way).
   */
  noteBar(bar: BrowserBar): BrowserBar {
    this.lastBar = bar;
    const url = activeUrl(bar);
    if (this.controller === "user" && url && url !== this.url) {
      this.notePage(url);
      void this.changed();
    }
    return bar;
  }

  /**
   * POST /api/computer/tabs (new), /tabs/:id/activate, /tabs/:id/close and /navigate: the user's
   * bar, only after they took over (409 take_over_first otherwise). Counted as their input (the
   * auto hand back stays away), audited with the page's domain (never what they typed), and in
   * flight for Sleep. Closing the last tab opens the start page in its place.
   */
  async browserAct(userId: string, action: BarAction): Promise<BrowserBar> {
    const client = this.need();
    if (this.controller !== "user" || (this.holder && this.holder !== userId))
      throw new HttpError(409, "take_over_first", "Take over the browser first.");
    // Recheck R4: a runaway app loop (or a stolen token) can't open tabs without end or hammer the
    // computer. Far above what a person taps; each renderer costs memory in the computer's 2 GB.
    const at = this.now();
    this.barActs = this.barActs.filter((t) => at - t < BAR_RATE_WINDOW_MS);
    if (this.barActs.length >= BAR_RATE_MAX) throw new HttpError(429, "rate_limited", "Too many browser actions. Wait a moment.");
    this.barActs.push(at);
    this.noteUserInput();
    // C2: words are searched, and a blank tab opens, with the engine of the user's region.
    const engine = await this.engineOf(userId);
    const startPage = this.startPageOf(engine);
    const typed = action.kind === "new" || action.kind === "navigate" ? action.address : undefined;
    const resolved = typed === undefined ? undefined : resolveAddress(typed, engine.searchUrl);
    const closing = action.kind === "close" ? this.lastBar?.tabs.find((tab) => tab.id === action.tabId)?.url : undefined;
    const audit = (outcome: "ok" | "error", url: string | null | undefined) =>
      this.deps.audit.record({ userId, action: BAR_AUDIT[action.kind], actor: "user", target: domainOf(url ?? null) ?? "", outcome });
    // Recheck R4/P2-2: at most MAX_OPEN_TABS, counting new tabs still on their way (concurrent +), and
    // asking the computer when the backend holds no bar yet (after a restart). No await between the
    // check and the count, so two requests can't both take the last place.
    const opening = action.kind === "new";
    if (opening) {
      if (!this.lastBar) await this.browserBar().catch(() => undefined);
      if ((this.lastBar?.tabs.length ?? 0) + this.newTabsInFlight >= MAX_OPEN_TABS)
        throw new HttpError(409, "conflict", `At most ${MAX_OPEN_TABS} tabs can be open. Close one first.`);
      this.newTabsInFlight++;
    }
    let answer: TabsResult;
    try {
      answer = await this.using(() => {
        switch (action.kind) {
          case "new": return client.tabAction({ action: "new", url: resolved?.url ?? startPage });
          case "activate": return client.tabAction({ action: "activate", tabId: action.tabId });
          case "close": return client.tabAction({ action: "close", tabId: action.tabId, replaceWith: startPage });
          case "navigate": return client.browserNavigate({ url: resolved!.url });
          default: return client.browserNavigate({ action: action.kind });
        }
      });
    } catch (error) {
      await audit("error", resolved?.url ?? closing ?? this.url);
      if (error instanceof ComputerError && error.kind === "conflict") void this.refresh().catch(() => undefined);
      throw barError(error);
    } finally {
      // Before noteBar below with no await in between: the new tab is counted in the bar from then on.
      if (opening) this.newTabsInFlight--;
    }
    this.noteUserInput();
    this.reachable = true;
    this.browser = "ready";
    const bar = this.noteBar(barFromComputer(answer));
    await audit("ok", resolved?.url ?? closing ?? activeUrl(bar));
    await this.changed();
    return bar;
  }

  /**
   * M20: after Take over, AUTO_HAND_BACK_MS with no input from the user's live screen hands the
   * browser back to the assistant (the app was killed, the phone lost signal, the user walked away), with a
   * grey line in the thread of the turn that waits for it (the main thread if none). Run by the sweep.
   */
  async autoHandBack(): Promise<boolean> {
    if (this.controller !== "user" || !this.deps.client) return false;
    if (this.now() - this.lastUserInputAt < this.handBackMs) return false;
    const userId = this.holder ?? this.owner ?? (this.ownerId || null);
    if (!userId) return false;
    // The line goes to the thread that stopped last (the others are carried on all the same).
    const pause = [...(this.pauses.get(userId)?.values() ?? [])].at(-1);
    const thread = pause ?? await this.deps.db.channel.findFirst({ where: { userId, isMain: true }, select: { id: true } }).then((c) => (c ? { channelId: c.id, taskId: null } : null));
    try {
      await this.handBack(userId, "system");
    } catch (error) {
      log.warn("auto hand back failed", { error: { name: (error as Error)?.name ?? "Error" } });
      return false;
    }
    if (this.controller === "user") return false;
    if (thread) {
      const minutes = Math.max(1, Math.round(this.handBackMs / 60_000));
      await postMessage(this.deps.db, this.deps.events, {
        userId, channelId: thread.channelId, taskId: thread.taskId, role: "system", kind: "system", text: "",
        payload: { phrase: { key: "computer.auto_handback", params: { minutes: { type: "number", value: minutes } } } },
      }).catch((error: unknown) => log.warn("auto hand back line failed", { error: { name: (error as Error)?.name ?? "Error" } }));
    }
    return true;
  }

  private async handBack(userId: string, actor: AuditActor): Promise<ComputerState> {
    const client = this.need();
    if (this.holder && this.holder !== userId) throw new HttpError(409, "stale_version", "Someone else is using OpenDuet's computer right now.");
    let control = await this.call(() => client.control());
    const id = control.request?.id ?? this.requestId;
    if (control.holder === "human" && id) {
      try {
        control = await client.release(id);
      } catch (error) {
        if (!(error instanceof ComputerError) || error.kind !== "conflict") return this.call(() => Promise.reject(error));
        control = await this.call(() => client.control());
        if (control.holder === "human") throw new HttpError(409, "stale_version", "OpenDuet's computer is busy. Try again in a moment.");
      }
    }
    const wasUser = this.controller === "user";
    this.syncControl(control);
    this.controller = control.holder === "human" ? "user" : "assistant";
    if (this.controller === "assistant") {
      this.holder = null;
      this.requestId = null;
      this.blocked = control.requested ? this.blocked : null;
      this.requireSnapshot();
      this.wakeWaiters();
    }
    this.owner = userId;
    if (wasUser) await this.deps.audit.record({ userId, action: actor === "user" ? "hand_back" : "auto_hand_back", actor, target: domainOf(this.url) ?? "", outcome: "ok" });
    await this.changed();
    if (this.controller === "assistant") await this.resume(userId);
    return this.state();
  }

  private wakeWaiters(handedBack = true): void {
    for (const wake of [...this.releaseWaiters]) wake(handedBack);
  }

  /** Waits until the user hands back. true = handed back, false = timed out or aborted. */
  waitForRelease(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.controller !== "user") return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    this.waiting++;
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.releaseWaiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        this.waiting--;
        resolve(value);
      };
      const wake = (handedBack: boolean) => done(handedBack);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), ms);
      this.releaseWaiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ------------------------------------------------------------------ one run at a time

  /**
   * Before a browser call: waits until `owner` (a run id, or an approved call / sign-in card) has the
   * browser. There is one browser and one set of refs (the latest snapshot's), so two runs that
   * interleave would click each other's refs and the consequential-click check would read the other
   * run's page. The owner keeps it until releaseBrowser (its turn ended); while it holds it, others
   * wait in order. One that has made no call for leaseIdleMs gives it to the next. Every claim must
   * be followed by doneWithBrowser. false = timed out or aborted (nothing claimed).
   */
  claimBrowser(owner: string, scope: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.lease?.owner === owner) {
      this.lease.calls++;
      this.lease.lastAt = Date.now();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const giveUp = () => {
        this.leaseWaiters = this.leaseWaiters.filter((w) => w !== waiter);
        waiter.grant(false);
      };
      const waiter: LeaseWaiter = {
        owner, scope,
        grant: (granted) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", giveUp);
          resolve(granted);
        },
      };
      timer = setTimeout(giveUp, ms);
      signal?.addEventListener("abort", giveUp, { once: true });
      this.leaseWaiters.push(waiter);
      this.pumpLease();
    });
  }

  /** One claimed call is over (the owner may still hold the browser for its next one). */
  doneWithBrowser(owner: string): void {
    if (this.lease?.owner !== owner) return;
    this.lease.calls = Math.max(0, this.lease.calls - 1);
    this.lease.lastAt = Date.now();
    this.pumpLease();
  }

  /** The owner's turn ended: the browser goes to the next one waiting; its own waits end. */
  releaseBrowser(owner: string): void {
    this.leaseTakenFrom.delete(owner);
    const mine = this.leaseWaiters.filter((w) => w.owner === owner);
    if (mine.length) this.leaseWaiters = this.leaseWaiters.filter((w) => w.owner !== owner);
    for (const waiter of mine) waiter.grant(false);
    if (this.lease?.owner !== owner) return;
    this.lease = null;
    this.pumpLease();
  }

  /** One call outside a turn (an approved card, a sign-in card): claimed, run, released. null = still busy after `ms`. */
  async withBrowser<T>(owner: string, scope: string, ms: number, work: () => Promise<T>): Promise<{ done: T } | null> {
    if (!(await this.claimBrowser(owner, scope, ms))) return null;
    try {
      return { done: await work() };
    } finally {
      this.releaseBrowser(owner);
    }
  }

  /** Another thread used the browser since the model last saw the page: its refs, focus and page are gone. */
  get refsStale(): boolean {
    return this.handedOver;
  }

  /** The model was just shown the page as it is (a snapshot, a navigation). */
  pageSeen(): void {
    this.handedOver = false;
  }

  private takeLease(waiter: LeaseWaiter): void {
    // Another thread's refs, or this owner coming back after its idle lease went to someone else.
    const cameBack = this.leaseTakenFrom.delete(waiter.owner);
    if ((this.lastLeaseScope !== null && this.lastLeaseScope !== waiter.scope) || cameBack) {
      this.handedOver = true;
      this.requireSnapshot();
    }
    this.lastLeaseScope = waiter.scope;
    this.lease = { owner: waiter.owner, scope: waiter.scope, calls: 1, lastAt: Date.now() };
    waiter.grant(true);
  }

  /** Hands a free browser to the first one waiting, or one held idle past leaseIdleMs. */
  private pumpLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    const next = this.leaseWaiters[0];
    if (!next) return;
    const held = this.lease;
    if (held) {
      if (held.calls > 0) return; // doneWithBrowser pumps again
      const idleFor = Date.now() - held.lastAt;
      if (idleFor < this.leaseIdleMs) {
        // Each waiter's own timeout keeps the process up while it waits; this one alone shouldn't.
        this.leaseTimer = setTimeout(() => this.pumpLease(), this.leaseIdleMs - idleFor);
        this.leaseTimer.unref?.();
        return;
      }
      log.info("browser lease taken from an idle run", { idleMs: idleFor });
      this.leaseTakenFrom.add(held.owner);
    }
    this.leaseWaiters.shift();
    this.takeLease(next);
  }

  // ------------------------------------------------------------------ pauses

  /**
   * A turn ended waiting for the user (in control, or a human check): carry on once they hand back,
   * with `prompt` (default RESUME_PROMPT; the sign-in card's Take over has its own).
   */
  pause(turn: Pick<TurnRef, "userId" | "channelId" | "taskId" | "kind">, reason: Pause["reason"], prompt?: string): void {
    // A Make build isn't carried on as a bare run: its artifact bookkeeping lives in the build's own
    // hooks (backend B), so a stopped build ends there and the user refreshes it.
    if (turn.kind === "build") return;
    // One per thread: two tasks stopped by the same Take over are both carried on. Set again, it moves to the end.
    const threads = this.pauses.get(turn.userId) ?? new Map<string, Pause>();
    const thread = browserThread(turn);
    threads.delete(thread);
    threads.set(thread, { channelId: turn.channelId, taskId: turn.taskId, kind: turn.kind, reason, ...(prompt ? { prompt } : {}) });
    this.pauses.set(turn.userId, threads);
  }

  /** May this user's taps and typing reach the browser? Only while they (or, after a restart, anyone) hold it. */
  canDrive(userId: string): boolean {
    return this.controller === "user" && (this.holder === null || this.holder === userId);
  }

  /** Starts the background turn that carries on (after a sign-in card was sent). */
  async carryOn(input: { userId: string; channelId: string; taskId: string | null; kind: RunKind; prompt: string }): Promise<void> {
    if (!this.deps.continueRun || input.kind === "build") return;
    try {
      await this.deps.continueRun(input);
    } catch (error) {
      log.warn("computer resume failed", { error: { name: (error as Error)?.name ?? "Error" } });
    }
  }

  /** A newer turn of this thread is using the computer: nothing left to carry on there. Other threads keep theirs. */
  clearPause(turn: Pick<TurnRef, "userId" | "channelId" | "taskId">): void {
    const threads = this.pauses.get(turn.userId);
    if (!threads) return;
    threads.delete(browserThread(turn));
    if (threads.size === 0) this.pauses.delete(turn.userId);
  }

  /** The hand back: every thread that stopped for it carries on, oldest first (each queues for the browser). */
  private async resume(userId: string): Promise<void> {
    const threads = this.pauses.get(userId);
    if (!threads || !this.deps.continueRun) return;
    this.pauses.delete(userId);
    for (const pause of threads.values()) {
      try {
        await this.deps.continueRun({ userId, channelId: pause.channelId, taskId: pause.taskId, kind: pause.kind, prompt: pause.prompt ?? RESUME_PROMPT });
      } catch (error) {
        log.warn("computer resume failed", { error: { name: (error as Error)?.name ?? "Error" } });
      }
    }
  }

  // ------------------------------------------------------------------ human checks (L144)

  /**
   * The computer reported a CAPTCHA / Cloudflare challenge: the assistant stops, the chat gets the
   * single-action alert card (once per challenge) and a notification. Nothing tries to solve it.
   */
  async humanCheck(turn: TurnRef, sink: CardSink, challenge: Challenge, url: string | null | undefined): Promise<string> {
    this.rememberUrl(url);
    this.blocked = "human_check";
    this.owner = turn.userId;
    const domain = domainOf(this.url) ?? "This site";
    const key = challenge.requestId ?? `${domain}:${Math.floor(this.now() / 600_000)}`;
    if (!this.alerted.has(key)) {
      if (this.alerted.size > 200) this.alerted.clear();
      this.alerted.add(key);
      const body = { key: "alert.human_check", params: { domain: { type: "text" as const, value: domain } } };
      const card = await sink.upsertMessage({
        role: "assistant", kind: "alert",
        payload: { title: { key: "alert.one_thing" }, body, action: { label: { key: "alert.open_browser" }, type: "open_browser", url: null, toolkit: null } },
      });
      // M29: the only push for it (triggers.ts skips open_browser alerts), keyed by the card.
      try {
        await this.deps.notify?.({ userId: turn.userId, channelId: turn.channelId, body, route: "duet://computer", collapseId: collapseIdFor.message(card.id) });
      } catch (error) {
        log.warn("human check notification failed", { error: { name: (error as Error)?.name ?? "Error" } });
      }
    }
    await this.deps.audit.record({ userId: turn.userId, action: "human_check", actor: "system", target: domain, outcome: "denied", runId: turn.runId });
    this.pause(turn, "human_check");
    await this.changed();
    return domain;
  }

  // ------------------------------------------------------------------ live browser card (L143)

  /** One live browser card per run; it follows the domain and the user's other live cards end. */
  async liveCard(turn: TurnRef, sink: CardSink, url: string | null | undefined): Promise<void> {
    // A Make build shows its progress in the Build view, not as a card in the channel.
    if (turn.kind === "build") return;
    const domain = domainOf(url ?? this.url);
    if (!domain) return;
    const existing = this.live.get(turn.runId);
    if (existing) {
      existing.lastAt = this.now();
      if (existing.domain !== domain) {
        existing.domain = domain;
        await sink.upsertMessage({ id: existing.messageId, role: "assistant", kind: "live_browser", payload: { domain, state: "live" } });
      }
      return;
    }
    for (const [runId, card] of [...this.live]) if (card.userId === turn.userId) await this.endLive(runId);
    const message = await sink.upsertMessage({ role: "assistant", kind: "live_browser", payload: { domain, state: "live" } });
    this.live.set(turn.runId, { messageId: message.id, userId: turn.userId, channelId: turn.channelId, domain, lastAt: this.now() });
  }

  touchLive(runId: string): void {
    const card = this.live.get(runId);
    if (card) card.lastAt = this.now();
  }

  async endLive(runId: string): Promise<void> {
    const card = this.live.get(runId);
    if (!card) return;
    this.live.delete(runId);
    try {
      await rewriteMessage(this.deps, card.userId, card.messageId, "live_browser", { domain: card.domain, state: "ended" });
    } catch (error) {
      log.warn("live card update failed", { error: { name: (error as Error)?.name ?? "Error" } });
    }
  }

  /** Ends live cards nobody has acted through for a while (not while a tool waits for the user). */
  async sweep(): Promise<void> {
    if (this.waiting > 0 || this.controller === "user") return;
    const cutoff = this.now() - this.liveIdleMs;
    for (const [runId, card] of [...this.live]) if (card.lastAt <= cutoff) await this.endLive(runId);
  }

  /** Cards left "live" by a previous process turn "ended". */
  async recover(): Promise<number> {
    const rows = await this.deps.db.message.findMany({ where: { kind: "live_browser" }, select: { id: true, userId: true, payload: true }, take: 500, orderBy: { createdAt: "desc" } });
    let count = 0;
    for (const row of rows) {
      let payload: { domain?: unknown; state?: unknown };
      try { payload = JSON.parse(row.payload) as typeof payload; } catch { continue; }
      if (payload.state !== "live" || typeof payload.domain !== "string") continue;
      if ([...this.live.values()].some((c) => c.messageId === row.id)) continue;
      if (await rewriteMessage(this.deps, row.userId, row.id, "live_browser", { domain: payload.domain, state: "ended" }).catch(() => false)) count++;
    }
    return count;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.recover().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
      void this.autoHandBack().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wakeWaiters(false);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    const waiting = this.leaseWaiters;
    this.leaseWaiters = [];
    for (const waiter of waiting) waiter.grant(false);
  }
}
