// Zeynep Sudem Aktaş, 2025502009
import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Conn } from "./db.ts";
import { ROLES } from "./schema.ts";

export type Role = (typeof ROLES)[number];

/** What the middlewares put into the Hono context for the routes to read. */
export type Env = {
  Variables: { userId: number; role: Role; conn: Conn; requestId: string };
};

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const checkPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// ---- Bonus 7: JWT instead of sessions -------------------------------------------------
// The token is signed with HS256. The user id is in the `sub` claim, the role in `role`,
// and the token expires after one hour. Checking it needs no database lookup.

const key = (secret: string) => new TextEncoder().encode(secret);

export function signToken(
  userId: number,
  role: Role,
  secret: string,
  expiresAt: string | number = "1h",
): Promise<string> {
  return new SignJWT({ role }).setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId)).setIssuedAt().setExpirationTime(expiresAt).sign(
      key(secret),
    );
}

export type Identity = { userId: number; role: Role };

/** Returns who the token belongs to, or null for a bad, tampered, expired or foreign token. */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<Identity | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    const userId = Number(payload.sub);
    const role = payload.role;
    if (!Number.isSafeInteger(userId) || userId < 1) return null;
    if (role !== "user" && role !== "admin") return null;
    return { userId, role };
  } catch {
    return null; // bad signature, malformed or expired
  }
}

/** Read "Authorization: Bearer <token>" (also used by the WebSocket route). */
export function bearerToken(header: string | undefined): string {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m ? m[1] : "";
}

/** Middleware: 401 without a valid token, otherwise store userId and role for the route. */
export const requireAuth =
  (secret: string): MiddlewareHandler<Env> => async (c, next) => {
    const who = await verifyToken(bearerToken(c.req.header("authorization")), secret);
    if (who === null) {
      return c.json({ error: "unauthorized", requestId: c.get("requestId") }, 401);
    }
    c.set("userId", who.userId);
    c.set("role", who.role);
    await next();
  };

// ---- Bonus 9: roles -------------------------------------------------------------------
/** 401 if nobody is logged in, 403 if the role is not allowed. */
export const requireRole =
  (...roles: Role[]): MiddlewareHandler<Env> => async (c, next) => {
    const role = c.get("role");
    if (!role) {
      return c.json({ error: "unauthenticated", requestId: c.get("requestId") }, 401);
    }
    if (!roles.includes(role)) {
      return c.json({ error: "forbidden", requestId: c.get("requestId") }, 403);
    }
    await next();
  };
