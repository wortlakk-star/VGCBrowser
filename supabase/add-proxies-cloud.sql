-- ── ADD: proxies_cloud — sync the Proxy Manager pool per account ─────────────
-- Run ONCE in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent). Mirrors profiles_cloud: each row is one saved proxy
-- owned by the signed-in user, protected by owner-only RLS.

create table if not exists public.proxies_cloud (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users (id) on delete cascade default auth.uid(),
  proxy_id   text not null,               -- the app's local SavedProxy id
  label      text,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  unique (owner, proxy_id)
);

alter table public.proxies_cloud enable row level security;

drop policy if exists "owner full access proxies" on public.proxies_cloud;
create policy "owner full access proxies"
  on public.proxies_cloud
  for all
  using (owner = auth.uid())
  with check (owner = auth.uid());

create index if not exists proxies_cloud_owner_idx on public.proxies_cloud (owner);
