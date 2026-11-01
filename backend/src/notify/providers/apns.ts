// APNs (L78): one alert per registered DeviceToken of the user, host by the token's environment
// (APNS_ENV is only the fallback). 410 and 400 BadDeviceToken delete the token.
// Logs never carry the token, the key or the text.
import { z } from "zod";
import type { Db } from "../../db.ts";
import { log } from "../../log.ts";
import { ApnsTokenCache } from "./apns-jwt.ts";
import { createHttp2Transport, type Http2Transport } from "./http2.ts";
import { sleep } from "./retry.ts";
import type { PushMessage, PushOutcome, PushProvider } from "./types.ts";
import { effectiveExpiresAt } from "../../contract/m28.ts";

export const APNS_HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;

export interface ApnsOptions {
  db: Db;
  keyId: string;
  teamId: string;
  key: string;
  topic: string;
  env: "production" | "sandbox" | null;
  transport?: Http2Transport;
  now?: () => Date;
  retryDelayMs?: number;
}

// Apple's documented error reasons; anything else is logged as "other" (third-party text stays out of logs).
const KNOWN_REASONS = new Set([
  "BadCollapseId", "BadDeviceToken", "BadExpirationDate", "BadMessageId", "BadPriority", "BadTopic",
  "DeviceTokenNotForTopic", "DuplicateHeaders", "IdleTimeout", "InvalidPushType", "MissingDeviceToken",
  "MissingTopic", "PayloadEmpty", "TopicDisallowed", "BadCertificate", "BadCertificateEnvironment",
  "ExpiredProviderToken", "Forbidden", "InvalidProviderToken", "MissingProviderToken", "UnrelatedKeyIdInToken",
  "BadPath", "MethodNotAllowed", "ExpiredToken", "Unregistered", "PayloadTooLarge", "TooManyProviderTokenUpdates",
  "TooManyRequests", "InternalServerError", "ServiceUnavailable", "Shutdown",
]);
const ApnsErrorBody = z.object({ reason: z.string().max(64) });

const reasonOf = (body: string): string | null => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = ApnsErrorBody.safeParse(json);
  if (!parsed.success) return null;
  return KNOWN_REASONS.has(parsed.data.reason) ? parsed.data.reason : "other";
};

export class ApnsProvider implements PushProvider {
  readonly name = "apns" as const;
  readonly badges = true;
  private readonly transport: Http2Transport;
  private readonly tokens: ApnsTokenCache;

  constructor(private readonly options: ApnsOptions) {
    this.transport = options.transport ?? createHttp2Transport();
    this.tokens = new ApnsTokenCache(options.key, options.keyId, options.teamId, options.now);
  }

  /**
   * M21: `collapseId` goes out as apns-collapse-id (a newer push for the same task / approval /
   * message replaces the older one on the device) and in the payload (the app matches it when it
   * withdraws). `passive` (quiet hours): interruption-level passive, no sound, priority 5.
   * M29: `badge` (the Waiting on you count) goes out as aps.badge; withdraw() never carries one.
   */
  async send(message: PushMessage): Promise<PushOutcome> {
    const aps: Record<string, unknown> = {
      alert: { title: message.title, body: message.body.slice(0, 1000) },
      ...(message.passive ? { "interruption-level": "passive" } : { sound: "default" }),
      ...(message.channelId ? { "thread-id": message.channelId } : {}),
      ...(message.badge !== undefined ? { badge: message.badge } : {}),
    };
    const body = JSON.stringify({ aps, route: message.route, ...(message.collapseId ? { collapseId: message.collapseId } : {}) });
    const headers: Record<string, string> = { "apns-push-type": "alert", "apns-priority": message.passive ? "5" : "10" };
    if (message.collapseId) headers["apns-collapse-id"] = message.collapseId;
    return this.toDevices(message.userId, body, headers);
  }

  /**
   * M21: takes back a delivered push: a silent background push (content-available, priority 5,
   * no alert) carrying `withdraw: [collapseId]`; the app calls removeDeliveredNotifications for
   * it. iOS may delay or drop background pushes (Low Power Mode, force-quit app): best effort.
   */
  async withdraw(userId: string, collapseId: string): Promise<PushOutcome> {
    const body = JSON.stringify({ aps: { "content-available": 1 }, withdraw: [collapseId] });
    return this.toDevices(userId, body, { "apns-push-type": "background", "apns-priority": "5" });
  }

  private async toDevices(userId: string, body: string, headers: Record<string, string>): Promise<PushOutcome> {
    const now = this.options.now?.() ?? new Date();
    const sessions = await this.options.db.session.findMany({ where: { userId, tokenHash: { not: null }, expiresAt: { gt: now } },
      select: { id: true, createdAt: true, expiresAt: true } });
    const live = sessions.filter(row => effectiveExpiresAt(row) > now).map(row => row.id);
    const devices = await this.options.db.deviceToken.findMany({ where: { userId, provider: "apns",
      OR: [{ sessionId: null }, { sessionId: { in: live } }] } });
    if (devices.length === 0) return "no_devices";
    let sent = false;
    for (const device of devices) {
      if (await this.deliver(device, body, headers)) sent = true;
    }
    return sent ? "sent" : "failed";
  }

  /** One device, at most one retry (expired provider token, 429, 5xx or a network error). */
  private async deliver(device: { id: string; token: string; environment: string }, body: string, pushHeaders: Record<string, string>): Promise<boolean> {
    // The token's own environment wins: a sandbox token sent to production is BadDeviceToken and
    // would be deleted. APNS_ENV only covers rows with an unknown value.
    const environment = device.environment === "sandbox" || device.environment === "production" ? device.environment : (this.options.env ?? "production");
    for (let attempt = 0; attempt < 2; attempt++) {
      let status = 0;
      let reason: string | null = null;
      try {
        const response = await this.transport.request({
          origin: APNS_HOSTS[environment],
          path: `/3/device/${device.token}`,
          headers: {
            authorization: `bearer ${await this.tokens.token()}`,
            "apns-topic": this.options.topic,
            ...pushHeaders,
          },
          body,
        });
        status = response.status;
        reason = reasonOf(response.body);
      } catch (error) {
        log.warn("push request failed", { provider: "apns", attempt, deviceId: device.id, error: { name: (error as Error).name } });
      }
      if (status === 200) return true;
      if (status === 410 || (status === 400 && reason === "BadDeviceToken")) {
        await this.options.db.deviceToken.deleteMany({ where: { id: device.id } });
        log.info("removed a dead APNs device token", { deviceId: device.id, status, reason });
        return false;
      }
      if (status !== 0) log.warn("push rejected", { provider: "apns", attempt, deviceId: device.id, status, reason });
      const expired = status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken");
      if (expired) this.tokens.reset();
      const retryable = expired || status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt === 1) return false;
      await sleep(this.options.retryDelayMs ?? 1000);
    }
    return false;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
