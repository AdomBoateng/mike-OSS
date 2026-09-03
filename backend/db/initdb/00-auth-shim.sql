-- Supabase-compatibility shim for self-hosted vanilla Postgres.
--
-- The application schema (backend/schema.sql) was written for Supabase, whose
-- managed `auth` schema provides an `auth.users` table. This recreates a
-- minimal `auth.users` so schema.sql loads UNMODIFIED: its foreign keys
-- (references auth.users(id)) and the on_auth_user_created trigger resolve.
--
-- Runs before 01-schema.sql (alphabetical order in docker-entrypoint-initdb.d),
-- and only on first init of an empty data volume.
--
-- During the LDAP migration the backend owns identity: it upserts a row here
-- (reusing the user's existing UUID) on first successful LDAP bind, which fires
-- handle_new_user() to seed public.user_profiles — exactly as Supabase did on
-- signup. See docs/self-hosting-roadmap.md (Phase 3).

create extension if not exists "pgcrypto";

-- Supabase's built-in roles. schema.sql ends with `revoke ... from anon,
-- authenticated` (hardening against direct browser DB access, which does not
-- apply here — the backend is the sole DB client). Create them as inert
-- NOLOGIN roles so those revokes succeed and schema.sql loads unmodified.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  -- Directory identifier for LDAP-authenticated users. Stable per user, so the
  -- app UUID (id) can be reused across logins and, later, mapped to an existing
  -- Supabase UUID during data migration.
  ldap_uid text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
