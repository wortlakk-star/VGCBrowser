-- ── ADD: soft-delete (tombstone) for profiles + proxies ─────────────────────
-- Run ONCE in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent).
--
-- WHY: profile/proxy sync is "upsert only", so deleting on one machine never
-- removed the cloud row → it kept re-appearing on "Làm mới" and on the other
-- machine. A `deleted` flag is a tombstone: deleting marks the row deleted=true,
-- every machine drops it on pull, and a stale machine re-pushing the row can't
-- resurrect it (push never sets `deleted`, so the flag survives the upsert).

alter table public.profiles_cloud add column if not exists deleted boolean not null default false;
alter table public.proxies_cloud  add column if not exists deleted boolean not null default false;
alter table public.profiles_cloud enable row level security;
alter table public.proxies_cloud enable row level security;
alter table public.profiles_cloud force row level security;
alter table public.proxies_cloud force row level security;
