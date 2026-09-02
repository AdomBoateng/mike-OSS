-- Migration date: 2026-09-02

-- Documents overview read model, for the global documents panel.
--
-- Returns every document the user can reach — their own, plus those in
-- projects shared with them — with the project name and the provenance the
-- panel filters on, in one call. The query-builder shim in lib/db has no
-- support for joins or embedded selects, so an overview like this is an RPC
-- rather than a series of round trips; the same reason get_projects_overview
-- and get_chats_overview exist.
--
-- Provenance comes from document_versions.source:
--   'upload' / 'user_upload'  the user put the file there
--   'generated'               the assistant created the document
--   'assistant_edit'          the assistant produced a new version
--   'user_accept' / 'user_reject'  the user resolved tracked changes
--
-- `origin` is taken from the EARLIEST surviving version (who first put this
-- document here) and `assistant_edited` from the existence of any
-- 'assistant_edit' version (whether the assistant has since touched it). They
-- are deliberately separate: a document the user uploaded and the assistant
-- then edited is both, and the panel needs to say so.

create or replace function public.get_documents_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  project_id uuid,
  project_name text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  size_bytes integer,
  page_count integer,
  version_count integer,
  latest_version_number integer,
  origin text,
  assistant_edited boolean
)
language sql
stable
as $$
  with visible_projects as (
    select p.id, p.name
    from public.projects p
    where p.user_id = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  ),
  visible_documents as (
    select d.*
    from public.documents d
    where d.user_id = p_user_id
       or d.project_id in (select vp.id from visible_projects vp)
  ),
  live_versions as (
    select v.*
    from public.document_versions v
    where v.deleted_at is null
      and v.document_id in (select vd.id from visible_documents vd)
  ),
  -- The version the panel describes: the one the document points at, else the
  -- most recent surviving one. Ordering falls back to created_at because
  -- version_number is nullable on older rows.
  active_version as (
    select distinct on (lv.document_id)
      lv.document_id, lv.filename, lv.file_type, lv.size_bytes, lv.page_count
    from live_versions lv
    join visible_documents vd on vd.id = lv.document_id
    order by
      lv.document_id,
      (vd.current_version_id is not distinct from lv.id) desc,
      lv.version_number desc nulls last,
      lv.created_at desc
  ),
  first_version as (
    select distinct on (lv.document_id) lv.document_id, lv.source
    from live_versions lv
    order by lv.document_id, lv.version_number asc nulls first, lv.created_at asc
  ),
  version_stats as (
    select
      lv.document_id,
      count(*)::integer as version_count,
      max(lv.version_number)::integer as latest_version_number,
      bool_or(lv.source = 'assistant_edit') as assistant_edited
    from live_versions lv
    group by lv.document_id
  )
  select
    vd.id,
    vd.project_id,
    vp.name as project_name,
    vd.status,
    vd.created_at,
    vd.updated_at,
    av.filename,
    av.file_type,
    av.size_bytes,
    av.page_count,
    coalesce(vs.version_count, 0) as version_count,
    vs.latest_version_number,
    case
      when fv.source = 'generated' then 'assistant'
      else 'upload'
    end as origin,
    coalesce(vs.assistant_edited, false) as assistant_edited
  from visible_documents vd
  left join visible_projects vp on vp.id = vd.project_id
  left join active_version av on av.document_id = vd.id
  left join first_version fv on fv.document_id = vd.id
  left join version_stats vs on vs.document_id = vd.id
  order by vd.updated_at desc, vd.created_at desc;
$$;
