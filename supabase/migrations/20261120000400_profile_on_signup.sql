-- TeachMate AI — 4/6 profile row on sign-up (trigger on auth.users)
-- Source: reviewed design TASK 003.1/003.2 (verified with PGlite). Do not edit after it is applied;
-- fix forward with a new migration.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    nullif(left(btrim(regexp_replace(
      coalesce(new.raw_user_meta_data ->> 'full_name', ''), '[[:cntrl:]]', '', 'g')), 120), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
