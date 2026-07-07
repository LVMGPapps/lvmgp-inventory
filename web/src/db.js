// Data layer: everything the app used to do via window.storage now goes here.
// Swap calls in ProductManager.jsx, e.g. window.storage.get('catalog') -> db.getCatalog().
import { supabase } from "./supabase";

async function uid() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

// ---- Catalog ----
export async function getCatalog(domain = "fnb") {
  const { data, error } = await supabase
    .from("product")
    .select(
      "*, product_vendor(vendor_id, current_price, is_primary, vendor(name))," +
      " product_location(location_id, is_primary, storage_unit_id, location(name), storage_unit(code, sort_order))," +
      " product_barcode(code)",
    )
    .eq("domain", domain)
    .eq("active", true)
    .order("category")
    .order("name");
  if (error) throw error;
  // flatten embedded names so the UI shape matches the prototype
  return (data ?? []).map((p) => ({
    ...p,
    vendors: (p.product_vendor ?? []).map((v) => ({
      vendor_id: v.vendor_id, name: v.vendor?.name, price: v.current_price, primary: v.is_primary,
    })),
    locations: (p.product_location ?? []).map((l) => ({
      location_id: l.location_id, name: l.location?.name, primary: l.is_primary,
      unit_id: l.storage_unit_id, unit_code: l.storage_unit?.code ?? null, unit_sort: l.storage_unit?.sort_order ?? null,
    })),
    barcodes: (p.product_barcode ?? []).map((b) => b.code),
  }));
}

export async function createProduct(p) {
  const upc = (Number(p.units_per_package) || 1) * (Number(p.packages_per_case) || 1) || 1;
  const { data, error } = await supabase.from("product").insert({
    domain: p.domain ?? "fnb", name: p.name, category: p.category, brand: p.brand, supc: p.supc,
    purchase_unit: p.purchase_unit, pack: p.pack, size: p.size, size_unit: p.size_unit,
    count_unit: p.unit_name || p.count_unit, count_per_case: upc,
    unit_name: p.unit_name || p.count_unit || "unit",
    units_per_package: Number(p.units_per_package) || 1,
    packages_per_case: Number(p.packages_per_case) || 1,
    buy_by: p.buy_by || "case",
    use_unit: p.use_unit, use_per_count: p.use_per_count, par_level: p.par_level, image_url: p.image_url ?? null,
    backup_for: p.backup_for ?? null,
  }).select("product_id").single();
  if (error) throw error;
  const id = data.product_id;
  if (p.barcodes?.length)
    await supabase.from("product_barcode").insert(p.barcodes.map((c) => ({ product_id: id, code: c })));
  if (p.vendors?.length)
    await supabase.from("product_vendor").insert(p.vendors.map((v) => ({
      product_id: id, vendor_id: v.vendor_id, current_price: v.price, is_primary: v.primary,
    })));
  if (p.locations?.length)
    await supabase.from("product_location").insert(p.locations.map((l) => ({
      product_id: id, location_id: l.location_id, is_primary: l.primary, storage_unit_id: l.unit_id ?? null,
    })));
  return id;
}

export async function updateProduct(p) {
  const id = p.product_id;
  const upc = (Number(p.units_per_package) || 1) * (Number(p.packages_per_case) || 1) || 1;
  const { error } = await supabase.from("product").update({
    name: p.name, category: p.category, brand: p.brand, supc: p.supc,
    purchase_unit: p.purchase_unit, pack: p.pack, size: p.size, size_unit: p.size_unit,
    count_unit: p.unit_name || p.count_unit, count_per_case: upc,
    unit_name: p.unit_name || p.count_unit || "unit",
    units_per_package: Number(p.units_per_package) || 1,
    packages_per_case: Number(p.packages_per_case) || 1,
    buy_by: p.buy_by || "case",
    use_unit: p.use_unit, use_per_count: p.use_per_count, par_level: p.par_level, image_url: p.image_url ?? null,
    backup_for: p.backup_for ?? null,
    updated_at: new Date().toISOString(),
  }).eq("product_id", id);
  if (error) throw error;
  await supabase.from("product_barcode").delete().eq("product_id", id);
  await supabase.from("product_vendor").delete().eq("product_id", id);
  await supabase.from("product_location").delete().eq("product_id", id);
  if (p.barcodes?.length)
    await supabase.from("product_barcode").insert(p.barcodes.map((c) => ({ product_id: id, code: c })));
  if (p.vendors?.length)
    await supabase.from("product_vendor").insert(p.vendors.map((v) => ({
      product_id: id, vendor_id: v.vendor_id, current_price: v.price, is_primary: v.primary,
    })));
  if (p.locations?.length)
    await supabase.from("product_location").insert(p.locations.map((l) => ({
      product_id: id, location_id: l.location_id, is_primary: l.primary, storage_unit_id: l.unit_id ?? null,
    })));
  return id;
}

// ---- Current user + in-app user management (direct DB functions, no edge function) ----
export async function currentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}
export async function listUsers() {
  const { data, error } = await supabase.rpc("admin_list_users");
  if (error) throw new Error(error.message);
  return (data || []).map((u) => ({ id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at, confirmed: true }));
}
export async function createUser(email, password) {
  const { error } = await supabase.rpc("admin_create_user", { p_email: email, p_password: password });
  if (error) throw new Error(error.message);
}
export async function setUserPassword(email, password) {
  const { error } = await supabase.rpc("admin_set_password", { p_email: email, p_password: password });
  if (error) throw new Error(error.message);
}
export async function deleteUser(email) {
  const { error } = await supabase.rpc("admin_delete_user", { p_email: email });
  if (error) throw new Error(error.message);
}

// ---- Product photos (Supabase Storage) ----
export async function uploadProductImage(file, productId) {
  const ext = (String(file.name || "").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${productId || "new"}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("product-photos")
    .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (error) throw error;
  const { data } = supabase.storage.from("product-photos").getPublicUrl(path);
  return data.publicUrl;
}

// ---- Storage units (shelves/bins inside a location) ----
export async function listStorageUnits() {
  const { data, error } = await supabase.from("storage_unit")
    .select("storage_unit_id, location_id, code, sort_order").order("location_id").order("sort_order");
  if (error) throw error;
  return data ?? [];
}
export async function addStorageUnit(location_id, code, sort_order = 999) {
  const { data, error } = await supabase.from("storage_unit")
    .insert({ location_id, code, sort_order }).select("storage_unit_id").single();
  if (error) throw error;
  return data.storage_unit_id;
}

export async function deleteProduct(id) {
  const { error } = await supabase.from("product").update({ active: false }).eq("product_id", id);
  if (error) throw error;
}

// ---- Locations / vendors ----
export async function listLocations() {
  const { data, error } = await supabase.from("location").select("*").eq("active", true).order("sort_order");
  if (error) throw error;
  return data;
}
export async function addLocation(name) {
  const { error } = await supabase.from("location").insert({ name });
  if (error) throw error;
}
export async function listVendors() {
  const { data, error } = await supabase.from("vendor").select("*").eq("active", true).order("name");
  if (error) throw error;
  return data;
}

// ---- Counts (per-location partials) ----
export async function postCounts(entries) {
  const me = await uid();
  const rows = entries.map((e) => ({
    product_id: e.product_id, location_id: e.location_id,
    cases: Number(e.cases) || 0, loose: Number(e.loose) || 0,
    qty: e.qty != null ? Number(e.qty) : (Number(e.cases) || 0) * (Number(e.count_per_case) || 1) + (Number(e.loose) || 0),
    counted_by: me,
  }));
  const { error } = await supabase.from("stock_count").insert(rows);
  if (error) throw error;
  return rows.length;
}

// ---- Edit / fix individual counts ----
export async function getItemCounts(productId, days = 200) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await supabase.from("stock_count")
    .select("stock_count_id, location_id, counted_at, cases, loose, qty, location(name)")
    .eq("product_id", productId).gte("counted_at", since)
    .order("counted_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, location_name: r.location?.name }));
}
export async function updateCount(id, fields) {
  const { error } = await supabase.from("stock_count").update(fields).eq("stock_count_id", id);
  if (error) throw error;
}
export async function deleteCount(id) {
  const { error } = await supabase.from("stock_count").delete().eq("stock_count_id", id);
  if (error) throw error;
}

// ---- Scan lookup / barcode learning ----
export async function lookupBarcode(code) {
  const c = String(code).trim();
  const bc = await supabase.from("product_barcode").select("product_id").eq("code", c).limit(1).maybeSingle();
  if (bc.data?.product_id) {
    const p = await supabase.from("product").select("product_id,name,count_unit").eq("product_id", bc.data.product_id).maybeSingle();
    if (p.data) return p.data;
  }
  const bySupc = await supabase.from("product").select("product_id,name,count_unit").eq("supc", c).limit(1).maybeSingle();
  return bySupc.data ?? null;
}
export async function linkBarcode(productId, code) {
  const { error } = await supabase.from("product_barcode").insert({ product_id: productId, code });
  if (error) throw error;
}

// ---- Receiving (+ OCR via edge function) ----
export async function scanReceipt(file, kind = "receipt") {
  const image = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("read"));
    r.readAsDataURL(file);
  });
  const { data, error } = await supabase.functions.invoke("ocr", {
    body: { image, media_type: file.type || "image/jpeg", kind },
  });
  if (error) throw error;
  return data;
}

export async function postReceipt(header, lines) {
  const me = await uid();
  const { data: r, error } = await supabase.from("receipt").insert({
    vendor_id: header.vendor_id, received_date: header.received_date,
    reference: header.reference, entered_by: me,
  }).select("receipt_id").single();
  if (error) throw error;
  for (const ln of lines) {
    const qcu = (Number(ln.purchase_qty) || 0) * (Number(ln.count_per_case) || 1);
    await supabase.from("receipt_line").insert({
      receipt_id: r.receipt_id, product_id: ln.product_id, location_id: ln.location_id,
      purchase_qty: ln.purchase_qty, unit_cost: ln.unit_cost, qty_count_units: qcu,
    });
    if (ln.unit_cost != null && header.vendor_id != null) {
      await supabase.from("product_vendor").upsert(
        { product_id: ln.product_id, vendor_id: header.vendor_id, current_price: ln.unit_cost },
        { onConflict: "product_id,vendor_id" },
      );
      await supabase.from("price_history").insert({
        product_id: ln.product_id, vendor_id: header.vendor_id, price: ln.unit_cost, source: "receipt",
      });
    }
  }
  return r.receipt_id;
}

// ---- Reports / dashboard ----
export async function getReceipts(days = 120) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const { data, error } = await supabase.from("receipt")
    .select("receipt_id, vendor_id, received_date, vendor(name)," +
      " receipt_line(product_id, purchase_qty, unit_cost, qty_count_units)")
    .gte("received_date", since).order("received_date", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
export async function getCounts(days = 120) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await supabase.from("stock_count")
    .select("product_id, location_id, qty, counted_at").gte("counted_at", since)
    .order("counted_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
export async function shoppingCounts(domain = "fnb") {
  const listId = await ensureOpenList(domain);
  const { data } = await supabase.from("shopping_line")
    .select("status").eq("shopping_list_id", listId).neq("status", "received");
  const open = (data ?? []).filter((l) => l.status === "open").length;
  const purchased = (data ?? []).filter((l) => l.status === "purchased").length;
  return { open, purchased };
}

export async function onHandByLocation() {
  const { data, error } = await supabase.from("v_on_hand_by_location")
    .select("product_id, location_id, qty, counted_at");
  if (error) throw error;
  return data;
}
export async function onHand() {
  const { data, error } = await supabase.from("v_on_hand").select("product_id, on_hand");
  if (error) throw error;
  return data;
}

// ---- Shopping (open -> purchased -> received) ----
export async function ensureOpenList(domain = "fnb") {
  let { data: list } = await supabase.from("shopping_list")
    .select("shopping_list_id").eq("domain", domain).eq("status", "open")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!list) {
    const ins = await supabase.from("shopping_list").insert({ domain }).select("shopping_list_id").single();
    if (ins.error) throw ins.error;
    list = ins.data;
  }
  return list.shopping_list_id;
}

// Returns the working list and its open + purchased lines (received are hidden here).
export async function getShopping(domain = "fnb") {
  const listId = await ensureOpenList(domain);
  const { data, error } = await supabase.from("shopping_line")
    .select("shopping_line_id, product_id, vendor_id, qty, unit_cost, status, order_unit")
    .eq("shopping_list_id", listId).neq("status", "received")
    .order("shopping_line_id");
  if (error) throw error;
  return { id: listId, lines: data ?? [] };
}

export async function addShoppingLine(listId, line) {
  const { data, error } = await supabase.from("shopping_line").insert({
    shopping_list_id: listId, product_id: line.product_id, vendor_id: line.vendor_id ?? null,
    qty: line.qty ?? 1, unit_cost: line.unit_cost ?? null, order_unit: line.order_unit ?? "case", status: "open",
  }).select("shopping_line_id").single();
  if (error) throw error;
  return data.shopping_line_id;
}
export async function updateShoppingLine(lineId, patch) {
  const { error } = await supabase.from("shopping_line").update(patch).eq("shopping_line_id", lineId);
  if (error) throw error;
}
export async function removeShoppingLine(lineId) {
  const { error } = await supabase.from("shopping_line").delete().eq("shopping_line_id", lineId);
  if (error) throw error;
}
// Bulk move all lines for one vendor (vendorId may be null) from one status to another.
export async function setVendorStatus(listId, vendorId, toStatus, fromStatus) {
  let q = supabase.from("shopping_line").update({ status: toStatus }).eq("shopping_list_id", listId);
  q = vendorId == null ? q.is("vendor_id", null) : q.eq("vendor_id", vendorId);
  if (fromStatus) q = q.eq("status", fromStatus);
  const { error } = await q;
  if (error) throw error;
}

// Purchased lines waiting to be received, with product + vendor detail for the Receive tab.
export async function getReceivables(domain = "fnb") {
  const listId = await ensureOpenList(domain);
  const { data, error } = await supabase.from("shopping_line")
    .select("shopping_line_id, product_id, vendor_id, qty, unit_cost, status, order_unit," +
      " product(name, count_per_case, count_unit, unit_name, units_per_package, packages_per_case, buy_by, purchase_unit, product_vendor(vendor_id, current_price))," +
      " vendor(name)")
    .eq("shopping_list_id", listId).eq("status", "purchased").order("shopping_line_id");
  if (error) throw error;
  return (data ?? []).map((l) => {
    const pv = (l.product?.product_vendor ?? []).find((v) => v.vendor_id === l.vendor_id);
    return {
      shopping_line_id: l.shopping_line_id, product_id: l.product_id, vendor_id: l.vendor_id,
      qty: l.qty, unit_cost: l.unit_cost ?? pv?.current_price ?? null, order_unit: l.order_unit || l.product?.buy_by || "case",
      product_name: l.product?.name, count_per_case: l.product?.count_per_case,
      units_per_package: l.product?.units_per_package || 1, packages_per_case: l.product?.packages_per_case || 1,
      count_unit: l.product?.unit_name || l.product?.count_unit, unit_name: l.product?.unit_name, buy_by: l.product?.buy_by,
      purchase_unit: l.product?.purchase_unit, vendor_name: l.vendor?.name,
    };
  });
}

// Recent deliveries — list, re-date, edit line qty/cost, delete.
export async function listRecentReceipts(days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const { data, error } = await supabase.from("receipt")
    .select("receipt_id, received_date, vendor_id, vendor(name), receipt_line(receipt_line_id, product_id, purchase_qty, qty_count_units, unit_cost, product(name, count_per_case))")
    .gte("received_date", since)
    .order("received_date", { ascending: false }).order("receipt_id", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    receipt_id: r.receipt_id, received_date: r.received_date, vendor_name: r.vendor?.name,
    lines: (r.receipt_line || []).map((l) => ({
      receipt_line_id: l.receipt_line_id, product_name: l.product?.name, count_per_case: l.product?.count_per_case,
      purchase_qty: l.purchase_qty, qty_count_units: l.qty_count_units, unit_cost: l.unit_cost,
    })),
  }));
}
export async function updateReceiptDate(receipt_id, received_date) {
  const { error } = await supabase.from("receipt").update({ received_date }).eq("receipt_id", receipt_id);
  if (error) throw error;
}
export async function updateReceiptLine(receipt_line_id, fields) {
  const { error } = await supabase.from("receipt_line").update(fields).eq("receipt_line_id", receipt_line_id);
  if (error) throw error;
}
export async function deleteReceipt(receipt_id) {
  await supabase.from("receipt_line").delete().eq("receipt_id", receipt_id);
  const { error } = await supabase.from("receipt").delete().eq("receipt_id", receipt_id);
  if (error) throw error;
}

// Receive a set of rows: writes a receipt per vendor, updates price, marks lines received.
// rows: [{shopping_line_id?, product_id, vendor_id, qty, unit_cost, count_per_case}]
export async function receiveRows(rows, received_date) {
  const me = await uid();
  const date = received_date || new Date().toISOString().slice(0, 10);
  const byVendor = {};
  for (const r of rows) (byVendor[r.vendor_id ?? "none"] ||= []).push(r);
  for (const key of Object.keys(byVendor)) {
    const group = byVendor[key];
    const vendor_id = group[0].vendor_id ?? null;
    const { data: rec, error } = await supabase.from("receipt").insert({
      vendor_id, received_date: date, entered_by: me,
    }).select("receipt_id").single();
    if (error) throw error;
    for (const ln of group) {
      const upc = Number(ln.count_per_case) || 1;         // units per case
      const upp = Number(ln.units_per_package) || 1;      // units per package
      const ou = ln.order_unit || "case";
      const factor = ou === "case" ? upc : ou === "package" ? upp : 1;   // units per ordered unit
      const qcu = (Number(ln.qty) || 0) * factor;                        // count units received
      // entered price is per the ordered unit; convert to a per-CASE price for the catalog
      const casePrice = ln.unit_cost == null ? null
        : ou === "case" ? Number(ln.unit_cost)
        : ou === "package" ? Number(ln.unit_cost) * (upc / upp)
        : Number(ln.unit_cost) * upc;
      await supabase.from("receipt_line").insert({
        receipt_id: rec.receipt_id, product_id: ln.product_id, location_id: null,
        purchase_qty: ln.qty, unit_cost: ln.unit_cost, qty_count_units: qcu,
      });
      if (casePrice != null && vendor_id != null) {
        await supabase.from("product_vendor").upsert(
          { product_id: ln.product_id, vendor_id, current_price: casePrice },
          { onConflict: "product_id,vendor_id" });
        await supabase.from("price_history").insert({
          product_id: ln.product_id, vendor_id, price: casePrice, source: "receipt" });
      }
      if (ln.shopping_line_id) {
        await supabase.from("shopping_line")
          .update({ status: "received", received_at: new Date().toISOString(), qty: ln.qty, unit_cost: ln.unit_cost })
          .eq("shopping_line_id", ln.shopping_line_id);
      }
    }
  }
}
