// Application user identity backed by auth.users. Replaces Supabase's managed
// auth user store. Uses raw SQL (not the query shim) because auth.users lives in
// the `auth` schema, which the shim's public-schema .from() does not address.
//
// Inserting a new auth.users row fires the handle_new_user() trigger, which
// seeds public.user_profiles — exactly as Supabase signup did.

import { query } from "./db";

export interface AuthUser {
  id: string;
  email: string | null;
  ldapUid: string | null;
}

/**
 * Look up (or create) the app user for an LDAP identity, keyed by ldap_uid so
 * the app UUID is stable across logins. Returns the app user id (auth.users.id).
 * A pre-seeded row (e.g. an existing Supabase UUID mapped to this ldap_uid) is
 * reused rather than replaced.
 */
export async function upsertLdapUser(
  ldapUid: string,
  email: string | null,
): Promise<AuthUser> {
  const res = await query(
    `insert into auth.users (ldap_uid, email)
     values ($1, $2)
     on conflict (ldap_uid) do update set
       email = excluded.email,
       updated_at = now()
     returning id, email, ldap_uid`,
    [ldapUid, email],
  );
  const row = res.rows[0] as { id: string; email: string | null; ldap_uid: string | null };
  return { id: row.id, email: row.email, ldapUid: row.ldap_uid };
}

/**
 * Sync the LDAP-sourced profile attributes (display name, organisation) into
 * the user's public.user_profiles row. LDAP is the source of truth for these
 * fields — they are read-only in the app — so this runs on every login to keep
 * them current. The profile row is normally seeded by the handle_new_user()
 * trigger when auth.users is inserted; the on-conflict upsert covers the case
 * where it already exists (returning logins).
 */
export async function syncLdapProfile(
  userId: string,
  displayName: string | null,
  organisation: string | null,
): Promise<void> {
  await query(
    `insert into public.user_profiles (user_id, display_name, organisation, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id) do update set
       display_name = excluded.display_name,
       organisation = excluded.organisation,
       updated_at = now()`,
    [userId, displayName, organisation],
  );
}

/**
 * List all app users (id + email). Replaces the Supabase auth-admin listUsers()
 * call the collaborator-label lookups used. User counts are modest; callers page
 * in memory. Rows without an email are skipped (email is what callers key on).
 */
export async function listAuthUsers(): Promise<
  { id: string; email: string }[]
> {
  const res = await query(
    `select id, email from auth.users where email is not null`,
    [],
  );
  return (res.rows as { id: string; email: string | null }[])
    .filter((r): r is { id: string; email: string } => !!r.email)
    .map((r) => ({ id: r.id, email: r.email }));
}

/**
 * Permanently delete an app user. Cascades (on delete cascade) clear the user's
 * profile, TOTP factor, and other user-owned rows. Replaces the Supabase
 * auth-admin deleteUser() call.
 */
export async function deleteAuthUser(id: string): Promise<void> {
  await query(`delete from auth.users where id = $1`, [id]);
}

export async function getAuthUserById(id: string): Promise<AuthUser | null> {
  const res = await query(
    `select id, email, ldap_uid from auth.users where id = $1`,
    [id],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as { id: string; email: string | null; ldap_uid: string | null };
  return { id: row.id, email: row.email, ldapUid: row.ldap_uid };
}

/**
 * Look up an app user by email (case-insensitive). Returns null when no one has
 * logged into the app with that address yet — used to decide whether a project
 * invitee already has an account.
 */
export async function getAuthUserByEmail(
  email: string,
): Promise<AuthUser | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const res = await query(
    `select id, email, ldap_uid from auth.users where lower(email) = $1 limit 1`,
    [normalized],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as { id: string; email: string | null; ldap_uid: string | null };
  return { id: row.id, email: row.email, ldapUid: row.ldap_uid };
}
