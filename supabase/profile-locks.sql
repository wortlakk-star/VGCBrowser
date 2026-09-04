-- ── VGC Browser — cross-machine EXCLUSIVE profile lock (session takeover) ───────
-- Only ONE machine may have a given profile open at a time. Each OPEN "claims" the lock,
-- which bumps a monotonic `epoch`. A machine holds the lock iff the row's epoch equals the
-- epoch it was given when it claimed. The holder polls; when it sees a HIGHER epoch, another
-- open (this or another machine) has taken over → it saves+uploads its session, publishes the
-- new session ETag for the taking-over generation, then closes. The claimer waits for that
-- ETag before downloading, so it always pulls the freshest session, never a stale one.
--
-- Why epoch (not holder_device) is the identity:
--   • A cloned install (duplicate machine id) still gets a DISTINCT epoch per claim, so
--     exclusivity holds even when two machines share a machine id.
--   • A same-machine reopen bumps the epoch, so a delayed release/poll from the PREVIOUS open
--     (gated on its own epoch) cannot delete or act on the reopened generation.
--   • set_lock_session_tag is gated on the takeover epoch, so a straggler from an OLDER cycle
--     cannot satisfy a NEWER claimer's hand-off wait.
--
-- Both machines are the SAME account (owner = auth.uid()); RLS scopes by owner only, so mutual
-- exclusion is enforced app-side via the epoch, not by RLS. Rows are tiny + high-churn, so this
-- lives in its OWN table (NOT profiles_cloud, whose data is encrypted-only + whose updated_at
-- drives metadata sync). Run once in the Supabase SQL editor (project: pwiledrttvbnmytghyip).

-- GLOBAL monotonic epoch source. Using a sequence (not a per-row +1) means every claim — even the
-- INSERT that follows a release-DELETE — gets a strictly HIGHER epoch than any ever issued, so a
-- delayed/duplicated release or poll from a previous open can never collide with a reopened row.
create sequence if not exists public.profile_lock_epoch_seq;

create table if not exists public.profile_locks (
  profile_id    text   not null,
  owner         uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  holder_device text   not null,                       -- getMachineId() — for the UX label only
  holder_name   text,                                  -- getMachineName() (hostname) for a toast
  holder_since  timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),    -- refreshed every poll by the holder
  epoch         bigint not null,                       -- globally-monotonic generation = the identity
  session_tag   text,                                  -- ETag the kicked holder wrote for the NEW
                                                        -- epoch after its save; the claimer waits on it
  primary key (owner, profile_id)
);

alter table public.profile_locks enable row level security;
alter table public.profile_locks force row level security;

drop policy if exists "owner full access locks" on public.profile_locks;
create policy "owner full access locks" on public.profile_locks
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- claim_profile_lock: atomically take the lock, bumping epoch. Returns the NEW epoch this open
-- holds, plus who held it immediately before and whether that holder looked alive (fresh
-- heartbeat) — so the claimer knows how long to wait for a hand-off.
create or replace function public.claim_profile_lock(p_profile_id text, p_device text, p_name text)
returns table(my_epoch bigint, previous_holder text, previous_fresh boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  prev_holder text;
  prev_hb     timestamptz;
  new_epoch   bigint;
begin
  select holder_device, heartbeat_at into prev_holder, prev_hb
    from public.profile_locks
    where owner = auth.uid() and profile_id = p_profile_id
    for update;

  insert into public.profile_locks(profile_id, owner, holder_device, holder_name, holder_since, heartbeat_at, epoch, session_tag)
    values (p_profile_id, auth.uid(), p_device, p_name, now(), now(), nextval('public.profile_lock_epoch_seq'), null)
    on conflict (owner, profile_id) do update
      set holder_device = excluded.holder_device,
          holder_name   = excluded.holder_name,
          holder_since  = now(),
          heartbeat_at  = now(),
          epoch         = nextval('public.profile_lock_epoch_seq'),  -- always advances past every prior epoch
          session_tag   = null                 -- reset so the claimer waits for the NEW tag
    returning epoch into new_epoch;

  return query select
    new_epoch,
    prev_holder,                                                        -- may equal p_device (reopen)
    (prev_hb is not null and prev_hb > now() - interval '30 seconds');  -- did a live holder just have it
end;
$$;

-- poll_profile_lock: the holder calls this on a timer. It heartbeats (only while THIS epoch is
-- still the holder) and returns the CURRENT epoch. If the returned epoch differs from the one
-- the caller holds, it has been taken over. NULL means the row is gone (treat as "no lock").
create or replace function public.poll_profile_lock(p_profile_id text, p_epoch bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare cur bigint;
begin
  update public.profile_locks set heartbeat_at = now()
    where owner = auth.uid() and profile_id = p_profile_id and epoch = p_epoch;
  select epoch into cur from public.profile_locks
    where owner = auth.uid() and profile_id = p_profile_id;
  return cur;
end;
$$;

-- release_profile_lock: free the lock on a clean close, but ONLY if this exact epoch still holds
-- it — so a delayed release from a previous open can never delete a newer generation's row.
create or replace function public.release_profile_lock(p_profile_id text, p_epoch bigint)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.profile_locks
    where owner = auth.uid() and profile_id = p_profile_id and epoch = p_epoch;
$$;

-- set_lock_session_tag: the kicked holder records the ETag of the session it just uploaded, for
-- the takeover GENERATION it observed (p_epoch = the epoch that kicked it). Writes only if that
-- epoch is still current, so a straggler from an older cycle cannot satisfy a newer claimer.
create or replace function public.set_lock_session_tag(p_profile_id text, p_epoch bigint, p_tag text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profile_locks set session_tag = p_tag
    where owner = auth.uid() and profile_id = p_profile_id and epoch = p_epoch;
$$;

grant execute on function public.claim_profile_lock(text, text, text)   to authenticated;
grant execute on function public.poll_profile_lock(text, bigint)        to authenticated;
grant execute on function public.release_profile_lock(text, bigint)     to authenticated;
grant execute on function public.set_lock_session_tag(text, bigint, text) to authenticated;
