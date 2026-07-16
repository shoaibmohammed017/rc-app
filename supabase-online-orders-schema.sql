-- ============================================================
-- RC Manager — Shiprocket ONLINE ORDERS table
-- Run once: Supabase → SQL Editor → New query → paste → Run.
-- Separate from business_state so the Shiprocket sync never
-- fights the app's JSON-blob merge.
-- ============================================================

create table if not exists public.online_orders (
  sr_id            bigint primary key,          -- Shiprocket order id (stable dedup key)
  channel_order_id text,                        -- e.g. PRC-XAXTLNYA (your site) or marketplace no.
  order_date       timestamptz,                 -- parsed order time (IST)
  order_ymd        text,                         -- YYYY-MM-DD (IST) for fast period filtering
  payment_method   text,                         -- cod | prepaid
  payment_status   text,
  total            numeric default 0,            -- order value (₹)
  qty              int default 0,
  status           text,                         -- NEW, IN TRANSIT, DELIVERED, RTO ...
  status_code      int,
  master_status    text,
  channel_name     text,
  customer_name    text,
  customer_city    text,
  customer_state   text,
  awb              text,
  courier          text,
  remittance_from  text,                         -- expected_remittance_date.start_date
  remittance_to    text,                         -- expected_remittance_date.end_date
  delivered_date   text,
  is_rto           boolean default false,
  is_cancelled     boolean default false,
  is_delivered     boolean default false,
  raw              jsonb,                         -- full order for future fields (products, cod, etc.)
  synced_at        timestamptz default now()
);

create index if not exists online_orders_ymd_idx on public.online_orders (order_ymd);

alter table public.online_orders enable row level security;

-- App reads directly (like business_state). Writes come from the server sync
-- function using the same public key for now; we can harden to service-role later.
drop policy if exists "read online_orders"   on public.online_orders;
drop policy if exists "insert online_orders" on public.online_orders;
drop policy if exists "update online_orders" on public.online_orders;

create policy "read online_orders"   on public.online_orders for select using (true);
create policy "insert online_orders" on public.online_orders for insert with check (true);
create policy "update online_orders" on public.online_orders for update using (true) with check (true);
