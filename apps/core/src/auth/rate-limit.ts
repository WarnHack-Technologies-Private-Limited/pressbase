/**
 * Fixed-window limiter for login attempts, keyed by IP + login name.
 * In memory, so it resets on restart and is per process — enough to stop
 * casual brute forcing until a shared store arrives with the job queue.
 */
export class RateLimiter {
  #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds until the key may try again, or 0 when it is not limited. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  hit(key: string, now = Date.now()): void {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.#hits.size > 10_000) this.#prune(now);
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.#hits.delete(key);
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#hits) if (entry.resetAt <= now) this.#hits.delete(key);
  }
}
