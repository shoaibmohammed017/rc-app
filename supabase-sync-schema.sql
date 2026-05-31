-- ============================================================
-- RC Manager — NO-LOGIN MULTI-DEVICE SYNC + AUTO-BACKUP setup
-- Run this once (RC assistant runs it for you via the Management API,
-- or paste into Supabase → SQL Editor → New query → Run).
--
-- Security model: no per-user login. The app uses the public
-- "publishable/anon" key, so we allow the anon role to read/write
-- the single business record. Anyone with the app link + that key
-- can access the data — acceptable for an internal tool, but keep
-- the link private.
-- ============================================================

-- 1) Live data: one row holds the whole business state as JSON
create table if not exists public.business_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.business_state enable row level security;

drop policy if exists "anon read state"   on public.business_state;
drop policy if exists "anon insert state" on public.business_state;
drop policy if exists "anon update state" on public.business_state;

create policy "anon read state"   on public.business_state for select using (true);
create policy "anon insert state" on public.business_state for insert with check (true);
create policy "anon update state" on public.business_state for update using (true) with check (true);

insert into public.business_state (id, data)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;

-- 2) Auto-backup history: a dated snapshot per day (point-in-time restore)
create table if not exists public.business_snapshots (
  id bigint generated always as identity primary key,
  snapshot_date date not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (snapshot_date)
);

alter table public.business_snapshots enable row level security;

drop policy if exists "anon read snapshots"   on public.business_snapshots;
drop policy if exists "anon insert snapshots" on public.business_snapshots;
drop policy if exists "anon update snapshots" on public.business_snapshots;

create policy "anon read snapshots"   on public.business_snapshots for select using (true);
create policy "anon insert snapshots" on public.business_snapshots for insert with check (true);
create policy "anon update snapshots" on public.business_snapshots for update using (true) with check (true);

-- 3) Realtime: let devices receive live updates when data changes
alter publication supabase_realtime add table public.business_state;
