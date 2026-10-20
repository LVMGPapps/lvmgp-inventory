"""
LVMGP nightly sales sync  —  Parafait (READ-ONLY)  ->  LVMGP Inventory app

Every night this:
  1. reads the last few days of closed POS sales from Parafait (SELECT only — nothing in
     Parafait is ever changed; no customer names, cards or payments are read),
  2. downloads the current recipes from the inventory app,
  3. works out how much of each inventory item those sales should have used,
  4. sends both (per hour) to the inventory app, where the "Sales & usage" report reads them.

Re-sending a day is safe: the newest upload for a day replaces the older one in the report.

First time (PowerShell, in the folder this file is in):
    python lvmgp_sales_sync.py --setup        # asks for the passwords/keys once, saves them next to this file
    python lvmgp_sales_sync.py --days 120     # back-fill the last 120 days
    python lvmgp_sales_sync.py --install      # schedule it nightly at 3:15 am (Windows Task Scheduler)

After that it runs on its own. Manual run any time:
    python lvmgp_sales_sync.py                # today + the 2 days before
    python lvmgp_sales_sync.py --from 2026-10-01 --to 2026-10-19
"""
import argparse, collections, configparser, getpass, json, os, subprocess, sys, urllib.request, urllib.error
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "lvmgp_sales_sync.ini")
LOG_PATH = os.path.join(HERE, "lvmgp_sales_sync.log")
SERVER = r"PRIMARYSERVER\SQLEXPRESS"
SQL_USER = "Parafaitreadonly"
SUPABASE_URL = "https://drfhuwmsmuikvewmupfx.supabase.co"
SUPABASE_ANON = "sb_publishable_l8dhIKBmJOeOrEcV6UywHg_MmtuuCPo"


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass

# ---------------------------------------------------------------------------
# POS item -> what it is in the inventory app
# (match type, app name, app recipe/product id, confidence, note)
# ---------------------------------------------------------------------------
R='Recipe'; S='Resale item'; T='Pizza topping'; W='Wing sauce/flavor'; F='Fountain flavor'; I='ICEE flavor'; C='Condiment / add-on'
N='Needs a recipe'; X='Not tracked (no inventory)'; B='Combo — parts counted separately'; O='Not food'
M={
# pizza
244:(R,'Cheese Pizza - Large',4,'Sure',''),1834:(R,'Cheese Pizza - Large',4,'Sure','Older duplicate item'),1689:(R,'Cheese Pizza - Large',4,'Sure','Party-package pizza'),
1710:(R,'Cheese Pizza - Large + topping',4,'Sure','Topping comes from the linked modifier line'),1547:(R,'Cheese Pizza - Large + topping',4,'Sure','Older 1-topping item'),
1886:(R,'Cheese Pizza - Large + topping',4,'Sure','Promo 1-topping'),1688:(R,'Cheese Pizza - Large + toppings',4,'Sure','Toppings from linked modifier lines'),
1692:(R,'Cheese Pizza - Large + toppings',4,'Sure','Toppings from linked modifier lines'),
268:(R,'Kids Cheese Pizza Base + toppings',7,'Sure','Toppings use kids portions'),161:(R,'Kids Cheese Pizza Base',7,'Sure','Older kids item (party packages)'),
1891:(R,'Kids Cheese Pizza Base',7,'Check','Promo Personal Pizza — confirm it is the kids size'),1669:(R,'Kids Cheese Pizza Base',7,'Check','3rd-party pass pizza — confirm size'),
175:(R,'All You Can Meat - Large (Meat Lovers)',1,'Sure',''),561:(R,'BBQ Chicken Pizza - Large',2,'Sure',''),177:(R,'Buffalo Chicken Pizza - Large',3,'Sure','App price $22.49 vs POS $24.99'),
1504:(R,'Gran Prix Pizza (Supreme) - Large',5,'Sure','Now deactivated on POS'),170:(R,'Veggie Delight - Large',8,'Sure',''),
167:(R,'Cheesy Bread',30,'Sure','POS renamed to "Cheese Bread", now $11.99; app still $8.99'),169:(R,'Breadsticks (6)',29,'Sure',''),
776:(B,'Family Meal Deal',None,'Sure','Combo — pizza/drinks inside are counted on their own lines'),1890:(B,'Family Fuel Up Feast Combo',None,'Sure','Combo — parts counted on their own lines'),
# apps & snacks
835:(R,'Chicken Nachos',31,'Sure',''),1687:(R,'Chili Cheese Nachos',32,'Sure','Now deactivated on POS'),1684:(R,'Mozzarella Sticks',33,'Sure',''),
773:(R,'Nachos with Cheese',34,'Sure',''),380:(R,'Popcorn',36,'Sure',''),772:(R,'Pretzel Bites with Cheese (12)',37,'Check','App recipe = 12 bites; earlier spec said 8 per order'),
1685:(R,'Quesadilla',38,'Sure',''),
# burgers / dogs / fries / tenders
187:(R,'Hamburger with Fries',19,'Sure','Cheese add-ons come from modifier lines'),639:(R,'Quarter-Mile Dog with Fries',20,'Sure',''),
836:(N,'Chicago Dog',None,'—','No recipe in app'),837:(N,'New Yorker Porker',None,'—','No recipe in app'),838:(N,'Double Porker',None,'—','No recipe in app (2 dogs?)'),
1571:(N,'Chili Cheese Dog',None,'—','No recipe in app; now deactivated on POS'),1693:(N,'Hot Dog (3 standard topping)',None,'—','Old item; 16 sold'),
1686:(N,'Kids hot dog',None,'—','No recipe; app has "Kids/Employee Hot Dog" product #32'),
190:(R,'French Fries',25,'Sure',''),1572:(R,'Chili Cheese Fries',24,'Sure','Now deactivated on POS'),188:(R,'Small Tenders (4) & Fries',28,'Sure',''),
189:(R,'Large Tenders (8) & Fries',27,'Sure',''),568:(R,'Chicken Tenders - Platter (20)',23,'Sure',''),569:(R,'French Fries - Platter',26,'Sure',''),
913:(R,'Hot Dog Platter (10)',21,'Sure',''),1676:(R,'Wings - Platter (24)',16,'Sure','App platter recipe has no wing sauce line'),
# wings
144:(R,'Wings - 8 + sauce',56,'Sure','Sauce from linked modifier line'),145:(R,'Wings - 16 + sauce',58,'Sure','Sauce from linked modifier line'),
1897:(R,'Wings - 10 + LTO flavor',57,'Sure','Flavor from linked modifier line'),
137:(W,'Buffalo (wing sauce)',45,'Sure','Pizza component #45'),138:(W,'BBQ (wing sauce)',21,'Sure','Pizza component #21'),139:(W,'Serious Sauce',23,'Sure','Component #23 → sub-recipe Serious Sauce'),
140:(W,'Plain (no sauce)',None,'Sure','Nothing used'),1898:(W,'Sweet Teriyaki',20,'Sure','LTO "Neon Drift"'),1899:(W,'Sweet Heat Peach',18,'Sure','LTO "Peach Pit"'),
1900:(W,'Mango Habanero',None,'Check','LTO "Burnout" — app has the sauce (#180) but no sauce component'),1901:(W,'Red Thai Chili',22,'Sure','LTO "Fast Lane"'),
1902:(W,'Lemon Pepper',17,'Check','LTO "Night Ride" — Lemon Pepper component not linked to a product'),1903:(W,'Garlic Parmesan',19,'Sure','LTO "Southbound"'),
# dips / sides
141:(C,'Side of Ranch',42,'Sure','Dipping sauce modifier'),1339:(R,'Side of Ranch',42,'Sure','Extra Ranch Cup'),142:(C,'Blue Cheese',None,'—','No product in app; now removed from POS'),
786:(C,'Side of BBQ Sauce',39,'Sure','Fries dipping sauce'),1542:(R,'Side of BBQ Sauce',39,'Sure','Extra BBQ cup'),1543:(R,'Side of Buffalo',40,'Sure','Extra Buffalo cup'),
1340:(R,'Extra cup of nacho cheese',43,'Sure',''),547:(R,'Side of Nacho Cheese',41,'Sure','Cheese Sauce add-on'),549:(N,'Extra Jalapeño Cup',None,'—','No recipe; jalapeños are product #76'),
184:(C,'Ketchup Packets',13,'Check','Fries ketchup — packets or bladder?'),162:(C,'Marinara (dipping)',61,'Check','Breadstick dipping marinara — portion size?'),
# pizza toppings (linked to their pizza)
150:(T,'Pepperoni',1,'Sure',''),151:(T,'Sausage',2,'Sure',''),152:(T,'Ham',3,'Sure',''),153:(T,'Bacon',4,'Sure',''),154:(T,'Chicken',5,'Sure',''),
160:(T,'Pineapple',6,'Sure',''),157:(T,'Green Peppers',7,'Sure',''),156:(T,'Red Onion',8,'Check','POS "Onions" → app Red Onion (also used on hot dogs?)'),
159:(T,'Black Olives',10,'Sure',''),158:(T,'Jalapeños',24,'Sure',''),155:(T,'Mushrooms',None,'—','No mushroom component in app; mushrooms now removed from POS'),
149:(T,'Extra Cheese',12,'Sure',''),147:(T,'Buffalo Sauce (pizza)',15,'Sure',''),148:(T,'Light Cheese',None,'Sure','Ignored (small)'),146:(T,'Extra Sauce',None,'Sure','Ignored (small)'),
143:(T,'Light Sauce',None,'Sure','Ignored (small)'),164:(T,'No Onions',None,'Sure','Removes onions from specialty pizza'),166:(T,'No Black Olives',None,'Sure','Removes olives'),636:(T,'No Chicken',None,'Sure','Removes chicken'),
# burger/dog condiments
178:(C,'American Cheese - Yellow',10,'Sure','Burger add-on'),180:(C,'Swiss-American Cheese',41,'Sure','Burger add-on'),193:(C,'Pizza Cheese (Italian blend)',11,'Check','Burger add-on — portion?'),
194:(C,'Lettuce',None,'Check','Iceberg #60 or Romaine #59?'),195:(C,'Tomatoes',57,'Check','Portion not set'),385:(C,'Mayo',53,'Check','Portion not set'),
185:(C,'Mustard Packets',46,'Check','Packets or bladder?'),839:(C,'Relish',55,'Check','Portion not set'),842:(C,'Sauerkraut',54,'Check','Portion not set'),
191:(C,'Pickles',52,'Check','Portion not set'),844:(C,'Sport Peppers',56,'Check','Portion not set'),787:(C,'Chili',72,'Check','Portion not set'),
841:(C,'No Relish',None,'Sure','Removal'),183:(C,'No Pickle',None,'Sure','Removal'),840:(C,'No Mustard',None,'Sure','Removal'),182:(C,'No Tomato',None,'Sure','Removal'),843:(C,'No Sauer Kraut',None,'Sure','Removal'),
# drinks
227:(R,'Fountain Soda — 20 oz or 24 oz?',76,'Check','"Fountain Drink" $3.99 — which cup? (20 oz and 24 oz recipes both $3.99)'),
1528:(R,'Fountain Beverage - 12 oz',78,'Check','"Small Fountain Drink" — POS price now $3.99'),1887:(R,'Fountain Beverage - 12 oz',78,'Check','Promo Small Drink'),
228:(N,'Fountain Beverage Pitcher',None,'—','No pitcher recipe (oz of syrup per pitcher?)'),
218:(F,'Pepsi 5G BIB',1,'Sure',''),219:(F,'Pepsi Zero/Diet BIB',120,'Sure',''),220:(F,'Mt. Dew 5G BIB',122,'Sure',''),221:(F,'Mug Rootbeer BIB',124,'Sure',''),
642:(F,'Orange Crush BIB',125,'Sure',''),223:(F,'Dr. Pepper BIB',119,'Sure',''),224:(F,'Starry BIB',121,'Sure',''),
222:(F,'Lemonade BIB',123,'Check','Lemonade is not in the fountain recipe\'s syrup options'),1937:(R,'Dirty Soda (add-on)',69,'Sure','"Make It Dirty"'),
215:(N,'ICEE Small',None,'—','No ICEE recipe — cups #155 + lids #157 + flavor'),554:(N,'ICEE Large',None,'—','No ICEE recipe — cups #156 + lids #158 + flavor'),
1160:(I,'Icee Blue Raspberry',152,'Sure',''),1158:(I,'Icee Cherry',153,'Sure',''),1159:(I,'Icee Watermelon',154,'Check','App item is inactive'),
1157:(I,'Icee Green Apple',151,'Check','App item is inactive'),1896:(I,'Icee Strawberry Lemonade',170,'Sure',''),1895:(I,'Icee Pina Colada',175,'Sure',''),1936:(I,'Icee Orange Cream',220,'Sure',''),
915:(R,'Bottle of Water',48,'Sure',''),231:(R,'Bottle of Water',48,'Sure','Second water item'),229:(S,'Gatorade (mixed)',66,'Check','App has 6 Gatorade items — which one is counted?'),
533:(S,'Red Bull',131,'Sure',''),1647:(S,'Large Red Bull',None,'—','No large Red Bull in app'),1300:(S,'Calypso',133,'Sure',''),1956:(S,'Monster Energy (blue)',221,'Sure',''),
779:(N,'Coffee',None,'—','No coffee items in app'),1959:(O,'Drink Tower',None,'—','1 sold'),
# desserts / sweets
225:(R,'Dippin Dots',47,'Check','Recipe line not linked to a product'),213:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),214:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),
216:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),217:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),600:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),
1589:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),560:(C,'Dippin Dots flavor',None,'Sure','Flavor choice'),
1694:(R,'Chocolate Chip Cookies',44,'Sure',''),207:(R,'Cinnamon Sticks',45,'Sure',''),208:(R,'Cinnamon Sticks (large)',45,'Check','Old LG size — 2× the recipe?'),
203:(C,'Extra Icing',None,'Check','Icing product?'),202:(C,'No Icing',None,'Sure','Removal'),
396:(N,'Cotton Candy',None,'—','Floss products #93–96 exist, no recipe'),401:(N,'Cotton Candy Tower',None,'—','No recipe'),1168:(N,'Pucker Powder tube',None,'—','No product in app'),
1196:(N,'Pucker Powder Birthday',None,'—','No product in app'),
859:(S,'Kinder Joy',146,'Sure',''),864:(S,"Peanut M&M's",144,'Check','App has 3 Peanut M&M items'),1444:(S,'SP kids',148,'Check','App has 2 Sour Patch Kids items'),
967:(S,'SP Watermelon',147,'Sure',''),833:(S,'Swedish Fish',200,'Sure',''),994:(S,'KitKat',150,'Sure',''),861:(S,'Melody Pops',196,'Check','POS "Lollipop" → Melody Pops?'),
865:(S,"M&M Plain",None,'—','No plain M&Ms in app'),869:(S,'Skittles',None,'—','No Skittles in app'),1022:(S,"Reese's PB Cup",191,'Sure',''),868:(S,'Twix',145,'Sure',''),
1370:(S,'Butterfinger',198,'Sure',''),860:(S,'Kinder Bueno',186,'Sure',''),866:(S,'Milky Way',199,'Sure',''),1576:(S,'Crunch Bar',193,'Sure',''),
1532:(S,'Hershey with Almonds',195,'Sure',''),957:(S,'Haribo Gummy Bears',189,'Sure',''),1443:(S,'Hersheys',None,'—','No plain Hershey bar in app'),
891:(S,'Giant Chewy Sweetarts',222,'Sure',''),1723:(S,'Sour Haribo Bears',None,'—','Not in app'),1722:(S,'Jarritos Gummy',None,'—','Not in app'),
1531:(S,'100 Grand',201,'Sure',''),867:(S,'Snickers',None,'—','Not in app'),1921:(S,'Whoppers',197,'Sure',''),1739:(S,'Fudge Stripes',None,'—','Not in app'),
993:(S,"King Size Reese's",None,'—','Not in app'),959:(S,'M&M Mini Tubes',202,'Sure',''),1782:(S,'Pickle in a Pouch',214,'Check','App has 2 Pickle in a Pouch items (#214, #223)'),
1888:(N,'Promo Cotton Candy',None,'—','Promo version of Cotton Candy'),1774:(N,'Free Cotton Candy Tower',None,'—','Comp'),
210:(O,'Candy Bars button',None,'Sure','$0 button — real candy rings separately'),
# party / group food
771:(X,'Nothing Bundt Cake cupcakes',None,'—','Bought in for parties'),770:(X,'Nothing Bundt Cake 10"',None,'—','Bought in for parties'),
1416:(N,'Vegetable platter',None,'—','Event item — needs recipe if tracked'),619:(N,'Mixed Fruit',None,'—','Event item — needs recipe if tracked'),
1533:(N,'Party Salad',None,'—','Event item'),1301:(N,'Sandwich Platter',None,'—','Event item'),1822:(N,'Pizza & Salad Bar',None,'—','Group item'),
1557:(N,'Fajita & Burrito Bar',None,'—','Group item'),531:(N,'Salad',None,'—','4 sold'),1727:(N,'Bowl of Dressing',None,'—','3 sold'),1744:(N,'Chips and Guac',None,'—','1 sold'),
1784:(O,'ST $5 food credit',None,'—','Credit, not food'),1771:(O,'Holiday Staff Appreciation Meal',None,'—','Staff meal ($0)'),
# alcohol (not in app)
**{k:(X,'Alcohol — not in inventory app',None,'—','') for k in [539,234,235,540,638,534,1695,1560,1799,1796,1299,1559,1788,1785,1793,1787,1794,1789,1795,1790,1791,1798,1800,1836,929,960,1590,930,1591,233,822,1752,1786,1621]},
856:(B,'Popcorn & 12 oz Beer Bucket',None,'Sure','Combo — beers and popcorn counted on their own lines'),857:(B,'Popcorn & 24 oz Beer Bucket',None,'Sure','Combo — parts counted separately'),
# non-food
965:(O,'Sunscreen',None,'—',''),1061:(O,'Employee Whistle',None,'—',''),1180:(O,'Employee Vest',None,'—',''),610:(O,'Vending Machine Revenue',None,'—',''),
1322:(O,'Skittles Vending Revenue',None,'—',''),1313:(O,'Gumball Machine Revenue',None,'—',''),
}

# ---------------------------------------------------------------------------
# Usage engine: POS lines + app recipes -> inventory used
# ---------------------------------------------------------------------------
LARGE_BASE = {244, 1834, 1689, 1710, 1547, 1886, 1688, 1692, 1972}
KIDS_BASE = {268, 161, 1891, 1669}
SPECIALTY = {175: 1, 561: 2, 177: 3, 1504: 5, 170: 8}
TOPPING = {150: 1, 151: 2, 152: 3, 153: 4, 154: 5, 160: 6, 157: 7, 156: 8, 159: 10, 158: 24}
NO_TOPPING = {164: 8, 166: 10, 636: 5}
EXTRA_CHEESE = 149
PIZZA_BUFFALO = 147
WINGS = {144: (56, '8'), 145: (58, '16'), 1897: (57, '10'), 1676: (16, '24')}
WING_SAUCE = {137: 45, 138: 21, 139: 23}
LTO = {1898: 15, 1899: 14, 1901: 12, 1902: 11, 1903: 9}
LTO_NO_RECIPE = {1900: (180, 3, 'oz')}            # Mango Habanero
FOUNTAIN = {227: 76, 1528: 78, 1887: 78, 228: 80}
FLAVOR = {218: 1, 219: 120, 220: 122, 221: 124, 642: 125, 223: 119, 224: 121, 222: 123, 1980: 128}
ICEE_SIZE = {215: 81, 554: 82}
ICEE_FLAVOR = {1160: 152, 1158: 153, 1159: 154, 1157: 151, 1896: 170, 1895: 175, 1936: 220}
NEWR = {836: 83, 837: 84, 838: 85, 1686: 86, 396: 87, 1888: 87, 401: 88, 1774: 88, 549: 89}
HANDLED_BY_PARENT = set(TOPPING) | set(NO_TOPPING) | {EXTRA_CHEESE, PIZZA_BUFFALO, 148, 146, 143} | set(WING_SAUCE) | {140} \
    | set(LTO) | set(LTO_NO_RECIPE) | set(FLAVOR) | set(ICEE_FLAVOR)


def num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


class Recipes:
    """Live recipe data from the inventory app, in the shapes the engine uses."""
    def __init__(self, data):
        self.recipes = {}
        for r in data["recipes"]:
            self.recipes[r["recipe_id"]] = (r["name"], r["kind"], r["base_recipe_id"], r["sauce_component_id"],
                                            list(r.get("topping_component_ids") or []), num(r["yield_qty"]), r["yield_unit"])
        syrup_recipes = set(FOUNTAIN.values())
        icee_recipes = set(ICEE_SIZE.values())
        self.lines = collections.defaultdict(list)
        for l in data["lines"]:
            name = l.get("item_name") or ""
            if l.get("options") or l.get("role") == "syrup":
                if l["recipe_id"] in syrup_recipes: name = "FOUNTAIN_SYRUP"
                elif l["recipe_id"] in icee_recipes: name = "ICEE_SYRUP"
            self.lines[l["recipe_id"]].append((l["recipe_id"], l["product_id"], num(l["qty"]), l["unit"], num(l["factor"]),
                                               l["sub_recipe_id"], name))
        self.comps = {}
        for c in data["comps"]:
            por = c.get("portions") or None
            if por: por = {str(k): num(v) for k, v in por.items()}
            self.comps[c["component_id"]] = (c["kind"], c["name"], c["product_id"], c["unit"], num(c["factor"]),
                                             num(c["full_qty"]), num(c["kids_qty"]), por, c["sub_recipe_id"])
        self.products = {p["product_id"]: (p["name"], p.get("use_unit") or p.get("measure") or "") for p in data["products"]}


def to_inv(R, pid, qty, unit, factor):
    if pid is None: return None
    if factor is not None: return qty * factor
    use = (R.products.get(pid, ("", ""))[1] or "").lower().strip()
    u = (unit or "").lower()
    if u in ("oz", "fl oz") and use in ("lb", "lbs", "pound", "pounds"): return qty / 16
    if u == use or (u in ("oz", "fl oz") and use in ("oz", "ounce")): return qty
    if u in ("each", "ct") and use in ("each", "ct", "bottle", "cups", "cup", "slice", "patty", "packet", "packets", "tray", "plate", "bags"): return qty
    return None


class Usage:
    def __init__(self, R):
        self.R = R
        self.used = collections.defaultdict(float)        # (hour, product_id, source) -> qty
        self.unmatched = collections.defaultdict(float)   # (hour, name, reason) -> qty

    def add(self, h, pid, label, qty, unit, factor, src):
        if pid is None: return                       # free lines (tap water, ice) have no product
        inv = to_inv(self.R, pid, qty, unit, factor)
        if inv is None:
            self.unmatched[(h, f"{label} (in {src})", "no portion / unit set")] += 1
        elif inv:
            self.used[(h, pid, src)] += inv

    def recipe(self, h, rid, mult, src, skip_pids=(), depth=0):
        if depth > 6: return
        for (_, pid, qty, unit, factor, sub, name) in self.R.lines.get(rid, []):
            if pid in skip_pids or qty is None: continue
            if sub:
                y = self.R.recipes.get(sub, (None,) * 7)[5]
                if y:
                    self.recipe(h, sub, mult * qty / y, src, depth=depth + 1); continue
            if name in ("FOUNTAIN_SYRUP", "ICEE_SYRUP"): continue
            self.add(h, pid, name, qty * mult, unit, factor, src)

    def comp(self, h, cid, qty, src):
        c = self.R.comps.get(cid)
        if not c: return
        if c[8]:
            y = self.R.recipes.get(c[8], (None,) * 7)[5]
            if y: self.recipe(h, c[8], qty / y, src); return
        self.add(h, c[2], c[1], qty, c[3], c[4], src)


def compute_usage(lines, R, pos_names):
    """lines: dicts with TrxId, LineId, ParentLineId, product_id, quantity, hour."""
    U = Usage(R)
    kids = collections.defaultdict(list)
    for r in lines:
        if r["ParentLineId"] is not None:
            kids[(r["TrxId"], int(r["ParentLineId"]))].append((r["product_id"], r["quantity"]))
    for r in lines:
        p, q, h = r["product_id"], r["quantity"], r["hour"]
        if not q or p in HANDLED_BY_PARENT: continue
        ch = kids.get((r["TrxId"], r["LineId"]), [])
        src = pos_names.get(p) or M.get(p, ("", str(p)))[1] or f"POS #{p}"     # the name staff see on the register
        # ---- pizzas ----
        if p in LARGE_BASE or p in KIDS_BASE or p in SPECIALTY:
            kidsz = p in KIDS_BASE
            base = 7 if kidsz else 4
            spec = SPECIALTY.get(p)
            tops = list(R.recipes[spec][4]) if spec and spec in R.recipes else []
            removed = {NO_TOPPING[c] for c, _ in ch if c in NO_TOPPING}
            tops = [t for t in tops if t not in removed]
            for c, cq in ch:
                if c in TOPPING:
                    tops += [TOPPING[c]] * max(1, int(round(abs(cq) / max(abs(q), 1))))
            sauce = R.recipes[spec][3] if spec and spec in R.recipes else 13
            skip = (17,) if sauce != 13 else ()
            U.recipe(h, base, q, src, skip_pids=skip)
            if spec: U.recipe(h, spec, q, src)
            if sauce != 13 and sauce in R.comps:
                U.comp(h, sauce, ((R.comps[sauce][6] if kidsz else R.comps[sauce][5]) or 0) * q, src)
            n = len(tops); por = 1 if n <= 1 else (0.75 if n == 2 else 0.5)
            for t in tops:
                if t not in R.comps: continue
                full = R.comps[t][6] if kidsz else R.comps[t][5]
                if full: U.comp(h, t, full * por * q, src)
            if any(c == EXTRA_CHEESE for c, _ in ch): U.comp(h, 12, (2 if kidsz else 4) * q, src)
            if any(c == PIZZA_BUFFALO for c, _ in ch): U.comp(h, 15, 4 * q, src)
            continue
        # ---- wings ----
        if p in WINGS:
            rid, size = WINGS[p]
            U.recipe(h, rid, q, src)
            for c, cq in ch:
                if c in WING_SAUCE and WING_SAUCE[c] in R.comps:
                    por = R.comps[WING_SAUCE[c]][7] or {}
                    qty = por.get(size) or ((por.get("16") or 4) * 1.5 if size == "24" else (por.get("8") or 3) * 1.25)
                    U.comp(h, WING_SAUCE[c], qty * q, src)
                elif c in LTO and LTO[c] in R.recipes:
                    frid = LTO[c]; U.recipe(h, frid, q, src)
                    cid = R.recipes[frid][3]; cc = R.comps.get(cid)
                    if cc and (cc[2] or cc[8]): U.comp(h, cid, ((cc[7] or {}).get(size) or 3) * q, src)
                    else: U.unmatched[(h, (cc[1] if cc else "Wing flavor") + " (no product linked)", "no product linked")] += q
                elif c in LTO_NO_RECIPE:
                    pid, qty, unit = LTO_NO_RECIPE[c]; U.add(h, pid, R.products.get(pid, ("?",))[0], qty * q, unit, 1, src)
            continue
        # ---- fountain ----
        if p in FOUNTAIN:
            rid = FOUNTAIN[p]; U.recipe(h, rid, q, src)
            syrup = [l for l in R.lines.get(rid, []) if l[6] == "FOUNTAIN_SYRUP"]
            if syrup:
                fl = [FLAVOR[c] for c, _ in ch if c in FLAVOR] or [1]
                for f in fl: U.add(h, f, R.products.get(f, ("?",))[0], syrup[0][2] * q / len(fl), syrup[0][3], 1, src)
            continue
        # ---- ICEE ----
        if p in ICEE_SIZE:
            rid = ICEE_SIZE[p]; U.recipe(h, rid, q, src)
            syr = [l for l in R.lines.get(rid, []) if l[6] == "ICEE_SYRUP"]
            if syr:
                fl = [ICEE_FLAVOR[c] for c, _ in ch if c in ICEE_FLAVOR] or [152]
                for f in fl: U.add(h, f, R.products.get(f, ("?",))[0], syr[0][2] * q / len(fl), "oz", syr[0][4], src)
            continue
        if p in NEWR: U.recipe(h, NEWR[p], q, src); continue
        mt, tgt, aid, conf, note = M.get(p, ("?", "?", None, "", ""))
        if mt == R_ and aid in R.recipes: U.recipe(h, aid, q, src)
        elif mt == S_ and aid: U.add(h, aid, R.products.get(aid, (tgt,))[0], q, "each", 1, src)
        elif mt == C_:
            if aid in R.recipes and str(tgt).startswith("Side of"): U.recipe(h, aid, q, src)
            elif aid in (10, 41): U.add(h, aid, R.products[aid][0], q, "slice", 1, src)
            elif aid and aid in R.products: U.unmatched[(h, R.products[aid][0] + f" (in {src})", "no portion set")] += q
        elif mt == N_: U.unmatched[(h, tgt, "no recipe yet")] += q
    return U

R_, S_, C_, N_ = R, S, C, N

# ---------------------------------------------------------------------------
# Parafait (read-only)
# ---------------------------------------------------------------------------
def sql_connect(cfg):
    import pyodbc
    drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
    if not drivers: sys.exit("No SQL Server ODBC driver found.")
    driver = next((d for d in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server") if d in drivers), drivers[0])
    return pyodbc.connect(
        f"DRIVER={{{driver}}};SERVER={SERVER};DATABASE={cfg['database']};UID={SQL_USER};PWD={cfg['sql_password']};"
        "TrustServerCertificate=yes;Encrypt=no;ApplicationIntent=ReadOnly;", readonly=True, timeout=60)


def read_day(conn, day):
    cur = conn.cursor()
    cur.execute("""
        SELECT h.TrxId, h.TrxDate, l.LineId, l.ParentLineId, l.product_id, l.quantity, l.amount
        FROM dbo.trx_lines l JOIN dbo.trx_header h ON h.TrxId = l.TrxId
        WHERE h.TrxDate >= ? AND h.TrxDate < ? AND h.Status = 'CLOSED' AND l.CancelledTime IS NULL
        ORDER BY h.TrxDate, l.TrxId, l.LineId""", datetime(day.year, day.month, day.day), datetime(day.year, day.month, day.day) + timedelta(days=1))
    out = []
    for r in cur.fetchall():
        out.append({"TrxId": r.TrxId, "hour": r.TrxDate.strftime("%Y-%m-%d %H:00"), "LineId": r.LineId,
                    "ParentLineId": r.ParentLineId, "product_id": r.product_id,
                    "quantity": float(r.quantity or 0), "amount": float(r.amount or 0)})
    return out


def read_catalog(conn):
    cur = conn.cursor()
    cats = {r.CategoryId: r.Name for r in cur.execute("SELECT CategoryId, Name FROM dbo.Category").fetchall()}
    names, cat = {}, {}
    for r in cur.execute("SELECT product_id, product_name, CategoryId FROM dbo.products").fetchall():
        names[r.product_id] = r.product_name
        cat[r.product_id] = cats.get(r.CategoryId)
    return names, cat

# ---------------------------------------------------------------------------
# Inventory app (Supabase)
# ---------------------------------------------------------------------------
def rpc(cfg, fn, payload):
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"apikey": SUPABASE_ANON, "Authorization": f"Bearer {SUPABASE_ANON}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{fn} failed: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}")


def build_day(lines, R, names, cats):
    sales = collections.defaultdict(lambda: [0.0, 0.0])
    for r in lines:
        k = (r["hour"], r["product_id"], r["ParentLineId"] is not None)
        sales[k][0] += r["quantity"]; sales[k][1] += r["amount"]
    S_rows = [{"h": h, "pid": pid, "mod": mod, "name": names.get(pid) or f"POS #{pid}", "cat": cats.get(pid),
               "qty": round(q, 4), "amt": round(a, 2)} for (h, pid, mod), (q, a) in sales.items() if q or a]
    U = compute_usage(lines, R, names)
    U_rows = [{"h": h, "pid": pid, "src": src, "qty": round(q, 6)} for (h, pid, src), q in U.used.items() if abs(q) > 1e-9]
    X_rows = [{"h": h, "name": n, "why": why, "qty": round(q, 4)} for (h, n, why), q in U.unmatched.items()]
    return S_rows, U_rows, X_rows


def load_cfg():
    if not os.path.exists(CFG_PATH):
        sys.exit("Not set up yet. Run:  python lvmgp_sales_sync.py --setup")
    c = configparser.ConfigParser(); c.read(CFG_PATH)
    return dict(c["sync"])


def pick_database(password):
    conn = sql_connect({"database": "master", "sql_password": password})
    names = [r[0] for r in conn.execute("SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name")]
    conn.close()
    guesses = [n for n in names if "parafait" in n.lower()]
    if len(guesses) == 1:
        print("Using database:", guesses[0]); return guesses[0]
    print("Databases:", ", ".join(names))
    return input("Which one is Parafait? ").strip()


def setup():
    print("LVMGP sales sync setup — saved to", CFG_PATH)
    c = configparser.ConfigParser()
    c["sync"] = {
        "sql_password": getpass.getpass(f"Password for SQL user {SQL_USER}: "),
        "sync_key": getpass.getpass("Inventory sync key (from Claude): ").strip(),
    }
    c["sync"]["database"] = pick_database(c["sync"]["sql_password"])
    with open(CFG_PATH, "w") as f: c.write(f)
    cfg = dict(c["sync"])
    conn = sql_connect(cfg); conn.close(); print("Parafait: connected OK.")
    rpc(cfg, "pos_sync_recipes", {"p_key": cfg["sync_key"]}); print("Inventory app: connected OK.")


def install():
    py = sys.executable.replace("python.exe", "pythonw.exe") if sys.executable.lower().endswith("python.exe") and os.path.exists(sys.executable.replace("python.exe", "pythonw.exe")) else sys.executable
    tr = f'"{py}" "{os.path.abspath(__file__)}"'
    user = os.environ.get("USERDOMAIN", "") + "\\" + getpass.getuser()
    print(f"Creating a nightly task (3:15 am) that runs as {user}. Windows will ask for that account's password so it runs while signed out.")
    subprocess.run(["schtasks", "/Create", "/F", "/TN", "LVMGP Sales Sync", "/TR", tr, "/SC", "DAILY", "/ST", "03:15",
                    "/RU", user, "/RP", "*"], check=True)
    print('Done. Check it any time in Task Scheduler ("LVMGP Sales Sync"); results go to', LOG_PATH)


def run(days_back=3, d_from=None, d_to=None):
    cfg = load_cfg()
    today = date.today()
    d_to = d_to or today
    d_from = d_from or (d_to - timedelta(days=days_back - 1))
    R = Recipes(rpc(cfg, "pos_sync_recipes", {"p_key": cfg["sync_key"]}))
    conn = sql_connect(cfg)
    names, cats = read_catalog(conn)
    d, ok, failed = d_from, 0, 0
    while d <= d_to:
        try:
            lines = read_day(conn, d)
            S_rows, U_rows, X_rows = build_day(lines, R, names, cats)
            res = rpc(cfg, "pos_ingest_day", {"p_key": cfg["sync_key"], "p_day": d.isoformat(),
                                               "p_sales": S_rows, "p_usage": U_rows, "p_unmatched": X_rows})
            log(f"{d}: {len(lines)} POS lines -> {res}")
            ok += 1
        except Exception as e:                       # keep going; one bad day shouldn't stop the rest
            log(f"{d}: FAILED — {e}")
            failed += 1
        d += timedelta(days=1)
    conn.close()
    log(f"Finished: {ok} day(s) sent, {failed} failed.")
    return failed == 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Send Parafait sales + recipe usage to the LVMGP inventory app.")
    ap.add_argument("--setup", action="store_true", help="save passwords/keys and test both connections")
    ap.add_argument("--install", action="store_true", help="schedule the nightly run in Windows Task Scheduler")
    ap.add_argument("--days", type=int, default=3, help="how many days back to send (default 3: today and the 2 days before)")
    ap.add_argument("--from", dest="d_from", help="first day, YYYY-MM-DD")
    ap.add_argument("--to", dest="d_to", help="last day, YYYY-MM-DD")
    a = ap.parse_args()
    if a.setup: setup(); sys.exit(0)
    if a.install: install(); sys.exit(0)
    pd_ = lambda s: datetime.strptime(s, "%Y-%m-%d").date() if s else None
    try:
        sys.exit(0 if run(a.days, pd_(a.d_from), pd_(a.d_to)) else 1)
    except SystemExit:
        raise
    except Exception as e:
        log(f"FAILED — {e}")
        sys.exit(1)
