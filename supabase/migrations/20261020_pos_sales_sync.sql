-- POS (Parafait) sales + the ingredient usage those sales imply, uploaded nightly by a
-- script on the Parafait server. Stored per HOUR so a report can line sales up with
-- Sunday-night counts exactly.
create extension if not exists pgcrypto with schema extensions;

create table if not exists pos_sales_hourly (
  sold_hour      timestamptz not null,
  pos_product_id integer     not null,
  is_modifier    boolean     not null default false,
  item_name      text        not null,
  category       text,
  qty            numeric     not null default 0,
  amount         numeric     not null default 0,
  sale_day       date        not null,
  batch_id       bigint      not null,
  primary key (batch_id, sold_hour, pos_product_id, is_modifier)
);
create table if not exists pos_usage_hourly (
  sold_hour   timestamptz not null,
  product_id  bigint      not null,
  source_item text        not null,
  qty         numeric     not null default 0,   -- in the product's count unit
  sale_day    date        not null,
  batch_id    bigint      not null,
  primary key (batch_id, sold_hour, product_id, source_item)
);
create table if not exists pos_unmatched_hourly (
  sold_hour timestamptz not null,
  item_name text        not null,
  reason    text        not null default 'no recipe',
  qty       numeric     not null default 0,
  sale_day  date        not null,
  batch_id  bigint      not null,
  primary key (batch_id, sold_hour, item_name, reason)
);
create table if not exists pos_sync_log (
  sync_id   bigserial primary key,
  synced_at timestamptz not null default now(),
  sale_day  date,
  sales_rows integer, usage_rows integer, unmatched_rows integer,
  note text
);
-- One shared secret the server script presents. Only its hash is stored.
create table if not exists pos_sync_key (id int primary key default 1 check (id = 1), key_hash text not null, created_at timestamptz default now());

alter table pos_sales_hourly     enable row level security;
alter table pos_usage_hourly     enable row level security;
alter table pos_unmatched_hourly enable row level security;
alter table pos_sync_log         enable row level security;
alter table pos_sync_key         enable row level security;   -- no policies: nobody reads it directly
create policy "staff read" on pos_sales_hourly     for select to authenticated using (true);
create policy "staff read" on pos_usage_hourly     for select to authenticated using (true);
create policy "staff read" on pos_unmatched_hourly for select to authenticated using (true);
create policy "staff read" on pos_sync_log         for select to authenticated using (true);

create index if not exists pos_usage_hourly_prod on pos_usage_hourly (product_id, sold_hour);

create or replace function pos_sync_check(p_key text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_key is null or not exists (select 1 from pos_sync_key where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) then
    raise exception 'bad sync key' using errcode = '28000';
  end if;
end $$;
revoke all on function pos_sync_check(text) from public, anon, authenticated;

create index if not exists pos_sales_hourly_day on pos_sales_hourly (sale_day, batch_id);
create index if not exists pos_usage_hourly_day on pos_usage_hourly (sale_day, batch_id);
create index if not exists pos_unmatched_hourly_day on pos_unmatched_hourly (sale_day, batch_id);

-- Re-sending a day adds a newer batch; reports only read the newest batch per day.
-- (Old batches can be cleared out any time: rows whose batch_id isn't in pos_current_batch.)
create or replace view pos_current_batch with (security_invoker = true) as
  select distinct on (sale_day) sale_day, sync_id as batch_id, synced_at from pos_sync_log where sale_day is not null order by sale_day, sync_id desc;
create or replace view v_pos_sales with (security_invoker = true) as
  select s.sold_hour, s.sale_day, s.pos_product_id, s.is_modifier, s.item_name, s.category, s.qty, s.amount
  from pos_sales_hourly s join pos_current_batch b on b.batch_id = s.batch_id;
create or replace view v_pos_usage with (security_invoker = true) as
  select u.sold_hour, u.sale_day, u.product_id, u.source_item, u.qty
  from pos_usage_hourly u join pos_current_batch b on b.batch_id = u.batch_id;
create or replace view v_pos_unmatched with (security_invoker = true) as
  select x.sold_hour, x.sale_day, x.item_name, x.reason, x.qty
  from pos_unmatched_hourly x join pos_current_batch b on b.batch_id = x.batch_id;
grant select on pos_current_batch, v_pos_sales, v_pos_usage, v_pos_unmatched to authenticated;

-- Upload one local (Las Vegas) day. Each element: {"h":"2026-10-12 14:00", ...}
create or replace function pos_ingest_day(p_key text, p_day date, p_sales jsonb, p_usage jsonb, p_unmatched jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare b bigint; ns int; nu int; nx int;
begin
  perform pos_sync_check(p_key);
  insert into pos_sync_log (sale_day) values (p_day) returning sync_id into b;
  insert into pos_sales_hourly (batch_id, sale_day, sold_hour, pos_product_id, is_modifier, item_name, category, qty, amount)
    select b, p_day, (x->>'h')::timestamp at time zone 'America/Los_Angeles', (x->>'pid')::int, coalesce((x->>'mod')::boolean, false),
           x->>'name', x->>'cat', (x->>'qty')::numeric, coalesce((x->>'amt')::numeric, 0)
    from jsonb_array_elements(coalesce(p_sales, '[]')) x;
  get diagnostics ns = row_count;
  insert into pos_usage_hourly (batch_id, sale_day, sold_hour, product_id, source_item, qty)
    select b, p_day, (x->>'h')::timestamp at time zone 'America/Los_Angeles', (x->>'pid')::bigint, x->>'src', (x->>'qty')::numeric
    from jsonb_array_elements(coalesce(p_usage, '[]')) x;
  get diagnostics nu = row_count;
  insert into pos_unmatched_hourly (batch_id, sale_day, sold_hour, item_name, reason, qty)
    select b, p_day, (x->>'h')::timestamp at time zone 'America/Los_Angeles', x->>'name', coalesce(x->>'why', 'no recipe'), (x->>'qty')::numeric
    from jsonb_array_elements(coalesce(p_unmatched, '[]')) x;
  get diagnostics nx = row_count;
  update pos_sync_log set sales_rows = ns, usage_rows = nu, unmatched_rows = nx where sync_id = b;
  return jsonb_build_object('day', p_day, 'batch', b, 'sales', ns, 'usage', nu, 'unmatched', nx);
end $$;
revoke all on function pos_ingest_day(text, date, jsonb, jsonb, jsonb) from public;
grant execute on function pos_ingest_day(text, date, jsonb, jsonb, jsonb) to anon, authenticated;
-- The sync key's hash is inserted into pos_sync_key separately (never commit the key itself).

-- The live recipe data the server script needs to turn sales into ingredient usage.
create or replace function pos_sync_recipes(p_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform pos_sync_check(p_key);
  return jsonb_build_object(
    'recipes',  (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from (select recipe_id, name, kind, base_recipe_id, sauce_component_id, topping_component_ids, yield_qty, yield_unit, active from menu_recipe) r),
    'lines',    (select coalesce(jsonb_agg(to_jsonb(l) order by l.recipe_id, l.sort, l.line_id), '[]') from (select line_id, recipe_id, sort, product_id, item_name, qty, unit, factor, sub_recipe_id, options, role from menu_recipe_line) l),
    'comps',    (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from (select component_id, kind, name, product_id, unit, factor, full_qty, kids_qty, portions, sub_recipe_id from pizza_component) c),
    'products', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from (select product_id, name, use_unit, coalesce(usage_measure, count_unit) as measure from product) p)
  );
end $$;
revoke all on function pos_sync_recipes(text) from public;
grant execute on function pos_sync_recipes(text) to anon, authenticated;
