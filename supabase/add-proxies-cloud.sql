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
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (owner, proxy_id)
);

alter table public.proxies_cloud enable row level security;
alter table public.proxies_cloud force row level security;
alter table public.proxies_cloud add column if not exists deleted boolean not null default false;

do $do$
begin
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
end
$do$;

drop policy if exists "owner full access proxies" on public.proxies_cloud;
create policy "owner full access proxies"
  on public.proxies_cloud
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

create index if not exists proxies_cloud_owner_idx on public.proxies_cloud (owner);

revoke all on table public.proxies_cloud from anon;
revoke all on table public.proxies_cloud from authenticated;
grant select, insert, update, delete on table public.proxies_cloud to authenticated;
