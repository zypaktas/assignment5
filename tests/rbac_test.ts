// Zeynep Sudem Aktaş, 2025502009
// Bonus 9: roles. The three outcomes: no token 401, a normal user 403, an admin 200.
import { assert, assertEquals } from "@std/assert";
import { call, freshApp, makeTask, signUp } from "./helpers.ts";
import { verifyToken } from "../src/auth.ts";

const BOSS = "boss@example.com";

Deno.test("admin route: no token is 401", async () => {
  const app = await freshApp({ adminEmail: BOSS });
  const res = await call(app, "GET", "/api/admin/users");
  assertEquals(res.status, 401);
  assertEquals(res.json.error, "unauthorized");
});

Deno.test("admin route: a normal user is 403", async () => {
  const app = await freshApp({ adminEmail: BOSS });
  const token = await signUp(app, "a@example.com");
  const res = await call(app, "GET", "/api/admin/users", { token });
  assertEquals(res.status, 403);
  assertEquals(res.json.error, "forbidden");
});

Deno.test("admin route: the admin gets every user with the number of their tasks (200)", async () => {
  const app = await freshApp({ adminEmail: BOSS });
  const a = await signUp(app, "a@example.com");
  await makeTask(app, a, { title: "one" });
  const boss = await signUp(app, BOSS);
  const res = await call(app, "GET", "/api/admin/users", { token: boss });
  assertEquals(res.status, 200);
  const list = JSON.parse(res.text) as {
    email: string;
    role: string;
    taskCount: number;
  }[];
  assertEquals(list.map((u) => [u.email, u.role, u.taskCount]), [
    ["a@example.com", "user", 2], // the welcome task and "one"
    [BOSS, "admin", 1], // only the welcome task
  ]);
  assert(!res.text.includes("passwordHash"), "never the hash");
});

Deno.test("only the ADMIN_EMAIL address becomes an admin, whatever the capitals", async () => {
  const app = await freshApp({ adminEmail: BOSS });
  const login = async (email: string) => {
    const token = await signUp(app, email);
    return await verifyToken(token, "dev-secret");
  };
  assertEquals((await login("Boss@Example.com"))?.role, "admin");
  assertEquals((await login("someone@example.com"))?.role, "user");
});

Deno.test("without ADMIN_EMAIL nobody can become an admin by registering", async () => {
  const app = await freshApp();
  const token = await signUp(app, BOSS);
  assertEquals((await call(app, "GET", "/api/admin/users", { token })).status, 403);
});
