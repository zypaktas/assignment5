// Zeynep Sudem Aktaş, 2025502009
// The Zod schemas: the same ones validate requests and describe the API in /openapi.json (Bonus 8).
import { z } from "@hono/zod-openapi";
import { PRIORITIES, ROLES, STATUSES } from "./schema.ts";

export const ErrorSchema = z.object({
  error: z.string().openapi({ example: "validation failed" }),
  issues: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })).optional(),
  requestId: z.string().optional(),
}).openapi("Error");

export const Credentials = z.object({
  email: z.email().openapi({ example: "zeynep@example.com" }),
  password: z.string().min(8).openapi({ example: "secret123" }),
}).openapi("Credentials");

// Login only checks that a password was sent: the 8-character rule belongs to registration.
// (A short wrong password must be a 401, not a 400, and a login should not reveal the rule.)
export const LoginBody = z.object({
  email: z.email().openapi({ example: "zeynep@example.com" }),
  password: z.string().min(1).openapi({ example: "secret123" }),
}).openapi("LoginBody");

export const UserSchema = z.object({
  id: z.number().int(),
  email: z.string(),
  role: z.enum(ROLES),
}).openapi("User");

export const TokenSchema = z.object({ token: z.string() }).openapi("Token");

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must look like 2026-12-31").refine(
  (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s),
  "not a real calendar date",
);

/** The body of POST and PUT on a task. */
export const TaskBody = z.object({
  title: z.string().trim().min(1).max(100).openapi({ example: "Write the README" }),
  status: z.enum(STATUSES).default("todo"),
  priority: z.enum(PRIORITIES).default("medium"),
  description: z.string().max(500).nullish().openapi({ example: "curl examples first" }),
  dueDate: date.nullish().openapi({ example: "2026-12-31" }),
}).openapi("TaskBody");

export const TaskSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  description: z.string().nullable(),
  dueDate: z.string().nullable(),
  createdAt: z.number().int().openapi({ description: "unix seconds" }),
  completedAt: z.number().int().nullable(),
  hasAttachment: z.boolean(),
}).openapi("Task");

export const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(STATUSES).optional(),
});

export const TaskPage = z.object({
  items: z.array(TaskSchema),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
}).openapi("TaskPage");

// A path parameter that is not a number is "not found", not "bad request" (see the hook in app.ts).
export const IdParam = z.object({
  id: z.string().regex(/^\d{1,15}$/).openapi({
    param: { name: "id", in: "path" },
    example: "1",
  }),
});

export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");

export const SummarySchema = z.object({
  "todo": z.number().int(),
  "in-progress": z.number().int(),
  "done": z.number().int(),
  total: z.number().int(),
}).openapi("Summary");

export const AdminUsersSchema = z.array(z.object({
  id: z.number().int(),
  email: z.string(),
  role: z.enum(ROLES),
  createdAt: z.number().int(),
  taskCount: z.number().int(),
})).openapi("AdminUsers");
