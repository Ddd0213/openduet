// A single registry for SSE responses and computer WebSockets, keyed by their login session.
import { effectiveExpiresAt, SESSION_STREAM_CHECK_MS } from "../contract/m28.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

export class SessionConnections {
  private readonly sessions = new Map<string, Set<() => void>>();
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(private readonly db: Db) {}

  register(sessionId: string, close: () => void): () => void {
    const callbacks = this.sessions.get(sessionId) ?? new Set<() => void>();
    callbacks.add(close);
    this.sessions.set(sessionId, callbacks);
    return () => {
      callbacks.delete(close);
      if (!callbacks.size && this.sessions.get(sessionId) === callbacks) this.sessions.delete(sessionId);
    };
  }

  close(ids: Iterable<string>): void {
    for (const id of ids) {
      const callbacks = this.sessions.get(id);
      this.sessions.delete(id);
      for (const close of callbacks ?? []) {
        try { close(); } catch (error) {
          log.warn("session connection close failed", { error: { name: (error as Error).name } });
        }
      }
    }
  }

  async sweep(db: Db = this.db): Promise<void> {
    const ids = [...this.sessions.keys()];
    if (!ids.length) return;
    const now = new Date();
    const rows = await db.session.findMany({ where: { id: { in: ids }, tokenHash: { not: null }, expiresAt: { gt: now } },
      select: { id: true, createdAt: true, expiresAt: true } });
    const live = new Set(rows.filter(row => effectiveExpiresAt(row) > now).map(row => row.id));
    this.close(ids.filter(id => !live.has(id)));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      void this.sweep().catch(error => {
        log.warn("session connection sweep failed", { error: { name: (error as Error).name } });
      }).finally(() => { this.sweeping = false; });
    }, SESSION_STREAM_CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.close([...this.sessions.keys()]);
  }
}
