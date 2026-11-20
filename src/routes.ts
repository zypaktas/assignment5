// Zeynep Sudem Aktaş, 2025502009
// Bonus 8: every route is described once with createRoute. The same description validates
// the request (Zod) and ends up in /openapi.json.
import { createRoute, z } from "@hono/zod-openapi";
import {
  AdminUsersSchema,
  Credentials,
  ErrorSchema,
  IdParam,
  ListQuery,
  LoginBody,
  OkSchema,
  SummarySchema,
  TaskBody,
  TaskPage,
  TaskSchema,
  TokenSchema,
  UserSchema,
} from "./schemas.ts";

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const err = (description: string) => json(ErrorSchema, description);
const bearer = [{ Bearer: [] }];
const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { "application/json": { schema } },
});

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["ops"],
  summary: "Is the process up?",
  responses: { 200: json(z.object({ ok: z.literal(true) }), "The server answers") },
});

export const healthzRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["ops"],
  summary: "Liveness probe for a platform",
  responses: { 200: json(z.object({ ok: z.literal(true) }), "The process is up") },
});

export const readyzRoute = createRoute({
  method: "get",
  path: "/readyz",
  tags: ["ops"],
  summary: "Readiness probe: runs SELECT 1 on the database",
  responses: {
    200: json(z.object({ ready: z.literal(true) }), "The database answers"),
    503: json(z.object({ ready: z.literal(false) }), "The database does not answer"),
  },
});

export const registerRoute = createRoute({
  method: "post",
  path: "/auth/register",
  tags: ["auth"],
  summary: "Create an account",
  request: { body: body(Credentials) },
  responses: {
    201: json(UserSchema, "The new user (never the password hash)"),
    400: err("Bad body"),
    409: err("Email already registered"),
  },
});

export const loginRoute = createRoute({
  method: "post",
  path: "/auth/login",
  tags: ["auth"],
  summary: "Log in and get a JWT",
  request: { body: body(LoginBody) },
  responses: {
    200: json(TokenSchema, "A signed token that is valid for one hour"),
    400: err("Bad body"),
    401: err("Wrong email or password (the same message for both)"),
    429: err("Too many failed logins for this email (see the Retry-After header)"),
  },
});

export const listTasksRoute = createRoute({
  method: "get",
  path: "/api/tasks",
  tags: ["tasks"],
  summary: "List your tasks, one page",
  security: bearer,
  request: { query: ListQuery },
  responses: {
    200: json(TaskPage, "One page of your tasks"),
    400: err("Bad query"),
    401: err("Missing or bad token"),
  },
});

export const createTaskRoute = createRoute({
  method: "post",
  path: "/api/tasks",
  tags: ["tasks"],
  summary: "Create a task",
  security: bearer,
  request: { body: body(TaskBody) },
  responses: {
    201: json(TaskSchema, "The new task"),
    400: err("Bad body"),
    401: err("Missing or bad token"),
  },
});

export const getTaskRoute = createRoute({
  method: "get",
  path: "/api/tasks/{id}",
  tags: ["tasks"],
  summary: "One task (cached for 60 seconds)",
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(TaskSchema, "The task"),
    401: err("Missing or bad token"),
    404: err("No such task (or it belongs to someone else)"),
  },
});

export const updateTaskRoute = createRoute({
  method: "put",
  path: "/api/tasks/{id}",
  tags: ["tasks"],
  summary: "Replace a task (same body as POST)",
  security: bearer,
  request: { params: IdParam, body: body(TaskBody) },
  responses: {
    200: json(TaskSchema, "The updated task"),
    400: err("Bad body"),
    401: err("Missing or bad token"),
    404: err("No such task"),
  },
});

export const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/api/tasks/{id}",
  tags: ["tasks"],
  summary: "Soft delete: the task is marked, not removed",
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(OkSchema, "Deleted"),
    401: err("Missing or bad token"),
    404: err("No such task"),
  },
});

export const restoreTaskRoute = createRoute({
  method: "post",
  path: "/api/tasks/{id}/restore",
  tags: ["tasks"],
  summary: "Bring a soft-deleted task back",
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(TaskSchema, "The restored task"),
    401: err("Missing or bad token"),
    404: err("No such task, or it is not deleted"),
  },
});

export const summaryRoute = createRoute({
  method: "get",
  path: "/api/me/summary",
  tags: ["tasks"],
  summary: "Number of your tasks per status (one GROUP BY query)",
  security: bearer,
  responses: {
    200: json(SummarySchema, "Counts"),
    401: err("Missing or bad token"),
  },
});

export const adminUsersRoute = createRoute({
  method: "get",
  path: "/api/admin/users",
  tags: ["admin"],
  summary: "All users with their task count (admins only; one LEFT JOIN)",
  security: bearer,
  responses: {
    200: json(AdminUsersSchema, "Every user"),
    401: err("Missing or bad token"),
    403: err("Not an admin"),
  },
});
