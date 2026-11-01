// M22 (#47): what this server has set up, one row per dependency (GET /api/setup), and a check that
// tries each set-up row (POST /api/setup/check): one tiny model call through llm/stream(), one
// search through the search module, the computer's health, the push provider's own config (signs
// an APNs token; never sends a push). Apps and voice need no try: they are ready when set up.
// Status: ready | not_checked (set up, not tried since boot or since it changed: the model row
// keeps a fingerprint of its entry, provider and key rows) | needs_setup (detail says why).
// Check results and the rate limit live in memory. A row never carries a secret's value, a key
// prefix or a URL: only phrase keys, env variable names, counts and the model's own label.
import type { z } from "zod";
import type { Phrase } from "../contract/common.ts";
import { SetupInfo } from "../contract/m22.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import type { NotifyConfig } from "../notify/config.ts";
import { signApnsJwt } from "../notify/providers/apns-jwt.ts";
import type { WebSearchResult } from "../web/search.ts";
import { searchOffered, SEARCH_NAMES, type BuiltinConfig } from "../builtins/config.ts";

type Item = z.infer<typeof SetupInfo>["items"][number];
type Fix = NonNullable<Item["fix"]>;
type CheckId = "model" | "search" | "computer" | "push";

/** At most one check per user in this window (429 rate_limited). */
export const CHECK_WINDOW_MS = 30_000;
/** Each try's own deadline, so the check answers in a bounded time (the model's: models.ts). */
const SEARCH_TIMEOUT_MS = 31_000; // Exa and Parallel each have a 15 s deadline.
const COMPUTER_TIMEOUT_MS = 5_000;
/** Listing Composio accounts for the apps row (GET and check). */
const APPS_TIMEOUT_MS = 5_000;
/** A neutral query: one search that shows the provider answers. */
export const CHECK_QUERY = "weather";

/** A try's outcome: ok, or why it failed and how to fix it. */
export type Outcome = { ok: true } | { ok: false; detail: Phrase; fix?: Fix | null };

/** What the setup rows need from the models module (models/index.ts builds the real one). */
export interface SetupModels {
  /** the user's default chat model when it's usable (label shown in the row; fingerprint = its rows' versions) */
  chat(userId: string): Promise<{ label: string; fingerprint: string; serverWebTools: boolean } | null>;
  /** one tiny call through llm/stream() on that model */
  ping(userId: string): Promise<Outcome>;
  /** the realtime voice model calls would use (its label), or null */
  voice(userId: string): Promise<{ label: string } | null>;
}

export interface SetupDeps {
  db: Db;
  config: Pick<Config, "COMPOSIO_API_KEY" | "COMPUTER_URL" | "COMPUTER_TOKEN"> & BuiltinConfig;
  /** NOTIFY_PROVIDER's settings as loaded at startup */
  notify: NotifyConfig;
  models: SetupModels;
  /** the user's Composio accounts; null without COMPOSIO_API_KEY */
  apps: { accounts(userId: string): Promise<{ toolkit: string; status: string }[]>; refresh?(userId: string): void } | null;
  /** OpenDuet's computer; null without COMPUTER_URL / COMPUTER_TOKEN */
  computer: { allows(userId: string): Promise<boolean>; probe(): Promise<{ ok: boolean }> } | null;
  /** web_search's own function (web/search.ts); tests pass a fake */
  search: (query: string, signal: AbortSignal) => Promise<WebSearchResult>;
  /** the push provider's own config is valid (default: pushConfigOk); never sends anything */
  pushOk?: (config: NotifyConfig) => Promise<boolean>;
  now?: () => Date;
}

interface Result { at: Date; fingerprint: string; outcome: Outcome }

const text = (value: string) => ({ type: "text" as const, value });
const number = (value: number) => ({ type: "number" as const, value });
const say = (key: string, params?: Phrase["params"]): Phrase => (params ? { key, params } : { key });
const route = (path: string): Fix => ({ kind: "route", route: path });
const env = (names: string[], hint = "setup.hint.env"): Fix => ({ kind: "env", names, hint: say(hint) });

const PUSH_NAMES: Record<NonNullable<NotifyConfig["provider"]>, string> = { apns: "APNs", ntfy: "ntfy", bark: "Bark" };
/** backend/.env.example's names per push provider */
const PUSH_ENV: Record<NonNullable<NotifyConfig["provider"]>, string[]> = {
  apns: ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY", "APNS_TOPIC"],
  ntfy: ["NTFY_URL", "NTFY_TOPIC", "NTFY_TOKEN"],
  bark: ["BARK_URL", "BARK_DEVICE_KEY", "BARK_ENCRYPTION_KEY", "BARK_ENCRYPTION_IV"],
};

/** The push provider's own settings hold together: APNs signs a provider token with its .p8 key. Sends nothing. */
export async function pushConfigOk(config: NotifyConfig): Promise<boolean> {
  switch (config.provider) {
    case null: return false;
    case "apns":
      try {
        await signApnsJwt(config.key, config.keyId, config.teamId, new Date());
        return !!config.topic;
      } catch {
        return false;
      }
    case "ntfy": return /^https?:\/\//.test(config.url) && !!config.topic;
    case "bark": return /^https?:\/\//.test(config.url) && !!config.deviceKey && [16, 24, 32].includes(Buffer.byteLength(config.encryptionKey)) && Buffer.byteLength(config.encryptionIv) === 16;
  }
}

/** A promise with a deadline: null when it doesn't settle in time. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export type CheckAnswer = { limited: false; info: SetupInfo } | { limited: true; retryAfterSeconds: number };

export class SetupService {
  /** userId -> row -> its last try */
  private readonly results = new Map<string, Map<CheckId, Result>>();
  private readonly lastCheck = new Map<string, number>();

  constructor(private readonly deps: SetupDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** GET /api/setup: the rows as they stand (no try, except listing the user's apps). */
  async info(userId: string): Promise<SetupInfo> {
    const items = await Promise.all([
      this.modelRow(userId), this.searchRow(userId), this.appsRow(userId), this.computerRow(userId), this.pushRow(userId), this.voiceRow(userId),
    ]);
    return SetupInfo.parse({ items });
  }

  /** POST /api/setup/check: tries every set-up row, then answers like info(); limited within CHECK_WINDOW_MS. */
  async check(userId: string): Promise<CheckAnswer> {
    const at = this.now().getTime();
    const last = this.lastCheck.get(userId);
    if (last !== undefined && at - last < CHECK_WINDOW_MS) return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((CHECK_WINDOW_MS - (at - last)) / 1000)) };
    // Stamped first: two taps at once run one check.
    this.lastCheck.set(userId, at);
    await Promise.all([this.tryModel(userId), this.trySearch(userId), this.tryComputer(userId), this.tryPush(userId)]);
    // The apps row lists the accounts afresh (not the catalog's cached list).
    this.deps.apps?.refresh?.(userId);
    return { limited: false, info: await this.info(userId) };
  }

  private result(userId: string, id: CheckId, fingerprint: string): Result | null {
    const found = this.results.get(userId)?.get(id);
    return found && found.fingerprint === fingerprint ? found : null;
  }

  private store(userId: string, id: CheckId, fingerprint: string, outcome: Outcome): void {
    const rows = this.results.get(userId) ?? new Map<CheckId, Result>();
    rows.set(id, { at: this.now(), fingerprint, outcome });
    this.results.set(userId, rows);
  }

  /** A checkable row once set up: not_checked until tried (or after it changed), then the try's outcome. */
  private tried(base: Pick<Item, "id" | "required" | "title">, ready: Phrase, last: Result | null): Item {
    if (!last) return { ...base, status: "not_checked", detail: ready, fix: null, checkedAt: null };
    if (last.outcome.ok) return { ...base, status: "ready", detail: ready, fix: null, checkedAt: last.at.toISOString() };
    return { ...base, status: "needs_setup", detail: last.outcome.detail, fix: last.outcome.fix ?? null, checkedAt: last.at.toISOString() };
  }

  // ---------------------------------------------------------------- rows

  private async modelRow(userId: string): Promise<Item> {
    const base = { id: "model" as const, required: true, title: say("setup.model.title") };
    const chat = await this.deps.models.chat(userId);
    if (!chat) return { ...base, status: "needs_setup", detail: say("setup.model.missing"), fix: route("duet://settings/models"), checkedAt: null };
    return this.tried(base, say("setup.model.ready", { model: text(chat.label) }), this.result(userId, "model", chat.fingerprint));
  }

  private async searchRow(userId: string): Promise<Item> {
    const base = { id: "search" as const, required: false, title: say("setup.search.title") };
    const provider = this.deps.config.SEARCH_PROVIDER;
    if (!searchOffered(this.deps.config)) {
      // The default model searches the web itself (Features.webSearch counts it too).
      const chat = await this.deps.models.chat(userId);
      if (chat?.serverWebTools) return { ...base, status: "ready", detail: say("setup.search.model", { model: text(chat.label) }), fix: null, checkedAt: null };
      return { ...base, status: "needs_setup", detail: say("setup.search.missing"), fix: env(["SEARCH_PROVIDER", "SEARCH_API_KEY", "SEARXNG_URL"]), checkedAt: null };
    }
    const detail = provider ? say("setup.search.ready", { provider: text(SEARCH_NAMES[provider]) }) : say("setup.search.keyless", { provider: text("Exa"), fallback: text("Parallel") });
    return this.tried(base, detail, this.result(userId, "search", provider ?? "keyless"));
  }

  /**
   * Nothing to try: ready once Composio is set up and an app is connected (the detail counts them).
   * Set up with no app connected yet: not_checked with Apps as the fix (docs/api-samples/m22.json).
   */
  private async appsRow(userId: string): Promise<Item> {
    const base = { id: "apps" as const, required: false, title: say("setup.apps.title") };
    if (!this.deps.apps) return { ...base, status: "needs_setup", detail: say("setup.apps.missing"), fix: env(["COMPOSIO_API_KEY"]), checkedAt: null };
    const accounts = await within(APPS_TIMEOUT_MS, this.deps.apps.accounts(userId).catch((error: unknown) => {
      log.warn("setup: listing apps failed", { error: { name: (error as Error)?.name ?? "Error" } });
      return null;
    }));
    if (!accounts) return { ...base, status: "needs_setup", detail: say("setup.apps.failed"), fix: env(["COMPOSIO_API_KEY"]), checkedAt: null };
    const connected = new Set(accounts.filter((a) => a.status === "active").map((a) => a.toolkit)).size;
    if (connected === 0) return { ...base, status: "not_checked", detail: say("setup.apps.none"), fix: route("duet://settings/apps"), checkedAt: null };
    return { ...base, status: "ready", detail: say("setup.apps.ready", { count: number(connected) }), fix: null, checkedAt: null };
  }

  private async computerRow(userId: string): Promise<Item> {
    const base = { id: "computer" as const, required: false, title: say("setup.computer.title") };
    const computer = this.deps.computer;
    if (!computer) return { ...base, status: "needs_setup", detail: say("setup.computer.missing"), fix: env(["COMPUTER_URL", "COMPUTER_TOKEN"]), checkedAt: null };
    if (!(await computer.allows(userId).catch(() => false))) {
      return { ...base, status: "needs_setup", detail: say("setup.computer.not_yours"), fix: env(["COMPUTER_OWNER"]), checkedAt: null };
    }
    return this.tried(base, say("setup.computer.ready"), this.result(userId, "computer", "computer"));
  }

  private async pushRow(userId: string): Promise<Item> {
    const base = { id: "push" as const, required: false, title: say("setup.push.title") };
    const provider = this.deps.notify.provider;
    if (!provider) return { ...base, status: "needs_setup", detail: say("setup.push.missing"), fix: env(["NOTIFY_PROVIDER"], "setup.hint.push"), checkedAt: null };
    // APNs pushes go to each phone that registered; ntfy and Bark to their one topic / device key.
    const ready = provider === "apns"
      ? say("setup.push.devices", { service: text(PUSH_NAMES.apns), count: number(await this.deps.db.deviceToken.count({ where: { userId, provider: "apns" } })) })
      : say("setup.push.ready", { service: text(PUSH_NAMES[provider]) });
    return this.tried(base, ready, this.result(userId, "push", provider));
  }

  /** Ready when a realtime model exists (nothing to try: a call starts it). */
  private async voiceRow(userId: string): Promise<Item> {
    const base = { id: "voice" as const, required: false, title: say("setup.voice.title") };
    const voice = await this.deps.models.voice(userId);
    if (!voice) return { ...base, status: "needs_setup", detail: say("setup.voice.missing"), fix: route("duet://settings/voice"), checkedAt: null };
    return { ...base, status: "ready", detail: say("setup.voice.ready", { model: text(voice.label) }), fix: null, checkedAt: null };
  }

  // ---------------------------------------------------------------- tries (POST /api/setup/check)

  private async tryModel(userId: string): Promise<void> {
    const chat = await this.deps.models.chat(userId);
    if (!chat) return;
    const outcome = await this.deps.models.ping(userId).catch((): Outcome => ({ ok: false, detail: say("system.model_network") }));
    this.store(userId, "model", chat.fingerprint, outcome.ok ? outcome : { ...outcome, fix: outcome.fix ?? route("duet://settings/models") });
  }

  private async trySearch(userId: string): Promise<void> {
    const provider = this.deps.config.SEARCH_PROVIDER;
    if (!searchOffered(this.deps.config)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let ok = false;
    try {
      ok = !(await this.deps.search(CHECK_QUERY, controller.signal)).isError;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    const keyless = !provider || provider === "exa" || provider === "parallel";
    const names = keyless ? ["SEARCH_PROVIDER", "BUILTIN_CONNECTORS_OFF"] : ["SEARCH_PROVIDER", provider === "searxng" ? "SEARXNG_URL" : "SEARCH_API_KEY"];
    this.store(userId, "search", provider ?? "keyless", ok ? { ok: true } : { ok: false, detail: say("setup.search.failed", { provider: text(provider ? SEARCH_NAMES[provider] : "Exa / Parallel") }), fix: env(names) });
  }

  private async tryComputer(userId: string): Promise<void> {
    const computer = this.deps.computer;
    if (!computer || !(await computer.allows(userId).catch(() => false))) return;
    const health = await within(COMPUTER_TIMEOUT_MS, computer.probe().catch(() => ({ ok: false })));
    this.store(userId, "computer", "computer", health?.ok ? { ok: true } : { ok: false, detail: say("setup.computer.failed"), fix: route("duet://computer") });
  }

  private async tryPush(userId: string): Promise<void> {
    const config = this.deps.notify;
    if (!config.provider) return;
    const ok = await (this.deps.pushOk ?? pushConfigOk)(config).catch(() => false);
    this.store(userId, "push", config.provider, ok ? { ok: true } : { ok: false, detail: say("setup.push.failed", { service: text(PUSH_NAMES[config.provider]) }), fix: env(PUSH_ENV[config.provider]) });
  }
}
