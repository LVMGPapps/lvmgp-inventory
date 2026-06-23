-- FIX: on-hand must be the LATEST count per item+location, not the sum of all counts.
-- Each time you count a location, that count becomes the new on-hand for that spot;
-- it does NOT add to last week's count. Total on-hand = sum of the latest count across locations.
-- Usage is then computed separately as: prior count + received between - current count.

create or replace view public.v_on_hand_by_location
  with (security_invoker = on) as
  select distinct on (product_id, location_id)
         product_id, location_id, qty, counted_at
  from public.stock_count
  order by product_id, location_id, counted_at desc;

create or replace view public.v_on_hand
  with (security_invoker = on) as
  select product_id, sum(qty) as on_hand
  from public.v_on_hand_by_location
  group by product_id;
