// ── INVENTORY ──

function vById(id){for(var i=0;i<D.vendors.length;i++){if(D.vendors[i].id===id)return D.vendors[i];}return null;}

function openPartReqModal(){
  partReqItems = [];
  document.getElementById('preq-search').value = '';
  document.getElementById('preq-custom-name').value = '';
  document.getElementById('preq-notes').value = '';
  document.getElementById('preq-results').innerHTML = '';
  renderPartReqList();
  openM('partReqModal');
}

function preqAddPart(pid){
  var p = D.parts.filter(function(x){return x.id===pid;})[0]; if(!p) return;
  if(partReqItems.some(function(r){return r.pid===pid;})) return;
  partReqItems.push({pid:pid,name:p.name,partNumber:p.partNumber||'',inStock:p.qty,reserved:0,requesting:1,cost:p.unitCost||0,custom:false,note:''});
  renderPartReqList(); preqSearch();
}

// Request the part currently open on its page: opens the standard request flow
// pre-loaded with this part, so it lands on the Order List like any other request.
function requestThisPart(pid){
  pid = pid || (typeof editPartId!=='undefined' ? editPartId : null);
  var p = (D.parts||[]).filter(function(x){return x.id===pid;})[0];
  if(!p){ alert('Open a saved part first to request it.'); return; }
  if(typeof closeM==='function') closeM('partModal');
  openPartReqModal();
  preqAddPart(pid);
}

// Open the unified WO chooser carrying this part as context.
function useInWOFromPart(pid){
  pid = pid || (typeof editPartId!=='undefined' ? editPartId : null);
  var p = (D.parts||[]).filter(function(x){return x.id===pid;})[0];
  if(!p){ alert('Open a saved part first to use it in a work order.'); return; }
  if(typeof closeM==='function') closeM('partModal');
  if(typeof openWOChooser==='function') openWOChooser({partName:p.name, partId:p.id});
}

// Receive a part directly to stock when it arrived without going through the
// Order List. Adds the entered quantity to on-hand and stamps last-received.
function openReceivePart(pid){
  pid = pid || (typeof editPartId!=='undefined' ? editPartId : null);
  var p = (D.parts||[]).filter(function(x){return x.id===pid;})[0];
  if(!p){ alert('Open a saved part first to receive it.'); return; }
  window._recvPid = pid;
  var unit = p.unit||'each';
  document.getElementById('rcv-part-name').textContent = p.name + (p.partNumber?(' ('+p.partNumber+')'):'');
  document.getElementById('rcv-onhand').textContent = (Number(p.qty)||0)+' '+unit+' on hand';
  document.getElementById('rcv-qty').value = '';
  document.getElementById('rcv-date').value = today();
  document.getElementById('rcv-cost').value = p.unitCost||'';
  if(typeof closeM==='function') closeM('partModal');
  openM('receivePartModal');
}
function confirmReceivePart(){
  var pid = window._recvPid;
  var p = (D.parts||[]).filter(function(x){return x.id===pid;})[0];
  if(!p){ closeM('receivePartModal'); return; }
  var qty = parseFloat(document.getElementById('rcv-qty').value)||0;
  if(qty<=0){ alert('Enter how many came in.'); return; }
  var d = document.getElementById('rcv-date').value||today();
  var cost = parseFloat(document.getElementById('rcv-cost').value);
  p.qty = (Number(p.qty)||0) + qty;
  p.lastReceived = d;
  if(!isNaN(cost) && cost>0) p.unitCost = cost;
  dbSave('parts',p);
  closeM('receivePartModal');
  var unit = p.unit||'each';
  alert(qty+' '+unit+' received - '+p.name+' now at '+p.qty+' '+unit+'.');
  if(typeof renderParts!=='undefined') renderParts();
}

function renderPartReqList(){
  var el=document.getElementById('preq-list');
  var sumEl=document.getElementById('preq-summary');
  if(!el) return;
  if(!partReqItems.length){
    el.innerHTML='<div style="text-align:center;padding:16px;font-size:12px;color:var(--muted)">No parts added yet.</div>';
    if(sumEl) sumEl.style.display='none'; return;
  }
  var totalCost=0,discrepancies=0,h='';
  for(var i=0;i<partReqItems.length;i++){
    var r=partReqItems[i];
    var lineCost=r.cost*r.requesting; totalCost+=lineCost;
    var disc=r.inStock!==null&&r.requesting>r.inStock; if(disc)discrepancies++;
    h+='<div style="background:var(--card);border-radius:10px;padding:10px;margin-bottom:6px;border-left:3px solid '+(disc?'#f59e0b':'var(--border)')+'">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start">'+
      '<div style="flex:1"><div style="font-size:13px;font-weight:700">'+esc(r.name)+'</div>'+
      (r.partNumber?'<div style="font-size:10px;font-family:monospace;color:var(--muted)">'+esc(r.partNumber)+'</div>':'')+
      '</div><button onclick="preqRemove('+i+')" style="background:none;border:none;font-size:16px;color:var(--muted);cursor:pointer">\u00d7</button></div>'+
      '<div style="display:flex;gap:10px;margin-top:8px;align-items:center;flex-wrap:wrap">'+
      (r.inStock!==null?'<div style="font-size:11px"><span style="color:var(--muted)">In Stock: </span><b style="color:'+(r.inStock>0?'#22c55e':'#ef4444')+'">'+r.inStock+'</b></div>':'')+
      '<div style="font-size:11px;display:flex;align-items:center;gap:4px"><span style="color:var(--muted)">Qty: </span>'+
      '<button onclick="preqAdj('+i+',-1)" style="width:22px;height:22px;border-radius:4px;border:1px solid var(--border);background:var(--bg);cursor:pointer;font-weight:700">\u2212</button>'+
      '<span style="font-weight:900;font-size:14px;min-width:24px;text-align:center">'+r.requesting+'</span>'+
      '<button onclick="preqAdj('+i+',1)" style="width:22px;height:22px;border-radius:4px;border:1px solid var(--border);background:var(--bg);cursor:pointer;font-weight:700">+</button></div>'+
      (r.cost>0?'<div style="font-size:11px;font-family:monospace;margin-left:auto">$'+lineCost.toFixed(2)+'</div>':'')+
      '</div>'+
      (disc?'<div style="margin-top:6px;padding:5px 8px;background:#fffbeb;border-radius:6px;font-size:11px;color:#92400e">\u26a0\ufe0f Requesting more than in stock ('+r.inStock+' available)</div>'+
        '<input placeholder="Note why you need more than stock shows..." data-ri="'+i+'" oninput="preqNote(this)" style="width:100%;margin-top:4px;border:1.5px solid #fcd34d;border-radius:7px;padding:5px 8px;font-size:11px;font-family:inherit;background:var(--bg)" value="'+esc(r.note)+'"/>':'')+
      '</div>';
  }
  el.innerHTML=h;
  if(sumEl){ sumEl.style.display='';
    sumEl.innerHTML='<div style="display:flex;justify-content:space-between;font-weight:700"><span>'+partReqItems.length+' parts</span><span style="font-family:monospace">$'+totalCost.toFixed(2)+'</span></div>'+
      (discrepancies?'<div style="color:#f59e0b;font-size:11px;margin-top:4px">\u26a0\ufe0f '+discrepancies+' item(s) exceed stock \u2014 notes required</div>':'');
  }
}

function submitPartRequest(){
  if(!partReqItems.length){alert('Add at least one part.');return;}
  for(var i=0;i<partReqItems.length;i++){
    var r=partReqItems[i];
    if(r.inStock!==null&&r.requesting>r.inStock&&!r.note.trim()){
      alert('Add a note for "'+r.name+'" \u2014 requesting more than in stock.');return;
    }
  }
  var notes=document.getElementById('preq-notes').value.trim();
  var req={id:nid('REQ'),created:today(),requestedBy:currentUser.name,status:'pending',notes:notes,items:partReqItems.slice()};
  if(!D.partRequests)D.partRequests=[];
  D.partRequests.push(req);dbSave('part_requests',req);
  // Route each requested item into the Order List so it's actually visible and
  // actionable. It starts as "requested"; a manager moves it to "ordered" then
  // "received". Without this, requests were saved to a bucket nothing displays.
  var added=0;
  for(var i=0;i<partReqItems.length;i++){
    var it=partReqItems[i];
    var line=addPartOrder(it.name, it.requesting, '', '', '');
    if(line){
      if(it.note)line.note=it.note;
      line.requestedBy=currentUser.name;
      line.requestId=req.id;
      if(it.cost&&!line.unitCost)line.unitCost=it.cost;
      dbSave('part_orders',line);
      added++;
    }
  }
  closeM('partReqModal');
  alert('Parts request submitted — '+added+' item'+(added===1?'':'s')+' added to the Order List.');
  if(typeof renderParts!=='undefined')renderParts();
  updateBadges();
}

function openPartAdjRequest(pid){
  var p=D.parts.filter(function(x){return x.id===pid;})[0];if(!p)return;
  partAdjPid=pid;
  document.getElementById('padj-info').innerHTML='<div style="font-size:14px;font-weight:800">'+esc(p.name)+'</div>'+
    '<div style="font-size:12px;color:var(--muted)">System shows: <b>'+p.qty+'</b> in stock'+(p.partNumber?' \u00b7 PN: '+esc(p.partNumber):'')+'</div>';
  document.getElementById('padj-actual').value=p.qty;
  document.getElementById('padj-reason').value='';
  openM('partAdjModal');
}

function renderRptParts(el){
  var h=rptHeader("Parts Usage & Cost","Parts consumed by WO, cost by category and kart");
  h+=rptDatePicker("parts-from","parts-to","","");
  h+='<button onclick="generatePartsReport()" style="width:100%;background:#22c55e;border:none;color:#fff;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:14px">Generate</button>';
  h+='<div id="parts-output"></div>';
  el.innerHTML=h;
}

function generatePartsReport(){
  var from=document.getElementById("parts-from")&&document.getElementById("parts-from").value;
  var to=document.getElementById("parts-to")&&document.getElementById("parts-to").value;
  var out=document.getElementById("parts-output");if(!out)return;

  // WOs in range with parts ordered
  var wos=D.workOrders.filter(function(w){
    return w.partsOrdered&&w.partsOrdered.length>0&&
           (!from||w.created>=from)&&(!to||w.created<=to);
  });

  var partUsage={};
  var catSpend={};
  var totalCost=0;
  var allK=D.karts.euro.concat(D.karts.road,D.karts.sprint,D.karts.kiddie);

  for(var wi=0;wi<wos.length;wi++){
    var w=wos[wi];
    for(var pi=0;pi<w.partsOrdered.length;pi++){
      var pid=w.partsOrdered[pi];
      var part=D.parts.find(function(p){return p.id===pid;});
      if(!part)continue;
      var cost=part.cost||0;
      var cat=part.category||"other";
      totalCost+=cost;
      if(!partUsage[pid])partUsage[pid]={name:part.name,category:cat,qty:0,cost:0,wos:[]};
      partUsage[pid].qty++;
      partUsage[pid].cost+=cost;
      partUsage[pid].wos.push(w.id);
      catSpend[cat]=(catSpend[cat]||0)+cost;
    }
  }

  var h='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:14px">';
  h+=rptStat("Total Spend",fmtM(totalCost),"#ef4444");
  var partArr=Object.keys(partUsage).map(function(k){return Object.assign({id:k},partUsage[k]);});
  h+=rptStat("Parts Used",partArr.length,"#3b82f6");
  h+=rptStat("WOs w/ Parts",wos.length,"#f59e0b");
  h+='</div>';

  // Spend by category
  h+=rptSection("Spend by Category");
  var catArr=Object.keys(catSpend).map(function(k){return{cat:k,spend:catSpend[k]};});
  catArr.sort(function(a,b){return b.spend-a.spend;});
  for(var i=0;i<catArr.length;i++){
    var pct=totalCost>0?(catArr[i].spend/totalCost*100).toFixed(0):0;
    h+='<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">';
    h+='<div style="flex:1;font-size:13px;font-weight:600;text-transform:capitalize">'+esc(catArr[i].cat)+'</div>';
    h+='<div style="font-size:13px;font-weight:800;color:#ef4444">'+fmtM(catArr[i].spend)+'</div>';
    h+='<div style="font-size:11px;color:var(--muted);width:30px;text-align:right">'+pct+'%</div></div>';
  }

  // Most used parts
  h+=rptSection("Most Used Parts");
  partArr.sort(function(a,b){return b.qty-a.qty;});
  if(partArr.length===0){
    h+='<div style="font-size:12px;color:var(--muted)">No parts usage recorded in this period.</div>';
  } else {
    for(var i=0;i<Math.min(partArr.length,20);i++){
      var p=partArr[i];
      h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);gap:8px">';
      h+='<div style="flex:1"><div style="font-size:12px;font-weight:700">'+esc(p.name)+'</div>';
      h+='<div style="font-size:10px;color:var(--muted)">'+p.wos.length+' WO'+(p.wos.length!==1?"s":"")+'</div></div>';
      h+='<div style="text-align:right"><div style="font-size:12px;font-weight:800">'+esc(String(p.qty))+'x</div>';
      h+='<div style="font-size:11px;color:#ef4444">'+fmtM(p.cost)+'</div></div></div>';
    }
  }

  out.innerHTML=h;
}

function openVendorModal(){ openM("vendorModal"); }




function diagAddCustomPart(){
  var name=document.getElementById('dp-name').value.trim();
  var qty=Number(document.getElementById('dp-qty').value)||1;
  var cost=Number(document.getElementById('dp-cost').value)||0;
  if(!name){alert('Enter part name.');return;}
  diagCustomParts.push({name:name,qty:qty,cost:cost,unit:'each'});
  renderDiagModal();
}

function diagRemoveCustomPart(btn){
  diagCustomParts.splice(parseInt(btn.dataset.cpi),1);
  renderDiagModal();
}

function renderVendors(){
  var el=document.getElementById('tab-vendors');if(!el)return;
  var st='<div class="subtabs">';var tabs=['vendors','visits','costs'];var tn={vendors:'Vendors',visits:'Visits',costs:'Costs'};
  for(var i=0;i<tabs.length;i++)st+='<button class="stab'+(vTab===tabs[i]?' on-v':'')+'" onclick="setVT(\''+tabs[i]+'\')">'+tn[tabs[i]]+'</button>';
  st+='<button class="stab" onclick="openLogVisit()" style="background:#0891b2;color:#fff;border-color:#0891b2;margin-left:auto">+ Log Visit</button></div>';
  var h='<div class="scroll"><div class="lpad">';
  if(vTab==='vendors'){
    var ns=[];for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].status==='needs-scheduling')ns.push(D.workOrders[i]);
    if(ns.length){h+='<div style="background:#cffafe;border:1.5px solid #67e8f9;border-radius:12px;padding:12px 14px"><div style="font-size:12px;font-weight:800;color:#0e7490;margin-bottom:6px">'+ns.length+' Vendor PM'+(ns.length>1?'s':'')+' Need Scheduling</div>';for(var i=0;i<ns.length;i++){var w=ns[i];h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #a5f3fc;gap:8px"><div><div style="font-size:12px;font-weight:700">'+esc(w.title)+'</div><div style="font-size:10px;color:#0e7490">'+fmtS(w.dueDate)+' - '+fmtM(w.cost)+'</div></div></div>';}h+='</div>';}
    for(var i=0;i<D.vendors.length;i++){
      var v=D.vendors[i],vis=[],spend=0;for(var j=0;j<D.vendorVisits.length;j++)if(D.vendorVisits[j].vendorId===v.id){vis.push(D.vendorVisits[j]);spend+=Number(D.vendorVisits[j].cost||0);}
      h+='<div class="card" style="border-left:4px solid #0891b2"><div style="display:flex;justify-content:space-between;gap:8px"><div><div style="font-size:15px;font-weight:800">'+esc(v.name)+'</div><div style="font-size:11px;color:#0891b2;font-weight:700">'+esc(v.trade)+'</div><div style="font-size:11px;color:var(--muted)">'+esc(v.contact)+' - '+esc(v.phone)+'</div></div>';
      if(canFinancials())h+='<div style="text-align:right;flex-shrink:0">'+(v.contract?'<div style="font-size:10px;font-family:monospace;color:var(--muted)">'+esc(v.contract)+'</div>':'')+'<div style="font-size:14px;font-weight:900;color:#0891b2;font-family:monospace">'+fmtM(v.annualValue)+'<span style="font-size:9px;color:var(--muted)">/yr</span></div></div>';
      h+='</div><div style="display:flex;gap:14px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)"><div><div style="font-size:16px;font-weight:900">'+vis.length+'</div><div style="font-size:9px;color:var(--muted);font-weight:600;text-transform:uppercase">Visits</div></div>';
      if(canFinancials())h+='<div><div style="font-size:16px;font-weight:900;color:#0891b2">'+fmtM(spend)+'</div><div style="font-size:9px;color:var(--muted);font-weight:600;text-transform:uppercase">Spent</div></div>';
      h+='</div></div>';
    }
    if(!D.vendors.length)h+='<div class="empty">No vendors yet</div>';
    h+='<button onclick="openVendorModal()" style="background:#0891b2;border:none;color:#fff;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;width:100%">+ Add Vendor</button>';
  } else if(vTab==='visits'){
    var sorted=D.vendorVisits.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    if(!sorted.length)h+='<div class="empty">No visits logged yet</div>';
    for(var i=0;i<sorted.length;i++){var vv=sorted[i],v=vById(vv.vendorId),asset=assetById(vv.assetId);h+='<div class="card" style="border-top:3px solid #0891b2"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px"><div><div style="font-size:14px;font-weight:700">'+(v?esc(v.name):'Vendor')+' - '+(asset?esc(asset.name):'--')+'</div><div style="font-size:11px;color:var(--muted)">'+fmt(vv.date)+'</div></div><div style="font-size:16px;font-weight:900;color:#0891b2;font-family:monospace">'+fmtM(vv.cost)+'</div></div>'+(vv.summary?'<div style="font-size:12px;color:var(--muted)">'+esc(vv.summary)+'</div>':'')+'</div>';}
  } else {
    var totalC=0,totalS=0;for(var i=0;i<D.vendors.length;i++)totalC+=Number(D.vendors[i].annualValue||0);for(var i=0;i<D.vendorVisits.length;i++)totalS+=Number(D.vendorVisits[i].cost||0);
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="stat-card" style="border-top-color:#0891b2"><div class="stat-val" style="color:#0891b2;font-size:18px">'+fmtM(totalC)+'</div><div class="stat-lbl">Annual Contracts</div></div><div class="stat-card" style="border-top-color:#22c55e"><div class="stat-val" style="color:#22c55e;font-size:18px">'+fmtM(totalS)+'</div><div class="stat-lbl">YTD Spend</div></div></div>';
    h+='<div class="card" style="overflow:hidden"><table class="dtbl"><thead><tr><th>Vendor</th><th>Trade</th><th style="text-align:right">Contract/yr</th><th style="text-align:right">YTD</th></tr></thead><tbody>';
    for(var i=0;i<D.vendors.length;i++){var v=D.vendors[i],s=0;for(var j=0;j<D.vendorVisits.length;j++)if(D.vendorVisits[j].vendorId===v.id)s+=Number(D.vendorVisits[j].cost||0);h+='<tr><td style="font-weight:700">'+esc(v.name)+'</td><td style="color:var(--muted)">'+esc(v.trade)+'</td><td style="text-align:right;font-family:monospace;color:#0891b2;font-weight:700">'+fmtM(v.annualValue)+'</td><td style="text-align:right;font-family:monospace;font-weight:700">'+fmtM(s)+'</td></tr>';}
    h+='</tbody></table></div>';
  }
  h+='<div style="height:60px"></div></div></div>';el.innerHTML=st+h;
}

function setVT(t){vTab=t;renderVendors();}

function openLogVisit(){
  var vsel=document.getElementById('vv-vendor');vsel.innerHTML='<option value="">Select...</option>';for(var i=0;i<D.vendors.length;i++)vsel.innerHTML+='<option value="'+D.vendors[i].id+'">'+esc(D.vendors[i].name)+'</option>';
  var asel=document.getElementById('vv-asset');if(asel){asel.innerHTML='<option value="">Select...</option>';for(var i=0;i<D.assets.length;i++)asel.innerHTML+='<option value="'+D.assets[i].id+'">'+esc(D.assets[i].name)+'</option>';makeSearchable('vv-asset');}
  var vd=document.getElementById('vv-date');if(vd)vd.value=today();
  openM('visitModal');
}

function saveVisit(){var vId=document.getElementById('vv-vendor').value,aId=( document.getElementById('vv-asset') ? document.getElementById('vv-asset').value : '' )||'';var date=( document.getElementById('vv-date') ? document.getElementById('vv-date').value : '' )||today();if(!vId||!aId){alert('Select vendor and asset.');return;}D.vendorVisits.push({id:nid('VV'),vendorId:vId,assetId:aId,date:date,cost:Number(( document.getElementById('vv-cost') ? document.getElementById('vv-cost').value : '0' ))||0,summary:'',followUps:[],approved:false});dbSave('vendor_visits',D.vendorVisits[D.vendorVisits.length-1]);closeM('visitModal');vTab='visits';renderVendors();}

function saveVendor(){var name=document.getElementById('vnd-name').value.trim();if(!name)return;D.vendors.push({id:nid('V'),name:name,trade:document.getElementById('vnd-trade').value,contact:document.getElementById('vnd-contact').value,phone:document.getElementById('vnd-phone').value,email:document.getElementById('vnd-email').value,contract:document.getElementById('vnd-contract').value,annualValue:Number(document.getElementById('vnd-annual').value)||0,notes:document.getElementById('vnd-notes').value});dbSave('vendors',D.vendors[D.vendors.length-1]);closeM('vendorModal');renderVendors();}

/* ===== Parts Order List + WO verify-stock (Phase 1) ===== */
function woById(id){for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id)return D.workOrders[i];return null;}
function partByName(n){var id=partIdByName(n);if(!id)return null;for(var i=0;i<D.parts.length;i++)if(D.parts[i].id===id)return D.parts[i];return null;}
function _partOnHand(n){var p=partByName(n);return p?(Number(p.qty)||0):null;}
function partOnOrderQty(n){if(!D.partOrders)return 0;var pid=partIdByName(n),k=ahNorm(n),sum=0;for(var i=0;i<D.partOrders.length;i++){var o=D.partOrders[i];if(o.status==='received')continue;var m=(pid&&o.partId&&o.partId===pid)||(ahNorm(o.partName)===k);if(m)sum+=Number(o.qty)||0;}return sum;}
function partLastUsed(name){var k=ahNorm(name),latest='';for(var i=0;i<D.workOrders.length;i++){var w=D.workOrders[i];if(w.status!=='completed')continue;var pu=w.partsUsed||[];for(var j=0;j<pu.length;j++){if(ahNorm(pu[j].name)===k){var d=w.completedOn||w.completed||w.dueDate||w.created||'';if(d>latest)latest=d;}}}return latest;}
function woPartState(w,name){return (w&&w.partCheck&&w.partCheck[name])||'';}
function woSetPartCheck(woId,idx,state){var w=woById(woId);if(!w)return;var pu=w.partsUsed||[];if(idx<0||idx>=pu.length)return;var nm=pu[idx].name;w.partCheck=w.partCheck||{};if(w.partCheck[nm]===state)delete w.partCheck[nm];else w.partCheck[nm]=state;saveWO(w);if(typeof renderWOPage!=='undefined')renderWOPage(woId);}
function woFixCount(woId,idx){var w=woById(woId);if(!w)return;var pu=w.partsUsed||[];if(idx<0||idx>=pu.length)return;var pid=partIdByName(pu[idx].name);if(!pid){alert('That part is not in inventory yet \u2014 add it first.');return;}if(typeof openPartAdjRequest!=='undefined')openPartAdjRequest(pid);}
function _partOrderOpen(woId,name){if(!D.partOrders)return false;var k=ahNorm(name);for(var i=0;i<D.partOrders.length;i++){var o=D.partOrders[i];if(o.woId===woId&&ahNorm(o.partName)===k&&o.status!=='received')return true;}return false;}
function addPartOrder(name,qty,woId,assetId,woTitle){if(!D.partOrders)D.partOrders=[];var p=partByName(name);var line={id:nid('PO'),partId:p?p.id:null,partName:name,partNumber:p?(p.partNumber||''):'',qty:Number(qty)||1,woId:woId||'',woTitle:woTitle||'',assetId:assetId||'',vendor:p?(p.vendors||''):'',unitCost:p?(Number(p.unitCost)||0):0,usedOn:p?(p.usedOn||[]):[],status:'requested',orderedDate:'',created:today(),addedBy:(currentUser&&currentUser.name)||''};D.partOrders.push(line);dbSave('part_orders',line);return line;}
function woAddPartToOrder(woId,idx){var w=woById(woId);if(!w)return;var pu=w.partsUsed||[];if(idx<0||idx>=pu.length)return;var nm=pu[idx].name;if(_partOrderOpen(woId,nm)){alert('\u201c'+nm+'\u201d is already on the order list for this work order.');return;}addPartOrder(nm,pu[idx].qty,woId,w.assetId,w.title);alert('Added \u201c'+nm+'\u201d to the order list.');if(typeof renderWOPage!=='undefined')renderWOPage(woId);}
function woAddAllShortfalls(woId){var w=woById(woId);if(!w)return;var pu=w.partsUsed||[],added=0;for(var i=0;i<pu.length;i++){var nm=pu[i].name,st=woPartState(w,nm),oh=_partOnHand(nm),need=Number(pu[i].qty)||1;if(st==='available')continue;if(st!=='missing'&&oh!==null&&oh>=need)continue;if(_partOrderOpen(woId,nm))continue;addPartOrder(nm,pu[i].qty,woId,w.assetId,w.title);added++;}if(!added){alert('Nothing to add \u2014 every part is either confirmed available or already on the order list.');return;}if(confirm(added+' part(s) added to the order list.\n\nPush this work order to \u201cawaiting parts\u201d?')){w.status='awaiting-parts';w.pushedDate=w.pushedDate||addD(today(),7);saveWO(w);}if(typeof renderWOPage!=='undefined')renderWOPage(woId);}
function setPartOrderStatus(id,status){if(!D.partOrders)return;for(var i=0;i<D.partOrders.length;i++){if(D.partOrders[i].id===id){D.partOrders[i].status=status;if(status==='ordered'&&!D.partOrders[i].orderedDate)D.partOrders[i].orderedDate=today();dbSave('part_orders',D.partOrders[i]);break;}}renderParts();}
function _applyReceiveToStock(line,nUnits,dateStr){
  var p=null;if(line.partId){for(var j=0;j<D.parts.length;j++)if(D.parts[j].id===line.partId){p=D.parts[j];break;}}
  if(!p&&line.partNumber&&typeof partByPN==='function')p=partByPN(line.partNumber);
  if(!p&&typeof partByName==='function')p=partByName(line.partName);
  var pack=(p&&Number(p.packSize)>0)?Number(p.packSize):0;var addQty=(pack>0?nUnits*pack:nUnits);var d=dateStr||today();
  if(p){p.qty=(Number(p.qty)||0)+addQty;if(!p.partNumber&&line.partNumber)p.partNumber=line.partNumber;if((!p.vendors||_poNorm(p.vendors)==='lvmgpinternal')&&line.vendor&&_poNorm(line.vendor)!=='lvmgpinternal')p.vendors=line.vendor;if(!(Number(p.unitCost)||0)&&Number(line.unitCost))p.unitCost=Number(line.unitCost);if(line.usedOn&&line.usedOn.length){p.usedOn=p.usedOn||[];for(var u=0;u<line.usedOn.length;u++)if(p.usedOn.indexOf(line.usedOn[u])<0)p.usedOn.push(line.usedOn[u]);}p.lastReceived=d;dbSave('parts',p);if(!line.partId)line.partId=p.id;}
  else{var np={id:nid('PRT'),name:line.partName,partNumber:line.partNumber||'',sku:'',area:'',location:'',description:'',qty:addQty,minQty:0,unitCost:Number(line.unitCost)||0,totalCost:0,vendors:line.vendor||'',types:'',engines:[],usedOn:(line.usedOn||[]).slice(),activeOverride:null,created:d,lastReceived:d};if(!np.usedOn.length&&typeof deriveUsedOn==='function')np.usedOn=deriveUsedOn(np);D.parts.push(np);dbSave('parts',np);line.partId=np.id;}
}
function receivePartOrderQty(id,nUnits,dateStr){
  if(!D.partOrders)return;var line=null;for(var i=0;i<D.partOrders.length;i++)if(D.partOrders[i].id===id){line=D.partOrders[i];break;}if(!line)return;
  var ordered=Number(line.qty)||0,already=Number(line.qtyReceived)||0,n=Math.max(0,Number(nUnits)||0);
  if(n<=0){alert('Enter how many were received.');return;}
  _applyReceiveToStock(line,n,dateStr);
  line.qtyReceived=already+n;line.receivedDate=dateStr||today();
  line.status=(line.qtyReceived>=ordered)?'received':'partial';
  dbSave('part_orders',line);window._poReceive=null;renderParts();
}
function receivePartOrder(id){var line=null;for(var i=0;i<(D.partOrders||[]).length;i++)if(D.partOrders[i].id===id){line=D.partOrders[i];break;}if(!line)return;var rem=(Number(line.qty)||0)-(Number(line.qtyReceived)||0);if(rem<=0)rem=Number(line.qty)||1;receivePartOrderQty(id,rem,today());}
function openReceivePanel(id){window._poReceive=id;window._poEdit=null;renderParts();}
function cancelReceive(){window._poReceive=null;renderParts();}
function confirmReceive(id){var q=document.getElementById('po-rec-qty'),d=document.getElementById('po-rec-date');receivePartOrderQty(id,q?Number(q.value):0,(d&&d.value)?d.value:today());}
function removePartOrder(id){if(!D.partOrders)return;if(!confirm('Remove this part from the order list?'))return;D.partOrders=D.partOrders.filter(function(o){return o.id!==id;});dbRemove('part_orders',id);renderParts();}
function editPartOrder(id){window._poEdit=id;renderParts();}
function createPartFromOrder(id){
  if(!D.partOrders)return;
  var o=null;for(var i=0;i<D.partOrders.length;i++)if(D.partOrders[i].id===id){o=D.partOrders[i];break;}
  if(!o)return;
  if(o.partId){alert('This order is already linked to an inventory part.');return;}
  var nm=(o.partName||'New part').trim();
  var isOil=/\boil\b/i.test(nm);
  if(!confirm('Create a new inventory part from this order?\n\n\u201c'+nm+'\u201d\n\nIt will be added to inventory and this order linked to it.'))return;
  var p={ id:nid('PRT'), name:nm, partNumber:(o.partNumber||''), vendors:(o.vendor||''),
    area:'', location:'', unit:(isOil?'qt':'each'),
    unitCost:(Number(o.unitCost)||0), qty:0, minQty:0,
    description:(isOil?'10W-30 full synthetic small-engine oil. Oil-change capacity per Honda GX spec: GX160/GX200 ~0.58 L (0.61 qt); GX270 ~1.1 L (1.16 qt). One 55-gal drum is ~220 qt.':''),
    engines:(isOil?['GX160','GX200','GX270']:[]),
    usedOn:(isOil?['Sprint Karts','Sodi GT5R (Euro)','Sodi SR5 (Euro)','Road Track F1000 (Single)','Road Track F3000 (Double)','Kiddie Karts']:[]),
    activeOverride:null, created:today(),
    totalCost:0 };
  if(!isOil&&typeof deriveUsedOn==='function')p.usedOn=deriveUsedOn(p);
  D.parts.push(p); dbSave('parts',p);
  if(isOil){ var gm=/([0-9]+(?:\.[0-9]+)?)\s*gal/i.exec(nm); if(gm){ var gal=parseFloat(gm[1]); p.purchaseUnit=gal+'-gal drum'; p.packSize=gal*4; p.purchaseCost=Number(o.unitCost)||0; p.unit='qt'; p.usagePerJob=0.6; if(p.packSize>0&&p.purchaseCost>0)p.unitCost=Math.round((p.purchaseCost/p.packSize)*10000)/10000; dbSave('parts',p); } }
  o.partId=p.id; if(!o.partNumber&&p.partNumber)o.partNumber=p.partNumber; dbSave('part_orders',o);
  window._poEdit=null;
  alert('Created \u201c'+p.name+'\u201d in inventory and linked this order to it.'+(isOil?' Tagged for all kart engines.':' Open it in Inventory to set engines, fitment, and min stock.'));
  renderParts();
}
function cancelPartOrderEdit(){window._poEdit=null;renderParts();}
function _partLinkOpts(sel){var h='<option value="">- not linked to inventory -</option>';var ps=(D.parts||[]).slice().sort(function(a,b){return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());});for(var i=0;i<ps.length;i++){h+='<option value="'+ps[i].id+'"'+(ps[i].id===sel?' selected':'')+'>'+esc(ps[i].name)+(ps[i].partNumber?' ('+esc(ps[i].partNumber)+')':'')+'</option>';}return h;}
function savePartOrderEdit(id){if(!D.partOrders)return;var o=null;for(var i=0;i<D.partOrders.length;i++)if(D.partOrders[i].id===id){o=D.partOrders[i];break;}if(!o)return;var g=function(x){var e=document.getElementById(x);return e?e.value:null;};var nm=(g('po-edit-name')||'').trim();if(nm)o.partName=nm;o.partNumber=(g('po-edit-pn')||'').trim();o.qty=Math.max(1,Number(g('po-edit-qty'))||1);o.unitCost=Math.max(0,Number(g('po-edit-cost'))||0);o.vendor=(g('po-edit-vendor')||'').trim();var link=g('po-edit-link');o.partId=link||null;if(o.partId){var p=null;for(var j=0;j<D.parts.length;j++)if(D.parts[j].id===o.partId){p=D.parts[j];break;}if(p){o.usedOn=p.usedOn||o.usedOn||[];if(!o.partNumber)o.partNumber=p.partNumber||'';}}dbSave('part_orders',o);window._poEdit=null;renderParts();}
function _pendingAdjHtml(){
  var reqs=(D.adjustRequests||[]).filter(function(r){return r.status==='pending';});
  if(!reqs.length)return '';
  var sup=(typeof isSupervisor!=='undefined'&&isSupervisor());
  var h='<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:12px;margin-bottom:14px">';
  h+='<div style="font-size:13px;font-weight:800;color:#9a3412;margin-bottom:8px">Pending stock adjustments ('+reqs.length+')</div>';
  for(var i=0;i<reqs.length;i++){var r=reqs[i];
    h+='<div style="border-top:1px solid #fed7aa;padding:8px 0">';
    h+='<div style="font-size:13px;font-weight:700">'+esc(r.partName)+'</div>';
    h+='<div style="font-size:12px;color:var(--muted)">'+r.systemQty+' → <b>'+r.actualQty+'</b> ('+(r.diff>=0?'+':'')+r.diff+') · '+esc(r.reason)+'</div>';
    h+='<div style="font-size:11px;color:var(--muted);margin-top:2px">Requested by '+esc(r.requestedBy)+' · '+esc(r.created)+'</div>';
    if(sup){
      h+='<div style="display:flex;gap:8px;margin-top:6px">';
      h+='<button onclick="approveAdj(\''+escA(r.id)+'\')" style="background:#16a34a;border:none;color:#fff;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Approve</button>';
      h+='<button onclick="rejectAdj(\''+escA(r.id)+'\')" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Reject</button>';
      h+='</div>';
    } else {
      h+='<div style="font-size:11px;color:#9a3412;margin-top:4px;font-weight:600">Awaiting manager approval</div>';
    }
    h+='</div>';
  }
  h+='</div>';
  return h;
}
function approveAdj(id){
  var reqs=D.adjustRequests||[];var r=null;for(var i=0;i<reqs.length;i++)if(reqs[i].id===id){r=reqs[i];break;}
  if(!r)return;
  for(var j=0;j<D.parts.length;j++)if(D.parts[j].id===r.pid){D.parts[j].qty=Math.max(0,Number(r.actualQty)||0);dbSave('parts',D.parts[j]);break;}
  r.status='approved';r.approvedBy=(currentUser&&currentUser.name)||'';r.approvedOn=today();dbSave('adjust_requests',r);
  renderParts();if(typeof updateBadges!=='undefined')updateBadges();
}
function rejectAdj(id){
  var reqs=D.adjustRequests||[];var r=null;for(var i=0;i<reqs.length;i++)if(reqs[i].id===id){r=reqs[i];break;}
  if(!r)return;
  r.status='rejected';r.approvedBy=(currentUser&&currentUser.name)||'';r.approvedOn=today();dbSave('adjust_requests',r);
  renderParts();if(typeof updateBadges!=='undefined')updateBadges();
}
function _poNorm(pn){return String(pn||'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function _matchOpenPO(partNumber, partId, name, excludeId){
  if(!D.partOrders)return null;
  var pn=_poNorm(partNumber), nm=(typeof ahNorm==='function'?ahNorm(name||''):String(name||'').toLowerCase());
  function by(test){for(var i=0;i<D.partOrders.length;i++){var o=D.partOrders[i];if(o.id===excludeId)continue;if(o.status==='received')continue;if(test(o))return o;}return null;}
  // Only auto-merge when it's unambiguously the SAME part number. Matching by
  // linked inventory record (partId) or by fuzzy name wrongly fuses distinct
  // catalog parts that share an over-broad inventory link or similar wording,
  // which silently drops lines from a multi-line purchase order. A real part
  // number is the only safe signal; with no part number, treat it as distinct.
  if(pn&&pn.length>=4){var m=by(function(o){var op=_poNorm(o.partNumber);return op&&op.length>=4&&op===pn;});if(m)return m;}
  return null;
}
function _mergePOInto(keeper, donor){
  keeper.qty=(Number(keeper.qty)||0)+(Number(donor.qty)||0);
  if((donor.status==='ordered'||donor.status==='received')&&keeper.status==='requested')keeper.status=donor.status;
  if(donor.orderedDate&&!keeper.orderedDate)keeper.orderedDate=donor.orderedDate;
  if(donor.receiptUrl&&!keeper.receiptUrl){keeper.receiptUrl=donor.receiptUrl;keeper.receiptName=donor.receiptName||'';}
  var dv=donor.vendor||'', kv=keeper.vendor||'';
  if(dv&&_poNorm(dv)!=='lvmgpinternal'&&(!kv||_poNorm(kv)==='lvmgpinternal'))keeper.vendor=dv;
  if((Number(donor.unitCost)||0)>0&&!(Number(keeper.unitCost)||0))keeper.unitCost=donor.unitCost;
  if(!keeper.partNumber&&donor.partNumber)keeper.partNumber=donor.partNumber;
  if(donor.note)keeper.note=(keeper.note?keeper.note+' · ':'')+donor.note;
  if(typeof dbSave!=='undefined')dbSave('part_orders',keeper);
}
function _poPushOrMerge(line){
  if(!D.partOrders)D.partOrders=[];
  var ex=_matchOpenPO(line.partNumber,line.partId,line.partName,line.id);
  if(ex){_mergePOInto(ex,line);} else {D.partOrders.push(line);if(typeof dbSave!=='undefined')dbSave('part_orders',line);}
}
function _poDupPNs(){
  var by={},pos=D.partOrders||[];
  for(var i=0;i<pos.length;i++){var o=pos[i];if(o.status==='received')continue;var pn=_poNorm(o.partNumber);if(!pn)continue;(by[pn]=by[pn]||[]).push(o);}
  var dups=[];for(var k in by)if(by[k].length>1)dups.push(k);
  return dups;
}
function mergePartOrdersByPN(pn){
  if(!D.partOrders)return;
  var norm=_poNorm(pn);
  var grp=D.partOrders.filter(function(o){return o.status!=='received'&&_poNorm(o.partNumber)===norm;});
  if(grp.length<2)return;
  var keeper=grp.filter(function(o){return o.partId;})[0]||grp.filter(function(o){return o.status==='requested';})[0]||grp[0];
  for(var i=0;i<grp.length;i++){var d=grp[i];if(d.id===keeper.id)continue;_mergePOInto(keeper,d);D.partOrders=D.partOrders.filter(function(o){return o.id!==d.id;});if(typeof dbRemove!=='undefined')dbRemove('part_orders',d.id);}
  if(typeof dbSave!=='undefined')dbSave('part_orders',keeper);
}
function mergeAllDupPartOrders(){
  var d=_poDupPNs();
  if(!d.length){alert('No duplicate part orders found.');return;}
  for(var i=0;i<d.length;i++)mergePartOrdersByPN(d[i]);
  window._poMergeReview=false;
  renderParts();
}
// Open / close the review screen (shown in place of the order list).
function openMergeReview(){window._poMergeReview=true;renderParts();}
function closeMergeReview(){window._poMergeReview=false;renderParts();}
// The review screen: every duplicate group laid out so you can see exactly
// what will combine (part, each line's qty + date + vendor, and the resulting
// merged qty) before committing. Merge one group or all of them from here.
function _mergeReviewHtml(){
  var dups=_poDupPNs();
  var h='<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 10px">';
  h+='<div style="font-size:13px;font-weight:800">Review duplicates</div>';
  h+='<button onclick="closeMergeReview()" style="background:#fff;border:1.5px solid var(--border);color:var(--muted);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">\u2039 Back to list</button></div>';
  if(!dups.length){h+='<div style="text-align:center;color:var(--muted);font-size:13px;padding:24px 10px">No duplicates to review \u2014 every part appears once.</div>';return h;}
  h+='<div style="font-size:11px;color:var(--muted);margin-bottom:10px">These parts appear more than once with the same part number. Merging combines each group into one line and <b>adds the quantities together</b>. Nothing is removed until you tap Merge.</div>';
  for(var di=0;di<dups.length;di++){
    var pn=dups[di];
    var grp=(D.partOrders||[]).filter(function(o){return o.status!=='received'&&_poNorm(o.partNumber)===pn;});
    if(grp.length<2)continue;
    var totQty=0;for(var g=0;g<grp.length;g++)totQty+=Number(grp[g].qty)||0;
    h+='<div style="background:var(--card);border:1.5px solid #fb923c;border-radius:11px;padding:11px 12px;margin-bottom:8px">';
    h+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:7px">';
    h+='<div style="min-width:0"><div style="font-size:13px;font-weight:800">'+esc(grp[0].partName)+'</div><div style="font-size:10px;color:var(--muted);font-family:monospace">'+esc(grp[0].partNumber||'')+'</div></div>';
    h+='<button onclick="mergePartOrdersByPN(\''+escA(pn)+'\');renderParts()" style="background:#ea580c;border:none;color:#fff;border-radius:7px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0;white-space:nowrap">Merge these '+grp.length+'</button></div>';
    for(var g=0;g<grp.length;g++){var o=grp[g];
      h+='<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--border);font-size:11px">';
      h+='<span style="color:var(--muted)">Qty <b style="color:var(--text)">'+esc(o.qty)+'</b>'+(o.vendor?' \u00b7 '+esc(o.vendor):'')+(o.orderedDate?' \u00b7 ordered '+esc(o.orderedDate):'')+(o.status==='requested'?' \u00b7 requested':'')+'</span>';
      h+='<button onclick="removePartOrder(\''+o.id+'\')" style="background:transparent;border:none;color:#dc2626;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0">Remove</button></div>';
    }
    h+='<div style="margin-top:7px;font-size:11px;font-weight:800;color:#16a34a">\u2192 Merges into one line, Qty '+totQty+'</div>';
    h+='</div>';
  }
  h+='<button onclick="mergeAllDupPartOrders()" style="width:100%;background:#ea580c;border:none;color:#fff;border-radius:10px;padding:11px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;margin-top:4px">Merge all '+dups.length+' group'+(dups.length===1?'':'s')+'</button>';
  return h;
}
function _partOrdersHtml(){
  if(window._poMergeReview)return _mergeReviewHtml();
  var pos=(D.partOrders||[]).slice();var h='';
  if(!pos.length){return '<div style="text-align:center;color:var(--muted);font-size:13px;padding:30px 10px">No parts on the order list yet.<br><span style="font-size:11px">Add parts from a work order\'s parts section \u2014 short or can\'t-find items land here.</span></div>';}
  var grp=window._poGroup||'part';
  var openPos=pos.filter(function(o){return o.status!=='received';});
  var recvPos=pos.filter(function(o){return (Number(o.qtyReceived)||0)>0;});
  var est=0;for(var i=0;i<openPos.length;i++)est+=(Number(openPos[i].unitCost)||0)*(Number(openPos[i].qty)||0);
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 4px">';
  h+='<div style="font-size:11px;color:var(--muted)">'+openPos.length+' open line'+(openPos.length===1?'':'s')+(est?' \u00b7 ~'+fmtM(est)+' est':'')+'</div>';
  h+='<div style="display:flex;gap:4px">';
  h+='<button onclick="window._poGroup=\'part\';renderParts()" style="padding:3px 9px;border-radius:100px;border:1.5px solid var(--border);background:'+(grp==='part'?'var(--accent)':'var(--card)')+';color:'+(grp==='part'?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">By part</button>';
  h+='<button onclick="window._poGroup=\'vendor\';renderParts()" style="padding:3px 9px;border-radius:100px;border:1.5px solid var(--border);background:'+(grp==='vendor'?'var(--accent)':'var(--card)')+';color:'+(grp==='vendor'?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">By vendor</button>';
  h+='</div></div>';
  var _dpn=_poDupPNs();
  if(_dpn.length)h+='<div style="background:#fff7ed;border:1.5px solid #fb923c;border-radius:10px;padding:8px 10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-size:12px;font-weight:800;color:#9a3412">⚠ '+_dpn.length+' part'+(_dpn.length===1?'':'s')+' on the list more than once (same part #)</span><button onclick="openMergeReview()" style="background:#ea580c;border:none;color:#fff;border-radius:7px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Review</button></div>';
  if(grp==='vendor')openPos.sort(function(a,b){return (a.vendor||'~').toLowerCase().localeCompare((b.vendor||'~').toLowerCase())||a.partName.toLowerCase().localeCompare(b.partName.toLowerCase());});
  else openPos.sort(function(a,b){return a.partName.toLowerCase().localeCompare(b.partName.toLowerCase());});
  var lastHdr=null;
  for(var i=0;i<openPos.length;i++){
    var o=openPos[i];
    if(!o.partId){var _lp=(o.partNumber&&typeof partByPN==='function')?partByPN(o.partNumber):null;if(!_lp&&typeof partByName==='function')_lp=partByName(o.partName);if(_lp){o.partId=_lp.id;if(!o.partNumber&&_lp.partNumber)o.partNumber=_lp.partNumber;if((!o.usedOn||!o.usedOn.length)&&_lp.usedOn)o.usedOn=_lp.usedOn.slice();dbSave('part_orders',o);}}
    if(grp==='vendor'){var hdr=o.vendor||'No vendor set';if(hdr!==lastHdr){h+='<div style="font-size:11px;font-weight:800;color:var(--accent);margin:9px 0 3px;text-transform:uppercase;letter-spacing:.3px">'+esc(hdr)+'</div>';lastHdr=hdr;}}
    if(window._poReceive===o.id){
      var _rem=(Number(o.qty)||0)-(Number(o.qtyReceived)||0);if(_rem<=0)_rem=Number(o.qty)||1;
      var _ri='width:100%;box-sizing:border-box;margin:2px 0 7px;border:1px solid var(--border);border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit';var _rl='font-size:10px;color:var(--muted);font-weight:700';
      h+='<div style="background:var(--card);border:1.5px solid #16a34a;border-radius:11px;padding:11px 12px;margin-bottom:7px">';
      h+='<div style="font-size:11px;font-weight:800;color:#16a34a;margin-bottom:3px">Receive \u201c'+esc(o.partName)+'\u201d</div>';
      h+='<div style="font-size:10px;color:var(--muted);margin-bottom:7px">'+(Number(o.qty)||0)+' ordered'+(((Number(o.qtyReceived)||0)>0)?', '+(Number(o.qtyReceived)||0)+' received so far':'')+'</div>';
      h+='<div style="display:flex;gap:8px"><div style="flex:1"><label style="'+_rl+'">How many received now?</label><input id="po-rec-qty" type="number" min="1" step="1" value="'+_rem+'" style="'+_ri+'"/></div><div style="flex:1"><label style="'+_rl+'">Received date</label><input id="po-rec-date" type="date" value="'+today()+'" style="'+_ri+'"/></div></div>';
      h+='<div style="font-size:10px;color:var(--muted);margin-bottom:4px">Receiving fewer than ordered leaves the rest on back order.</div>';
      h+='<div style="display:flex;gap:6px"><button onclick="confirmReceive(\''+o.id+'\')" style="background:#16a34a;border:none;color:#fff;border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Receive into stock</button><button onclick="cancelReceive()" style="background:#fff;border:1.5px solid var(--border);color:var(--muted);border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Cancel</button></div>';
      h+='</div>';continue;
    }
    if(window._poEdit===o.id){
      var _is='width:100%;box-sizing:border-box;margin:2px 0 7px;border:1px solid var(--border);border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit';
      var _ls='font-size:10px;color:var(--muted);font-weight:700';
      h+='<div style="background:var(--card);border:1.5px solid var(--accent);border-radius:11px;padding:11px 12px;margin-bottom:7px">';
      h+='<div style="font-size:11px;font-weight:800;color:var(--accent);margin-bottom:7px">Edit order line</div>';
      h+='<label style="'+_ls+'">Part name</label><input id="po-edit-name" value="'+esc(o.partName)+'" style="'+_is+'"/>';
      h+='<label style="'+_ls+'">Part number</label><input id="po-edit-pn" value="'+esc(o.partNumber||'')+'" style="'+_is+'"/>';
      h+='<div style="display:flex;gap:8px"><div style="flex:1"><label style="'+_ls+'">Qty</label><input id="po-edit-qty" type="number" min="1" value="'+(Number(o.qty)||1)+'" style="'+_is+'"/></div><div style="flex:1"><label style="'+_ls+'">Unit cost</label><input id="po-edit-cost" type="number" step="0.01" min="0" value="'+(Number(o.unitCost)||0)+'" style="'+_is+'"/></div></div>';
      h+='<label style="'+_ls+'">Vendor</label><input id="po-edit-vendor" list="vendorList" value="'+esc(o.vendor||'')+'" style="'+_is+'"/>';
      h+='<label style="'+_ls+'">Link to inventory part (so receiving adds to its stock)</label><select id="po-edit-link" style="'+_is+'">'+_partLinkOpts(o.partId)+'</select>';
      h+='<div style="display:flex;gap:6px;margin-top:4px"><button onclick="savePartOrderEdit(\''+o.id+'\')" style="background:#16a34a;border:none;color:#fff;border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Save</button><button onclick="cancelPartOrderEdit()" style="background:#fff;border:1.5px solid var(--border);color:var(--muted);border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Cancel</button></div>';
      h+='</div>';
      continue;
    }
    var sc=o.status==='received'?'#16a34a':(o.status==='partial'?'#d97706':(o.status==='ordered'?'#2563eb':'#d97706'));
    var sl=(o.status==='ordered')?('Ordered'+(o.orderedDate?' \u00b7 '+o.orderedDate:'')):(o.status==='partial')?('Partial \u00b7 '+(Number(o.qtyReceived)||0)+'/'+(Number(o.qty)||0)):(o.status==='received')?('Received'+(o.receivedDate?' \u00b7 '+o.receivedDate:'')):'Requested';
    var lu=partLastUsed(o.partName);
    var fit=(o.usedOn&&o.usedOn.length)?o.usedOn.join(', '):'\u2014';
    h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:11px;padding:10px 12px;margin-bottom:7px">';
    h+='<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">';
    h+='<div style="min-width:0"><div style="font-size:13px;font-weight:800">'+esc(o.partName)+(o.partNumber?' <span style="font-size:10px;color:var(--muted);font-family:monospace">'+esc(o.partNumber)+'</span>':'')+'</div>';
    h+='<div style="font-size:10px;color:var(--muted);margin-top:2px">Fits: '+esc(fit)+'</div></div>';
    h+='<span style="background:'+sc+'1a;color:'+sc+';border-radius:100px;padding:3px 9px;font-size:10px;font-weight:700;white-space:nowrap">'+sl+'</span></div>';
    h+='<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;font-size:10px;color:var(--muted)">';
    h+='<span><b style="color:var(--text)">Qty '+esc(o.qty)+'</b>'+(((Number(o.qtyReceived)||0)>0)?' \u00b7 '+(Number(o.qtyReceived)||0)+' received':'')+'</span>';
    if(o.orderedDate)h+='<span>Ordered: '+esc(o.orderedDate)+'</span>';
    if(o.receivedDate)h+='<span>Received: '+esc(o.receivedDate)+'</span>';
    var _rem=(Number(o.qty)||0)-(Number(o.qtyReceived)||0);
    if(o.status==='partial'&&_rem>0)h+='<span style="color:#b45309;font-weight:800">\u26a0 Back order: '+_rem+' due</span>';
    if(o.woId)h+='<span>For: '+esc(o.woId)+(o.assetId?' \u00b7 '+esc(o.assetId):'')+'</span>';
    if(o.vendor&&grp!=='vendor')h+='<span>Vendor: '+esc(o.vendor)+'</span>';
    if(lu)h+='<span>Last used: '+esc(lu)+'</span>';
    h+='</div>';
    h+='<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">';
    if(o.status==='requested')h+='<button onclick="setPartOrderStatus(\''+o.id+'\',\'ordered\')" style="background:#2563eb;border:none;color:#fff;border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Mark ordered</button>';
    h+='<button onclick="openReceivePanel(\''+o.id+'\')" style="background:#16a34a;border:none;color:#fff;border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">'+(o.status==='partial'?'Receive rest\u2026':'Receive\u2026')+'</button>';
    if(!o.partId)h+='<button onclick="createPartFromOrder(\''+o.id+'\')" style="background:#7c3aed;border:none;color:#fff;border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">+ New part</button>';
    h+='<button onclick="editPartOrder(\''+o.id+'\')" style="background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Edit</button>';
    if(o.receiptUrl)h+='<a href="'+escA(o.receiptUrl)+'" target="_blank" rel="noopener" style="background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700;text-decoration:none">📎 Receipt</a>';
    h+='<button data-msg="Re: parts order — '+escA(o.partName)+(o.woTitle?(' (for '+escA(o.woTitle)+')'):'')+'" onclick="openMsgTo(this.dataset.msg,\'\')" style="background:transparent;border:1px solid var(--border);color:var(--accent);border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">💬 Message</button>';
    h+='<button onclick="removePartOrder(\''+o.id+'\')" style="background:transparent;border:none;color:#dc2626;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;margin-left:auto">Remove</button>';
    h+='</div></div>';
  }
  // Recently Received \u2014 filtered by a chosen date range
  if(window._recvFrom===undefined)window._recvFrom=(typeof _dateMinusDays==='function')?_dateMinusDays(30):'';
  if(window._recvTo===undefined)window._recvTo=today();
  var _rf=window._recvFrom||'',_rt=window._recvTo||'';
  var _inr=recvPos.filter(function(o){var d=o.receivedDate||'';return d&&(!_rf||d>=_rf)&&(!_rt||d<=_rt);});
  _inr.sort(function(a,b){return String(b.receivedDate||'').localeCompare(String(a.receivedDate||''));});
  var _di='border:1px solid var(--border);border-radius:7px;padding:5px 7px;font-size:12px;font-family:inherit;background:var(--bg)';
  h+='<div style="font-size:11px;font-weight:800;color:#16a34a;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.3px">Recently Received</div>';
  h+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:var(--muted)">';
  h+='<span>From</span><input type="date" value="'+escA(_rf)+'" onchange="window._recvFrom=this.value;renderParts()" style="'+_di+'"/>';
  h+='<span>to</span><input type="date" value="'+escA(_rt)+'" onchange="window._recvTo=this.value;renderParts()" style="'+_di+'"/>';
  h+='<span style="margin-left:auto;font-weight:700">'+_inr.length+' received</span></div>';
  if(!_inr.length)h+='<div style="text-align:center;color:var(--muted);font-size:12px;padding:14px 0">No parts received between these dates.</div>';
  for(var r=0;r<_inr.length;r++){var o=_inr[r];var _bo=(Number(o.qty)||0)-(Number(o.qtyReceived)||0);
    h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:11px;padding:9px 12px;margin-bottom:6px">';
    h+='<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">';
    h+='<div style="min-width:0"><div style="font-size:12px;font-weight:800">'+esc(o.partName)+(o.partNumber?' <span style="font-size:10px;color:var(--muted);font-family:monospace">'+esc(o.partNumber)+'</span>':'')+'</div>';
    h+='<div style="font-size:10px;color:var(--muted);margin-top:2px">'+(Number(o.qtyReceived)||0)+' received'+(o.vendor?' \u00b7 '+esc(o.vendor):'')+(o.orderedDate?' \u00b7 ordered '+esc(o.orderedDate):'')+((o.status==='partial'&&_bo>0)?' \u00b7 <span style="color:#b45309;font-weight:800">'+_bo+' still on order</span>':'')+'</div></div>';
    h+='<span style="background:#16a34a1a;color:#16a34a;border-radius:100px;padding:3px 9px;font-size:10px;font-weight:700;white-space:nowrap">Received \u00b7 '+esc(o.receivedDate||'')+'</span></div>';
    h+='<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">';
    if(o.receiptUrl)h+='<a href="'+escA(o.receiptUrl)+'" target="_blank" rel="noopener" style="background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700;text-decoration:none">\ud83d\udcce Receipt</a>';
    if(o.status==='received')h+='<button onclick="removePartOrder(\''+o.id+'\')" style="background:transparent;border:none;color:#dc2626;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;margin-left:auto">Clear</button>';
    h+='</div></div>';
  }
  return h;
}

/* ===== Engine Diagrams (parts lookup by exploded view) ===== */
function _normPN(s){return String(s||'').toUpperCase().replace(/\u2013/g,'-').replace(/\s+/g,'').trim();}
function partByPN(pn){
  var k=_normPN(pn);if(!k||!D.parts)return null;
  for(var i=0;i<D.parts.length;i++)if(_normPN(D.parts[i].partNumber)===k)return D.parts[i];
  for(var i=0;i<D.parts.length;i++)if(_normPN(D.parts[i].name).indexOf(k)>=0)return D.parts[i];
  return null;
}
function diagAddToOrder(diagId,ix){
  var d=(D.engineDiagrams||[]).filter(function(x){return x.id===diagId;})[0];if(!d)return;
  var pt=d.parts[ix];if(!pt)return;var inv=partByPN(pt.pn);
  if(inv){addPartOrder(inv.name,pt.reqQty||1,'','','');}
  else{if(!D.partOrders)D.partOrders=[];var line={id:nid('PO'),partId:null,partName:pt.desc,partNumber:pt.pn,qty:pt.reqQty||1,woId:'',woTitle:d.engine+' '+d.system,assetId:'',vendor:'',unitCost:Number(pt.price)||0,usedOn:[],status:'requested',orderedDate:'',created:today(),addedBy:(currentUser&&currentUser.name)||''};D.partOrders.push(line);dbSave('part_orders',line);}
  alert('Added \u201c'+pt.desc+'\u201d to the order list.');renderParts();
}

// ── VENDOR LIST + RESERVED/AVAILABLE ────────────────────────
function _allVendorNames(){
  var seen={},out=[];
  function add(n){n=String(n||"").trim();if(!n)return;var k=n.toLowerCase();if(seen[k])return;seen[k]=1;out.push(n);}
  (D.vendors||[]).forEach(function(v){add(v.name||v.id);});
  (D.parts||[]).forEach(function(p){add(p.vendors);});
  (D.partOrders||[]).forEach(function(o){add(o.vendor);});
  out.sort(function(a,b){return a.toLowerCase().localeCompare(b.toLowerCase());});
  return out;
}
function fillVendorDatalist(){
  var dl=document.getElementById("vendorList");if(!dl)return;
  var ns=_allVendorNames(),h='';for(var i=0;i<ns.length;i++)h+="<option value='"+escA(ns[i])+"'></option>";
  dl.innerHTML=h;
}
function partReservedQty(part){
  if(!D.workOrders)return 0;
  var k=ahNorm(part.name),sum=0;
  for(var i=0;i<D.workOrders.length;i++){var w=D.workOrders[i];
    if(w.status==="completed")continue;if(w.vendorPartsProvided)continue;
    var pu=w.partsUsed||[],use=w.partsUse||{};
    for(var j=0;j<pu.length;j++){if(ahNorm(pu[j].name)===k){if(use[pu[j].name]==="used")continue;sum+=Number(pu[j].qty)||0;}}
  }
  return sum;
}
function partAvailableQty(part){return (Number(part.qty)||0)-partReservedQty(part);}

// ── PARTS WEAVE: fleet class map, diagram sync, Fits, active/inactive ──────────
function kartClassOf(k){
  if(!k)return null;
  if(k.track==='sprint')return 'Sprint Karts';
  if(k.track==='kiddie')return 'Kiddie Karts';
  if(k.track==='euro')return (/sr5/i.test(k.kartType||''))?'Sodi SR5 (Euro)':'Sodi GT5R (Euro)';
  if(k.track==='road')return (typeof PM_F3000_ROAD!=='undefined'&&PM_F3000_ROAD.indexOf(+k.num)>=0)?'Road Track F3000 (Double)':'Road Track F1000 (Single)';
  return null;
}
function _engineClassMap(){
  var m={};var ks=D.karts||[];
  for(var i=0;i<ks.length;i++){var k=ks[i];var e=k.engine,c=kartClassOf(k);if(!e||!c)continue;(m[e]=m[e]||{});m[e][c]=1;}
  var out={};for(var e in m)out[e]=Object.keys(m[e]);
  return out;
}
function _partDiagEngines(part){
  var out={},ds=D.engineDiagrams||[];
  var pn=(typeof _normPN==='function')?_normPN(part.partNumber):String(part.partNumber||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  var nm=(typeof ahNorm==='function')?ahNorm(part.name):String(part.name||'').toLowerCase();
  for(var i=0;i<ds.length;i++){var d=ds[i],pts=d.parts||[];for(var j=0;j<pts.length;j++){var pt=pts[j];
    var ppn=(typeof _normPN==='function')?_normPN(pt.pn):String(pt.pn||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    var pnm=(typeof ahNorm==='function')?ahNorm(pt.desc):String(pt.desc||'').toLowerCase();
    if((pn&&ppn&&pn===ppn)||(nm&&pnm&&nm===pnm)){if(d.engine)out[d.engine]=1;break;}
  }}
  return Object.keys(out);
}
function deriveUsedOn(part){
  var map=_engineClassMap();
  var engs=(part.engines||[]).slice();
  var de=_partDiagEngines(part);for(var i=0;i<de.length;i++)if(engs.indexOf(de[i])<0)engs.push(de[i]);
  var cls={};for(var j=0;j<engs.length;j++){var cs=map[engs[j]]||[];for(var k=0;k<cs.length;k++)cls[cs[k]]=1;}
  return Object.keys(cls);
}
function _dateMinusDays(n){var d=new Date();d.setDate(d.getDate()-n);return d.toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});}
function partLastActivity(part){
  var latest=(typeof partLastUsed==='function')?(partLastUsed(part.name)||''):'';
  var pos=D.partOrders||[];
  var pn=(typeof _normPN==='function')?_normPN(part.partNumber):'';
  for(var i=0;i<pos.length;i++){var o=pos[i];
    var m=(o.partId&&o.partId===part.id)||(pn&&_normPN(o.partNumber)===pn)||(ahNorm(o.partName)===ahNorm(part.name));
    if(!m)continue;var d=o.orderedDate||o.created||'';if(d>latest)latest=d;}
  if(part.lastReceived&&part.lastReceived>latest)latest=part.lastReceived;
  if(part.lastUpdated&&part.lastUpdated>latest)latest=part.lastUpdated;
  return latest;
}
function isPartActive(part){
  if(part.activeOverride===true)return true;
  if(part.activeOverride===false)return false;
  if((Number(part.qty)||0)>0)return true;
  if((Number(part.minQty)||0)>0)return true;
  var la=partLastActivity(part);
  return !!la && la>=_dateMinusDays(365);
}
function partActiveReason(part){
  if(part.activeOverride===true)return 'Active (set by hand)';
  if(part.activeOverride===false)return 'Inactive (set by hand)';
  if((Number(part.qty)||0)>0)return 'Active (in stock)';
  if((Number(part.minQty)||0)>0)return 'Active (has a minimum to keep stocked)';
  var la=partLastActivity(part);
  if(la&&la>=_dateMinusDays(365))return 'Active (used in last 12 months)';
  return 'Inactive (no stock, not used in 12 months)';
}
function syncDiagramPartsToInventory(){
  var ds=D.engineDiagrams||[];if(!ds.length){alert('No diagrams to pull from yet.');return;}
  var created=0,updated=0;
  for(var i=0;i<ds.length;i++){var d=ds[i],pts=d.parts||[];
    for(var j=0;j<pts.length;j++){var pt=pts[j];if(!pt||(!pt.pn&&!pt.desc))continue;
      var inv=(pt.pn&&typeof partByPN==='function')?partByPN(pt.pn):null;
      if(!inv&&pt.desc&&typeof partByName==='function')inv=partByName(pt.desc);
      if(inv){
        var ch=false;
        if(!inv.partNumber&&pt.pn){inv.partNumber=pt.pn;ch=true;}
        if(!inv.description&&pt.desc){inv.description=pt.desc;ch=true;}
        if(!(Number(inv.unitCost)||0)&&Number(pt.price)){inv.unitCost=Number(pt.price);ch=true;}
        inv.engines=inv.engines||[];if(d.engine&&inv.engines.indexOf(d.engine)<0){inv.engines.push(d.engine);ch=true;}
        var du=deriveUsedOn(inv);inv.usedOn=inv.usedOn||[];for(var u=0;u<du.length;u++)if(inv.usedOn.indexOf(du[u])<0){inv.usedOn.push(du[u]);ch=true;}
        if(ch){dbSave('parts',inv);updated++;}
      } else {
        var np={id:nid('PRT'),name:pt.desc||pt.pn,partNumber:pt.pn||'',sku:'',area:'',location:'',
          description:pt.desc||'',qty:0,minQty:0,unitCost:Number(pt.price)||0,totalCost:0,
          vendors:'',types:'',engines:d.engine?[d.engine]:[],usedOn:[],fromDiagram:true,
          activeOverride:null,created:today()};
        np.usedOn=deriveUsedOn(np);
        D.parts.push(np);dbSave('parts',np);created++;
      }
    }
  }
  alert('Diagram parts pulled into inventory.\n\nNew parts added: '+created+'\nExisting parts enriched: '+updated+'\n\nNew ones come in at 0 stock and Inactive, but stay searchable and you can attach orders to them.');
  renderParts();
}
function refreshAllFits(){
  var n=0,ps=D.parts||[];
  for(var i=0;i<ps.length;i++){var p=ps[i];var du=deriveUsedOn(p);var ch=false;p.usedOn=p.usedOn||[];
    for(var u=0;u<du.length;u++)if(p.usedOn.indexOf(du[u])<0){p.usedOn.push(du[u]);ch=true;}
    if(ch){dbSave('parts',p);n++;}}
  alert('Updated Fits on '+n+' part'+(n===1?'':'s')+' from diagrams (hand-picked classes were kept).');
  renderParts();
}

function _diagramsHtml(){
  var ds=(D.engineDiagrams||[]);
  if(!ds.length)return '<div style="text-align:center;color:var(--muted);font-size:13px;padding:30px 10px">No engine diagrams yet.<br><span style="font-size:11px">Send a screenshot of an exploded view and it gets added here.</span></div>';
  var _dgbtns='<div style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px"><button onclick="syncDiagramPartsToInventory()" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Pull diagram parts into inventory</button><button onclick="refreshAllFits()" style="background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:8px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Refresh Fits</button></div>';
  var engs=[];ds.forEach(function(d){if(engs.indexOf(d.engine)<0)engs.push(d.engine);});
  var eng=window._diagEngine;if(engs.indexOf(eng)<0)eng=engs[0];
  var systems=[];ds.forEach(function(d){if(d.engine===eng&&systems.indexOf(d.system)<0)systems.push(d.system);});
  var sys=window._diagSystem;if(systems.indexOf(sys)<0)sys=systems[0];
  var h=_dgbtns;
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:2px">';
  engs.forEach(function(e){var on=e===eng;h+='<button onclick="window._diagEngine=\''+e+'\';window._diagSystem=null;renderParts()" style="padding:4px 13px;border-radius:100px;border:1.5px solid '+(on?'#4338ca':'var(--border)')+';background:'+(on?'#4338ca':'var(--card)')+';color:'+(on?'#fff':'var(--muted)')+';font-size:11px;font-weight:800;cursor:pointer;font-family:inherit">'+esc(e)+'</button>';});
  h+='</div>';
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap">';
  for(var si=0;si<systems.length;si++){var sname=systems[si],on=sname===sys;h+='<button data-sys="'+esc(sname)+'" onclick="window._diagSystem=this.dataset.sys;renderParts()" style="padding:3px 10px;border-radius:100px;border:1.5px solid var(--border);background:'+(on?'var(--accent)':'var(--card)')+';color:'+(on?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">'+esc(sname)+'</button>';}
  h+='</div>';
  var diag=null;ds.forEach(function(d){if(d.engine===eng&&d.system===sys)diag=d;});
  if(!diag)return h;
  if(diag.image){
  h+='<div style="margin-top:6px;background:#fff;border:1px solid var(--border);border-radius:11px;padding:8px;text-align:center">';
  h+='<img src="'+esc(diag.image)+'" style="max-width:100%;border-radius:6px;cursor:zoom-in" onclick="openImgViewer(this.src)" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'block\'"/>';
  h+='<div style="display:none;color:var(--muted);font-size:12px;padding:24px 10px">Diagram image not uploaded yet.<br>Drop <b style="font-family:monospace">'+esc(diag.image)+'</b> into your repo.</div>';
  h+='</div>';
  }
  h+='<div style="font-size:11px;color:var(--muted);margin-top:8px;margin-bottom:2px">'+esc(eng)+' \u00b7 '+esc(sys)+' \u2014 '+diag.parts.length+' parts \u00b7 green = you stock it</div>';
  for(var ix=0;ix<diag.parts.length;ix++){
    var pt=diag.parts[ix],inv=partByPN(pt.pn),stocked=!!inv,oh=stocked?(Number(inv.qty)||0):null;
    var loc=stocked?(inv.area||inv.location||''):'';
    var bc=stocked?(oh>0?'#16a34a':'#d97706'):'#94a3b8';
    var bt=stocked?(oh>0?('In stock: '+oh):'Out (0)'):'Not stocked';
    h+='<div style="background:var(--card);border:1px solid var(--border);border-left:3px solid '+bc+';border-radius:9px;padding:9px 11px;margin-bottom:6px;'+(stocked?'cursor:pointer':'')+'"'+(stocked?' data-editpid="'+inv.id+'" onclick="openEditPart(this.dataset.editpid)"':'')+'>';
    h+='<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">';
    h+='<div style="min-width:0"><div style="font-size:12px;font-weight:800"><span style="display:inline-block;min-width:18px;color:var(--muted)">'+esc(pt.ref)+'.</span>'+esc(pt.desc)+'</div>';
    h+='<div style="font-size:10px;color:var(--muted);font-family:monospace;margin-top:1px;margin-left:18px">'+esc(pt.pn)+(pt.reqQty?' \u00b7 req '+esc(pt.reqQty):'')+'</div></div>';
    h+='<div style="text-align:right;flex-shrink:0"><div style="font-size:10px;font-weight:800;color:'+bc+'">'+bt+'</div>'+(loc?'<div style="font-size:9px;color:var(--muted)">'+esc(loc)+'</div>':'')+(pt.price?'<div style="font-size:11px;font-family:monospace;color:var(--muted);margin-top:2px">$'+Number(pt.price).toFixed(2)+'</div>':'')+'</div>';
    h+='</div>';
    h+='<div style="margin-top:7px"><button onclick="event.stopPropagation();diagAddToOrder(\''+diag.id+'\','+ix+')" style="background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:7px;padding:3px 11px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">Add to order</button>'+(stocked?'<span style="font-size:10px;color:var(--muted);margin-left:8px">tap row to open part</span>':'')+'</div>';
    h+='</div>';
  }
  return h;
}

function renderParts(){
  var el=document.getElementById('tab-parts');if(!el)return;
  var h='<div class="scroll"><div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px">';
  var _pv=window._partsView||'inventory';var _ocount=(D.partOrders||[]).length+((D.adjustRequests||[]).filter(function(r){return r.status==='pending';}).length);
  h+='<div style="display:flex;gap:6px">';
  h+='<button onclick="window._partsView=\'inventory\';renderParts()" style="flex:1;padding:7px;border-radius:9px;border:1.5px solid var(--border);background:'+(_pv==='inventory'?'var(--accent)':'var(--card)')+';color:'+(_pv==='inventory'?'#fff':'var(--muted)')+';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Inventory</button>';
  h+='<button onclick="window._partsView=\'orders\';renderParts()" style="flex:1;padding:7px;border-radius:9px;border:1.5px solid var(--border);background:'+(_pv==='orders'?'var(--accent)':'var(--card)')+';color:'+(_pv==='orders'?'#fff':'var(--muted)')+';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Order List'+(_ocount?' ('+_ocount+')':'')+'</button>';
  h+='<button onclick="window._partsView=\'diagrams\';renderParts()" style="flex:1;padding:7px;border-radius:9px;border:1.5px solid var(--border);background:'+(_pv==='diagrams'?'var(--accent)':'var(--card)')+';color:'+(_pv==='diagrams'?'#fff':'var(--muted)')+';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Diagrams</button>';
  h+='</div>';
  if(_pv==='orders'){h+=_pendingAdjHtml()+_partOrdersHtml();h+='</div></div>';el.innerHTML=h;return;}
  if(_pv==='diagrams'){h+=_diagramsHtml();h+='</div></div>';el.innerHTML=h;return;}

  // Search + add
  var _q=((document.getElementById('parts-search')||{}).value||'');
  h+='<div style="display:flex;gap:6px">';
  h+='<input id="parts-search" value="'+esc(_q)+'" oninput="renderParts()" placeholder="Search parts..." style="flex:1;border:1.5px solid var(--border);border-radius:9px;padding:7px 10px;font-size:12px;font-family:inherit;background:var(--bg)"/>';
  h+='<button onclick="openPartModal()" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">+ Add</button>';
  h+='<button onclick="openPartReqModal()" style="background:#7c3aed;border:none;color:#fff;border-radius:9px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Request Parts</button>';
  h+='<button onclick="openInvCount()" style="background:#0d9488;border:none;color:#fff;border-radius:9px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Count</button>';
  h+='</div>';

  // Group filter pills
  var groups=['All'].concat(ASSET_CLASSES);
  var ag=window._partsGroup||'All';
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap">';
  for(var gi=0;gi<groups.length;gi++){
    var g=groups[gi];var on=ag===g;
    h+='<button onclick="window._partsGroup=\''+g+'\';renderParts()" style="padding:3px 9px;border-radius:100px;border:1.5px solid var(--border);background:'+(on?'var(--accent)':'var(--card)')+';color:'+(on?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">'+g+'</button>';
  }
  h+='</div>';

  // Exclude (hide) category pills
  var _pex=window._partsExclude||{};
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center"><span style="font-size:10px;font-weight:800;color:var(--muted);margin-right:2px">HIDE:</span>';
  for(var xi=0;xi<ASSET_CLASSES.length;xi++){var xc=ASSET_CLASSES[xi];var xon=!!_pex[xc];
    h+='<button onclick="togglePartsExclude(\''+escA(xc)+'\')" style="padding:3px 9px;border-radius:100px;border:1.5px solid '+(xon?'#ef4444':'var(--border)')+';background:'+(xon?'#ef4444':'var(--card)')+';color:'+(xon?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;'+(xon?'text-decoration:line-through':'')+'">'+esc(xc)+'</button>';
  }
  h+='</div>';

  // Engine filter pills
  var _engs=['All'].concat(ENGINE_TYPES);var ae=window._partsEngine||'All';
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap">';
  for(var ti=0;ti<_engs.length;ti++){var et=_engs[ti];var eon=ae===et;
    h+='<button onclick="window._partsEngine=\''+et+'\';renderParts()" style="padding:3px 9px;border-radius:100px;border:1.5px solid '+(eon?'#4338ca':'var(--border)')+';background:'+(eon?'#4338ca':'var(--card)')+';color:'+(eon?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">'+(et==='All'?'All engines':et)+'</button>';}
  h+='</div>';

  // Active filter pills
  var _af=window._partsActive||'active';
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap">';
  ['active','inactive','all'].forEach(function(v){var on=_af===v;var lbl=v==='active'?'Active':(v==='inactive'?'Inactive':'All');h+='<button onclick="window._partsActive=\''+v+'\';renderParts()" style="padding:3px 11px;border-radius:100px;border:1.5px solid '+(on?'#0d9488':'var(--border)')+';background:'+(on?'#0d9488':'var(--card)')+';color:'+(on?'#fff':'var(--muted)')+';font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">'+lbl+'</button>';});
  h+='</div>';

  // Filter
  var st=_q.toLowerCase().trim();
  var fp=D.parts.filter(function(p){
    if(!st&&_af!=='all'){var _act=isPartActive(p);if(_af==='active'&&!_act)return false;if(_af==='inactive'&&_act)return false;}
    if(ag!=='All'&&(p.usedOn||[]).indexOf(ag)<0) return false;
    if(ae!=='All'&&(p.engines||[]).indexOf(ae)<0) return false;
    var _ex=window._partsExclude||{};if(p.usedOn&&p.usedOn.length){for(var _e=0;_e<p.usedOn.length;_e++)if(_ex[p.usedOn[_e]])return false;}
    if(st){
      var hay=(p.name+' '+(p.partNumber||'')+' '+(p.description||'')+' '+(p.area||'')).toLowerCase();
      if(hay.indexOf(st)<0) return false;
    }
    return true;
  });

  h+='<div style="font-size:11px;color:var(--muted)">'+fp.length+' parts'+(ag!=='All'?' · '+ag:'')+(ae!=='All'?' · '+ae:'')+'</div>';

  // Card list — two lines per part
  for(var i=0;i<fp.length;i++){
    var p=fp[i];
    var isLow=p.qty>0&&p.qty<=p.minQty;
    var isOut=p.qty<=0&&p.minQty>0;
    var qtyColor=isOut?'#ef4444':isLow?'#f59e0b':'#22c55e';

    h+='<div data-editpid="'+p.id+'" onclick="openEditPart(this.dataset.editpid)" style="background:var(--card);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,.06);cursor:pointer">';
    if(p.photo)h+='<img src="'+p.photo+'" style="width:42px;height:42px;object-fit:cover;border-radius:7px;flex-shrink:0;border:1px solid var(--border)"/>';

    // Left: name + part number
    h+='<div style="flex:1;min-width:0">';
    h+='<div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.name)+'</div>';
    h+='<div style="font-size:10px;color:var(--muted);margin-top:1px">';
    if(p.partNumber)h+=esc(p.partNumber);
    if(p.partNumber&&p.area)h+=' · ';
    if(p.area)h+=esc(p.area);
    if(!p.partNumber&&!p.area)h+='—';
    h+='</div>';
    if(typeof isPartActive==='function'&&!isPartActive(p))h+='<div style="margin-top:3px"><span style="font-size:9px;font-weight:800;background:#f1f5f9;color:#64748b;border-radius:5px;padding:1px 6px">INACTIVE</span></div>';
    var _oo=partOnOrderQty(p.name);
    if(p.packSize>0&&p.purchaseCost>0)h+='<div style="font-size:9px;color:var(--muted);margin-top:1px">'+esc(p.purchaseUnit||'pack')+' $'+Number(p.purchaseCost).toFixed(2)+' \u00b7 '+p.packSize+' '+esc(p.unit||'')+' @ $'+(p.purchaseCost/p.packSize).toFixed(2)+'/'+esc(p.unit||'')+(p.usagePerJob>0?' \u00b7 '+p.usagePerJob+'/use \u2248 $'+((p.purchaseCost/p.packSize)*p.usagePerJob).toFixed(2):'')+'</div>';
    if(_oo>0)h+='<div style="margin-top:3px"><span style="font-size:9px;font-weight:800;background:#ede9fe;color:#5b21b6;border-radius:5px;padding:1px 6px">'+_oo+' on order</span></div>';
    var _rsv=(typeof partReservedQty==='function')?partReservedQty(p):0;
    if(_rsv>0)h+='<div style="margin-top:3px"><span style="font-size:9px;font-weight:800;background:#fef3c7;color:#92400e;border-radius:5px;padding:1px 6px">'+_rsv+' reserved · '+partAvailableQty(p)+' available</span></div>';
    if(p.engines&&p.engines.length){h+='<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px">';for(var ei=0;ei<p.engines.length;ei++)h+='<span style="font-size:9px;font-weight:800;background:#eef2ff;color:#4338ca;border-radius:5px;padding:1px 6px">'+esc(p.engines[ei])+'</span>';h+='</div>';}
    h+='</div>';

    // Right: cost + stock badge + adj buttons
    h+='<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">';
    if(p.unitCost>0)h+='<span style="font-size:11px;font-family:monospace;color:var(--muted)">$'+p.unitCost.toFixed(2)+'</span>';
    h+='<div style="text-align:center;min-width:32px;padding:3px 6px;border-radius:6px;background:'+(isOut?'#fee2e2':isLow?'#fef3c7':'#f0fdf4')+'">';
    h+='<div style="font-size:13px;font-weight:900;color:'+qtyColor+'">'+p.qty+'</div>';
    h+='<div style="font-size:8px;color:'+qtyColor+';font-weight:700">'+(isOut?'OUT':isLow?'LOW':'in stk')+'</div>';
    h+='</div>';
    h+='<div style="display:flex;flex-direction:column;gap:3px">';
    h+='<button data-pid="'+p.id+'" data-adj="-1" onclick="event.stopPropagation();adjPBtn(this)" style="width:26px;height:22px;border-radius:5px;border:1.5px solid var(--border);background:var(--bg);font-size:14px;font-weight:700;cursor:pointer;line-height:1">−</button>';
    h+='<button data-pid="'+p.id+'" onclick="event.stopPropagation();adjPBtn2(this)" style="width:26px;height:22px;border-radius:5px;border:1.5px solid var(--border);background:var(--bg);font-size:14px;font-weight:700;cursor:pointer;line-height:1">+</button>';
    h+='<button data-adjustpid="'+p.id+'" onclick="event.stopPropagation();openPartAdjRequest(this.dataset.adjustpid)" style="font-size:9px;font-weight:700;color:var(--muted);background:none;border:none;cursor:pointer;font-family:inherit;margin-top:2px;display:block">adj</button>';
    h+='</div></div></div>';
  }

  h+='<div style="height:60px"></div></div></div>';
  el.innerHTML=h;
  if(typeof fillVendorDatalist==='function')fillVendorDatalist();
  var _si=document.getElementById('parts-search');if(_si&&_q!==''){_si.focus();try{_si.setSelectionRange(_q.length,_q.length);}catch(e){}}
}

function togglePartsExclude(cls){if(!window._partsExclude)window._partsExclude={};if(window._partsExclude[cls])delete window._partsExclude[cls];else window._partsExclude[cls]=true;renderParts();}
function openInvCount(){
  var _q=((document.getElementById('parts-search')||{}).value||'').toLowerCase().trim();
  var ag=window._partsGroup||'All',ae=window._partsEngine||'All',_af=window._partsActive||'active',_ex=window._partsExclude||{};
  var fp=D.parts.filter(function(p){
    if(!_q&&_af!=='all'){var _act=isPartActive(p);if(_af==='active'&&!_act)return false;if(_af==='inactive'&&_act)return false;}
    if(ag!=='All'&&(p.usedOn||[]).indexOf(ag)<0)return false;
    if(ae!=='All'&&(p.engines||[]).indexOf(ae)<0)return false;
    if(p.usedOn&&p.usedOn.length){for(var e=0;e<p.usedOn.length;e++)if(_ex[p.usedOn[e]])return false;}
    if(_q){var hay=(p.name+' '+(p.partNumber||'')+' '+(p.description||'')+' '+(p.area||'')).toLowerCase();if(hay.indexOf(_q)<0)return false;}
    return true;
  });
  var cap=400,more=fp.length>cap;if(more)fp=fp.slice(0,cap);
  var h='<div style="font-size:12px;color:var(--muted);margin-bottom:8px">'+fp.length+' part'+(fp.length===1?'':'s')+' match your current filters. Type the count you physically have; leave blank to skip.'+(more?' <b style="color:#f59e0b">Showing first '+cap+' \u2014 narrow your filters to count a section.</b>':'')+'</div>';
  for(var i=0;i<fp.length;i++){var p=fp[i];
    h+='<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)"><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.name)+'</div><div style="font-size:10px;color:var(--muted)">'+(p.partNumber?esc(p.partNumber)+' \u00b7 ':'')+'on hand: '+(Number(p.qty)||0)+'</div></div><input type="number" inputmode="numeric" data-cntpid="'+escA(p.id)+'" placeholder="'+(Number(p.qty)||0)+'" style="width:74px;border:1.5px solid var(--border);border-radius:8px;padding:7px;font-size:13px;font-family:inherit;text-align:center"/></div>';
  }
  if(!fp.length)h+='<div style="font-size:13px;color:var(--muted);padding:8px 0">No parts match \u2014 adjust your filters or search.</div>';
  var b=document.getElementById('invcount-body');if(b)b.innerHTML=h;
  openM('invCountModal');
}
function saveInvCount(){
  var rows=document.querySelectorAll('#invcount-body input[data-cntpid]');var n=0,counted=0;
  for(var i=0;i<rows.length;i++){var el=rows[i];var v=el.value;if(v===''||v==null)continue;var nv=Math.round(Number(v));if(isNaN(nv)||nv<0)continue;var pid=el.getAttribute('data-cntpid');var p=null;for(var j=0;j<D.parts.length;j++)if(D.parts[j].id===pid){p=D.parts[j];break;}if(!p)continue;counted++;p.lastCycleCount=today();p.lastCountBy=(currentUser&&currentUser.name)||'';if((Number(p.qty)||0)!==nv){p.qty=nv;n++;}dbSave('parts',p);}
  closeM('invCountModal');
  alert(counted?('Counted '+counted+' part'+(counted===1?'':'s')+(n?' \u2014 '+n+' stock level'+(n===1?'':'s')+' updated.':' \u2014 no changes.')):'No counts entered.');
  renderParts();
}
var ENGINE_TYPES=['GX160','GX200','GX270'];
function renderPartEngines(sel){
  sel=sel||[];var el=document.getElementById('ptf-engines');if(!el)return;var h='';
  for(var i=0;i<ENGINE_TYPES.length;i++){var e=ENGINE_TYPES[i],on=sel.indexOf(e)>=0;
    h+='<label style="display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border-radius:100px;border:1.5px solid '+(on?'#4338ca':'var(--border)')+';background:'+(on?'#4338ca':'var(--bg)')+';color:'+(on?'#fff':'var(--text)')+';font-size:12px;font-weight:700;cursor:pointer;user-select:none">';
    h+='<input type="checkbox" class="ptf-eng-cb" value="'+e+'"'+(on?' checked':'')+' onchange="_toggleEngChip(this)" style="display:none"/>'+e+'</label>';}
  el.innerHTML=h;
}
function _toggleEngChip(cb){var l=cb.parentNode;if(!l)return;if(cb.checked){l.style.background='#4338ca';l.style.borderColor='#4338ca';l.style.color='#fff';}else{l.style.background='var(--bg)';l.style.borderColor='var(--border)';l.style.color='var(--text)';}}
function _readPartEngines(){var cbs=document.querySelectorAll('#ptf-engines .ptf-eng-cb'),out=[];for(var i=0;i<cbs.length;i++)if(cbs[i].checked)out.push(cbs[i].value);return out;}
var ASSET_CLASSES=['Sprint Karts','Sodi GT5R (Euro)','Sodi SR5 (Euro)','Road Track F1000 (Single)','Road Track F3000 (Double)','Kiddie Karts','Dragon Coaster','Tornado','Fun Slide','Arcade'];
function renderPartClasses(sel){
  sel=sel||[];var el=document.getElementById('ptf-classes');if(!el)return;var h='';
  for(var i=0;i<ASSET_CLASSES.length;i++){var c=ASSET_CLASSES[i],on=sel.indexOf(c)>=0;
    h+='<label style="display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border-radius:100px;border:1.5px solid '+(on?'#0d9488':'var(--border)')+';background:'+(on?'#0d9488':'var(--bg)')+';color:'+(on?'#fff':'var(--text)')+';font-size:12px;font-weight:700;cursor:pointer;user-select:none">';
    h+='<input type="checkbox" class="ptf-cls-cb" value="'+esc(c)+'"'+(on?' checked':'')+' onchange="_toggleClassChip(this)" style="display:none"/>'+esc(c)+'</label>';}
  el.innerHTML=h;
}
function _toggleClassChip(cb){var l=cb.parentNode;if(!l)return;if(cb.checked){l.style.background='#0d9488';l.style.borderColor='#0d9488';l.style.color='#fff';}else{l.style.background='var(--bg)';l.style.borderColor='var(--border)';l.style.color='var(--text)';}}
function _readPartClasses(){var cbs=document.querySelectorAll('#ptf-classes .ptf-cls-cb'),out=[];for(var i=0;i<cbs.length;i++)if(cbs[i].checked)out.push(cbs[i].value);return out;}
var _ptfPhoto='';
function _ptfSetPhoto(d){
  _ptfPhoto=d||'';
  var img=document.getElementById('ptf-photo-img'),lbl=document.getElementById('ptf-photo-label'),rm=document.getElementById('ptf-photo-rm');
  if(img){ if(_ptfPhoto){img.src=_ptfPhoto;img.style.display='';}else{img.removeAttribute('src');img.style.display='none';} }
  if(lbl)lbl.textContent=_ptfPhoto?'Replace photo':'Add photo';
  if(rm)rm.style.display=_ptfPhoto?'':'none';
}
function ptfPhoto(inp){ var f=inp&&inp.files&&inp.files[0]; if(!f)return;
  if(typeof _imgToDataURL==='function'){ _imgToDataURL(f,function(d){_ptfSetPhoto(d);}); }
  else { var r=new FileReader(); r.onload=function(e){_ptfSetPhoto(e.target.result);}; r.readAsDataURL(f); }
}
function ptfPhotoRemove(){ _ptfSetPhoto(''); }
function openPartModal(){
  editPartId = null;
  document.getElementById('ptf-title').textContent = 'Add Part';
  document.getElementById('ptf-name').value = '';
  document.getElementById('ptf-pn').value = '';
  document.getElementById('ptf-vendor').value = '';
  document.getElementById('ptf-section').value = '';
  document.getElementById('ptf-unit').value = 'each';
  document.getElementById('ptf-cost').value = '';
  document.getElementById('ptf-qty').value = '';
  document.getElementById('ptf-min').value = '';
  document.getElementById('ptf-desc').value = '';
  document.getElementById('ptf-punit').value = '';
  document.getElementById('ptf-pack').value = '';
  document.getElementById('ptf-pcost').value = '';
  document.getElementById('ptf-usage').value = '';
  document.getElementById('ptf-del-btn').style.display = 'none';
  var _rqb=document.getElementById('ptf-req-btn');if(_rqb)_rqb.style.display='none';
  var _rcb=document.getElementById('ptf-recv-btn');if(_rcb)_rcb.style.display='none';
  var _rub=document.getElementById('ptf-use-btn');if(_rub)_rub.style.display='none';
  renderPartEngines([]);
  renderPartClasses([]);
  if(typeof fillVendorDatalist==='function')fillVendorDatalist();
  var _pa=document.getElementById('ptf-active');if(_pa)_pa.value='auto';var _pah=document.getElementById('ptf-active-hint');if(_pah)_pah.textContent='New parts default to Auto.';
  if(document.getElementById('ptf-derived'))document.getElementById('ptf-derived').textContent='';
  _ptfSetPhoto('');
  openM('partModal');
}

function openEditPart(pid){
  var p = D.parts.filter(function(x){return x.id===pid;})[0];
  if(!p) return;
  editPartId = pid;
  document.getElementById('ptf-title').textContent = 'Edit Part';
  document.getElementById('ptf-name').value = p.name||'';
  document.getElementById('ptf-pn').value = p.partNumber||'';
  document.getElementById('ptf-vendor').value = p.vendors||'';
  document.getElementById('ptf-section').value = p.area||p.location||'';
  document.getElementById('ptf-unit').value = p.unit||'each';
  document.getElementById('ptf-cost').value = p.unitCost||'';
  document.getElementById('ptf-qty').value = p.qty||0;
  document.getElementById('ptf-min').value = p.minQty||0;
  document.getElementById('ptf-desc').value = p.description||'';
  document.getElementById('ptf-punit').value = p.purchaseUnit||'';
  document.getElementById('ptf-pack').value = p.packSize||'';
  document.getElementById('ptf-pcost').value = p.purchaseCost||'';
  document.getElementById('ptf-usage').value = p.usagePerJob||'';
  document.getElementById('ptf-del-btn').style.display = '';
  var _rqb=document.getElementById('ptf-req-btn');if(_rqb)_rqb.style.display='';
  var _rcb=document.getElementById('ptf-recv-btn');if(_rcb)_rcb.style.display='';
  var _rub=document.getElementById('ptf-use-btn');if(_rub)_rub.style.display='';
  renderPartEngines(p.engines||[]);
  renderPartClasses(p.usedOn||[]);
  if(typeof fillVendorDatalist==='function')fillVendorDatalist();
    var _pa=document.getElementById('ptf-active');if(_pa)_pa.value=(p.activeOverride===true?'active':(p.activeOverride===false?'inactive':'auto'));
  var _pah=document.getElementById('ptf-active-hint');if(_pah)_pah.textContent=(typeof partActiveReason==='function'?('Currently: '+partActiveReason(p)):'');
  ptfRecalc();
  _ptfSetPhoto(p.photo||'');
  openM('partModal');
}

function ptfRecalc(){
  var g=function(x){return document.getElementById(x);};
  var pack=parseFloat(g('ptf-pack').value)||0, pcost=parseFloat(g('ptf-pcost').value)||0;
  var unit=g('ptf-unit').value||'each', punit=(g('ptf-punit').value||'').trim(), usage=parseFloat(g('ptf-usage').value)||0;
  var d=g('ptf-derived'); if(!d)return;
  if(pack>0&&pcost>0){
    var per=pcost/pack;
    g('ptf-cost').value=(Math.round(per*10000)/10000);
    var s=(punit||'purchase')+' = '+pack+' '+unit+' @ $'+per.toFixed(2)+'/'+unit;
    if(usage>0)s+=' \u00b7 '+usage+' '+unit+'/use \u2248 $'+(per*usage).toFixed(2)+'/use';
    d.textContent=s;
  } else { d.textContent=''; }
}
function savePart(){
  var name = document.getElementById('ptf-name').value.trim();
  if(!name){ alert('Part name required.'); return; }
  var fields = {
    name: name,
    partNumber: document.getElementById('ptf-pn').value.trim(),
    vendors: document.getElementById('ptf-vendor').value.trim(),
    area: document.getElementById('ptf-section').value.trim(),
    location: document.getElementById('ptf-section').value.trim(),
    unit: document.getElementById('ptf-unit').value,
    unitCost: parseFloat(document.getElementById('ptf-cost').value)||0,
    qty: parseInt(document.getElementById('ptf-qty').value)||0,
    minQty: parseInt(document.getElementById('ptf-min').value)||0,
    description: document.getElementById('ptf-desc').value.trim(),
    photo: _ptfPhoto||'',
    purchaseUnit: document.getElementById('ptf-punit').value.trim(),
    packSize: parseFloat(document.getElementById('ptf-pack').value)||0,
    purchaseCost: parseFloat(document.getElementById('ptf-pcost').value)||0,
    usagePerJob: parseFloat(document.getElementById('ptf-usage').value)||0,
    engines: _readPartEngines(),
    usedOn: _readPartClasses(),
    activeOverride: (function(){var v=(document.getElementById('ptf-active')||{}).value||'auto';return v==='active'?true:(v==='inactive'?false:null);})()
  };
  if(editPartId){
    var p = D.parts.filter(function(x){return x.id===editPartId;})[0];
    if(p){ for(var k in fields) p[k]=fields[k]; dbSave('parts',p); }
  } else {
    fields.id = nid('PRT');
    fields.totalCost = 0;
    fields.created = today();
    D.parts.push(fields); dbSave('parts',fields);
  }
  closeM('partModal');
  renderParts();
}

function deletePartFromModal(){
  if(!editPartId) return;
  var p = D.parts.filter(function(x){return x.id===editPartId;})[0];
  if(!p) return;
  if(!confirm('Delete "'+p.name+'"?')) return;
  dbRemove('parts',editPartId); D.parts = D.parts.filter(function(x){return x.id!==editPartId;});
  closeM('partModal');
  renderParts();
}

function addPushPart(){var n=document.getElementById('pp-name').value.trim();if(!n)return;ppParts.push({id:'tmp'+Date.now(),name:n,qty:1,unit:'each'});document.getElementById('pp-name').value='';renderPPList();}

function vendorById(id){if(!id)return null;for(var i=0;i<D.vendors.length;i++)if(D.vendors[i].id===id)return D.vendors[i];return null;}
function openVendorDetail(id){
  var v=vendorById(id); if(!v){return;}
  var h='<div style="font-size:20px;font-weight:800;margin-bottom:2px">'+esc(v.name||'Vendor')+'</div>';
  if(v.trade)h+='<div style="font-size:12px;color:#0891b2;font-weight:700;margin-bottom:6px">'+esc(v.trade)+'</div>';
  var cs=(v.contacts&&v.contacts.length)?v.contacts:[{name:v.contact,email:v.email,phone:v.phone}];
  var any=false;
  h+='<div style="margin-top:8px">';
  for(var i=0;i<cs.length;i++){var c=cs[i];if(!c||(!c.name&&!c.email&&!c.phone))continue;any=true;
    h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:11px;margin-bottom:8px">';
    if(c.name)h+='<div style="font-weight:700;font-size:14px">'+esc(c.name)+'</div>';
    if(c.phone)h+='<div style="font-size:13px;margin-top:4px"><a href="tel:'+esc(c.phone)+'" style="color:#0891b2;font-weight:700;text-decoration:none">Call '+esc(c.phone)+'</a></div>';
    if(c.email)h+='<div style="font-size:13px;margin-top:4px"><a href="mailto:'+esc(c.email)+'" style="color:#0891b2;font-weight:700;text-decoration:none">Email '+esc(c.email)+'</a></div>';
    h+='</div>';}
  h+='</div>';
  if(!any)h+='<div style="font-size:13px;color:var(--muted);margin:6px 0">No contact details on file yet. Add them in the Vendors tab.</div>';
  if(v.assets){var arr=String(v.assets).split(',').map(function(s){return s.trim();}).filter(Boolean);if(arr.length){h+='<div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;margin:12px 0 5px">Assets serviced ('+arr.length+')</div><div style="font-size:13px;line-height:1.7">'+arr.map(esc).join(' \u00b7 ')+'</div>';}}
  if(v.notes)h+='<div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;margin:12px 0 5px">Notes</div><div style="font-size:13px;white-space:pre-wrap">'+esc(v.notes)+'</div>';
  h+='<button onclick="closeM(\'drillSheet\')" style="margin-top:16px;width:100%;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:11px;font-weight:700;cursor:pointer;font-family:inherit">Close</button>';
  document.getElementById('drill-content').innerHTML=h;openM('drillSheet');
}
