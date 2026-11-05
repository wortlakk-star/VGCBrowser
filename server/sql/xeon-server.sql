-- VGC máy chủ riêng (Xeon) — chạy SAU 8 file supabase/*.sql. Chạy lại an toàn.
-- Chỉ dùng trên máy chủ tự host, KHÔNG chạy trên Supabase cloud.

-- 1. Cho tài khoản dịch vụ của máy chủ (service_role, chỉ tồn tại bên trong máy Xeon) chép
--    nguyên khoá tài khoản từ cloud sang. Mọi tài khoản khác vẫn bị kiểm tra như cũ.
create or replace function public.guard_account_secret_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
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

-- 2. Biên bản chuyển dữ liệu (chỉ dịch vụ máy chủ đọc/ghi).
create table if not exists public.vgc_migration_runs (
  id          bigserial primary key,
  uid         uuid not null,
  email       text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  full_verify boolean not null default false,
  report      jsonb,
  error       text
);
create index if not exists vgc_migration_runs_uid_idx on public.vgc_migration_runs (uid, started_at desc);

-- Mã SHA-256 của từng file đã chép + ETag bên cloud lúc chép (để lần sau bỏ qua file không đổi).
create table if not exists public.vgc_migration_objects (
  name        text primary key,
  sha256      text not null,
  size        bigint not null,
  src_etag    text,
  verified_at timestamptz not null default now()
);

-- Dòng chưa ghi được vì tham chiếu tài khoản chưa chuyển (vd thành viên nhóm) — tự ghép sau.
create table if not exists public.vgc_migration_pending (
  tbl        text not null,
  pk         text not null,
  row        jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tbl, pk)
);

do $do$
declare t text;
begin
  foreach t in array array['vgc_migration_runs','vgc_migration_objects','vgc_migration_pending'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$do$;
grant usage, select on sequence public.vgc_migration_runs_id_seq to service_role;

-- 3. ETag của file trên máy chủ (để app 2.2.0 đổi "mã phiên bản" đã nhớ từ cloud sang mã mới).
alter table public.vgc_migration_objects add column if not exists dst_etag text;
alter table public.vgc_migration_objects add column if not exists src_etag_hdr text;

-- 4. Danh sách nhân viên được dùng VGC (thay vgcbrowser.com/quanly). Chỉ dịch vụ máy chủ đọc/ghi.
create table if not exists public.vgc_staff (
  email        text primary key check (email = lower(email)),
  approved     boolean not null default true,
  expires      timestamptz,
  note         text,
  source       text not null default 'admin',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen    timestamptz,
  machine_name text,
  machine_id   text,
  os           text
);
alter table public.vgc_staff enable row level security;
alter table public.vgc_staff force row level security;
revoke all on table public.vgc_staff from anon, authenticated;
grant all on table public.vgc_staff to service_role;

-- 5. Lệnh điều khiển toàn hệ thống (vd huỷ khẩn cấp). Chỉ dịch vụ máy chủ đọc/ghi.
create table if not exists public.vgc_control (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.vgc_control enable row level security;
alter table public.vgc_control force row level security;
revoke all on table public.vgc_control from anon, authenticated;
grant all on table public.vgc_control to service_role;

-- 6. Số "epoch" khoá profile trên máy chủ luôn lớn hơn mọi số cloud từng cấp (app so epoch để biết ai
--    đang giữ profile). Đẩy lên 10^12 một lần; chạy lại không giảm.
select setval('public.profile_lock_epoch_seq',
              greatest(1000000000000, (select last_value from public.profile_lock_epoch_seq)), true);
