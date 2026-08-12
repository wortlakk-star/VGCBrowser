-- VGC Browser - revoke the legacy symmetric-key profile-sharing design.
-- Run after schema.sql. Safe to re-run.
--
-- Existing rows are retained for an administrator-led migration, but no client role
-- can read or mutate them. Re-enable sharing only after adding authenticated user
-- public keys and one encrypted key envelope per recipient.

create table if not exists public.profile_shares (
  profile_id text not null,
  owner uuid not null references auth.users (id) on delete cascade,
  member_email text not null,
  shared_key text not null,
  proxy jsonb,
  created_at timestamptz not null default now(),
  primary key (owner, profile_id, member_email)
);

alter table public.profile_shares enable row level security;
alter table public.profile_shares force row level security;

drop policy if exists "share owner manage" on public.profile_shares;
drop policy if exists "share member read" on public.profile_shares;

drop policy if exists "shared profile member access" on public.profiles_cloud;
drop policy if exists "shared profile member read" on public.profiles_cloud;
drop policy if exists "shared profile member insert" on public.profiles_cloud;
drop policy if exists "shared profile member update" on public.profiles_cloud;
drop policy if exists "team read profiles" on public.profiles_cloud;

drop policy if exists "shared profile storage member" on storage.objects;
drop policy if exists "shared profile storage member read" on storage.objects;
drop policy if exists "shared profile storage member insert" on storage.objects;
drop policy if exists "shared profile storage member update" on storage.objects;
drop policy if exists "shared profile storage member delete" on storage.objects;

drop trigger if exists guard_shared_profile_update on public.profiles_cloud;
drop function if exists public.guard_shared_profile_update();
drop function if exists public.is_shared_profile_member(uuid, text);
drop function if exists public.can_access_shared_object(text);

revoke all on table public.profile_shares from public, anon, authenticated;
