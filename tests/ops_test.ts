// Zeynep Sudem Aktaş, 2025502009
// Bonus 10 (logging, request ids) and Bonus 11 (health checks, configuration).
import { assert, assertEquals, assertThrows } from "@std/assert";
import { call, freshAppWithDb, signUp } from "./helpers.ts";
import { closeDb } from "../src/db.ts";
import { ConfigError, loadConfig } from "../src/config.ts";

Deno.test("GET /healthz is 200 and GET /readyz is 200 when the database answers", async () => {
  const { app } = await freshAppWithDb();
  assertEquals((await call(app, "GET", "/healthz")).json, { ok: true });
  const ready = await call(app, "GET", "/readyz");
  assertEquals(ready.status, 200);
  assertEquals(ready.json, { ready: true });
});

Deno.test("GET /readyz is 503 when the database does not answer", async () => {
  const { app, db } = await freshAppWithDb();
  closeDb(db); // every connection is closed now
  const res = await call(app, "GET", "/readyz");
  assertEquals(res.status, 503);
  assertEquals(res.json, { ready: false });
  assertEquals((await call(app, "GET", "/healthz")).status, 200); // the process itself is fine
});

Deno.test("an unexpected failure is a 500 with a short message, a request id and no details", async () => {
  const lines: string[] = [];
  const { app, db } = await freshAppWithDb({ log: (l) => lines.push(l) });
  const token = await signUp(app, "a@example.com");
  closeDb(db);
  const res = await call(app, "GET", "/api/tasks", { token });
  assertEquals(res.status, 500);
  assertEquals(res.json.error, "internal error");
  assertEquals(res.json.requestId, res.res.headers.get("x-request-id"));
  assert(!res.text.includes("stack"), "no stack trace for the client");
  // the real error went to the log instead
  const errorLine = lines.map((l) => JSON.parse(l)).find((l) => l.level === "error");
  assertEquals(errorLine.requestId, res.json.requestId);
});

Deno.test("every response has an x-request-id, and error bodies carry the same id", async () => {
  const { app } = await freshAppWithDb();
  const ok = await call(app, "GET", "/health");
  assert(ok.res.headers.get("x-request-id"));
  const missing = await call(app, "GET", "/no/such/route");
  assertEquals(missing.status, 404);
  assertEquals(missing.json.requestId, missing.res.headers.get("x-request-id"));
  const unauthorized = await call(app, "GET", "/api/tasks");
  assertEquals(unauthorized.json.requestId, unauthorized.res.headers.get("x-request-id"));
  const ids = new Set(
    [ok, missing, unauthorized].map((r) => r.res.headers.get("x-request-id")),
  );
  assertEquals(ids.size, 3, "a new id for every request");
});

Deno.test("each request leaves one JSON log line, and no line contains a password or a token", async () => {
  const lines: string[] = [];
  const { app } = await freshAppWithDb({ log: (l) => lines.push(l) });
  const password = "very-secret-password-123";
  const token = await signUp(app, "a@example.com", password);
  await call(app, "GET", "/api/tasks", { token });
  await call(app, "POST", "/api/tasks", { token, body: { title: "x" } });
  await call(app, "GET", `/ws?token=${token}`); // a token in the query string

  assertEquals(lines.length, 5); // register, login, list, create, ws
  for (const line of lines) {
    const entry = JSON.parse(line); // one line = one JSON object
    assertEquals(
      Object.keys(entry).sort(),
      ["method", "ms", "path", "requestId", "status", "time"],
    );
    assert(!line.includes(password), "the password is not logged");
    assert(!line.includes(token), "the token is not logged");
  }
  assertEquals(JSON.parse(lines[0]).path, "/auth/register");
  assertEquals(JSON.parse(lines[0]).status, 201);
  assertEquals(JSON.parse(lines[4]).path, "/ws"); // path only, without ?token=...
});

Deno.test("config: defaults work in development", () => {
  const c = loadConfig({});
  assertEquals([c.port, c.appEnv, c.databaseUrl, c.jwtSecret], [
    8000,
    "development",
    "file:./tasks.db",
    "dev-secret",
  ]);
  assertEquals(c.dbPoolSize, 4);
});

Deno.test("config: values from the environment are read and an empty value means 'not set'", () => {
  const c = loadConfig({
    PORT: "9000",
    ADMIN_EMAIL: "",
    DB_POOL_SIZE: "2",
    JWT_SECRET: "abc",
  });
  assertEquals([c.port, c.adminEmail, c.dbPoolSize, c.jwtSecret], [
    9000,
    undefined,
    2,
    "abc",
  ]);
});

Deno.test("config: bad values are refused with a clear message", () => {
  for (
    const env of [
      { PORT: "abc" },
      { PORT: "0" },
      { PORT: "70000" },
      { APP_ENV: "staging" },
      { ADMIN_EMAIL: "nope" },
      { DB_POOL_SIZE: "0" },
    ]
  ) {
    assertThrows(() => loadConfig(env), ConfigError);
  }
  try {
    loadConfig({ PORT: "abc" });
  } catch (e) {
    assert((e as Error).message.includes("PORT"), "the message names the setting");
  }
});

Deno.test("config: production refuses the development secret, a placeholder and a short one", () => {
  const prod = { APP_ENV: "production", DATABASE_URL: "file:/data/tasks.db" };
  assertThrows(() => loadConfig({ ...prod }), ConfigError); // no secret at all
  assertThrows(() => loadConfig({ ...prod, JWT_SECRET: "dev-secret" }), ConfigError);
  assertThrows(
    () => loadConfig({ ...prod, JWT_SECRET: "change-me-to-a-long-random-string" }),
    ConfigError,
  );
  assertThrows(() => loadConfig({ ...prod, JWT_SECRET: "short" }), ConfigError);
  assertThrows(
    () => loadConfig({ APP_ENV: "production", JWT_SECRET: "x".repeat(32) }),
    ConfigError,
  ); // no DATABASE_URL
  const good = loadConfig({ ...prod, JWT_SECRET: "x".repeat(32) });
  assertEquals(good.appEnv, "production");
});
