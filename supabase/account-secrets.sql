-- VGC Browser — per-account encryption secret
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- It creates a table holding a random secret per account, readable ONLY by the
-- owner (RLS). The app uses it to (a) derive the engine's portable os_crypt key so
-- it is no longer derivable from the public uid/profileId, and (b) AES-256-GCM
-- encrypt the synced cookies before upload. Until this runs, the app falls back to
-- the older (weaker, derivable) behavior — nothing breaks, it just isn't encrypted.

create table if not exists public.account_secrets (
  owner uuid primary key references auth.users (id) on delete cascade,
  secret text not null,
  created_at timestamptz not null default now()
);

alter table public.account_secrets enable row level security;

-- Owner can read their own secret (needed to decrypt on every machine of the account).
drop policy if exists "account_secrets own select" on public.account_secrets;
create policy "account_secrets own select" on public.account_secrets
  for select using (owner = auth.uid());

-- Owner can insert their own secret once. No update/delete policy → the secret is
-- immutable; rotating it would orphan already-encrypted data, so we never do.
drop policy if exists "account_secrets own insert" on public.account_secrets;
create policy "account_secrets own insert" on public.account_secrets
  for insert with check (owner = auth.uid());
