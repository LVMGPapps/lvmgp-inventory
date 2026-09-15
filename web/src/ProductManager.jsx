--- orig/lvmgp-inventory-main/web/src/ProductManager.tsx	2026-09-02 08:16:36.000000000 +0000
+++ inv/lvmgp-inventory-main/web/src/ProductManager.tsx	2026-09-15 00:49:42.544661281 +0000
@@ -451,7 +451,7 @@
           <div className="group-t">Backup / alternate</div>
           <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 8 }}>
             <input type="checkbox" checked={!!p.count_whole_only} onChange={(e) => set("count_whole_only", e.target.checked)} />
-            Count whole units only — no partial/each (e.g. fountain BIBs)
+            Don't count in {p.usage_measure || "each"} — count cases and {(p.package_unit || "package") + "s"} only. The size unit still drives costing.
           </label>
           <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 8 }}>
             <input type="checkbox" checked={!!p.not_stocked} onChange={(e) => setP((s) => ({ ...s, not_stocked: e.target.checked, ...(e.target.checked ? { par_level: 0 } : {}) }))} />
@@ -534,7 +534,7 @@
   );
 }
 
-function printCountSheet(products, locations, areaId) {
+function printCountSheet(products, locations, areaId, az = false) {
   const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
   const areas = areaId ? locations.filter((l) => String(l.location_id) === String(areaId)) : locations;
   let body = "";
@@ -548,11 +548,16 @@
       const sort = a?.unit_sort ?? 9e9;
       (groups[code] = groups[code] || { sort, items: [] }).items.push(p);
     }
-    const ordered = Object.entries(groups).sort((a, b) => (a[1].sort - b[1].sort) || a[0].localeCompare(b[0]));
+    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
+    const shelfLabel = {};
+    for (const [code, g] of Object.entries(groups)) for (const it of g.items) shelfLabel[it.product_id] = code;
+    const ordered = az
+      ? [["A\u2013Z", { sort: 0, items: items.slice().sort(byName) }]]
+      : Object.entries(groups).sort((a, b) => (a[1].sort - b[1].sort) || a[0].localeCompare(b[0]));
     body += `<div class="area"><h2>${esc(loc.name)}</h2><div class="meta">Counted by ________________________    Date ______________    Page counts on-hand only</div>`;
     for (const [code, g] of ordered) {
-      g.items.sort((a, b) => a.name.localeCompare(b.name));
-      body += `<h3>${esc(code)}</h3><table><thead><tr><th class="nm">Item</th><th>Cases</th><th>Pkgs</th><th>Loose</th></tr></thead><tbody>`;
+      g.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
+      body += `<h3>${esc(code)}</h3><table><thead><tr><th class="nm">Item</th>${az ? "<th>Shelf</th>" : ""}<th>Cases</th><th>Pkgs</th><th>Loose</th></tr></thead><tbody>`;
       for (const p of g.items) {
         const ppc = Number(p.packages_per_case) || 1;
         const upp = Number(p.usage_per_package) || 1;
@@ -561,7 +566,7 @@
         const hint = ppc > 1
           ? `1 case = ${ppc} ${pkg}${ppc === 1 ? "" : "s"}${upp > 1 ? ` · 1 ${pkg} = ${upp} ${meas}` : ""}`
           : (upp > 1 ? `1 ${pkg} = ${upp} ${meas}` : "");
-        body += `<tr><td class="nm">${esc(p.name)}${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</td><td class="box"></td><td class="box"></td><td class="box">${esc(meas)}</td></tr>`;
+        body += `<tr><td class="nm">${esc(p.name)}${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</td>${az ? `<td>${esc(shelfLabel[p.product_id] || "")}</td>` : ""}<td class="box"></td><td class="box"></td><td class="box">${esc(meas)}</td></tr>`;
       }
       body += `</tbody></table>`;
     }
@@ -590,6 +595,10 @@
   const [finding, setFinding] = useState(false);
   const [focusId, setFocusId] = useState(null);
   const [flaggedOnly, setFlaggedOnly] = useState(false);
+  // Shelf order (default — matches the physical walk) vs one flat A–Z list across the whole section.
+  const [sortAZ, setSortAZ] = useState(() => { try { return localStorage.getItem("lvmgp_count_sort") === "az"; } catch { return false; } });
+  const setSort = (v) => { setSortAZ(v); try { localStorage.setItem("lvmgp_count_sort", v ? "az" : "shelf"); } catch {} };
+  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
   // Weekly count = a complete statement of a section (blanks become 0).
   // Spot count = a single-item correction (nothing else is touched).
   const [weekly, setWeekly] = useState(() => { try { return JSON.parse(localStorage.getItem("lvmgp_weekly") || "null"); } catch { return null; } });
@@ -602,6 +611,10 @@
   const loc = locations.find((l) => String(l.location_id) === String(locId));
   const unitFor = (p) => (p.locations || []).find((l) => l.location_id === loc?.location_id);
   const inLoc = (p) => (p.locations || []).some((l) => l.location_id === loc?.location_id);
+  // In A–Z mode the shelf grouping disappears, so each row carries its shelf (or location) as a chip.
+  const shelfOf = (p) => loc
+    ? (unitFor(p)?.unit_code || "")
+    : ((p.locations || []).find((l) => l.primary)?.name || (p.locations || [])[0]?.name || "");
   const backupsBy = {};
   for (const p of products) if (p.backup_for) (backupsBy[p.backup_for] ||= []).push(p);
 
@@ -623,8 +636,10 @@
     else { gname = (p.locations || []).find((l) => l.primary)?.name || (p.locations || [])[0]?.name || "Unassigned"; gsort = 0; }
     (groups[gname] = groups[gname] || { sort: gsort, items: [] }).items.push(p);
   }
-  for (const g of Object.values(groups)) g.items.sort((a, b) => a.name.localeCompare(b.name));
-  const orderedGroups = Object.entries(groups).sort((a, b) => (a[1].sort - b[1].sort) || a[0].localeCompare(b[0]));
+  for (const g of Object.values(groups)) g.items.sort(byName);
+  const orderedGroups = sortAZ
+    ? [["A–Z", { sort: 0, items: heads.slice().sort(byName) }]]
+    : Object.entries(groups).sort((a, b) => (a[1].sort - b[1].sort) || a[0].localeCompare(b[0]));
   const entered = Object.entries(draft).filter(([k, e]) => ["cases", "packages", "units", "loose"].some((f) => e[f] !== undefined && e[f] !== ""));
 
   // What you actually typed, turned into count rows.
@@ -701,14 +716,15 @@
     const uMeas = measure(p);
     const upc = usagePerCase(p), upp = usagePerPack(p);
     const whole = wholeOnly(p);
-    const showCase = !whole && (num(p.packages_per_case) || 1) > 1;    // show a Cases box only when a case holds >1 package
+    const showCase = (num(p.packages_per_case) || 1) > 1;    // show a Cases box whenever a case holds >1 package
     const counted = ["cases", "packages", "units", "loose"].some((f) => e[f] !== undefined && e[f] !== "");
     const partial = (num(e.cases) || 0) * upc + (num(e.packages) || 0) * upp + (num(e.units) || 0) + (num(e.loose) || 0);
     const hot = focusId === p.product_id;
-    const style = { ...(hot ? { background: "#FFF8E1", borderRadius: 8 } : {}), ...(alt ? { paddingLeft: 14 } : {}), gridTemplateColumns: whole ? "1fr 72px 96px" : showCase ? "1fr 46px 52px 54px 84px" : "1fr 58px 60px 90px" };
+    const shelf = sortAZ ? shelfOf(p) : "";
+    const style = { ...(hot ? { background: "#FFF8E1", borderRadius: 8 } : {}), ...(alt ? { paddingLeft: 14 } : {}), gridTemplateColumns: whole ? (showCase ? "1fr 52px 66px 90px" : "1fr 72px 96px") : showCase ? "1fr 46px 52px 54px 84px" : "1fr 58px 60px 90px" };
     return (
       <div className="crow" key={p.product_id} style={style}>
-        <div>{alt && <span className="bchip" style={{ marginRight: 6, background: "#FFF3E0", borderColor: "#E68A00", color: "#9a5b00" }}>Alternate</span>}{p.needs_recount && <span className="bchip" style={{ marginRight: 6, background: "#FDECEA", borderColor: "#E0392B", color: "#B0271B" }} title={p.recount_note || "Flagged for recount"}>🚩</span>}<b>{p.name}</b><div className="stat">{whole ? `count whole ${pkgName(p, 2)}` : (showCase ? `1 case = ${num(p.packages_per_case) || 1} ${pkgName(p, 2)} · ` : "") + `1 ${p.package_unit || "package"} = ${upp} ${uMeas}`} · here {fmtQty(p, here)}</div></div>
+        <div>{shelf && <span className="bchip" style={{ marginRight: 6, background: "#F2F4F8", borderColor: "#C9CCD2", color: "#4a4f57" }} title="Shelf">{shelf}</span>}{alt && <span className="bchip" style={{ marginRight: 6, background: "#FFF3E0", borderColor: "#E68A00", color: "#9a5b00" }}>Alternate</span>}{p.needs_recount && <span className="bchip" style={{ marginRight: 6, background: "#FDECEA", borderColor: "#E0392B", color: "#B0271B" }} title={p.recount_note || "Flagged for recount"}>🚩</span>}<b>{p.name}</b><div className="stat">{whole ? `count whole ${pkgName(p, 2)}` + (showCase ? ` · 1 case = ${num(p.packages_per_case) || 1} ${pkgName(p, 2)}` : "") : (showCase ? `1 case = ${num(p.packages_per_case) || 1} ${pkgName(p, 2)} · ` : "") + `1 ${p.package_unit || "package"} = ${upp} ${uMeas}`} · here {fmtQty(p, here)}</div></div>
         {showCase && <label>Cases<input className="fig" type="number" min="0" value={e.cases ?? ""} onChange={(ev) => setRow(key, "cases", ev.target.value)} /></label>}
         <label>{pkgName(p, 2)}<input className="fig" type="number" min="0" value={e.packages ?? ""} onChange={(ev) => setRow(key, "packages", ev.target.value)} /></label>
         {!whole && <label>+ {uMeas}<input className="fig" type="number" min="0" step="0.01" value={e.units ?? ""} onChange={(ev) => setRow(key, "units", ev.target.value)} /></label>}
@@ -726,7 +742,10 @@
         </select>
         <input className="grow" placeholder={loc ? "Search this location…" : "Search all items…"} value={q} onChange={(e) => setQ(e.target.value)} />
         {flaggedCount > 0 && <button className="mini" onClick={() => setFlaggedOnly((v) => !v)} style={flaggedOnly ? { background: "#E0392B", color: "#fff", borderColor: "#E0392B" } : { borderColor: "#E0392B", color: "#E0392B" }}>🚩 {flaggedCount}</button>}
-        <button className="mini" title={loc ? `Print a blank count sheet for ${loc.name}` : "Print blank count sheets for all areas"} onClick={() => printCountSheet(products, locations, locId)}>🖨 Print{loc ? "" : " all"}</button>
+        <button className="mini" onClick={() => setSort(!sortAZ)}
+          title={sortAZ ? "Sorted A–Z — switch back to shelf order" : "Sorted by shelf — switch to one flat A–Z list"}
+          style={sortAZ ? { background: "#243B6B", color: "#fff", borderColor: "#243B6B" } : undefined}>{sortAZ ? "A–Z" : "⇅ Shelf"}</button>
+        <button className="mini" title={loc ? `Print a blank count sheet for ${loc.name}` : "Print blank count sheets for all areas"} onClick={() => printCountSheet(products, locations, locId, sortAZ)}>🖨 Print{loc ? "" : " all"}</button>
         <button className="mini" onClick={() => setFinding(true)}>📷 Find</button>
         {weekly && loc
           ? <button className="btn btn-primary" disabled={busy} onClick={submitSection}>Submit {loc.name} ›</button>
@@ -756,7 +775,7 @@
         </div>
       )}
 
-      <p className="stat" style={{ margin: "0 2px 12px" }}>Items list in shelf order (A1, A2, …). Count cases and loose separately — the total is figured for you. Each location is a partial count; on-hand sums across locations.</p>
+      <p className="stat" style={{ margin: "0 2px 12px" }}>{sortAZ ? "Items list A–Z in one flat list; the grey chip is the shelf." : "Items list in shelf order (A1, A2, …)."} Count cases and loose separately — the total is figured for you. Each location is a partial count; on-hand sums across locations.</p>
       {note > 0 && <div className="ok">Saved {note} count{note === 1 ? "" : "s"}. On-hand updated.</div>}
       {!loc && <div className="note" style={{ marginBottom: 14 }}>Pick a location above to count the items stored there — they'll be sorted by shelf.</div>}
 
@@ -805,7 +824,7 @@
 
       {orderedGroups.map(([g, grp]) => (
         <div className="vgroup" key={g}>
-          <div className="vgroup-h"><span className="vname">{loc ? "▸ " + g : "📍 " + g}</span><span className="stat">{grp.items.length} items</span></div>
+          <div className="vgroup-h"><span className="vname">{sortAZ ? "🔤 A–Z" : loc ? "▸ " + g : "📍 " + g}</span><span className="stat">{grp.items.length} items</span></div>
           {grp.items.map((head) => {
             const backups = backupsBy[head.product_id] || [];
             if (!backups.length) return renderRow(head, false);
@@ -2190,7 +2209,7 @@
   // Rebuild a row's fields from cases/packages/partial, keeping unedited sub-fields at their decomposed value.
   function rowFields(r) {
     const upc = usagePerCase(product), upp = usagePerPack(product);
-    const showCase = !wholeOnly(product) && (Number(product.packages_per_case) || 1) > 1;
+    const showCase = (Number(product.packages_per_case) || 1) > 1;
     const dC = r._c != null ? (Number(r._c) || 0) : (showCase ? Math.floor((r.qty || 0) / upc + 1e-9) : 0);
     const remA = (r.qty || 0) - dC * upc;
     const dP = r._p != null ? (Number(r._p) || 0) : Math.floor(remA / upp + 1e-9);
@@ -2261,7 +2280,7 @@
           <span className="stat">·</span>
           <input type="number" step="0.001" value={perPkg} onChange={(e) => setPerPkg(e.target.value)} style={{ width: 70 }} />
           <span className="stat">per {product.package_unit || "package"}</span>
-          <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={wholeChk} onChange={(e) => setWholeChk(e.target.checked)} />whole only</label>
+          <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={wholeChk} onChange={(e) => setWholeChk(e.target.checked)} title={`Cost in ${meas || "each"}, but don't count in it`} />don't count in {meas || "each"}</label>
           <button className="mini" disabled={busy} onClick={saveMeasure}>Save measure</button>
         </div>
         <div className="stat" style={{ marginBottom: 10 }}>Edit the <b>date</b>, cases/loose, or delete any entry. Deliveries for this item are below — fix their date, qty, or cost here too. Everything recalculates on-hand and usage.</div>
@@ -2273,7 +2292,7 @@
             {rows.map((r) => {
               const upc = usagePerCase(product), upp = usagePerPack(product);
               const whole = wholeOnly(product);
-              const showCase = !whole && (Number(product.packages_per_case) || 1) > 1;
+              const showCase = (Number(product.packages_per_case) || 1) > 1;
               const dC = r._c != null ? r._c : (showCase ? Math.floor((r.qty || 0) / upc + 1e-9) : 0);
               const remA = (r.qty || 0) - (Number(dC) || 0) * upc;
               const dP = r._p != null ? r._p : Math.floor(remA / upp + 1e-9);
