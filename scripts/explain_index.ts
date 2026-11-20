// Zeynep Sudem Aktaş, 2025502009
// Bonus 4: a list query before and after an index, with the query plan and the time.
import { closeDb, createDb, migrate } from "../src/db.ts";
import { PRIORITIES, STATUSES, tasks, users } from "../src/schema.ts";

const file = await Deno.makeTempFile({ suffix: ".db" });
const db = createDb(`file:${file}`, { poolSize: 1 });
await migrate(db);

// migrate() already created the index from schema.ts, so drop it to see "before"
await db.client.execute("DROP INDEX idx_tasks_user_status");

const USERS = 20;
const TOTAL = 20_000;
await db.db.insert(users).values(
  Array.from(
    { length: USERS },
    (_, i) => ({ email: `u${i}@example.com`, passwordHash: "x" }),
  ),
);
for (let start = 0; start < TOTAL; start += 1000) {
  const batch = Array.from({ length: 1000 }, (_, i) => {
    const n = start + i;
    return {
      userId: (n % USERS) + 1,
      title: `task ${n}`,
      status: STATUSES[n % 3],
      priority: PRIORITIES[n % 3],
    };
  });
  await db.db.insert(tasks).values(batch);
}
console.log(`${TOTAL} tasks for ${USERS} users inserted\n`);

// the two queries that GET /api/tasks?status=done runs for one user
const QUERIES = {
  "page of tasks":
    "SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY id LIMIT 20 OFFSET 200",
  "total (count)": "SELECT count(*) FROM tasks WHERE user_id = ? AND status = ?",
};
const args = [7, "done"];

async function plan(label: string, sql: string) {
  const res = await db.client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
  console.log(`${label} plan : ${res.rows.map((r) => String(r.detail)).join(" | ")}`);
}
async function time(label: string, sql: string) {
  const RUNS = 300;
  await db.client.execute({ sql, args }); // warm up
  const start = performance.now();
  for (let i = 0; i < RUNS; i++) await db.client.execute({ sql, args });
  const ms = (performance.now() - start) / RUNS;
  console.log(`${label} time : ${ms.toFixed(3)} ms per query (average of ${RUNS} runs)`);
  return ms;
}

const before: Record<string, number> = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  console.log(`--- ${name}: ${sql}`);
  await plan("BEFORE", sql);
  before[name] = await time("BEFORE", sql);
}
await db.client.execute("CREATE INDEX idx_tasks_user_status ON tasks(user_id, status)");
console.log("\nCREATE INDEX idx_tasks_user_status ON tasks(user_id, status)\n");
for (const [name, sql] of Object.entries(QUERIES)) {
  console.log(`--- ${name}`);
  await plan("AFTER ", sql);
  const after = await time("AFTER ", sql);
  console.log(`speed-up: ${(before[name] / after).toFixed(1)}x`);
}
closeDb(db);
await Deno.remove(file).catch(() => {});
