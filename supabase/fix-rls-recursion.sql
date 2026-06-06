-- ── FIX: "infinite recursion detected in policy for relation team_members" (42P17)
-- Run ONCE in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent). Fixes profiles_cloud failing with HTTP 500 so the
-- app can load the profile list again.
--
-- Cause: teams ↔ team_members ↔ profiles_cloud policies referenced each other with
-- plain sub-SELECTs, so evaluating one policy re-entered another's policy forever.
-- Fix: move the membership/ownership checks into SECURITY DEFINER functions, which
-- run as the table owner and therefore bypass RLS — breaking the cycle.

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

-- teams: members + owner can read
drop policy if exists "team members read" on public.teams;
create policy "team members read"
  on public.teams for select
  using (owner = auth.uid() or public.is_team_member(id, auth.uid()));

-- team_members: see your own rows; team owners see all their team's rows
drop policy if exists "members read membership" on public.team_members;
create policy "members read membership"
  on public.team_members for select
  using (user_id = auth.uid() or public.is_team_owner(team_id, auth.uid()));

-- team_members: owners manage their team's members
drop policy if exists "owner manages members" on public.team_members;
create policy "owner manages members"
  on public.team_members for all
  using (public.is_team_owner(team_id, auth.uid()))
  with check (public.is_team_owner(team_id, auth.uid()));

-- profiles_cloud: members can read profiles shared to their team
drop policy if exists "team read profiles" on public.profiles_cloud;
create policy "team read profiles"
  on public.profiles_cloud for select
  using (team_id is not null and public.is_team_member(team_id, auth.uid()));
