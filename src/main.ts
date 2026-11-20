// Zeynep Sudem Aktaş, 2025502009
import { createApp } from "./app.ts";
import { closeDb, createDb, migrate } from "./db.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { purgeOldDone } from "./queries.ts";

// Bonus 11: read and validate the configuration once; stop with a clear message if it is wrong.
let config;
try {
  config = loadConfig(Deno.env.toObject());
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    Deno.exit(1);
  }
  throw e;
}

const db = createDb(config.databaseUrl, {
  poolSize: config.dbPoolSize,
  authToken: config.databaseAuthToken,
});
await migrate(db);

// Bonus 16: Deno KV holds the task cache
const kv = await Deno.openKv(config.kvPath);

const app = createApp(db, {
  jwtSecret: config.jwtSecret,
  adminEmail: config.adminEmail,
  kv,
  uploadDir: config.uploadDir,
});

// Bonus 14: once a day at 03:00 delete tasks that were done more than 30 days ago
Deno.cron("purge old done tasks", config.purgeCron, async () => {
  const removed = await purgeOldDone(db, 30, config.uploadDir);
  console.log(JSON.stringify({ job: "purge", removed }));
});

const server = Deno.serve({ port: config.port }, app.fetch);
console.log(JSON.stringify({ msg: "listening", port: config.port, env: config.appEnv }));

// stop cleanly on Ctrl+C
Deno.addSignalListener("SIGINT", async () => {
  await server.shutdown();
  closeDb(db);
  kv.close();
  Deno.exit(0);
});
