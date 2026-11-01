// NOTIFY_PROVIDER -> the remote push provider (null: notifications are local only).
import type { Db } from "../../db.ts";
import type { NotifyConfig } from "../config.ts";
import { ApnsProvider } from "./apns.ts";
import { BarkProvider } from "./bark.ts";
import type { Http2Transport } from "./http2.ts";
import { NtfyProvider } from "./ntfy.ts";
import type { FetchLike, PushProvider } from "./types.ts";

export interface ProviderDeps {
  db: Db;
  /** test seams; default to fetch / node:http2 */
  fetch?: FetchLike;
  transport?: Http2Transport;
  now?: () => Date;
  retryDelayMs?: number;
}

export function createPushProvider(config: NotifyConfig, deps: ProviderDeps): PushProvider | null {
  switch (config.provider) {
    case null: return null;
    case "apns": return new ApnsProvider({ ...config, db: deps.db, transport: deps.transport, now: deps.now, retryDelayMs: deps.retryDelayMs });
    case "ntfy": return new NtfyProvider({ ...config, fetch: deps.fetch, retryDelayMs: deps.retryDelayMs });
    case "bark": return new BarkProvider({ ...config, fetch: deps.fetch, retryDelayMs: deps.retryDelayMs });
  }
}

export type { FetchLike, PushMessage, PushOutcome, PushProvider } from "./types.ts";
export type { Http2Transport } from "./http2.ts";
