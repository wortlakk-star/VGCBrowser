-- VGC Browser — profile sharing (share a profile, two-way, to another email)
-- Run ONCE in the Supabase SQL editor.
--
-- A profile owned by A can be shared with member emails. Because synced data is
-- AES-256-GCM encrypted, a SHARED random key (per shared profile) is stored here so
-- BOTH the owner and the members can decrypt it (the per-account secret can't be
-- used — only its owner can read that). The owner also picks a `proxy` that the
-- shared copy uses. RLS: the owner manages the share; a member can READ the row
-- (to get the shared_key + proxy) when the share targets their email.

create table if not exists public.profile_shares (
  profile_id    text not null,                       -- the app's local profile id
  owner         uuid not null references auth.users (id) on delete cascade,
  member_email  text not null,
  shared_key    text not null,                       -- random hex; the AES key material
  proxy         jsonb,                               -- proxy the owner chose for the share
  created_at    timestamptz not null default now(),
  primary key (owner, profile_id, member_email)
);

alter table public.profile_shares enable row level security;

-- Owner manages all shares of their profiles.
drop policy if exists "share owner manage" on public.profile_shares;
create policy "share owner manage" on public.profile_shares
  for all using (owner = auth.uid()) with check (owner = auth.uid());

-- A member reads shares addressed to their email (to get the key + proxy + know
-- which profiles are shared with them).
drop policy if exists "share member read" on public.profile_shares;
create policy "share member read" on public.profile_shares
  for select using (member_email = (auth.jwt() ->> 'email'));

-- SECURITY DEFINER helper (avoids RLS recursion when referenced by other policies):
-- true when the current user owns OR is a member of a share for this profile.
create or replace function public.can_access_shared_profile(_profile_id text)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.profile_shares
    where profile_id = _profile_id
      and (owner = auth.uid() or member_email = (auth.jwt() ->> 'email'))
  );
$$;

-- profiles_cloud: a member can READ + UPDATE the shared profile's row (two-way), in
-- addition to the existing owner-only policy. Owner stays via "owner full access".
drop policy if exists "shared profile member access" on public.profiles_cloud;
create policy "shared profile member access" on public.profiles_cloud
  for all
  using (public.can_access_shared_profile(profile_id))
  with check (public.can_access_shared_profile(profile_id));

-- Storage: the session zip + cookies live at  {owner_uid}/{profile_id}.(zip|cookies.json).
-- Let a member read+write the objects of a profile shared with them. The FILENAME is
-- "{profile_id}.zip" / "{profile_id}.cookies.json" → strip the suffix to get the
-- profile id and check the share.
drop policy if exists "shared profile storage member" on storage.objects;
create policy "shared profile storage member" on storage.objects
  for all
  using (
    bucket_id = 'profiles'
    and public.can_access_shared_profile(
      regexp_replace(storage.filename(name), '\.(zip|cookies\.json)$', '')
    )
  )
  with check (
    bucket_id = 'profiles'
    and public.can_access_shared_profile(
      regexp_replace(storage.filename(name), '\.(zip|cookies\.json)$', '')
    )
  );
