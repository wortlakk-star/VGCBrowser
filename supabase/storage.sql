-- ── VGC Browser — Cloud profile DATA storage ────────────────────────────────
-- Run this ONCE in the Supabase SQL Editor (after schema.sql).
-- Creates a PRIVATE bucket `profiles` that holds each profile's browser session
-- zip at  {uid}/{profileId}.zip , with row-level security so each user can only
-- read/write objects inside their own {uid}/ folder.

-- 1) Private bucket. Keep this in sync with MAX_CLOUD_OBJECT_BYTES in cloud-data.ts.
insert into storage.buckets (id, name, public, file_size_limit)
values ('profiles', 'profiles', false, 67108864)
on conflict (id) do update set public = false, file_size_limit = 67108864;

-- 2) Permit only the exact object names produced by the app. Checking only the first
-- folder would let compromised clients fill arbitrary nested paths in the bucket.
create or replace function public.is_owned_profile_object(_name text, _owner uuid)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select _owner is not null and _name ~ (
    '^' || _owner::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' ||
    '\.(zip|cookies\.json|passwords\.json|cookiesdb\.json)$'
  );
$$;

revoke all on function public.is_owned_profile_object(text, uuid) from public, anon, authenticated;
grant execute on function public.is_owned_profile_object(text, uuid) to authenticated;

drop policy if exists "vgc_profiles_select" on storage.objects;
create policy "vgc_profiles_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'profiles' and public.is_owned_profile_object(name, auth.uid()));

drop policy if exists "vgc_profiles_insert" on storage.objects;
create policy "vgc_profiles_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'profiles' and public.is_owned_profile_object(name, auth.uid()));

drop policy if exists "vgc_profiles_update" on storage.objects;
create policy "vgc_profiles_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'profiles' and public.is_owned_profile_object(name, auth.uid()))
  with check (bucket_id = 'profiles' and public.is_owned_profile_object(name, auth.uid()));

drop policy if exists "vgc_profiles_delete" on storage.objects;
create policy "vgc_profiles_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profiles' and public.is_owned_profile_object(name, auth.uid()));
