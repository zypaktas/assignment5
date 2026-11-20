// Zeynep Sudem Aktaş, 2025502009
import { and, count, eq, isNull, lt } from "drizzle-orm";
import type { Conn, Db } from "./db.ts";
import { STATUSES, tasks, users } from "./schema.ts";
import { removeFile } from "./uploads.ts";

/**
 * The one rule of the task routes: every query includes the owner (and skips soft-deleted
 * rows). Another user's task is then simply "not found". Only Drizzle operators are used,
 * so user input always travels as a parameter and never inside the SQL text.
 */
export const own = (id: number, userId: number) =>
  and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt));

export type Summary = {
  todo: number;
  "in-progress": number;
  done: number;
  total: number;
};

const emptySummary = (): Summary => ({
  "todo": 0,
  "in-progress": 0,
  "done": 0,
  total: 0,
});

// ---- Bonus 3: Joins and the N+1 problem -------------------------------------------------

/** GOOD: one GROUP BY query, whatever the data looks like. */
export async function summaryGood(conn: Conn, userId: number): Promise<Summary> {
  const rows = await conn.db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .groupBy(tasks.status);
  const out = emptySummary();
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

/** NAIVE: load every task (1 query), then one more count query for each status. */
export async function summaryNaive(conn: Conn, userId: number): Promise<Summary> {
  const all = await conn.db.select().from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)));
  const out = emptySummary();
  for (const status of STATUSES) {
    const [row] = await conn.db.select({ n: count() }).from(tasks)
      .where(
        and(eq(tasks.userId, userId), isNull(tasks.deletedAt), eq(tasks.status, status)),
      );
    out[status] = row.n;
  }
  out.total = all.length;
  return out;
}

export type UserWithCount = {
  id: number;
  email: string;
  role: "user" | "admin";
  createdAt: number;
  taskCount: number;
};

/** GOOD: one LEFT JOIN + GROUP BY gives every user and the number of their tasks. */
export async function adminUsersJoin(conn: Conn): Promise<UserWithCount[]> {
  return await conn.db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      taskCount: count(tasks.id),
    })
    .from(users)
    .leftJoin(tasks, and(eq(tasks.userId, users.id), isNull(tasks.deletedAt)))
    .groupBy(users.id)
    .orderBy(users.id);
}

/** NAIVE (the classic N+1): 1 query for the users, then 1 count query for EACH user. */
export async function adminUsersNaive(conn: Conn): Promise<UserWithCount[]> {
  const all = await conn.db.select().from(users).orderBy(users.id);
  const out: UserWithCount[] = [];
  for (const u of all) {
    const [row] = await conn.db.select({ n: count() }).from(tasks)
      .where(and(eq(tasks.userId, u.id), isNull(tasks.deletedAt)));
    out.push({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      taskCount: row.n,
    });
  }
  return out;
}

// ---- Bonus 14: the job that Deno.cron runs ------------------------------------------------

/**
 * Delete tasks that were done more than `days` days ago. Returns how many rows were removed.
 * Idempotent: the second run finds nothing, so it changes nothing.
 */
export async function purgeOldDone(
  db: Db,
  days: number,
  uploadDir?: string,
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
  return await db.pool.use(async (conn) => {
    const removed = await conn.db.delete(tasks)
      .where(and(eq(tasks.status, "done"), lt(tasks.completedAt, cutoff)))
      .returning({ id: tasks.id, attachment: tasks.attachment });
    if (uploadDir) { for (const r of removed) await removeFile(uploadDir, r.attachment); }
    return removed.length;
  });
}
