// Zeynep Sudem Aktaş, 2025502009
// Bonus 3: count the SQL statements of a naive and of a good version.
import { closeDb, createDb, migrate } from "../src/db.ts";
import {
  adminUsersJoin,
  adminUsersNaive,
  summaryGood,
  summaryNaive,
} from "../src/queries.ts";
import { PRIORITIES, STATUSES, tasks, users } from "../src/schema.ts";

const logged: string[] = [];
const file = await Deno.makeTempFile({ suffix: ".db" });
const db = createDb(`file:${file}`, {
  poolSize: 1,
  // the same idea as drizzle(client, { logger: true }), but it keeps the lines so we can count
  logger: { logQuery: (q) => void logged.push(q) },
});
await migrate(db);

const USERS = 10;
const PER_USER = 30;
await db.db.insert(users).values(
  Array.from(
    { length: USERS },
    (_, i) => ({ email: `u${i}@example.com`, passwordHash: "x" }),
  ),
);
const rows = [];
for (let u = 1; u <= USERS; u++) {
  for (let t = 0; t < PER_USER; t++) {
    rows.push({
      userId: u,
      title: `task ${t}`,
      status: STATUSES[t % 3],
      priority: PRIORITIES[t % 3],
    });
  }
}
await db.db.insert(tasks).values(rows);

async function measure<T>(label: string, fn: () => Promise<T>) {
  logged.length = 0;
  await fn();
  console.log(`\n${label}: ${logged.length} queries`);
  for (const q of logged.slice(0, 3)) console.log("  " + q);
  if (logged.length > 3) console.log(`  ... and ${logged.length - 3} more`);
  return logged.length;
}

console.log(`Data: ${USERS} users with ${PER_USER} tasks each`);
await measure(
  "summary, NAIVE (load all tasks, then a count per status)",
  () => summaryNaive(db, 1),
);
await measure("summary, GOOD  (one GROUP BY)", () => summaryGood(db, 1));
await measure(
  "admin list, NAIVE (1 for the users + 1 per user)",
  () => adminUsersNaive(db),
);
await measure("admin list, GOOD  (one LEFT JOIN + GROUP BY)", () => adminUsersJoin(db));

// the naive admin list grows with the number of users, the join does not
await db.db.insert(users).values(
  Array.from(
    { length: 40 },
    (_, i) => ({ email: `v${i}@example.com`, passwordHash: "x" }),
  ),
);
console.log(`\nAfter adding 40 more users (${USERS + 40} in total):`);
await measure("admin list, NAIVE", () => adminUsersNaive(db));
await measure("admin list, GOOD ", () => adminUsersJoin(db));
closeDb(db);
await Deno.remove(file).catch(() => {});
