import { createDb, type Db } from "./db";
import { verifySession } from "./session";

/**
 * Server-side database client for application data.
 *
 * Migrated off Supabase-PostgREST to self-hosted Postgres: this now returns the
 * query-builder shim (see ./db), which reproduces the supabase-js query API the
 * backend uses so existing `.from(...).select()/.eq()/...` call sites keep
 * working. The name is retained to avoid churn across ~20 files. Auth is now
 * handled by LDAP + our own session tokens (see lib/authUsers, routes/auth).
 */
export function createServerSupabase(): Db {
  return createDb();
}

/**
 * Extract and verify our session token from the Authorization header.
 * Returns the user's UUID string, or throws a Response with 401.
 */
export async function getUserIdFromRequest(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", {
      status: 401,
    });
  }
  const token = auth.slice(7).trim();
  const claims = verifySession(token);
  if (!claims) {
    throw new Response("Invalid or expired token", { status: 401 });
  }
  return claims.sub;
}
