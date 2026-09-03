-- Migration: chat session persistence + "last used" timestamps
--
-- Two fixes bundled here because they touch the same tables:
--
-- 1. chat_messages.workflow — the chat routes insert a `workflow` field for
--    the user's turn, but the column was never part of the OSS schema. On
--    self-hosted Postgres the INSERT failed (unknown column) and, because the
--    error was unchecked, the user's message silently vanished — only the
--    assistant reply persisted. Adding the column restores parity so user
--    messages (and their workflow chips) survive a reload.
--
-- 2. chats.updated_at — the sidebar "sessions" list needs a "last used" time
--    in addition to created_at. A trigger keeps it in step with the newest
--    message, and get_chats_overview now returns it and orders by it.

-- 1. Persist the workflow chip on user messages ---------------------------
alter table public.chat_messages
  add column if not exists workflow jsonb;

-- 2. Track last-activity time on chats ------------------------------------
alter table public.chats
  add column if not exists updated_at timestamptz not null default now();

-- Backfill: point updated_at at the most recent message (falling back to
-- created_at for empty chats) so existing sessions sort sensibly right away.
update public.chats c
  set updated_at = coalesce(
    (
      select max(m.created_at)
      from public.chat_messages m
      where m.chat_id = c.id
    ),
    c.created_at
  );

create or replace function public.touch_chat_updated_at()
returns trigger
language plpgsql
as $$
begin
  update public.chats
    set updated_at = now()
    where id = new.chat_id;
  return new;
end;
$$;

drop trigger if exists on_chat_message_insert on public.chat_messages;
create trigger on_chat_message_insert
  after insert on public.chat_messages
  for each row execute procedure public.touch_chat_updated_at();

-- 3. Expose updated_at in the overview read model, ordered by last use ----
-- Adding a column to RETURNS TABLE changes the function's return type, which
-- CREATE OR REPLACE cannot do — drop the prior 5-column version first.
drop function if exists public.get_chats_overview(text, integer);
create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id,
    c.title,
    c.created_at,
    c.updated_at
  from public.chats c
  where c.user_id = p_user_id
     or exists (
      select 1
      from public.projects p
      where p.id = c.project_id
        and p.user_id = p_user_id
    )
  order by c.updated_at desc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end;
$$;
