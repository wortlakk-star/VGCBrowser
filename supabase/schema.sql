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
  updated_at  timestamptz not null default now(),
  unique (owner, profile_id)
);

alter table public.profiles_cloud enable row level security;

-- Owners can do anything with their own rows.
drop policy if exists "owner full access" on public.profiles_cloud;
create policy "owner full access"
  on public.profiles_cloud
  for all
  using (owner = auth.uid())
  with check (owner = auth.uid());

create index if not exists profiles_cloud_owner_idx on public.profiles_cloud (owner);

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
  set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id and user_id = _user_id
  );
$$;

create or replace function public.is_team_owner(_team_id uuid, _user_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from public.teams
    where id = _team_id and owner = _user_id
  );
$$;

drop policy if exists "team members read" on public.teams;
create policy "team members read"
  on public.teams for select
  using (
    owner = auth.uid()
    or public.is_team_member(id, auth.uid())
  );

drop policy if exists "team owner writes" on public.teams;
create policy "team owner writes"
  on public.teams for all
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists "members read membership" on public.team_members;
create policy "members read membership"
  on public.team_members for select
  using (user_id = auth.uid()
         or public.is_team_owner(team_id, auth.uid()));

-- ── Phase 6b: sharing ────────────────────────────────────────────────────────
-- Team members can READ profiles shared to a team they belong to.
drop policy if exists "team read profiles" on public.profiles_cloud;
create policy "team read profiles"
  on public.profiles_cloud for select
  using (
    team_id is not null
    and public.is_team_member(team_id, auth.uid())
  );

-- A user can add THEMSELVES as a member (used right after creating a team).
drop policy if exists "self join" on public.team_members;
create policy "self join"
  on public.team_members for insert
  with check (user_id = auth.uid());

-- Team owners can add/remove any member of their teams.
drop policy if exists "owner manages members" on public.team_members;
create policy "owner manages members"
  on public.team_members for all
  using (public.is_team_owner(team_id, auth.uid()))
  with check (public.is_team_owner(team_id, auth.uid()));
