// Zeynep Sudem Aktaş, 2025502009
// Bonus 16: cache GET /api/tasks/:id for 60 seconds in Deno KV.
import type { Task } from "./schema.ts";

export const CACHE_SECONDS = 60;

/**
 * The key contains the user id, so one user can never be served another user's cached task.
 * Without a KV store (kv is undefined) the cache does nothing and every read hits the database.
 */
export class TaskCache {
  constructor(private kv?: Deno.Kv) {}

  #key(userId: number, id: number): Deno.KvKey {
    return ["task", userId, id];
  }

  async get(userId: number, id: number): Promise<Task | null> {
    if (!this.kv) return null;
    return (await this.kv.get<Task>(this.#key(userId, id))).value;
  }

  async set(userId: number, id: number, task: Task): Promise<void> {
    await this.kv?.set(this.#key(userId, id), task, { expireIn: CACHE_SECONDS * 1000 });
  }

  /** Call after every update, delete, restore and upload, so a changed task is not stale. */
  async invalidate(userId: number, id: number): Promise<void> {
    await this.kv?.delete(this.#key(userId, id));
  }
}
