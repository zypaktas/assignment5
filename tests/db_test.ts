// Zeynep Sudem Aktaş, 2025502009
// R2 (the tables), Bonus 1 (migrations), Bonus 3 (N+1), Bonus 6 (pool), Bonus 14 (purge job).
import { assert, assertEquals } from "@std/assert";
import { eq, getTableColumns } from "drizzle-orm";
import { call, counter, freshApp, freshAppWithDb, signUp } from "./helpers.ts";
import { closeDb, createDb, migrate } from "../src/db.ts";
import { tasks, users } from "../src/schema.ts";
import { Pool } from "../src/pool.ts";
import {
  adminUsersJoin,
  adminUsersNaive,
  purgeOldDone,
  summaryGood,
  summaryNaive,
} from "../src/queries.ts";

const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

Deno.test("a task row can be inserted through Drizzle and read back, with SQL defaults", async () => {
  const { db } = await freshAppWithDb();
  const [user] = await db.db.insert(users).values({
    email: "a@example.com",
    passwordHash: "x",
  })
    .returning();
  const [inserted] = await db.db.insert(tasks).values({
    userId: user.id,
    title: "from drizzle",
  })
    .returning();
  const [read] = await db.db.select().from(tasks).where(eq(tasks.id, inserted.id));
  assertEquals(read.title, "from drizzle");
  assertEquals([read.status, read.priority], ["todo", "medium"]); // the defaults
  assert(read.createdAt > 1_700_000_000, "createdAt comes from the SQL default");
  assertEquals([read.deletedAt, read.completedAt, read.attachment], [null, null, null]);
});

Deno.test("createdAt is a SQL default: it is set per row, not once at start-up", async () => {
  const { db } = await freshAppWithDb();
  const [user] = await db.db.insert(users).values({
    email: "a@example.com",
    passwordHash: "x",
  })
    .returning();
  const [first] = await db.db.insert(tasks).values({ userId: user.id, title: "1" })
    .returning();
  await new Promise((r) => setTimeout(r, 1100));
  const [second] = await db.db.insert(tasks).values({ userId: user.id, title: "2" })
    .returning();
  assert(second.createdAt > first.createdAt, "two rows, two different times");
});

Deno.test("schema.ts and the migrations describe the same columns", async () => {
  const { db } = await freshAppWithDb();
  for (const [name, table] of [["users", users], ["tasks", tasks]] as const) {
    const info = await db.client.execute(`PRAGMA table_info(${name})`);
    const inDatabase = info.rows.map((r) => String(r.name)).sort();
    const inSchema = Object.values(getTableColumns(table)).map((c) => c.name).sort();
    assertEquals(inDatabase, inSchema, `columns of ${name}`);
  }
});

Deno.test("the migrations made the index, and the old sessions table is gone", async () => {
  const { db } = await freshAppWithDb();
  const rows = await db.client.execute("SELECT type, name FROM sqlite_master");
  const names = rows.rows.map((r) => `${r.type}:${r.name}`);
  assert(names.includes("index:idx_tasks_user_status"));
  assert(!names.includes("table:sessions"), "JWT replaced the sessions table");
});

Deno.test("migrate() is safe to run again: applied files are skipped", async () => {
  const { db } = await freshAppWithDb();
  await migrate(db);
  await migrate(db);
  const applied = await db.client.execute(
    "SELECT count(*) AS n FROM __drizzle_migrations",
  );
  const files = [...Deno.readDirSync(new URL("../drizzle", import.meta.url))]
    .filter((f) => f.name.endsWith(".sql"));
  assertEquals(Number(applied.rows[0].n), files.length);
  assert(files.length >= 2, "at least the first migration and an ALTER TABLE one");
});

Deno.test("the second migration is an ALTER TABLE (a real change, not the first CREATE)", async () => {
  const sql = await Deno.readTextFile(
    new URL("../drizzle/0001_add_due_date.sql", import.meta.url),
  );
  assert(sql.startsWith("ALTER TABLE"));
});

// ---- Bonus 3 ------------------------------------------------------------------------------
Deno.test("N+1: the naive and the good summary agree, the good one sends one query", async () => {
  const c = counter();
  const { app, db } = await freshAppWithDb({}, { logger: c.logger });
  const token = await signUp(app, "a@example.com");
  await call(app, "POST", "/api/tasks", { token, body: { title: "x", status: "done" } });
  const [user] = await db.db.select().from(users);

  c.queries.length = 0;
  const naive = await summaryNaive(db, user.id);
  const naiveCount = c.queries.length;
  c.queries.length = 0;
  const good = await summaryGood(db, user.id);
  const goodCount = c.queries.length;

  assertEquals(naive, good);
  assertEquals(good, { "todo": 1, "in-progress": 0, "done": 1, total: 2 });
  assertEquals(goodCount, 1);
  assertEquals(naiveCount, 4); // 1 for the rows + 1 per status
});

Deno.test("N+1: the naive admin list needs one query per user, the join needs one in total", async () => {
  const c = counter();
  const { app, db } = await freshAppWithDb({}, { logger: c.logger });
  for (const n of [1, 2, 3, 4, 5]) await signUp(app, `u${n}@example.com`);

  c.queries.length = 0;
  const naive = await adminUsersNaive(db);
  assertEquals(c.queries.length, 1 + 5);
  c.queries.length = 0;
  const joined = await adminUsersJoin(db);
  assertEquals(c.queries.length, 1);
  assertEquals(naive, joined);

  await signUp(app, "u6@example.com"); // one more user: the naive list grows, the join does not
  c.queries.length = 0;
  await adminUsersNaive(db);
  assertEquals(c.queries.length, 1 + 6);
  c.queries.length = 0;
  await adminUsersJoin(db);
  assertEquals(c.queries.length, 1);
});

// ---- Bonus 6 ------------------------------------------------------------------------------
Deno.test("pool: 20 jobs on a pool of 3 never run more than 3 at once, and all finish", async () => {
  const pool = new Pool(["c1", "c2", "c3"]);
  let running = 0;
  let max = 0;
  let finished = 0;
  await Promise.all(Array.from({ length: 20 }, () =>
    pool.use(async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      finished++;
    })));
  assertEquals(max, 3);
  assertEquals(finished, 20);
  assertEquals(pool.idleCount, 3); // everything was given back
  assertEquals(pool.waitingCount, 0);
});

Deno.test("pool: a job that throws still gives its connection back", async () => {
  const pool = new Pool(["only"]);
  let caught = false;
  await pool.use(() => Promise.reject(new Error("boom"))).catch(() => (caught = true));
  assert(caught);
  assertEquals(pool.idleCount, 1);
  assertEquals(await pool.use((c) => Promise.resolve(c)), "only"); // and it can be borrowed again
});

Deno.test("pool: callers wait in a queue when all connections are busy", async () => {
  const pool = new Pool([1]);
  const held = await pool.acquire();
  const order: string[] = [];
  const waiting1 = pool.acquire().then((c) => (order.push("first"), pool.release(c)));
  const waiting2 = pool.acquire().then((c) => (order.push("second"), pool.release(c)));
  assertEquals(pool.waitingCount, 2);
  pool.release(held);
  await Promise.all([waiting1, waiting2]);
  assertEquals(order, ["first", "second"]);
});

Deno.test("pool: 30 requests at once on 3 SQLite connections all succeed (WAL + busy_timeout)", async () => {
  const { app, db } = await freshAppWithDb({}, { poolSize: 3 });
  assertEquals(db.conns.length, 3);
  const token = await signUp(app, "a@example.com");
  const results = await Promise.all(
    Array.from(
      { length: 30 },
      (_, i) =>
        call(app, "POST", "/api/tasks", { token, body: { title: `parallel ${i}` } }),
    ),
  );
  assertEquals(results.map((r) => r.status), Array(30).fill(201));
  const page = await call(app, "GET", "/api/tasks?limit=100", { token });
  assertEquals(page.json.total, 31); // 30 + the welcome task
  assertEquals(db.pool.idleCount, 3);
});

Deno.test("an in-memory database gets exactly one connection (more would be separate databases)", () => {
  const db = createDb(":memory:", { poolSize: 5 });
  assertEquals(db.conns.length, 1);
  closeDb(db);
});

// ---- Bonus 14 -----------------------------------------------------------------------------
Deno.test("purgeOldDone deletes only tasks done more than N days ago, and is idempotent", async () => {
  const { db } = await freshAppWithDb();
  const [user] = await db.db.insert(users).values({
    email: "a@example.com",
    passwordHash: "x",
  })
    .returning();
  await db.db.insert(tasks).values([
    {
      userId: user.id,
      title: "done 40 days ago",
      status: "done",
      completedAt: NOW() - 40 * DAY,
    },
    {
      userId: user.id,
      title: "done 31 days ago",
      status: "done",
      completedAt: NOW() - 31 * DAY,
    },
    {
      userId: user.id,
      title: "done 29 days ago",
      status: "done",
      completedAt: NOW() - 29 * DAY,
    },
    { userId: user.id, title: "done today", status: "done", completedAt: NOW() },
    {
      userId: user.id,
      title: "old but not done",
      status: "todo",
      createdAt: NOW() - 90 * DAY,
    },
  ]);
  assertEquals(await purgeOldDone(db, 30), 2);
  const left = (await db.db.select().from(tasks)).map((t) => t.title).sort();
  assertEquals(left, ["done 29 days ago", "done today", "old but not done"]);
  assertEquals(await purgeOldDone(db, 30), 0); // the second run changes nothing
  assertEquals((await db.db.select().from(tasks)).length, 3);
});

Deno.test("purgeOldDone also removes the uploaded file of a purged task", async () => {
  const { db } = await freshAppWithDb();
  const dir = await Deno.makeTempDir();
  const name = `${crypto.randomUUID()}.png`;
  await Deno.writeFile(`${dir}/${name}`, new Uint8Array([1, 2, 3]));
  const [user] = await db.db.insert(users).values({
    email: "a@example.com",
    passwordHash: "x",
  })
    .returning();
  await db.db.insert(tasks).values({
    userId: user.id,
    title: "old",
    status: "done",
    completedAt: NOW() - 60 * DAY,
    attachment: name,
  });
  assertEquals(await purgeOldDone(db, 30, dir), 1);
  assertEquals([...Deno.readDirSync(dir)].length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("freshApp gives every test its own empty database", async () => {
  const a = await freshApp();
  const b = await freshApp();
  await signUp(a, "same@example.com");
  const again = await call(b, "POST", "/auth/register", {
    body: { email: "same@example.com", password: "secret123" },
  });
  assertEquals(again.status, 201); // not 409: b does not know the user of a
});
