// Supabase Edge Function: receipt / product-label OCR for the LVMGP inventory app.
// Called by db.scanReceipt() as supabase.functions.invoke("ocr").
// Holds ANTHROPIC_API_KEY server-side (Edge Function secret); the browser never sees it.
// Deployed as "ocr" (an older copy lived under the dashboard's default name "quick-api").

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("OCR_MODEL") ?? "claude-sonnet-5-5";

const RECEIPT_PROMPT =
  "Read this supplier receipt or invoice (often Costco, Sysco, Amazon or Pepsi). " +
  "Costco receipts abbreviate item names (e.g. 'KS TORT CHIP' = Kirkland Signature tortilla chips, 'BR CHSE BL' = a cheese blend) — expand them into a plain product name. " +
  "A line like '12 @ 11.49' printed above an item means qty 12 at 11.49 each. " +
  "Skip subtotal, tax, total and payment lines. A discount line (e.g. '0000396652 / 242668  10.00-') is an instant savings on the item number after the slash: " +
  "subtract it from that item's unit_price instead of listing it. " +
  "qty is the number of units bought; unit_price is the price of ONE unit after instant savings. " +
  "List every item line, including non-food items.";

const RECEIPT_SHAPE =
  'Return ONLY JSON, no markdown: {"vendor":string,"date":"YYYY-MM-DD" or "",' +
  '"lines":[{"name":string,"raw":string (text as printed),"item_no":string or "","qty":number,"unit_price":number or null,"product_id":number or null}]}';

const PRODUCT_PROMPT =
  "Identify the single food-service product shown. Return ONLY JSON, no markdown: " +
  '{"name":string,"brand":string,"supc":string,' +
  '"barcode":string (digits if clearly readable else ""),"category":string,' +
  '"pack":number,"size":number,"size_unit":string,"unit_price":number or null}';

type Cand = { id: number; name: string; brand?: string; sku?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY secret is not set on this Supabase project" }, 500);
    const { image, media_type = "image/jpeg", kind = "receipt", candidates } = await req.json();
    if (!image) return json({ error: "missing image" }, 400);

    let prompt = PRODUCT_PROMPT;
    if (kind !== "product") {
      prompt = RECEIPT_PROMPT;
      if (Array.isArray(candidates) && candidates.length) {
        const list = (candidates as Cand[]).slice(0, 600)
          .map((c) => `${c.id} | ${c.name}${c.brand ? " | " + c.brand : ""}${c.sku ? " | item# " + c.sku : ""}`).join("\n");
        prompt += "\n\nThese are the items in the buyer's inventory app (id | name | brand | vendor item#). " +
          "For each receipt line set product_id to the id of the inventory item it is, if you are reasonably sure " +
          "(e.g. 'DAWN BUCKET' = Dish Soap, 'TORT ROUNDS' = Tortilla Chips, 'BR CHSE BL' = a pizza cheese blend, 'KS FRNCH FRY' = French Fries). " +
          "A matching vendor item# is a certain match. Otherwise null.\n" + list;
      }
      prompt += "\n\n" + RECEIPT_SHAPE;
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type, data: image } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return json({ error: `Anthropic API ${resp.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}` }, 502);
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "model did not return JSON", text: text.slice(0, 300) }, 502);
    return json(JSON.parse(m[0]), 200);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}
