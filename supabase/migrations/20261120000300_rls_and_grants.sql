-- TeachMate AI — 3/6 RLS, table and column grants
-- Source: reviewed design TASK 003.1/003.2 (verified with PGlite). Do not edit after it is applied;
-- fix forward with a new migration.

alter table public.profiles             enable row level security;
alter table public.presentations        enable row level security;
alter table public.slides               enable row level security;
alter table public.source_documents     enable row level security;
alter table public.document_extracts    enable row level security;
alter table public.presentation_exports enable row level security;

-- Explicit, independent of which role's default privileges applied at creation time
revoke all on public.profiles, public.presentations, public.slides, public.source_documents,
              public.document_extracts, public.presentation_exports
  from public, anon, authenticated;
grant all on public.profiles, public.presentations, public.slides, public.source_documents,
             public.document_extracts, public.presentation_exports
  to service_role;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;

grant select on public.presentations to authenticated;
grant insert (title, grade_level, subject, generation_mode, topic, learning_objectives,
              language, theme, slide_count) on public.presentations to authenticated;
grant update (title, grade_level, subject, topic, learning_objectives, language, theme)
  on public.presentations to authenticated;

grant select on public.slides to authenticated;
grant update (position, title, content, layout, speaker_notes) on public.slides to authenticated;

grant select on public.source_documents to authenticated;
grant insert (presentation_id, original_filename, file_type, file_size)
  on public.source_documents to authenticated;

grant select on public.document_extracts    to authenticated;
grant select on public.presentation_exports to authenticated;

create policy "profiles: read own" on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "presentations: read own" on public.presentations for select to authenticated
  using (user_id = (select auth.uid()) and deleting_at is null);
create policy "presentations: insert own" on public.presentations for insert to authenticated
  with check (user_id = (select auth.uid()) and deleting_at is null);
create policy "presentations: update own" on public.presentations for update to authenticated
  using (user_id = (select auth.uid()) and deleting_at is null)
  with check (user_id = (select auth.uid()) and deleting_at is null);

create policy "slides: read own" on public.slides for select to authenticated
  using (user_id = (select auth.uid()));
create policy "slides: update own" on public.slides for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "source_documents: read own" on public.source_documents for select to authenticated
  using (user_id = (select auth.uid()));
create policy "source_documents: register own" on public.source_documents for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "document_extracts: read own" on public.document_extracts for select to authenticated
  using (user_id = (select auth.uid()));
create policy "presentation_exports: read own" on public.presentation_exports for select to authenticated
  using (user_id = (select auth.uid()));
