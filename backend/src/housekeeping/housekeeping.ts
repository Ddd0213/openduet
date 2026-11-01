// Hourly cleanup (M2 leftovers):
// - Event log: per user, keep the newest MAX_REPLAY events and everything from the last 7 days.
// - Uploads that were never sent with a message (ChannelFile.messageId = null, source "user")
//   older than 24 h: the row and the bytes. The row goes first with the same guard as
//   DELETE /api/files/:id, so a file attached to a message at that moment is never removed.
import type { Db } from "../db.ts";
import { MAX_REPLAY } from "../events/bus.ts";
import type { FileStore } from "../files/store.ts";
import { log } from "../log.ts";
import { convertLegacySessions } from "../auth/sessions.ts";

export const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
export const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface HousekeepingDeps {
  db: Db;
  files: FileStore;
  now?: () => Date;
  intervalMs?: number;
  /** defaults: MAX_REPLAY events, 7 days, 24 hours */
  keepEvents?: number;
  eventMaxAgeMs?: number;
  uploadMaxAgeMs?: number;
}

export interface HousekeepingResult {
  events: number; uploads: number; convertedSessions: number; legacyExpiredSessions: number;
  expiredSessions: number; expiredDeviceTokens: number; orphanDeviceTokens: number;
}

export class Housekeeping {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<HousekeepingResult> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: HousekeepingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Runs once now, then every intervalMs (default hourly). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? HOUSEKEEPING_INTERVAL_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; overlapping calls share the pass in progress. */
  tick(): Promise<HousekeepingResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<HousekeepingResult> {
    const result: HousekeepingResult = { events: 0, uploads: 0, convertedSessions: 0, legacyExpiredSessions: 0,
      expiredSessions: 0, expiredDeviceTokens: 0, orphanDeviceTokens: 0 };
    try {
      const converted = await convertLegacySessions(this.deps.db, this.now());
      result.convertedSessions = converted.converted;
      result.legacyExpiredSessions = converted.expired;
      Object.assign(result, await this.pruneSessions());
    } catch (error) {
      log.error("session cleanup failed", { error: { name: (error as Error).name } });
    }
    try {
      result.events = await this.pruneEvents();
    } catch (error) {
      log.error("event cleanup failed", { error: { name: (error as Error).name } });
    }
    try {
      result.uploads = await this.pruneUploads();
    } catch (error) {
      log.error("upload cleanup failed", { error: { name: (error as Error).name } });
    }
    if (Object.values(result).some(Boolean)) log.info("housekeeping", { ...result });
    return result;
  }

  private async pruneSessions() {
    return this.deps.db.$transaction(async tx => {
      const now = this.now();
      const expired = await tx.session.findMany({ where: { expiresAt: { lte: now } }, select: { id: true } });
      const expiredDeviceTokens = (await tx.deviceToken.deleteMany({ where: { sessionId: { in: expired.map(row => row.id) } } })).count;
      const expiredSessions = (await tx.session.deleteMany({ where: { expiresAt: { lte: now } } })).count;
      // sessionId is deliberately not a foreign key: CLI deletes and user cascades can leave orphans.
      const orphanDeviceTokens = await tx.$executeRaw`DELETE FROM "DeviceToken" WHERE "sessionId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Session" WHERE "Session"."id" = "DeviceToken"."sessionId")`;
      return { expiredSessions, expiredDeviceTokens, orphanDeviceTokens };
    });
  }

  private async pruneEvents(): Promise<number> {
    const { db } = this.deps;
    const keep = this.deps.keepEvents ?? MAX_REPLAY;
    const cutoff = new Date(this.now().getTime() - (this.deps.eventMaxAgeMs ?? EVENT_MAX_AGE_MS));
    let removed = 0;
    for (const { id: userId } of await db.user.findMany({ select: { id: true } })) {
      // The oldest event among the newest `keep`; anything below it is outside the replay window.
      const floor = await db.event.findFirst({ where: { userId }, orderBy: { id: "desc" }, skip: keep - 1, select: { id: true } });
      if (!floor) continue;
      removed += (await db.event.deleteMany({ where: { userId, id: { lt: floor.id }, createdAt: { lt: cutoff } } })).count;
    }
    return removed;
  }

  private async pruneUploads(): Promise<number> {
    const { db, files } = this.deps;
    const cutoff = new Date(this.now().getTime() - (this.deps.uploadMaxAgeMs ?? UPLOAD_MAX_AGE_MS));
    const stale = await db.channelFile.findMany({ where: { messageId: null, source: "user", createdAt: { lt: cutoff } }, select: { id: true, path: true }, take: 500 });
    let removed = 0;
    for (const file of stale) {
      const gone = await db.channelFile.deleteMany({ where: { id: file.id, messageId: null } });
      if (gone.count === 0) continue;
      removed++;
      try {
        await files.remove(file.path);
      } catch (error) {
        log.warn("could not remove an unsent upload's bytes", { fileId: file.id, error: { name: (error as Error).name } });
      }
    }
    return removed;
  }
}
