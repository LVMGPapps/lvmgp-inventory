-- LVMGP Kitchen — fountain drink recipes.
-- Needs migration 15 (interchangeable lines) and the build that supports it.
--
-- THREE recipes, not twenty-two: the flavour is an interchangeable line, so
-- "Cost by choice" prices every BIB against the same build. Carbonated and
-- still drinks are separate because only one of them uses CO2.
--
-- Amounts (5:1 BIB, 30% ice):
--   24 oz cup -> 16.8 oz liquid -> 2.80 oz syrup + 14.00 oz water -> 0.00851 lb CO2
--   12 oz cup ->  8.4 oz liquid -> 1.40 oz syrup +  7.00 oz water -> 0.00425 lb CO2
-- CO2 figured at 13.5 gal carbonated water per lb, +5% for the syrup pumps.
-- If your crew ices heavier or lighter, change the ice % and rescale.

-- ============================================================
-- FIRST: three products can't be costed until these are set.
-- Run this, fix them in Catalog, then run the rest.
-- ============================================================
select product_id, name, usage_measure, packages_per_case, usage_per_package,
       packages_per_case * usage_per_package as units_per_case,
       case name
         when 'Brisk Ice Tea BIB' then 'set to 640 oz (or its real bag size) — currently 1 each, so it cannot cost'
         when 'Co2 50lb tank'     then 'set to 50 lb — currently 1 each, so CO2 cannot cost'
         when 'Pepsi Zero/Diet BIB' then 'reads 384 oz (3 gal) — correct if that is the bag you buy, otherwise 640'
       end as what_to_fix
from   public.product
where  name in ('Brisk Ice Tea BIB','Co2 50lb tank','Pepsi Zero/Diet BIB');

-- Diet Dr Pepper isn't stocked. Retired rather than deleted so its delivery
-- history stays intact; it drops out of counts, ordering and the flavour list.
update public.product set active = false where name = 'Diet Dr. Pepper BIB';

-- ============================================================
-- The recipes
-- ============================================================
do $$
declare
  v_recipe  bigint;
  v_co2     bigint := (select product_id from public.product where name = 'Co2 50lb tank' limit 1);
  v_cup24   bigint := (select product_id from public.product where name = 'Large Cups (24 oz)' limit 1);
  v_cup12   bigint := (select product_id from public.product where name = 'Go City Cups (12 oz)' limit 1);
  v_lid     bigint := (select product_id from public.product where name = 'Pepsi Lids' limit 1);
  v_straw   bigint := (select product_id from public.product where name = '7.75" Straw' limit 1);
  v_fizzy   jsonb;
  v_still   jsonb;
  v_cupname text;
  r         record;
begin
  -- the flavour choices, built from whatever BIBs exist, Pepsi marked default
  select jsonb_agg(jsonb_build_object('product_id', product_id, 'is_default', name = 'Pepsi 5G BIB')
                   order by (name <> 'Pepsi 5G BIB'), name)
    into v_fizzy
    from public.product
   where name in ('Pepsi 5G BIB','Pepsi Zero/Diet BIB','Starry BIB','Mt. Dew 5G BIB','Mug Rootbeer BIB',
                  'Orange Crush BIB','Dr. Pepper BIB','Wild Cherry Pepsi 5G BIB');   -- no Diet Dr Pepper, not stocked

  select jsonb_agg(jsonb_build_object('product_id', product_id, 'is_default', name = 'Lemonade BIB')
                   order by (name <> 'Lemonade BIB'), name)
    into v_still
    from public.product
   where name in ('Lemonade BIB','Brisk Ice Tea BIB');

  for r in
    select * from (values
      ('Fountain Soda — 24 oz', 2.80, 0.00851, v_cup24, v_fizzy, true),
      ('Fountain Soda — 12 oz', 1.40, 0.00425, v_cup12, v_fizzy, true),
      ('Lemonade / Iced Tea — 24 oz', 2.80, 0, v_cup24, v_still, false)
    ) as t(nm, syrup_oz, co2_lb, cup_id, choices, fizzy)
  loop
    if r.choices is null then continue; end if;

    delete from public.menu_recipe where name = r.nm;      -- re-runnable
    insert into public.menu_recipe (name, category, kind, active, source, sort_order)
         values (r.nm, 'Beverages', 'standard', true, 'App', 10)
      returning recipe_id into v_recipe;

    -- the flavour: one line, every BIB behind it
    insert into public.menu_recipe_line (recipe_id, sort, stage, item_name, qty, unit, factor, options, note)
         values (v_recipe, 0, 'before', 'Fountain syrup (choose flavour)', r.syrup_oz, 'oz', 1, r.choices,
                 '5:1 BIB — syrup is one sixth of the liquid, and ice takes about 30% of the cup');

    if r.fizzy and v_co2 is not null then
      insert into public.menu_recipe_line (recipe_id, sort, stage, product_id, item_name, qty, unit, factor, note)
           values (v_recipe, 1, 'before', v_co2, 'CO2', r.co2_lb, 'lb', 1,
                   'carbonates the water only, +5% for the syrup pumps');
    end if;

    if r.cup_id is not null then
      select name into v_cupname from public.product where product_id = r.cup_id;
      insert into public.menu_recipe_line (recipe_id, sort, stage, product_id, item_name, qty, unit, factor)
           values (v_recipe, 2, 'pack', r.cup_id, coalesce(v_cupname,'Cup'), 1, 'cup', 1);
    end if;
    if v_lid is not null then
      insert into public.menu_recipe_line (recipe_id, sort, stage, product_id, item_name, qty, unit, factor)
           values (v_recipe, 3, 'pack', v_lid, 'Lid', 1, 'each', 1);
    end if;
    if v_straw is not null then
      insert into public.menu_recipe_line (recipe_id, sort, stage, product_id, item_name, qty, unit, factor)
           values (v_recipe, 4, 'pack', v_straw, 'Straw', 1, 'each', 1);
    end if;
  end loop;
end $$;

select r.name, l.sort, l.stage, l.item_name, l.qty, l.unit,
       jsonb_array_length(coalesce(l.options,'[]'::jsonb)) as choices
from   public.menu_recipe r join public.menu_recipe_line l using (recipe_id)
where  r.name in ('Fountain Soda — 24 oz','Fountain Soda — 12 oz','Lemonade / Iced Tea — 24 oz')
order  by r.name, l.sort;
