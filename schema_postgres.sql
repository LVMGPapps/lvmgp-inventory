-- ============================================================
-- LVMGP Inventory — Postgres schema for Supabase
-- Run this once in Supabase Studio → SQL Editor.
-- One database, two domains (fnb | prize). Vendors & locations global.
-- On-hand = latest count per location, summed. RLS = logged-in staff only.
-- ============================================================

create table public.vendor (
  vendor_id  bigint generated always as identity primary key,
  name       text not null unique,
  order_days text,
  min_order  numeric(10,2),
  active     boolean not null default true
);

create table public.location (
  location_id bigint generated always as identity primary key,
  name        text not null unique,
  sort_order  int not null default 0,
  active      boolean not null default true
);

create table public.product (
  product_id     bigint generated always as identity primary key,
  domain         text not null default 'fnb' check (domain in ('fnb','prize')),
  name           text not null,
  category       text,
  brand          text,
  supc           text,
  mfr            text,
  menu           text,
  purchase_unit  text not null default 'Case',
  pack           numeric(10,3) not null default 1,
  size           numeric(10,3),
  size_unit      text,
  count_unit     text not null default 'each',
  count_per_case numeric(10,3) not null default 1,
  use_unit       text,
  use_per_count  numeric(12,4),
  par_level      numeric(12,3),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index ix_product_domain on public.product(domain, active);
create index ix_product_supc on public.product(supc);

create table public.product_vendor (
  product_vendor_id bigint generated always as identity primary key,
  product_id    bigint not null references public.product(product_id) on delete cascade,
  vendor_id     bigint not null references public.vendor(vendor_id),
  current_price numeric(12,4),
  is_primary    boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (product_id, vendor_id)
);

create table public.product_barcode (
  barcode_id bigint generated always as identity primary key,
  product_id bigint not null references public.product(product_id) on delete cascade,
  code       text not null unique
);

create table public.product_location (
  product_location_id bigint generated always as identity primary key,
  product_id  bigint not null references public.product(product_id) on delete cascade,
  location_id bigint not null references public.location(location_id),
  is_primary  boolean not null default false,
  unique (product_id, location_id)
);

-- Partial count of one product at one location at a point in time.
create table public.stock_count (
  stock_count_id bigint generated always as identity primary key,
  product_id  bigint not null references public.product(product_id),
  location_id bigint not null references public.location(location_id),
  counted_at  timestamptz not null default now(),
  cases       numeric(12,3) not null default 0,
  loose       numeric(12,3) not null default 0,
  qty         numeric(14,3) not null,        -- cases*count_per_case + loose
  counted_by  uuid                            -- auth.users id
);
create index ix_stock_count_lookup on public.stock_count(product_id, location_id, counted_at desc);

create table public.receipt (
  receipt_id    bigint generated always as identity primary key,
  vendor_id     bigint references public.vendor(vendor_id),
  received_date date not null,
  reference     text,
  entered_by    uuid,
  created_at    timestamptz not null default now()
);
create table public.receipt_line (
  receipt_line_id bigint generated always as identity primary key,
  receipt_id      bigint not null references public.receipt(receipt_id) on delete cascade,
  product_id      bigint not null references public.product(product_id),
  location_id     bigint references public.location(location_id),
  purchase_qty    numeric(12,3) not null,
  unit_cost       numeric(12,4),
  qty_count_units numeric(14,3) not null
);

create table public.price_history (
  price_history_id bigint generated always as identity primary key,
  product_id   bigint not null references public.product(product_id),
  vendor_id    bigint not null references public.vendor(vendor_id),
  price        numeric(12,4) not null,
  effective_at timestamptz not null default now(),
  source       text
);
create index ix_price_history on public.price_history(product_id, vendor_id, effective_at desc);

create table public.shopping_list (
  shopping_list_id bigint generated always as identity primary key,
  domain     text not null default 'fnb',
  name       text not null default 'Working list',
  status     text not null default 'open' check (status in ('open','ordered','closed')),
  created_at timestamptz not null default now()
);
create table public.shopping_line (
  shopping_line_id bigint generated always as identity primary key,
  shopping_list_id bigint not null references public.shopping_list(shopping_list_id) on delete cascade,
  product_id bigint not null references public.product(product_id),
  vendor_id  bigint references public.vendor(vendor_id),
  qty        numeric(12,3) not null default 1
);

-- ---- Views (security_invoker so RLS applies) ----
create or replace view public.v_on_hand_by_location
  with (security_invoker = on) as
  select distinct on (product_id, location_id)
         product_id, location_id, qty, counted_at
  from public.stock_count
  order by product_id, location_id, counted_at desc;

create or replace view public.v_on_hand
  with (security_invoker = on) as
  select product_id, sum(qty) as on_hand
  from public.v_on_hand_by_location group by product_id;

-- ---- Row Level Security: any logged-in (invited) user = staff, full access ----
do $$
declare t text;
begin
  foreach t in array array[
    'vendor','location','product','product_vendor','product_barcode',
    'product_location','stock_count','receipt','receipt_line',
    'price_history','shopping_list','shopping_line'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy staff_all on public.%I
                      for all to authenticated using (true) with check (true)$p$, t);
  end loop;
end $$;

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;

-- ---- Seed: LVMGP locations + vendors ----
insert into public.location(name, sort_order) values
 ('Walk-in Freezer',1),('Walk-in Refrigerator',2),('Cage Left',3),('Cage Right',4),
 ('In-Use BIBs',5),('BIB Rack',6),('Back Kitchen',7),('Main Kitchen',8),('Bathroom Closet',9);
insert into public.vendor(name) values ('Sysco'),('Costco'),('Amazon'),('Pepsi'),('Instacart');
