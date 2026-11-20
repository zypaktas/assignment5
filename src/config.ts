// Zeynep Sudem Aktaş, 2025502009
// Bonus 11: one validated configuration object instead of loose Deno.env.get calls.
import { z } from "zod";

export const DEFAULT_SECRET = "dev-secret";

const Raw = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(1).optional(),
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_EMAIL: z.email().optional(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(4),
  KV_PATH: z.string().min(1).optional(),
  UPLOAD_DIR: z.string().min(1).default("./uploads"),
  PURGE_CRON: z.string().min(1).default("0 3 * * *"),
});

export type Config = {
  port: number;
  databaseUrl: string;
  databaseAuthToken?: string;
  jwtSecret: string;
  appEnv: "development" | "test" | "production";
  adminEmail?: string;
  dbPoolSize: number;
  kvPath?: string;
  uploadDir: string;
  purgeCron: string;
};

export class ConfigError extends Error {}

/** Read the configuration once. Throws a ConfigError with a readable message. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  // an empty value in a .env file (for example `ADMIN_EMAIL=`) means "not set"
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = Raw.safeParse(cleaned);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      problems.push(`${i.path.join(".") || "config"}: ${i.message}`);
    }
  }
  const raw = parsed.success ? parsed.data : undefined;
  const appEnv = raw?.APP_ENV ?? "development";

  if (appEnv === "production") {
    // in production nothing may silently fall back to a development default
    if (!cleaned.DATABASE_URL) problems.push("DATABASE_URL: required in production");
    const secret = cleaned.JWT_SECRET;
    if (!secret) problems.push("JWT_SECRET: required in production");
    else if (secret === DEFAULT_SECRET || secret.startsWith("change-me")) {
      problems.push(
        "JWT_SECRET: the development/placeholder secret is refused in production",
      );
    } else if (secret.length < 16) {
      problems.push("JWT_SECRET: must be at least 16 characters in production");
    }
  }
  if (problems.length > 0 || !raw) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return {
    port: raw.PORT,
    databaseUrl: raw.DATABASE_URL ?? "file:./tasks.db",
    databaseAuthToken: raw.DATABASE_AUTH_TOKEN,
    jwtSecret: raw.JWT_SECRET ?? DEFAULT_SECRET,
    appEnv,
    adminEmail: raw.ADMIN_EMAIL?.toLowerCase(),
    dbPoolSize: raw.DB_POOL_SIZE,
    kvPath: raw.KV_PATH,
    uploadDir: raw.UPLOAD_DIR,
    purgeCron: raw.PURGE_CRON,
  };
}
