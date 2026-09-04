import crypto from "node:crypto";
import { query } from "./db";
import { signSession, type SessionClaims } from "./session";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function issueSession(
  claims: Omit<SessionClaims, "sessionId">,
): Promise<{ token: string; sessionId: string }> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `insert into public.user_sessions (id, user_id, expires_at)
     values ($1, $2, $3)`,
    [sessionId, claims.sub, expiresAt],
  );
  // Opportunistic bounded cleanup avoids an unbounded history without putting
  // a scheduled job on the critical deployment path.
  await query(
    `delete from public.user_sessions
     where user_id = $1 and (expires_at <= now() or revoked_at is not null)`,
    [claims.sub],
  );
  return {
    sessionId,
    token: signSession({ ...claims, sessionId }),
  };
}

export function rotateSessionToken(
  claims: Omit<SessionClaims, "sessionId">,
  sessionId: string,
): string {
  return signSession({ ...claims, sessionId });
}

export async function sessionIsActive(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const result = await query(
    `select 1 from public.user_sessions
     where id = $1 and user_id = $2 and revoked_at is null and expires_at > now()
     limit 1`,
    [sessionId, userId],
  );
  return result.rowCount === 1;
}

export async function revokeSession(
  sessionId: string,
  userId: string,
): Promise<void> {
  await query(
    `update public.user_sessions set revoked_at = now()
     where id = $1 and user_id = $2 and revoked_at is null`,
    [sessionId, userId],
  );
}
