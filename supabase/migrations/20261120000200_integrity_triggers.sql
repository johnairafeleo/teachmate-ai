-- TeachMate AI — 2/6 integrity triggers (document limits, slide bounds, slide_count guard)
-- Source: reviewed design TASK 003.1/003.2 (verified with PGlite). Do not edit after it is applied;
-- fix forward with a new migration.

create or replace function public.enforce_source_document_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_mode text; v_status text; v_deleting timestamptz; v_active integer; v_total integer;
begin
  select p.generation_mode, p.status, p.deleting_at
    into v_mode, v_status, v_deleting
    from public.presentations p
   where p.id = new.presentation_id and p.user_id = new.user_id
     for update;
  if not found then
    raise exception 'presentation not found' using errcode = '23503';
  end if;
  if v_deleting is not null then
    raise exception 'presentation is being deleted' using errcode = '55000';
  end if;
  if v_mode <> 'materials' then
    raise exception 'documents are only allowed for materials-based presentations' using errcode = '23514';
  end if;
  if v_status not in ('draft', 'failed') then
    raise exception 'documents can only be added before generation' using errcode = '55000';
  end if;

  select count(*) filter (where processing_status <> 'failed'), count(*)
    into v_active, v_total
    from public.source_documents
   where presentation_id = new.presentation_id;
  if v_active >= 3 then
    raise exception 'a presentation can have at most 3 source documents' using errcode = '23514';
  end if;
  if v_total >= 10 then
    raise exception 'too many upload attempts for this presentation' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger source_documents_rules before insert on public.source_documents
  for each row execute function public.enforce_source_document_rules();

create or replace function public.enforce_slide_bounds()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_slide_count smallint; v_deleting timestamptz;
begin
  select p.slide_count, p.deleting_at
    into v_slide_count, v_deleting
    from public.presentations p
   where p.id = new.presentation_id and p.user_id = new.user_id
     for share;
  if not found then
    raise exception 'presentation not found' using errcode = '23503';
  end if;
  if v_deleting is not null then
    raise exception 'presentation is being deleted' using errcode = '55000';
  end if;
  if new.position >= v_slide_count then
    raise exception 'slide position % exceeds slide_count %', new.position, v_slide_count
      using errcode = '23514';
  end if;
  return new;
end $$;
create trigger slides_bounds before insert or update of position, presentation_id, user_id on public.slides
  for each row execute function public.enforce_slide_bounds();

create or replace function public.guard_slide_count_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.slide_count < old.slide_count and exists (
       select 1 from public.slides s
        where s.presentation_id = new.id and s.position >= new.slide_count) then
    raise exception 'slide_count cannot be lower than existing slides' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger presentations_slide_count_guard before update of slide_count on public.presentations
  for each row execute function public.guard_slide_count_change();

revoke all on function public.enforce_source_document_rules() from public, anon, authenticated;
revoke all on function public.enforce_slide_bounds()          from public, anon, authenticated;
revoke all on function public.guard_slide_count_change()      from public, anon, authenticated;
