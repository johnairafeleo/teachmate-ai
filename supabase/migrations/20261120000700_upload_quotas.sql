-- TeachMate AI — 7 upload quotas + atomic materials drafts
-- Source: reviewed design TASK 005.1/005.2. Do not edit after it is applied;
-- fix forward with a new migration.
--
-- Quota model (per user):
--   * Daily limits are RATE limits: every registered upload attempt consumes one attempt and its
--     bytes for the current UTC day, at registration (declared size) and again when verification
--     finds a larger actual size (the difference). Failures and deletions never refund them, so
--     upload/delete loops cannot reset the limit.
--   * The stored limit is a LIVE total, derived on demand from source_documents rows that still
--     occupy (or are about to occupy) Storage: pending_upload (reservation), uploaded, processing,
--     ready. A document that becomes failed or deleting, or is deleted, stops counting. Nothing is
--     ever "released" by a counter, so retries and cleanup cannot double-release.
--   * Every quota decision for a user runs under one per-user transaction advisory lock, so
--     concurrent registrations and verifications are serialized and cannot overshoot.

-- Abort before creating anything unless this runs as postgres (owner of the SECURITY DEFINER
-- functions below).
do $$
begin
  if current_user <> 'postgres' then
    raise exception 'migrations must run as postgres (current_user = %)', current_user;
  end if;
end $$;

-- ---------- limits (single SQL source; mirrored in the app for UI copy only) ----------
create or replace function public.upload_quota_limits()
returns table (max_daily_attempts integer, max_daily_bytes bigint, max_stored_bytes bigint)
language sql immutable parallel safe set search_path = '' as $$
  select 20, 209715200::bigint, 157286400::bigint   -- 20 attempts, 200 MiB/day, 150 MiB stored
$$;
revoke all on function public.upload_quota_limits() from public, anon;
grant execute on function public.upload_quota_limits() to authenticated, service_role;

-- ---------- daily usage ledger (aggregated: at most one row per user per UTC day) ----------
create table public.upload_quota_usage (
  user_id     uuid not null references auth.users (id) on delete cascade,
  usage_date  date not null,
  attempts    integer not null default 0 check (attempts >= 0),
  bytes       bigint  not null default 0 check (bytes >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, usage_date)
);
create index upload_quota_usage_date_idx on public.upload_quota_usage (usage_date);

alter table public.upload_quota_usage enable row level security;
revoke all on public.upload_quota_usage from public, anon, authenticated;
-- Explicit: Supabase's default privileges do not give service_role full access to new tables.
grant all on public.upload_quota_usage to service_role;
-- Teachers may read (never write) their own usage, e.g. to show "12 of 20 uploads today".
grant select on public.upload_quota_usage to authenticated;
create policy "upload_quota_usage: read own" on public.upload_quota_usage for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------- shared checks ----------
-- Quota checks read fresh committed data after taking the per-user lock, which only holds
-- under READ COMMITTED (each statement takes a new snapshot). Refuse snapshot isolation levels.
create or replace function public.assert_quota_isolation()
returns void language plpgsql stable set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'upload quota checks require READ COMMITTED isolation' using errcode = '25000';
  end if;
end $$;
revoke all on function public.assert_quota_isolation() from public, anon, authenticated;

-- ---------- enforcement on registration (insert) ----------
create or replace function public.enforce_upload_quota()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_today    date := (now() at time zone 'utc')::date;
  v_uid      uuid := (select auth.uid());
  v_limits   record;
  v_attempts integer;
  v_bytes    bigint;
  v_stored   bigint;
begin
  -- Never spend another user's quota (RLS would reject the row anyway; fail before locking).
  if v_uid is not null and new.user_id is distinct from v_uid then
    raise exception 'cannot register documents for another user' using errcode = '42501';
  end if;
  perform public.assert_quota_isolation();
  select * into v_limits from public.upload_quota_limits();

  -- Serialize all quota decisions for this user, including the first upload of a day.
  perform pg_advisory_xact_lock(hashtext('teachmate.upload_quota'), hashtext(new.user_id::text));

  -- Retention: keep only the last 7 UTC days for this user (bounded table growth).
  delete from public.upload_quota_usage u
   where u.user_id = new.user_id and u.usage_date < v_today - 7;

  select u.attempts, u.bytes into v_attempts, v_bytes
    from public.upload_quota_usage u
   where u.user_id = new.user_id and u.usage_date = v_today;
  v_attempts := coalesce(v_attempts, 0);
  v_bytes    := coalesce(v_bytes, 0);

  if v_attempts + 1 > v_limits.max_daily_attempts then
    raise exception 'daily upload limit reached' using errcode = 'TQ001';
  end if;
  if v_bytes + new.file_size > v_limits.max_daily_bytes then
    raise exception 'daily upload size limit reached' using errcode = 'TQ002';
  end if;

  select coalesce(sum(d.file_size), 0) into v_stored
    from public.source_documents d
   where d.user_id = new.user_id
     and d.processing_status in ('pending_upload', 'uploaded', 'processing', 'ready');
  if v_stored + new.file_size > v_limits.max_stored_bytes then
    raise exception 'storage limit reached' using errcode = 'TQ003';
  end if;

  insert into public.upload_quota_usage as u (user_id, usage_date, attempts, bytes)
  values (new.user_id, v_today, 1, new.file_size)
  on conflict (user_id, usage_date) do update
    set attempts = u.attempts + 1, bytes = u.bytes + excluded.bytes, updated_at = now();
  return new;
end $$;
revoke all on function public.enforce_upload_quota() from public, anon, authenticated;

-- Named so it fires after source_documents_rules (triggers fire in name order): presentation
-- rules reject first, then quota is charged. All of it rolls back together on any error.
create trigger source_documents_rules_quota before insert on public.source_documents
  for each row execute function public.enforce_upload_quota();

-- ---------- enforcement when verification records a larger actual size ----------
create or replace function public.enforce_upload_quota_on_resize()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_today   date := (now() at time zone 'utc')::date;
  v_limits  record;
  v_delta   bigint := new.file_size - old.file_size;
  v_bytes   bigint;
  v_stored  bigint;
begin
  -- Shrinking never refunds daily bytes; the stored total follows the row automatically.
  if v_delta <= 0 then
    return new;
  end if;
  perform public.assert_quota_isolation();
  select * into v_limits from public.upload_quota_limits();
  perform pg_advisory_xact_lock(hashtext('teachmate.upload_quota'), hashtext(new.user_id::text));

  select u.bytes into v_bytes
    from public.upload_quota_usage u
   where u.user_id = new.user_id and u.usage_date = v_today;
  if coalesce(v_bytes, 0) + v_delta > v_limits.max_daily_bytes then
    raise exception 'daily upload size limit reached' using errcode = 'TQ002';
  end if;

  if new.processing_status in ('pending_upload', 'uploaded', 'processing', 'ready') then
    select coalesce(sum(d.file_size), 0) into v_stored
      from public.source_documents d
     where d.user_id = new.user_id and d.id <> new.id
       and d.processing_status in ('pending_upload', 'uploaded', 'processing', 'ready');
    if v_stored + new.file_size > v_limits.max_stored_bytes then
      raise exception 'storage limit reached' using errcode = 'TQ003';
    end if;
  end if;

  insert into public.upload_quota_usage as u (user_id, usage_date, attempts, bytes)
  values (new.user_id, v_today, 0, v_delta)
  on conflict (user_id, usage_date) do update
    set bytes = u.bytes + excluded.bytes, updated_at = now();
  return new;
end $$;
revoke all on function public.enforce_upload_quota_on_resize() from public, anon, authenticated;

create trigger source_documents_quota_resize before update of file_size on public.source_documents
  for each row execute function public.enforce_upload_quota_on_resize();

-- ---------- atomic materials draft: presentation + up to 3 pending documents ----------
-- SECURITY INVOKER: runs as the calling teacher, so RLS, column grants and every trigger
-- (presentation rules, per-presentation limits, quotas) apply. One call = one transaction.
create or replace function public.create_materials_draft(
  p_title text, p_grade_level smallint, p_subject text, p_language text, p_theme text,
  p_slide_count smallint, p_files jsonb)
returns table (out_document_id uuid, out_storage_path text, out_original_filename text,
               out_file_type text, out_file_size bigint)
language plpgsql security invoker set search_path = '' as $$
declare
  v_title        text := btrim(coalesce(p_title, ''));
  v_presentation uuid;
  v_file         jsonb;
  v_name         text;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Materials presentations have no topic, so the title is the teacher's only label: required.
  if char_length(v_title) = 0 then
    raise exception 'title is required' using errcode = '22023';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) not between 1 and 3 then
    raise exception 'between 1 and 3 files are required' using errcode = '22023';
  end if;

  insert into public.presentations
    (title, grade_level, subject, generation_mode, language, theme, slide_count)
  values (v_title, p_grade_level, p_subject, 'materials', p_language, p_theme, p_slide_count)
  returning id into v_presentation;

  for v_file in select f.value from jsonb_array_elements(p_files) as f(value) loop
    if jsonb_typeof(v_file) <> 'object'
       or jsonb_typeof(v_file -> 'name') is distinct from 'string'
       or jsonb_typeof(v_file -> 'type') is distinct from 'string'
       or jsonb_typeof(v_file -> 'size') is distinct from 'number'
       or (v_file ->> 'size') !~ '^[0-9]{1,9}$' then
      raise exception 'invalid file entry' using errcode = '22023';
    end if;
    v_name := v_file ->> 'name';
    if v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid file name' using errcode = '22023';
    end if;

    insert into public.source_documents (presentation_id, original_filename, file_type, file_size)
    values (v_presentation, v_name, v_file ->> 'type', (v_file ->> 'size')::bigint)
    returning id, storage_path, original_filename, file_type, file_size
      into out_document_id, out_storage_path, out_original_filename, out_file_type, out_file_size;
    return next;
  end loop;
end $$;
-- Explicit revokes: callers are signed-in teachers only (service_role has no auth.uid()).
revoke all on function public.create_materials_draft(text, smallint, text, text, text, smallint, jsonb)
  from public, anon, service_role;
grant execute on function public.create_materials_draft(text, smallint, text, text, text, smallint, jsonb)
  to authenticated;

-- ---------- the caller's own quota (for UI) ----------
create or replace function public.my_upload_quota()
returns table (attempts_today integer, bytes_today bigint, stored_bytes bigint,
               max_daily_attempts integer, max_daily_bytes bigint, max_stored_bytes bigint,
               resets_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  with today as (select (now() at time zone 'utc')::date as d)
  select
    coalesce((select u.attempts from public.upload_quota_usage u, today
               where u.user_id = (select auth.uid()) and u.usage_date = today.d), 0),
    coalesce((select u.bytes from public.upload_quota_usage u, today
               where u.user_id = (select auth.uid()) and u.usage_date = today.d), 0)::bigint,
    coalesce((select sum(s.file_size) from public.source_documents s
               where s.user_id = (select auth.uid())
                 and s.processing_status in ('pending_upload', 'uploaded', 'processing', 'ready')), 0)::bigint,
    l.max_daily_attempts, l.max_daily_bytes, l.max_stored_bytes,
    ((select d from today) + 1)::timestamp at time zone 'utc'
  from public.upload_quota_limits() l;
$$;
revoke all on function public.my_upload_quota() from public, anon, service_role;
grant execute on function public.my_upload_quota() to authenticated;

-- ---------- global retention (maintenance cron) ----------
create or replace function public.svc_prune_upload_quota_usage(p_keep_days integer default 7)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.upload_quota_usage
   where usage_date < (now() at time zone 'utc')::date - greatest(coalesce(p_keep_days, 7), 1);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function public.svc_prune_upload_quota_usage(integer) from public, anon, authenticated;
grant execute on function public.svc_prune_upload_quota_usage(integer) to service_role;
