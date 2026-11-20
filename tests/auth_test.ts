// Zeynep Sudem Aktaş, 2025502009
// R3 and R7: register, login, tokens, the auth middleware (and Bonus 2 and 15 on register/login).
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { call, freshApp, freshAppWithDb, makeTask, PASSWORD, signUp } from "./helpers.ts";
import { signToken } from "../src/auth.ts";
import { users } from "../src/schema.ts";
import { createUserWithWelcomeTask } from "../src/users.ts";

const creds = (email = "a@example.com", password = PASSWORD) => ({ email, password });

Deno.test("register answers 201 with id and email, and never the hash or password", async () => {
  const app = await freshApp();
  const res = await call(app, "POST", "/auth/register", { body: creds() });
  assertEquals(res.status, 201);
  assertEquals(res.json.email, "a@example.com");
  assertEquals(typeof res.json.id, "number");
  assert(!res.text.includes("password"), "no password field in the answer");
  assert(!res.text.includes("$2"), "no bcrypt hash in the answer");
});

Deno.test("the password is stored as a bcrypt hash, not as text", async () => {
  const { app, db } = await freshAppWithDb();
  await call(app, "POST", "/auth/register", { body: creds() });
  const [row] = await db.db.select().from(users);
  assertNotEquals(row.passwordHash, PASSWORD);
  assert(row.passwordHash.startsWith("$2"), `looks like bcrypt: ${row.passwordHash}`);
});

Deno.test("registering the same email twice is 409 (also with other capitals)", async () => {
  const app = await freshApp();
  await call(app, "POST", "/auth/register", { body: creds() });
  const again = await call(app, "POST", "/auth/register", { body: creds() });
  assertEquals(again.status, 409);
  assertEquals(again.json.error, "email already registered");
  const shouting = await call(app, "POST", "/auth/register", {
    body: creds("A@Example.COM"),
  });
  assertEquals(shouting.status, 409);
});

Deno.test("register with a bad body is 400 and names the field", async () => {
  const app = await freshApp();
  const badEmail = await call(app, "POST", "/auth/register", {
    body: { email: "not-an-email", password: PASSWORD },
  });
  assertEquals(badEmail.status, 400);
  assertEquals(badEmail.json.error, "validation failed");
  const issues = badEmail.json.issues as { path: string[]; message: string }[];
  assertEquals(issues[0].path, ["email"]);

  const shortPassword = await call(app, "POST", "/auth/register", {
    body: { email: "a@example.com", password: "short" },
  });
  assertEquals(shortPassword.status, 400);
  assertEquals((shortPassword.json.issues as { path: string[] }[])[0].path, ["password"]);

  const nothing = await call(app, "POST", "/auth/register", { body: {} });
  assertEquals(nothing.status, 400);
});

Deno.test("malformed JSON is a 400 in the normal error shape", async () => {
  const app = await freshApp();
  const res = await app.request("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(typeof body.error, "string");
});

Deno.test("login with the right password returns a token", async () => {
  const app = await freshApp();
  await call(app, "POST", "/auth/register", { body: creds() });
  const res = await call(app, "POST", "/auth/login", { body: creds() });
  assertEquals(res.status, 200);
  assertEquals(typeof res.json.token, "string");
  assertEquals((res.json.token as string).split(".").length, 3); // a JWT: header.payload.signature
});

Deno.test("a wrong password and an unknown email give the same 401", async () => {
  const app = await freshApp();
  await call(app, "POST", "/auth/register", { body: creds() });
  const wrong = await call(app, "POST", "/auth/login", {
    body: creds("a@example.com", "wrong"),
  });
  const unknown = await call(app, "POST", "/auth/login", {
    body: creds("nobody@example.com"),
  });
  assertEquals(wrong.status, 401);
  assertEquals(unknown.status, 401);
  assertEquals(wrong.json.error, "invalid email or password");
  assertEquals(unknown.json.error, wrong.json.error);
});

Deno.test("login with a bad body is 400", async () => {
  const app = await freshApp();
  const res = await call(app, "POST", "/auth/login", { body: { email: "x" } });
  assertEquals(res.status, 400);
  assertEquals(res.json.error, "validation failed");
});

Deno.test("a missing token is 401 in the normal error shape", async () => {
  const app = await freshApp();
  const res = await call(app, "GET", "/api/tasks");
  assertEquals(res.status, 401);
  assertEquals(res.json.error, "unauthorized");
});

Deno.test("a garbage or malformed Authorization header is 401", async () => {
  const app = await freshApp();
  for (const header of ["Bearer nonsense", "nonsense", "Bearer", "Basic abc"]) {
    const res = await call(app, "GET", "/api/tasks", {
      headers: { authorization: header },
    });
    assertEquals(res.status, 401, header);
  }
});

Deno.test("a valid token reaches the route", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const res = await call(app, "GET", "/api/tasks", { token });
  assertEquals(res.status, 200);
});

Deno.test("a tampered token is 401", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  // change one character in the signature
  const last = token.at(-1) === "A" ? "B" : "A";
  const res = await call(app, "GET", "/api/tasks", { token: token.slice(0, -1) + last });
  assertEquals(res.status, 401);
});

Deno.test("an expired token is 401", async () => {
  const app = await freshApp({ jwtSecret: "s3cret-for-tests" });
  const longAgo = Math.floor(Date.now() / 1000) - 3600;
  const token = await signToken(1, "user", "s3cret-for-tests", longAgo);
  assertEquals((await call(app, "GET", "/api/tasks", { token })).status, 401);
  // the same secret with a normal lifetime works, so the secret was not the problem
  const fresh = await signToken(1, "user", "s3cret-for-tests");
  assertEquals((await call(app, "GET", "/api/tasks", { token: fresh })).status, 200);
});

Deno.test("a token signed with another secret is 401", async () => {
  const app = await freshApp({ jwtSecret: "the-real-secret" });
  const forged = await signToken(1, "admin", "another-secret");
  assertEquals((await call(app, "GET", "/api/tasks", { token: forged })).status, 401);
});

Deno.test("registering creates a welcome task in the same transaction", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const list = await call(app, "GET", "/api/tasks", { token });
  assertEquals(list.json.total, 1);
  assertEquals(
    (list.json.items as { title: string }[])[0].title.startsWith("Welcome"),
    true,
  );
});

Deno.test("a failing welcome task rolls the user back too (transaction)", async () => {
  const { db } = await freshAppWithDb();
  await assertRejects(() =>
    createUserWithWelcomeTask(db, {
      email: "ghost@example.com",
      passwordHash: "x",
      role: "user",
    }, {
      afterUserInsert: () => {
        throw new Error("boom between the two inserts");
      },
    })
  );
  const left = await db.db.select().from(users);
  assertEquals(left.length, 0, "no user may be left behind");
});

Deno.test("when registration fails half way, the API answers 500 and the email stays free", async () => {
  let fail = true;
  const { app, db } = await freshAppWithDb({
    afterUserInsert: () => {
      if (fail) throw new Error("boom");
    },
  });
  const first = await call(app, "POST", "/auth/register", { body: creds() });
  assertEquals(first.status, 500);
  assertEquals(first.json.error, "internal error");
  assertEquals((await db.db.select().from(users)).length, 0);
  fail = false;
  const second = await call(app, "POST", "/auth/register", { body: creds() });
  assertEquals(second.status, 201);
});

Deno.test("rate limit: after 5 failed logins the 6th is 429 with Retry-After, even with the right password", async () => {
  const app = await freshApp();
  await call(app, "POST", "/auth/register", { body: creds() });
  for (let i = 0; i < 5; i++) {
    const res = await call(app, "POST", "/auth/login", {
      body: creds("a@example.com", "wrong"),
    });
    assertEquals(res.status, 401);
  }
  const blocked = await call(app, "POST", "/auth/login", { body: creds() });
  assertEquals(blocked.status, 429);
  assertEquals(blocked.json.error, "too many failed logins, try again later");
  const wait = Number(blocked.res.headers.get("retry-after"));
  assert(wait >= 1 && wait <= 60, `Retry-After is ${wait}`);
  // another email is not affected
  await call(app, "POST", "/auth/register", { body: creds("b@example.com") });
  assertEquals(
    (await call(app, "POST", "/auth/login", { body: creds("b@example.com") })).status,
    200,
  );
});

Deno.test("rate limit: a success clears the counter and an old window starts again", async () => {
  let now = 1_000_000;
  const app = await freshApp({ rateLimit: { now: () => now } });
  await call(app, "POST", "/auth/register", { body: creds() });
  const bad = () =>
    call(app, "POST", "/auth/login", { body: creds("a@example.com", "wrong") });
  for (let i = 0; i < 4; i++) await bad();
  assertEquals((await call(app, "POST", "/auth/login", { body: creds() })).status, 200); // clears
  for (let i = 0; i < 4; i++) assertEquals((await bad()).status, 401); // 4 again: still no 429
  await bad(); // the 5th failure in this window
  assertEquals((await bad()).status, 429);
  now += 61_000; // the window is over
  assertEquals((await call(app, "POST", "/auth/login", { body: creds() })).status, 200);
});

Deno.test("a user can make a task right after registering (token from login works end to end)", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token, { title: "first" });
  assertEquals(typeof task.id, "number");
});
