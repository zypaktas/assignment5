// Zeynep Sudem Aktaş, 2025502009
// R4, R5, R6 and R7: the task routes, ownership, validation, pagination, soft delete.
import { assert, assertEquals } from "@std/assert";
import { call, freshApp, type Json, makeTask, signUp } from "./helpers.ts";

type TaskJson = {
  id: number;
  title: string;
  status: string;
  priority: string;
  completedAt: number | null;
  description: string | null;
  dueDate: string | null;
};
type PageJson = { items: TaskJson[]; page: number; limit: number; total: number };

/** every failing answer must have the one error shape */
function assertErrorShape(json: Json, message?: string) {
  assertEquals(typeof json.error, "string");
  if (message) assertEquals(json.error, message);
}

Deno.test("POST /api/tasks creates a task with the defaults (201)", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const res = await call(app, "POST", "/api/tasks", {
    token,
    body: { title: "Write tests" },
  });
  assertEquals(res.status, 201);
  const task = res.json as unknown as TaskJson;
  assertEquals(task.title, "Write tests");
  assertEquals(task.status, "todo");
  assertEquals(task.priority, "medium");
  assertEquals(task.completedAt, null);
});

Deno.test("a task needs a token (401) on every route", async () => {
  const app = await freshApp();
  const routes: [string, string][] = [
    ["GET", "/api/tasks"],
    ["POST", "/api/tasks"],
    ["GET", "/api/tasks/1"],
    ["PUT", "/api/tasks/1"],
    ["DELETE", "/api/tasks/1"],
    ["POST", "/api/tasks/1/restore"],
    ["GET", "/api/me/summary"],
    ["GET", "/api/admin/users"],
  ];
  for (const [method, path] of routes) {
    const res = await call(app, method, path, {
      body: method === "GET" ? undefined : { title: "x" },
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertErrorShape(res.json, "unauthorized");
  }
});

Deno.test("an invalid status is 400, and so are a bad priority, title and dates", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const bad: Json[] = [
    { title: "x", status: "finished" },
    { title: "x", priority: "urgent" },
    { title: "" },
    { title: "   " },
    { title: "x".repeat(101) },
    {},
    { title: "x", description: "d".repeat(501) },
    { title: "x", dueDate: "tomorrow" },
    { title: "x", dueDate: "2026-02-30" },
  ];
  for (const body of bad) {
    const res = await call(app, "POST", "/api/tasks", { token, body });
    assertEquals(res.status, 400, JSON.stringify(body));
    assertErrorShape(res.json, "validation failed");
    assert(Array.isArray(res.json.issues) && res.json.issues.length > 0);
  }
  // the edge values are fine
  const ok = await call(app, "POST", "/api/tasks", {
    token,
    body: { title: "x".repeat(100), dueDate: "2026-12-31", description: "d".repeat(500) },
  });
  assertEquals(ok.status, 201);
});

Deno.test("GET /api/tasks lists only my tasks", async () => {
  const app = await freshApp();
  const a = await signUp(app, "a@example.com");
  const b = await signUp(app, "b@example.com");
  await makeTask(app, a, { title: "A1" });
  await makeTask(app, a, { title: "A2" });
  await makeTask(app, b, { title: "B1" });
  const mine = (await call(app, "GET", "/api/tasks", { token: a }))
    .json as unknown as PageJson;
  assertEquals(mine.items.map((t) => t.title).filter((t) => !t.startsWith("Welcome")), [
    "A1",
    "A2",
  ]);
  const theirs = (await call(app, "GET", "/api/tasks", { token: b }))
    .json as unknown as PageJson;
  assertEquals(theirs.items.map((t) => t.title).filter((t) => !t.startsWith("Welcome")), [
    "B1",
  ]);
});

Deno.test("another user's task is 404 to read, change and delete (and stays untouched)", async () => {
  const app = await freshApp();
  const a = await signUp(app, "a@example.com");
  const b = await signUp(app, "b@example.com");
  const task = await makeTask(app, a, { title: "secret plan" });

  const read = await call(app, "GET", `/api/tasks/${task.id}`, { token: b });
  assertEquals(read.status, 404);
  assertErrorShape(read.json, "not found");
  const change = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token: b,
    body: { title: "hacked" },
  });
  assertEquals(change.status, 404);
  const remove = await call(app, "DELETE", `/api/tasks/${task.id}`, { token: b });
  assertEquals(remove.status, 404);
  const restore = await call(app, "POST", `/api/tasks/${task.id}/restore`, { token: b });
  assertEquals(restore.status, 404);

  const still = await call(app, "GET", `/api/tasks/${task.id}`, { token: a });
  assertEquals(still.status, 200);
  assertEquals(still.json.title, "secret plan");
});

Deno.test("an unknown or non-numeric id is 404", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  for (const id of ["9999", "abc", "-1", "1.5", "0x10"]) {
    assertEquals((await call(app, "GET", `/api/tasks/${id}`, { token })).status, 404, id);
    assertEquals(
      (await call(app, "DELETE", `/api/tasks/${id}`, { token })).status,
      404,
      id,
    );
  }
});

Deno.test("SQL injection in the id, the title and the query is only data", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const evil = "x'); DROP TABLE tasks; --";
  const made = await call(app, "POST", "/api/tasks", { token, body: { title: evil } });
  assertEquals(made.status, 201);
  assertEquals(made.json.title, evil); // stored as plain text
  assertEquals((await call(app, "GET", "/api/tasks/1 OR 1=1", { token })).status, 404);
  assertEquals(
    (await call(app, "GET", "/api/tasks?status=done'%20OR%201=1", { token })).status,
    400,
  );
  const list = (await call(app, "GET", "/api/tasks", { token }))
    .json as unknown as PageJson;
  assertEquals(list.total, 2); // the table is still there: welcome task + this one
});

Deno.test("PUT replaces a task and answers the updated task", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token, { title: "old", priority: "high" });
  const res = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token,
    body: {
      title: "new",
      status: "in-progress",
      priority: "low",
      description: "now with notes",
    },
  });
  assertEquals(res.status, 200);
  const updated = res.json as unknown as TaskJson;
  assertEquals([updated.title, updated.status, updated.priority], [
    "new",
    "in-progress",
    "low",
  ]);
  assertEquals(updated.description, "now with notes");
  // PUT is a full replacement: what the body leaves out goes back to its default
  const again = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token,
    body: { title: "newer" },
  });
  assertEquals([again.json.status, again.json.priority, again.json.description], [
    "todo",
    "medium",
    null,
  ]);
});

Deno.test("PUT with a bad body is 400 and changes nothing", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token, { title: "keep me" });
  const res = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token,
    body: { title: "changed", status: "nope" },
  });
  assertEquals(res.status, 400);
  assertErrorShape(res.json, "validation failed");
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}`, { token })).json.title,
    "keep me",
  );
});

Deno.test("completedAt is set when a task becomes done, kept while done, cleared otherwise", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const created = await call(app, "POST", "/api/tasks", {
    token,
    body: { title: "x", status: "done" },
  });
  assertEquals(typeof created.json.completedAt, "number");

  const task = await makeTask(app, token, { title: "y" });
  const done = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token,
    body: { title: "y", status: "done" },
  });
  const stamp = done.json.completedAt;
  assertEquals(typeof stamp, "number");
  const renamed = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token,
    body: { title: "y2", status: "done" },
  });
  assertEquals(renamed.json.completedAt, stamp);
  const reopened = await call(app, "PUT", `/api/tasks/${task.id}`, {
    token,
    body: { title: "y2", status: "todo" },
  });
  assertEquals(reopened.json.completedAt, null);
});

Deno.test("pagination: page 2 holds the right items and the total", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com"); // has 1 welcome task already
  for (const title of ["t1", "t2", "t3"]) await makeTask(app, token, { title });
  // 4 tasks in order: Welcome, t1, t2, t3
  const page2 = (await call(app, "GET", "/api/tasks?page=2&limit=2", { token }))
    .json as unknown as PageJson;
  assertEquals(page2.items.map((t) => t.title), ["t2", "t3"]);
  assertEquals([page2.page, page2.limit, page2.total], [2, 2, 4]);

  const odd = (await call(app, "GET", "/api/tasks?page=2&limit=3", { token }))
    .json as unknown as PageJson;
  assertEquals(odd.items.map((t) => t.title), ["t3"]); // 4 tasks, 3 per page: one left on page 2
  const beyond = (await call(app, "GET", "/api/tasks?page=9&limit=2", { token }))
    .json as unknown as PageJson;
  assertEquals(beyond.items, []);
  assertEquals(beyond.total, 4);
});

Deno.test("pagination defaults are page 1 and limit 20", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const res = (await call(app, "GET", "/api/tasks", { token }))
    .json as unknown as PageJson;
  assertEquals([res.page, res.limit], [1, 20]);
  const max = await call(app, "GET", "/api/tasks?limit=100", { token });
  assertEquals(max.status, 200);
});

Deno.test("filtering by status counts only that status", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  await makeTask(app, token, { title: "d1", status: "done" });
  await makeTask(app, token, { title: "d2", status: "done" });
  await makeTask(app, token, { title: "p", status: "in-progress" });
  const done = (await call(app, "GET", "/api/tasks?status=done&limit=1", { token }))
    .json as unknown as PageJson;
  assertEquals(done.total, 2);
  assertEquals(done.items.length, 1);
  assertEquals(done.items[0].status, "done");
});

Deno.test("a bad query is a 400, not a crash", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  for (
    const q of [
      "page=abc",
      "page=0",
      "page=-2",
      "page=1.5",
      "limit=1000",
      "limit=0",
      "limit=abc",
      "status=bogus",
      "page=",
    ]
  ) {
    const res = await call(app, "GET", `/api/tasks?${q}`, { token });
    assertEquals(res.status, 400, q);
    assertErrorShape(res.json, "validation failed");
  }
});

Deno.test("DELETE is a soft delete: gone from the list and the lookup, then restorable", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token, { title: "temporary" });

  const del = await call(app, "DELETE", `/api/tasks/${task.id}`, { token });
  assertEquals(del.status, 200);
  assertEquals(del.json, { ok: true });
  assertEquals((await call(app, "GET", `/api/tasks/${task.id}`, { token })).status, 404);
  const list = (await call(app, "GET", "/api/tasks", { token }))
    .json as unknown as PageJson;
  assert(!list.items.some((t) => t.id === task.id));
  assertEquals(
    (await call(app, "DELETE", `/api/tasks/${task.id}`, { token })).status,
    404,
  ); // twice
  assertEquals(
    (await call(app, "PUT", `/api/tasks/${task.id}`, { token, body: { title: "x" } }))
      .status,
    404,
  );

  const back = await call(app, "POST", `/api/tasks/${task.id}/restore`, { token });
  assertEquals(back.status, 200);
  assertEquals(back.json.title, "temporary");
  assertEquals((await call(app, "GET", `/api/tasks/${task.id}`, { token })).status, 200);
});

Deno.test("restoring a task that is not deleted (or does not exist) is 404", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token);
  assertEquals(
    (await call(app, "POST", `/api/tasks/${task.id}/restore`, { token })).status,
    404,
  );
  assertEquals(
    (await call(app, "POST", "/api/tasks/9999/restore", { token })).status,
    404,
  );
});

Deno.test("an unknown route is 404 in the error shape", async () => {
  const app = await freshApp();
  const res = await call(app, "GET", "/nothing/here");
  assertEquals(res.status, 404);
  assertErrorShape(res.json, "not found");
  const post = await call(app, "POST", "/api/nothing", { body: {} });
  assertEquals(post.status, 401); // /api/* needs a token before anything else
});

Deno.test("the summary counts my tasks per status and ignores deleted ones", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com"); // 1 welcome task (todo)
  const other = await signUp(app, "b@example.com");
  await makeTask(app, token, { title: "a", status: "done" });
  await makeTask(app, token, { title: "b", status: "done" });
  await makeTask(app, token, { title: "c", status: "in-progress" });
  const gone = await makeTask(app, token, { title: "d", status: "in-progress" });
  await call(app, "DELETE", `/api/tasks/${gone.id}`, { token });
  await makeTask(app, other, { title: "not mine", status: "done" });
  const res = await call(app, "GET", "/api/me/summary", { token });
  assertEquals(res.status, 200);
  assertEquals(res.json, { "todo": 1, "in-progress": 1, "done": 2, total: 4 });
});
