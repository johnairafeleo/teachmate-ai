-- TeachMate AI - 8: retryable document processing (attempt tokens + bounded memory-pressure releases)
-- Design: TASK 005.7.4, approved in TASK 005.7.6. Do not edit after it is applied; fix forward.
--
-- Every claim issues a fresh processing_attempt token. Save, fail and release of an ACTIVE attempt
-- require that token, so a stale request (an old app instance, a lost response, a killed function)
-- can never change a newer attempt. A worker terminated because of SHARED process memory pressure
-- releases the document back to `uploaded` (retryable), at most twice per document; the third
-- time it fails permanently with SERVER_CAPACITY.
--
-- Quotas: `uploaded` and `processing` are both counted as stored bytes and file_size is untouched,
-- so a release changes no quota; daily usage is only charged at registration.

do $$
begin
  if current_user <> 'postgres' then
    raise exception 'migrations must run as postgres (current_user = %)', current_user;
  end if;
end $$;

-- ---------- columns and invariants ----------
alter table public.source_documents
  add column processing_attempt uuid,
  add column memory_release_count smallint not null default 0;

alter table public.source_documents
  add constraint source_documents_memory_release_count_check
    check (memory_release_count between 0 and 2),
  add constraint source_documents_attempt_only_while_processing
    check (processing_attempt is null or processing_status = 'processing');

-- Any transition out of `processing` (ready, failed, uploaded, deleting; through new or legacy
-- functions) clears the token, so the invariant above always holds and a token is never reused.
create function public.clear_processing_attempt()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.processing_status <> 'processing' then
    new.processing_attempt := null;
  end if;
  return new;
end $$;
revoke all on function public.clear_processing_attempt() from public, anon, authenticated;

create trigger source_documents_clear_attempt before update on public.source_documents
  for each row execute function public.clear_processing_attempt();

-- ---------- legacy (unscoped) functions: same signatures, now unable to touch a token attempt ----------
-- Old app instances still call these during a rolling deployment; they keep working for their own
-- token-less attempts.

-- Save: only a token-less (legacy) attempt. A token attempt must use svc_save_document_extract_attempt.
create or replace function public.svc_save_document_extract(
  p_user_id uuid, p_document_id uuid, p_text text, p_page_count integer,
  p_is_truncated boolean, p_extractor_version text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.source_documents
   where id = p_document_id and user_id = p_user_id and processing_status = 'processing'
     and processing_attempt is null
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

-- Fail: pending_upload / uploaded as before; `processing` only for a token-less (legacy) attempt,
-- or for an ABANDONED token attempt (no change for 2 minutes by the database clock, longer than
-- the routes' 60 s maxDuration). Maintenance (15 min) and the service's stale recovery (120 s)
-- therefore still work, and can never fail a live worker's attempt.
create or replace function public.svc_fail_document(p_user_id uuid, p_document_id uuid, p_error text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.source_documents
     set processing_status = 'failed', processing_error = left(p_error, 500)
   where id = p_document_id and user_id = p_user_id
     and (processing_status in ('pending_upload', 'uploaded')
          or (processing_status = 'processing'
              and (processing_attempt is null or updated_at < now() - interval '2 minutes')));
end $$;

-- ---------- token-scoped functions ----------

-- Claim (uploaded -> processing) with a fresh token. Raises 55000 when not claimable.
create function public.svc_claim_document_processing(p_user_id uuid, p_document_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_attempt uuid := pg_catalog.gen_random_uuid();
begin
  if p_user_id is null or p_document_id is null then
    raise exception 'user and document are required' using errcode = '22023';
  end if;
  update public.source_documents
     set processing_status = 'processing', processing_error = null, processing_attempt = v_attempt
   where id = p_document_id and user_id = p_user_id and processing_status = 'uploaded';
  if not found then
    raise exception 'document is not ready for processing' using errcode = '55000';
  end if;
  return v_attempt;
end $$;

-- Release after shared memory pressure. Returns
--   'released'    processing -> uploaded, memory_release_count + 1 (at most 2 times);
--   'cap_reached' processing -> failed (SERVER_CAPACITY), count unchanged;
--   'not_current' nothing changed: other owner, other state, newer attempt, or already released.
-- The row lock serialises concurrent calls; READ COMMITTED re-checks the WHERE clause on the
-- updated row, so a second call with the same token sees `uploaded` and returns 'not_current'.
create function public.svc_release_document_processing(p_user_id uuid, p_document_id uuid, p_attempt uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_count smallint;
begin
  if p_user_id is null or p_document_id is null or p_attempt is null then
    raise exception 'user, document and attempt are required' using errcode = '22023';
  end if;
  select d.memory_release_count into v_count
    from public.source_documents d
   where d.id = p_document_id and d.user_id = p_user_id
     and d.processing_status = 'processing' and d.processing_attempt = p_attempt
     for update;
  if not found then
    return 'not_current';
  end if;
  if v_count >= 2 then
    update public.source_documents
       set processing_status = 'failed', processing_error = 'SERVER_CAPACITY'
     where id = p_document_id;
    return 'cap_reached';
  end if;
  update public.source_documents
     set processing_status = 'uploaded', processing_error = null, memory_release_count = v_count + 1
   where id = p_document_id;
  return 'released';
end $$;

-- Fail the caller's own attempt. Returns true when this call recorded the failure.
create function public.svc_fail_document_attempt(p_user_id uuid, p_document_id uuid, p_attempt uuid, p_error text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_user_id is null or p_document_id is null or p_attempt is null then
    raise exception 'user, document and attempt are required' using errcode = '22023';
  end if;
  update public.source_documents
     set processing_status = 'failed', processing_error = left(p_error, 500)
   where id = p_document_id and user_id = p_user_id
     and processing_status = 'processing' and processing_attempt = p_attempt;
  return found;
end $$;

-- Save the caller's own attempt (processing -> ready). Raises 55000 when the attempt is not current.
create function public.svc_save_document_extract_attempt(
  p_user_id uuid, p_document_id uuid, p_attempt uuid, p_text text, p_page_count integer,
  p_is_truncated boolean, p_extractor_version text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_user_id is null or p_document_id is null or p_attempt is null then
    raise exception 'user, document and attempt are required' using errcode = '22023';
  end if;
  perform 1 from public.source_documents
   where id = p_document_id and user_id = p_user_id
     and processing_status = 'processing' and processing_attempt = p_attempt
     for update;
  if not found then
    raise exception 'document attempt is not current' using errcode = '55000';
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

-- ---------- execute privileges: explicit for every function this file creates or replaces ----------
-- (create or replace keeps existing grants; they are restated so this file stands on its own.)
revoke all on function public.svc_save_document_extract(uuid, uuid, text, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.svc_fail_document(uuid, uuid, text)                                 from public, anon, authenticated;
revoke all on function public.svc_claim_document_processing(uuid, uuid)                           from public, anon, authenticated;
revoke all on function public.svc_release_document_processing(uuid, uuid, uuid)                   from public, anon, authenticated;
revoke all on function public.svc_fail_document_attempt(uuid, uuid, uuid, text)                   from public, anon, authenticated;
revoke all on function public.svc_save_document_extract_attempt(uuid, uuid, uuid, text, integer, boolean, text) from public, anon, authenticated;

grant execute on function public.svc_save_document_extract(uuid, uuid, text, integer, boolean, text) to service_role;
grant execute on function public.svc_fail_document(uuid, uuid, text)                                 to service_role;
grant execute on function public.svc_claim_document_processing(uuid, uuid)                           to service_role;
grant execute on function public.svc_release_document_processing(uuid, uuid, uuid)                   to service_role;
grant execute on function public.svc_fail_document_attempt(uuid, uuid, uuid, text)                   to service_role;
grant execute on function public.svc_save_document_extract_attempt(uuid, uuid, uuid, text, integer, boolean, text) to service_role;
