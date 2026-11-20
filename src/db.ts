// Zeynep Sudem Aktaş, 2025502009
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate as runMigrations } from "drizzle-orm/libsql/migrator";
import type { Logger } from "drizzle-orm";
import { type Client, createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";
import { Pool } from "./pool.ts";

export type Schema = typeof schema;
/** One connection: a libSQL client and the Drizzle object built on it. */
export type Conn = { db: LibSQLDatabase<Schema>; client: Client };
/**
 * The database: `db` and `client` are the first connection (used for start-up work such as
 * migrations and seeding); `pool` holds all connections and is what the routes borrow from.
 */
export type Db = Conn & { pool: Pool<Conn>; conns: Conn[] };
export type DbOptions = { poolSize?: number; authToken?: string; logger?: Logger };

/** Open a database with a pool of connections. Tests pass a temporary file. */
export function createDb(url: string, opts: DbOptions = {}): Db {
  // every connection to ":memory:" would be its own empty database, so use exactly one
  const size = url.includes(":memory:") ? 1 : Math.max(1, opts.poolSize ?? 4);
  const conns: Conn[] = Array.from({ length: size }, () => {
    const client = createClient({ url, authToken: opts.authToken });
    return { client, db: drizzle(client, { schema, logger: opts.logger }) };
  });
  return { ...conns[0], conns, pool: new Pool(conns) };
}

/**
 * Per-connection settings. busy_timeout makes SQLite wait up to 5 s for a lock instead of
 * failing at once. It belongs to one connection, so it has to be set again after
 * db.transaction() (libSQL opens a fresh connection behind the client after a transaction).
 */
export async function tuneConn(conn: Conn): Promise<void> {
  if (conn.client.protocol === "file") {
    await conn.client.execute("PRAGMA busy_timeout=5000");
  }
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Bonus 1: apply the SQL migration files that Drizzle Kit generated from schema.ts
 * (folder drizzle/). Already applied files are skipped, so this is safe at every start.
 */
export async function migrate(db: Db): Promise<void> {
  if (db.client.protocol === "file") {
    // WAL: readers do not block the writer. The setting is stored in the database file.
    await db.client.execute("PRAGMA journal_mode=WAL");
  }
  await Promise.all(db.conns.map(tuneConn));
  await runMigrations(db.db, { migrationsFolder });
  await Promise.all(db.conns.map(tuneConn));
}

/** Close every connection (tests and shutdown). */
export function closeDb(db: Db): void {
  for (const c of db.conns) c.client.close();
}
