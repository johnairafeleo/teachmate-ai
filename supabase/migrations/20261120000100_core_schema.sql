-- TeachMate AI — 1/6 core schema: default privileges, tables, indexes, updated_at triggers
-- Source: reviewed design TASK 003.1/003.2 (verified with PGlite). Do not edit after it is applied;
-- fix forward with a new migration.

-- Abort before creating anything unless this runs as postgres: the default-privilege
-- revokes below and the SECURITY DEFINER trigger functions (later files) assume that owner.
do $$
begin
  if current_user <> 'postgres' then
    raise exception 'migrations must run as postgres (current_user = %)', current_user;
  end if;
end $$;

-- Stop default grants for objects the migration role creates.
-- EXECUTE-to-PUBLIC on functions is a GLOBAL default, so it is revoked globally;
-- Supabase's anon/authenticated grants are schema-level defaults, revoked per schema.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.set_updated_at() from public, anon, authenticated;

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (full_name is null
                          or (char_length(full_name) between 1 and 120 and full_name !~ '[[:cntrl:]]')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.presentations (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title                text not null check (char_length(btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'),
  grade_level          smallint not null check (grade_level between 1 and 6),
  subject              text not null check (subject ~ '^[a-z0-9-]{1,40}$'),
  generation_mode      text not null check (generation_mode in ('topic', 'materials')),
  topic                text check (topic is null or char_length(btrim(topic)) between 3 and 150),
  learning_objectives  text check (learning_objectives is null or char_length(learning_objectives) <= 600),
  language             text not null check (language in ('english', 'filipino', 'taglish')),
  theme                text not null check (theme ~ '^[a-z0-9-]{1,40}$'),
  slide_count          smallint not null check (slide_count between 5 and 15),
  status               text not null default 'draft'
                         check (status in ('draft', 'generating', 'ready', 'failed')),
  status_message       text check (status_message is null or char_length(status_message) <= 500),
  deleting_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint presentations_topic_required check (generation_mode <> 'topic' or topic is not null),
  constraint presentations_id_user_key unique (id, user_id)
);
create index presentations_user_updated_idx on public.presentations (user_id, updated_at desc)
  where deleting_at is null;
create index presentations_deleting_idx on public.presentations (deleting_at)
  where deleting_at is not null;

create table public.slides (
  id               uuid primary key default gen_random_uuid(),
  presentation_id  uuid not null,
  user_id          uuid not null default auth.uid(),
  position         smallint not null check (position >= 0),
  title            text not null check (char_length(title) <= 200),
  content          jsonb not null default '{}'::jsonb
                     check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 32768),
  layout           text not null default 'title_and_bullets' check (layout ~ '^[a-z0-9_]{1,40}$'),
  speaker_notes    text check (speaker_notes is null or char_length(speaker_notes) <= 4000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint slides_presentation_owner_fk foreign key (presentation_id, user_id)
    references public.presentations (id, user_id) on delete cascade,
  constraint slides_position_key unique (presentation_id, position) deferrable initially deferred
);
create index slides_user_idx on public.slides (user_id);

create table public.source_documents (
  id                 uuid primary key default gen_random_uuid(),
  presentation_id    uuid not null,
  user_id            uuid not null default auth.uid(),
  original_filename  text not null check (char_length(original_filename) between 1 and 255),
  file_type          text not null check (file_type in ('pdf', 'docx')),
  file_size          bigint not null check (file_size between 1 and 10485760),
  storage_path       text generated always as (
                       user_id::text || '/' || presentation_id::text || '/' || id::text || '.' || file_type
                     ) stored,
  processing_status  text not null default 'pending_upload'
                       check (processing_status in
                         ('pending_upload', 'uploaded', 'processing', 'ready', 'failed', 'deleting')),
  processing_error   text check (processing_error is null or char_length(processing_error) <= 500),
  verified_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint source_documents_presentation_owner_fk foreign key (presentation_id, user_id)
    references public.presentations (id, user_id) on delete cascade,
  constraint source_documents_storage_path_key unique (storage_path),
  constraint source_documents_id_user_key unique (id, user_id)
);
create index source_documents_presentation_idx on public.source_documents (presentation_id);
create index source_documents_user_idx on public.source_documents (user_id);
create index source_documents_maintenance_idx on public.source_documents (processing_status, updated_at)
  where processing_status in ('pending_upload', 'uploaded', 'processing', 'failed', 'deleting');

create table public.document_extracts (
  source_document_id  uuid primary key,
  user_id             uuid not null,
  extracted_text      text not null check (char_length(extracted_text) <= 100000),
  char_count          integer generated always as (char_length(extracted_text)) stored,
  page_count          integer check (page_count is null or page_count between 0 and 50),
  is_truncated        boolean not null default false,
  extractor_version   text not null check (char_length(extractor_version) <= 40),
  created_at          timestamptz not null default now(),
  constraint document_extracts_owner_fk foreign key (source_document_id, user_id)
    references public.source_documents (id, user_id) on delete cascade
);

create table public.presentation_exports (
  id               uuid primary key,
  presentation_id  uuid not null,
  user_id          uuid not null,
  storage_path     text generated always as (
                     user_id::text || '/' || presentation_id::text || '/' || id::text || '.pptx'
                   ) stored,
  file_size        bigint not null check (file_size > 0),
  created_at       timestamptz not null default now(),
  constraint presentation_exports_owner_fk foreign key (presentation_id, user_id)
    references public.presentations (id, user_id) on delete cascade,
  constraint presentation_exports_storage_path_key unique (storage_path)
);
create index presentation_exports_presentation_idx
  on public.presentation_exports (presentation_id, created_at desc);

create trigger profiles_updated_at         before update on public.profiles         for each row execute function public.set_updated_at();
create trigger presentations_updated_at    before update on public.presentations    for each row execute function public.set_updated_at();
create trigger slides_updated_at           before update on public.slides           for each row execute function public.set_updated_at();
create trigger source_documents_updated_at before update on public.source_documents for each row execute function public.set_updated_at();
