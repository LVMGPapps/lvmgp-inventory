-- Items with interchangeable purchase options (SKUs). Run BEFORE deploying this branch:
-- the app now saves product.count_by_sku.
alter table product add column if not exists count_by_sku boolean not null default false;

-- Gatorade: one item, flavors are its purchase options, counted per flavor
update product set name = 'Gatorade 20 oz', count_by_sku = true, usage_measure = 'each', count_unit = 'each' where product_id = 66;
update product set backup_for = 66, usage_measure = 'each', count_unit = 'each' where product_id in (67,68,69,179,215);

-- Pizza Cheese: Costco is bought as Premium Pizza Blend (173), not as Pizza Cheese itself
delete from product_vendor where product_id = 11 and vendor_id = 2;
-- Premium Pizza Blend's Costco row said 6 lb per bag; bags are 5 lb
update product_vendor set usage_per_package = 5, package_unit = 'bag' where product_id = 173 and vendor_id = 2;
update product set package_unit = 'bag' where product_id = 173;
-- Re-state the 5 deliveries (8/29–10/17) recorded at 6 lb per bag
update receipt_line set qty_count_units = purchase_qty * 5 where product_id = 173 and qty_count_units = purchase_qty * 6;
