-- ── VGC Browser — Supabase schema (Phase 6: Cloud + Team) ────────────────────
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- Then put the project URL + anon key into VGC Browser → ⚙ Cài đặt → Cloud.

-- Each row is one synced profile, owned by the signed-in user. `data` holds the
-- full profile JSON the app uses; `profile_id` is the app's local profile id so
-- push/pull can upsert without duplicating.
create table if not exists public.profiles_cloud (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users (id) on delete cascade default auth.uid(),
  team_id     uuid,                       -- reserved for team sharing (Phase 6b)
  profile_id  text not null,              -- the app's local profile id
  name        text,
  data        jsonb not null,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (owner, profile_id)
);

alter table public.profiles_cloud enable row level security;
alter table public.profiles_cloud force row level security;
alter table public.profiles_cloud add column if not exists deleted boolean not null default false;

-- Owners can do anything with their own rows.
drop policy if exists "owner full access" on public.profiles_cloud;
create policy "owner full access"
  on public.profiles_cloud
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

create index if not exists profiles_cloud_owner_idx on public.profiles_cloud (owner);

-- ── Proxy pool (Proxy Manager) — synced per account, like profiles. ──────────
-- Each row is one saved proxy owned by the signed-in user. `data` holds the full
-- SavedProxy JSON; `proxy_id` is the app's local id so push/pull upserts cleanly.
create table if not exists public.proxies_cloud (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users (id) on delete cascade default auth.uid(),
  proxy_id   text not null,               -- the app's local SavedProxy id
  label      text,
  data       jsonb not null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (owner, proxy_id)
);

alter table public.proxies_cloud enable row level security;
alter table public.proxies_cloud force row level security;
alter table public.proxies_cloud add column if not exists deleted boolean not null default false;

-- Owners can do anything with their own proxies.
drop policy if exists "owner full access proxies" on public.proxies_cloud;
create policy "owner full access proxies"
  on public.proxies_cloud
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

create index if not exists proxies_cloud_owner_idx on public.proxies_cloud (owner);

-- ── Teams (Phase 6b — sharing). Optional now; safe to create. ────────────────
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner      uuid not null references auth.users (id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role    text not null default 'member',  -- 'owner' | 'admin' | 'member'
  primary key (team_id, user_id)
);

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.teams force row level security;
alter table public.team_members force row level security;

-- New writes must use the encrypted `{ "enc": "..." }` envelope. NOT VALID keeps
-- legacy rows readable long enough for the app's one-time owner migration, while the
-- constraint is still enforced for every insert/update from this point onward.
do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_cloud_encrypted_data_check'
      and conrelid = 'public.profiles_cloud'::regclass
  ) then
    alter table public.profiles_cloud
      add constraint profiles_cloud_encrypted_data_check check (
        jsonb_typeof(data) = 'object'
        and data ? 'enc'
        and jsonb_typeof(data -> 'enc') = 'string'
        and data - 'enc' = '{}'::jsonb
        and octet_length(data ->> 'enc') between 40 and 25165824
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'proxies_cloud_encrypted_data_check'
      and conrelid = 'public.proxies_cloud'::regclass
  ) then
    alter table public.proxies_cloud
      add constraint proxies_cloud_encrypted_data_check check (
        jsonb_typeof(data) = 'object'
        and data ? 'enc'
        and jsonb_typeof(data -> 'enc') = 'string'
        and data - 'enc' = '{}'::jsonb
        and octet_length(data ->> 'enc') between 40 and 4194304
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_cloud_profile_id_check'
      and conrelid = 'public.profiles_cloud'::regclass
  ) then
    alter table public.profiles_cloud
      add constraint profiles_cloud_profile_id_check check (
        profile_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and (name is null or octet_length(name) <= 1024)
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'proxies_cloud_proxy_id_check'
      and conrelid = 'public.proxies_cloud'::regclass
  ) then
    alter table public.proxies_cloud
      add constraint proxies_cloud_proxy_id_check check (
        proxy_id ~ '^[A-Za-z0-9_-]{1,100}$'
        and (label is null or octet_length(label) <= 1024)
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'team_members_role_check'
      and conrelid = 'public.team_members'::regclass
  ) then
    alter table public.team_members
      add constraint team_members_role_check
      check (role in ('owner', 'admin', 'member')) not valid;
  end if;
end
$do$;

-- ── RLS helpers (SECURITY DEFINER) ───────────────────────────────────────────
-- The teams/team_members/profiles_cloud policies cross-reference each other. If
-- they did so via plain sub-SELECTs, evaluating one policy would trigger another
-- table's policy, which triggers the first again → "infinite recursion detected
-- in policy" (Postgres 42P17). These helpers run as the function owner (postgres),
-- which bypasses RLS on the tables they read, so the membership/ownership checks
-- no longer re-enter the policies. Keep policy bodies referring ONLY to these.
create or replace function public.is_team_member(_team_id uuid, _user_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.team_members
    where _user_id = auth.uid()
      and team_id = _team_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.is_team_owner(_team_id uuid, _user_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.teams
    where _user_id = auth.uid()
      and id = _team_id
      and owner = auth.uid()
  );
$$;

revoke all on function public.is_team_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.is_team_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_team_member(uuid, uuid) to authenticated;
grant execute on function public.is_team_owner(uuid, uuid) to authenticated;

drop policy if exists "team members read" on public.teams;
create policy "team members read"
  on public.teams for select to authenticated
  using (
    owner = auth.uid()
    or public.is_team_member(id, auth.uid())
  );

drop policy if exists "team owner writes" on public.teams;
create policy "team owner writes"
  on public.teams for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists "members read membership" on public.team_members;
create policy "members read membership"
  on public.team_members for select to authenticated
  using (user_id = auth.uid()
         or public.is_team_owner(team_id, auth.uid()));

-- Team metadata remains available, but profile sharing is disabled until each
-- recipient has a public-key envelope. Never expose another account's ciphertext as
-- a substitute for a working end-to-end sharing design.
drop policy if exists "team read profiles" on public.profiles_cloud;

-- Membership is owner-managed. Allowing a user to add themselves made every
-- team effectively public to anyone who learned its UUID.
drop policy if exists "self join" on public.team_members;

-- Team owners can add/remove any member of their teams.
drop policy if exists "owner manages members" on public.team_members;
create policy "owner manages members"
  on public.team_members for all to authenticated
  using (public.is_team_owner(team_id, auth.uid()))
  with check (public.is_team_owner(team_id, auth.uid()));

revoke all on table public.profiles_cloud from anon;
revoke all on table public.proxies_cloud from anon;
revoke all on table public.teams from anon;
revoke all on table public.team_members from anon;
revoke all on table public.profiles_cloud from authenticated;
revoke all on table public.proxies_cloud from authenticated;
revoke all on table public.teams from authenticated;
revoke all on table public.team_members from authenticated;
grant select, insert, update, delete on table public.profiles_cloud to authenticated;
grant select, insert, update, delete on table public.proxies_cloud to authenticated;
grant select, insert, update, delete on table public.teams to authenticated;
grant select, insert, update, delete on table public.team_members to authenticated;
