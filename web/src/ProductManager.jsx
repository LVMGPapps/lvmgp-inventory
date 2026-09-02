<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>LVMGP — Daily Freezer Pull Plan</title>
<style>
  :root{ --ink:#1a1c20; --line:#9aa0a8; --line2:#c9ccd2; --head:#243b6b; --par:#eef3fb; --amber:#8a5a00; }
  *{ box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  @page{ size:letter landscape; margin:0.3in; }
  body{ font-family:Arial,Helvetica,sans-serif; color:var(--ink); margin:0; padding:12px 14px; }
  h1{ font-size:18px; margin:0 0 1px; }
  .sub{ color:#5b5f66; font-size:11px; margin:0 0 8px; }
  .banner{ border:2px solid var(--head); background:#eef3fb; border-radius:7px; padding:7px 11px; font-size:12px; margin:0 0 11px; }
  .banner b{ color:var(--head); }
  .bar{ margin:0 0 10px; }
  .bar button{ font-family:inherit; font-size:12px; padding:6px 12px; margin-right:8px; border:1px solid var(--head); background:var(--head); color:#fff; border-radius:6px; cursor:pointer; }
  .bar button.ghost{ background:#fff; color:var(--head); }
  .bar .msg{ font-size:11px; color:#0a5c50; margin-left:6px; }
  h2{ font-size:13px; margin:16px 0 5px; padding-bottom:3px; border-bottom:2px solid var(--ink); }
  h2.morn{ border-color:var(--amber); color:var(--amber); }
  .mornnote{ font-size:11px; color:var(--amber); margin:0 0 6px; font-weight:bold; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; margin-bottom:4px; }
  th,td{ border:1px solid var(--line2); font-size:10px; text-align:center; }
  thead .day{ background:var(--head); color:#fff; font-size:11px; padding:4px 2px; border-color:var(--head); }
  thead .sub3{ background:#f0f0f0; padding:3px 1px; font-size:9px; font-weight:bold; }
  .itemcol{ width:150px; text-align:left; padding:5px 7px; font-weight:bold; background:#fafafa; }
  thead .itemhead{ background:#e9e9e9; text-align:left; padding:5px 7px; font-size:11px; vertical-align:bottom; }
  tbody td{ height:30px; }
  td.par{ background:var(--par); padding:0; }
  .parin{ width:100%; height:100%; border:0; background:transparent; text-align:center; font-family:inherit; font-size:12px; font-weight:bold; color:var(--ink); padding:2px 0; }
  .parin:focus{ outline:2px solid var(--head); background:#fff; }
  .dayEnd{ border-right:2px solid var(--line); }
  tbody tr:nth-child(even) td.itemcol{ background:#f2f2f2; }
  /* morning table: amber-tint par cells to distinguish */
  table.morn thead .day{ background:var(--amber); border-color:var(--amber); }
  table.morn td.par{ background:#fdf6e9; }
  .legend{ margin-top:6px; font-size:10px; color:#5b5f66; }
  .legend b{ color:var(--ink); }
  @media print{ .bar{ display:none; } tr{ page-break-inside:avoid; } h2{ page-break-after:avoid; } }
</style>
</head>
<body>
<h1>Daily Freezer Pull Plan</h1>
<p class="sub">Las Vegas Mini Grand Prix &middot; type <b>Par</b> in the blue cells &middot; write <b>Events</b> + <b>Total</b> by hand each day &middot; pull oldest first</p>

<div class="banner">
  <b>Before you leave each night:</b> make sure <b>TOMORROW's Total</b> for every item below is already in the fridge. This sheet is <b>nightly prep for the next day</b> &mdash; pull tonight so the morning crew opens ready.
</div>

<div class="bar">
  <button onclick="savePlan()">Save pars</button>
  <button class="ghost" onclick="window.print()">Print</button>
  <button class="ghost" onclick="clearPlan()">Clear all pars</button>
  <span class="msg" id="msg"></span>
</div>

<h2>Nightly pull &mdash; for tomorrow</h2>
<table><colgroup>
    <col style="width:150px" />
    <col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" />
    <col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" /><col /><col /><col />
  </colgroup><thead>
    <tr>
      <th class="itemhead" rowspan="2">Item</th>
      <th class="day" colspan="3">MON</th><th class="day" colspan="3">TUE</th><th class="day" colspan="3">WED</th>
      <th class="day" colspan="3">THU</th><th class="day" colspan="3">FRI</th><th class="day" colspan="3">SAT</th><th class="day" colspan="3">SUN</th>
    </tr>
    <tr>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3">Tot</th>
    </tr>
  </thead><tbody>
    <tr><td class="itemcol">Pizza Dough</td><td class="par"><input class="parin" data-k="n-0-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-0-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-0-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-0-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-0-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-0-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-0-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Chicken Tenders</td><td class="par"><input class="parin" data-k="n-1-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-1-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-1-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-1-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-1-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-1-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-1-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Wings</td><td class="par"><input class="parin" data-k="n-2-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-2-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-2-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-2-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-2-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-2-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-2-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Fajita Chicken Strips</td><td class="par"><input class="parin" data-k="n-3-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-3-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-3-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-3-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-3-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-3-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-3-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">French Fries</td><td class="par"><input class="parin" data-k="n-4-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-4-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-4-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-4-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-4-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-4-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-4-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Mozzarella Sticks</td><td class="par"><input class="parin" data-k="n-5-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-5-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-5-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-5-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-5-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-5-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-5-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Large Hot Dog</td><td class="par"><input class="parin" data-k="n-6-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-6-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-6-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-6-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-6-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-6-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-6-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Burger Patty</td><td class="par"><input class="parin" data-k="n-7-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-7-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-7-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-7-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-7-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-7-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="n-7-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
  </tbody></table>

<h2 class="morn">Pulled the morning of &mdash; never in advance</h2>
<p class="mornnote">Do NOT pull these ahead. Pull the morning they're needed, up to the day's Total.</p>
<table class="morn"><colgroup>
    <col style="width:150px" />
    <col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" />
    <col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" /><col /><col /><col class="dayEnd" /><col /><col /><col />
  </colgroup><thead>
    <tr>
      <th class="itemhead" rowspan="2">Item</th>
      <th class="day" colspan="3">MON</th><th class="day" colspan="3">TUE</th><th class="day" colspan="3">WED</th>
      <th class="day" colspan="3">THU</th><th class="day" colspan="3">FRI</th><th class="day" colspan="3">SAT</th><th class="day" colspan="3">SUN</th>
    </tr>
    <tr>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3 dayEnd">Tot</th>
      <th class="sub3">Par</th><th class="sub3">Ev</th><th class="sub3">Tot</th>
    </tr>
  </thead><tbody>
    <tr><td class="itemcol">Pepperoni</td><td class="par"><input class="parin" data-k="m-0-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-0-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-0-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-0-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-0-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-0-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-0-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Sausage</td><td class="par"><input class="parin" data-k="m-1-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-1-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-1-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-1-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-1-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-1-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-1-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Hot Dog Buns</td><td class="par"><input class="parin" data-k="m-2-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-2-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-2-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-2-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-2-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-2-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-2-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
    <tr><td class="itemcol">Burger Buns</td><td class="par"><input class="parin" data-k="m-3-0" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-3-1" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-3-2" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-3-3" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-3-4" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-3-5" inputmode="numeric" /></td><td class="ev"></td><td class="tot dayEnd"></td><td class="par"><input class="parin" data-k="m-3-6" inputmode="numeric" /></td><td class="ev"></td><td class="tot"></td></tr>
  </tbody></table>

<p class="legend"><b>Par</b> = standing amount for that day. <b>Ev</b> (Events) = extra for events/parties. <b>Tot</b> (Total) = Par + Events = what gets pulled. Pull oldest-dated stock first.</p>

<script>
  var KEY = "lvmgp_freezer_pull_pars_v3";
  function all(){ return Array.prototype.slice.call(document.querySelectorAll(".parin")); }
  function load(){ try{ var d = JSON.parse(localStorage.getItem(KEY) || "{}"); all().forEach(function(i){ if(d[i.dataset.k] != null) i.value = d[i.dataset.k]; }); }catch(e){} }
  function collect(){ var d={}; all().forEach(function(i){ if(i.value!=="") d[i.dataset.k]=i.value; }); return d; }
  function savePlan(){ try{ localStorage.setItem(KEY, JSON.stringify(collect())); msg("Saved. Pars will be here next time on this device."); }catch(e){ msg("Couldn't save on this device."); } }
  function clearPlan(){ if(!confirm("Clear all Par numbers?")) return; all().forEach(function(i){ i.value=""; }); try{ localStorage.removeItem(KEY); }catch(e){} msg("Cleared."); }
  function msg(t){ var m=document.getElementById("msg"); m.textContent=t; setTimeout(function(){ m.textContent=""; }, 3000); }
  document.addEventListener("input", function(e){ if(e.target.classList.contains("parin")){ try{ localStorage.setItem(KEY, JSON.stringify(collect())); }catch(e2){} } });
  load();
</script>
</body>
</html>
