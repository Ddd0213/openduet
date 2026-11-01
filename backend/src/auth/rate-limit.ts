// Process-local sliding window; retries during a lock do not extend that lock.
const WINDOW_MS = 15 * 60 * 1000;
type Entry = { failures: number[]; lockedUntil: number };

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  private keys(ip: string, username: string): string[] {
    return [`ip:${ip}`, `pair:${JSON.stringify([ip, username.toLowerCase()])}`];
  }

  private clean(now: number): void {
    for (const [key, entry] of this.entries) {
      entry.failures = entry.failures.filter((time) => time > now - WINDOW_MS);
      if (!entry.failures.length && entry.lockedUntil <= now) this.entries.delete(key);
    }
  }

  /** Remaining lock duration rounded up to whole Retry-After seconds; zero permits a try. */
  retryAfter(ip: string, username: string): number {
    const now = this.now();
    this.clean(now);
    const until = Math.max(now, ...this.keys(ip, username).map((key) => this.entries.get(key)?.lockedUntil ?? 0));
    return Math.ceil((until - now) / 1000);
  }

  failure(ip: string, username: string): void {
    const now = this.now();
    this.clean(now);
    for (const key of [...this.keys(ip, username), `username:${username.toLowerCase()}`]) {
      const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
      entry.failures.push(now);
      if (!key.startsWith("username:") && entry.failures.length >= 5) {
        const seconds = Math.min(900, 2 ** Math.min(10, entry.failures.length - 5));
        entry.lockedUntil = now + seconds * 1000;
      }
      this.entries.set(key, entry);
    }
  }

  /** Username-only attempts delay verification, never reject a different IP. */
  slowdown(username: string): number {
    this.clean(this.now());
    const count = this.entries.get(`username:${username.toLowerCase()}`)?.failures.length ?? 0;
    return count < 5 ? 0 : Math.min(30, 2 ** Math.min(5, count - 5));
  }

  success(ip: string, username: string): void {
    this.clean(this.now());
    this.entries.delete(`pair:${JSON.stringify([ip, username.toLowerCase()])}`);
    this.entries.delete(`username:${username.toLowerCase()}`);
  }

  get size(): number {
    this.clean(this.now());
    return this.entries.size;
  }
}
