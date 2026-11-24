-- TeachMate AI — 5/6 reorder_slides (user) and svc_* server functions (service_role only)
-- Source: reviewed design TASK 003.1/003.2 (verified with PGlite). Do not edit after it is applied;
-- fix forward with a new migration.

-- ---------- user-callable (RLS applies) ----------
create or replace function public.reorder_slides(p_presentation_id uuid, p_slide_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
declare v_existing integer;
begin
  if p_presentation_id is null or p_slide_ids is null then
    raise exception 'presentation id and slide ids are required' using errcode = '22023';
  end if;
  select count(*) into v_existing from public.slides where presentation_id = p_presentation_id;
  if v_existing = 0
     or cardinality(p_slide_ids) <> v_existing
     or (select count(distinct x) from unnest(p_slide_ids) as x) <> v_existing
     or (select count(*) from public.slides
          where presentation_id = p_presentation_id and id = any (p_slide_ids)) <> v_existing then
    raise exception 'slide list must be an exact permutation of this presentation''s slides'
      using errcode = '22023';
  end if;
  update public.slides s
     set position = (t.ord - 1)::smallint
    from unnest(p_slide_ids) with ordinality as t(slide_id, ord)
   where s.id = t.slide_id and s.presentation_id = p_presentation_id;
end $$;
revoke all on function public.reorder_slides(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_slides(uuid, uuid[]) to authenticated;

-- ---------- helpers ----------
create or replace function public.svc_objects_remaining(p_user_id uuid, p_presentation_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from storage.objects o
     where o.bucket_id in ('source-materials', 'presentation-exports')
       and starts_with(o.name, p_user_id::text || '/' || p_presentation_id::text || '/')
  );
$$;

-- ---------- presentation deletion ----------
create or replace function public.svc_begin_presentation_deletion(p_user_id uuid, p_presentation_id uuid)
returns table (out_bucket text, out_path text)
language plpgsql security invoker set search_path = '' as $$
begin
  update public.presentations
     set deleting_at = coalesce(deleting_at, now())
   where id = p_presentation_id and user_id = p_user_id;
  if not found then
    raise exception 'presentation not found' using errcode = 'P0002';
  end if;
  return query
    select 'source-materials'::text, d.storage_path from public.source_documents d
     where d.presentation_id = p_presentation_id and d.user_id = p_user_id
    union all
    select 'presentation-exports'::text, e.storage_path from public.presentation_exports e
     where e.presentation_id = p_presentation_id and e.user_id = p_user_id;
end $$;

create or replace function public.svc_finish_presentation_deletion(p_user_id uuid, p_presentation_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if public.svc_objects_remaining(p_user_id, p_presentation_id) then
    raise exception 'storage objects remain for this presentation' using errcode = '55000';
  end if;
  delete from public.presentations
   where id = p_presentation_id and user_id = p_user_id and deleting_at is not null;
  return found;
end $$;

-- ---------- document lifecycle ----------
create or replace function public.svc_begin_document_deletion(p_user_id uuid, p_document_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_path text; v_doc_status text; v_pres_status text; v_deleting timestamptz;
begin
  select d.storage_path, d.processing_status, p.status, p.deleting_at
    into v_path, v_doc_status, v_pres_status, v_deleting
    from public.source_documents d
    join public.presentations p on p.id = d.presentation_id
   where d.id = p_document_id and d.user_id = p_user_id
     for update of d, p;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if v_pres_status not in ('draft', 'failed') and v_deleting is null
     and v_doc_status not in ('pending_upload', 'failed', 'deleting') then
    raise exception 'document is locked by generation' using errcode = '55000';
  end if;
  update public.source_documents set processing_status = 'deleting' where id = p_document_id;
  return v_path;
end $$;

create or replace function public.svc_finish_document_deletion(p_user_id uuid, p_document_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.source_documents d
   where d.id = p_document_id and d.user_id = p_user_id and d.processing_status = 'deleting'
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'source-materials' and o.name = d.storage_path);
  return found;
end $$;

create or replace function public.svc_mark_document_verified(p_user_id uuid, p_document_id uuid)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_path text; v_size bigint;
begin
  select d.storage_path into v_path
    from public.source_documents d
    join public.presentations p on p.id = d.presentation_id
   where d.id = p_document_id and d.user_id = p_user_id
     and d.processing_status = 'pending_upload' and p.deleting_at is null
     for update of d;
  if not found then
    raise exception 'document is not awaiting verification' using errcode = 'P0002';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o
   where o.bucket_id = 'source-materials' and o.name = v_path;
  if v_size is null or v_size not between 1 and 10485760 then
    raise exception 'uploaded object missing or out of range' using errcode = '22023';
  end if;
  update public.source_documents
     set processing_status = 'uploaded', file_size = v_size, verified_at = now()
   where id = p_document_id;
  return v_size;
end $$;

create or replace function public.svc_start_document_processing(p_user_id uuid, p_document_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.source_documents set processing_status = 'processing', processing_error = null
   where id = p_document_id and user_id = p_user_id and processing_status = 'uploaded';
  if not found then
    raise exception 'document is not ready for processing' using errcode = '55000';
  end if;
end $$;

create or replace function public.svc_fail_document(p_user_id uuid, p_document_id uuid, p_error text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.source_documents
     set processing_status = 'failed', processing_error = left(p_error, 500)
   where id = p_document_id and user_id = p_user_id
     and processing_status in ('pending_upload', 'uploaded', 'processing');
end $$;

create or replace function public.svc_save_document_extract(
  p_user_id uuid, p_document_id uuid, p_text text, p_page_count integer,
  p_is_truncated boolean, p_extractor_version text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.source_documents
   where id = p_document_id and user_id = p_user_id and processing_status = 'processing'
     for update;
  if not found then
    raise exception 'document is not processing' using errcode = '55000';
  end if;
  insert into public.document_extracts
    (source_document_id, user_id, extracted_text, page_count, is_truncated, extractor_version)
  values (p_document_id, p_user_id, p_text, p_page_count, p_is_truncated, p_extractor_version)
  on conflict (source_document_id) do update
    set extracted_text = excluded.extracted_text, page_count = excluded.page_count,
        is_truncated = excluded.is_truncated, extractor_version = excluded.extractor_version,
        created_at = now();
  update public.source_documents set processing_status = 'ready' where id = p_document_id;
end $$;

-- ---------- generation ----------
create or replace function public.svc_begin_generation(p_user_id uuid, p_presentation_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_mode text; v_status text;
begin
  select generation_mode, status into v_mode, v_status
    from public.presentations
   where id = p_presentation_id and user_id = p_user_id and deleting_at is null
     for update;
  if not found then
    raise exception 'presentation not found' using errcode = 'P0002';
  end if;
  if v_status not in ('draft', 'failed', 'ready') then
    raise exception 'generation already in progress' using errcode = '55000';
  end if;
  if v_mode = 'materials' and (
       not exists (select 1 from public.source_documents
                    where presentation_id = p_presentation_id and processing_status = 'ready')
       or exists (select 1 from public.source_documents
                   where presentation_id = p_presentation_id
                     and processing_status in ('pending_upload', 'uploaded', 'processing', 'deleting'))) then
    raise exception 'source documents are not ready' using errcode = '55000';
  end if;
  update public.presentations set status = 'generating', status_message = null
   where id = p_presentation_id;
end $$;

create or replace function public.svc_fail_generation(p_user_id uuid, p_presentation_id uuid, p_message text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.presentations set status = 'failed', status_message = left(p_message, 500)
   where id = p_presentation_id and user_id = p_user_id and status = 'generating';
end $$;

create or replace function public.svc_replace_generated_slides(
  p_user_id uuid, p_presentation_id uuid, p_slides jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_status text; v_count smallint; v_len integer;
begin
  select status, slide_count into v_status, v_count
    from public.presentations
   where id = p_presentation_id and user_id = p_user_id and deleting_at is null
     for update;
  if not found then
    raise exception 'presentation not found' using errcode = 'P0002';
  end if;
  if v_status <> 'generating' then
    raise exception 'presentation is not generating' using errcode = '55000';
  end if;
  -- SQL OR has no guaranteed short-circuit, so test the type before calling jsonb_array_length
  v_len := case when jsonb_typeof(p_slides) = 'array' then jsonb_array_length(p_slides) end;
  if v_len is null or v_len not between 1 and v_count then
    raise exception 'slides must be an array of 1..% items', v_count using errcode = '22023';
  end if;
  delete from public.slides where presentation_id = p_presentation_id;
  insert into public.slides (presentation_id, user_id, position, title, content, layout, speaker_notes)
  select p_presentation_id, p_user_id, (t.ord - 1)::smallint,
         t.slide ->> 'title', t.slide -> 'content',
         coalesce(t.slide ->> 'layout', 'title_and_bullets'), t.slide ->> 'speaker_notes'
    from jsonb_array_elements(p_slides) with ordinality as t(slide, ord);
  update public.presentations set status = 'ready', status_message = null
   where id = p_presentation_id;
end $$;

-- ---------- exports ----------
create or replace function public.svc_record_export(p_user_id uuid, p_presentation_id uuid, p_export_id uuid)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_size bigint;
begin
  perform 1 from public.presentations
   where id = p_presentation_id and user_id = p_user_id
     and deleting_at is null and status = 'ready'
     for share;
  if not found then
    raise exception 'presentation not exportable' using errcode = '55000';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o
   where o.bucket_id = 'presentation-exports'
     and o.name = p_user_id::text || '/' || p_presentation_id::text || '/' || p_export_id::text || '.pptx';
  if v_size is null then
    raise exception 'export object missing' using errcode = 'P0002';
  end if;
  insert into public.presentation_exports (id, presentation_id, user_id, file_size)
  values (p_export_id, p_presentation_id, p_user_id, v_size);
  return v_size;
end $$;

create or replace function public.svc_delete_export_record(p_user_id uuid, p_export_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.presentation_exports e
   where e.id = p_export_id and e.user_id = p_user_id
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'presentation-exports' and o.name = e.storage_path);
  return found;
end $$;

-- ---------- maintenance (cron only) ----------
create or replace function public.svc_maintenance_candidates(p_limit integer default 200)
returns table (kind text, owner_id uuid, target_id uuid)
language sql stable security invoker set search_path = '' as $$
  (select 'presentation_deleting'::text, p.user_id, p.id from public.presentations p
    where p.deleting_at < now() - interval '15 minutes' limit p_limit)
  union all
  (select 'generation_stuck'::text, p.user_id, p.id from public.presentations p
    where p.status = 'generating' and p.deleting_at is null
      and p.updated_at < now() - interval '15 minutes' limit p_limit)
  union all
  (select 'document_stuck'::text, d.user_id, d.id from public.source_documents d
    where d.processing_status in ('uploaded', 'processing')
      and d.updated_at < now() - interval '15 minutes' limit p_limit)
  union all
  (select 'document_cleanup'::text, d.user_id, d.id from public.source_documents d
    where (d.processing_status = 'deleting'       and d.updated_at < now() - interval '15 minutes')
       or (d.processing_status = 'pending_upload' and d.created_at < now() - interval '24 hours')
       or (d.processing_status = 'failed'         and d.updated_at < now() - interval '7 days')
    limit p_limit)
  union all
  (select 'export_superseded'::text, x.user_id, x.id from (
      select e.user_id, e.id,
             row_number() over (partition by e.presentation_id order by e.created_at desc) as rn
        from public.presentation_exports e) x
    where x.rn > 3 limit p_limit);
$$;

create or replace function public.svc_find_orphan_objects(
  p_older_than interval default '1 hour', p_limit integer default 500)
returns table (out_bucket text, out_path text)
language sql stable security invoker set search_path = '' as $$
  select o.bucket_id, o.name
    from storage.objects o
   where o.created_at < now() - p_older_than
     and ((o.bucket_id = 'source-materials'
           and not exists (select 1 from public.source_documents d where d.storage_path = o.name))
       or (o.bucket_id = 'presentation-exports'
           and not exists (select 1 from public.presentation_exports e where e.storage_path = o.name)))
   limit p_limit;
$$;

-- Lock down every svc_* function: service_role only
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'svc\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
