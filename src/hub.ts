// Zeynep Sudem Aktaş, 2025502009
// Bonus 13: user id -> that user's open WebSockets. A change goes to its owner only.

/** The small part of a WebSocket that the hub needs (a fake in the tests). */
export type Socket = { send(data: string): void };

export type TaskEvent = {
  type: "task.created" | "task.updated" | "task.deleted" | "task.restored";
  task: unknown;
};

export class Hub {
  #sockets = new Map<number, Set<Socket>>();

  add(userId: number, socket: Socket): void {
    const set = this.#sockets.get(userId) ?? new Set<Socket>();
    set.add(socket);
    this.#sockets.set(userId, set);
  }

  remove(userId: number, socket: Socket): void {
    const set = this.#sockets.get(userId);
    set?.delete(socket);
    if (set?.size === 0) this.#sockets.delete(userId);
  }

  count(userId: number): number {
    return this.#sockets.get(userId)?.size ?? 0;
  }

  /** Send to the sockets of one user, never to everyone. */
  broadcast(userId: number, event: TaskEvent): void {
    const message = JSON.stringify(event);
    for (const s of this.#sockets.get(userId) ?? []) {
      try {
        s.send(message);
      } catch {
        // a socket that just closed: onclose removes it
      }
    }
  }
}
