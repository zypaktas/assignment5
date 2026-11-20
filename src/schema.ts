// Zeynep Sudem Aktaş, 2025502009
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Worked example: the users table.
export const ROLES = ["user", "admin"] as const;

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ROLES }).notNull().default("user"),
  // A SQL default runs for every row. A JavaScript Date.now() here would run once.
  createdAt: integer("created_at").notNull().default(sql`(strftime('%s','now'))`),
});

export const STATUSES = ["todo", "in-progress", "done"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: text("due_date"), // optional "YYYY-MM-DD"
  status: text("status", { enum: STATUSES }).notNull().default("todo"),
  priority: text("priority", { enum: PRIORITIES }).notNull().default("medium"),
  createdAt: integer("created_at").notNull().default(sql`(strftime('%s','now'))`),
  // set when the status becomes "done", cleared when it leaves "done" (used by the purge job)
  completedAt: integer("completed_at"),
  // soft delete: a deleted task keeps its row and gets a timestamp
  deletedAt: integer("deleted_at"),
  // name of the uploaded image on disk (a generated uuid + extension)
  attachment: text("attachment"),
}, (t) => [
  // the list query filters by owner and status (Bonus 4)
  index("idx_tasks_user_status").on(t.userId, t.status),
]);

export type Task = typeof tasks.$inferSelect;
export type User = typeof users.$inferSelect;
