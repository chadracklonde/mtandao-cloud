/**
 * Fixed-window, in-memory rate limiter for the public portal. It is a best-effort
 * guard per API instance; the database enforces the hard per-phone and per-site caps.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxKeys = 10_000) {}

  /** Returns true when the call is allowed, false when the limit is exceeded. */
  allow(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
    this.sweep(now);
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  private sweep(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    // Still full of live windows: drop the oldest entries rather than grow without bound.
    if (this.windows.size >= this.maxKeys) {
      const excess = this.windows.size - this.maxKeys + 1;
      let removed = 0;
      for (const key of this.windows.keys()) {
        this.windows.delete(key);
        if (++removed >= excess) break;
      }
    }
  }
}
