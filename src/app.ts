// Zeynep Sudem Aktaş, 2025502009
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Context, MiddlewareHandler } from "hono";
import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { type Task, tasks, users } from "./schema.ts";
import {
  bearerToken,
  checkPassword,
  type Env,
  hashPassword,
  requireAuth,
  requireRole,
  signToken,
  verifyToken,
} from "./auth.ts";
import { DEFAULT_SECRET } from "./config.ts";
import { adminUsersJoin, own, summaryGood } from "./queries.ts";
import { createUserWithWelcomeTask } from "./users.ts";
import { type LimiterOptions, LoginLimiter } from "./limiter.ts";
import { Hub, type TaskEvent } from "./hub.ts";
import { TaskCache } from "./cache.ts";
import {
  ALLOWED_TYPES,
  contentTypeOf,
  MAX_UPLOAD_BYTES,
  newAttachmentName,
  removeFile,
  sniffImage,
} from "./uploads.ts";
import * as r from "./routes.ts";

export type AppOptions = {
  /** secret for signing and checking JWTs (default: the development secret) */
  jwtSecret?: string;
  /** registering with this email makes the user an admin (Bonus 9) */
  adminEmail?: string;
  /** a Deno KV store switches the task cache on (Bonus 16); without it nothing is cached */
  kv?: Deno.Kv;
  /** where uploaded images are stored (Bonus 12) */
  uploadDir?: string;
  /** receives one JSON line per request (Bonus 10). Default: console.log */
  log?: (line: string) => void;
  /** login rate limit (Bonus 15): 5 failures per minute by default */
  rateLimit?: LimiterOptions;
  /** a hook for the tests, see createUserWithWelcomeTask */
  afterUserInsert?: () => void;
};

const toDto = (t: Task) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  description: t.description,
  dueDate: t.dueDate,
  createdAt: t.createdAt,
  completedAt: t.completedAt,
  hasAttachment: t.attachment !== null,
});

let dummyHash: Promise<string> | undefined;

/** Build the whole application around a database, so tests can give it their own. */
export function createApp(db: Db, opts: AppOptions = {}) {
  const secret = opts.jwtSecret ?? DEFAULT_SECRET;
  const log = opts.log ?? ((line: string) => console.log(line));
  const uploadDir = opts.uploadDir ?? "./uploads";
  const cache = new TaskCache(opts.kv);
  const hub = new Hub();
  const limiter = new LoginLimiter(opts.rateLimit);

  /** the one error shape: { error, issues?, requestId } */
  const fail = (c: Context<Env>, error: string) => ({
    error,
    requestId: c.get("requestId"),
  });
  const notice = (userId: number, type: TaskEvent["type"], task: Task) =>
    hub.broadcast(userId, { type, task: toDto(task) });

  const app = new OpenAPIHono<Env>({
    // runs when a Zod schema of a route rejects the request
    defaultHook: (result, c) => {
      if (result.success) return;
      if (result.target === "param") return c.json(fail(c, "not found"), 404);
      return c.json({
        error: "validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path.map((p) => typeof p === "symbol" ? String(p) : p),
          message: i.message,
        })),
        requestId: c.get("requestId"),
      }, 400);
    },
  });

  // ---- Bonus 10: a request id and one JSON log line per request --------------------------
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const start = performance.now();
    await next(); // run the route first, then log
    try {
      c.res.headers.set("x-request-id", requestId);
    } catch {
      // the headers of an upgraded WebSocket response cannot be changed
    }
    // Only these fields are logged: never a body, a header, a password or a token.
    log(JSON.stringify({
      time: new Date().toISOString(),
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    }));
  });

  // ---- one error shape for every failure -------------------------------------------------
  app.notFound((c) => c.json(fail(c, "not found"), 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const message = err.message || "bad request";
      return c.json(
        fail(c, message.charAt(0).toLowerCase() + message.slice(1)),
        err.status,
      );
    }
    // the details go to the log, never to the client
    log(JSON.stringify({
      level: "error",
      requestId: c.get("requestId"),
      path: c.req.path,
      message: err.message,
      stack: err.stack,
    }));
    return c.json(fail(c, "internal error"), 500);
  });

  // ---- Bonus 6: each request borrows ONE connection from the pool and gives it back ------
  const withConn: MiddlewareHandler<Env> = async (c, next) => {
    await db.pool.use(async (conn) => {
      c.set("conn", conn);
      await next();
    });
  };
  app.use("/auth/*", withConn);
  app.use("/api/*", requireAuth(secret)); // before the pool: a stranger never takes a connection
  app.use("/api/*", withConn);
  app.use("/api/admin/*", requireRole("admin"));

  // ---- health (Bonus 11) -----------------------------------------------------------------
  app.openapi(r.healthRoute, (c) => c.json({ ok: true as const }, 200));
  app.openapi(r.healthzRoute, (c) => c.json({ ok: true as const }, 200));
  app.openapi(r.readyzRoute, async (c) => {
    try {
      await db.pool.use((conn) => conn.db.run(sql`SELECT 1`));
      return c.json({ ready: true as const }, 200);
    } catch {
      return c.json({ ready: false as const }, 503);
    }
  });

  // ---- register and login ----------------------------------------------------------------
  app.openapi(r.registerRoute, async (c) => {
    const body = c.req.valid("json");
    const conn = c.get("conn");
    const email = body.email.trim().toLowerCase();

    const [existing] = await conn.db.select({ id: users.id }).from(users)
      .where(eq(users.email, email));
    if (existing) return c.json(fail(c, "email already registered"), 409);

    const role = email === opts.adminEmail?.toLowerCase()
      ? "admin" as const
      : "user" as const;
    const passwordHash = await hashPassword(body.password); // never store the plain password
    try {
      const user = await createUserWithWelcomeTask(
        conn,
        { email, passwordHash, role },
        { afterUserInsert: opts.afterUserInsert },
      );
      return c.json({ id: user.id, email: user.email, role: user.role }, 201);
    } catch (e) {
      // two requests with the same email can both pass the lookup above;
      // the UNIQUE constraint decides and the loser gets a 409 as well
      if (
        String(e instanceof Error ? e.message + String(e.cause) : e).includes("UNIQUE")
      ) {
        return c.json(fail(c, "email already registered"), 409);
      }
      throw e;
    }
  });

  app.openapi(r.loginRoute, async (c) => {
    const body = c.req.valid("json");
    const conn = c.get("conn");
    const email = body.email.trim().toLowerCase();

    // Bonus 15: checked BEFORE the password, so a blocked caller learns nothing new
    const wait = limiter.retryAfter(email);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json(fail(c, "too many failed logins, try again later"), 429);
    }

    const [user] = await conn.db.select().from(users).where(eq(users.email, email));
    // For an unknown email we still run one bcrypt comparison, so that the answer takes
    // about as long as for a wrong password and the timing does not reveal which emails exist.
    dummyHash ??= hashPassword("dummy password for timing");
    const ok = user
      ? await checkPassword(body.password, user.passwordHash)
      : await checkPassword(body.password, await dummyHash).then(() => false);
    if (!user || !ok) {
      limiter.recordFailure(email);
      return c.json(fail(c, "invalid email or password"), 401); // one message for both cases
    }
    limiter.clear(email);
    return c.json({ token: await signToken(user.id, user.role, secret) }, 200);
  });

  // ---- tasks (every query includes the owner) --------------------------------------------
  app.openapi(r.listTasksRoute, async (c) => {
    const q = c.req.valid("query");
    const userId = c.get("userId");
    const conn = c.get("conn");
    const where = and(
      eq(tasks.userId, userId),
      isNull(tasks.deletedAt),
      q.status ? eq(tasks.status, q.status) : undefined,
    );
    const items = await conn.db.select().from(tasks).where(where)
      .orderBy(asc(tasks.id)).limit(q.limit).offset((q.page - 1) * q.limit);
    const [{ total }] = await conn.db.select({ total: count() }).from(tasks).where(where);
    return c.json({ items: items.map(toDto), page: q.page, limit: q.limit, total }, 200);
  });

  app.openapi(r.createTaskRoute, async (c) => {
    const b = c.req.valid("json");
    const userId = c.get("userId");
    const [row] = await c.get("conn").db.insert(tasks).values({
      userId,
      title: b.title,
      status: b.status,
      priority: b.priority,
      description: b.description ?? null,
      dueDate: b.dueDate ?? null,
      completedAt: b.status === "done" ? sql`(strftime('%s','now'))` : null,
    }).returning();
    notice(userId, "task.created", row);
    return c.json(toDto(row), 201);
  });

  app.openapi(r.getTaskRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const userId = c.get("userId");
    // Bonus 16: the cache key contains the user id, so this can only ever return OWN tasks
    let task = await cache.get(userId, id);
    if (!task) {
      [task] = await c.get("conn").db.select().from(tasks).where(own(id, userId));
      if (!task) return c.json(fail(c, "not found"), 404);
      await cache.set(userId, id, task);
    }
    return c.json(toDto(task), 200);
  });

  app.openapi(r.updateTaskRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const b = c.req.valid("json");
    const userId = c.get("userId");
    const [row] = await c.get("conn").db.update(tasks).set({
      title: b.title,
      status: b.status,
      priority: b.priority,
      description: b.description ?? null,
      dueDate: b.dueDate ?? null,
      // keeps the first completion time while the task stays done, clears it otherwise
      completedAt: sql`CASE WHEN ${b.status} = 'done'
        THEN COALESCE(${tasks.completedAt}, strftime('%s','now')) ELSE NULL END`,
    }).where(own(id, userId)).returning(); // no row back = not yours or not there = 404
    if (!row) return c.json(fail(c, "not found"), 404);
    await cache.invalidate(userId, id);
    notice(userId, "task.updated", row);
    return c.json(toDto(row), 200);
  });

  // Bonus 2: DELETE only marks the task
  app.openapi(r.deleteTaskRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const userId = c.get("userId");
    const [row] = await c.get("conn").db.update(tasks)
      .set({ deletedAt: sql`(strftime('%s','now'))` })
      .where(own(id, userId)).returning();
    if (!row) return c.json(fail(c, "not found"), 404);
    await cache.invalidate(userId, id);
    notice(userId, "task.deleted", row);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(r.restoreTaskRoute, async (c) => {
    const id = Number(c.req.valid("param").id);
    const userId = c.get("userId");
    const [row] = await c.get("conn").db.update(tasks).set({ deletedAt: null })
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNotNull(tasks.deletedAt)))
      .returning();
    if (!row) return c.json(fail(c, "not found"), 404);
    await cache.invalidate(userId, id);
    notice(userId, "task.restored", row);
    return c.json(toDto(row), 200);
  });

  app.openapi(r.summaryRoute, async (c) => {
    return c.json(await summaryGood(c.get("conn"), c.get("userId")), 200);
  });

  app.openapi(r.adminUsersRoute, async (c) => {
    return c.json(await adminUsersJoin(c.get("conn")), 200);
  });

  // ---- Bonus 12: file upload. Plain routes, because a File is not JSON ---------------------
  const idOf = (raw: string) => /^\d{1,15}$/.test(raw) ? Number(raw) : null;

  app.post("/api/tasks/:id/attachment", async (c) => {
    const id = idOf(c.req.param("id"));
    const userId = c.get("userId");
    const conn = c.get("conn");
    if (id === null) return c.json(fail(c, "not found"), 404);
    const [task] = await conn.db.select().from(tasks).where(own(id, userId));
    if (!task) return c.json(fail(c, "not found"), 404);

    let form: Record<string, unknown> = {};
    try {
      form = await c.req.parseBody();
    } catch {
      // not a form at all: treated like a missing file below
    }
    const file = form["file"];
    if (!(file instanceof File)) return c.json(fail(c, "file required"), 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(fail(c, "file too large (max 1 MB)"), 413);
    }
    if (!(ALLOWED_TYPES as readonly string[]).includes(file.type)) {
      return c.json(fail(c, "type not allowed (png or jpeg only)"), 415);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const real = sniffImage(bytes); // the first bytes must agree with the type the client sent
    if (real === null || real !== file.type) {
      return c.json(fail(c, "file content is not the image type it claims"), 415);
    }

    const name = newAttachmentName(real); // generated: never the user's file name
    await Deno.mkdir(uploadDir, { recursive: true });
    await Deno.writeFile(`${uploadDir}/${name}`, bytes);
    const [row] = await conn.db.update(tasks).set({ attachment: name })
      .where(own(id, userId)).returning();
    await removeFile(uploadDir, task.attachment); // the old picture is replaced
    await cache.invalidate(userId, id);
    notice(userId, "task.updated", row);
    return c.json(toDto(row), 200);
  });

  app.get("/api/tasks/:id/attachment", async (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json(fail(c, "not found"), 404);
    const [task] = await c.get("conn").db.select().from(tasks).where(
      own(id, c.get("userId")),
    );
    const type = task?.attachment ? contentTypeOf(task.attachment) : null;
    if (!task?.attachment || !type) return c.json(fail(c, "not found"), 404);
    try {
      const bytes = await Deno.readFile(`${uploadDir}/${task.attachment}`);
      return c.body(bytes.buffer as ArrayBuffer, 200, { "content-type": type });
    } catch {
      return c.json(fail(c, "not found"), 404);
    }
  });

  // the OpenAPI description of the two upload routes (they are not made with createRoute)
  const binary = z.string().openapi({ type: "string", format: "binary" });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/attachment",
    tags: ["tasks"],
    summary: "Attach a png or jpeg (max 1 MB) to a task",
    security: [{ Bearer: [] }],
    request: {
      params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
      body: {
        content: { "multipart/form-data": { schema: z.object({ file: binary }) } },
      },
    },
    responses: {
      200: { description: "The task with the attachment" },
      400: { description: "No file in the form" },
      401: { description: "Missing or bad token" },
      404: { description: "No such task" },
      413: { description: "Larger than 1 MB" },
      415: { description: "Not a png or jpeg" },
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/attachment",
    tags: ["tasks"],
    summary: "Download the attachment (owner only)",
    security: [{ Bearer: [] }],
    request: {
      params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "The image bytes" },
      401: { description: "Missing or bad token" },
      404: { description: "No such task or no attachment" },
    },
  });

  // ---- Bonus 13: WebSocket. A browser cannot set headers, so the token is in the query ----
  app.get("/ws", async (c) => {
    // authenticate BEFORE upgrading, the same check as requireAuth
    const who = await verifyToken(
      c.req.query("token") ?? bearerToken(c.req.header("authorization")),
      secret,
    );
    if (who === null) return c.json(fail(c, "unauthorized"), 401);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json(fail(c, "websocket upgrade required"), 426);
    }
    const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
    socket.onopen = () => hub.add(who.userId, socket);
    socket.onclose = () => hub.remove(who.userId, socket);
    socket.onerror = () => hub.remove(who.userId, socket);
    return response;
  });

  // ---- Bonus 8: the document and the docs page --------------------------------------------
  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
      title: "Tasks API",
      version: "1.0.0",
      description:
        "MIS 233 Assignment 5. Log in with POST /auth/login, press Authorize and paste the token.",
    },
  });
  app.get("/docs", (c) =>
    c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tasks API docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" });</script>
</body></html>`));

  return app;
}
