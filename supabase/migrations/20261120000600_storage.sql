-- TeachMate AI — 6/6 private Storage buckets and storage.objects policies
-- Source: reviewed design TASK 003.1/003.2 (verified with PGlite). Do not edit after it is applied;
-- fix forward with a new migration.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('source-materials', 'source-materials', false, 10485760,
     array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('presentation-exports', 'presentation-exports', false, 52428800,
     array['application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "source-materials: owner reads" on storage.objects for select to authenticated
  using (bucket_id = 'source-materials'
         and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "source-materials: upload to a registered pending path" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'source-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
        from public.source_documents d
        join public.presentations p on p.id = d.presentation_id
       where d.storage_path = objects.name
         and d.user_id = (select auth.uid())
         and d.processing_status = 'pending_upload'
         and p.deleting_at is null
    )
  );

create policy "presentation-exports: owner reads" on storage.objects for select to authenticated
  using (bucket_id = 'presentation-exports'
         and (storage.foldername(name))[1] = (select auth.uid())::text);
