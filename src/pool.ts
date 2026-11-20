// Zeynep Sudem Aktaş, 2025502009
// Bonus 6 (option B): a small generic pool that I wrote myself.

/**
 * A pool hands out a fixed set of items (here: database connections).
 * `acquire()` gives an idle item or waits in a queue, `release()` gives the item to the
 * next waiter, and `use(fn)` always releases in a `finally`.
 */
export class Pool<T> {
  #idle: T[];
  #waiting: ((item: T) => void)[] = [];
  readonly size: number;

  constructor(items: T[]) {
    this.#idle = [...items];
    this.size = items.length;
  }

  /** How many items are free right now (used by the tests and the README). */
  get idleCount(): number {
    return this.#idle.length;
  }

  /** How many callers are waiting for an item. */
  get waitingCount(): number {
    return this.#waiting.length;
  }

  acquire(): Promise<T> {
    if (this.#idle.length > 0) return Promise.resolve(this.#idle.pop() as T);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  release(item: T): void {
    const next = this.#waiting.shift();
    if (next) next(item); // hand it straight to the next waiter
    else this.#idle.push(item);
  }

  async use<R>(fn: (item: T) => Promise<R>): Promise<R> {
    const item = await this.acquire();
    try {
      return await fn(item);
    } finally {
      this.release(item); // always give it back
    }
  }
}
