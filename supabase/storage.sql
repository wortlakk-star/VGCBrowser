-- ── VGC Browser — Cloud profile DATA storage ────────────────────────────────
-- Run this ONCE in the Supabase SQL Editor (after schema.sql).
-- Creates a PRIVATE bucket `profiles` that holds each profile's browser session
-- zip at  {uid}/{profileId}.zip , with row-level security so each user can only
-- read/write objects inside their own {uid}/ folder.

-- 1) Private bucket (50MB/object is plenty once caches are excluded).
insert into storage.buckets (id, name, public, file_size_limit)
values ('profiles', 'profiles', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- 2) RLS policies on storage.objects, scoped to the bucket + the user's folder.
--    storage.foldername(name)[1] is the first path segment = the owner uid.

drop policy if exists "vgc_profiles_select" on storage.objects;
create policy "vgc_profiles_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'profiles' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vgc_profiles_insert" on storage.objects;
create policy "vgc_profiles_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'profiles' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vgc_profiles_update" on storage.objects;
create policy "vgc_profiles_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'profiles' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'profiles' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vgc_profiles_delete" on storage.objects;
create policy "vgc_profiles_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profiles' and (storage.foldername(name))[1] = auth.uid()::text);
