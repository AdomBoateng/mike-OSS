-- Migration: TOTP multi-factor authentication factors.
--
-- Rebuilds MFA on self-hosted Postgres after the Supabase-auth migration (MFA
-- previously rode on Supabase's managed factor store). One factor per user; the
-- TOTP secret is stored encrypted (AES-256-GCM, see backend/src/lib/secretCrypto.ts).
-- `verified` flips true once the user confirms a code during enrollment.

create table if not exists public.user_totp_factors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_secret text not null,
  iv text not null,
  auth_tag text not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

alter table public.user_totp_factors enable row level security;

revoke all on public.user_totp_factors from anon, authenticated;
