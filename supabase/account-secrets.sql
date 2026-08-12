-- VGC Browser - passphrase-wrapped per-account encryption key.
-- Run in the Supabase SQL editor after schema.sql. Safe to re-run.
-- The server stores only VGCWRAP1 ciphertext. A legacy 64-hex plaintext key may be
-- updated exactly once to VGCWRAP1 so existing installations can migrate safely.

create table if not exists public.account_secrets (
  owner uuid primary key references auth.users (id) on delete cascade,
  secret text not null,
  created_at timestamptz not null default now()
);

alter table public.account_secrets enable row level security;
alter table public.account_secrets force row level security;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'account_secrets_format_check'
      and conrelid = 'public.account_secrets'::regclass
  ) then
    alter table public.account_secrets
      add constraint account_secrets_format_check check (
        secret ~* '^[a-f0-9]{64}$'
        or (
          char_length(secret) between 80 and 4096
          and secret ~ '^VGCWRAP1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$'
        )
      ) not valid;
  end if;
end
$do$;

create or replace function public.guard_account_secret_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.owner is distinct from auth.uid() then
    raise exception 'account secret owner mismatch';
  end if;

  if new.secret !~ '^VGCWRAP1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$'
     or char_length(new.secret) not between 80 and 4096 then
    raise exception 'account secret must be VGCWRAP1 ciphertext';
  end if;

  if tg_op = 'UPDATE' then
    if new.owner is distinct from old.owner
       or new.created_at is distinct from old.created_at
       or old.secret !~* '^[a-f0-9]{64}$' then
      raise exception 'account secret is immutable after wrapping';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_account_secret_write() from public, anon, authenticated;

drop trigger if exists guard_account_secret_write on public.account_secrets;
create trigger guard_account_secret_write
  before insert or update on public.account_secrets
  for each row execute function public.guard_account_secret_write();

drop policy if exists "account_secrets own select" on public.account_secrets;
create policy "account_secrets own select" on public.account_secrets
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists "account_secrets own insert" on public.account_secrets;
create policy "account_secrets own insert" on public.account_secrets
  for insert to authenticated
  with check (owner = auth.uid());

drop policy if exists "account_secrets own update" on public.account_secrets;
create policy "account_secrets own update" on public.account_secrets
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

revoke all on table public.account_secrets from anon;
revoke all on table public.account_secrets from authenticated;
grant select, insert, update on table public.account_secrets to authenticated;
