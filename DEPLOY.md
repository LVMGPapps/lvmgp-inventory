# Shipping LVMGP Inventory — step by step

Stack: **Supabase** (database + login gate + OCR function) · **GitHub** (repo) ·
**Cloudflare Pages** (hosts the app at inventory.lvmgp.com). Render isn't needed
for v1. Plan on ~1–2 hours end to end.

---

## 1. GitHub — put the code in a repo
1. Create a private repo, e.g. `lvmgp-inventory`.
2. Copy this whole folder into it. Then add the actual app screen:
   - Copy your prototype `ProductManager.jsx` into `web/src/ProductManager.jsx`.
   - In it, replace the `window.storage` calls with the `db` functions
     (see the mapping in section 7). Import at top: `import * as db from "./db";`
3. Commit and push.

## 2. Supabase — create the project + database
1. supabase.com → New project (pick a region near Vegas, e.g. West US). Save the
   database password.
2. Project → **SQL Editor** → paste all of `schema_postgres.sql` → Run. This
   creates the tables, the on-hand views, Row Level Security, and seeds your nine
   locations + five vendors.
3. Project → **Settings → API**. Copy the **Project URL** and the **anon public**
   key — you'll need both for the frontend.

## 3. Supabase Auth — the login gate (this is the "no one else gets in" part)
1. **Authentication → Providers → Email**: make sure Email is enabled.
2. **Authentication → Sign In / Providers (or Settings)**: turn **"Allow new
   users to sign up" OFF**. Now the only people who can ever log in are ones you
   invite. The login screen uses passwordless email links and refuses any address
   that isn't already a user.
3. **Authentication → URL Configuration**: set **Site URL** to
   `https://inventory.lvmgp.com` and add it to Redirect URLs (add
   `http://localhost:5173` too for local dev).
4. **Authentication → Users → Invite user**: invite yourself first (and the rest
   of the team later). They'll get an email to set up access.

## 4. Supabase Edge Function — receipt/label OCR
The OCR holds your Anthropic key, so it lives server-side here, not in the browser.
```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF      # ref is in your project URL
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...  # your own key
supabase functions deploy ocr                      # deploys supabase/functions/ocr
```

## 5. Frontend — install & run locally first
```bash
cd web
npm install
cp .env.local.example .env.local     # fill in the URL + anon key from step 2
npm run dev                          # http://localhost:5173
```
Sign in with the email you invited — you should land in the app, talking to the
real database.

## 6. Cloudflare Pages — deploy + your domain
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** →
   pick the repo.
2. Build settings:
   - Framework preset: **Vite**
   - Root directory: `web`
   - Build command: `npm run build`
   - Build output directory: `dist`
3. **Environment variables** (Production *and* Preview): add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Deploy. You'll get a `*.pages.dev` URL — confirm login works there.
5. **Custom domains → Set up a custom domain → `inventory.lvmgp.com`**. Because
   lvmgp.com is already on Cloudflare, the DNS record is added for you; it's live
   in a minute or two.
6. Go back to Supabase → Auth → URL Configuration and confirm the Site/Redirect
   URLs point at `https://inventory.lvmgp.com`.

## 7. Wire the prototype to the database (storage → db)
In `ProductManager.jsx`, swap each storage call for its `db` equivalent (all
return Promises, so `await` them inside your effects/handlers):

| Prototype (window.storage) | Replace with |
|---|---|
| load catalog | `await db.getCatalog()` |
| save new product | `await db.createProduct(p)` |
| delete product | `await db.deleteProduct(id)` |
| load/add locations | `await db.listLocations()` / `db.addLocation(name)` |
| vendors | `await db.listVendors()` |
| save counts | `await db.postCounts(entries)`  *(include `count_per_case` per entry)* |
| barcode scan lookup | `await db.lookupBarcode(code)` |
| learn a barcode | `await db.linkBarcode(productId, code)` |
| receipt photo | `await db.scanReceipt(file)` → review → `await db.postReceipt(header, lines)` |
| on-hand by location report | `await db.onHandByLocation()` |
| shopping list | `await db.getShopping()` / `db.saveShopping(lines)` |

Drop the in-artifact `window.storage` block and the seeded sample data. Add a
small "Sign out" button somewhere using `import { signOut } from "./AuthGate"`.

## 8. Load your real catalog
Two ways, once units/pars are settled in the kitchen session:
- **By hand / scan** in the app (good for ongoing additions).
- **Bulk:** in Supabase SQL Editor, import your spreadsheet via Table editor →
  `product` → Import CSV (map columns to name, category, brand, supc,
  count_unit, count_per_case, use_unit, use_per_count, par_level, etc.), then add
  vendor prices and locations. Ask me for a ready-made CSV template matching the
  columns and I'll generate it.

## Done = shippable
Logged-in-only app at inventory.lvmgp.com, real Postgres behind it, counting by
location, receipt OCR. Next up (not blockers): usage + weighted shopping
suggestions once a few weeks of counts exist, and per-user roles if you want
counter-vs-manager separation.
