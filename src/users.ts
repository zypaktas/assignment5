// Zeynep Sudem Aktaş, 2025502009
import { type Conn, tuneConn } from "./db.ts";
import { tasks, users } from "./schema.ts";
import type { Role } from "./auth.ts";

export const WELCOME_TITLE = "Welcome! This is your first task";

/**
 * Bonus 2: the user and the welcome task are created in ONE transaction.
 * If anything inside throws, both inserts are rolled back and no user is left behind.
 * `afterUserInsert` is a hook for the tests: it lets a test make the second step fail.
 */
export async function createUserWithWelcomeTask(
  conn: Conn,
  v: { email: string; passwordHash: string; role: Role },
  hooks: { afterUserInsert?: () => void } = {},
): Promise<{ id: number; email: string; role: Role }> {
  try {
    return await conn.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values(v).returning();
      hooks.afterUserInsert?.();
      await tx.insert(tasks).values({
        userId: user.id,
        title: WELCOME_TITLE,
        priority: "low",
      });
      return { id: user.id, email: user.email, role: user.role };
    });
  } finally {
    await tuneConn(conn); // the client opened a fresh connection behind our back
  }
}
