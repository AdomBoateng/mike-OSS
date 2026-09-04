-- Server-side session registry for immediate logout/revocation across every
-- backend replica. JWTs carry only the random session id; no token is stored.

create table if not exists public.user_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists idx_user_sessions_active
  on public.user_sessions(user_id, expires_at)
  where revoked_at is null;

alter table public.user_sessions enable row level security;
revoke all on public.user_sessions from anon, authenticated;
