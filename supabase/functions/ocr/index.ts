// Supabase Edge Function: receipt / product-label OCR.
// Holds ANTHROPIC_API_KEY server-side; the browser never sees it.
// Deploy:  supabase functions deploy ocr
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-4-6";

const RECEIPT_PROMPT =
  'Read this supplier receipt or invoice. Return ONLY JSON, no markdown: ' +
  '{"vendor":string,"date":"YYYY-MM-DD" or "",' +
  '"lines":[{"name":string,"qty":number,"unit_price":number or null}]}';

const PRODUCT_PROMPT =
  'Identify the single food-service product shown. Return ONLY JSON, no markdown: ' +
  '{"name":string,"brand":string,"supc":string,' +
  '"barcode":string (digits if clearly readable else ""),"category":string,' +
  '"pack":number,"size":number,"size_unit":string,"unit_price":number or null}';

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { image, media_type = "image/jpeg", kind = "receipt" } = await req.json();
    if (!image) return json({ error: "missing image" }, 400);

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type, data: image } },
            { type: "text", text: kind === "product" ? PRODUCT_PROMPT : RECEIPT_PROMPT },
          ],
        }],
      }),
    });

    const data = await resp.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return json(parsed, 200);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
