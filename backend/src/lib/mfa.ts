// DB layer for TOTP MFA factors (public.user_totp_factors). One factor per user.
// Secrets are encrypted at rest with secretCrypto (AES-256-GCM). All functions
// take an optional Db so callers can share a client.

import { createServerSupabase } from "./supabase";
import { encryptSecret, decryptSecret } from "./secretCrypto";

type Db = ReturnType<typeof createServerSupabase>;

const SALT = "mike-totp-v1";

interface FactorRow {
  user_id: string;
  encrypted_secret: string;
  iv: string;
  auth_tag: string;
  verified: boolean;
  created_at: string;
  verified_at: string | null;
}

export interface MfaFactor {
  verified: boolean;
  /** Decrypted TOTP secret, or null if it could not be decrypted. */
  secret: string | null;
}

async function loadRow(userId: string, db: Db): Promise<FactorRow | null> {
  const { data, error } = await db
    .from("user_totp_factors")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as FactorRow | null) ?? null;
}

/** Return the user's factor with its decrypted secret, or null if none. */
export async function getFactor(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<MfaFactor | null> {
  const row = await loadRow(userId, db);
  if (!row) return null;
  return {
    verified: row.verified === true,
    secret: decryptSecret(
      { ciphertext: row.encrypted_secret, iv: row.iv, authTag: row.auth_tag },
      SALT,
    ),
  };
}

/** Whether the user has completed TOTP enrollment (verified factor). */
export async function userHasVerifiedTotp(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<boolean> {
  const row = await loadRow(userId, db);
  return row?.verified === true;
}

/**
 * Store a fresh (unverified) secret for the user, replacing any prior pending
 * or verified factor. Used at the start of enrollment.
 */
export async function upsertPendingSecret(
  userId: string,
  secret: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  const enc = encryptSecret(secret, SALT);
  const { error } = await db.from("user_totp_factors").upsert(
    {
      user_id: userId,
      encrypted_secret: enc.ciphertext,
      iv: enc.iv,
      auth_tag: enc.authTag,
      verified: false,
      verified_at: null,
      created_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}

/** Mark the user's pending factor as verified (completes enrollment). */
export async function markVerified(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  const { error } = await db
    .from("user_totp_factors")
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
}

/** Remove the user's factor entirely (unenroll). */
export async function deleteFactor(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  const { error } = await db
    .from("user_totp_factors")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}
