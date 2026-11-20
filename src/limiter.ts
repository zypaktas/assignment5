// Zeynep Sudem Aktaş, 2025502009
// Bonus 15: after `max` failed logins for one email inside a window, answer 429.

export type LimiterOptions = {
  max?: number;
  windowMs?: number;
  /** a clock the tests can control */
  now?: () => number;
};

export class LoginLimiter {
  #fails = new Map<string, { n: number; reset: number }>();
  #max: number;
  #windowMs: number;
  #now: () => number;

  constructor(o: LimiterOptions = {}) {
    this.#max = o.max ?? 5;
    this.#windowMs = o.windowMs ?? 60_000;
    this.#now = o.now ?? Date.now;
  }

  /** Seconds the caller must wait, or 0 when a login attempt is allowed. */
  retryAfter(key: string): number {
    const e = this.#fails.get(key);
    if (!e || e.reset <= this.#now() || e.n < this.#max) return 0;
    return Math.max(1, Math.ceil((e.reset - this.#now()) / 1000));
  }

  recordFailure(key: string): void {
    const now = this.#now();
    const e = this.#fails.get(key);
    if (!e || e.reset <= now) {
      this.#sweep(now);
      this.#fails.set(key, { n: 1, reset: now + this.#windowMs });
    } else e.n++;
  }

  /** A successful login clears the counter. */
  clear(key: string): void {
    this.#fails.delete(key);
  }

  // Without this, many different emails would make the map grow for ever.
  #sweep(now: number): void {
    if (this.#fails.size < 1000) return;
    for (const [k, v] of this.#fails) if (v.reset <= now) this.#fails.delete(k);
  }
}
