// Zeynep Sudem Aktaş, 2025502009
// Bonus 5: fill a database with 2 demo users and 20 tasks. Safe to run twice.
import { inArray } from "drizzle-orm";
import { closeDb, createDb, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { hashPassword } from "../src/auth.ts";
import { PRIORITIES, STATUSES, tasks, users } from "../src/schema.ts";

// check APP_ENV first, with its own message, before the rest of the configuration is read
if (Deno.env.get("APP_ENV") === "production") {
  console.error("Refusing to seed: APP_ENV is production.");
  Deno.exit(1);
}
const config = loadConfig(Deno.env.toObject());

export const DEMO_PASSWORD = "demo12345";
const DEMO = [
  { email: "demo@example.com", role: "user" as const },
  { email: "admin@example.com", role: "admin" as const },
];

const db = createDb(config.databaseUrl, {
  poolSize: 1,
  authToken: config.databaseAuthToken,
});
await migrate(db); // a fresh database has no tables yet

// 1. users: onConflictDoNothing means "the email already exists, leave it alone"
const passwordHash = await hashPassword(DEMO_PASSWORD);
await db.db.insert(users).values(DEMO.map((u) => ({ ...u, passwordHash })))
  .onConflictDoNothing();
const demoUsers = await db.db.select().from(users)
  .where(inArray(users.email, DEMO.map((u) => u.email)));

// 2. tasks: skip them if these users already have some, so a second run adds nothing
const existing = await db.db.select({ id: tasks.id }).from(tasks)
  .where(inArray(tasks.userId, demoUsers.map((u) => u.id)));
if (existing.length > 0) {
  console.log(`Nothing to do: the demo users already have ${existing.length} tasks.`);
} else {
  const titles = [
    "Read the assignment",
    "Run the starter",
    "Add the tasks table",
    "Write register",
    "Write login",
    "Auth middleware",
    "Task routes",
    "Validation with Zod",
    "Pagination",
    "Write ten tests",
    "Fill the README",
    "Zip and upload",
    "Buy coffee",
    "Plan the week",
    "Email the instructor",
    "Backup the database",
    "Try the docs page",
    "Rest a little",
    "Refactor app.ts",
    "Celebrate",
  ];
  const day = 86_400;
  const now = Math.floor(Date.now() / 1000);
  const rows = titles.map((title, i) => {
    const status = STATUSES[i % 3];
    return {
      userId: demoUsers[i % demoUsers.length].id,
      title,
      status,
      priority: PRIORITIES[i % 3],
      // done tasks finished between 1 and 60 days ago, so the purge job (30 days) has work
      completedAt: status === "done" ? now - ((i * 9) % 60 + 1) * day : null,
    };
  });
  await db.db.insert(tasks).values(rows);
  console.log(`Seeded ${demoUsers.length} users and ${rows.length} tasks.`);
}
console.log(
  `Log in as ${DEMO[0].email} or ${DEMO[1].email} (admin), password: ${DEMO_PASSWORD}`,
);
closeDb(db);
