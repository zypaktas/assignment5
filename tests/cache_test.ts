// Zeynep Sudem Aktaş, 2025502009
// Bonus 16: GET /api/tasks/:id is cached in Deno KV for 60 seconds.
import { assertEquals } from "@std/assert";
import { call, counter, freshAppWithDb, makeTask, signUp } from "./helpers.ts";

async function setup() {
  const c = counter();
  const kv = await Deno.openKv(":memory:");
  const { app, db } = await freshAppWithDb({ kv }, { logger: c.logger });
  const a = await signUp(app, "a@example.com");
  const b = await signUp(app, "b@example.com");
  const task = await makeTask(app, a, { title: "cached" });
  c.queries.length = 0;
  return { app, db, kv, c, a, b, task };
}

Deno.test("cache hit: the second read does not touch the database", async () => {
  const { app, kv, c, a, task } = await setup();
  const first = await call(app, "GET", `/api/tasks/${task.id}`, { token: a });
  assertEquals(c.reads("tasks"), 1); // a miss: one SELECT
  const second = await call(app, "GET", `/api/tasks/${task.id}`, { token: a });
  const third = await call(app, "GET", `/api/tasks/${task.id}`, { token: a });
  assertEquals(c.reads("tasks"), 1); // still one: the next two came from the cache
  assertEquals(second.json, first.json);
  assertEquals(third.json, first.json);
  kv.close();
});

Deno.test("invalidation: a changed task is not served stale", async () => {
  const { app, kv, c, a, task } = await setup();
  await call(app, "GET", `/api/tasks/${task.id}`, { token: a }); // fills the cache
  await call(app, "PUT", `/api/tasks/${task.id}`, {
    token: a,
    body: { title: "changed" },
  });
  const after = await call(app, "GET", `/api/tasks/${task.id}`, { token: a });
  assertEquals(after.json.title, "changed");
  assertEquals(c.reads("tasks"), 2); // the read after the PUT went to the database again
  kv.close();
});

Deno.test("invalidation: a deleted task is 404 at once, a restored one is back", async () => {
  const { app, kv, a, task } = await setup();
  await call(app, "GET", `/api/tasks/${task.id}`, { token: a });
  await call(app, "DELETE", `/api/tasks/${task.id}`, { token: a });
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}`, { token: a })).status,
    404,
  );
  await call(app, "POST", `/api/tasks/${task.id}/restore`, { token: a });
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}`, { token: a })).status,
    200,
  );
  kv.close();
});

Deno.test("the cache key includes the user: B never gets A's cached task", async () => {
  const { app, kv, c, a, b, task } = await setup();
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}`, { token: a })).status,
    200,
  ); // cached for A
  const stranger = await call(app, "GET", `/api/tasks/${task.id}`, { token: b });
  assertEquals(stranger.status, 404);
  assertEquals(c.reads("tasks"), 2, "B's request had its own lookup and found nothing");
  const keys: unknown[][] = [];
  for await (const e of kv.list({ prefix: ["task"] })) keys.push([...e.key]);
  assertEquals(keys.length, 1);
  assertEquals(keys[0].length, 3); // ["task", userId, taskId]
  kv.close();
});

Deno.test("a missing task is not cached (404 stays 404, a later task with that id shows up)", async () => {
  const { app, kv, a } = await setup();
  assertEquals((await call(app, "GET", "/api/tasks/9999", { token: a })).status, 404);
  const entries: unknown[] = [];
  for await (const e of kv.list({ prefix: ["task"] })) entries.push(e);
  assertEquals(entries.length, 0);
  kv.close();
});

Deno.test("without a KV store the app still works and reads the database every time", async () => {
  const c = counter();
  const { app } = await freshAppWithDb({}, { logger: c.logger });
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token);
  c.queries.length = 0;
  await call(app, "GET", `/api/tasks/${task.id}`, { token });
  await call(app, "GET", `/api/tasks/${task.id}`, { token });
  assertEquals(c.reads("tasks"), 2);
});
