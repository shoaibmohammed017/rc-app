-- ============================================================
-- RC Business Manager — Supabase setup
-- Paste this whole file into:  Supabase → SQL Editor → New query → Run
-- It creates one shared business record + security rules so that
-- only your logged-in staff can read/write your data.
-- ============================================================

create table if not exists public.business_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.business_state enable row level security;

-- Any signed-in staff member can read the business data
drop policy if exists "read business" on public.business_state;
create policy "read business" on public.business_state
  for select to authenticated using (true);

-- Any signed-in staff member can create the record
drop policy if exists "insert business" on public.business_state;
create policy "insert business" on public.business_state
  for insert to authenticated with check (true);

-- Any signed-in staff member can update the record
drop policy if exists "update business" on public.business_state;
create policy "update business" on public.business_state
  for update to authenticated using (true) with check (true);

-- Seed the empty business row (safe to run more than once)
insert into public.business_state (id, data)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;

-- ============================================================
-- (Optional) make data sync live across devices in real time:
-- Supabase → Database → Replication → enable for "business_state"
-- ============================================================
