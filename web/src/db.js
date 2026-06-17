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
      " product_location(location_id, is_primary, location(name)), product_barcode(code)",
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
    })),
    barcodes: (p.product_barcode ?? []).map((b) => b.code),
  }));
}

export async function createProduct(p) {
  const { data, error } = await supabase.from("product").insert({
    domain: p.domain ?? "fnb", name: p.name, category: p.category, brand: p.brand, supc: p.supc,
    purchase_unit: p.purchase_unit, pack: p.pack, size: p.size, size_unit: p.size_unit,
    count_unit: p.count_unit, count_per_case: p.count_per_case,
    use_unit: p.use_unit, use_per_count: p.use_per_count, par_level: p.par_level,
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
      product_id: id, location_id: l.location_id, is_primary: l.primary,
    })));
  return id;
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
    cases: e.cases || 0, loose: e.loose || 0,
    qty: (Number(e.cases) || 0) * (Number(e.count_per_case) || 1) + (Number(e.loose) || 0),
    counted_by: me,
  }));
  const { error } = await supabase.from("stock_count").insert(rows);
  if (error) throw error;
  return rows.length;
}

// ---- Scan lookup / barcode learning ----
export async function lookupBarcode(code) {
  const byCode = await supabase.from("product_barcode")
    .select("product:product_id(product_id,name,count_unit)").eq("code", code).maybeSingle();
  if (byCode.data?.product) return byCode.data.product;
  const bySupc = await supabase.from("product")
    .select("product_id,name,count_unit").eq("supc", code).maybeSingle();
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

// ---- Reports ----
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

// ---- Shopping ----
export async function getShopping(domain = "fnb") {
  const { data: list } = await supabase.from("shopping_list")
    .select("shopping_list_id").eq("domain", domain).eq("status", "open")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!list) return { id: null, lines: [] };
  const { data: lines } = await supabase.from("shopping_line")
    .select("product_id, vendor_id, qty").eq("shopping_list_id", list.shopping_list_id);
  return { id: list.shopping_list_id, lines: lines ?? [] };
}
export async function saveShopping(lines, domain = "fnb") {
  let { data: list } = await supabase.from("shopping_list")
    .select("shopping_list_id").eq("domain", domain).eq("status", "open")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!list) {
    const ins = await supabase.from("shopping_list").insert({ domain }).select("shopping_list_id").single();
    list = ins.data;
  }
  await supabase.from("shopping_line").delete().eq("shopping_list_id", list.shopping_list_id);
  if (lines.length)
    await supabase.from("shopping_line").insert(lines.map((l) => ({
      shopping_list_id: list.shopping_list_id, product_id: l.product_id, vendor_id: l.vendor_id, qty: l.qty,
    })));
  return list.shopping_list_id;
}
