// Zeynep Sudem Aktaş, 2025502009
import { createApp } from "../src/app.ts";
import type { AppOptions } from "../src/app.ts";
import { closeDb, createDb, type DbOptions, migrate } from "../src/db.ts";
import type { Db } from "../src/db.ts";

export type TestApp = ReturnType<typeof createApp>;

/**
 * Every test gets a fresh, empty database in its own temporary file.
 * (An in-memory database loses its tables after a transaction with libSQL,
 * so a temporary file is the safe choice.)
 * The request log is silent unless a test passes its own `log`.
 */
export async function freshApp(opts: AppOptions = {}, dbOpts: DbOptions = {}) {
  const { app } = await freshAppWithDb(opts, dbOpts);
  return app;
}

/** Same, but also returns the database, for tests that look inside it. */
export async function freshAppWithDb(opts: AppOptions = {}, dbOpts: DbOptions = {}) {
  const file = await Deno.makeTempFile({ suffix: ".db" });
  const db = createDb(`file:${file}`, dbOpts);
  await migrate(db);
  const app = createApp(db, { log: () => {}, ...opts });
  return { app, db, file, close: () => closeDb(db) };
}

export type Json = Record<string, unknown>;

/** Send a request with an optional JSON body and token, and return the status and the body. */
export async function call(
  app: TestApp,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (an image, for example)
  }
  return { status: res.status, json, res, text };
}

export const PASSWORD = "secret123";

/** Register a user and log in; returns the token. */
export async function signUp(app: TestApp, email: string, password = PASSWORD) {
  await call(app, "POST", "/auth/register", { body: { email, password } });
  const login = await call(app, "POST", "/auth/login", { body: { email, password } });
  return String(login.json.token);
}

/** Create a task for the token's user; returns the task. */
export async function makeTask(
  app: TestApp,
  token: string,
  body: Json = { title: "A task" },
) {
  const res = await call(app, "POST", "/api/tasks", { token, body });
  return res.json as { id: number } & Json;
}

/** Count the SQL statements a Db runs (used by the cache and N+1 tests). */
export function counter() {
  const queries: string[] = [];
  return {
    queries,
    logger: { logQuery: (q: string) => void queries.push(q) },
    reads: (table: string) =>
      queries.filter((q) =>
        q.toLowerCase().startsWith("select") && q.includes(`"${table}"`)
      )
        .length,
  };
}

export type { Db };
