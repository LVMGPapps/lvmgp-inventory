// ── SUPABASE CONFIG ───────────────────────────────────────────────────────────
var SUPA_URL = "https://scolwievbsvvzfabqbld.supabase.co";
// Use the legacy 'anon' key (Settings -> API Keys -> Legacy tab -> anon key)
// The publishable key (sb_publishable_...) requires origin allowlisting
// The anon key works from any browser with RLS enabled
var SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjb2x3aWV2YnN2dnpmYWJxYmxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MTk2NzUsImV4cCI6MjA5NTM5NTY3NX0.0hzWIAUDHvd11OZA336dJyB3fxpIoCJYHT-MN4ZseDM";
var sb = null;

// ── DEVICE ARCHIVE CACHE (IndexedDB) — Option B ────────────────────────
// Only the STABLE archive is cached: work orders that are completed and older
// than the operational window. Those records don't change, so caching them is
// safe and never goes stale. Everything live (open WOs, recent WOs, inspections,
// karts, parts, all other tables) is always fetched fresh from the server.
//
// Safety: the cache carries APP_SCHEMA. On any deploy that bumps the schema, the
// whole archive store is dropped and rebuilt from the server. New code can never
// read archive records shaped for old code.
var APP_SCHEMA = '2026-07-26.5';   // bumped: cache mechanism changed shape
var IDB_NAME = 'lvmgp_archive';
var IDB_STORE = 'wo_archive';
var IDB_META = 'meta';
var _idb=null;

function _idbOpen(){
  return new Promise(function(resolve){
    try{
      if(!('indexedDB' in window)){ resolve(null); return; }
      var req=indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded=function(e){
        var db=e.target.result;
        if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, {keyPath:'id'});
        if(!db.objectStoreNames.contains(IDB_META)) db.createObjectStore(IDB_META, {keyPath:'k'});
      };
      req.onsuccess=function(e){ resolve(e.target.result); };
      req.onerror=function(){ console.warn('[cache] IndexedDB open failed'); resolve(null); };
    }catch(e){ console.warn('[cache] IndexedDB unavailable:',e&&e.message); resolve(null); }
  });
}
async function _idbReady(){ if(_idb) return _idb; _idb=await _idbOpen(); return _idb; }
function _idbTx(db, store, mode){ return db.transaction(store, mode).objectStore(store); }
function _idbGetMeta(db,key){
  return new Promise(function(res){ try{ var r=_idbTx(db,IDB_META,'readonly').get(key); r.onsuccess=function(){res(r.result?r.result.v:null);}; r.onerror=function(){res(null);}; }catch(e){res(null);} });
}
function _idbPutMeta(db,key,val){
  return new Promise(function(res){ try{ var r=_idbTx(db,IDB_META,'readwrite').put({k:key,v:val}); r.onsuccess=function(){res(true);}; r.onerror=function(){res(false);}; }catch(e){res(false);} });
}
function _idbGetAll(db){
  return new Promise(function(res){ try{ var r=_idbTx(db,IDB_STORE,'readonly').getAll(); r.onsuccess=function(){res(r.result||[]);}; r.onerror=function(){res([]);}; }catch(e){res([]);} });
}
function _idbPutMany(db, rows){
  // Chunk large writes. A single transaction with 12k+ puts can be slow enough to
  // be interrupted by a reload (leaving nothing committed). Smaller transactions
  // commit incrementally and are far more robust on mobile.
  return new Promise(async function(res){
    try{
      var CHUNK=1000, ok=true;
      for(var start=0; start<rows.length; start+=CHUNK){
        var slice=rows.slice(start, start+CHUNK);
        var done=await new Promise(function(r){
          try{
            var tx=db.transaction(IDB_STORE,'readwrite'); var st=tx.objectStore(IDB_STORE);
            for(var i=0;i<slice.length;i++){ if(slice[i]&&slice[i].id) st.put(slice[i]); }
            tx.oncomplete=function(){r(true);}; tx.onerror=function(){r(false);}; tx.onabort=function(){r(false);};
          }catch(e){ r(false); }
        });
        if(!done){ ok=false; break; }
      }
      res(ok);
    }catch(e){ res(false); }
  });
}
function _idbClearStore(db){
  return new Promise(function(res){ try{ var tx=db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).clear(); tx.oncomplete=function(){res(true);}; tx.onerror=function(){res(false);}; }catch(e){res(false);} });
}

// Read the cached archive IF its schema matches the running code. Returns an
// array of WO records, or null if there is no usable cache (absent, mismatched,
// or error) so the caller loads the archive fresh.
async function readArchiveCache(){
  try{
    var db=await _idbReady(); if(!db) return null;
    var schema=await _idbGetMeta(db,'schema');
    if(schema!==APP_SCHEMA){
      console.log('[cache] archive schema '+(schema||'none')+' ≠ code '+APP_SCHEMA+' — dropping archive, will rebuild');
      await _idbClearStore(db);
      // NOTE: do NOT write schema=null here. writeArchiveCache owns the schema
      // stamp. Nulling it created a window where an interrupted rebuild left the
      // cache permanently "schema none", forcing a full re-fetch on every load.
      return null;
    }
    var rows=await _idbGetAll(db);
    if(!rows.length) return null;
    var out=[]; for(var i=0;i<rows.length;i++){ if(rows[i]&&rows[i].data) out.push(rows[i].data); }
    console.log('[cache] archive loaded from device: '+out.length+' work orders');
    return out;
  }catch(e){ console.warn('[cache] archive read failed, loading fresh:',e&&e.message); return null; }
}
// Persist archive rows (each {id, data}) and stamp the schema + newest updated_at
// so next login can fetch only what changed since.
async function writeArchiveCache(rows, newestUpdatedAt){
  try{
    var db=await _idbReady(); if(!db) return false;
    var packed=[]; for(var i=0;i<rows.length;i++){ var w=rows[i]; if(w&&w.id) packed.push({id:w.id, data:w}); }
    // Clear then write the rows FIRST. Only after they commit do we stamp the
    // schema — so an interrupted write leaves an unstamped (ignored) cache rather
    // than a stamped-but-incomplete one. The stamp is the "this cache is complete
    // and valid" flag, written last.
    await _idbClearStore(db);
    await _idbPutMany(db, packed);
    if(newestUpdatedAt) await _idbPutMeta(db,'cursor',newestUpdatedAt);
    await _idbPutMeta(db,'schema',APP_SCHEMA);
    console.log('[cache] archive cached on device: '+packed.length+' work orders (schema '+APP_SCHEMA+')');
    return true;
  }catch(e){ console.warn('[cache] archive write failed:',e&&e.message); return false; }
}
async function _archiveCursor(){ try{ var db=await _idbReady(); if(!db)return null; return await _idbGetMeta(db,'cursor'); }catch(e){ return null; } }
async function clearArchiveCache(){ try{ var db=await _idbReady(); if(!db)return; await _idbClearStore(db); await _idbPutMeta(db,'schema',null); await _idbPutMeta(db,'cursor',null); }catch(e){} }

window.lvmgpCache={ readArchive:readArchiveCache, clearArchive:clearArchiveCache, schema:function(){return APP_SCHEMA;} };

var DB_READY = false;
var DB_LOADING = false;

function initSupabase(){
  try{
    sb = supabase.createClient(SUPA_URL, SUPA_KEY, {
      global:{headers:{'X-Client-Info':'lvmgp-maintenance/2.0'}},
      auth:{persistSession:false,autoRefreshToken:false}
    });
    console.log("Supabase connected");
    return true;
  }catch(e){ console.error("Supabase init failed:",e); sb=null; return false; }
}

// Each in-app collection -> its Supabase table. Every table uses the JSON-blob
// shape (id text pk, data jsonb, updated_at) so the schema NEVER changes when
// we add fields to a record (the symptom checker, future features, etc.).
var DB_TABLES = {
  workOrders:'work_orders', assets:'assets', inspections:'inspections',
  engines:'engines', parts:'parts', vendors:'vendors', vendorVisits:'vendor_visits',
  compliance:'compliance', incidents:'incidents', downtimes:'downtimes',
  arcadeMachines:'arcade_machines', handoffs:'handoffs', teamMembers:'team_members',
  shifts:'shifts', partWriteoffs:'part_writeoffs', partRequests:'part_requests',
  adjustRequests:'adjust_requests', partOrders:'part_orders', engineDiagrams:'engine_diagrams',
  messages:'messages', pmTemplates:'pm_templates', privateNotes:'private_notes', followups:'followups', manuals:'manuals', arcadeRevenue:'arcade_revenue', supplies:'supplies', arcadePMs:'arcade_pms'
};
var DB_SINGLETONS = ['preopState','serviceThresholds','dismissedEmailWOs','swoKindOverride'];

// ── SAVE STATUS PILL ──────────────────────────────────────────────────────────
var SAVE_STATE='idle', SAVE_T=null;
function setSaveStatus(s){
  SAVE_STATE=s;
  var el=document.getElementById('saveStatus'); if(!el)return;
  var m={idle:['',''],saving:['Saving…','#fde68a'],saved:['\u2713 Saved','#86efac'],offline:['Offline \u2014 will retry','#fca5a5']};
  var v=m[s]||m.idle;
  el.textContent=v[0]; el.style.color=v[1]; el.style.opacity=v[0]?'1':'0';
  if(s==='saved'){clearTimeout(SAVE_T);SAVE_T=setTimeout(function(){if(SAVE_STATE==='saved')setSaveStatus('idle');},1600);}
}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

// ── WRITE QUEUE (retries on failure so nothing is lost; one bad write can NEVER block the rest) ──
var WRITE_QUEUE=[], QUEUE_RUNNING=false, WRITE_FAILED=[], FAILED_T=null;
function enqueueWrite(op){ WRITE_QUEUE.push(op); runQueue(); }
function pendingWrites(){ return WRITE_QUEUE.length + WRITE_FAILED.length; }
function scheduleFailedRetry(){
  if(FAILED_T||!WRITE_FAILED.length)return;
  FAILED_T=setTimeout(function(){
    FAILED_T=null;
    if(!WRITE_FAILED.length)return;
    var batch=WRITE_FAILED; WRITE_FAILED=[];
    for(var i=0;i<batch.length;i++){ batch[i]._tries=0; WRITE_QUEUE.push(batch[i]); }
    runQueue();
  },20000);
}
async function runQueue(){
  if(QUEUE_RUNNING||!sb)return;
  QUEUE_RUNNING=true; setSaveStatus('saving');
  while(WRITE_QUEUE.length){
    var op=WRITE_QUEUE[0], ok=false;
    try{ ok=await op.run(); }catch(e){ ok=false; }
    if(ok){ WRITE_QUEUE.shift(); op._tries=0; }
    else {
      op._tries=(op._tries||0)+1;
      if(op._tries>=4){
        // A write that keeps failing gets set aside so it can never block saves to
        // other records. It is retried on its own every 20s in the background.
        WRITE_QUEUE.shift(); WRITE_FAILED.push(op); setSaveStatus('offline');
      } else {
        setSaveStatus('offline'); await sleep(Math.min(2000*op._tries,8000));
      }
    }
  }
  QUEUE_RUNNING=false;
  if(typeof _euroSyncRepaint==='function'){ try{_euroSyncRepaint();}catch(e){} }
  if(WRITE_FAILED.length){ setSaveStatus('offline'); scheduleFailedRetry(); }
  else setSaveStatus('saved');
}
if(typeof window!=='undefined'&&window.addEventListener){
  window.addEventListener('beforeunload',function(e){ if(pendingWrites()>0){ e.preventDefault(); e.returnValue=''; return ''; } });
}

// ── GENERIC SAVE / DELETE (JSON-blob shape) ───────────────────────────────────
var _recentSaves={};
// Per-record save confirmation. A record id sits in _unsaved from the moment we
// try to save it until the upsert actually lands. This is what lets a sign-off
// show a real "saved" state instead of a hopeful one — the green check can be
// gated on confirmation rather than on the in-memory flag flip.
var _unsaved={};      // records with a pending FIRST save that has not confirmed
var _confirmed={};    // records known to exist on the server (loaded, or write landed)
function markConfirmedFromLoad(ids){ if(ids)for(var i=0;i<ids.length;i++)if(ids[i])_confirmed[ids[i]]=1; }
function isSaved(id){ return !!id && !_unsaved[id]; }
function unsavedCount(){ var n=0; for(var k in _unsaved){ if(_unsaved[k])n++; } return n; }
function _markUnsaved(id){
  // Re-saving a record that is already on the server does NOT make it unsaved.
  // Only a brand-new record awaiting its first successful write is "not saved".
  if(id && !_confirmed[id]) _unsaved[id]=Date.now();
}
function _markSaved(id){ if(id){ delete _unsaved[id]; _confirmed[id]=1; } }
function dbSave(table, rec){
  if(!sb||!rec||!rec.id)return;
  try{_recentSaves[rec.id]=Date.now();}catch(e){}
  _markUnsaved(rec.id);
  var _rid=rec.id;
  enqueueWrite({recId:_rid, run:async function(){
    try{
      var r=await sb.from(table).upsert({id:rec.id,data:rec,updated_at:new Date().toISOString()},{onConflict:'id'});
      if(r.error){console.error('dbSave '+table+': '+r.error.message);return false;}
      _markSaved(_rid);
      return true;
    }catch(e){console.error('dbSave '+table+' ex:',e.message||e);return false;}
  }});
}
function dbRemove(table, id){
  if(!sb||!id)return;
  enqueueWrite({run:async function(){
    try{
      var r=await sb.from(table).delete().eq('id',id);
      if(r.error){console.error('dbRemove '+table+': '+r.error.message);return false;}
      return true;
    }catch(e){console.error('dbRemove '+table+' ex:',e.message||e);return false;}
  }});
}
function dbSaveSingleton(key){
  if(!sb)return;
  enqueueWrite({run:async function(){
    try{
      var r=await sb.from('app_state').upsert({id:key,data:(D[key]||{}),updated_at:new Date().toISOString()},{onConflict:'id'});
      if(r.error){console.error('dbSaveSingleton '+key+': '+r.error.message);return false;}
      return true;
    }catch(e){return false;}
  }});
}
// compatibility shims + named wrappers used throughout the app
function dbUpsert(t,rec){ dbSave(t,rec); }
function dbDelete(t,id){ dbRemove(t,id); }

var _woKnownIds={};
function saveWO(wo){ if(!wo)return;
  if(wo.id&&!_woKnownIds[wo.id]){ if(!wo.createdBy){ wo.createdBy=(currentUser&&currentUser.name)||''; wo.createdTs=(typeof woNow==='function'?woNow():(typeof today==='function'?today():'')); var _hc=false; if(wo.changeLog){for(var _c=0;_c<wo.changeLog.length;_c++)if(wo.changeLog[_c]&&wo.changeLog[_c].text==='Created'){_hc=true;break;}} if(!_hc&&typeof woLog==='function')woLog(wo,'Created'); } _woKnownIds[wo.id]=1; } dbSave('work_orders',wo); }
function _woCreatorLine(w){ var by='',ts=''; if(w.createdBy){by=w.createdBy;ts=w.createdTs||w.created||'';} else if(w.changeLog&&w.changeLog.length){var c=null;for(var i=0;i<w.changeLog.length;i++)if(w.changeLog[i]&&w.changeLog[i].text==='Created'){c=w.changeLog[i];break;}if(!c)c=w.changeLog[0];if(c){by=c.user||'';ts=c.ts||'';}} if(!ts)ts=w.created||''; var label=by?('Created by '+esc(by)+(ts?' \u00b7 '+esc(ts):'')):(ts?('Created '+esc(ts)):''); if(!label)return ''; return '<div style="font-size:11px;color:var(--muted);margin:2px 0 8px">'+label+'</div>'; }
// ── PRIVATE NOTES (Owner / GM / AGM only) ───────────────────────────────────
function _pnCan(){var r=(typeof currentUser!=='undefined'&&currentUser&&currentUser.role)||'';return r==='owner'||r==='gm'||r==='agm';}
function _pnList(kind,id){var out=[],a=D.privateNotes||[];for(var i=0;i<a.length;i++){if(a[i]&&a[i].refKind===kind&&String(a[i].refId)===String(id))out.push(a[i]);}out.sort(function(x,y){return String(x.ts||'').localeCompare(String(y.ts||''));});return out;}
function _pnRefresh(kind,id){if(kind==='wo'&&typeof renderWOPage==='function'){renderWOPage(id);return;}if(typeof pgRender==='function')pgRender();}
function _pnAdd(kind,id){if(!_pnCan())return;var inp=document.getElementById('pn-inp-'+kind+'-'+id);if(!inp)return;var t=(inp.value||'').trim();if(!t)return;if(!D.privateNotes)D.privateNotes=[];var rec={id:nid('PN'),refKind:kind,refId:String(id),text:t,user:(currentUser&&currentUser.name)||'',ts:(typeof woNow==='function'?woNow():today())};D.privateNotes.push(rec);dbSave('private_notes',rec);inp.value='';_pnRefresh(kind,id);}
function _pnDelete(pnId,kind,id){if(!_pnCan())return;if(!confirm('Delete this private note?'))return;D.privateNotes=(D.privateNotes||[]).filter(function(n){return n.id!==pnId;});if(typeof dbRemove==='function')dbRemove('private_notes',pnId);_pnRefresh(kind,id);}
function _pnBlock(kind,id){
  if(!_pnCan())return '';
  var list=_pnList(kind,id);
  var h='<div class="ds-sec" style="border:1.5px solid #f59e0b;border-radius:12px;padding:12px;background:#fffbeb;margin-top:14px">';
  h+='<div class="ds-st" style="color:#92400e;display:flex;align-items:center;gap:6px;flex-wrap:wrap">\ud83d\udd12 Private Notes <span style="font-size:10px;font-weight:700;color:#b45309;background:#fef3c7;border-radius:5px;padding:1px 7px">Owner / GM / AGM only</span></div>';
  h+='<div style="font-size:10px;color:#b45309;margin:2px 0 8px">Mechanics and other staff can\u2019t see these.</div>';
  if(!list.length)h+='<div style="font-size:12px;color:#92400e;opacity:.7;padding:2px 0 8px">No private notes yet.</div>';
  for(var i=0;i<list.length;i++){var n=list[i];
    h+='<div style="background:#fff;border:1px solid #fde68a;border-radius:9px;padding:8px 10px;margin-bottom:6px">';
    h+='<div style="font-size:13px;white-space:pre-wrap">'+esc(n.text)+'</div>';
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;gap:8px"><span style="font-size:10px;color:#b45309">'+esc(n.user||'')+(n.ts?' \u00b7 '+esc(n.ts):'')+'</span>';
    h+='<button data-pn="'+escA(n.id)+'" data-k="'+escA(kind)+'" data-i="'+escA(String(id))+'" onclick="_pnDelete(this.dataset.pn,this.dataset.k,this.dataset.i)" style="background:none;border:none;color:#dc2626;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Delete</button></div></div>';
  }
  h+='<div style="display:flex;gap:6px;margin-top:4px"><input id="pn-inp-'+escA(kind)+'-'+escA(String(id))+'" placeholder="Add a private note\u2026" style="flex:1;border:1.5px solid #fcd34d;border-radius:9px;padding:9px 11px;font-size:13px;font-family:inherit;background:#fff"/>';
  h+='<button data-k="'+escA(kind)+'" data-i="'+escA(String(id))+'" onclick="_pnAdd(this.dataset.k,this.dataset.i)" style="background:#d97706;border:none;color:#fff;border-radius:9px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Add</button></div>';
  h+='</div>';
  return h;
}




function showLoadingOverlay(show){ var el=document.getElementById('loadingOverlay'); if(el)el.style.display=show?'flex':'none'; }

// Operational-first work-order load. Returns the operational rows immediately and
// kicks off the archive fetch in the background (which calls onArchive when done).
async function dbLoadWorkOrdersPhased(onArchive){
  try{
    var cutoff=new Date(Date.now()-30*24*3600*1000).toISOString().slice(0,10);
    // Phase 1: open/in-progress/on-hold + recently completed. Two cheap queries.
    var openP=sb.from('work_orders').select('*').neq('data->>status','completed');
    var recentP=sb.from('work_orders').select('*')
        .eq('data->>status','completed').gte('data->>completed',cutoff);
    var res=await Promise.all([openP,recentP]);
    if(res[0].error||res[1].error) throw (res[0].error||res[1].error);
    var seen={},ops=[];
    function take(arr){ for(var i=0;i<arr.length;i++){ var r=arr[i]; if(r&&r.id&&!seen[r.id]){seen[r.id]=1;ops.push(r.data);} } }
    take(res[0].data||[]); take(res[1].data||[]);
    // Phase 2: the archive (older closed WOs), in the background, from the device
    // cache when possible. Only WOs changed since the cache was written are pulled
    // from the server, so the heavy history loads instantly and re-download is tiny.
    if(typeof onArchive==='function'){
      (async function(){
        try{
          var cached=await readArchiveCache();
          if(cached){
            // Delta: fetch only rows updated since the cache cursor.
            var cursor=await _archiveCursor();
            var delta=[];
            if(cursor){
              var dq=await sb.from('work_orders').select('*').gt('updated_at',cursor);
              if(!dq.error) delta=(dq.data||[]);
            }
            var byId={};
            for(var c=0;c<cached.length;c++){ var cw=cached[c]; if(cw&&cw.id)byId[cw.id]=cw; }
            var newest=cursor||'';
            for(var d=0;d<delta.length;d++){ var row=delta[d]; if(row&&row.id){ byId[row.id]=row.data; if(row.updated_at&&row.updated_at>newest)newest=row.updated_at; } }
            var merged=[]; for(var k in byId){ merged.push(byId[k]); }
            // Hand the caller only the archive rows not already in the operational set.
            var add=[]; for(var m=0;m<merged.length;m++){ var mw=merged[m]; if(mw&&mw.id&&!seen[mw.id]){seen[mw.id]=1;add.push(mw);} }
            onArchive(add);
            // Re-cache the freshened archive (operational rows are excluded from cache;
            // they'll be fetched fresh next login anyway).
            var toCache=[]; for(var t=0;t<merged.length;t++){ var tw=merged[t]; if(tw&&tw.id) toCache.push(tw); }
            writeArchiveCache(toCache, newest||undefined);
            console.log('[cache] archive delta from server: '+delta.length+' changed');
            return;
          }
          // No cache yet (first run or after a schema bump): full fetch, then cache it.
          var arch=await dbLoadRows('work_orders');
          var add2=[], newest2='';
          for(var i=0;i<arch.length;i++){ var w=arch[i]; if(w&&w.id&&!seen[w.id]){seen[w.id]=1;add2.push(w);} }
          onArchive(add2);
          // Cache the full set with a cursor = newest updated_at we can find.
          var cur2=await sb.from('work_orders').select('updated_at').order('updated_at',{ascending:false}).limit(1);
          if(!cur2.error && cur2.data && cur2.data[0]) newest2=cur2.data[0].updated_at;
          writeArchiveCache(arch, newest2||undefined);
        }catch(e){ console.warn('WO archive load failed (operational set is complete):',e&&e.message); }
      })();
    }
    return ops;
  }catch(e){
    // Any trouble → behave exactly like today: one full load, no phasing.
    console.warn('phased WO load unavailable, loading all at once:',e&&e.message);
    var all=await dbLoadRows('work_orders');
    if(typeof onArchive==='function') onArchive([]);   // nothing left to merge
    return all;
  }
}
async function dbLoadRows(table){
  // No exact count. Asking Postgres for {count:'exact'} on every table forces a
  // full-table scan before any rows come back — that was ~20s of the load. Instead
  // grab a big first page; if it's not completely full, that IS the whole table
  // (one round trip, no count). Only when the page comes back full do we keyset
  // through the rest. Falls back to the safe keyset loader on any error.
  try{
    var BIG=100000;
    var first=await sb.from(table).select('*').order('id',{ascending:true}).range(0,BIG-1);
    if(first.error) return await dbLoadRowsKeyset(table);
    var firstRows=first.data||[];
    // Not full → we have everything.
    if(firstRows.length<BIG){ return firstRows.map(function(x){return x.data;}); }
    // Full page → there may be more; continue from the last id via keyset.
    var seen={},all=[],lastId=null;
    for(var j=0;j<firstRows.length;j++){ var rw=firstRows[j]; if(rw&&rw.id&&!seen[rw.id]){seen[rw.id]=1;all.push(rw.data);lastId=rw.id;} }
    while(true){
      var more=await sb.from(table).select('*').order('id',{ascending:true}).gt('id',lastId).range(0,BIG-1);
      if(more.error) return await dbLoadRowsKeyset(table);
      var mrows=more.data||[]; if(!mrows.length)break;
      for(var q=0;q<mrows.length;q++){ var r2=mrows[q]; if(r2&&r2.id&&!seen[r2.id]){seen[r2.id]=1;all.push(r2.data);lastId=r2.id;} }
      if(mrows.length<BIG)break;
    }
    return all;
  }catch(e){ return await dbLoadRowsKeyset(table); }
}
async function dbLoadRowsKeyset(table){
  try{
    var all=[],last=null,desc=false,CAP=0;
    var startPage=1000;
    var PAGE=startPage, MINPAGE=5;
    while(true){
      var q=sb.from(table).select('*').order('id',{ascending:!desc}).limit(PAGE);
      if(last!==null)q=desc?q.lt('id',last):q.gt('id',last);
      var r=await q;
      if(r.error){
        // A page of very heavy rows can blow the server statement timeout.
        // Shrink the page and retry the SAME spot before giving up, so a few
        // heavy records can never abort the whole table load.
        var msg=((r.error.message||'')+'').toLowerCase();
        if(PAGE>MINPAGE && (msg.indexOf('timeout')>=0||msg.indexOf('statement')>=0||msg.indexOf('canceling')>=0)){
          PAGE=Math.max(MINPAGE, Math.floor(PAGE/4));
          console.warn('load '+table+': page too heavy, retrying at '+PAGE);
          continue;
        }
        console.error('load '+table+': '+r.error.message);
        return all.length?all:null;
      }
      var rows=r.data||[];
      for(var i=0;i<rows.length;i++)all.push(rows[i].data);
      if(rows.length<PAGE)break;
      last=rows[rows.length-1].id;
      if(CAP&&all.length>=CAP)break;
      if(PAGE<startPage)PAGE=Math.min(startPage, PAGE*2); // rows were light: speed back up
    }
    return all;
  }catch(e){console.error('load '+table+' ex:',e.message||e);return null;}
}

async function seedFromD(loaded){
  async function batch(table, arr){
    for(var i=0;i<arr.length;i+=50){
      var slice=arr.slice(i,i+50).filter(function(r){return r&&r.id;})
                  .map(function(r){return {id:r.id,data:r,updated_at:new Date().toISOString()};});
      if(!slice.length)continue;
      var res=await sb.from(table).upsert(slice,{onConflict:'id'});
      if(res.error)console.error('seed '+table+': '+res.error.message);
    }
  }
  if(!loaded.karts||!loaded.karts.length) await batch('karts', allKarts());
  for(var j=0;j<loaded.keys.length;j++){
    var k=loaded.keys[j], existing=loaded.rows[j];
    if((!existing||!existing.length)&&Array.isArray(D[k])) await batch(DB_TABLES[k], D[k]);
  }
  for(var s=0;s<DB_SINGLETONS.length;s++){
    var key=DB_SINGLETONS[s];
    if(D[key]&&Object.keys(D[key]).length) await sb.from('app_state').upsert({id:key,data:D[key],updated_at:new Date().toISOString()},{onConflict:'id'});
  }
}

async function loadFromDB(){
  if(!sb||DB_LOADING)return;
  DB_LOADING=true; showLoadingOverlay(true); setSaveStatus('saving');
  try{
    var test=await sb.from('karts').select('id').limit(1);
    if(test.error){
      console.error('DB connection failed: '+test.error.message+' \u2014 staying offline with seed data');
      DB_LOADING=false; showLoadingOverlay(false); setSaveStatus('offline'); return;
    }
    DB_READY=true;
    var _t0=Date.now();

    // Load karts AND every other table concurrently (don't wait on karts first).
    // Work orders are the heavy table (12k+ rows), so they load operational-first:
    // the app comes up on the open + last-30-day set, and the archive merges in
    // behind it. _woArchivePending stays true until that merge completes.
    window._woArchivePending=true;
    var kartsP=dbLoadRows('karts');
    var keys=Object.keys(DB_TABLES);
    var _woKey='workOrders';
    var rowsP=Promise.all(keys.map(function(k){
      if(DB_TABLES[k]==='work_orders'){
        return dbLoadWorkOrdersPhased(function(archiveRows){ _mergeWOArchive(archiveRows); });
      }
      return dbLoadRows(DB_TABLES[k]);
    }));

    var kRows=await kartsP;
    if(kRows&&kRows.length){
      D.karts={euro:[],road:[],sprint:[],kiddie:[]};
      kRows.forEach(function(k){ if(k&&D.karts[k.track])D.karts[k.track].push(k); });
      sortKarts();
    }
    var _tK=Date.now();
    // array collections
    var rows=await rowsP;
    // A database is "first run" ONLY if it is genuinely empty across every table.
    // Requiring this (not just empty karts) means a transient/failed karts read can
    // never be mistaken for a blank DB and re-seed demo data over real records.
    var anyData=(kRows&&kRows.length)||rows.some(function(r){return r&&r.length;});
    var firstRun=!anyData;
    if(firstRun){
      // brand-new DB only: keep in-memory defaults for empty tables
      keys.forEach(function(k,i){ if(rows[i]&&rows[i].length)D[k]=rows[i]; });
    } else {
      // established DB: mirror exactly what's in Supabase, empty tables included
      keys.forEach(function(k,i){ D[k]=(rows[i]||[]); });
    }
    if(typeof _partitionDeletedWOs==='function')_partitionDeletedWOs();
    var _tT=Date.now();

    // singletons
    var stRes=await sb.from('app_state').select('*');
    if(!stRes.error&&stRes.data){
      stRes.data.forEach(function(row){ if(DB_SINGLETONS.indexOf(row.id)>=0)D[row.id]=row.data; });
    }

    // First-run seed ONLY: on a brand-new database, push the in-app starter data
    // up once. On an established database this is skipped entirely so deploys
    // never re-create records the user has cleaned up.
    if(firstRun){
      if((!D.engines||!D.engines.length)&&typeof seedEngines!=='undefined'&&seedEngines.length){D.engines=seedEngines.concat(typeof SPARE_ENGINES!=='undefined'?SPARE_ENGINES:[]);}
      // PM/SWO templates: seed from code only when the table is empty, so user
      // edits are never overwritten on later loads.
      if((!D.pmTemplates||!D.pmTemplates.length)&&window.LVMGP_PMT){D.pmTemplates=LVMGP_PMT.buildSeed();}
      await seedFromD({karts:kRows,rows:rows,keys:keys});
    }

    var _tS=Date.now();
    var _tReconStart=Date.now();
    // Everything that came from the DB is by definition already on the server, so
    // seed it as confirmed. Without this, the startup reconcile pass (which re-saves
    // some records) would flag already-saved inspections as "not saved yet".
    try{
      var _seedT=['workOrders','parts','assets','arcadeMachines','engines','inspections','pmTemplates','followups','vendors','meters'];
      for(var _si=0;_si<_seedT.length;_si++){ var _arr=D[_seedT[_si]]||[]; for(var _sj=0;_sj<_arr.length;_sj++){ if(_arr[_sj]&&_arr[_sj].id)_confirmed[_arr[_sj].id]=1; } }
      var _tr=['euro','road','sprint','kiddie'];
      for(var _ti=0;_ti<_tr.length;_ti++){ var _ka=(D.karts&&D.karts[_tr[_ti]])||[]; for(var _kj=0;_kj<_ka.length;_kj++){ if(_ka[_kj]&&_ka[_kj].id)_confirmed[_ka[_kj].id]=1; } }
    }catch(e){}
    _woKnownIds={};for(var _wk=0;_wk<D.workOrders.length;_wk++){var _wko=D.workOrders[_wk];if(_wko&&_wko.id)_woKnownIds[_wko.id]=1;}
    if(!D.dismissedEmailWOs) D.dismissedEmailWOs={};
    suppressDismissedWOs(); // drop any re-ingested email WOs the user already cleared
    autoDedupeWOs();        // collapse duplicate PM / email WOs automatically
    if(typeof _pmRepairItems==='function'){ for(var _ri=0;_ri<D.workOrders.length;_ri++) _pmRepairItems(D.workOrders[_ri]); } // fix any PM whose tasks got duplicated
    if(typeof _cleanupFlagWOs==='function') _cleanupFlagWOs(); // repair old inspection-flag WOs (ride name/asset, kart link)
    if(typeof reconcileKartOOS==='function') reconcileKartOOS(); // return karts to service whose repair WO is already completed/closed
    if(typeof reconcileWOHolds==='function') reconcileWOHolds(); // reopen WOs held for parts now back in stock
    if(typeof purgeOldRideKeyPhotos==='function') purgeOldRideKeyPhotos(); // delete ride-key photos >7 days old (unless that day had a return problem)
    console.log('DB loaded \u2014 karts:'+allKarts().length+' WOs:'+D.workOrders.length+' parts:'+D.parts.length+' | build '+APP_SCHEMA);
    var _tRecon=Date.now();
    console.log('[load timing] karts '+(_tK-_t0)+'ms | tables '+(_tT-_tK)+'ms | singletons+seed '+(_tS-_tT)+'ms | reconcile '+(_tRecon-_tReconStart)+'ms | TOTAL to data-ready '+(_tRecon-_t0)+'ms');
    window._tDataReady=_tRecon;
    // (Archive is cached inside the phased WO loader; nothing to write here.)
  }catch(e){ console.error('DB load failed:',e); }
  DB_LOADING=false; showLoadingOverlay(false);
  setSaveStatus('saved');
  updateBadges();
  window._dataReady=true;
  resolveSession();buildNav();
  if(typeof curTab!=='undefined'&&curTab){ var _tR0=Date.now(); setTab(curTab); console.log('[load timing] first render ('+curTab+') '+(Date.now()-_tR0)+'ms'); }
  if(typeof startAutoSync==='function')startAutoSync();
  if(window.LVMGP_PM&&typeof LVMGP_PM.check==='function'){try{LVMGP_PM.check();}catch(e){}}
}

// Merge the background-loaded WO archive into memory once phase 1 is already live.
function _mergeWOArchive(archiveRows){
  window._woArchivePending=false;
  if(!archiveRows||!archiveRows.length){ if(typeof _refreshCurrentView==='function')_refreshCurrentView(); return; }
  try{
    var have={};
    for(var i=0;i<D.workOrders.length;i++){ var w=D.workOrders[i]; if(w&&w.id)have[w.id]=1; }
    for(var j=0;j<archiveRows.length;j++){ var a=archiveRows[j]; if(a&&a.id&&!have[a.id]){ have[a.id]=1; D.workOrders.push(a); _confirmed[a.id]=1; } }
    // archive rows are known-saved; seed them so nothing flags them unsaved
    if(typeof _partitionDeletedWOs==='function')_partitionDeletedWOs();
    _woKnownIds={};for(var k=0;k<D.workOrders.length;k++){var wk=D.workOrders[k];if(wk&&wk.id)_woKnownIds[wk.id]=1;}
    console.log('WO archive merged — total WOs now '+D.workOrders.length);
  }catch(e){ console.warn('WO archive merge:',e&&e.message); }
  var _tM=Date.now();
  if(typeof _refreshCurrentView==='function')_refreshCurrentView();
  console.log('[load timing] archive merge re-render '+(Date.now()-_tM)+'ms'+((window._tDataReady)?(' | archive arrived '+(_tM-window._tDataReady)+'ms after data-ready'):''));
  updateBadges();
}
// Repaint the current tab only if it actually depends on the archive (deep history).
// The dashboard, fleet, inspections etc. read the operational set, which is already
// complete, so re-rendering them on archive arrival is wasted work.
var _ARCHIVE_DEPENDENT_TABS={reports:1};
function _refreshCurrentView(){
  try{
    if(typeof curTab==='undefined'||!curTab||typeof setTab!=='function')return;
    // If an asset's full-history sheet is open, refresh it; otherwise only reports.
    var histOpen=(typeof ahName!=='undefined'&&ahName);
    if(_ARCHIVE_DEPENDENT_TABS[curTab]||histOpen){ setTab(curTab); }
    // everything else already shows correct numbers from the operational set
  }catch(e){}
}

/* ===== Live auto-sync: pull in changes other devices make, without a manual refresh ===== */
var _lastSyncWall=null,_syncing=false,_syncTimer=null;
function _viewBusy(){
  var ae=document.activeElement;
  if(ae&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'||ae.tagName==='SELECT'||ae.isContentEditable))return true;
  var on=document.querySelectorAll('.on');
  for(var i=0;i<on.length;i++){if(on[i].querySelector&&on[i].querySelector('.modal,.dbody'))return true;}
  return false;
}
function _mergeArrayRow(dkey,obj){
  if(dkey==='workOrders'&&obj&&obj.id&&typeof _woKnownIds!=='undefined')_woKnownIds[obj.id]=1;
  if(!Array.isArray(D[dkey]))D[dkey]=[];
  var arr=D[dkey];
  for(var i=0;i<arr.length;i++){if(arr[i]&&arr[i].id===obj.id){if(JSON.stringify(arr[i])===JSON.stringify(obj))return false;arr[i]=obj;return true;}}
  arr.push(obj);return true;
}
function _mergeKart(obj){
  if(!D.karts)D.karts={euro:[],road:[],sprint:[],kiddie:[]};
  var tracks=['euro','road','sprint','kiddie'],found=false,changed=false;
  for(var t=0;t<tracks.length;t++){var arr=D.karts[tracks[t]]||[];for(var i=0;i<arr.length;i++){if(arr[i]&&arr[i].id===obj.id){if(tracks[t]!==obj.track){arr.splice(i,1);i--;changed=true;}else{if(JSON.stringify(arr[i])!==JSON.stringify(obj)){arr[i]=obj;changed=true;}found=true;}}}}
  if(!found&&obj.track&&D.karts[obj.track]){D.karts[obj.track].push(obj);changed=true;}
  if(changed&&typeof sortKarts==='function')try{sortKarts();}catch(e){}
  return changed;
}
function _rerenderAfterSync(){
  if(typeof reconcileWOHolds==='function')try{reconcileWOHolds();}catch(e){}
  if(typeof updateBadges==='function')try{updateBadges();}catch(e){}
  if(_viewBusy())return;
  var _isPage=(typeof pageStack!=='undefined'&&pageStack.length);
  var _sc=document.querySelector('.panel.on .scroll');
  var _top=_sc?(_sc.scrollTop||0):0;
  try{
    if(_isPage){if(typeof pgRender==='function')pgRender();}
    else if(typeof curTab!=='undefined'&&curTab&&typeof setTab==='function')setTab(curTab);
  }catch(e){}
  function _restore(){ try{ var e2=document.querySelector('.panel.on .scroll'); if(e2 && _top>0) e2.scrollTop=_top; }catch(e){} }
  _restore();
  if(typeof requestAnimationFrame==='function')requestAnimationFrame(function(){_restore();requestAnimationFrame(_restore);});
  if(typeof setTimeout==='function'){setTimeout(_restore,80);setTimeout(_restore,220);}
}
async function syncChanges(){
  if(!sb||!DB_READY||DB_LOADING||_syncing)return;
  if(typeof document!=='undefined'&&document.hidden)return;
  _syncing=true;
  try{
    var nowMs=Date.now();
    var gap=_lastSyncWall?(nowMs-_lastSyncWall):300000;
    var windowMs=Math.min(Math.max(gap+120000,300000),86400000); // \u2265 5 min, plus time since last sync, capped at 24h
    var since=new Date(nowMs-windowMs).toISOString();
    var tables=[['karts','__karts__']],keys=Object.keys(DB_TABLES);
    for(var k=0;k<keys.length;k++)tables.push([DB_TABLES[keys[k]],keys[k]]);
    var results=await Promise.all(tables.map(function(tt){return sb.from(tt[0]).select('*').gt('updated_at',since).limit(1000);}));
    var changed=false;
    for(var t=0;t<tables.length;t++){
      var r=results[t]; if(!r||r.error||!r.data||!r.data.length)continue;
      var dkey=tables[t][1];
      for(var i=0;i<r.data.length;i++){var obj=r.data[i].data;if(!obj||!obj.id)continue;if(dkey==='__karts__'){if(_mergeKart(obj))changed=true;}else{if(_mergeArrayRow(dkey,obj))changed=true;}}
    }
    _lastSyncWall=nowMs;
    if(changed)_rerenderAfterSync();
  }catch(e){}
  _syncing=false;
}
var _reconciling=false;
async function _allIds(table){
  var ids={},from=0,PAGE=1000;
  while(true){
    var r=await sb.from(table).select('id').range(from,from+PAGE-1);
    if(!r||r.error)return null; // failed fetch -> signal "don't prune"
    var rows=r.data||[];
    for(var i=0;i<rows.length;i++)ids[rows[i].id]=1;
    if(rows.length<PAGE)break;
    from+=PAGE;
  }
  return ids;
}
async function _tableCount(table){try{var r=await sb.from(table).select('id',{count:'exact',head:true});if(!r||r.error||r.count==null)return null;return r.count;}catch(e){return null;}}
async function _pruneTable(table,dkey){
  var ids=await _allIds(table);if(!ids)return false;var changed=false,nowMs=Date.now();
  function keep(id){return !!(_recentSaves[id]&&(nowMs-_recentSaves[id])<60000);} // protect a record we just saved (still syncing up)
  if(dkey==='__karts__'){if(!D.karts)return false;var tr=['euro','road','sprint','kiddie'];for(var t=0;t<tr.length;t++){var arr=D.karts[tr[t]]||[];for(var i=arr.length-1;i>=0;i--){if(arr[i]&&arr[i].id&&!ids[arr[i].id]&&!keep(arr[i].id)){arr.splice(i,1);changed=true;}}}}
  else{if(!Array.isArray(D[dkey]))return false;var a=D[dkey];for(var j=a.length-1;j>=0;j--){if(a[j]&&a[j].id&&!ids[a[j].id]&&!keep(a[j].id)){a.splice(j,1);changed=true;}}}
  return changed;
}
async function checkDeletes(){
  if(!sb||!DB_READY||DB_LOADING||_reconciling)return;
  if(typeof document!=='undefined'&&document.hidden)return;
  _reconciling=true;var changed=false;
  try{
    var localKarts=0;if(D.karts){var tr=['euro','road','sprint','kiddie'];for(var t=0;t<tr.length;t++)localKarts+=(D.karts[tr[t]]||[]).length;}
    var tables=[['karts','__karts__',localKarts]],keys=Object.keys(DB_TABLES);
    for(var k=0;k<keys.length;k++){var dkey=keys[k];tables.push([DB_TABLES[dkey],dkey,Array.isArray(D[dkey])?D[dkey].length:0]);}
    var counts=await Promise.all(tables.map(function(tt){return _tableCount(tt[0]);}));
    for(var i=0;i<tables.length;i++){var cnt=counts[i];if(cnt==null)continue;if(cnt<tables[i][2]){ if(await _pruneTable(tables[i][0],tables[i][1]))changed=true; }} // fewer rows in DB than local => something was deleted elsewhere
  }catch(e){}
  _reconciling=false;
  if(changed&&typeof _rerenderAfterSync==='function')_rerenderAfterSync();
}
async function _syncTick(){ await syncChanges(); await checkDeletes(); }
var _rtChannel=null,_rtLive=false;
function _setPollInterval(ms){ if(_syncTimer)clearInterval(_syncTimer); _syncTimer=setInterval(_syncTick,ms); }
function _removeById(dkey,id){
  if(dkey==='__karts__'){if(!D.karts)return false;var tr=['euro','road','sprint','kiddie'];for(var t=0;t<tr.length;t++){var arr=D.karts[tr[t]]||[];for(var i=0;i<arr.length;i++){if(arr[i]&&arr[i].id===id){arr.splice(i,1);return true;}}}return false;}
  if(!Array.isArray(D[dkey]))return false;var a=D[dkey];for(var j=0;j<a.length;j++){if(a[j]&&a[j].id===id){a.splice(j,1);return true;}}return false;
}
function _rtHandle(dkey,p){
  try{
    var ev=p.eventType||p.type,changed=false;
    if(ev==='DELETE'){var id=p.old&&p.old.id;if(id)changed=_removeById(dkey,id);}
    else{var obj=p.new&&p.new.data;if(obj&&obj.id)changed=(dkey==='__karts__')?_mergeKart(obj):_mergeArrayRow(dkey,obj);}
    if(changed&&dkey==='workOrders'&&typeof _partitionDeletedWOs==='function')_partitionDeletedWOs();
    if(changed&&typeof _rerenderAfterSync==='function')_rerenderAfterSync();
  }catch(e){}
}
function startRealtime(){
  if(!sb||!sb.channel||_rtChannel)return;
  try{
    var ch=sb.channel('lvmgp-live');
    ch.on('postgres_changes',{event:'*',schema:'public',table:'karts'},function(p){_rtHandle('__karts__',p);});
    var keys=Object.keys(DB_TABLES);
    for(var k=0;k<keys.length;k++){(function(dkey,tbl){ch.on('postgres_changes',{event:'*',schema:'public',table:tbl},function(p){_rtHandle(dkey,p);});})(keys[k],DB_TABLES[keys[k]]);}
    ch.subscribe(function(status){
      if(status==='SUBSCRIBED'){_rtLive=true;_setPollInterval(60000);try{_syncTick();}catch(e){}}
      else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){if(_rtLive){_rtLive=false;_setPollInterval(12000);}}
    });
    _rtChannel=ch;
  }catch(e){}
}
function startAutoSync(){
  _lastSyncWall=Date.now();
  _setPollInterval(12000);
  if(typeof document!=='undefined'&&document.addEventListener&&!window._syncBound){
    window._syncBound=true;
    document.addEventListener('visibilitychange',function(){if(!document.hidden)_syncTick();});
    window.addEventListener('focus',function(){_syncTick();});
  }
  startRealtime();
}



var ROLE_COLORS={owner:'#7c3aed',gm:'#6366f1',agm:'#6366f1',manager:'#4f46e5','area-lead':'#0891b2',lead:'#0e7490',mechanic:'#10b981',operator:'#f59e0b',restaurant:'#ec4899','arcade-tech':'#8b5cf6'};
var AREAS=['Maintenance','Attractions','Restaurant','Arcade'];
var ROLE_LABELS={owner:'Owner',gm:'GM',agm:'AGM',manager:'Manager','area-lead':'Area Lead',lead:'Lead Mechanic',mechanic:'Mechanic',operator:'Ride Operator',restaurant:'Restaurant Staff','arcade-tech':'Arcade Tech'};
var CAN_CREATE={owner:['gm','agm','manager','area-lead','lead','mechanic','operator','restaurant','arcade-tech'],gm:['agm','manager','area-lead','lead','mechanic','operator','restaurant','arcade-tech'],agm:['manager','area-lead','lead','mechanic','operator','restaurant','arcade-tech'],manager:['area-lead','lead','mechanic','operator','restaurant','arcade-tech'],'area-lead':['operator','restaurant','arcade-tech'],lead:['mechanic'],mechanic:[],operator:[],restaurant:[],'arcade-tech':[]};
var ROLE_TABS={
  owner:['dashboard','followups','messages','schedule','inspections','fleet','rides','facility','workorders','reports','arcade','parts','manuals','templates','compliance','vendors','incidents','handoff','team'],
  gm:['dashboard','followups','messages','schedule','inspections','fleet','rides','facility','workorders','reports','arcade','parts','manuals','templates','compliance','vendors','incidents','handoff','team'],
  agm:['dashboard','followups','messages','schedule','inspections','fleet','rides','facility','workorders','reports','arcade','parts','manuals','templates','compliance','vendors','incidents','handoff','team'],
  lead:['dashboard','followups','messages','schedule','inspections','fleet','rides','facility','workorders','reports','parts','manuals','compliance','vendors','incidents','handoff','team'],
  mechanic:['followups','messages','schedule','inspections','fleet','rides','facility','workorders','parts','manuals'],
  operator:['followups','inspections','messages','arcade'],
  manager:['dashboard','followups','messages','schedule','inspections','fleet','rides','facility','workorders','parts','manuals','arcade','vendors','team'],
  'area-lead':['dashboard','followups','messages','schedule','inspections','rides','arcade','incidents','handoff','team'],
  restaurant:['dashboard','followups','messages','schedule','handoff'],
  'arcade-tech':['dashboard','followups','messages','schedule','arcade','handoff']
};
var TAB_LABELS={dashboard:'Dashboard',followups:'Follow-Ups',messages:'Messages',inspections:'Inspections',fleet:'Fleet',rides:'Rides',facility:'Facility Assets',reports:'Reports',workorders:'Work Orders',schedule:'Schedule',vendors:'Vendors',compliance:'Compliance',incidents:'Incidents',arcade:'Arcade',parts:'Parts',handoff:'Handoff',team:'Team',templates:'Templates',manuals:'Manuals'};
var SC={open:'#f59e0b','in-progress':'#3b82f6',completed:'#22c55e','on-hold':'#94a3b8','awaiting-parts':'#ef4444','needs-scheduling':'#0891b2'};
var PC={low:'#94a3b8',medium:'#f59e0b',high:'#ef4444',critical:'#7c3aed'};
var TEAM=[];var TC={};var TB={};
var TM_SENIOR=['owner','gm','agm'];
function tmIsSenior(r){return TM_SENIOR.indexOf(r)>=0;}
// Can the current user see this team member at all? Hidden ("joining soon")
// members are visible only to seniors, and a hidden member only sees seniors.
function tmCanSee(t){if(!t)return false;var v=(typeof currentUser!=='undefined')?currentUser:null;if(!v)return !t.hidden;if(v.id===t.id)return true;if(t.hidden&&!tmIsSenior(v.role))return false;if(v.hidden&&!tmIsSenior(t.role))return false;return true;}
function tmByName(n){if(!n)return null;var a=D.teamMembers||[],k=String(n).trim().toLowerCase();for(var i=0;i<a.length;i++)if((a[i].name||'').trim().toLowerCase()===k)return a[i];return null;}
function tmMaskName(n){if(!n)return n;var m=tmByName(n);return (m&&!tmCanSee(m))?'\u2014':n;}
var MECH_PALETTE=[['#3b82f6','#eff6ff'],['#a855f7','#faf5ff'],['#10b981','#f0fdf4'],['#f59e0b','#fffbeb'],['#ef4444','#fef2f2'],['#06b6d4','#ecfeff'],['#8b5cf6','#f5f3ff'],['#ec4899','#fdf2f8']];
function refreshTeam(){TEAM=[];TC={};TB={};var l=[];for(var i=0;i<D.teamMembers.length;i++){var m=D.teamMembers[i];if(m.active===false)continue;if(typeof tmCanSee==='function'&&!tmCanSee(m))continue;if(m.role==='mechanic'||m.role==='lead')l.push(m.name);}l.sort();for(var i=0;i<l.length;i++){TEAM.push(l[i]);var p=MECH_PALETTE[i%MECH_PALETTE.length];TC[l[i]]=p[0];TB[l[i]]=p[1];}}
var HOURS=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
var PX=64;
var TN={euro:'Euro High Speed',road:'Road Track',sprint:'Sprint Track',kiddie:'Kiddie Track'};

var PREOP_TEMPLATES={
  'Euro Track':{who:'mechanic',mfr:true,roles:["mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"so-hrs",label:"Record Kart Hours",detail:"Enter the current hour-meter reading for this kart.",cat:"Admin",sev:"minor",type:"number",meterOnly:true},
    {id:"so-fuel",label:"Fuel System",detail:"Check for fuel leaks from tank, cap, filter, vents, fittings. Remove cap, inspect gasket for even filler neck imprint and damage. Confirm hoses are properly connected at the tank, fuel sump, filter, and pump.",cat:"Engine",sev:"major"},
    {id:"so-oil",label:"Engine & Reducer Oil Level",detail:"Loosen filler caps and confirm both engine and reducer oil are at the required level. Check for leaks at the caps and oil-change nuts. Level check only \u2014 the oil change is on the hour schedule. Oil: 10W40.",cat:"Engine",sev:"major"},
    {id:"so-covers",label:"Covers & Guards",detail:"Check proper installation of all covers and guards. Check that body parts have no broken or sharp edges.",cat:"Safety",sev:"major"},
    {id:"so-belts",label:"Seat Belts",detail:"Check for frayed webbing, loose stitching; check buckle and adjustment. Belt should extend slowly, lock when pulled quickly, and return to casing.",cat:"Safety",sev:"major"},
    {id:"so-tires",label:"Tires & Wheels",detail:"Wear lines must be visible. Tire pressure: Front 23-25 PSI, Rear 25-28 PSI. Check for tears or scrubbing, and confirm correct rotation direction (arrow on sidewall). Check lug nuts/studs  if torque markings misalign, check with torque wrench and remark. DO NOT OVER TORQUE.",cat:"Mechanical",sev:"major"},
    {id:"so-bolts",label:"All Nuts & Bolts",detail:"Check by feel and sight for loose and/or missing nuts and bolts throughout kart  nothing should move. (The torque-wrench audit with specific values is done monthly.)",cat:"Mechanical",sev:"major"},
    {id:"so-brake",label:"Brake System (Visual)",detail:"Check brake fluid level  not black; confirm reservoir cap is secure. Check pads are correctly fitted, minimum 8mm (4mm lining + 4mm steel support). Check for leaks at brake hose connections. Confirm firm mechanical contact between the brake pedal and master cylinder.",cat:"Brakes",sev:"major"},
    {id:"so-belt",label:"Belt / Chain Tension & State",detail:"Check drive belt (or chain) tension: 5mm deflection at the tensioner. Inspect for cracks or glazing. Replace any damaged belt/chain to prevent engine overspeed.",cat:"Mechanical",sev:"major"},
    {id:"so-steer",label:"Steering (Visual)",detail:"Check front wheels aligned (same direction). Check upper/lower column plastic support torque and stub axle screws. Ensure front wheel axle is not out of line, sub axles not bent, tie rods not damaged.",cat:"Mechanical",sev:"major"},
    {id:"so-rope",label:"Starter Rope",detail:"Check rope for fraying. Check air intake screen for foreign matter.",cat:"Engine",sev:"minor"},
    {id:"so-roll",label:"Roll Bar",detail:"Check for any looseness in roll bar system.",cat:"Safety",sev:"major"},
    {id:"so-drub",label:"D Rubbers & Bumpers",detail:"Check for signs of damage. Check for loose or hanging bolts.",cat:"Safety",sev:"minor"},
    {id:"so-decal",label:"Warning Decals",detail:"Check that all warning decals are in place and legible.",cat:"Safety",sev:"minor"},
    {id:"so-switch",label:"On/Off Switch",detail:"Check switch is properly secured and works to turn kart on and off.",cat:"Electrical",sev:"major"},
    {id:"so-accel",label:"Accelerator (Test Drive)",detail:"Check for smooth operation and full return to idle when released  no sticking.",cat:"Mechanical",sev:"major"},
    {id:"so-tdbrak",label:"Brakes (Test Drive)",detail:"Check pedal travel; check for proper action during test drive.",cat:"Brakes",sev:"major"},
    {id:"so-tdstr",label:"Steering (Test Drive)",detail:"Check for smooth and precise movement full left to full right. Feel for jerkiness; listen for abnormal sounds.",cat:"Mechanical",sev:"major"},
    {id:"so-remote",label:"Remote Shut-Off",detail:"Verify pit loop slows karts after transponder; verify remote slowdown slows kart; verify remote stop stops kart.",cat:"Safety",sev:"major"}
  ]},
  'Road Track':{who:'mechanic',mfr:true,roles:["operator","mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"so-hrs",label:"Record Kart Hours",detail:"Enter the current hour-meter reading for this kart.",cat:"Admin",sev:"minor",type:"number",meterOnly:true},
    {id:"so-fuel",label:"Fuel System",detail:"Check for fuel leaks from tank, cap, filter, vents, fittings. Remove cap, inspect gasket for even filler neck imprint and damage.",cat:"Engine",sev:"major"},
    {id:"so-covers",label:"Covers & Guards",detail:"Check proper installation of all covers and guards. Check that body parts have no broken or sharp edges.",cat:"Safety",sev:"major"},
    {id:"so-belts",label:"Seat Belts",detail:"Check for frayed webbing, loose stitching; check buckle and adjustment. Belt should extend slowly, lock when pulled quickly, and return to casing.",cat:"Safety",sev:"major"},
    {id:"so-tires",label:"Tires & Wheels",detail:"Wear lines must be visible. Tire pressure: Front 23-25 PSI, Rear 25-28 PSI. Check lug nuts/studs — if torque markings misalign, check with torque wrench and remark. DO NOT OVER TORQUE.",cat:"Mechanical",sev:"major"},
    {id:"so-bolts",label:"All Nuts & Bolts",detail:"Check for loose and/or missing nuts and bolts throughout kart.",cat:"Mechanical",sev:"major"},
    {id:"so-brake",label:"Brake System (Visual)",detail:"Check brake fluid level — not black. Check pads are correctly fitted, minimum 8mm (4mm lining + 4mm steel support). Check for leaks at brake hose connections.",cat:"Brakes",sev:"major"},
    {id:"so-steer",label:"Steering (Visual)",detail:"Check front wheels aligned (same direction). Check upper/lower column plastic support torque and stub axle screws. Ensure front wheel axle is not out of line, sub axles not bent, tie rods not damaged.",cat:"Mechanical",sev:"major"},
    {id:"so-rope",label:"Starter Rope",detail:"Check rope for fraying. Check air intake screen for foreign matter.",cat:"Engine",sev:"minor"},
    {id:"so-roll",label:"Roll Bar",detail:"Check for any looseness in roll bar system.",cat:"Safety",sev:"major"},
    {id:"so-drub",label:"D Rubbers & Bumpers",detail:"Check for signs of damage. Check for loose or hanging bolts.",cat:"Safety",sev:"minor"},
    {id:"so-decal",label:"Warning Decals",detail:"Check that all warning decals are in place and legible.",cat:"Safety",sev:"minor"},
    {id:"so-switch",label:"On/Off Switch",detail:"Check switch is properly secured and works to turn kart on and off.",cat:"Electrical",sev:"major"},
    {id:"so-accel",label:"Accelerator (Test Drive)",detail:"Check for smooth operation and full return when released.",cat:"Mechanical",sev:"major"},
    {id:"so-tdbrak",label:"Brakes (Test Drive)",detail:"Check pedal travel; check for proper action during test drive.",cat:"Brakes",sev:"major"},
    {id:"so-tdstr",label:"Steering (Test Drive)",detail:"Check for smooth and precise movement full left to full right. Feel for jerkiness; listen for abnormal sounds.",cat:"Mechanical",sev:"major"},
    {id:"so-remote",label:"Remote Shut-Off",detail:"Verify pit loop slows karts after transponder; verify remote slowdown slows kart; verify remote stop stops kart.",cat:"Safety",sev:"major"}
  ]},
  'Kiddie Track':{who:'mechanic',mfr:true,roles:["operator","mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"kk-drub",label:"D Rubbers & Bumpers",detail:"Check for signs of damage; check that there are no loose, dangling, or missing bolts.",cat:"Safety",sev:"major"},
    {id:"kk-fuel",label:"Fuel System",detail:"Check for fuel leaks from tank, cap, filter, vents, fittings. Remove cap, inspect gasket for even filler neck imprint and damage.",cat:"Engine",sev:"major"},
    {id:"kk-switch",label:"On/Off Switch",detail:"Check that switch is secured in place, not dangling or loose.",cat:"Electrical",sev:"major"},
    {id:"kk-belts",label:"Seat Belts",detail:"Check for frayed webbing, loose stitching; check buckle adjustment and operation.",cat:"Safety",sev:"major"},
    {id:"kk-pads",label:"Pads",detail:"Check seat, seat belt, steering wheel, and steering post pads for damage.",cat:"Safety",sev:"minor"},
    {id:"kk-steer",label:"Steering",detail:"Visually check that front tires appear aligned (going in same direction).",cat:"Mechanical",sev:"major"},
    {id:"kk-tires",label:"Tires & Wheels",detail:"Look for visual signs of tire wear and flat tires; check wheels for loose or missing lug nuts.",cat:"Mechanical",sev:"major"},
    {id:"kk-mounts",label:"Body Mounts",detail:"Check for looseness or improper fastening.",cat:"Safety",sev:"minor"},
    {id:"kk-roll",label:"Roll Bar",detail:"Check for any looseness in roll bar system.",cat:"Safety",sev:"major"},
    {id:"kk-decal",label:"Safety & Warning Decals",detail:"Check for all safety and warning decals.",cat:"Safety",sev:"minor"},
    {id:"kk-switch2",label:"On/Off Switch (Test Drive)",detail:"Check that on/off switch is properly secured and works to turn kart on and off.",cat:"Electrical",sev:"major"},
    {id:"kk-accel",label:"Accelerator",detail:"Check for smooth operation and full return when released.",cat:"Mechanical",sev:"major"},
    {id:"kk-brake",label:"Brakes",detail:"Check pedal travel; check for proper action during test drive.",cat:"Brakes",sev:"major"}
  ]},
  'Sprint Track':{who:'mechanic',mfr:true,roles:["operator","mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"spr-fuel",label:"Fuel System",detail:"Check for fuel leaks from tank, cap, filter, vents, fittings. Remove cap, inspect gasket for even imprint.",cat:"Engine",sev:"major"},
    {id:"spr-covers",label:"Covers & Guards",detail:"Visually check: steering cover, axle cover, pulley guard, fenders, and body properly installed.",cat:"Safety",sev:"major"},
    {id:"spr-mounts",label:"Body Mounts",detail:"Check for looseness or improper fastening.",cat:"Safety",sev:"minor"},
    {id:"spr-belts",label:"Seat Belts",detail:"Check for frayed webbing, loose stitching; buckle adjustment and operation.",cat:"Safety",sev:"major"},
    {id:"spr-pads",label:"Pads",detail:"Check seat, seat belt, steering wheel, and steering post pads for damage.",cat:"Safety",sev:"minor"},
    {id:"spr-tires",label:"Tires & Wheels",detail:"Check for tire wear, flat tires, loose or missing lug nuts.",cat:"Mechanical",sev:"major"},
    {id:"spr-tpsi",label:"Tire Pressure (30psi)",detail:"Should be 30 PSI. Record actual reading.",cat:"Mechanical",sev:"major"},
    {id:"spr-bolts",label:"All Nuts & Bolts",detail:"Check for loose and/or missing nuts and bolts.",cat:"Mechanical",sev:"major"},
    {id:"spr-steer",label:"Steering",detail:"Visually check that front tires appear aligned (going in same direction).",cat:"Mechanical",sev:"major"},
    {id:"spr-rope",label:"Starter Rope",detail:"Check rope for fraying. Check air intake screen for foreign matter.",cat:"Engine",sev:"minor"},
    {id:"spr-roll",label:"Roll Bar",detail:"Check for any looseness in roll bar system.",cat:"Safety",sev:"major"},
    {id:"spr-drub",label:"D Rubbers & Bumpers",detail:"Check for damage, loose or missing bolts.",cat:"Safety",sev:"minor"},
    {id:"spr-decal",label:"Safety Decals",detail:"Check for all safety and warning decals present.",cat:"Safety",sev:"minor"},
    {id:"spr-switch",label:"On/Off Switch",detail:"Check switch secured, not dangling. Verify works to turn kart on/off.",cat:"Electrical",sev:"major"},
    {id:"spr-accel",label:"Accelerator",detail:"Check for smooth operation and full return when released.",cat:"Mechanical",sev:"major"},
    {id:"spr-brake",label:"Brakes",detail:"Check pedal travel; proper braking action during test drive.",cat:"Brakes",sev:"major"},
    {id:"spr-remote",label:"Remote Shut-Off",detail:"Verify pit loop slows karts. Verify remote slowdown and stop functions work.",cat:"Safety",sev:"major"}
  ]},
  'Daily Track':{who:'operator',mfr:false,roles:["operator","mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"tr-surface",label:"Track Surface",detail:"Inspect track surface for cracks, uneven areas, or debris. Ensure free from oil spills or slippery substances.",cat:"Track",sev:"major"},
    {id:"tr-barriers",label:"Track Barriers",detail:"Check integrity of barriers and guardrails; ensure securely fastened and properly aligned.",cat:"Safety",sev:"major"},
    {id:"tr-signs",label:"Signage",detail:"Verify all safety, directional, and instructional signs are in place, visible, and in good condition.",cat:"Safety",sev:"minor"},
    {id:"tr-exits",label:"Emergency Exits",detail:"Confirm emergency exits are clearly marked, accessible, and open without difficulty.",cat:"Safety",sev:"major"},
    {id:"tr-kartrol",label:"Kartrol Speaker",detail:"Test overhead speaker — verify safety message plays and can be heard in pit and waiting areas.",cat:"Operations",sev:"major"},
    {id:"tr-mega",label:"Megaphone",detail:"Test megaphone to ensure it is in proper working order.",cat:"Operations",sev:"minor"},
    {id:"tr-clean",label:"Cleanliness",detail:"Ensure line/waiting area and pit are clean of debris and garbage.",cat:"Operations",sev:"minor"},
    {id:"tr-signs2",label:"Area Signage",detail:"Look for missing or damaged signs: Height, Rules of the Road, Rotating Parts Warning, Amusement Risk.",cat:"Safety",sev:"minor"},
    {id:"tr-extgr",label:"Fire Extinguishers",detail:"Ensure fire extinguishers are available, properly placed, and charge indicator is in the green.",cat:"Safety",sev:"major"},
    {id:"tr-firstaid",label:"First Aid Kit",detail:"Ensure first aid kit is available with: adhesive bandages, gauze pads, tape, antiseptic wipes, scissors, gloves, eye wash, hand sanitizer.",cat:"Safety",sev:"major"}
  ]},
  'Tornado':{who:'mechanic',mfr:true,roles:["mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"t-pins",label:"Lock Pins",detail:"Check all lock pins are in place and secured.",cat:"Safety",sev:"major"},
    {id:"t-air",label:"Air Compressor (100-120psi)",detail:"Check that air compressor turns on at 100psi and off at 120psi.",cat:"Mechanical",sev:"major"},
    {id:"t-mainbrg",label:"Main Bearing Bolts",detail:"Check main bearing bolts are tight.",cat:"Mechanical",sev:"major"},
    {id:"t-liftarm",label:"Main Lifting Arms",detail:"Check main lifting arms for cracks.",cat:"Structural",sev:"major"},
    {id:"t-collar",label:"Lift Arm Pin Collars",detail:"Check main lift arm pin retaining collars are locked in place.",cat:"Safety",sev:"major"},
    {id:"t-loweratt",label:"Lift Arm Lower Attachment",detail:"Check main lift arm lower attachment for cracks.",cat:"Structural",sev:"major"},
    {id:"t-hydpivot",label:"Hydraulic Cylinder Pivots",detail:"Check hydraulic cylinder pivots for cracks.",cat:"Structural",sev:"major"},
    {id:"t-drivegear",label:"Main Drive Gear",detail:"Check main drive gear for looseness.",cat:"Mechanical",sev:"major"},
    {id:"t-drivetrain",label:"Drive Train",detail:"Check drive train for tightness.",cat:"Mechanical",sev:"major"},
    {id:"t-motormnt",label:"Motor Mount",detail:"Check motor mount for cracks.",cat:"Structural",sev:"major"},
    {id:"t-sweeps",label:"Sweeps",detail:"Check sweeps for cracks. Check all lock pins.",cat:"Structural",sev:"major"},
    {id:"t-carpivot",label:"Car Pivots",detail:"Check each pivot for cracks. Check pivot bolts for lock nuts.",cat:"Structural",sev:"major"},
    {id:"t-carshock",label:"Car Shock Mounts & Shocks",detail:"Check car shock mounts for cracks; check car shocks for proper operation.",cat:"Mechanical",sev:"major"},
    {id:"t-seat",label:"Seats",detail:"Check seat pipe for cracks; check that seat halves are down and seated; check spin wheel is tight.",cat:"Safety",sev:"major"},
    {id:"t-lapbar",label:"Seat Lap Bar",detail:"Check lap bar for proper operation; check lap bar foam is centered and in good shape.",cat:"Safety",sev:"major"},
    {id:"t-lapbolt",label:"Lap Bar Hinge Bolts",detail:"Check lap bar hinge bolts and lock mechanism hinge bolts for looseness or broken bolts.",cat:"Safety",sev:"major"},
    {id:"t-lappin",label:"Lap Bar Cylinder Pins",detail:"Check lap bar cylinder attachment pins for security and cotter pins.",cat:"Safety",sev:"major"},
    {id:"t-laparm",label:"Lap Bar Arm",detail:"Check lap bar arm for cracks.",cat:"Structural",sev:"major"},
    {id:"t-laptest",label:"Lap Bar Ratchet Test",detail:"Push lap bar open then push down — must ratchet down and lock at each detent.",cat:"Safety",sev:"major"},
    {id:"t-airlock",label:"Air Locking System",detail:"Activate air locking system — all seats should open. Watch that manual release lever does not stick.",cat:"Safety",sev:"major"},
    {id:"t-opctrl",label:"Operations Controls",detail:"Activate foot switch — ride should turn up to speed and come to smooth stop on release.",cat:"Safety",sev:"major"},
    {id:"t-raise",label:"Raise Function",detail:"Activate foot switch, push ride raise button — ride raises, lowers automatically after 30 seconds.",cat:"Safety",sev:"major"},
    {id:"t-estop",label:"Emergency Stop",detail:"With ride raising, push emergency stop — ride should smoothly lower and stop.",cat:"Safety",sev:"major"},
    {id:"t-lube1",label:"Lubrication — Lifting Arms",detail:"Main center lifting arms — 1 shot of grease each, 2 zerks per arm.",cat:"Maintenance",sev:"major"},
    {id:"t-lube2",label:"Lubrication — Hydraulic Pivots",detail:"Hydraulic cylinder pivot bushings — 1 shot, 4 bushings.",cat:"Maintenance",sev:"major"},
    {id:"t-lube3",label:"Lubrication — Car/Sweep Pivot",detail:"Car to sweep pivot block — 1 shot each pivot, 2 zerks per pivot.",cat:"Maintenance",sev:"major"},
    {id:"t-lube4",label:"Lubrication — Spinning Bushing",detail:"Nylon spinning bushing — light machine oil, 1-2 shots, wipe off excess.",cat:"Maintenance",sev:"major"},
    {id:"t-compres",label:"Air Compressor Oil & Leaks",detail:"Check air compressor oil level; check for visual or audio air leaks; verify correct PSI.",cat:"Maintenance",sev:"major"}
  ]},
  'Dragon Coaster':{who:'mechanic',mfr:true,roles:["mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"dc-pins",label:"Pins, Wedges & Clips",detail:"Check for loose or missing pins, wedges, and clips.",cat:"Safety",sev:"major"},
    {id:"dc-lapbar",label:"Lap Bars",detail:"Check lap bars for proper operation.",cat:"Safety",sev:"major"},
    {id:"dc-jackstd",label:"Track Jackstand Bolts",detail:"Check track jackstand bolts for looseness.",cat:"Structural",sev:"major"},
    {id:"dc-spread",label:"Track Joint Spreaders",detail:"Check track joint spreaders for cracks where welded to pipe track.",cat:"Structural",sev:"major"},
    {id:"dc-axle",label:"Car Wheel Axle Bolts",detail:"Check car wheels for loose axle bolts.",cat:"Mechanical",sev:"major"},
    {id:"dc-wear",label:"Car Wheel Wear",detail:"Check car wheels for excessive wear.",cat:"Mechanical",sev:"major"},
    {id:"dc-lube",label:"Lubrication Schedule",detail:"Confirm lubrication schedule has been completed.",cat:"Maintenance",sev:"major"},
    {id:"dc-frame",label:"Car Frames",detail:"Check car frames for cracks.",cat:"Structural",sev:"major"},
    {id:"dc-dtires",label:"Drive & Brake Tires (35psi)",detail:"Check drive tires and brake tires for proper air pressure (35psi) and excessive wear.",cat:"Mechanical",sev:"major"},
    {id:"dc-brake",label:"Brake Operation",detail:"Check brake for proper operation. Check that drive tires do not slip when operating ride.",cat:"Safety",sev:"major"},
    {id:"dc-coupler",label:"Car Couplers",detail:"Check car couplers for loose mounting bolts and cracks.",cat:"Structural",sev:"major"},
    {id:"dc-fbolt",label:"Fiberglass Body Bolts",detail:"Check fiberglass body attachment bolts for looseness or missing bolts.",cat:"Mechanical",sev:"minor"},
    {id:"dc-grabbar",label:"Seat Grab Bars",detail:"Check seat grab bars for looseness.",cat:"Safety",sev:"major"},
    {id:"dc-brframe",label:"Ride Brake Frame",detail:"Check ride brake frame for cracks.",cat:"Structural",sev:"major"},
    {id:"dc-belts",label:"Motor V-Belts",detail:"Check main motor and kicker motor V-belts for tightness and wear.",cat:"Mechanical",sev:"major"},
    {id:"dc-motfrm",label:"Motor Frames",detail:"Check main motor and kicker motor frame for cracks.",cat:"Structural",sev:"major"},
    {id:"dc-gearbox",label:"Gear Box",detail:"Check gear boxes for leaks. Check gear box oil level if leaks are showing.",cat:"Mechanical",sev:"major"},
    {id:"dc-train",label:"Train Start & Acceleration",detail:"Verify train starts smoothly and accelerates to full speed before contacting up ramp kicker motor.",cat:"Mechanical",sev:"major"},
    {id:"dc-lbmnt",label:"Lap Bar Mounting",detail:"Check lap bar mounting for security. Check seat liner for security.",cat:"Safety",sev:"major"},
    {id:"dc-lbbolt",label:"Lap Bar Hinge Bolts",detail:"Check lap bar hinge bolts and lock mechanism hinge bolts for looseness or broken bolts.",cat:"Safety",sev:"major"},
    {id:"dc-lbpin",label:"Lap Bar Cylinder Pins",detail:"Check lap bar air cylinder attachment pins for security and cotter pins.",cat:"Safety",sev:"major"},
    {id:"dc-lbarm",label:"Lap Bar Arm",detail:"Check lap bar arm for cracks.",cat:"Structural",sev:"major"}
  ]},
  'Fun Slide':{who:'any',mfr:true,roles:["operator","mechanic","lead","owner","gm","agm","manager"],items:[
    {id:"fs-speed",label:"Slide Speed Agreement",detail:"Understand: if rider gets stuck or has to push, spray Pledge on humps only (moving downward, 6 inches past each hump). Over-spraying is a safety hazard. Confirm you understand.",cat:"Safety",sev:"major"},
    {id:"fs-purple",label:"Purple Slide Speed",detail:"Test speed of purple slide — spray Pledge if needed.",cat:"Safety",sev:"major"},
    {id:"fs-pink",label:"Pink Slide Speed",detail:"Test speed of pink slide — spray Pledge if needed.",cat:"Safety",sev:"major"},
    {id:"fs-green",label:"Green Slide Speed",detail:"Test speed of green slide — spray Pledge if needed.",cat:"Safety",sev:"major"},
    {id:"fs-pins",label:"Pins & Snap Keys",detail:"Ensure all pins and snap keys are in proper placement and good condition.",cat:"Safety",sev:"major"},
    {id:"fs-steps",label:"Steps & Welds",detail:"Walk the steps — check for damage or cracks in the welding.",cat:"Structural",sev:"major"},
    {id:"fs-lights",label:"Ride Lights",detail:"Turn on lights, wait 15 seconds, turn back off. Verify all work.",cat:"Electrical",sev:"minor"},
    {id:"fs-jbox",label:"Junction Box Panels",detail:"Ensure all panels on the junction box are properly closed.",cat:"Electrical",sev:"major"},
    {id:"fs-mats",label:"Slide Mats Count",detail:"Inspect slide mats for large holes. Record number of usable mats in the mat box.",cat:"Equipment",sev:"record",count:true},
    {id:"fs-hrail",label:"Handrails",detail:"Ensure handrails are properly in place and safe. If heat protection is damaged, submit WO.",cat:"Safety",sev:"major"},
    {id:"fs-divider",label:"Top Divider Handrails",detail:"Ensure the three handrails dividing slides at the top are properly positioned and safe.",cat:"Safety",sev:"major"},
    {id:"fs-breaker",label:"Breaker",detail:"Check slide breaker is ON. If off, do not reset — contact mechanical team.",cat:"Electrical",sev:"major"},
    {id:"fs-banners",label:"Shade Banners",detail:"Ensure shade banners are free from damage and properly secured with zip ties.",cat:"Safety",sev:"minor"},
    {id:"fs-purple2",label:"Purple Slide Surface",detail:"Check purple slide is free from cracks or damage.",cat:"Structural",sev:"major"},
    {id:"fs-pink2",label:"Pink Slide Surface",detail:"Check pink slide is free from cracks or damage.",cat:"Structural",sev:"major"},
    {id:"fs-green2",label:"Green Slide Surface",detail:"Check green slide is free from cracks or damage.",cat:"Structural",sev:"major"}
  ]}
};

function makeKarts(prefix,track,count){
  var ktMap={EURO:'Sodi GT5R',ROAD:'Formula K F1000',SPRT:'J&J F-8000 Sprint',KIDD:'Formula K F5000'};
  var engMap={EURO:'GX200',ROAD:'GX160',SPRT:'GX200',KIDD:'GX160'};
  var arr=[];
  for(var i=0;i<count;i++){
    var hrs=Math.round(100+Math.random()*400);
    var kt=ktMap[prefix]||prefix;
    // Euro SR5 karts start at #13
    if(prefix==='EURO'&&i>=12){kt='Sodi SR5';}
    arr.push({id:prefix+(i+1),num:i+1,track:track,kartType:kt,engine:engMap[prefix]||'GX200',
      status:'active',engineHrs:hrs,lastOilHrs:Math.round(hrs-Math.random()*45),
      last50hrHrs:Math.round(hrs-Math.random()*45),shopWoId:null,
      preOpToday:false,transponderSerial:'',notes:''});
  }
  return arr;
}

var D={
  messages:[],
  pmTemplates:[],
  workOrders:[],
  assets:[
    {id:"MX-6528874",name:"Tornado",category:"ride",maintenanceType:"vendor",status:"operational",parent:"",serial:"",manufacturer:"Wisdom",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-6646997",name:"Dragon Coaster",category:"ride",maintenanceType:"vendor",status:"operational",parent:"",serial:"",manufacturer:"Wisdom",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-6647018",name:"Fun Slide",category:"ride",maintenanceType:"vendor",status:"operational",parent:"",serial:"",manufacturer:"Frederiksen Industries, Inc.",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-6698174",name:"Lincon Pizza Oven",category:"food-service",maintenanceType:"internal",status:"operational",parent:"",serial:"L27020",manufacturer:"Lincoln Impinger\u00ae II",model:"Impinger\u00ae II",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Model: 1600 000 DB (Base/Original Model)",vendorOnly:false,subAssetOnly:false},
    {id:"MX-6698175",name:"Manitowek Ice machines",category:"food-service",maintenanceType:"internal",status:"operational",parent:"",serial:"1120086630",manufacturer:"Manitowoc",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-TURBOAIR01",name:"Turbo Air Sandwich/Salad Prep Cooler",category:"food-service",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"Turbo Air",model:"MST-48-N",purchaseCost:3720,currentValue:3720,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"48\" 2-door refrigerated sandwich/salad prep table. 115V/60Hz, 1/3 HP, R-290 refrigerant 2.4oz, 4.4A, 12 cu ft capacity, 242 lbs. Temp range 33-39°F. Self-cleaning condenser. Condenser coil must be cleaned every 90 days. R-290 (propane) refrigerant — flammable, service by qualified tech only. Warranty: 3yr parts & labor, 5yr compressor.",vendorOnly:false,subAssetOnly:false,manuals:[{title:"MST-48-N Installation & Operation Manual",url:"https://turboairinc.com/wp-content/uploads/2021/01/MST_MST-Mega-HC.pdf"}]},
    {id:"MX-6889714",name:"A/C 1 - 5ton Over walkin",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"Carrier",model:"661BE060-A",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-6889720",name:"A/C 2 - 5ton over walk in",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"Carrier",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-6889725",name:"A/C 3 - 7.5 ton over walk in",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"250514696",manufacturer:"Daikin",model:"DH6TE0904",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Split System; Rooftop Condenser, 7.5 Ton R-32 HP 3Phase 460V, separate air handler (see child)\n\nRequires 2 of each filter (16 x 20 x 2, 20 x 20 x 2), change monthly\n\nHVAC Unit is 11.r EER / 15 IEER; 2-stage tandem, not inverter/VFG Compressor\nWhen cooling, approximate power draw is 92k BTU per hour / 11.4 EER = 8,070 watts\nTypical cooling cost is 8-10kw, on a very hot day it could reach up to 9-11\nIn terms of cost ($0.081744/kwh as of 4/2026), that equals roughly $0.74 per hour, plus demand and facility charges of 10.08*highest demand in month, assuming this contributes, roughly $100/month, totaling roughly $230 - $290 per month.",vendorOnly:false,subAssetOnly:false},
    {id:"MX-6889731",name:"RTU 4 SW Side by tornado (HVAC)",category:"facility",maintenanceType:"internal",status:"out-of-service",parent:"",serial:"1803407624",manufacturer:"Daikin",model:"DCC 120xxx4vxxxac",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"HVAC Unit - not currently in service.  Leak and at least one bad compressor.",vendorOnly:false,subAssetOnly:false},
    {id:"MX-7754858",name:"Entry Gates",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-8062577",name:"Table",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Inside/Outside Table",vendorOnly:false,subAssetOnly:false},
    {id:"MX-8372680",name:"Exit Gate at Sprint",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Sprint Track",lastService:"",nextService:"",notes:"Exit gate from Sprint track",vendorOnly:false,subAssetOnly:false},
    {id:"MX-8501057",name:"Track tools",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Tools used at the tracks to move karts or the tires around the track.",vendorOnly:false,subAssetOnly:false},
    {id:"MX-8501065",name:"Tire Machine",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Shop Tire Machine for Karts",vendorOnly:false,subAssetOnly:false},
    {id:"MX-8760413",name:"Exit Gate Kiddie Karts",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Exit Gate/ Fence",vendorOnly:false,subAssetOnly:false},
    {id:"MX-9781881",name:"MyLaps transponder 12486708",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 17 (SR5)",serial:"12486708",manufacturer:"mylaps",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart",vendorOnly:false,subAssetOnly:true},
    {id:"MX-9781882",name:"MyLaps Transponder 12724659",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"",serial:"12724659",manufacturer:"mylaps",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart",vendorOnly:false,subAssetOnly:true},
    {id:"MX-9781884",name:"MyLaps Transponder 12608563",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 16 (SR5)",serial:"12608563",manufacturer:"mylaps",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart",vendorOnly:false,subAssetOnly:true},
    {id:"MX-9781885",name:"MyLaps Transponder 12673979",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"",serial:"12673979",manufacturer:"mylaps",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10029566",name:"Hytera Radio #6",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R23O180728",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10030321",name:"Hytera Radio #16",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R23O180726",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Manager/Sup Radio\nhas a clip",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10030338",name:"Hytera Radio #15",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R23O180730",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"THIS RADIO IS CURRENTLY ASSIGNED TO LIZ\nhas clip",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10030348",name:"Hytera Radio #7",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R23O180729",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10030365",name:"Hytera Radio #12",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R20D110884",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"THIS RADIO IS CURRENTLY ASSIGNED TO MO",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031064",name:"Hytera Radio #10",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R214071248",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031080",name:"Hytera Radio #1",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R216242269",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031097",name:"Hytera Radio #5",category:"radio",maintenanceType:"vendor",status:"out-of-service",parent:"",serial:"R19N230213",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031111",name:"Hytera Radio #8",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R214071249",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031124",name:"Hytera Radio #4",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R214071247",manufacturer:"Hytera",model:"pd602i",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"temporally assigned to mo",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031136",name:"Hytera Radio #3",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R216242270",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031157",name:"Hytera Radio #11",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R247221065",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Placed in service August 2025, 3 year Warranty",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031163",name:"Hytera Radio #14",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R19N230252",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Placed in service August 2025",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10031172",name:"Hytera Radio #13",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R19N230251",manufacturer:"Hytera",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Placed in service August 2025",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10050888",name:"Men\u2019s sink 1",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-10150130",name:"Cilico scanner #1",category:"scanner",maintenanceType:"vendor",status:"operational",parent:"",serial:"OE8838003164",manufacturer:"Cilico",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10150131",name:"Cilico scanner #2",category:"scanner",maintenanceType:"vendor",status:"operational",parent:"",serial:"OE8838003144",manufacturer:"Cilico",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10150132",name:"Cilico scanner #3",category:"scanner",maintenanceType:"vendor",status:"operational",parent:"",serial:"OE8838003140",manufacturer:"Cilico",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10150135",name:"Cilico scanner #4",category:"scanner",maintenanceType:"vendor",status:"operational",parent:"",serial:"OE8838003157",manufacturer:"Cilico",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10150136",name:"Cilico scanner#5",category:"scanner",maintenanceType:"vendor",status:"operational",parent:"",serial:"OE8838003849",manufacturer:"Cilico",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10150137",name:"Cilico scanner #6",category:"scanner",maintenanceType:"vendor",status:"operational",parent:"",serial:"OE8838003824",manufacturer:"Cilico",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-10203708",name:"My laps transponder 6366338",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 1",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203709",name:"My laps transponder 6166119",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 2",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203710",name:"My laps transponder 6321334",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 3",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203711",name:"My laps transponder 6413607",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 4",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203712",name:"My laps transponder 6489598",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 5",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203713",name:"My laps transponder 6130884",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Family Kart 7",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203714",name:"My laps transponder 6320433",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 9",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203715",name:"My laps transponder 7403289",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 10",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203716",name:"My laps transponder 6735069",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 11",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203719",name:"My laps transponder 12479833",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 13 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203720",name:"My laps transponder 12751876",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 14 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203723",name:"My laps transponder 12536588",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 15 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203725",name:"My laps transponder 12470103",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 18 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203727",name:"My laps transponder 12478827",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 19 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203728",name:"My laps transponder 12478926",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203729",name:"12441277",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 21 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-10203731",name:"My laps transponder 12476005",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 22 (SR5)",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-11181827",name:"Honda Engine",category:"engine-spare",maintenanceType:"internal",status:"operational",parent:"Sodi 10",serial:"GCBTT-2408091",manufacturer:"Honda",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Honda Engine\nPart Lookup by Serial Number: https://peparts.honda.com/engines/engines/GX/GX200/GX200UT2-RH2/illustrations",vendorOnly:false,subAssetOnly:false},
    {id:"MX-12338810",name:"Make table large",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-12338817",name:"Make Table Small",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-12474221",name:"A/C 5 by tornado",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"Carrier",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-12474222",name:"A/C 6  7.5 ton North",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"Daikin",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-12474375",name:"A/C 7 - 110 ton North sign",category:"facility",maintenanceType:"internal",status:"out-of-service",parent:"",serial:"",manufacturer:"Daikin",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:false},
    {id:"MX-12496123",name:"Tornado pod 7",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Pod 7",vendorOnly:false,subAssetOnly:false},
    {id:"MX-13759793",name:"Inside air filters for big a/c (cleaning)",category:"facility",maintenanceType:"internal",status:"operational",parent:"",serial:"",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Replace and wipe down grills for filter holders",vendorOnly:false,subAssetOnly:false},
    {id:"MX-14165578",name:"My laps transponder",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 6",serial:"6414848",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-14165584",name:"My Laps Transponder",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 23",serial:"12673979",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-14165592",name:"My Laps Transponder",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 7",serial:"6130884",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-14165594",name:"My Laps Transponder",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 12",serial:"12724659",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-14165597",name:"My Laps Transponder",category:"transponder",maintenanceType:"sub-asset-only",status:"operational",parent:"Sodi 20 (SR5)",serial:"12478926",manufacturer:"",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:false,subAssetOnly:true},
    {id:"MX-16076253",name:"Hytera Radio #17",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R246281206",manufacturer:"Hytera",model:"BD502i VHF",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-16190547",name:"Hytera Radio #18",category:"radio",maintenanceType:"vendor",status:"operational",parent:"",serial:"R246281215",manufacturer:"Hytera",model:"BD502i VHF",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"",vendorOnly:true,subAssetOnly:false},
    {id:"MX-16713515",name:"AC Unit 2 Air Handler",category:"facility",maintenanceType:"internal",status:"operational",parent:"A/C 3 - 7.5 ton over walk in",serial:"250743740",manufacturer:"Daikin",model:"",purchaseCost:0.0,currentValue:0.0,location:"Las Vegas Mini Grand Prix",lastService:"",nextService:"",notes:"Air Handler- Daikin- Model -DAQ09034 Serial 250743740",vendorOnly:false,subAssetOnly:false}
  ],
  inspections:[],
  engines:[],
  karts:{euro:makeKarts('EURO','euro',22),road:makeKarts('ROAD','road',34),sprint:makeKarts('SPRT','sprint',16),kiddie:makeKarts('KIDD','kiddie',12)},
  serviceThresholds:{oil:20,chain:50,fullService:200},
  parts:[
    {id:"PRT-7227226",name:"Main rail left side",partNumber:"",sku:"",area:"",location:"General Storage",description:"Needs to be welded on left side main rail, stick weld process.",qty:-1,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7230144",name:"PC0331.075 Rear hydraulic brake caliper",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Rear hydraulic brake caliper for Sodikart",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7232882",name:"Kart Fuel Filters",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:-2,minQty:10,unitCost:0.0,totalCost:0.0,vendors:"",types:"Critical"},
    {id:"PRT-7232945",name:"13101-zh8-010 piston std gx160",partNumber:"",sku:"",area:"",location:"General Storage",description:"Piston for gx160 motors",qty:1,minQty:2,unitCost:42.7,totalCost:42.7,vendors:"MTA",types:""},
    {id:"PRT-7232952",name:"13010-zf1-023 gx160 piston ring set",partNumber:"",sku:"",area:"",location:"General Storage",description:"Std Piston ring set gx160 motors",qty:1,minQty:2,unitCost:25.75,totalCost:25.75,vendors:"MTA",types:""},
    {id:"PRT-7232960",name:"11381-zh8-801 gasket crankcase cover",partNumber:"1",sku:"",area:"",location:"General Storage",description:"Crankcase gasket for GX200 motors",qty:4,minQty:13,unitCost:4.96,totalCost:19.84,vendors:"MTA",types:""},
    {id:"PRT-7232963",name:"12391-ze1-000 valve cover gasket",partNumber:"",sku:"",area:"",location:"General Storage",description:"Valve cover gasket for all motors",qty:0,minQty:25,unitCost:4.99,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7232974",name:"GX200, GX160 cylinder head gasket 12251-ZL0-003",partNumber:"1",sku:"",area:"Cabinet 55 \u2013 M bay14",location:"Cabinet 55 \u2013 M bay14",description:"PN: 12251-ZL0-003\nGasket; Cyl Hd; \nHead gasket for gx200 motors, gx160 motors",qty:0,minQty:5,unitCost:21.69,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7232975",name:"12251-zf1-800 gx160 cyinderhead gasket",partNumber:"",sku:"",area:"",location:"General Storage",description:"Cylinder head gasket for gx160 motors",qty:5,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7232980",name:"16510-ZE1-000 governor gear assembly",partNumber:"",sku:"",area:"",location:"General Storage",description:"Governor gear assembly for all motors",qty:-2,minQty:4,unitCost:18.85,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7232983",name:"90601-ZE1-000 drain plug washer",partNumber:"",sku:"",area:"55-M slot 3",location:"55-M slot 3",description:"Washer drain plug for motor oil",qty:50,minQty:15,unitCost:0.9,totalCost:45.0,vendors:"MTA",types:""},
    {id:"PRT-7232984",name:"16561-ZE1-020 spring governor",partNumber:"",sku:"",area:"",location:"General Storage",description:"Governor spring for all motors",qty:3,minQty:10,unitCost:2.81,totalCost:8.43,vendors:"MTA",types:""},
    {id:"PRT-7232987",name:"16562-ZE1-020 spring throttle return",partNumber:"",sku:"00HB;;16562-ZE1-020;10;KB5C04Y;CHINA;CN;156;;250304;JHLI0202;C1",area:"",location:"General Storage",description:"Throttle return spring for all motors",qty:13,minQty:12,unitCost:3.25,totalCost:42.25,vendors:"MTA",types:""},
    {id:"PRT-7232992",name:"16010-ZE1-812 gasket set carb",partNumber:"1",sku:"",area:"",location:"General Storage",description:"Carb gasket set for carb rebuilds",qty:17,minQty:15,unitCost:14.93,totalCost:253.81,vendors:"MTA",types:""},
    {id:"PRT-7232996",name:"16100-ZH8-822 carburetor gx160",partNumber:"",sku:"",area:"",location:"General Storage",description:"Carburetor assembly for gx160 motor",qty:-1,minQty:3,unitCost:72.49,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7232998",name:"16610-ZE1-000 choke lever STD",partNumber:"",sku:"",area:"",location:"General Storage",description:"Carb choke for all models",qty:9,minQty:8,unitCost:8.49,totalCost:76.41,vendors:"MTA",types:""},
    {id:"PRT-7232999",name:"GX160 [16212-ZH8-800] intake gasket insulator",partNumber:"1",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Cylinder head-carb insulation gasket for all motors",qty:6,minQty:10,unitCost:2.56,totalCost:15.36,vendors:"MTA",types:""},
    {id:"PRT-7233000",name:"16221-ZH8-801 gasket carb mounting",partNumber:"16221-ZH8-801",sku:"",area:"",location:"General Storage",description:"Outer gasket for carb and insulator; Part number 16 on image",qty:0,minQty:10,unitCost:1.26,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7233001",name:"16211-ZL0-200 gx200 insulator, carburetor",partNumber:"",sku:"",area:"",location:"General Storage",description:"Plastic insulator for carburetor",qty:3,minQty:5,unitCost:16.36,totalCost:49.08,vendors:"MTA",types:""},
    {id:"PRT-7233003",name:"16211-ZE1\u2013000 INSULATOR CARBURETOR gx160",partNumber:"1",sku:"",area:"",location:"General Storage",description:"Insulator for carburetor for all other models",qty:10,minQty:5,unitCost:17.41,totalCost:174.1,vendors:"MTA",types:""},
    {id:"PRT-7233007",name:"31510-ZE1-711 coil lamp 12v",partNumber:"",sku:"",area:"",location:"General Storage",description:"Charging coil for 12V system",qty:2,minQty:2,unitCost:119.69,totalCost:239.38,vendors:"MTA",types:""},
    {id:"PRT-7233010",name:"21691-ZH8-800 gasket reduction gear cover",partNumber:"21691-ZH8-800",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Clutch cover gasket for 160/200 motors",qty:0,minQty:5,unitCost:10.08,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7233012",name:"21591-ZH8-620 packing reduction case",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Clutch case gasket",qty:5,minQty:10,unitCost:7.58,totalCost:37.9,vendors:"MTA",types:""},
    {id:"PRT-7233040",name:"13200-Z0T-800 ROD ASSY. CONNECTING",partNumber:"",sku:"",area:"",location:"General Storage",description:"connecting rod for all motors",qty:0,minQty:3,unitCost:35.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7233489",name:"AXEL",partNumber:"",sku:"",area:"",location:"General Storage",description:"Axel mount",qty:-1,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7243067",name:"23120-822-611 chain drive",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Chain for clutch to output sprocket RK428SH-36LE",qty:-2,minQty:3,unitCost:48.34,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7246098",name:"23711-822-610 shaft comp",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Drive shaft for all motors",qty:-2,minQty:3,unitCost:98.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7246102",name:"23120-883-621 Sprocket comp drive 160/200cc",partNumber:"",sku:"",area:"",location:"General Storage",description:"Clutch basket and sprocket for 160/200 motors",qty:6,minQty:3,unitCost:101.61,totalCost:609.66,vendors:"MTA",types:""},
    {id:"PRT-7246117",name:"22201-822-306 disk, clutch friction",partNumber:"22201-822-306",sku:"",area:"",location:"General Storage",description:"Friction plates for clutch",qty:5,minQty:10,unitCost:29.96,totalCost:149.8,vendors:"MTA",types:""},
    {id:"PRT-7246121",name:"22311-822-610 plate clutch 1.6mm",partNumber:"22311-822-610",sku:"",area:"55-M slot 2",location:"55-M slot 2",description:"Steel plates for clutch",qty:4,minQty:4,unitCost:17.49,totalCost:69.96,vendors:"MTA",types:""},
    {id:"PRT-7246134",name:"21510-883-621 case reduction",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Clutch inner case for all motors",qty:0,minQty:3,unitCost:128.61,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7256673",name:"X00390CWP5 Fuel pump lawn mower",partNumber:"",sku:"X00390CWP5",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:15,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:"Critical"},
    {id:"PRT-7281727",name:"17410-Z4M-010 Elbow, air cleaner",partNumber:"1",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Intake elbow for all units",qty:5,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7310267",name:"PC0324 fren tubo brake line",partNumber:"",sku:"",area:"",location:"General Storage",description:"Hydraulic Brake line for Sodikarts",qty:0,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7396106",name:"Honda Engines 90601-ZE1-000 (Washer, Drain Plug)",partNumber:"90601-ZE1-000",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Honda Engines 90601-ZE1-000 (Washer, Drain Plug)",qty:0,minQty:0,unitCost:0.83,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7396109",name:"Wingnut (6MM) 1742238",partNumber:"90203-ZA0-800",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Wingnut (6MM) 1742238",qty:-1,minQty:0,unitCost:2.55,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7396110",name:"36100-ZE1-015 Switch Assembly,Engine Stop\"short single lead\"",partNumber:"27878690",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"36100-ZE1-015 Switch Assembly,Engine Stop\"short single lead\"",qty:-2,minQty:0,unitCost:12.91,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7396111",name:"Engine, GX160 5.5hp UT2RH2 (STD) Honda",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Engine, GX160 5.5hp UT2RH2 (STD) Honda",qty:2,minQty:0,unitCost:589.0,totalCost:1178.0,vendors:"MTA",types:""},
    {id:"PRT-7396112",name:"Engine, GX200 6.5hp URH2 (STD) Honda",partNumber:"10982",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Engine, GX200 6.5hp URH2 (STD) Honda",qty:2,minQty:0,unitCost:644.0,totalCost:1288.0,vendors:"MTA",types:""},
    {id:"PRT-7396113",name:"SHORT TUBLESS VALVE",partNumber:"PC0264.001",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"SHORT TUBLESS VALVE",qty:29,minQty:2,unitCost:3.51,totalCost:101.79,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396114",name:"PC0642.027 BRACKET FRONT SHIELD",partNumber:"PC0642.027",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"BRACKET FOR FRONT SHIELD",qty:6,minQty:2,unitCost:11.93,totalCost:71.58,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396115",name:"STRAP BRACKET FOR FRONT SHIELD",partNumber:"PC0642.027",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"STRAP BRACKET FOR FRONT SHIELD",qty:4,minQty:0,unitCost:5.82,totalCost:23.28,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396116",name:"RIGHT SIDE POD SUPPORT",partNumber:"PC0631.240",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"RIGHT SIDE POD SUPPORT",qty:0,minQty:0,unitCost:163.85,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396117",name:"OUTER CABLE STOP & PROTECTION",partNumber:"PC0711.177",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"OUTER CABLE STOP & PROTECTION",qty:10,minQty:5,unitCost:15.9,totalCost:159.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396118",name:"ON OFF SWITCH sodi",partNumber:"PC0712.047",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"ON OFF SWITCH",qty:4,minQty:0,unitCost:28.91,totalCost:115.64,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396119",name:"GAS FILTER",partNumber:"PM393.101",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"GAS FILTER",qty:-1,minQty:0,unitCost:5.26,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396120",name:"PAN - CLAMP 22.1",partNumber:"PC0711.094",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"PAN - CLAMP 22.1",qty:15,minQty:0,unitCost:2.58,totalCost:38.7,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396121",name:"PAN - CLAMP 28.5",partNumber:"PC0711.096",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"PAN - CLAMP 28.5",qty:15,minQty:0,unitCost:2.76,totalCost:41.4,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396122",name:"PAN - CLAMP \ufffd9.5",partNumber:"PC0711.090",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"PAN - CLAMP \ufffd9.5",qty:6,minQty:0,unitCost:2.46,totalCost:14.76,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396123",name:"PAN - CLAMP 12.7",partNumber:"PC0711.091",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"PAN - CLAMP 12.7",qty:15,minQty:0,unitCost:2.46,totalCost:36.9,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396124",name:"FLOOR RIVETS D6 L40",partNumber:"B1.R0640",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"FLOOR RIVETS D6 L40",qty:30,minQty:0,unitCost:2.4,totalCost:72.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396125",name:"BRAKE PADS SET OF 2 sold as PC0351.095",partNumber:"PC0351.095",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"BRAKE PADS SET OF 2 sold as PC0351.095",qty:13,minQty:0,unitCost:32.9,totalCost:427.7,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7396126",name:"brake hose to reservoir p/meter",partNumber:"PC0324.055",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"brake hose to reservoir p/meter",qty:1,minQty:0,unitCost:5.06,totalCost:5.06,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7443822",name:"Welding Wire .045 Flux Core",partNumber:"",sku:"",area:"Home Depot, Lowes, Cal Ranch, Harbor Freight",location:"Home Depot, Lowes, Cal Ranch, Harbor Freight",description:"211 Flux Cored MIG Welding Wire",qty:-1,minQty:0,unitCost:130.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7445452",name:"Sakamoto front tire (medium)",partNumber:"",sku:"",area:"",location:"General Storage",description:"10x4.5-5 sakamoto Sodi tires",qty:-2,minQty:20,unitCost:20.0,totalCost:0.0,vendors:"Sakamoto",types:"Critical"},
    {id:"PRT-7445459",name:"Sakamoto rear tire (medium)",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"11x7.1-5 Sakamoto tire for Sodi",qty:6,minQty:20,unitCost:23.0,totalCost:138.0,vendors:"Sakamoto",types:"Critical"},
    {id:"PRT-7496799",name:"001686",partNumber:"",sku:"",area:"",location:"General Storage",description:"Decal, Blaster Boat Motor 8\"",qty:0,minQty:0,unitCost:13.46,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7496802",name:"00169",partNumber:"",sku:"",area:"",location:"General Storage",description:"Decal, Warning-Keep Hands And Feet In Boat At All Time",qty:-1,minQty:0,unitCost:2.25,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7496804",name:"00170",partNumber:"",sku:"",area:"",location:"General Storage",description:"Decal, Warning-Never Stand Up While Boat Is Operating",qty:0,minQty:0,unitCost:2.25,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7496814",name:"001772-G",partNumber:"",sku:"",area:"",location:"General Storage",description:"Filter, Fuel 60 Micron Stainless Steel, PET Ho",qty:10,minQty:0,unitCost:3.5,totalCost:35.0,vendors:"",types:""},
    {id:"PRT-7496840",name:"002679T",partNumber:"",sku:"",area:"",location:"General Storage",description:"Latch, Body - Flexible W/Keeper Bracket (Heavy Duty)",qty:1,minQty:0,unitCost:28.99,totalCost:28.99,vendors:"",types:""},
    {id:"PRT-7497192",name:"00962",partNumber:"",sku:"",area:"",location:"General Storage",description:"Washer, 5/16 Z Lock",qty:4,minQty:0,unitCost:0.15,totalCost:0.6,vendors:"",types:""},
    {id:"PRT-7497227",name:"00980 Keep hands and arms in car at all times sticker",partNumber:"",sku:"",area:"",location:"General Storage",description:"Decal, Warning-Keep Hands And Arms in Car At All 6.75\" x 3\"",qty:20,minQty:0,unitCost:2.25,totalCost:45.0,vendors:"",types:""},
    {id:"PRT-7497261",name:"01013",partNumber:"",sku:"",area:"",location:"General Storage",description:"Washer, HD Steel Engine Pulley Cup",qty:4,minQty:0,unitCost:11.0,totalCost:44.0,vendors:"",types:""},
    {id:"PRT-7497266",name:"01016",partNumber:"",sku:"",area:"",location:"General Storage",description:"Bolt, 8mm x 1.25 x 35mm 10.9z HCS Tap",qty:4,minQty:0,unitCost:1.0,totalCost:4.0,vendors:"",types:""},
    {id:"PRT-7497317",name:"010820A",partNumber:"",sku:"",area:"",location:"General Storage",description:"Brake Pad, Black Square (FPX/Wil) Sold Each Pad",qty:10,minQty:0,unitCost:10.99,totalCost:109.9,vendors:"",types:""},
    {id:"PRT-7499495",name:"160 gov gear [16510-Z4M-000]",partNumber:"",sku:"",area:"Middle cabinets",location:"Middle cabinets",description:"16510-Z4M-000 Governor Assy.",qty:1,minQty:0,unitCost:35.5,totalCost:35.5,vendors:"",types:""},
    {id:"PRT-7500146",name:"22121-887-620",partNumber:"",sku:"",area:"",location:"General Storage",description:"22121-887-620 Center, Clutch  (28T) GX120 ONLY",qty:-1,minQty:0,unitCost:76.04,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7501558",name:"Oil seal, cylinder barrel [91201-Z0T-801]",partNumber:"",sku:"",area:"",location:"General Storage",description:"91201-Z0T-801 Seal, Oil\nGX200, GX160\n#14 in diagram",qty:3,minQty:0,unitCost:8.33,totalCost:24.99,vendors:"",types:""},
    {id:"PRT-7564606",name:"PC0711.040 throttle cable (Sodi)",partNumber:"",sku:"",area:"",location:"General Storage",description:"76 in throttle cable for sodi karts\nPC0711.040",qty:6,minQty:7,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7663915",name:"spring 1950625",partNumber:"37400",sku:"",area:"",location:"General Storage",description:"",qty:10,minQty:0,unitCost:2.2,totalCost:22.0,vendors:"MTA",types:""},
    {id:"PRT-7663924",name:"switch engine stop",partNumber:"731395",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:19,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-7797340",name:"Tire inner tube",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-17,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7896505",name:"REAR ARM",partNumber:"",sku:"",area:"",location:"General Storage",description:"Support brackets which attach the rear end to the bumper.",qty:6,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-7996094",name:"Digital Caliper Measuring Tool",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:8.99,totalCost:17.98,vendors:"",types:""},
    {id:"PRT-7999923",name:"Side Pod A Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:2,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-7999931",name:"Side Pod C Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:2,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000207",name:"Sidepod E Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:3,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8000218",name:"Sidepod D Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:4,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000225",name:"Spoiler D Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:4,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000231",name:"Front Panel D",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000248",name:"Sidepod G Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:9,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000255",name:"Spoiler H Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:11,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000291",name:"Spoiler K Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:13,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000298",name:"Spoiler I Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:11,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000308",name:"Spoiler G Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"white piece",qty:6,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000310",name:"Spoiler M",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:18,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000312",name:"Covers I",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:6,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000313",name:"Covers J",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:7,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000315",name:"Covers H Stickers",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:7,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000317",name:"Covers G Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:5,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000318",name:"Spoiler F Stickers",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:14,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000322",name:"Front Panel B",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:2,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000328",name:"Front Panel A",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:5,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000334",name:"Spoiler E",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"White",qty:7,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000336",name:"Spoiler L Stickers",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:20,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000341",name:"Spoiler J Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:9,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000344",name:"Weight Box A",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:42,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000346",name:"Covers K Sticker",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:7,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000347",name:"Covers L Sticker",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:8,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000348",name:"Covers M Stickers",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:5,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000350",name:"Front Panel C",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:3,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000354",name:"Fuel Tank A",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:2,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000356",name:"Cover C",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000358",name:"Spoiler C",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000360",name:"Fuel Tank B",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:3,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000362",name:"Covers F",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:27,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000368",name:"Covers N",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:6,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8000370",name:"Covers O",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:7,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8013037",name:"PC0261.035 ALUrear180mm wheel",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:6,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8013171",name:"PC0252.042 EXTRA LONG ALLOY HUB 30MM",partNumber:"",sku:"",area:"",location:"General Storage",description:"Sodi hub for 30MM axle",qty:2,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8013230",name:"1-61-0062 CARBON CANISTER",partNumber:"",sku:"",area:"",location:"General Storage",description:"Canister for sprint carts",qty:0,minQty:2,unitCost:25.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8112546",name:"22350-822-610 clutch pressure plate friction",partNumber:"22350-822-610",sku:"",area:"55-M Slot 5-6",location:"55-M Slot 5-6",description:"Friction plate on clutch pressure plate for 160/200 motors",qty:13,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-8117643",name:"Sodi Drive Belt.",partNumber:"",sku:"",area:"",location:"General Storage",description:"Main Drive Belt. TR231.041",qty:1,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-8164137",name:"Nylon Pull Rope.",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-4,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8193905",name:"UHMW Wheels",partNumber:"",sku:"",area:"",location:"General Storage",description:"we buy the UHMW stick and have fabricated by Micar Fabrication at 5166 Arville Street, LV, NV, 89118; phone number 702-871-4300",qty:-6,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"Micar Fabrication",types:""},
    {id:"PRT-8194062",name:"10W30 Small Engine Oil",partNumber:"ASE55-EA",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"Synthetic 10W30 Small Engine Oil Drum  should last us 3-4 Months",qty:178,minQty:0,unitCost:7.94,totalCost:1413.32,vendors:"Ams Oil",types:"Critical"},
    {id:"PRT-8226320",name:"PM372.050 EXHAUST PIPE",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"Factory exhaust pipe for sodikart\nGX200/160",qty:1,minQty:2,unitCost:76.77,totalCost:76.77,vendors:"",types:""},
    {id:"PRT-8437261",name:"B3P0614 Fasco#10NWUSTZ",partNumber:"",sku:"",area:"",location:"General Storage",description:"#10USSFLATWASHER*PKG*PLATED",qty:100,minQty:8,unitCost:0.02,totalCost:2.0,vendors:"",types:""},
    {id:"PRT-8437263",name:"B2N06E Fasco #.6CNNE8Z/FLG",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0FLANGEDNYLONINSERTLOCK\n NUTCL8ZINC",qty:100,minQty:8,unitCost:0.09,totalCost:9.0,vendors:"",types:""},
    {id:"PRT-8437264",name:"B3P08 Fasco# 25NWSATZ",partNumber:"",sku:"",area:"",location:"General Storage",description:"1/4SAEFLATWASHER*PKG*PLATED",qty:100,minQty:8,unitCost:0.2,totalCost:20.0,vendors:"",types:""},
    {id:"PRT-8438178",name:"B1T0620ZN Fasco#.6C20KFC1Z",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0X20FLATSOCKETCAPSCREWGR\n 12.9PLATED",qty:200,minQty:8,unitCost:0.16,totalCost:32.0,vendors:"",types:""},
    {id:"PRT-8438180",name:"B1C063SN Fasco#.6C25KFC1Z",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0X25FLATSOCKETCAPSCREWGR\n 12.9PLATED\n\nfor seat track",qty:100,minQty:8,unitCost:0.26,totalCost:26.0,vendors:"",types:""},
    {id:"PRT-8438182",name:"B1F0630 Fasco # .6C30KFC1",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0X30FLATSOCKETCAPSCREWGR\n 12.9",qty:100,minQty:8,unitCost:0.14,totalCost:14.0,vendors:"",types:""},
    {id:"PRT-8438186",name:"B2N06 Fasco#.6CNNETZ",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0NYLONINSERTL/NDIN982*PKG*\n PLATED",qty:100,minQty:8,unitCost:0.4,totalCost:40.0,vendors:"",types:""},
    {id:"PRT-8511676",name:"PC0632.235 LEFT SIDE PROTECTION",partNumber:"",sku:"",area:"",location:"General Storage",description:"Crash bumper for Sodikarts",qty:-2,minQty:0,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8549621",name:"B214B  Fasco#.14CNFJZ",partNumber:"",sku:"",area:"",location:"General Storage",description:"M14-2.0HEXJAMNUTZINCPLATED",qty:100,minQty:8,unitCost:0.19,totalCost:19.0,vendors:"",types:""},
    {id:"PRT-8559060",name:"B206CL Fasco# /AU-11864B",partNumber:"",sku:"",area:"",location:"General Storage",description:"extrudedu-nutm6-1.0screwsize-gm",qty:100,minQty:8,unitCost:0.28,totalCost:28.0,vendors:"",types:""},
    {id:"PRT-8678911",name:"B1C0865P  Fasco# .8C65KCS1Z",partNumber:"",sku:"",area:"",location:"General Storage",description:"M8-1.25X65SOCKETCAPSCREWGR12.9\n ZINC",qty:100,minQty:8,unitCost:0.42,totalCost:42.0,vendors:"",types:""},
    {id:"PRT-8678914",name:"B1C0640P Fasco#  .6C40KCS1Z",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0X40SOCKETCAPSCREWGR12.9\n PLATED\n CustPart#:B1C0640P\n\nSteering column bottom",qty:100,minQty:8,unitCost:0.24,totalCost:24.0,vendors:"",types:""},
    {id:"PRT-8678917",name:"B1F062S Fasco #.6C35KCS1",partNumber:"",sku:"",area:"",location:"General Storage",description:"M6-1.0X35SOCKETCAPSCREWGR12.9\n CustPart#:B1F062S\n\nfor  sodi steering hub",qty:100,minQty:8,unitCost:0.16,totalCost:16.0,vendors:"",types:""},
    {id:"PRT-8678930",name:"B1E10100P Fasco #   .12N25KSS",partNumber:"",sku:"",area:"",location:"General Storage",description:"M12X25SHOULDERBOLT\n CustPart#:B1E10100P",qty:24,minQty:4,unitCost:3.27,totalCost:78.48,vendors:"",types:""},
    {id:"PRT-8678938",name:"B1F0625 Fasco# .10C25HM0FZ",partNumber:"",sku:"",area:"",location:"General Storage",description:"M10-1.5X25HEXC/SGR10.9DIN933\n PLATED\n CustPart#:B1F0625   bolt for pully tension all karts",qty:50,minQty:4,unitCost:0.34,totalCost:17.0,vendors:"",types:""},
    {id:"PRT-8678949",name:"B1F10100P Fasco #  .10C100KFC",partNumber:"",sku:"",area:"",location:"General Storage",description:"M10-1.5X100FLATSOCCAPSCREW\n CustPart#:B1F10100P",qty:100,minQty:8,unitCost:0.01,totalCost:1.0,vendors:"",types:""},
    {id:"PRT-8768297",name:"Pm372.061 Exhaust pipe - Low",partNumber:"",sku:"",area:"",location:"General Storage",description:"Exhaust pipe between engine pipe and muffler",qty:-2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8768298",name:"Pm371.043 Exhaust -STD- Low",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"Muffler for Sodi carts",qty:1,minQty:1,unitCost:182.31,totalCost:182.31,vendors:"",types:""},
    {id:"PRT-8768299",name:"Pm373.007 Exhaust spring",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"Springs for exhaust pipe connection and muffler",qty:26,minQty:1,unitCost:2.5,totalCost:65.0,vendors:"",types:""},
    {id:"PRT-8768301",name:"Pm373.024 Exhaust spring fastening",partNumber:"",sku:"",area:"",location:"General Storage",description:"Plate for exhaust connection springs",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8768302",name:"Pm373.025 Exhaust gasket",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"Metal exhaust gasket for exhaust connection",qty:7,minQty:1,unitCost:5.38,totalCost:37.66,vendors:"",types:""},
    {id:"PRT-8768303",name:"Pm373.064 Exhaust Flex D30D35L70",partNumber:"",sku:"",area:"",location:"General Storage",description:"Exhaust flex extension between muffler and exhaust pipe",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8768304",name:"B2.10E Nut flang M10",partNumber:"",sku:"",area:"",location:"General Storage",description:"Nut for exhaust mount",qty:99,minQty:8,unitCost:0.08,totalCost:7.92,vendors:"",types:""},
    {id:"PRT-8768305",name:"Pc0711.195 Silentblock for exhaust",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"Silent dampers for exhaust mounting\n\nM/M M10 D40 EP20 Shore 70",qty:6,minQty:1,unitCost:8.27,totalCost:49.62,vendors:"",types:""},
    {id:"PRT-8768307",name:"Pc0632.269 spacer M6 D20 H30",partNumber:"",sku:"",area:"",location:"General Storage",description:"Spacer for pods",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-8768562",name:"B2.N08E  - m8 nylon flange",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:20,minQty:20,unitCost:0.15,totalCost:3.0,vendors:"",types:""},
    {id:"PRT-8768564",name:"B2.N10 Fasco#.10CNN0Z",partNumber:"",sku:"",area:"",location:"General Storage",description:"M10 -1.5 Nylon insert L/N GR 10.9 Zinc plated",qty:100,minQty:10,unitCost:0.12,totalCost:12.0,vendors:"",types:""},
    {id:"PRT-8800868",name:"Kartrol Box 01",partNumber:"exeg-0207",sku:"527876526901",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800871",name:"Kartrol Box 02",partNumber:"exeg-0207",sku:"527876526902",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800872",name:"Kartrol Box 03",partNumber:"exeg-0207",sku:"527876526903",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800874",name:"Kartol Box 04",partNumber:"exeg-0207",sku:"527876526904",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800875",name:"Katrol Box 05",partNumber:"",sku:"527876526905",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800877",name:"Kartrol Box 06",partNumber:"",sku:"527876526906",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800879",name:"Kartrol Box 07",partNumber:"",sku:"527876526907",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800880",name:"Kartrol 08",partNumber:"",sku:"527876526908",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800881",name:"Kartrol Box 09",partNumber:"",sku:"527876526909",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-8800882",name:"Katrol Box 10",partNumber:"",sku:"527876526910",area:"",location:"Las Vegas Mini Grand Prix",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"J&J Amusements",types:""},
    {id:"PRT-9074689",name:"PM393.101 Part#STR1078",partNumber:"",sku:"",area:"",location:"General Storage",description:"Sodi Kart fuel filter",qty:0,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9259757",name:"BPR5ES spark plug",partNumber:"",sku:"087295440063",area:"",location:"General Storage",description:"Spark plug for all motors",qty:-4,minQty:10,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9278458",name:"Used tires",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:13,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9278639",name:"800RC35285-99 Adult Seat Belts",partNumber:"",sku:"",area:"",location:"General Storage",description:"Seatbelt for Adults in Go Karts",qty:0,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9278641",name:"800RC3-1009  Kiddie Seat Belt",partNumber:"",sku:"",area:"",location:"General Storage",description:"seat belt for kiddie karts and kiddie side on Family Kart",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9342584",name:"Sodi Stub Axle",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"20mm Sodi Kart Stub Axle for steering spindle Left",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:"Critical"},
    {id:"PRT-9342594",name:"Sodi Stub Axle Right",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"20mm Sodi Kart Stub Axle for steering spindle Right",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9342603",name:"Sodi Stub Axle Left",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"20mm Sodi Kart Stub Axle for steering spindle Left",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9344527",name:"Pc0341.218 ventilated brake disc Diam 192",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:4,minQty:3,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9424194",name:"Coaster Tires, 5.70-8, TOW MASTER",partNumber:"",sku:"",area:"Tire station",location:"Tire station",description:"Tires for brakes on dragon coaster\n\nTEB-0768 coaster brake tires 17.8x17.8x10.98",qty:7,minQty:1,unitCost:34.99,totalCost:244.93,vendors:"",types:""},
    {id:"PRT-9430190",name:".8C440KFC-NVL",partNumber:"",sku:"",area:"",location:"Las Vegas Mini Grand Prix",description:"M8-1.25x40  flat coc cap screw",qty:100,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9430263",name:"22E77825EFINT",partNumber:"",sku:"",area:"",location:"General Storage",description:"22-16 GA x .250 TAB Fem Nylon",qty:100,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9430264",name:"16E77915EBMNT",partNumber:"",sku:"",area:"",location:"General Storage",description:"16-14 GA x 157 Dia",qty:100,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9430265",name:"10C125KFC",partNumber:"",sku:"",area:"",location:"General Storage",description:"10-24x1 1/4 Flat head Socket cap crew",qty:100,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9430266",name:"10CNNETZ",partNumber:"",sku:"",area:"",location:"General Storage",description:"10-24 Nylon Insert lock Nut zinc plated",qty:100,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9430267",name:".10C45KFC",partNumber:"",sku:"",area:"",location:"General Storage",description:"M10-1.5x45  Flat Socket head Cap Screw",qty:100,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9431169",name:"B1F1025ZN  10C45KFC",partNumber:"M10C25FSHCS12Z/D,B1.F1025ZN",sku:"",area:"",location:"General Storage",description:"M10-1.5 x 45  Flat Socket Head Cap Screw  \nRear Bumper assy.",qty:20,minQty:25,unitCost:1.93,totalCost:38.6,vendors:"BoltsandNuts.com,Sodi Logistics",types:""},
    {id:"PRT-9431339",name:"PCO681.150",partNumber:"",sku:"",area:"",location:"General Storage",description:"MIDDLE SUPPORT-AXLE PROTECTION",qty:4,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9431343",name:"PC0323.036",partNumber:"",sku:"",area:"",location:"General Storage",description:"Rubber lined Clips D16",qty:14,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9431347",name:"PC0323.034",partNumber:"",sku:"",area:"",location:"General Storage",description:"D6.5",qty:25,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9431354",name:"B1.R0640",partNumber:"",sku:"",area:"",location:"General Storage",description:"Rivit D6",qty:8,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9431368",name:"PC0452.027",partNumber:"",sku:"",area:"",location:"General Storage",description:"rubber round",qty:8,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9431371",name:"B1.R0640",partNumber:"",sku:"",area:"",location:"General Storage",description:"Rivet",qty:29,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9455507",name:"Brake band GK",partNumber:"",sku:"",area:"",location:"General Storage",description:"Fiber mesh pad or ceramic pad",qty:-10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9474094",name:"PC0312.003 Master cylinder tank",partNumber:"",sku:"",area:"",location:"General Storage",description:"Brake reservoir for sodi karts",qty:10,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9474994",name:"755313    23120-88-621   Sprocket Drive",partNumber:"",sku:"",area:"",location:"General Storage",description:"Sprocket  Drive",qty:7,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9475436",name:"18622   1601ZEI-812 Gasket Set",partNumber:"",sku:"",area:"",location:"General Storage",description:"Gasket Set",qty:19,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9475440",name:"29814  90203-ZAO-800 WINGNUT",partNumber:"",sku:"",area:"",location:"General Storage",description:"WING NUT 6 MM",qty:9,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9475441",name:"704402  17410-ZEI -030 ELBOW AIR CLEANER",partNumber:"",sku:"",area:"",location:"General Storage",description:"ELBOW AIR CLEANER",qty:5,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9475443",name:"37894 91301-805-000 O-RING 26x2.7",partNumber:"",sku:"",area:"",location:"General Storage",description:"O-RING 26x2.7",qty:23,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9475446",name:"647200  GX16OUT2RH2",partNumber:"",sku:"",area:"",location:"General Storage",description:"160 CC HONDA  Engine   Serial# GCBPT-4874244, GCBPT-4874238",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485214",name:"M8 -1.25x20MM  12.9 DIN 7991  FLAT SOCKET",partNumber:"",sku:"",area:"",location:"General Storage",description:"M8 -1.25x20MM  12.9 DIN 7991  FLAT SOCKET",qty:43,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485218",name:"16-14 GA x157 DIA Female Bullet connector nylon",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:200,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485221",name:"16-14 GA x 157 DIA Male Bull Conn",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:100,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485225",name:"22-16 GA x .250 TAB MALE QD Nylon",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:100,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485285",name:"Deflector",partNumber:"",sku:"",area:"",location:"General Storage",description:"Round with 7 holes around it or square with 4 holes",qty:10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485651",name:"BigFoot Tires",partNumber:"",sku:"",area:"Shed",location:"Shed",description:"12 x 4.00-5\n\nFamily karts, sprints, kiddie",qty:59,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485700",name:"Adjustable seat left guide pc0142.026",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485704",name:"Adjustable seat right guide pc0142.045",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:8,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485710",name:"Seat locking rod pc0142.046",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485712",name:"Adjustable seat runner pc0142.025",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9485713",name:"Adjustable seat lever",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9502504",name:"ACCEL CABLE D1.8 L2000",partNumber:"",sku:"",area:"",location:"General Storage",description:"Throttle Cable for Sodi karts",qty:39,minQty:1,unitCost:4.19,totalCost:163.41,vendors:"",types:"Critical"},
    {id:"PRT-9503435",name:"B1.B0610RT Panhead screw",partNumber:"",sku:"",area:"",location:"General Storage",description:"For silent bloc sodi",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9598549",name:"Sodi shutdown transponder",partNumber:"",sku:"",area:"",location:"General Storage",description:"Shutdown for sodi karts from dehart",qty:-1,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9598553",name:"Sodi transponder harness",partNumber:"",sku:"",area:"",location:"General Storage",description:"Shutdown transponder harness for sodikart from dehart",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9598856",name:"PC0124.064 ADJ. REAR SUPPORT BLACK",partNumber:"",sku:"",area:"",location:"General Storage",description:"Adjustable seat support for sodikart",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9630229",name:"Pull cord handle",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9834403",name:"PC0131.096 PLASTIC FLOOR BLACK SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"SR5 floor board includes pedal cover #2",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9834447",name:"PC0132.029 FLOOR TRAY STICKER - SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"SR5 FLOOR TRAY STICKER SET",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9834482",name:"PC0272.311 SR5 FULL AXLE FUN D30 L900",partNumber:"",sku:"",area:"",location:"General Storage",description:"Rear axle for SR5 model's",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9834496",name:"PC02274.047 SR5 BEARING D30 / VERTICAL FLANGE",partNumber:"",sku:"",area:"",location:"General Storage",description:"Middle bearing for SR5 MODELS",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9834563",name:"PC0142.144 ADJUSTABLE SEAT SUPPORT BLACK SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Seat support bracket for SR5 models",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9834667",name:"PC0142.149 SEAT SLIDER SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Bottom seat slider for SR5 models",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9835976",name:"PC0142.148 GUIDE FOR ADJUSTING SEAT SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"SR5 seat adjustment guide",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9835981",name:"PC0641.226 BLACK FRONT FAIRING sr5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Front nose fairing for SR5 model's",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9836002",name:"PC0632.070 LEFT/RIGHT SIDE BUFFER",partNumber:"",sku:"",area:"",location:"General Storage",description:"Bumper support for left and right sides for SR5 models",qty:-1,minQty:6,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9836010",name:"PC0632.075 LEFT/RIGHT SIDE BUFFER - LOWER",partNumber:"",sku:"",area:"",location:"General Storage",description:"Left and right side bumper support for SR5 models",qty:-2,minQty:6,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9836014",name:"PC0633.368 RIGHT SIDE POD BLACK",partNumber:"",sku:"",area:"",location:"General Storage",description:"Right side cover for SR5 models",qty:2,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9836026",name:"PC0681.158 REAR AXLE PROTECTION",partNumber:"",sku:"",area:"Sodi rack",location:"Sodi rack",description:"Rear axle cover for SR5 models",qty:1,minQty:3,unitCost:243.5,totalCost:243.5,vendors:"",types:""},
    {id:"PRT-9836048",name:"PC0711.188 Rubber spacer D15 D26",partNumber:"",sku:"",area:"",location:"General Storage",description:"Rubber grommets for plastic body panels",qty:39,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9836066",name:"PC0681.160 LEFT SUPPORT -AXLE PROTECTION SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"LH AXLE COVER MOUNT for SR5 models",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9836099",name:"PC0681.159 RIGHT SUPPORT -AXLE PROTECTION SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Axle cover support",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9836713",name:"PM371.041 EXHAUST - STANDARD SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837300",name:"B9.6000-2RS1 BALL BEARING 6000-2RS1",partNumber:"",sku:"",area:"",location:"General Storage",description:"Sealed ball bearings for the belt tensioner roller",qty:12,minQty:6,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837325",name:"PC0712.125 CONTACTOR / STOP LIGHT",partNumber:"",sku:"",area:"",location:"General Storage",description:"Brake light harness for sodi",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837334",name:"PC0821.040 STICKER KIT - FULL SR BLUE/RED",partNumber:"",sku:"",area:"",location:"General Storage",description:"Sticker set for sodi SR5 models",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837345",name:"PC0612.173 FRONT SPOILER PROTECTION SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Front bumper on SR5 models",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837356",name:"PC0613.136 FRONT BUMPER BLACK WITHOUT LIGHT",partNumber:"",sku:"",area:"Sodi rack",location:"Sodi rack",description:"Front cowl for SR5 models",qty:4,minQty:1,unitCost:91.72,totalCost:366.88,vendors:"",types:""},
    {id:"PRT-9837360",name:"PC0612.060 FRONT BUFFER BLADE SR5",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"*Item number 2 in diagram\n\nFront bumper mount\nSame on for both old and new models",qty:1,minQty:1,unitCost:107.2,totalCost:107.2,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837364",name:"PC0632.268 LEFT SIDE PROTECT PROLINE EP12",partNumber:"",sku:"",area:"",location:"General Storage",description:"Left Bumper for SR5",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837370",name:"PC0633.365 LEFT SIDE POD BLACK SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Left pod/cover for SR5",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837375",name:"PC0621.169 REAR PLASTIC PROTECTION SR5",partNumber:"",sku:"",area:"Sodi racks",location:"Sodi racks",description:"Rear bumper for SR5 models",qty:1,minQty:1,unitCost:189.92,totalCost:189.92,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837385",name:"PC0671.115 ENGINE COVER BLACK GX270 SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Engine cover for SR5 models comes with grommets p#PC0711.188",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837395",name:"PC0612.174 HIGH FRONT SPOILER PROTECTION SR5",partNumber:"",sku:"",area:"",location:"General Storage",description:"Spoilers for SR5 models increased height",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837403",name:"PC0632.266 LEFT SIDE PROTECT PROLINE EP15 SR5 HIGH BUMPER OPTION",partNumber:"",sku:"",area:"",location:"General Storage",description:"Bumper compatible with high bumper option",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-9837429",name:"17210-ze2-515 Air cleaner gx270",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:17,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837436",name:"[16223-ZA0-800] GASKET INSULATOR GX270",partNumber:"",sku:"16223-ZA0-800",area:"55-M bay 10",location:"55-M bay 10",description:"",qty:1,minQty:25,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837441",name:"16221-ZA0-800 GASKET CARBURETOR GX270",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837443",name:"16010-ZE2-812 GX270 GASKET SET",partNumber:"",sku:"",area:"55-M slot 4",location:"55-M slot 4",description:"",qty:8,minQty:10,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837454",name:"VALVE COVER GASKET",partNumber:"",sku:"",area:"Cabinet 55-M  bay 1",location:"Cabinet 55-M  bay 1",description:"Part number 12391-ZE2-020 Honda -LaMonthe",qty:7,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9837456",name:"12251-ZH9-010 CYLINDER HEAD GASKET GX270",partNumber:"",sku:"",area:"55-M slot 11",location:"55-M slot 11",description:"",qty:10,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9838725",name:"18331-883-810 Muffler cap",partNumber:"",sku:"00HB;;18331-883-810;1;MB1D23;JAPAN;JP;392;;;;",area:"Cabinet 55 \u2013 M BAY 17",location:"Cabinet 55 \u2013 M BAY 17",description:"",qty:5,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9872324",name:"Contactor TeSys Control",partNumber:"",sku:"LC1D18G7",area:"",location:"General Storage",description:"Contactor used for electricity breaker on dragon",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:"Critical"},
    {id:"PRT-9889189",name:"PC0143.013 engine sprocket protection",partNumber:"",sku:"",area:"",location:"General Storage",description:"Engine belt guard for sodi karts",qty:2,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9895805",name:"PC0142.129 ADJ. SEAT REAR SUPPORT",partNumber:"",sku:"",area:"",location:"General Storage",description:"Sodi rear seat adjustment support",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-9918417",name:"Ball Bearing (Belt Transmission SR5)",partNumber:"B9.6000-2rs1,https://www.amazon.com/TIMKEN-10x26x8mm-Pre-Lubricated-Performance-Effective/dp/B08Q3B4MG1/ref=sr_1_3?crid=JM2DBB9IQMN7&dib=eyJ2IjoiMSJ9.f6q57T5e4V3HWxoNvO18rEVHZ7ctBhCulCxxWeZVLE8fRneRCmZCljPJrNQ7nmOdWOAVmJGyFfhuKALyvsclyIyQhbagvL1-PVWIMKnfKV6TVhL_BXdyes",sku:"",area:"",location:"General Storage",description:"",qty:0,minQty:1,unitCost:4.54,totalCost:0.0,vendors:"Sodi Logistics,amazon",types:""},
    {id:"PRT-9918546",name:"Dowel Pin (Honda GX160)",partNumber:"94301-10160",sku:"",area:"",location:"General Storage",description:"This is the core part number for a standard 10x16 mm dowel pin used in various Honda engines and assemblies; \n\nThe \u201c-RB\u201d suffix typically indicates region-specific packaging or distribution (often RB = Honda Racing or a regional batch, such as U.S. market packaging).; The part itself is functionally identical to 94301-10160.",qty:20,minQty:1,unitCost:0.18,totalCost:3.6,vendors:"MTA",types:""},
    {id:"PRT-10015718",name:"E094-VI8-SS CLUTCH COVER OIL SEAL",partNumber:"",sku:"",area:"",location:"General Storage",description:"CTTO brand oil seals for all motors",qty:43,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10015725",name:"12251-ZF1-800 GASKET , Cylinder Head Gx160",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-1,minQty:3,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10015727",name:"Gasket Muffler",partNumber:"",sku:"",area:"Cabinet 54 \u2013 M  bay 1",location:"Cabinet 54 \u2013 M  bay 1",description:"Part number 18381-Z0T-801",qty:1,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10031291",name:"PC0313.009 brake hose washers",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:8,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10031293",name:"B1.C0510 zinc screw CHC 5X10 8.8",partNumber:"",sku:"",area:"",location:"General Storage",description:"Throttle cable hold down bolt",qty:22,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10031294",name:"PC0711.213 cable tightener",partNumber:"",sku:"",area:"",location:"General Storage",description:"Hold down for cable",qty:13,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10031299",name:"PC0131.044 RX7 FUN BOARD",partNumber:"",sku:"",area:"Sodi shelves",location:"Sodi shelves",description:"Used for both gt5r and sr5",qty:3,minQty:1,unitCost:169.59,totalCost:508.77,vendors:"",types:""},
    {id:"PRT-10032835",name:"PC0612.145 SilentBloc M/F M10 D40 EP45",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:6,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-10032979",name:"Oil seal",partNumber:"",sku:"",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10066904",name:"MasterPro Hose Clamps 11/16 Inch To 1-1/2 Inch Hose Clamp - MP5016",partNumber:"",sku:"155C0R0PCTFW1",area:"",location:"General Storage",description:"We need these clamps for strap transponders to euro karts",qty:6,minQty:0,unitCost:2.29,totalCost:13.74,vendors:"",types:"Critical"},
    {id:"PRT-10074812",name:"PC0711.149 throttle cable housing(sodi)",partNumber:"",sku:"27NZEGLLYFF9",area:"",location:"General Storage",description:"Sodi throttle cable housing",qty:17,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10085476",name:"Gokart spindle left",partNumber:"",sku:"52ED6ET7RAH3",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10085479",name:"Go-kart spindle right",partNumber:"",sku:"L5FUZC0OWBMD",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10085487",name:"J&J harness",partNumber:"",sku:"2RJ4OAI32FTGC",area:"",location:"General Storage",description:"",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10151958",name:"16220-ZAO-702 carburetor spacer",partNumber:"",sku:"IL4X0VWY14JB",area:"55-M slot 7",location:"55-M slot 7",description:"Carb spacer",qty:7,minQty:3,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10152021",name:"16211-ZE2-010 carburetor insulator",partNumber:"",sku:"1Z1PKZV3GP8SJ",area:"55-M slot 9",location:"55-M slot 9",description:"Carb insulator\nGX240",qty:9,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10202077",name:"Nylon nut m8-1.25",partNumber:"",sku:"3565QJHU10IKX",area:"55-M 8",location:"55-M 8",description:"Pack of 4 nylon nuts from Lowe\u2019s",qty:6,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10294569",name:"21691-889-306 gasket reduction cover gx 270",partNumber:"",sku:"UTTUHBCPV282",area:"",location:"General Storage",description:"",qty:4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10335781",name:"Colonical Washer D8",partNumber:"PC0142.009",sku:"",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:2.44,totalCost:4.88,vendors:"Sodi Logistics",types:""},
    {id:"PRT-10335854",name:"Right Side Pod GT5R",partNumber:"PC0633.340",sku:"1UTSG7TR5GOZ7",area:"Sodi racks",location:"Sodi racks",description:"Pc0633.340",qty:0,minQty:1,unitCost:118.71,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-10335869",name:"ALU Kolonical Washer",partNumber:"PC0711.111",sku:"160GA61U3LVD0",area:"",location:"General Storage",description:"",qty:22,minQty:1,unitCost:2.03,totalCost:44.66,vendors:"Sodi Logistics",types:""},
    {id:"PRT-10645025",name:"Insulated female disconnects 16-14 gauge",partNumber:"",sku:"2UOHXC2KY0WRD",area:"55-M 13",location:"55-M 13",description:"1/4 in plug",qty:15,minQty:10,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10647486",name:"JET BS-01-020 IR LASER / GUN SENSOR",partNumber:"",sku:"2819VKA5BC23E",area:"",location:"General Storage",description:"This part is for big shot gun",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"BETSON IMPERIAL PARTS & SERVICE",types:""},
    {id:"PRT-10693846",name:"17410-ze1-030",partNumber:"",sku:"2172FD0PQRYB6",area:"",location:"General Storage",description:"",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-10694053",name:"17230-ZE1-820 Cover; Air Cleaner",partNumber:"17230-ZE1-820",sku:"11J9Y2EKHHGXG",area:"",location:"General Storage",description:"Air Cover Cleaner",qty:-6,minQty:1,unitCost:23.3,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-10694059",name:"16044-ZE0-005 Choke Set",partNumber:"",sku:"2CLESSM6UFYIK",area:"",location:"General Storage",description:"Choke Set for GX160/200",qty:5,minQty:1,unitCost:25.05,totalCost:125.25,vendors:"MTA",types:""},
    {id:"PRT-11392474",name:"Knob; Recoil Starter (Pull Handle)",partNumber:"28461-Z4M-003",sku:"6FQN83F62H86",area:"",location:"General Storage",description:"Knob; Recoil Starter\nHonda Engines 28461-Z4M-003",qty:19,minQty:1,unitCost:6.22,totalCost:118.18,vendors:"MTA",types:""},
    {id:"PRT-11392920",name:"Tube; Breather 3683497",partNumber:"15721-ZH8-000",sku:"15721-ZH8-000",area:"",location:"General Storage",description:"Tube; Breather 3683497\nHonda Engines 15721-ZH8-000",qty:2,minQty:1,unitCost:4.0,totalCost:8.0,vendors:"MTA",types:""},
    {id:"PRT-11398321",name:"Stud for Adjustable Seat Strap",partNumber:"PC0143.083",sku:"1D82I9BITJ99Z",area:"",location:"General Storage",description:"STUD M6X40",qty:10,minQty:1,unitCost:9.64,totalCost:96.4,vendors:"Sodi Logistics",types:""},
    {id:"PRT-11679198",name:"16220-ZE1-020 GX200, GX160 SPACER, CARBURETOR",partNumber:"",sku:"00HB;;16220-ZE1-020;1;B5A17G;JAPAN;JP;392;",area:"Middle cabinets",location:"Middle cabinets",description:"Part Number 15 in image",qty:1,minQty:1,unitCost:7.11,totalCost:7.11,vendors:"MTA",types:""},
    {id:"PRT-12663950",name:"16561-ZL0-000 Spring Governor",partNumber:"",sku:"1V3Z2IBLPLW52",area:"",location:"General Storage",description:"Spring Governor 4743092",qty:10,minQty:1,unitCost:3.54,totalCost:35.4,vendors:"MTA",types:""},
    {id:"PRT-12663967",name:"Throttle return spring",partNumber:"",sku:"3S2Y57KHV6BDC",area:"Cabinet 56 \u2013 L bay 11",location:"Cabinet 56 \u2013 L bay 11",description:"Part number 16592-ze1-810 Honda - LaMonthe",qty:11,minQty:2,unitCost:1.5,totalCost:16.5,vendors:"",types:""},
    {id:"PRT-12668265",name:"17210-Z4M-821 Air Cleaner Element",partNumber:"",sku:"7CB31BVN9L5Z",area:"",location:"General Storage",description:"Air Cleaner Element for GX200",qty:2,minQty:10,unitCost:5.87,totalCost:11.74,vendors:"MTA",types:""},
    {id:"PRT-12738539",name:"8-32 Bolt",partNumber:"",sku:"130ZMPQUQ2H1X",area:"",location:"General Storage",description:"",qty:-3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12741296",name:"Clutch spring holder",partNumber:"",sku:"GXFUFLCV1ERY",area:"Shop",location:"Shop",description:"Part number 22421-822-610 Honda -LaMonthe",qty:0,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12743246",name:"Go kart kilswitch 35120-ZOT831",partNumber:"",sku:"2B0QI4FJI32C6",area:"",location:"General Storage",description:"On/off switch",qty:7,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12876751",name:"12210-ZL0-425",partNumber:"",sku:"3KHSHWBAF9YWY",area:"Shop",location:"Shop",description:"Gx200 cylinder head",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12876909",name:"36100-ZF6-P82",partNumber:"",sku:"3KY94VKLCUN5H",area:"",location:"General Storage",description:"On/off switch",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12894102",name:"8.8 flange bolt",partNumber:"",sku:"25XISA70F4XRR",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12900282",name:"Sodi Kart Seat Belt BUCKLE STYLE",partNumber:"",sku:"3C4Y8FHKJZYA9",area:"Sodi Racks",location:"Sodi Racks",description:"Telneex buckle belts\nPN: PC0143.096",qty:6,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12906288",name:"PC0313.009",partNumber:"",sku:"3GVMJYBNKGD41",area:"",location:"General Storage",description:"Crush washers",qty:6,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12906315",name:"PC0142.020",partNumber:"",sku:"32D981YRYW172",area:"",location:"General Storage",description:"Seat/frame spacer",qty:10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12909381",name:"14-16 gauge female connectors",partNumber:"",sku:"QG78467MK6PF",area:"",location:"General Storage",description:"",qty:10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910132",name:"1/2 fine nylon nut",partNumber:"",sku:"2PQ3DF0EPFUET",area:"",location:"General Storage",description:"",qty:100,minQty:20,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910139",name:"1/2 course nylon nut",partNumber:"",sku:"3I2BEJW4DYHUM",area:"",location:"General Storage",description:"",qty:45,minQty:20,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910455",name:"1/2 washers",partNumber:"",sku:"9IDU559M6QSR",area:"",location:"General Storage",description:"",qty:200,minQty:30,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910463",name:"5/16 washers",partNumber:"",sku:"1JHH7W4RP18W1",area:"",location:"General Storage",description:"",qty:120,minQty:30,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910475",name:"3/8x4 fine nylon nut",partNumber:"",sku:"24SO5VUCKTPXU",area:"",location:"General Storage",description:"",qty:100,minQty:20,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910784",name:"7/8 washer",partNumber:"",sku:"110L0ET9HLR53",area:"",location:"General Storage",description:"",qty:45,minQty:20,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12910824",name:"Inner tube3.40/3.00",partNumber:"",sku:"20MY71SQ30EES",area:"Shed/ tire rack",location:"Shed/ tire rack",description:"Family kart tubes",qty:130,minQty:20,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12912669",name:"11381-ZE2-801",partNumber:"",sku:"2AEZZX8T3XO78",area:"",location:"General Storage",description:"Gasket",qty:11,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12960739",name:"Break Band Family Go Kart",partNumber:"",sku:"27E5ZM956JNQ1",area:"shed",location:"shed",description:"These are \u201cbreak pads\u201d for family go karts",qty:206,minQty:50,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12972376",name:"1/4x20 inch bolt",partNumber:"",sku:"300MYOXFHYDVP",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-12972377",name:"1/4 coarse nut",partNumber:"",sku:"1ZPP170NM6S30",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13027678",name:"Fuel Pump",partNumber:"",sku:"1CDLEAXEKGL5F",area:"",location:"General Storage",description:"",qty:1,minQty:1,unitCost:28.99,totalCost:28.99,vendors:"MTA,Sodi Logistics",types:""},
    {id:"PRT-13028148",name:"Pc0671.109 ind2 gx270 motor cover",partNumber:"",sku:"1800ZYCHGRO03",area:"Sodi rack",location:"Sodi rack",description:"Sr5 engine cover\nGX270",qty:1,minQty:3,unitCost:97.15,totalCost:97.15,vendors:"",types:""},
    {id:"PRT-13028149",name:"Pc0632.067",partNumber:"",sku:"3SUDUJG5WJJW2",area:"",location:"General Storage",description:"Right side bumper buffer",qty:1,minQty:3,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13028150",name:"Pc0632.052 Left/Right side bumper buffers. SR5",partNumber:"",sku:"6QMERT28V32K",area:"Sodi cabinets",location:"Sodi cabinets",description:"Right side bumper buffer",qty:3,minQty:1,unitCost:72.84,totalCost:218.52,vendors:"",types:""},
    {id:"PRT-13028151",name:"Pc0681.156 rear cover GT5R",partNumber:"",sku:"3VLZ5P1PABMQZ",area:"Sodi cabinets",location:"Sodi cabinets",description:"Rear axle cover gt5r gx200",qty:2,minQty:2,unitCost:243.5,totalCost:487.0,vendors:"",types:""},
    {id:"PRT-13102825",name:"A-Premium Lift Supports Shock Struts",partNumber:"",sku:"GRMMTCJ083Q",area:"",location:"Shop cabinet",description:"WE USE THESE ON COASTER\nwhen inputting for inventory count each shock individually not by the boxes there's two in each box",qty:20,minQty:4,unitCost:10.99,totalCost:219.8,vendors:"",types:""},
    {id:"PRT-13105752",name:"NUT 3/8-24 Z Lug Nut (disc lock)",partNumber:"",sku:"1DV0EELNHXTLZ",area:"",location:"General Storage",description:"part number 1-20-0189 \nlug nuts for sprint karts",qty:100,minQty:50,unitCost:1.79,totalCost:179.0,vendors:"",types:""},
    {id:"PRT-13186644",name:"16100-Z4V-921 Carburetor 160/200",partNumber:"",sku:"2DJK5F92XL6CM",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13278479",name:"B1.C06100PN 6x 100",partNumber:"",sku:"M0XR8T4BFICJ",area:"",location:"General Storage",description:"Bolts for pedal index slide",qty:19,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13278480",name:"Zinc nut M6Nylstop B2.N06B",partNumber:"",sku:"3F75QXT2B3F7B",area:"",location:"General Storage",description:"",qty:91,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13382485",name:"35120-z0t-821",partNumber:"",sku:"R2VBJ37LYO89",area:"",location:"General Storage",description:"On/off switch for family kart",qty:11,minQty:6,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13403018",name:"X002809Y3P",partNumber:"",sku:"10IV8715Q9MJA",area:"",location:"General Storage",description:"GX160 air filters",qty:32,minQty:10,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13525589",name:"PC0143.009 Adjust Seat Lever",partNumber:"",sku:"QRXQPJRCKJII",area:"",location:"General Storage",description:"",qty:7,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749138",name:"PC0261.135",partNumber:"",sku:"2CM1FZRSE0PDM",area:"",location:"General Storage",description:"Front sodi rim",qty:6,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749195",name:"PC0612.068 front spoiler elastic band",partNumber:"",sku:"2P20T7TJB0532",area:"Sodi rack",location:"Sodi rack",description:"Elastic for front spoiler",qty:9,minQty:2,unitCost:7.48,totalCost:67.32,vendors:"",types:""},
    {id:"PRT-13749233",name:"PC0143.096 Safety belt 4 points",partNumber:"",sku:"2Z6CQLQCMYS9D",area:"",location:"General Storage",description:"Sodi 4 point seat belt",qty:4,minQty:3,unitCost:131.06,totalCost:524.24,vendors:"",types:""},
    {id:"PRT-13749284",name:"PC0412.058 upper steering bracket",partNumber:"",sku:"6H3DZFTV3P57",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749307",name:"PC0423.036 index pedal slide",partNumber:"",sku:"28W8IW563XZTV",area:"",location:"General Storage",description:"",qty:4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749331",name:"PC0425.035 center brake control",partNumber:"",sku:"35XUSZAY2I2P9",area:"",location:"General Storage",description:"",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749348",name:"PC0113.006 plastic cap for steering tube",partNumber:"",sku:"33VD6H6GJHX23",area:"",location:"General Storage",description:"",qty:15,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749411",name:"PC0633.342 right fairing",partNumber:"",sku:"1SP61VRM2LUEH",area:"Sodi rack",location:"Sodi rack",description:"",qty:8,minQty:1,unitCost:90.02,totalCost:720.16,vendors:"",types:""},
    {id:"PRT-13749432",name:"PC0633.343 left fairing GT5R",partNumber:"",sku:"Z24GJ9PHQWDW",area:"Sodi rack",location:"Sodi rack",description:"gt5r left fairing trim",qty:1,minQty:1,unitCost:90.02,totalCost:90.02,vendors:"",types:""},
    {id:"PRT-13749493",name:"PC0672.053 engine cover bracket",partNumber:"",sku:"3JLBWVMXJKN6I",area:"",location:"General Storage",description:"Sodi hour meter and on off switch bracket",qty:4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749591",name:"B2.N08 m8 nylon nut",partNumber:"",sku:"FKWV4G8IUW75",area:"",location:"General Storage",description:"",qty:20,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13749619",name:"B1.C081030EP steel screw m8 D10",partNumber:"",sku:"4PLS8UCHULRL",area:"",location:"General Storage",description:"Upper seat support",qty:10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13777017",name:"PC0681.147 right support rear",partNumber:"",sku:"3G3U443EMML5M",area:"",location:"General Storage",description:"",qty:0,minQty:3,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13777048",name:"PC0623.204 rear arm",partNumber:"",sku:"2E9RBZZ2PGMKT",area:"",location:"General Storage",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13834402",name:"Outer seal after market E094-VI8-SS",partNumber:"",sku:"DSN3BF8CQ07F",area:"",location:"General Storage",description:"",qty:29,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13847296",name:"PC0424.017 left heel rest",partNumber:"",sku:"SFW1OY3EACMU",area:"",location:"General Storage",description:"",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13877783",name:"gumout jet spray carb and choke cleaner",partNumber:"",sku:"3AD99K5QPWU5R",area:"",location:"General Storage",description:"Carb choke & parts cleaner",qty:5,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"amazon",types:""},
    {id:"PRT-13877882",name:"Track Master II Front Euro Tires",partNumber:"",sku:"1TAVW2JFHKJT9",area:"",location:"General Storage",description:"",qty:0,minQty:2,unitCost:22.0,totalCost:0.0,vendors:"Litchfield Sports, INC.",types:"Critical"},
    {id:"PRT-13909629",name:"PC0612.064",partNumber:"",sku:"FVP6X300TG2E",area:"",location:"General Storage",description:"Black front buffer",qty:1,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13909635",name:"PC0612.080",partNumber:"",sku:"3D3CCYSIRK8OE",area:"",location:"General Storage",description:"Front buffer guide pin",qty:2,minQty:6,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13925682",name:"B1.C081016EP steel screw chcm8 d10 L16",partNumber:"",sku:"1YN565857BZ5S",area:"",location:"General Storage",description:"",qty:12,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13925683",name:"B2.N08B Nut m8 m8 mini",partNumber:"",sku:"IPGJQRG61TPV",area:"",location:"General Storage",description:"",qty:12,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-13925690",name:"PC0421.061 Green pedal, Right",partNumber:"",sku:"3TVOBHYU0ABWP",area:"Sodi racks",location:"Sodi racks",description:"Green gas pedal for the right side",qty:3,minQty:2,unitCost:105.56,totalCost:316.68,vendors:"",types:""},
    {id:"PRT-13925691",name:"PC0422.061 brake pedal, Red",partNumber:"",sku:"2RFXN71SQVGBE",area:"Sodi racks",location:"Sodi racks",description:"Red left brake pedal\n\nALT PN: PC0422.038",qty:2,minQty:2,unitCost:109.32,totalCost:218.64,vendors:"",types:""},
    {id:"PRT-13925693",name:"PC0424.016 right heel rest",partNumber:"",sku:"15QDF8FTAGSC5",area:"",location:"General Storage",description:"",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14030522",name:"91202-Z1T-003 OIL SEAL",partNumber:"91202-Z1T-003",sku:"23AOJN0GFJ7HP",area:"",location:"General Storage",description:"",qty:4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14030544",name:"91201-Z1D-003 OIL SEAL",partNumber:"",sku:"3DG7FMZETNLDL",area:"",location:"General Storage",description:"",qty:8,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14030638",name:"90403-889-000 washer",partNumber:"",sku:"2TDMOUG1VL6AA",area:"",location:"General Storage",description:"",qty:10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14030682",name:"91201-890-003 OIL SEAL",partNumber:"",sku:"2LNB384L0SULK",area:"",location:"General Storage",description:"",qty:8,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14030727",name:"91202-Z2F-801 OIL SEAL",partNumber:"",sku:"91202-Z.3-801",area:"Middle cabinets",location:"Middle cabinets",description:"Clutch seal",qty:-1,minQty:1,unitCost:9.71,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14030794",name:"23120-889-751 SPROCKET",partNumber:"",sku:"5FM9QYPOE47E",area:"",location:"General Storage",description:"",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14038153",name:"22121-883-620 Center Clutch",partNumber:"",sku:"1VF94IZZL8MF5",area:"",location:"General Storage",description:"",qty:5,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14038550",name:"Air Filter Sodi Karts",partNumber:"",sku:"3O802EQL2WEAF",area:"",location:"General Storage",description:"",qty:24,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"amazon",types:""},
    {id:"PRT-14161419",name:"22121-889-750 Center Clutch",partNumber:"",sku:"2XMTCRRKYUML2",area:"",location:"General Storage",description:"",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14162124",name:"PC0143.093 3 point seat belt complete kit",partNumber:"",sku:"234UWMCW1H7A8",area:"",location:"General Storage",description:"",qty:1,minQty:1,unitCost:62.79,totalCost:62.79,vendors:"Sodi Logistics",types:""},
    {id:"PRT-14162141",name:"PC0324.031 REAR hydraulic brake hose LI540",partNumber:"",sku:"2L1O4Z3UD6GJ0",area:"",location:"General Storage",description:"",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-14162191",name:"PC0711.261 throttle cable sheath",partNumber:"",sku:"JNPC0KGPPICQ",area:"",location:"General Storage",description:"",qty:10,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"Sodi Logistics",types:""},
    {id:"PRT-14162205",name:"5HP BALDOR 1755RPM 184T TEFC 3PH SUPER-E MOTOR EM3615T",partNumber:"",sku:"3ILWLDHUJ3VPD",area:"",location:"General Storage",description:"motor is used for dragon",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"ELECTRIC MOTOR WHOLESALE, INC",types:""},
    {id:"PRT-14444820",name:"No Parts",partNumber:"",sku:"30W8HAJTX82CW",area:"",location:"General Storage",description:"",qty:-277,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14444825",name:"No parts",partNumber:"",sku:"3GQETE3IREMNJ",area:"",location:"General Storage",description:"",qty:-20,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14444827",name:"No Parts",partNumber:"",sku:"1TKITECM4Q4BB",area:"",location:"General Storage",description:"",qty:-11,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14445796",name:"steering cushion for karts",partNumber:"",sku:"2RKGJUDEUDYQ9",area:"",location:"General Storage",description:"",qty:0,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14445797",name:"Family Go Kart Tire",partNumber:"",sku:"3EBF5F3PWDC5K",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14462295",name:"30500-Z5K-004 COIL ASSY IGNITION",partNumber:"",sku:"1CLEVVDWB0WDH",area:"",location:"General Storage",description:"",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"MTA",types:""},
    {id:"PRT-14506703",name:"PC0451.022 TEKNEEX TANK sodi",partNumber:"",sku:"30OR7IKL28G95",area:"Sodi racks",location:"Sodi racks",description:"Sodi gas tanx, tekneex",qty:1,minQty:1,unitCost:84.89,totalCost:84.89,vendors:"Sodi Logistics",types:""},
    {id:"PRT-14532208",name:"PC0623.125 rear bumper sup fixation",partNumber:"",sku:"1HFK7RIRAFC9L",area:"",location:"General Storage",description:"Rear bumper silent bloc fixation",qty:6,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14532279",name:"PC0711.214 cable tightener blade",partNumber:"",sku:"329X6ETNO40EL",area:"",location:"General Storage",description:"Blade for cable hold down",qty:10,minQty:3,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14532288",name:"TR247.100 engine sprocket holder hub",partNumber:"",sku:"26A8X4XXUVMIR",area:"",location:"General Storage",description:"Clutch to belt sprocket holder",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14724747",name:"22421-822-610 clutch spring cap",partNumber:"",sku:"12AAA2XENWLQ6",area:"",location:"General Storage",description:"Spring cap for clutch",qty:16,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14725184",name:"25651-889-750 dipstick reader",partNumber:"",sku:"ORJIGV27380L",area:"",location:"General Storage",description:"Clutch dipstick reader end",qty:8,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14725202",name:"25620-805-612 dipstick knob",partNumber:"",sku:"2NLDW5QOERERH",area:"",location:"General Storage",description:"Clutch dipstick knob",qty:8,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14725643",name:"22411-822-611 clutch springs",partNumber:"",sku:"5M4YPZZH3J48",area:"",location:"General Storage",description:"Pressure springs for clutch",qty:12,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14829003",name:"PC0221.030 RIGHT TIE ROD",partNumber:"",sku:"2PDVM2FPTEUAC",area:"",location:"General Storage",description:"Right tie rod 1.270",qty:9,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14829017",name:"PC0221.029 left tie rod",partNumber:"",sku:"1O4OJAX9S6F7U",area:"",location:"General Storage",description:"Left sodi tie rod 1.240",qty:8,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14829463",name:"PC0232.014 left ball joint",partNumber:"",sku:"DD6VIF1FRDDV",area:"",location:"General Storage",description:"Left hymen- POSL 10",qty:3,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14829475",name:"PC0232.029 right balljoint",partNumber:"",sku:"2PE6RSZ4YY1W9",area:"",location:"General Storage",description:"Right hymen POS10",qty:3,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14829584",name:"PC0681.149 left support axle prot",partNumber:"",sku:"3FL6DPIJ439PT",area:"",location:"General Storage",description:"Rear cover support",qty:6,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14829600",name:"PC0681.150 middle support rear",partNumber:"",sku:"2YTVZIC735FZJ",area:"",location:"General Storage",description:"Middle support for rear protection",qty:4,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14865931",name:"PC0621.121 rear protect sup",partNumber:"",sku:"15VDRHOWY7ZV4",area:"",location:"General Storage",description:"Rear bumper support",qty:2,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14866114",name:"PC0711.113 alum conical washer D10",partNumber:"",sku:"JOHQQTWETI1Z",area:"",location:"General Storage",description:"Stub axle washers black",qty:20,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14866148",name:"CA171.301 carburetor return spring",partNumber:"",sku:"ZW500TZJU9F7",area:"",location:"General Storage",description:"Return spring for carburetor",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14866174",name:"PC0213.024 stub axle washer",partNumber:"",sku:"2GK2M4XHYL5S8",area:"",location:"General Storage",description:"Washer for stub axle",qty:20,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-14866192",name:"PC0425.064 center throttle linkage",partNumber:"",sku:"2Z5Z9L6B0B20X",area:"",location:"General Storage",description:"Pedal linkage for gas pedal",qty:3,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15749441",name:"No Parts Used",partNumber:"",sku:"228RACU9WW53G",area:"",location:"General Storage",description:"Add this if no parts are used.",qty:-3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15749930",name:"Exhaust gasket, muffler [GX160]",partNumber:"",sku:"18381-Z0T-801",area:"Middle cabinets",location:"Middle cabinets",description:"Gasket for the exhaust for the 160 motors",qty:-1,minQty:1,unitCost:4.37,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15749942",name:"GX160 wire, stop switch",partNumber:"",sku:"00HB;;36101-ZE1-010;1;XB2K20;JAPAN;JP;392;;;;",area:"Middle cabinets",location:"Middle cabinets",description:"gx160 \"kill switch\" wire connector",qty:1,minQty:1,unitCost:9.67,totalCost:9.67,vendors:"",types:""},
    {id:"PRT-15749952",name:"Spring, cable return",partNumber:"",sku:"00HB;;16592-ZE1-810;1;KB5C04;JAPAN;JP;392;;;;;",area:"",location:"General Storage",description:"PN: 16592-ZE1-810",qty:10,minQty:1,unitCost:2.99,totalCost:29.9,vendors:"",types:""},
    {id:"PRT-15749975",name:"Push Rods (160)",partNumber:"",sku:"00HB;;14410-ZE1-010;1;KB2X21;JAPAN;JP;392;;;;;",area:"Middle cabinets",location:"Middle cabinets",description:"PN: 14410-Ze1-010\nQUANTITY: 2",qty:14,minQty:1,unitCost:4.5,totalCost:63.0,vendors:"",types:""},
    {id:"PRT-15749981",name:"GX160 Lifter valve",partNumber:"",sku:"14441-010",area:"Middle cabinets",location:"Middle cabinets",description:"PN: 14441-ze1-010\nQUANTITY: 2",qty:6,minQty:1,unitCost:11.95,totalCost:71.7,vendors:"",types:""},
    {id:"PRT-15749989",name:"GX160 Gas Tank",partNumber:"",sku:"RF8LQKHLX3BP",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15750884",name:"On/off switch bracket",partNumber:"",sku:"22KTZOZ5AFRHV",area:"",location:"General Storage",description:"Bracket for on/off switch",qty:19,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15750941",name:"Plate, push rod guide GX200",partNumber:"",sku:"3MYVLVN3P8Q4A",area:"Middle cabinets",location:"Middle cabinets",description:"PN: 14791-ZE1-010\nQTY: 1",qty:8,minQty:1,unitCost:3.47,totalCost:27.76,vendors:"",types:""},
    {id:"PRT-15751099",name:"GX160 Gov. Rod",partNumber:"",sku:"3HL3KV3LTFGX0",area:"Middle cabinets",location:"Middle cabinets",description:"OLD PN: 16555-ZE1-000\nCORRECT PN (GX160): 16555-Z0T-N70\nQTY PER ORDER: 1",qty:4,minQty:1,unitCost:4.28,totalCost:17.12,vendors:"",types:""},
    {id:"PRT-15751165",name:"GX240 GOV. SHEATH",partNumber:"",sku:"1JGGUB17777NM",area:"",location:"General Storage",description:"PN: 16531-Z0A-000",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15751166",name:"GX200 Exhaust valve (OLD PN)",partNumber:"",sku:"00HB;;14721-ZF1-000;1;KB0V13;JAPAN;JP;392;;;;;",area:"Middle cabinets",location:"Middle cabinets",description:"PN: 14721-ZF1-000",qty:2,minQty:1,unitCost:7.28,totalCost:14.56,vendors:"",types:""},
    {id:"PRT-15751168",name:"Exhaust valve, incorrect parts",partNumber:"",sku:"VRV4KMY5A7IO",area:"",location:"General Storage",description:"PN: 14721-ZH8-810\nGX160 PN for our karts: 14721-Z4M-000",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15751170",name:"GX200 Intake valve 14711-ZF1-000",partNumber:"",sku:"3ADD9LOYDGYAX",area:"Middle cabinets",location:"Middle cabinets",description:"PN: 14711-ZF1-000\nORDER QTY: 1\nGX200",qty:2,minQty:1,unitCost:5.75,totalCost:11.5,vendors:"",types:""},
    {id:"PRT-15751175",name:"ROD GUIDE wrong part 14791-ZE2-010",partNumber:"",sku:"2S6DGFSX1TPZA",area:"Middle cabinets",location:"Middle cabinets",description:"Rod Guide plate, not for our motors",qty:4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15751179",name:"GX200 Exhaust Valve (stelite) 14721-Zh8-810",partNumber:"",sku:"14721-ZH8-810",area:"Middle cabinet",location:"Middle cabinet",description:"Exhaust valve",qty:3,minQty:1,unitCost:7.28,totalCost:21.84,vendors:"",types:""},
    {id:"PRT-15752048",name:"Used part",partNumber:"",sku:"2TQYVYIKXX1GQ",area:"",location:"General Storage",description:"",qty:-41,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15799647",name:"Soap",partNumber:"",sku:"2WNU0P6JXXOCZ",area:"",location:"General Storage",description:"",qty:-7,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15823939",name:"None",partNumber:"",sku:"TMO7JA96MUES",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850036",name:"PC0274.005 rear axle bearing",partNumber:"",sku:"9IGVC5MM0Y9V",area:"",location:"General Storage",description:"Axle bearing",qty:1,minQty:2,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850057",name:"PC0274.019 axle bearing set screw",partNumber:"",sku:"451IKIWUQW7S",area:"",location:"General Storage",description:"Set screw for axle bearing",qty:20,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850084",name:"PC0425.037 pedal support",partNumber:"",sku:"4ZLA9PKI4B4W",area:"Sodi racks",location:"Sodi racks",description:"Pedal support for both old and new models",qty:5,minQty:2,unitCost:87.36,totalCost:436.8,vendors:"",types:""},
    {id:"PRT-15850096",name:"PC0711.170 breather fitting",partNumber:"",sku:"3OJIRNHZ8H33Z",area:"",location:"General Storage",description:"Breather fitting for fuel pump",qty:20,minQty:5,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850126",name:"TR223.269 1/2 sprocket 68t D50",partNumber:"",sku:"1AZXX72MTI6L3",area:"",location:"General Storage",description:"Rear sprocket for sr5 hollow axle",qty:2,minQty:4,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850134",name:"TR231.693 belt 960mm x 33mm",partNumber:"",sku:"KQKF0T6B5UBV",area:"",location:"General Storage",description:"Belt for sr5 with small rear sprocket",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850224",name:"TR247.125 engine sprocket 25T",partNumber:"",sku:"2SSNIZB61PW8J",area:"",location:"General Storage",description:"25 tooth engine sprocket",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15850239",name:"TR247.126 engine sprocket 26T",partNumber:"",sku:"1SYKPIN2ZADBM",area:"",location:"General Storage",description:"26 Tooth engine sprocket",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15852633",name:"Spindle bearing",partNumber:"",sku:"ECEM84BG7DPA",area:"",location:"General Storage",description:"",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15855785",name:"012.9 Allen 1/4 bolt",partNumber:"",sku:"3FBTFPL6NHM63",area:"",location:"General Storage",description:"",qty:86,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15855795",name:"PC0272.309 Sodi 200 axle",partNumber:"",sku:"3H0AXG0L9S1EE",area:"",location:"General Storage",description:"",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15887365",name:"17231-z4m-010 air cleaner housing box cover",partNumber:"",sku:"K5XUGID4ZBMB",area:"",location:"General Storage",description:"200, 160 cover",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15959994",name:"Sodi kart TRADITIONAL seat belt",partNumber:"",sku:"3BANSZ4LFRWGB",area:"Sodi racks",location:"Sodi racks",description:"Tekneex seat belt\nMale and female assembly\n\nPN: PC0143.092",qty:1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15962493",name:"Sakamoto Rear Tires (HARD)",partNumber:"",sku:"JTGD7DX5QEI3",area:"",location:"General Storage",description:"Hard compound, directional \n11 x 7.10 - 5",qty:30,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15962498",name:"Sakamoto Front Tires (HARD)",partNumber:"",sku:"19E2UYLZTSYGE",area:"",location:"General Storage",description:"Hard compound, directional \n10 x 4.50 - 5",qty:-4,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15971193",name:"Sakamoto Tires (FK, SK, KK)",partNumber:"",sku:"2V0YDWHP7HVLC",area:"Tire Racks",location:"Tire Racks",description:"12 x. 4.00-5",qty:0,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15971206",name:"Duro Rear (EURO)",partNumber:"",sku:"5KXZXV6AVWPJ",area:"Tire rack",location:"Tire rack",description:"11 x 7.10-5",qty:14,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-15971207",name:"Duro Front (EURO)",partNumber:"",sku:"2VB4HQ3K3ZSBL",area:"Tire rack",location:"Tire rack",description:"10 x 4.50-5",qty:-4,minQty:8,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16138740",name:"Exhaust flex",partNumber:"",sku:"3TP0PUYAYSXG5",area:"Sodi rack",location:"Sodi rack",description:"D30 D35 L70\nFits for EXHAUST, PM371.043",qty:3,minQty:1,unitCost:26.86,totalCost:80.58,vendors:"",types:""},
    {id:"PRT-16138809",name:"Wall anchors and screws",partNumber:"",sku:"18D5YJP9NC00E",area:"Matiance",location:"Matiance",description:"",qty:49,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16161322",name:"Rear Bumper Protector GT5R Pc0621.178",partNumber:"",sku:"Y2GQT7RIGANL",area:"Sodi racks",location:"Sodi racks",description:"Pc0621.178\nGT5R rear Bumper",qty:2,minQty:1,unitCost:193.71,totalCost:387.42,vendors:"",types:""},
    {id:"PRT-16161348",name:"Steering Shaft Linkage PC0411.026",partNumber:"",sku:"1NHUGGXNQK5G2",area:"Sodi racks",location:"Sodi racks",description:"Shaft for both gt5r and sr5",qty:4,minQty:1,unitCost:186.07,totalCost:744.28,vendors:"",types:""},
    {id:"PRT-16161381",name:"Front Butter Support, Double, pC0612.061",partNumber:"",sku:"9WLQ94H686XZ",area:"Sodi racks",location:"Sodi racks",description:"For gt5r and sr5",qty:2,minQty:1,unitCost:107.2,totalCost:214.4,vendors:"",types:""},
    {id:"PRT-16209837",name:"White Wheels",partNumber:"",sku:"ZIFDWQ5VWS0Y",area:"Dragon Coaster",location:"Dragon Coaster",description:"White wheel with bearings and sleeve inside",qty:-13,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16217455",name:"PC0143.092 3 point safety harness",partNumber:"",sku:"38WG5MGK2B761",area:"",location:"General Storage",description:"Sodi sr5 safety harness",qty:3,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16217515",name:"PC0674.012 motor mount",partNumber:"",sku:"264U22P1ZO455",area:"",location:"General Storage",description:"Motor mount for gx200 motors",qty:8,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16217542",name:"PM391.012 bride restriction",partNumber:"",sku:"3HF06K5EE0A7K",area:"",location:"General Storage",description:"Gx270",qty:2,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16531197",name:"1-61-0032 motor mount",partNumber:"",sku:"O06YBI15K4CU",area:"",location:"General Storage",description:"Sprint motor mount",qty:2,minQty:1,unitCost:149.0,totalCost:298.0,vendors:"",types:""},
    {id:"PRT-16531358",name:"3VX315 drive belt",partNumber:"",sku:"3VGQIW4MKC0B1",area:"",location:"General Storage",description:"Family kart drive belt",qty:17,minQty:1,unitCost:6.0,totalCost:102.0,vendors:"",types:""},
    {id:"PRT-16531359",name:"120319 drive belt",partNumber:"",sku:"1JR04AR2Z5QDJ",area:"",location:"General Storage",description:"Sprint kart drive belt",qty:10,minQty:1,unitCost:70.0,totalCost:700.0,vendors:"",types:""},
    {id:"PRT-16902942",name:"Exhaust fan motor",partNumber:"",sku:"19ZSJVHNBGZJL",area:"",location:"General Storage",description:"Ex fan bathrooms",qty:-1,minQty:1,unitCost:0.0,totalCost:0.0,vendors:"",types:""},
    {id:"PRT-16949598",name:"SODI Steering Wheel pC0431.006",partNumber:"",sku:"12M17CS80BLLB",area:"Sodi racks",location:"Sodi racks",description:"Rounded sodi steering wheel type",qty:3,minQty:1,unitCost:139.39,totalCost:418.17,vendors:"",types:""},
    {id:"PRT-16949716",name:"Brake / Sprocket protector PC0683.006",partNumber:"",sku:"Y7Y1PKHZTKMG",area:"Sodi racks",location:"Sodi racks",description:"The Protector \nPc0683.006",qty:3,minQty:1,unitCost:34.5,totalCost:103.5,vendors:"",types:""},
    {id:"PRT-16949831",name:"Fuel Tank Pipe, plongeur PC0452.025",partNumber:"",sku:"35HEQ61J5ORRP",area:"Sodi Racks",location:"Sodi Racks",description:"Inner tube for tank on the feed line",qty:1,minQty:1,unitCost:26.88,totalCost:26.88,vendors:"",types:""},
    {id:"PRT-16956310",name:"Sodi Fuel Cap, Tank PC0453.010",partNumber:"",sku:"NVMXO0C7CR29",area:"SODI racks",location:"SODI racks",description:"Fuel caps for the fuel tanks, with inner gasket",qty:6,minQty:1,unitCost:6.34,totalCost:38.04,vendors:"",types:""}
  ],
  partWriteoffs:[],
  shifts:[],
  vendors:[
    {id:"VND-867563",name:"amazon",contact:"",email:"",phone:"",contacts:[],assets:"",notes:""},
    {id:"VND-720845",name:"Ams Oil",contact:"ANTHONY E PAOLONE",email:"tonyshavings@yahoo.com",phone:"+17022897304",contacts:[{name:"ANTHONY E PAOLONE",email:"tonyshavings@yahoo.com",phone:"+17022897304"}],assets:"",notes:""},
    {id:"VND-908922",name:"BETSON IMPERIAL PARTS & SERVICE",contact:"",email:"",phone:"",contacts:[],assets:"",notes:""},
    {id:"VND-1007449",name:"BoltsandNuts.com",contact:"",email:"",phone:"",contacts:[],assets:"",notes:""},
    {id:"VND-1595251",name:"CalicoProducts",contact:"",email:"",phone:"",contacts:[],assets:"",notes:""},
    {id:"VND-1600454",name:"CWF",contact:"",email:"",phone:"",contacts:[],assets:"A/C 3 - 7.5 ton over walk in,AC Unit 2 Air Handler",notes:""},
    {id:"VND-1448681",name:"ELECTRIC MOTOR WHOLESALE, INC",contact:"",email:"",phone:"",contacts:[],assets:"Dragon Coaster",notes:""},
    {id:"VND-1007424",name:"Fastener Superstore",contact:"",email:"",phone:"",contacts:[],assets:"",notes:""},
    {id:"VND-828541",name:"FormulaK",contact:"Michael Stenger",email:"parts@formulakequipment.com",phone:"+18008730291",contacts:[{name:"Michael Stenger",email:"parts@formulakequipment.com",phone:"+18008730291"}],assets:"Family Kart 1,Family Kart 10,Family Kart 11,Family Kart 12,Family Kart 13,Family Kart 14,Family Kart 15,Family Kart 16,Family Kart 17,Family Kart 18,Family Kart 19,Family Kart 2,Family Kart 20,Family Kart 21,Family Kart 22,Family Kart 23,Family Kart 24,Family Kart 25,Family Kart 26,Family Kart 27,Family Kart 28,Family Kart 29,Family Kart 3,Family Kart 30,Family Kart 31,Family Kart 32,Family Kart 33,Family Kart 34,Family Kart 4,Family Kart 5,Family Kart 6,Family Kart 7,Family Kart 8,Family Kart 9",notes:""},
    {id:"VND-631770",name:"Frederiksen",contact:"Jim Frederickson",email:"jimfrederind1@aol.com",phone:"+18136284545",contacts:[{name:"Jim Frederickson",email:"jimfrederind1@aol.com",phone:"+18136284545"}],assets:"",notes:""},
    {id:"VND-624351",name:"Insinger",contact:"",email:"",phone:"",contacts:[],assets:"",notes:""},
    {id:"VND-619481",name:"J&J Amusements",contact:"Dan Hansen",email:"dan@jjamusements.com",phone:"",contacts:[{name:"Dan Hansen",email:"dan@jjamusements.com",phone:""},{name:"Kevin",email:"kderrickson@jjamusements.com",phone:""},{name:"Monique",email:"monique@jjamusements.com",phone:""}],assets:"Sprint 15,Sprint 4,Sprint 5,Sprint 9",notes:""},
    {id:"VND-1477393",name:"Jakes Associates",contact:"David Mori",email:"d.mori@jakesassociates.com",phone:"",contacts:[{name:"David Mori",email:"d.mori@jakesassociates.com",phone:""}],assets:"",notes:""},
    {id:"VND-1433391",name:"Litchfield Sports, INC.",contact:"Store Number",email:"info@litchfiedspecialty.com",phone:"+12173243390",contacts:[{name:"Store Number",email:"info@litchfiedspecialty.com",phone:"+12173243390"}],assets:"",notes:""},
    {id:"VND-1594950",name:"LVMGP Internal",contact:"Jackie",email:"jackie@lvmgp.com",phone:"",contacts:[{name:"Jackie",email:"jackie@lvmgp.com",phone:""},{name:"Kristin Chmieleweski",email:"generalmanager@lvmgp.com",phone:"+17252073368"},{name:"Liz Viramontes",email:"liz@lvmgp.com",phone:""}],assets:"",notes:""},
    {id:"VND-720836",name:"Micar Fabrication",contact:"Micar Fabrication",email:"",phone:"+17028714300",contacts:[{name:"Micar Fabrication",email:"",phone:"+17028714300"}],assets:"",notes:""},
    {id:"VND-634913",name:"Mikes merchandise",contact:"",email:"",phone:"",contacts:[],assets:"Tornado",notes:""},
    {id:"VND-670633",name:"MTA",contact:"",email:"",phone:"",contacts:[],assets:"GX200 UT2 RH2 Engine,Sodi 17 (SR5),Sodi 18 (SR5),Sodi 19 (SR5),Sodi 20 (SR5),Sodi 21 (SR5),Sodi 22 (SR5)",notes:""},
    {id:"VND-699886",name:"Sakamoto",contact:"Derek Yeagan",email:"derek@sakamototires.com",phone:"",contacts:[{name:"Derek Yeagan",email:"derek@sakamototires.com",phone:""}],assets:"",notes:""},
    {id:"VND-720843",name:"Showman Supplies",contact:"Terri",email:"tfrancis@showmensupplies.com",phone:"",contacts:[{name:"Terri",email:"tfrancis@showmensupplies.com",phone:""}],assets:"Dragon Coaster,Fun Slide,Tornado",notes:""},
    {id:"VND-671497",name:"Sodi Logistics",contact:"",email:"",phone:"",contacts:[],assets:"Sodi 13 (SR5),Sodi 14 (SR5),Sodi 15 (SR5),Sodi 16 (SR5),Sodi 17 (SR5),Sodi 18 (SR5),Sodi 19 (SR5),Sodi 20 (SR5),Sodi 21 (SR5),Sodi 22 (SR5)",notes:""},
    {id:"VND-1661352",name:"Super Service Heating and Cooling",contact:"",email:"",phone:"",contacts:[],assets:"A/C 3 - 7.5 ton over walk in,AC Unit 2 Air Handler",notes:""},
    {id:"VND-827160",name:"supersport timing",contact:"",email:"",phone:"",contacts:[],assets:"MyLaps Transponder 12480024,MyLaps transponder 12486708,MyLaps Transponder 12608563,MyLaps Transponder 12673979,MyLaps Transponder 12724659",notes:""},
    {id:"VND-1595544",name:"Two Way Radio Pro (CavComm)",contact:"Andrew Hooghkirk",email:"andrewh@cavcominc.com",phone:"+12188922111",contacts:[{name:"Andrew Hooghkirk",email:"andrewh@cavcominc.com",phone:"+12188922111"}],assets:"Hytera Radio #1,Hytera Radio #10,Hytera Radio #11,Hytera Radio #12,Hytera Radio #13,Hytera Radio #14,Hytera Radio #15,Hytera Radio #16,Hytera Radio #3,Hytera Radio #4,Hytera Radio #5,Hytera Radio #6,Hytera Radio #7,Hytera Radio #8",notes:""},
    {id:"VND-718009",name:"Wisdom",contact:"",email:"",phone:"",contacts:[],assets:"Dragon Coaster,Fun Slide,Tornado",notes:""}
  ],
  vendorVisits:[],
  compliance:[],
  incidents:[],
  downtimes:[],
  arcadeMachines:[],
  arcadeRevenue:[],
  supplies:[],
  arcadePMs:[],
  handoffs:[],
  preopState:{},
  teamMembers:[
    {id:'TM001',name:'',role:'owner',certifications:[]}
  ]
};

var IDX={WO:6,SH:5,P:8,V:4,VV:1,C:5,INC:2,DT:2,ARC:6,HO:2,TM:9};
function nid(p){IDX[p]=(IDX[p]||0)+1;return p+'-'+Date.now().toString(36)+IDX[p]+'-'+Math.random().toString(36).slice(2,6);}
function today(){return new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});}
function addD(d,n){var t=new Date(d+'T12:00:00');t.setDate(t.getDate()+n);return t.toISOString().slice(0,10);}
function fmt(d){return d?new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'--';}
function fmtS(d){return d?new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'--';}
function fmtM(n){return n?'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'$0.00';}
function du(d){return Math.ceil((new Date(d)-new Date())/86400000);}
function fmtH(h){return h===0?'12am':h===12?'12pm':h<12?h+'am':(h-12)+'pm';}
function fmtHM(h){var H=Math.floor(h+1e-6),m=Math.round((h-H)*60);if(m>=60){H+=1;m-=60;}var ap=H<12?'am':'pm';var hh=(H%12)||12;return hh+(m?':'+(m<10?'0'+m:m):'')+ap;}
function fmtMins(m){m=Math.round(m||0);if(m<=0)return '0m';var h=Math.floor(m/60),mm=m%60;return (h?h+'h':'')+(h&&mm?' ':'')+(mm?mm+'m':(h?'':'0m'));}
function isToday(d){return d===today();}
function isPast(d){return d<today();}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function pill(label,color){return '<span class="pill" style="background:'+color+'22;color:'+color+';border:1px solid '+color+'44">'+esc(label)+'</span>';}
function monday(d){var t=new Date(d+'T12:00:00'),dy=t.getDay(),df=dy===0?-6:1-dy;t.setDate(t.getDate()+df);return t.toISOString().slice(0,10);}




function canFinancials(){return['owner','gm','agm','manager'].indexOf(currentUser.role)>=0;}
function isSupervisor(){return['owner','gm','agm','manager','area-lead','lead'].indexOf(currentUser.role)>=0;}
// Inspection sign-off is a management responsibility. A Maintenance Lead can
// schedule and run work but is NOT authorized to approve inspections, so this
// is intentionally narrower than isSupervisor() (no 'lead' / 'area-lead').
function canApproveInspection(){return['owner','gm','agm','manager'].indexOf(currentUser.role)>=0;}
// PM/Standard-Work template editing is an AGM-and-up responsibility. Everyone
// else with the tab can view issued templates read-only.
function canEditTemplates(){return['owner','gm','agm'].indexOf(currentUser.role)>=0;}
function canSeePay(){return['owner','gm'].indexOf(currentUser.role)>=0;}
function canLaborCost(){return['owner','gm'].indexOf(currentUser.role)>=0;}
function woPartsCost(w){var s=0,pu=(w&&w.partsUsed)||[];for(var i=0;i<pu.length;i++)s+=Number(pu[i].cost)||0;s+=Number(w&&w.otherPartsCost)||0;return s;}
function woDateMs(w){var t=Date.parse(w.completed||w.created||'');return isNaN(t)?0:t;}
function personRate(name){if(name){var k=String(name).trim().toLowerCase();for(var i=0;i<D.teamMembers.length;i++){var m=D.teamMembers[i];if((m.name||'').trim().toLowerCase()===k)return (m.payRate!=null&&m.payRate!=='')?(Number(m.payRate)||0):(typeof DIAG_LABOR_RATE!=='undefined'?DIAG_LABOR_RATE:30);}return 20;}return (typeof DIAG_LABOR_RATE!=='undefined'?DIAG_LABOR_RATE:30);}
function woLaborCost(w){return (Number(w.laborHours)||0)*personRate(w&&w.assignee);}
function vendorNameById(id){if(!id)return '';for(var i=0;i<D.vendors.length;i++)if(D.vendors[i].id===id)return D.vendors[i].name||id;return '';}
var currentUser=D.teamMembers[0];
var DEFAULT_PASSWORD='1234';
function effUser(m){return ((m.username||'').trim()||(m.name||'').split(' ')[0].toLowerCase());}
function effPass(m){return ((m.password||'')||DEFAULT_PASSWORD);}
function updateHeader(){var n=document.getElementById('hdrName'),r=document.getElementById('hdrRole');if(!currentUser){if(n)n.textContent='';if(r)r.textContent='';return;}if(n)n.textContent=currentUser.name||'';if(r){r.textContent=ROLE_LABELS[currentUser.role]||currentUser.role;r.style.background=(ROLE_COLORS[currentUser.role]||'#7c3aed')+'44';}}
function refreshLoginUsers(){}
function showLogin(){var u=document.getElementById('login-username'),p=document.getElementById('login-pass'),e=document.getElementById('login-err');if(u)u.value='';if(p)p.value='';if(e)e.style.display='none';var o=document.getElementById('loginOverlay');if(o)o.style.display='flex';}
function hideLogin(){var o=document.getElementById('loginOverlay');if(o)o.style.display='none';}
function doLogin(){var uEl=document.getElementById('login-username'),pEl=document.getElementById('login-pass');if(!uEl||!pEl)return;var un=(uEl.value||'').trim().toLowerCase(),pw=(pEl.value||'');var u=null;for(var i=0;i<D.teamMembers.length;i++){var m=D.teamMembers[i];if(m.active===false)continue;if(effUser(m).toLowerCase()===un&&effPass(m)===pw){u=m;break;}}if(!u){var e=document.getElementById('login-err');if(e)e.style.display='block';pEl.value='';return;}currentUser=u;try{localStorage.setItem('lvmgp_user',u.id);localStorage.setItem('lvmgp_user_cache',JSON.stringify({id:u.id,name:u.name,role:u.role}));}catch(err){}pEl.value='';var er=document.getElementById('login-err');if(er)er.style.display='none';hideLogin();updateHeader();buildNav();updateBadges();setTab((typeof curTab!=='undefined'&&curTab)?curTab:'dashboard');}
function logout(){try{localStorage.removeItem('lvmgp_user');localStorage.removeItem('lvmgp_user_cache');}catch(err){}currentUser=null;showLogin();}
function resolveSession(){var saved=null,cache=null;try{saved=localStorage.getItem('lvmgp_user');cache=JSON.parse(localStorage.getItem('lvmgp_user_cache')||'null');}catch(err){}var u=null;if(saved){for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].id===saved){u=D.teamMembers[i];break;}}if((!u||!u.name)&&cache&&cache.id===saved){u=cache;}if(u){currentUser=u;updateHeader();hideLogin();}else{showLogin();}}

function openM(id){var el=document.getElementById(id);if(el){var b=el.querySelector('.modal,.dbody');if(b)b.style.transform='';el.classList.add('on');}window._modalStack=window._modalStack||[];var _mi=window._modalStack.indexOf(id);if(_mi>=0)window._modalStack.splice(_mi,1);window._modalStack.push(id);if(typeof _navArm==='function')_navArm();}
function closeM(id){var el=document.getElementById(id);if(el)el.classList.remove('on');if(window._modalStack){var _mi=window._modalStack.indexOf(id);if(_mi>=0)window._modalStack.splice(_mi,1);}}
/* ---- Browser Back button wired into in-app navigation ---- */
function _navArm(){try{if(!window._navArmed){history.pushState({lvmgp:1},'');window._navArmed=true;}}catch(e){}}
function appGoBack(){
  if(window._modalStack&&window._modalStack.length){closeM(window._modalStack[window._modalStack.length-1]);return true;}
  var ov=document.querySelectorAll('.overlay.on,.dsheet.on');if(ov.length){ov[ov.length-1].classList.remove('on');return true;}
  if(typeof window!=='undefined'&&window._msgThread&&typeof closeMsgThread==='function'){closeMsgThread();return true;}
  if(typeof pageStack!=='undefined'&&pageStack.length){if(typeof pgPop==='function')pgPop();return true;}
  if(typeof curTab!=='undefined'&&curTab!=='dashboard'){if(typeof setTab==='function')setTab('dashboard');return true;}
  return false;
}
if(typeof window!=='undefined'&&window.addEventListener){window.addEventListener('popstate',function(){var did=false;try{did=appGoBack();}catch(e){}if(did){try{history.pushState({lvmgp:1},'');}catch(e){}}else{window._navArmed=false;}});}

(function(){var drag=null;
function down(e){var h=e.target.closest?e.target.closest('.drag-handle,.mt'):null;if(!h)return;var box=h.closest('.modal,.dbody');if(!box)return;var m=(box.style.transform||'').match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);drag={box:box,sx:e.clientX,sy:e.clientY,ox:m?parseFloat(m[1]):0,oy:m?parseFloat(m[2]):0};document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);e.preventDefault();}
function move(e){if(!drag)return;drag.box.style.transform='translate('+(drag.ox+e.clientX-drag.sx)+'px,'+(drag.oy+e.clientY-drag.sy)+'px)';}
function up(){drag=null;document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('pointerdown',down);
})();

document.addEventListener('click',function(e){if(e.target.classList.contains('dsheet'))e.target.classList.remove('on');});
var curTab='dashboard';

function checkOKBtn(btn){ checkOK(btn.dataset.en, btn.dataset.iid); }

function closeMiniModal(){ closeM('miniModal'); }
function togglePOByName(btn){ togglePO(btn.dataset.po); }

function flagItemBtn(btn){ flagItem(btn.dataset.en2, btn.dataset.iid2, btn.dataset.sev); }

// ── ASSET CRUD ────────────────────────────────────────────────────────────────
var editAssetId = null;





function amCatChanged(sel){
  var ef = document.getElementById('am-engine-fields');
  if(ef) ef.style.display = (sel.value === 'engine') ? '' : 'none';
  if(typeof _amApplyDefaultLife==='function') _amApplyDefaultLife();
}





// ── PHOTO → ASSET SCANNER ─────────────────────────────────────────────────────
var pamImageBase64 = null;
var pamImageMediaType = "image/jpeg";
var pamParsedTagData = {};
var pamParsedAsset = null;



function pamFileSelected(input){
  var file = input.files[0]; if(!file) return;
  // Detect actual media type
  pamImageMediaType = file.type || 'image/jpeg';
  if(pamImageMediaType === 'image/png') pamImageMediaType = 'image/png';
  else if(pamImageMediaType === 'image/webp') pamImageMediaType = 'image/webp';
  else if(pamImageMediaType === 'image/gif') pamImageMediaType = 'image/gif';
  else pamImageMediaType = 'image/jpeg';
  
  var reader = new FileReader();
  reader.onload = function(e){
    var dataUrl = e.target.result;
    pamImageBase64 = dataUrl.split(',')[1];
    document.getElementById('pam-img').src = dataUrl;
    document.getElementById('pam-preview').style.display = '';
    document.getElementById('pam-dropzone').style.display = 'none';
    document.getElementById('pam-scan-btn').style.display = '';
  };
  reader.readAsDataURL(file);
}




function pamShowManualEntry(errMsg){
  document.getElementById('pam-status').style.display = 'none';
  var el = document.getElementById('pam-result');
  el.style.display = '';
  el.innerHTML = 
    '<div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#92400e">' +
    '<b>Auto-scan unavailable</b> — ' + (errMsg||'API not reachable') + '<br>Enter details from the tag manually below, or type/paste the tag text to auto-parse.' +
    '</div>' +
    '<div class="mf" style="margin-bottom:8px">' +
    '<label style="font-size:11px;font-weight:700;color:var(--muted)">Paste or type tag text (auto-parses)</label>' +
    '<textarea id="pam-raw-text" rows="4" placeholder="e.g. MODEL MST-48-N Turbo Air VOLTAGE 115V AMPS 6.5 REFRIGERANT R-290 2.4oz..." ' +
    'style="width:100%;border:1.5px solid var(--border);border-radius:9px;padding:8px 10px;font-size:12px;font-family:inherit;background:var(--bg);resize:vertical" ' +
    'oninput="pamParseRawText(this.value)"></textarea>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
    pamManualField('pam-m-mfr','Manufacturer','e.g. Turbo Air') +
    pamManualField('pam-m-model','Model','e.g. MST-48-N') +
    pamManualField('pam-m-serial','Serial #','S/N') +
    pamManualField('pam-m-voltage','Voltage','e.g. 115V') +
    pamManualField('pam-m-amps','Amps','e.g. 6.5') +
    pamManualField('pam-m-refrig','Refrigerant','e.g. R-290') +
    '</div>' +
    '<div class="mf" style="margin-bottom:6px">' +
    pamManualField('pam-m-name','Product Name','Full descriptive name') +
    '</div>';
  document.getElementById('pam-add-btn').style.display = '';
  document.getElementById('pam-scan-btn').style.display = '';
  document.getElementById('pam-scan-btn').textContent = '🔄 Retry Scan';
}

function pamManualField(id, label, placeholder){
  return '<div class="mf"><label style="font-size:11px;font-weight:700;color:var(--muted)">'+label+'</label>' +
    '<input id="'+id+'" placeholder="'+placeholder+'" style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:7px 10px;font-size:12px;font-family:inherit;background:var(--bg)"/></div>';
}

function pamParseRawText(txt){
  // Smart parse common nameplate patterns
  var t = txt.toUpperCase();
  var get = function(patterns){
    for(var i=0;i<patterns.length;i++){
      var m = txt.match(patterns[i]);
      if(m && m[1]) return m[1].trim();
    }
    return '';
  };
  var mfr    = get([/(?:manufactured by|manufacturer)[:\s]+([^\n,]+)/i, /^([A-Za-z][A-Za-z\s]+)(?:\n|MODEL)/im]);
  var model  = get([/MODEL[:\s]+([^\n\s,]+)/i, /MODEL NO\.?[:\s]+([^\n,]+)/i]);
  var serial = get([/(?:SERIAL|S\/N|SER\.? NO\.?)[:\s]+([^\n,]+)/i]);
  var volts  = get([/(\d+(?:\.\d+)?\s*V[~AC]*(?:\s*\/\s*\d+V)?)/i]);
  var amps   = get([/AMPS?[:\s]+(\d+(?:\.\d+)?)/i, /(\d+(?:\.\d+)?)\s*A(?:MPS?)?/i]);
  var refrig = get([/(?:REFRIGERANT|REF\.?)[:\s]+([R\-]\d+[^\n,]*)/i, /(R-\d+(?:[A-Z])?)/i]);
  
  if(mfr)    setV('pam-m-mfr', mfr);
  if(model)  setV('pam-m-model', model);
  if(serial) setV('pam-m-serial', serial);
  if(volts)  setV('pam-m-voltage', volts);
  if(amps)   setV('pam-m-amps', amps);
  if(refrig) setV('pam-m-refrig', refrig);
  if(mfr && model) setV('pam-m-name', mfr + ' ' + model);
}

function setV(id, val){ var el=document.getElementById(id); if(el&&val) el.value=val; }


function pamShowResult(asset, rawTag){
  document.getElementById('pam-status').style.display = 'none';
  var el = document.getElementById('pam-result');
  el.style.display = '';
  
  var fields = [
    ['Name', asset.name],
    ['Manufacturer', asset.manufacturer],
    ['Model', asset.model],
    ['Category', asset.category],
    ['Serial #', rawTag.serial || asset.serial],
    ['Description', asset.description],
    ['Dimensions', asset.dimensions],
    ['Weight', asset.weight],
    ['Capacity', asset.capacity],
    ['Voltage', rawTag.voltage || asset.voltage],
    ['Amps', rawTag.amps || asset.amps],
    ['Refrigerant', rawTag.refrigerant || asset.refrigerant],
    ['Notes', asset.notes]
  ];

  var h = '<div style="background:var(--bg);border-radius:12px;padding:12px;margin-bottom:10px">';
  h += '<div style="font-size:11px;font-weight:800;color:#22c55e;text-transform:uppercase;margin-bottom:8px">✓ Tag Read Successfully</div>';
  for(var i=0; i<fields.length; i++){
    if(!fields[i][1]) continue;
    h += '<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">';
    h += '<span style="font-weight:700;min-width:90px;color:var(--muted)">'+fields[i][0]+'</span>';
    h += '<span>'+esc(String(fields[i][1]))+'</span></div>';
  }
  h += '</div>';
  el.innerHTML = h;
  document.getElementById('pam-add-btn').style.display = '';
}




// ── PART REQUEST SYSTEM ───────────────────────────────────────────────────────
var partReqItems = [];
var partAdjPid = null;



function preqSearch(){
  var q = document.getElementById('preq-search').value.toLowerCase().trim();
  var el = document.getElementById('preq-results');
  if(!q){ el.innerHTML=''; return; }
  var matches = D.parts.filter(function(p){
    return (p.name+' '+(p.partNumber||'')).toLowerCase().indexOf(q)>=0;
  }).slice(0,10);
  if(!matches.length){ el.innerHTML='<div style="padding:8px 10px;font-size:12px;color:var(--muted)">No parts found</div>'; return; }
  el.innerHTML = matches.map(function(p){
    var already = partReqItems.some(function(r){return r.pid===p.id;});
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-bottom:1px solid var(--border)">'+
      '<div><div style="font-size:12px;font-weight:700">'+esc(p.name)+'</div>'+
      '<div style="font-size:10px;color:var(--muted)">Stock: '+p.qty+((typeof partReservedQty==='function'&&partReservedQty(p)>0)?' ('+partAvailableQty(p)+' avail)':'')+' \u00b7 PN: '+(p.partNumber||'\u2014')+'</div></div>'+
      '<button onclick="preqAddPart(\''+p.id+'\')" style="background:'+(already?'#e5e7eb':'var(--accent)')+';border:none;color:'+(already?'var(--muted)':'#fff')+';border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">'+(already?'Added':'+ Add')+'</button>'+
      '</div>';
  }).join('');
}



function preqAddCustom(){
  var name = document.getElementById('preq-custom-name').value.trim(); if(!name) return;
  partReqItems.push({pid:'custom-'+Date.now(),name:name,partNumber:'',inStock:null,reserved:0,requesting:1,cost:0,custom:true,note:''});
  document.getElementById('preq-custom-name').value=''; renderPartReqList();
}

function preqAddFromList(pid){ preqAddPart(pid); openPartReqModal(); }



function preqRemove(i){partReqItems.splice(i,1);renderPartReqList();}
function preqAdj(i,d){partReqItems[i].requesting=Math.max(1,partReqItems[i].requesting+d);renderPartReqList();}
function preqNote(input){partReqItems[parseInt(input.dataset.ri)].note=input.value;}





function submitAdjRequest(){
  var actual=parseInt(document.getElementById('padj-actual').value);
  var reason=document.getElementById('padj-reason').value.trim();
  if(isNaN(actual)||actual<0){alert('Enter a valid quantity.');return;}
  if(!reason){alert('Reason is required.');return;}
  var p=D.parts.filter(function(x){return x.id===partAdjPid;})[0];if(!p)return;
  if(!D.adjustRequests)D.adjustRequests=[];
  D.adjustRequests.push({id:nid('ADJ'),pid:partAdjPid,partName:p.name,systemQty:p.qty,actualQty:actual,diff:actual-p.qty,reason:reason,requestedBy:currentUser.name,created:today(),ts:(typeof woNow==='function'?woNow():today()),status:'pending'});
  closeM('partAdjModal');
  dbSave('adjust_requests',D.adjustRequests[D.adjustRequests.length-1]);alert('Adjustment request submitted \u2014 a manager can approve it in the Order List.');if(typeof renderParts!=='undefined')renderParts();if(typeof updateBadges!=='undefined')updateBadges();
}


// ── WO BUILDER ────────────────────────────────────────────────────────────────
var wobMode = 'know';
var wobAssetId = null;
var wobSelectedIssue = null;

var WO_COMMON_ISSUES = [
  {label:'Oil Change',           swo:'oil-change',      priority:'medium', type:'pm',        icon:'🛢'},
  {label:'Spark Plug Replace',   swo:'spark-plug',      priority:'medium', type:'pm',        icon:'⚡'},
  {label:'Air Filter Service',   swo:'air-filter',      priority:'medium', type:'pm',        icon:'💨'},
  {label:'Brake Adjustment',     swo:'brake-adjust',    priority:'high',   type:'corrective', icon:'🔴'},
  {label:'Brake Pad Replace',    swo:'brake-pads',      priority:'high',   type:'corrective', icon:'🔴'},
  {label:'Brake Bleed',          swo:'brake-bleed',     priority:'high',   type:'corrective', icon:'🔴'},
  {label:'Tire Pressure',        swo:'tire-pressure',   priority:'low',    type:'pm',        icon:'🔵'},
  {label:'Tire Replace',         swo:'tire-replace',    priority:'medium', type:'corrective', icon:'🔵'},
  {label:'Drive Belt Replace',   swo:'belt-replace',    priority:'high',   type:'corrective', icon:'⚙️'},
  {label:'Throttle Adjust',      swo:'throttle-adjust', priority:'medium', type:'corrective', icon:'⚙️'},
  {label:'Carburetor Rebuild',   swo:'carb-rebuild',    priority:'high',   type:'corrective', icon:'⚙️'},
  {label:'Ignition Coil',        swo:'ignition-coil',   priority:'high',   type:'corrective', icon:'⚡'},
  {label:'Wheel Bearings',       swo:'wheel-bearings',  priority:'medium', type:'corrective', icon:'🔧'},
  {label:'Governor Adjust',      swo:'governor-adjust', priority:'medium', type:'corrective', icon:'⚙️'},
  {label:'Spindle Lube',         swo:'spindle-lube',    priority:'low',    type:'pm',        icon:'🔧'},
  {label:'Spindle Replace',      swo:'spindle-replace', priority:'critical',type:'corrective',icon:'🚨'},
  {label:'Engine Rebuild',       swo:'engine-rebuild',  priority:'high',   type:'corrective', icon:'🔩'},
  {label:'Custom Issue',         swo:null,              priority:'medium', type:'corrective', icon:'✏️'}
];

var WO_PM_SCHEDULES = [
  {label:'50hr Oil Change',        swo:'oil-change',     freq:'50hr'},
  {label:'100hr Spark Plug',       swo:'spark-plug',     freq:'100hr'},
  {label:'Break-In Service (new/rebuilt engine)', swo:'oil-change', freq:'once \u2014 first 20 hrs'},
  {label:'Monthly Spindle Lube',   swo:'spindle-lube',   freq:'monthly'},
  {label:'Weekly Alignment Check', swo:'alignment',      freq:'weekly'},
  {label:'Annual Full Inspection', swo:null,             freq:'annual'}
];




function renderRptLegal(el){
  var h = rptHeader("Legal / Incident Package","Full kart history for a date range — inspections, WOs, incidents");

  // Controls
  h += rptDatePicker("legal-from","legal-to","","");
  // Track + kart
  var tracks=["euro","road","sprint","kiddie"];
  var TN2={euro:"Euro Track",road:"Road Track",sprint:"Sprint Track",kiddie:"Kiddie Track"};
  h += '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">';
  h += '<select id="legal-track" onchange="renderReports()" style="flex:1;border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit">';
  for(var ti=0;ti<tracks.length;ti++) h += '<option value="'+tracks[ti]+'"'+(rptTrack===tracks[ti]?" selected":"")+'>'+TN2[tracks[ti]]+'</option>';
  h += '</select>';
  h += '<select id="legal-kart" style="flex:1;border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit">';
  h += '<option value="">All Karts</option>';
  var ltrack=document.getElementById("legal-track")?document.getElementById("legal-track").value:rptTrack;
  var lkarts=D.karts[ltrack]||[];
  for(var ki=0;ki<lkarts.length;ki++) h += '<option value="'+lkarts[ki].id+'"'+(rptKartId===lkarts[ki].id?" selected":"")+'>Kart #'+lkarts[ki].num+'</option>';
  h += '</select></div>';
  h += '<button onclick="generateLegalReport()" style="width:100%;background:#ef4444;border:none;color:#fff;border-radius:10px;padding:12px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;margin-bottom:14px">Generate Legal Package</button>';
  h += '<div id="legal-output"></div>';
  el.innerHTML = h;
}



function renderRptDaily(el){
  var h = rptHeader("Daily Operations Summary","Everything that happened on a specific date");
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:14px">';
  h += '<div style="flex:1"><label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Date</label>';
  h += '<input type="date" id="daily-date" value="'+today()+'" style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;margin-top:3px"/></div>';
  h += '<button onclick="generateDailyReport()" style="background:var(--accent);border:none;color:#fff;border-radius:10px;padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Generate</button></div>';
  h += '<div id="daily-output"></div>';
  el.innerHTML = h;
}



function renderRptDeficiency(el){
  var h=rptHeader("Deficiency Trend Report","Most flagged items and karts over time");
  h+=rptDatePicker("def-from","def-to","","");
  h+='<button onclick="generateDeficiencyReport()" style="width:100%;background:var(--warn);border:none;color:#fff;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:14px">Generate</button>';
  h+='<div id="def-output"></div>';
  el.innerHTML=h;
}







function renderRptMechanic(el){
  var h=rptHeader("Mechanic Productivity","WOs closed, response times, inspection completion");
  h+=rptDatePicker("mech-from","mech-to","","");
  h+='<button onclick="generateMechanicReport()" style="width:100%;background:#a855f7;border:none;color:#fff;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:14px">Generate</button>';
  h+='<div id="mech-output"></div>';
  el.innerHTML=h;
}











function setRptView(v){ rptView=v; renderReports(); }

function renderRptHome(el){
  var h = '<div style="padding-bottom:20px">';
  h += '<div style="font-size:18px;font-weight:900;margin-bottom:4px">Reports</div>';
  h += '<div style="font-size:12px;color:var(--muted);margin-bottom:16px">Select a report to generate</div>';

  // Only the reports we've built are listed. The rest are kept (commented)
  // and can be switched back on as we build/verify each one.
  var reports = [
    {v:"maint",        icon:"\u2696\ufe0f", title:"Kart Maintenance Record", desc:"Complete, unabridged maintenance history for one kart over a date range \u2014 work orders, parts installed, labor, personnel, and inspection exceptions. For insurance, regulators, and counsel.", color:"#7f1d1d"},
    {v:"cert",         icon:"\ud83d\udee1\ufe0f", title:"Daily Inspection Certification", desc:"Certified record of every kart placed in service on a given day and each checklist item inspected. For insurance and legal use. Print to PDF.", color:"#1e1b4b"},
    {v:"no-parts",     icon:"\ud83e\uddfe", title:"Completed WOs Without Parts", desc:"Completed work orders in a date range with no parts logged. Print to PDF, export to Excel, or tap any row to open the work order.", color:"#14b8a6"},
    {v:"neg-bal",       icon:"\u26a0\ufe0f", title:"Inventory \u2014 Negative Balance", desc:"Parts whose stock count has dropped below zero \u2014 likely missed receipts or miscounts.", color:"#ef4444"},
    {v:"onhand-value",  icon:"\ud83d\udcb0", title:"Inventory \u2014 On-Hand Value", desc:"Every part with stock on hand, its unit cost and total value, with a grand total.", color:"#22c55e"},
    {v:"reserved-short",icon:"\ud83d\udd12", title:"Reserved Parts \u2014 Short Stock", desc:"Parts reserved by open work orders that have zero or negative stock available.", color:"#f59e0b"},
    {v:"mechanic",      icon:"\ud83d\udc77", title:"Mechanic Productivity", desc:"WOs closed per mechanic, average close time, inspection completion. Pick a date range.", color:"#a855f7"},
  ];
  /* Not yet wired into the menu:
    {v:"kart-history", icon:"\ud83c\udfce", title:"Kart Inspection History", desc:"All inspection records for a specific kart. Status, findings, signatures.", color:"#6366f1"},
    {v:"legal",        icon:"⚖️", title:"Legal / Incident Package", desc:"Full kart history + maintenance record for a date range. For attorneys, insurance, state inspectors.", color:"#ef4444"},
    {v:"daily",        icon:"\ud83d\udcc5", title:"Daily Operations Summary", desc:"Everything that happened on a specific date — inspections, WOs opened, karts OOS.", color:"#0891b2"},
    {v:"deficiency",   icon:"⚠️", title:"Deficiency Trend Report", desc:"Most flagged checklist items, most problematic karts, patterns over time.", color:"#f59e0b"},
    {v:"parts",        icon:"\ud83d\udd29", title:"Parts Usage & Cost", desc:"Parts consumed by kart, track, or time period. Spend by category.", color:"#22c55e"},
    {v:"mechanic",     icon:"\ud83d\udc77", title:"Mechanic Productivity", desc:"WOs closed per mechanic, avg close time, inspection completion rate.", color:"#a855f7"},
    {v:"fleet",        icon:"\ud83d\udcca", title:"Fleet Trend Report", desc:"Kart-by-kart health over time, hours accumulation, service intervals met vs missed.", color:"#f97316"},
    {v:"engine",       icon:"⚙️", title:"Engine Lifecycle Report", desc:"Rebuild history, cost per engine over lifetime, hours between rebuilds.", color:"#64748b"},
  */

  for(var i=0;i<reports.length;i++){
    var r=reports[i];
    h += '<div data-view="'+r.v+'" onclick="setRptView(this.dataset.view)" style="background:var(--card);border-radius:14px;padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:4px solid '+r.color+';cursor:pointer;display:flex;align-items:center;gap:12px">';
    h += '<div style="font-size:28px;flex-shrink:0">'+r.icon+'</div>';
    h += '<div><div style="font-size:15px;font-weight:800">'+r.title+'</div>';
    h += '<div style="font-size:12px;color:var(--muted);margin-top:2px">'+r.desc+'</div></div>';
    h += '<div style="margin-left:auto;font-size:20px;color:var(--muted)">›</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function rptHeader(title, subtitle){
  return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">'
    +'<button onclick="setRptView(\'home\')" style="background:var(--bg);border:1.5px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">← Reports</button>'
    +'<div><div style="font-size:16px;font-weight:900">'+esc(title)+'</div>'
    +(subtitle?'<div style="font-size:11px;color:var(--muted)">'+esc(subtitle)+'</div>':'')
    +'</div></div>';
}

function rptDatePicker(fromId, toId, fromVal, toVal){
  return '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">'
    +'<div style="flex:1;min-width:130px"><label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">From</label>'
    +'<input type="date" id="'+fromId+'" value="'+(fromVal||addD(today(),-30))+'" style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;margin-top:2px"/></div>'
    +'<div style="flex:1;min-width:130px"><label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">To</label>'
    +'<input type="date" id="'+toId+'" value="'+(toVal||today())+'" style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;margin-top:2px"/></div>'
    +'</div>';
}

function rptStat(label, value, color, sub){
  return '<div style="background:var(--bg);border-radius:10px;padding:10px 12px;text-align:center">'
    +'<div style="font-size:22px;font-weight:900;color:'+(color||"var(--text)")+'">'+esc(String(value))+'</div>'
    +'<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-top:1px">'+esc(label)+'</div>'
    +(sub?'<div style="font-size:10px;color:var(--muted);margin-top:1px">'+esc(sub)+'</div>':'')
    +'</div>';
}

function rptSection(title){
  return '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px;padding-top:10px;border-top:1px solid var(--border)">'+esc(title)+'</div>';
}



function setRptTrack(t){ rptTrack=t; rptKartId=null; renderReports(); }




function openWODBtn(btn){ openWOD(btn.dataset.wid); }
function openIncDBtn(btn){ openIncD(btn.dataset.incid); }
function resolveIncBtn(btn){ resolveInc(btn.dataset.incid); }
function toggleArcOOSBtn(btn){ toggleArcOOS(btn.dataset.mid); }
function setPCBtn(btn){ setPC(btn.dataset.pc); }
function openSupMBtn(btn){ openSupM(btn.dataset.sid); }

function resetPOBtn(btn){ resetPO(btn.dataset.po); }

function updWOBtn(btn){ updWO(btn.dataset.wid, btn.dataset.ws); }
function addNoteBtn(btn){ addNote(btn.dataset.wid); }

function adjPBtn(btn){ adjP(btn.dataset.pid, parseInt(btn.dataset.adj)); }
function adjPBtn2(btn){ adjP(btn.dataset.pid, 1); }
function openPushMBtn(btn){ openPushM(btn.dataset.wid); }

function supReassignBtn(btn){ supReassign(btn.dataset.mech); }
function closeSupOpenPush(btn){ closeM('supModal'); openPushM(btn.dataset.wid); }


function closeDetailOpenWO(pf){ closeM("detailSheet"); openWOForm(pf); }
function closeDetailSheet(){ closeM("detailSheet"); }
function closeWOModal(){ closeM("woModal"); }
function closeDrillSheet(){ closeM("drillSheet"); }
function closeSupModal(){ closeM("supModal"); }
function openWOModal(){ openM("woModal"); }








function dstartSHBtn(event,el){ dstartSH(event, el.dataset.sid2); }

function alertUpload(){ alert("Upload feature coming soon"); }
function setTabBtn(btn){ setTab(btn.dataset.tab); }

// Per-user tab order. ROLE_TABS still defines what a role may SEE (access);
// this only changes ORDER. Dashboard is always pinned first, and any tab not yet
// in the saved order (new tabs, role changes) appends at the end so nothing breaks.
function navOrder(){
  var allowed=ROLE_TABS[currentUser.role]||ROLE_TABS.owner;
  var inAllowed={}; for(var i=0;i<allowed.length;i++)inAllowed[allowed[i]]=true;
  var saved=(currentUser&&currentUser.tabOrder)||[];
  var out=[],seen={};
  if(inAllowed['dashboard']){out.push('dashboard');seen['dashboard']=true;}
  for(var i=0;i<saved.length;i++){var t=saved[i];if(inAllowed[t]&&!seen[t]){out.push(t);seen[t]=true;}}
  for(var i=0;i<allowed.length;i++){var t=allowed[i];if(!seen[t]){out.push(t);seen[t]=true;}}
  return out;
}
function openCustomizeTabs(){
  window._tabEdit=navOrder().filter(function(t){return t!=='dashboard';});
  renderTabEditList();
  openM('customizeTabsModal');
}
function renderTabEditList(){
  var el=document.getElementById('tabedit-list'); if(!el)return;
  var a=window._tabEdit||[]; var h='';
  for(var i=0;i<a.length;i++){ var t=a[i]; var first=(i===0), last=(i===a.length-1);
    h+='<div style="display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:6px">'+
      '<div style="flex:1;font-size:13px;font-weight:700;min-width:0">'+esc(TAB_LABELS[t]||t)+'</div>'+
      '<button onclick="tabMove('+i+',-1)"'+(first?' disabled':'')+' style="width:32px;height:32px;border-radius:7px;border:1px solid var(--border);background:var(--bg);cursor:'+(first?'default':'pointer')+';font-size:12px;color:'+(first?'#cbd5e1':'var(--accent)')+';font-family:inherit">&#9650;</button>'+
      '<button onclick="tabMove('+i+',1)"'+(last?' disabled':'')+' style="width:32px;height:32px;border-radius:7px;border:1px solid var(--border);background:var(--bg);cursor:'+(last?'default':'pointer')+';font-size:12px;color:'+(last?'#cbd5e1':'var(--accent)')+';font-family:inherit">&#9660;</button>'+
      '</div>';
  }
  el.innerHTML=h;
}
function tabMove(i,dir){
  var a=window._tabEdit||[]; var j=i+dir;
  if(j<0||j>=a.length)return;
  var tmp=a[i];a[i]=a[j];a[j]=tmp;
  renderTabEditList();
}
function saveTabOrder(){
  var a=window._tabEdit||[];
  var hasDash=((ROLE_TABS[currentUser.role]||ROLE_TABS.owner).indexOf('dashboard')>=0);
  currentUser.tabOrder=(hasDash?['dashboard']:[]).concat(a);
  if(typeof dbSave!=='undefined')dbSave('team_members',currentUser);
  closeM('customizeTabsModal');
  buildNav();
  setTab((typeof curTab!=='undefined'&&curTab)?curTab:'dashboard');
  if(typeof updateBadges==='function')updateBadges();
}
function buildNav(){
  var tabs=navOrder();
  var app=document.getElementById('appBody');
  var h='';for(var i=0;i<tabs.length;i++)h+='<div class="panel" id="tab-'+tabs[i]+'"></div>';
  h+='<div class="panel" id="tab-page"><div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--card);flex-shrink:0"><button onclick="pgPop()" style="background:none;border:none;font-size:15px;font-weight:700;color:var(--accent);cursor:pointer;font-family:inherit">\u2039 Back</button><span id="apage-title" style="font-size:15px;font-weight:800;flex:1;text-align:center"></span><span style="width:48px"></span></div><div class="scroll"><div id="apage-body" style="padding:14px;max-width:900px;margin:0 auto"></div></div></div>';
  app.innerHTML=h;
  var nh='';for(var i=0;i<tabs.length;i++){
    var badgeHtml='';
    if(tabs[i]==='inspections'){badgeHtml='<span class="tbadge-w" id="inspBadge" style="display:none">0</span>';}
    if(tabs[i]==='workorders'){badgeHtml='<span class="tbadge-w" id="woBadge" style="display:none">0</span>';}
    nh+='<button class="ntab" id="ntab-'+tabs[i]+'" data-tab="'+tabs[i]+'" onclick="setTabBtn(this)">'+esc(TAB_LABELS[tabs[i]])+badgeHtml+'</button>';
  }
  document.getElementById('navTabs').innerHTML=nh;
}
function setTab(t){
  if(t!=='dashboard'&&typeof _navArm==='function')_navArm();
  if(typeof pageStack!=='undefined')pageStack=[];
  refreshTeam();
  var panels=document.querySelectorAll('.panel');for(var i=0;i<panels.length;i++)panels[i].classList.remove('on');
  var btns=document.querySelectorAll('.ntab');for(var i=0;i<btns.length;i++)btns[i].classList.remove('on');
  var panel=document.getElementById('tab-'+t);
  var ntab=document.getElementById('ntab-'+t);
  if(!panel||!ntab){ var _fb=ROLE_TABS[currentUser.role]||ROLE_TABS.owner; if(_fb&&_fb.length){ t=_fb[0]; panel=document.getElementById('tab-'+t); ntab=document.getElementById('ntab-'+t); } }
  if(!panel||!ntab)return;
  panel.classList.add('on');ntab.classList.add('on');curTab=t;
  document.getElementById('fab').style.display=['schedule','messages'].indexOf(t)>=0?'none':'flex';
  var r={dashboard:renderDash,followups:function(){if(typeof renderFollowups==='function')renderFollowups();},messages:renderMessages,inspections:renderInspections,fleet:renderFleet,facility:renderFacility,reports:renderReports,rides:renderRides,workorders:renderWOs,schedule:function(){checkRollovers();renderSched();},vendors:renderVendors,compliance:renderCompliance,incidents:renderIncidents,arcade:renderArcade,parts:renderParts,handoff:renderHandoff,team:renderTeam,templates:function(){if(typeof renderTemplates==='function')renderTemplates();},manuals:function(){if(typeof renderManuals==='function')renderManuals();}};
  if(r[t])r[t]();
  updateBadges();
}
function fabAction(){
  var m={workorders:'_wobuild',vendors:'vendorModal',arcade:'arcadeModal',parts:'partModal',rides:'_addAsset',facility:'_addAsset',incidents:'incidentModal',compliance:'compModal',handoff:'handoffModal'};
  var dest=m[curTab];
  if(dest==='_wobuild'){openWOChooser({});}
  else if(dest==='_addAsset'){openAddAsset();}
  else if(dest){openM(dest);}
  else{openWOChooser({});}
}
function updateBadges(){
  var myPO=getMyPreops(),pp=0;for(var i=0;i<myPO.length;i++)if(!D.preopState[myPO[i]]||!D.preopState[myPO[i]].completed)pp++;
  setBadge('ntab-preops',pp,'w');
  var fl=0;for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].flagged)fl++;
  setBadge('ntab-schedule',fl,'r');
  var vn=0;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].status==='needs-scheduling')vn++;
  setBadge('ntab-vendors',vn,'b');
  var ksp=0,ak=allKarts();for(var i=0;i<ak.length;i++)if(ak[i].status==='pending-signoff')ksp++;
  setBadge('ntab-fleet',ksp,'w');
  setBadge('ntab-messages',msgUnreadCount(),'r');
}
function setBadge(tabId,count,type){
  var el=document.getElementById(tabId);if(!el)return;
  var old=el.querySelector('.tbadge');if(old)old.parentNode.removeChild(old);
  if(count>0){var b=document.createElement('span');b.className='tbadge tbadge-'+type;b.textContent=count;el.appendChild(b);}
}

// ── Dashboard helpers ───────────────────────────────────────────────────────
// A work order is "scheduled" (not reactive) if it's a recurring PM or a booked
// inspection. Everything else open/in-progress is reactive — regardless of which
// legacy type string it carries (corrective / reactive / etc.).
function _dashScheduledWO(w){
  if(!w) return false;
  if(w.recurring===true || w.pmSchedId) return true;
  var t=(w.type||'');
  return t==='preventive'||t==='pm'||t==='oil-change'||t==='full-service'||t==='state-inspection';
}
// Ride PMs due/overdue, read from the same engine the Recurring tab uses.
function _dashRidePMsDue(){
  if(!(window.LVMGP_PM && typeof LVMGP_PM.schedules==='function' && typeof LVMGP_PM._due==='function')) return 0;
  var rideIds={}; (D.assets||[]).forEach(function(a){ if(a && a.category==='ride') rideIds[a.id]=1; });
  var n=0;
  try{
    var sc=LVMGP_PM.schedules();
    for(var i=0;i<sc.length;i++){ var s=sc[i]; if(s.kart || !rideIds[s.assetId]) continue;
      try{ var st=LVMGP_PM._due(s); if(st && (st.overdue || st.due)) n++; }catch(e){}
    }
  }catch(e){}
  return n;
}
// Critical building equipment: explicit `critical` flag wins; until those are set,
// fall back to a name heuristic over facility / food-service systems.
function _dashIsCritical(a){
  if(!a) return false;
  if(a.critical===true) return true;
  if(a.critical===false) return false;
  if(a.category!=='facility' && a.category!=='food-service') return false;
  var n=((a.name||'')+' '+(a.model||'')+' '+(a.manufacturer||'')).toLowerCase();
  return /(a\/c|hvac|\brtu\b|air cond|cooler|walk|\bice\b|compressor|\boven\b|refriger|chiller|gate|boiler|\bpump\b|fire)/.test(n);
}
// Spare-engine condition: explicit `condition` wins; else derive from existing fields.
function _dashEngCond(e){
  var c=(e&&e.condition)||'';
  if(c==='new'||c==='rebuilt'||c==='rebuild-in-progress'||c==='needs-rebuild') return c;
  if(!e) return 'new';
  if(e.rebuildInProgress || e.rebuildScheduled || e.status==='rebuilding' || e.status==='rebuild-in-progress') return 'rebuild-in-progress';
  if(e.needsRebuild || e.status==='needs-rebuild') return 'needs-rebuild';
  if(e.status==='rebuilt' || (Number(e.rebuildCount)||0)>0) return 'rebuilt';
  return 'new';
}

function renderDash(){
  var el=document.getElementById('tab-dashboard'); if(!el) return;
  try{
    var allK=allKarts(), totalK=allK.length;
    var kOOS=0,kPend=0,kSvc=0;
    for(var i=0;i<allK.length;i++){ var s=kartStatus(allK[i]); if(s.cls==='k-oos')kOOS++; else if(s.cls==='k-svc')kSvc++; if(allK[i].status==='pending-signoff')kPend++; }
    var readyK=totalK-kOOS;

    var reactiveOpen=0,nsWOs=0;
    for(var i=0;i<D.workOrders.length;i++){ var w=D.workOrders[i];
      if((w.status==='open'||w.status==='in-progress') && !_dashScheduledWO(w)) reactiveOpen++;
      if(w.status==='needs-scheduling') nsWOs++;
    }

    var pmsDue=kSvc + _dashRidePMsDue();

    var rides=(D.assets||[]).filter(function(a){return a.category==='ride';});
    var ridesDown=rides.filter(function(a){return a.status!=='operational';});

    var _pp=(typeof preopProgress==='function')?preopProgress((currentUser&&currentUser.role)||null):null;
    var pDone, pTotal;
    if(_pp){ pDone=_pp.done; pTotal=_pp.total; }
    else { var myPO=getMyPreops?getMyPreops():[]; pDone=0; for(var i=0;i<myPO.length;i++){ var st=D.preopState&&D.preopState[myPO[i]]; if(st&&st.completed)pDone++; } pTotal=myPO.length; }

    // ── Pre-op sign-off banner (managers only) ──
    var _pmInsp=(D.inspections||[]).filter(function(x){return x.status==='pending-manager';});
    var _pmBanner='';
    if(_pmInsp.length && canApproveInspection()){
      _pmBanner='<div style="margin:12px 14px 0;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:12px;padding:12px 14px"><div style="font-size:13px;font-weight:800;color:#991b1b;margin-bottom:6px">⚠ '+_pmInsp.length+' pre-op'+(_pmInsp.length>1?'s':'')+' awaiting your sign-off</div>';
      for(var _pi=0;_pi<_pmInsp.length;_pi++){var _ip=_pmInsp[_pi];_pmBanner+='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #fecaca"><div style="min-width:0"><div style="font-size:12px;font-weight:700">'+esc(_ip.title||_ip.templateKey)+'</div><div style="font-size:10px;color:#b91c1c">Inspected by '+esc(_ip.completedBy||'?')+' · '+esc(fmt(_ip.date))+'</div></div><button onclick="openInspSheet(\''+_ip.id+'\')" style="background:#dc2626;border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0;white-space:nowrap">Review &amp; Approve</button></div>';}
      _pmBanner+='</div>';
    }

    // Status hero: "Action needed" only when something needs a person today --
    // pre-ops to do, sign-offs to approve, or a ride down. Routine OOS karts are
    // shown in the counts and fleet card, not treated as an alert. Tappable ->
    // the most relevant tab.
    var preopsLeft=Math.max(0,pTotal-pDone);
    var signOff=kPend+(_pmInsp?_pmInsp.length:0);
    var attn=(preopsLeft>0)||(signOff>0)||(ridesDown.length>0);
    var urgent=(ridesDown.length>0)||(signOff>0);
    var heroBg=!attn?'#f0fdf4':(urgent?'#fef2f2':'#fffbeb');
    var heroBd=!attn?'#86efac':(urgent?'#fca5a5':'#fcd34d');
    var heroCol=!attn?'#166534':(urgent?'#991b1b':'#92400e');
    var heroTab=(preopsLeft>0||signOff>0)?'inspections':(ridesDown.length>0?'rides':'fleet');
    var heroIcon=attn?'⚠':'✓';
    var heroTitle=attn?'Action needed':'Good to run';
    var heroSummary;
    if(attn){ var dparts=[];
      if(preopsLeft>0) dparts.push(preopsLeft+' pre-op'+(preopsLeft>1?'s':'')+' to do');
      if(signOff>0) dparts.push(signOff+' awaiting sign-off');
      if(ridesDown.length>0) dparts.push(ridesDown.map(function(a){return esc(a.name);}).join(', ')+' down');
      heroSummary=dparts.join(' · ');
    } else {
      heroSummary=readyK+' of '+totalK+' karts ready · all rides up · pre-ops complete';
    }
    var hero='<div onclick="setTab(\''+heroTab+'\')" style="margin:12px 14px 0;background:'+heroBg+';border:1.5px solid '+heroBd+';border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:center;cursor:pointer">'+
      '<div style="font-size:18px;line-height:1.1;color:'+heroCol+'">'+heroIcon+'</div>'+
      '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800;color:'+heroCol+'">'+heroTitle+'</div>'+
      '<div style="font-size:12px;color:#374151;margin-top:2px;line-height:1.4">'+heroSummary+'</div></div>'+
      '<div style="font-size:20px;color:'+heroCol+';opacity:.5;flex-shrink:0">›</div></div>';

    // ── Action tiles ──
    function tile(val,label,col,onclick){
      return '<div onclick="'+onclick+'" style="background:var(--card);border-radius:10px;padding:12px 10px;text-align:center;cursor:pointer;border-top:3px solid '+col+'">'+
        '<div style="font-size:22px;font-weight:900;font-family:monospace;color:'+col+'">'+val+'</div>'+
        '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-top:3px;line-height:1.2">'+label+'</div></div>';
    }
    var preopCol=(pTotal>0&&pDone<pTotal)?'#f59e0b':'#22c55e';
    var actionGrid='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 14px 0">'+
      tile(pDone+'/'+pTotal,'Pre-Ops',preopCol,"setTab('inspections')")+
      tile(kPend,'Awaiting Sign-Off',kPend>0?'#ef4444':'#22c55e',"setTab('fleet')")+
      tile(reactiveOpen,'Reactive WOs',reactiveOpen>0?'#f59e0b':'#22c55e',"setTab('workorders')")+
      tile(pmsDue,'Fleet & Ride PMs Due',pmsDue>0?'#f59e0b':'#22c55e',"setTab('workorders')")+
      '</div>';
    var vendorLine=nsWOs>0?'<div onclick="setTab(\'schedule\')" style="margin:8px 14px 0;font-size:12px;color:#0891b2;font-weight:700;cursor:pointer">'+nsWOs+' work order'+(nsWOs>1?'s':'')+' need vendor scheduling ›</div>':'';

    // ── Regulatory & compliance ──
    var compUp=(D.compliance||[]).filter(function(c){return du(c.nextDue)<=90;}).sort(function(a,b){return new Date(a.nextDue)-new Date(b.nextDue);});
    var compToSched=0; for(var i=0;i<compUp.length;i++){ if(!compUp[i].bookedFor) compToSched++; }
    var compRows='';
    if(compUp.length){
      var topC=compUp.slice(0,4);
      for(var i=0;i<topC.length;i++){ var c=topC[i]; var d=du(c.nextDue);
        var dc=d<=30?'#ef4444':d<=60?'#f59e0b':'#94a3b8';
        var sub=c.bookedFor?('booked '+fmtS(c.bookedFor)):'needs scheduling';
        var subCol=c.bookedFor?'#16a34a':'#ef4444';
        compRows+='<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);gap:8px">'+
          '<div style="min-width:0"><div style="font-size:13px;font-weight:700">'+esc(c.title)+'</div>'+
          '<div style="font-size:11px;color:'+subCol+'">'+sub+'</div></div>'+
          '<div style="font-size:12px;font-weight:700;color:'+dc+';flex-shrink:0;white-space:nowrap">due '+fmtS(c.nextDue)+'</div></div>';
      }
    } else { compRows='<div style="font-size:12px;color:var(--muted);padding:8px 0">Nothing due within 90 days</div>'; }
    var compSchedPill=compToSched>0
      ?'<span style="font-size:11px;background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:8px;font-weight:700">'+compToSched+' to schedule</span>'
      :'<span style="font-size:11px;background:#dcfce7;color:#166534;padding:3px 10px;border-radius:8px;font-weight:700">all booked</span>';
    var compCard='<div class="card"><div onclick="setTab(\'compliance\')" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:pointer"><div style="font-size:13px;font-weight:800">🛡 Regulatory & Compliance</div>'+compSchedPill+'</div>'+compRows+'</div>';

    // ── Fleet & rides ──
    var tracks=['euro','road','sprint','kiddie'];
    var TN={euro:'Euro',road:'Road',sprint:'Sprint',kiddie:'Kiddie'};
    var fleetRows='';
    for(var ti=0;ti<tracks.length;ti++){ var tk=tracks[ti]; var kk=D.karts[tk]||[];
      var tOOS=0,tSvc=0,tPend=0;
      for(var j=0;j<kk.length;j++){ var s2=kartStatus(kk[j]); if(s2.cls==='k-oos')tOOS++; else if(s2.cls==='k-svc')tSvc++; if(kk[j].status==='pending-signoff')tPend++; }
      var tReady=kk.length-tOOS;
      fleetRows+='<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">'+
        '<div><div style="font-size:13px;font-weight:700">'+TN[tk]+'</div><div style="font-size:11px;color:var(--muted)">'+kk.length+' karts</div></div>'+
        '<div style="display:flex;gap:10px;align-items:center;font-size:12px">'+
        '<span style="font-weight:700;color:#22c55e">'+tReady+' ready</span>'+
        (tOOS?'<span style="color:#ef4444;font-weight:700">'+tOOS+' OOS</span>':'')+
        (tSvc?'<span style="color:#f59e0b;font-weight:700">'+tSvc+' svc</span>':'')+
        (tPend?'<span style="color:#a855f7;font-weight:700">'+tPend+' pend</span>':'')+
        '</div></div>';
    }
    var rideChips='';
    for(var i=0;i<rides.length;i++){ var rr=rides[i]; var up=rr.status==='operational';
      rideChips+='<span style="display:inline-flex;align-items:center;font-size:12px;background:'+(up?'#dcfce7':'#fee2e2')+';color:'+(up?'#166534':'#991b1b')+';padding:4px 10px;border-radius:8px;margin-right:6px;margin-top:4px">'+esc(rr.name)+' '+(up?'up':'down')+'</span>';
    }
    if(!rideChips) rideChips='<span style="font-size:11px;color:var(--muted)">No rides</span>';
    var fleetCard='<div class="card"><div onclick="setTab(\'fleet\')" style="font-size:13px;font-weight:800;margin-bottom:6px;cursor:pointer">🏎 Fleet & Rides</div>'+fleetRows+'<div onclick="setTab(\'rides\')" style="padding-top:8px;cursor:pointer">'+rideChips+'</div></div>';

    // ── Assets & equipment ──
    var arc=D.arcadeMachines||[];
    var arcUp=0,arcDownList=[];
    for(var i=0;i<arc.length;i++){ if(arc[i].status==='operational')arcUp++; else arcDownList.push(arc[i]); }
    var critList=(D.assets||[]).filter(_dashIsCritical);
    var critOk=0,critDownList=[];
    for(var i=0;i<critList.length;i++){ if(critList[i].status==='operational')critOk++; else critDownList.push(critList[i]); }
    var spares=(D.engines||[]).filter(function(e){return e.status!=='installed';});
    var spc={'new':0,'rebuilt':0,'rebuild-in-progress':0,'needs-rebuild':0};
    for(var i=0;i<spares.length;i++){ var cc=_dashEngCond(spares[i]); if(spc[cc]==null)spc[cc]=0; spc[cc]++; }

    function statusRight(okN,okLbl,downN){
      return '<div style="font-size:12px"><span style="color:#22c55e;font-weight:700">'+okN+' '+okLbl+'</span>'+(downN?' · <span style="color:#ef4444;font-weight:700">'+downN+' down</span>':'')+'</div>';
    }
    function chip(n,label,bg,col){ return n>0?'<span style="font-size:12px;background:'+bg+';color:'+col+';padding:3px 9px;border-radius:8px;margin-right:6px;display:inline-block;margin-top:4px">'+n+' '+label+'</span>':''; }
    var arcSub=arcDownList.length?arcDownList.map(function(m){return esc(m.name)+(m.notes?(' — '+esc(m.notes)):'');}).join('; '):'';
    var critSub=critDownList.length?critDownList.map(function(a){return esc(a.name)+(a.notes?(' — '+esc(String(a.notes).split('\n')[0])):'');}).join('; '):'';
    var spChips=chip(spc['rebuilt'],'rebuilt · ready','#dcfce7','#166534')+chip(spc['new'],'new','#e0f2fe','#0369a1')+chip(spc['rebuild-in-progress'],'rebuild in progress','#fef3c7','#92400e')+chip(spc['needs-rebuild'],'needs rebuild','#fee2e2','#991b1b');
    if(!spChips) spChips='<span style="font-size:11px;color:var(--muted)">No spare engines</span>';
    var aeCard='<div class="card"><div style="font-size:13px;font-weight:800;margin-bottom:6px">🔧 Assets & Equipment</div>'+
      '<div onclick="setTab(\'arcade\')" style="padding:7px 0;border-bottom:1px solid var(--border);cursor:pointer"><div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:13px;font-weight:700">Arcade</div>'+statusRight(arcUp,'up',arcDownList.length)+'</div>'+(arcSub?'<div style="font-size:11px;color:var(--muted);margin-top:2px">'+arcSub+'</div>':'')+'</div>'+
      '<div onclick="setTab(\'facility\')" style="padding:7px 0;border-bottom:1px solid var(--border);cursor:pointer"><div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:13px;font-weight:700">Critical building equipment</div>'+statusRight(critOk,'ok',critDownList.length)+'</div>'+(critSub?'<div style="font-size:11px;color:var(--muted);margin-top:2px">'+critSub+'</div>':'')+'</div>'+
      '<div onclick="setTab(\'fleet\')" style="padding:7px 0;cursor:pointer"><div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:13px;font-weight:700">Spare engines</div><div style="font-size:12px;color:var(--muted)">'+spares.length+' total</div></div><div>'+spChips+'</div></div>'+
      '</div>';

    // ── Assemble ──
    var unreadMail=(typeof msgUnreadCount==='function')?msgUnreadCount():0;
    var mailBanner=unreadMail>0?'<div onclick="setTab(\'messages\')" style="margin:12px 14px 0;background:#eef2ff;border:1.5px solid #c7d2fe;border-radius:12px;padding:11px 14px;display:flex;align-items:center;gap:10px;cursor:pointer"><div style="font-size:18px">✉</div><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:#3730a3">You have a new message!</div><div style="font-size:12px;color:#4f46e5;margin-top:1px">'+unreadMail+' unread message'+(unreadMail>1?'s':'')+'</div></div><div style="font-size:20px;color:#6366f1;opacity:.6">›</div></div>':'';
    el.innerHTML='<div class="scroll">'+_pmBanner+hero+mailBanner+actionGrid+vendorLine+
      '<div style="padding:10px 14px;display:flex;flex-direction:column;gap:10px">'+compCard+fleetCard+aeCard+'</div>'+
      '<div style="height:60px"></div></div>';
  }catch(e){
    el.innerHTML='<div class="scroll"><div style="padding:20px"><h2>Dashboard</h2><p style="color:var(--muted)">Error: '+e.message+'</p></div></div>';
    console.error('renderDash:',e);
  }
}
function sCard(val,label,sub,color,onclick,big){
  var fs=big?'18px':'26px';
  return '<div class="stat-card" style="border-top-color:'+color+'" onclick="'+onclick+'"><div class="stat-val" style="color:'+color+';font-size:'+fs+'">'+esc(String(val))+'</div><div class="stat-lbl">'+esc(label)+'</div>'+(sub?'<div class="stat-sub">'+esc(sub)+'</div>':'')+'<span class="stat-arrow">&rsaquo;</span></div>';
}
function drillComp(){
  var soon=[];for(var i=0;i<D.compliance.length;i++)if(du(D.compliance[i].nextDue)<=60)soon.push(D.compliance[i]);
  soon.sort(function(a,b){return new Date(a.nextDue)-new Date(b.nextDue);});
  var h='<div style="font-size:17px;font-weight:800;margin-bottom:16px">Compliance Due in 60 Days</div>';
  for(var i=0;i<soon.length;i++){var c=soon[i],days=du(c.nextDue);h+='<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div style="font-size:13px;font-weight:700;margin-bottom:2px">'+esc(c.title)+'</div><div style="font-size:11px;color:var(--muted)">'+esc(c.inspector)+' - Due '+fmt(c.nextDue)+' - '+fmtM(c.cost)+'</div><div style="margin-top:4px">'+pill(days<=30?'URGENT':'Due Soon',days<=30?'#ef4444':'#f59e0b')+'</div></div>';}
  h+='<button onclick="closeSheetGoCompliance()" style="margin-top:16px;width:100%;background:var(--accent);border:none;color:#fff;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Go to Compliance</button>';
  document.getElementById('drill-content').innerHTML=h;openM('drillSheet');
}
function drillDT(){
  var total=0;for(var i=0;i<(D.downtimes||[]).length;i++)total+=Number(D.downtimes[i].lostRevenue||0);
  var sup=(typeof isSupervisor!=='undefined'&&isSupervisor());
  var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div style="font-size:17px;font-weight:800">Downtime Events YTD</div><button onclick="openDowntimeModal()" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">+ Log downtime</button></div>';
  h+='<div style="font-size:24px;font-weight:900;color:#ef4444;margin-bottom:16px">'+fmtM(total)+' lost</div>';
  if(!D.downtimes||!D.downtimes.length){h+='<div style="text-align:center;color:var(--muted);font-size:13px;padding:24px 0">No downtime logged yet.</div>';}
  for(var i=0;i<(D.downtimes||[]).length;i++){var dt=D.downtimes[i],asset=assetById(dt.assetId);
    h+='<div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><div style="font-size:13px;font-weight:700">'+(asset?esc(asset.name):'Unknown')+'</div><div style="font-size:11px;color:var(--muted)">'+esc(dt.reason)+' - '+new Date(dt.start).toLocaleDateString()+(dt.notes?(' \u00b7 '+esc(dt.notes)):'')+'</div></div><div style="text-align:right"><div style="font-size:13px;font-weight:800;color:#ef4444">'+fmtM(dt.lostRevenue)+'</div>'+(sup?('<button onclick="removeDowntime(\''+escA(dt.id)+'\')" style="background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;font-family:inherit;padding:2px 0">remove</button>'):'')+'</div></div>';
  }
  document.getElementById('drill-content').innerHTML=h;openM('drillSheet');
}
function openDowntimeModal(){
  var asel=document.getElementById('dt-asset');if(asel){asel.innerHTML='<option value="">Select...</option>';for(var i=0;i<D.assets.length;i++)asel.innerHTML+='<option value="'+escA(D.assets[i].id)+'">'+esc(D.assets[i].name)+'</option>';if(typeof makeSearchable!=='undefined')makeSearchable('dt-asset');}
  var now=new Date(),pad=function(n){return (n<10?'0':'')+n;};
  var local=now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())+'T'+pad(now.getHours())+':'+pad(now.getMinutes());
  var st=document.getElementById('dt-start');if(st)st.value=local;
  var r=document.getElementById('dt-reason');if(r)r.selectedIndex=0;
  ['dt-hours','dt-lost','dt-notes'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  openM('downtimeModal');
}
function saveDowntime(){
  var assetId=document.getElementById('dt-asset').value;
  var reason=document.getElementById('dt-reason').value;
  var start=document.getElementById('dt-start').value;
  var hours=parseFloat(document.getElementById('dt-hours').value)||0;
  var lost=parseFloat(document.getElementById('dt-lost').value);
  var notes=document.getElementById('dt-notes').value.trim();
  if(!assetId){alert('Pick an asset.');return;}
  if(!reason){alert('Pick a reason.');return;}
  if(isNaN(lost)||lost<0){alert('Enter lost revenue (a dollar amount, 0 or more).');return;}
  var rec={id:nid('DT'),assetId:assetId,reason:reason,start:start||new Date().toISOString(),end:'',hours:hours,lostRevenue:lost,notes:notes,created:today(),loggedBy:(currentUser&&currentUser.name)||''};
  if(!D.downtimes)D.downtimes=[];D.downtimes.push(rec);dbSave('downtimes',rec);
  closeM('downtimeModal');
  if(typeof renderDash!=='undefined')renderDash();
  drillDT();
  if(typeof updateBadges!=='undefined')updateBadges();
}
function removeDowntime(id){
  if(!confirm('Remove this downtime event?'))return;
  D.downtimes=(D.downtimes||[]).filter(function(d){return d.id!==id;});
  if(typeof dbRemove!=='undefined')dbRemove('downtimes',id);
  if(typeof renderDash!=='undefined')renderDash();
  drillDT();
}
function setPF(f){preopFilter=f;renderPreops();}
function buildPOCard(name){
  var tmpl=PREOP_TEMPLATES[name],st=D.preopState[name]||{checks:{},flags:{},failNotes:{},completed:false};
  var tot=tmpl.items.length,done=0;var ck=st.checks||{};for(var k in ck){if(ck[k]==='ok'||ck[k]==='fail')done++;}
  var maj=0,min=0;var fl=st.flags||{};for(var k in fl){if(fl[k]==='major')maj++;if(fl[k]==='minor')min++;}
  var pct=tot>0?Math.round((done/tot)*100):0,isOpen=st._open;
  var whoTxt=tmpl.who==='mechanic'?'Mechanic':tmpl.who==='operator'?'Operator':'Either';
  var dotC=st.completed?(maj>0?'#ef4444':min>0?'#f59e0b':'#22c55e'):pct>0?'#f59e0b':'#e2e8f0';
  var en=name.replace(/'/g,"\\'");
  var h='<div class="po-asset"><div class="po-head" data-po="'+en+'" onclick="togglePOByName(this)">';
  h+='<div><div style="font-size:14px;font-weight:800">'+esc(name)+'</div><div style="font-size:11px;color:var(--muted)">'+esc(whoTxt)+' - '+done+'/'+tot;
  if(maj>0)h+=' - <span style="color:#ef4444">'+maj+' MAJOR</span>';
  if(min>0)h+=' - <span style="color:#f59e0b">'+min+' minor</span>';
  h+='</div></div><div style="display:flex;align-items:center;gap:8px">';
  if(st.completed)h+=pill(maj>0?'FAILED':min>0?'FLAGS':'CLEARED',maj>0?'#ef4444':min>0?'#f59e0b':'#22c55e');
  else h+='<div style="width:40px;height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+(pct===100?'#22c55e':'#f59e0b')+'"></div></div>';
  h+='<div style="width:10px;height:10px;border-radius:50%;background:'+dotC+'"></div>';
  h+='<span style="font-size:13px;color:var(--muted)">'+(isOpen?'v':'^')+'</span></div></div>';
  h+='<div class="po-body'+(isOpen?' open':'')+'">';
  h+=buildPOItems(name,tmpl,st);
  if(tmpl.mfr)h+='<div class="mfr-block"><div style="font-size:12px;font-weight:800;color:var(--muted);margin-bottom:6px">Manufacturer Pre-Op Checklist</div><div style="font-size:11px;color:var(--muted);margin-bottom:8px">Submit the manufacturer\'s required daily inspection form</div><button onclick="alertUpload()" style="width:100%;background:var(--card);border:1.5px solid var(--border);border-radius:9px;padding:10px 14px;font-size:12px;font-weight:600;color:var(--accent);cursor:pointer;font-family:inherit">Upload Manufacturer Form</button></div>';
  h+='<div class="po-section">';
  if(st.completed)h+='<div style="font-size:12px;font-weight:700;color:#22c55e">Signed off by '+esc(st.completedBy||'')+' at '+esc(st.completedAt||'')+'</div><button data-po="'+en+'" onclick="resetPOBtn(this)" style="margin-top:8px;background:#fee2e2;border:1.5px solid #fca5a5;color:#991b1b;border-radius:8px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Reset</button>';
  else{var sid=name.replace(/[^a-zA-Z0-9]/g,'_');h+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div style="flex:1;border:1.5px solid var(--border);border-radius:10px;padding:9px 12px;font-size:13px;font-family:inherit;min-width:150px;color:var(--text);background:var(--bg);font-weight:700">'+esc((currentUser&&currentUser.name)||'')+'</div><button data-po="'+en+'" onclick="signOffPOBtn(this)" style="background:#22c55e;border:none;color:#fff;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Sign Off</button></div>';}
  h+='</div></div></div>';
  return h;
}
function buildPOItems(name,tmpl,st){
  var cats=[],catSeen={};for(var i=0;i<tmpl.items.length;i++){var c=tmpl.items[i].cat;if(!catSeen[c]){cats.push(c);catSeen[c]=true;}}
  var h='';
  for(var ci=0;ci<cats.length;ci++){
    var cat=cats[ci];h+='<div class="po-section"><div class="po-sec-t">'+esc(cat)+'</div>';
    for(var i=0;i<tmpl.items.length;i++){
      var item=tmpl.items[i];if(item.cat!==cat)continue;
      var v=(st.checks||{})[item.id],fl=(st.flags||{})[item.id];
      var cc=v==='ok'?' ok':fl==='major'?' major':fl==='minor'?' minor':'';
      var ct=v==='ok'?'&#10003;':fl==='major'?'&#10007;':fl==='minor'?'!':'';
      var en=name.replace(/'/g,"\\'");
      h+='<div class="check-item"><div class="chkbox'+cc+'" data-en="'+en+'" data-iid="'+item.id+'" onclick="checkOKBtn(this)">'+ct+'</div>';
      h+='<div style="flex:1"><div style="font-size:13px;font-weight:600">'+esc(item.label)+'</div>';
      h+='<span class="sev-badge '+(item.sev==='major'?'sev-major':'sev-minor')+'">'+item.sev+'</span>';
      if(v!=='ok'){h+='<div class="flag-btns"><button class="fbtn fbtn-major" data-en2="'+en+'" data-iid2="'+item.id+'" data-sev="major" onclick="flagItemBtn(this)"'+(fl==='major'?' style="background:#ef4444;color:#fff"':'')+'>Major</button><button class="fbtn fbtn-minor" data-en2="'+en+'" data-iid2="'+item.id+'" data-sev="minor" onclick="flagItemBtn(this)"'+(fl==='minor'?' style="background:#f59e0b;color:#fff"':'')+'>Minor</button></div>';}
      if(fl==='major'||fl==='minor'){var sid2=item.id.replace(/[^a-zA-Z0-9]/g,'_');h+='<input class="flag-inp '+(fl==='major'?'maj':'min')+'" id="fn-'+sid2+'" placeholder="Describe the issue..." value="'+esc((st.failNotes||{})[item.id]||'')+'" oninput="setFN(\''+en+'\',\''+item.id+'\',this.value)"/>';}
      h+='</div></div>';
    }
    h+='</div>';
  }
  return h;
}
function togglePO(name){if(!D.preopState[name])D.preopState[name]={checks:{},flags:{},failNotes:{},completed:false};D.preopState[name]._open=!D.preopState[name]._open;renderPreops();}
function checkOK(name,id){
  if(!D.preopState[name])D.preopState[name]={checks:{},flags:{},failNotes:{},completed:false,_open:true};
  var st=D.preopState[name];st.checks=st.checks||{};
  st.checks[id]=st.checks[id]==='ok'?undefined:'ok';
  if(st.checks[id]==='ok'){if(st.flags)delete st.flags[id];if(st.failNotes)delete st.failNotes[id];}
  renderPreops();updateBadges();
}
function flagItem(name,id,sev){
  if(!D.preopState[name])D.preopState[name]={checks:{},flags:{},failNotes:{},completed:false,_open:true};
  var st=D.preopState[name];st.flags=st.flags||{};
  st.flags[id]=st.flags[id]===sev?undefined:sev;
  st.checks=st.checks||{};st.checks[id]=st.flags[id]?'fail':undefined;
  renderPreops();
}
function setFN(name,id,val){if(D.preopState[name]){D.preopState[name].failNotes=D.preopState[name].failNotes||{};D.preopState[name].failNotes[id]=val;}}

function resetPO(name){D.preopState[name]={checks:{},flags:{},failNotes:{},completed:false,_open:true};renderPreops();updateBadges();}

var signoffKartId=null,signoffTrack=null;

function findItemById(id){for(var name in PREOP_TEMPLATES){var items=PREOP_TEMPLATES[name].items;for(var i=0;i<items.length;i++)if(items[i].id===id)return items[i];}return null;}


var fleetTrack='euro';
var fleetView='karts'; // 'karts' or 'engines'
// ── KART DISPLAY NAMES ───────────────────────────────────────────────────────
var TRACK_PREFIX={euro:'Sodi',road:'Family Kart',sprint:'Sprint',kiddie:'Kiddie Kart'};



function setFT(t){fleetTrack=t;fleetView='karts';renderFleet();}
var curEngineId = null;















// ── ENGINE SWAP WIZARD ────────────────────────────────────────────────────────
// Steps: 1=confirm pull, 2=select replacement, 3=confirm & execute, 4=done
// ── DIAGNOSTIC / SYMPTOM CHECKER ─────────────────────────────────────────────
var diagSymptom = null;
var diagStep = 0;      // 0=symptom list, 1=walk steps, 2=estimate
var diagSwoId = null;  // resolved SWO
var diagCustomParts = []; // mechanic-added parts {name,qty,cost,unit}
var diagCustomLaborMins = 0; // override


// ── SMART DIAGNOSTIC WIZARD ───────────────────────────────────────────────────
// State
var diagSelectedSymptoms = [];  // array of symptom IDs
var diagCauses = [];            // ranked causes after matching
var diagCurrentCause = null;    // cause being confirmed
var diagQIdx = 0;               // current question index
var diagAnswers = {};           // {causeId: {qIdx: answer}}
var diagCauseScores = {};       // {causeId: score}
var diagConfirmedCause = null;  // the identified cause
var diagCustomParts = [];
var diagCustomLaborMins = 0;
var diagStep = 0;
// 0=symptoms 1=questions 2=results 3=estimate 4=done



function renderDiagModal(){
  var body=document.getElementById('diag-body');
  var btns=document.getElementById('diag-btns');
  if(!body||!btns) return;

  var eng = curEngineId ? getEngineById(curEngineId) : null;
  var kart = null;
  if(eng){ var allK=allKarts(); for(var i=0;i<allK.length;i++) if(allK[i].engineId===eng.id){kart=allK[i];break;} }

  if(diagStep===0) renderDiagSymptoms(body, btns, eng, kart);
  else if(diagStep===1) renderDiagQuestions(body, btns, eng, kart);
  else if(diagStep===2) renderDiagResults(body, btns, eng, kart);
  else if(diagStep===3) renderDiagEstimate(body, btns, eng, kart);
  else if(diagStep===4) renderDiagDone(body, btns);
}

// ── STEP 0: Symptom Multi-Select ─────────────────────────────────────────────




// ── SYMPTOM MATCHING ENGINE ───────────────────────────────────────────────────
function diagRunMatch(){
  if(!diagSelectedSymptoms.length) return;
  // Score each cause by how many selected symptoms it matches
  var scores = {};
  for(var ci=0;ci<DIAG_CAUSES.length;ci++){
    var cause = DIAG_CAUSES[ci];
    var matched=0, total=diagSelectedSymptoms.length;
    for(var si=0;si<diagSelectedSymptoms.length;si++){
      if(cause.symptoms.indexOf(diagSelectedSymptoms[si])>=0) matched++;
    }
    if(matched===0){ scores[cause.id]=-99; continue; }
    // Score: match ratio * base likelihood, divided by check cost (prefer cheap checks)
    var matchRatio = matched/total;
    var fullMatch = matched===total ? 2 : 1;
    scores[cause.id] = (matchRatio * cause.likelihood_base * fullMatch) - (cause.check_cost * 0.05);
    scores[cause.id] = Math.round(scores[cause.id]*10)/10;
  }
  diagCauseScores = scores;
  // Sort causes by score descending, filter out negative
  diagCauses = DIAG_CAUSES.filter(function(c){return scores[c.id]>0;})
    .sort(function(a,b){return scores[b.id]-scores[a.id];});
  // Init answers
  diagAnswers = {};
  for(var i=0;i<diagCauses.length;i++) diagAnswers[diagCauses[i].id]={};
  diagQIdx=0; diagCurrentCause=null;
  diagStep=1;
  renderDiagModal();
}

// ── STEP 1: Smart Clarifying Questions ───────────────────────────────────────
function renderDiagQuestions(body, btns, eng, kart){
  document.getElementById('diag-title').textContent = '🔎 Narrowing down...';
  // Find next unanswered question across top causes
  var topCauses = diagCauses.slice(0,6);
  var nextQ = null, nextCause = null, nextQIdx = -1;
  for(var ci=0;ci<topCauses.length;ci++){
    var cause = topCauses[ci];
    if(!cause.questions||!cause.questions.length) continue;
    for(var qi=0;qi<cause.questions.length;qi++){
      var ans = diagAnswers[cause.id];
      if(!ans||ans[qi]===undefined){
        nextQ=cause.questions[qi]; nextCause=cause; nextQIdx=qi;
        break;
      }
    }
    if(nextQ) break;
  }

  if(!nextQ){
    // All questions answered — go to results
    diagStep=2; renderDiagModal(); return;
  }

  diagCurrentCause = nextCause;
  var h = '';

  // Progress indicator
  var totalQ=0, answeredQ=0;
  for(var ci=0;ci<topCauses.length;ci++){
    var cause=topCauses[ci];
    if(!cause.questions) continue;
    totalQ+=cause.questions.length;
    var ans=diagAnswers[cause.id]||{};
    for(var qi=0;qi<cause.questions.length;qi++) if(ans[qi]!==undefined) answeredQ++;
  }
  var pct = totalQ>0?Math.round((answeredQ/totalQ)*100):0;
  h += '<div style="height:4px;background:var(--border);border-radius:2px;margin-bottom:12px"><div style="height:100%;width:'+pct+'%;background:var(--accent);border-radius:2px"></div></div>';
  h += '<div style="font-size:10px;color:var(--muted);margin-bottom:12px">Question '+(answeredQ+1)+' of ~'+totalQ+'</div>';

  // Question
  h += '<div style="font-size:14px;font-weight:700;margin-bottom:8px">'+esc(nextQ.q)+'</div>';

  // How-to hint
  if(nextQ.how){
    h += '<div style="background:#f0f9ff;border-radius:8px;padding:8px 10px;font-size:11px;color:#0891b2;margin-bottom:12px">'+
      '<b>How to check:</b> '+esc(nextQ.how)+'</div>';
  }

  // Answer buttons
  if(nextQ.options){
    h += '<div style="display:flex;flex-direction:column;gap:6px">';
    for(var oi=0;oi<nextQ.options.length;oi++){
      h += '<button data-ci="'+diagCauses.indexOf(nextCause)+'" data-qi="'+nextQIdx+'" data-ai="'+oi+'" onclick="diagAnswerMulti(this)" style="padding:10px 14px;border:1.5px solid var(--border);border-radius:9px;background:var(--card);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left">'+esc(nextQ.options[oi])+'</button>';
    }
    h += '</div>';
  } else {
    h += '<div style="display:flex;gap:8px">';
    h += '<button data-ci="'+diagCauses.indexOf(nextCause)+'" data-qi="'+nextQIdx+'" data-ans="yes" onclick="diagAnswerYesNo(this)" style="flex:1;padding:12px;border:1.5px solid var(--border);border-radius:9px;background:var(--card);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">✅ Yes</button>';
    h += '<button data-ci="'+diagCauses.indexOf(nextCause)+'" data-qi="'+nextQIdx+'" data-ans="no" onclick="diagAnswerYesNo(this)" style="flex:1;padding:12px;border:1.5px solid var(--border);border-radius:9px;background:var(--card);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">❌ No</button>';
    h += '</div>';
  }

  body.innerHTML = h;
  btns.innerHTML = '<button class="mc" onclick="diagStep=0;renderDiagModal()">← Symptoms</button>' +
    '<button onclick="diagStep=2;renderDiagModal()" style="background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Skip to Results</button>';
}

function diagAnswerYesNo(btn){
  var ci=parseInt(btn.dataset.ci), qi=parseInt(btn.dataset.qi), ans=btn.dataset.ans;
  var cause=diagCauses[ci]; if(!cause) return;
  if(!diagAnswers[cause.id]) diagAnswers[cause.id]={};
  diagAnswers[cause.id][qi]=ans;
  // Adjust score
  var q=cause.questions[qi];
  var adj=0;
  if(ans==='yes'){ if(q.yes==='confirm') adj=5; else if(q.yes==='increase') adj=3; else if(q.yes==='eliminate') adj=-99; else if(q.yes==='reduce') adj=-2; }
  else { if(q.no==='confirm') adj=5; else if(q.no==='increase') adj=3; else if(q.no==='eliminate') adj=-99; else if(q.no==='reduce') adj=-2; }
  diagCauseScores[cause.id]=(diagCauseScores[cause.id]||0)+adj;
  // Re-sort
  diagCauses.sort(function(a,b){return (diagCauseScores[b.id]||0)-(diagCauseScores[a.id]||0);});
  diagCauses=diagCauses.filter(function(c){return (diagCauseScores[c.id]||0)>-50;});
  renderDiagModal();
}

function diagAnswerMulti(btn){
  var ci=parseInt(btn.dataset.ci), qi=parseInt(btn.dataset.qi), ai=parseInt(btn.dataset.ai);
  var cause=diagCauses[ci]; if(!cause) return;
  if(!diagAnswers[cause.id]) diagAnswers[cause.id]={};
  diagAnswers[cause.id][qi]=ai;
  var q=cause.questions[qi];
  if(q.weights&&q.weights[ai]!==undefined){
    diagCauseScores[cause.id]=(diagCauseScores[cause.id]||0)+q.weights[ai];
  }
  diagCauses.sort(function(a,b){return (diagCauseScores[b.id]||0)-(diagCauseScores[a.id]||0);});
  diagCauses=diagCauses.filter(function(c){return (diagCauseScores[c.id]||0)>-50;});
  renderDiagModal();
}

// ── STEP 2: Ranked Results ────────────────────────────────────────────────────
function renderDiagResults(body, btns, eng, kart){
  document.getElementById('diag-title').textContent = '📊 Most Likely Causes';
  var maxScore = diagCauses.length>0?(diagCauseScores[diagCauses[0].id]||1):1;
  var h='<div style="font-size:11px;color:var(--muted);margin-bottom:10px">Select the cause you\'ve identified — or select "All of these" for a combined estimate.</div>';

  for(var i=0;i<Math.min(diagCauses.length,8);i++){
    var cause=diagCauses[i];
    var score=Math.max(0,diagCauseScores[cause.id]||0);
    var pct=Math.min(100,Math.round((score/maxScore)*100));
    var conf=pct>=70?'High':pct>=40?'Likely':'Possible';
    var confColor=pct>=70?'#22c55e':pct>=40?'#f59e0b':'#94a3b8';
    // Which selected symptoms this explains
    var explains=cause.symptoms.filter(function(s){return diagSelectedSymptoms.indexOf(s)>=0;});
    var explainLabels=explains.map(function(sid){
      var sym=DIAG_SYMPTOMS.filter(function(s){return s.id===sid;})[0];
      return sym?sym.label:'';
    }).filter(Boolean);

    h+='<div data-causeid="'+cause.id+'" onclick="diagSelectCause(this)" style="border:1.5px solid var(--border);border-radius:11px;padding:11px 13px;margin-bottom:7px;cursor:pointer;background:var(--card)">';
    h+='<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px">';
    h+='<div style="font-size:13px;font-weight:700;flex:1">'+esc(cause.label)+'</div>';
    h+='<span style="font-size:10px;font-weight:800;color:'+confColor+';background:'+confColor+'20;border-radius:5px;padding:2px 7px;flex-shrink:0;margin-left:8px">'+conf+'</span>';
    h+='</div>';
    // Confidence bar
    h+='<div style="height:3px;background:var(--border);border-radius:2px;margin-bottom:6px"><div style="height:100%;width:'+pct+'%;background:'+confColor+';border-radius:2px"></div></div>';
    // Explains which symptoms
    if(explainLabels.length){
      h+='<div style="font-size:10px;color:var(--muted)">Explains: '+explainLabels.slice(0,3).map(function(l){return esc(l);}).join(', ')+(explainLabels.length>3?' +'+( explainLabels.length-3)+' more':'')+'</div>';
    }
    // Check cost preview
    h+='<div style="font-size:10px;color:var(--muted);margin-top:3px">Check cost: '+(cause.check_cost===0?'Free — visual check':'$'+cause.check_cost)+' · Labor: '+cause.labor_hrs+'h</div>';
    h+='</div>';
  }
  if(!diagCauses.length){
    h+='<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">No matching causes found. Try selecting different symptoms or consult a senior mechanic.</div>';
  }

  body.innerHTML=h;
  btns.innerHTML='<button class="mc" onclick="diagStep=1;renderDiagModal()">← Questions</button>';
}

function diagSelectCause(el){
  diagConfirmedCause=el.dataset.causeid;
  diagCustomParts=[]; diagCustomLaborMins=0;
  diagStep=3; renderDiagModal();
}

// ── STEP 3: Estimate ──────────────────────────────────────────────────────────
function renderDiagEstimate(body, btns, eng, kart){
  document.getElementById('diag-title').textContent = '💰 Repair Estimate';
  var cause=DIAG_CAUSES.filter(function(c){return c.id===diagConfirmedCause;})[0];
  if(!cause){body.innerHTML='<div>Cause not found.</div>';return;}

  var engModel = eng?(eng.model||'GX200'):'GX200';
  var engHrs = eng?(eng.totalHrs||0):0;
  var engCostInfo = ENGINE_COSTS[engModel]||ENGINE_COSTS['GX200'];

  // Parts list — merge default + custom
  var allParts = (cause.parts||[]).slice();
  for(var i=0;i<diagCustomParts.length;i++) allParts.push(diagCustomParts[i]);

  // Calculate costs
  var partsCost=0;
  for(var i=0;i<allParts.length;i++){
    if(!allParts[i]._skip) partsCost+=(allParts[i].cost||0)*(allParts[i].qty||1);
  }
  partsCost=Math.round(partsCost*100)/100;
  var laborMins=diagCustomLaborMins>0?diagCustomLaborMins:Math.round(cause.labor_hrs*60);
  var laborCost=Math.round((laborMins/60)*DIAG_LABOR_RATE*100)/100;
  var totalCost=Math.round((partsCost+laborCost)*100)/100;

  // Build/Replace recommendation
  var newCost=engCostInfo.new_cost;
  var repairRatio=newCost>0?totalCost/newCost:0;
  var highHours=engHrs>=400;
  var midHours=engHrs>=200;
  var isCatastrophic=cause.id==='seized';
  var recReplace = isCatastrophic||(repairRatio>0.5&&highHours)||(repairRatio>0.7);
  var recText='', recColor='', recBg='';
  if(isCatastrophic){recText='🔒 Replace Engine';recColor='#ef4444';recBg='#fff5f5';}
  else if(recReplace){recText='🔄 Consider Replacement';recColor='#f59e0b';recBg='#fffbeb';}
  else{recText='🔧 Repair / Rebuild';recColor='#22c55e';recBg='#f0fdf4';}

  var h='';

  // Cause title
  h+='<div style="font-size:14px;font-weight:800;margin-bottom:12px">'+esc(cause.label)+'</div>';

  // Fix description
  if(cause.fix){
    h+='<div style="background:var(--bg);border-radius:9px;padding:10px;font-size:12px;color:var(--text);line-height:1.5;margin-bottom:12px">'+esc(cause.fix)+'</div>';
  }

  // Cost summary
  h+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px">';
  h+='<div style="background:var(--bg);border-radius:9px;padding:8px;text-align:center"><div style="font-size:16px;font-weight:900;color:#0891b2;font-family:monospace">$'+partsCost.toFixed(2)+'</div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Parts</div></div>';
  h+='<div style="background:var(--bg);border-radius:9px;padding:8px;text-align:center"><div style="font-size:16px;font-weight:900;color:#6366f1;font-family:monospace">$'+laborCost.toFixed(2)+'</div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Labor '+laborMins+'min</div></div>';
  h+='<div style="background:#1e1b4b;border-radius:9px;padding:8px;text-align:center"><div style="font-size:16px;font-weight:900;color:#a5b4fc;font-family:monospace">$'+totalCost.toFixed(2)+'</div><div style="font-size:9px;font-weight:700;color:#a5b4fc;text-transform:uppercase">Total</div></div>';
  h+='</div>';

  // Build/Replace recommendation
  h+='<div style="background:'+recBg+';border:2px solid '+recColor+'40;border-radius:11px;padding:11px 13px;margin-bottom:12px">';
  h+='<div style="font-size:13px;font-weight:900;color:'+recColor+';margin-bottom:4px">'+recText+'</div>';
  if(engCostInfo.new_cost>0){
    h+='<div style="font-size:11px;color:'+recColor+'">Repair: $'+totalCost.toFixed(2)+' vs. New engine: $'+newCost+'</div>';
    if(engCostInfo.note) h+='<div style="font-size:10px;color:var(--muted);margin-top:2px">'+esc(engCostInfo.note)+'</div>';
  }
  if(engHrs>0) h+='<div style="font-size:10px;color:var(--muted);margin-top:4px">Engine hours: '+engHrs.toFixed(0)+'h '+(highHours?'⚠️ High hours':midHours?'Moderate hours':'Low hours — rebuild favored')+'</div>';
  h+='</div>';

  // Parts list — editable with reuse toggles
  h+='<div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Parts</div>';
  if(!allParts.length){
    h+='<div style="font-size:12px;color:var(--muted);padding:6px 0;margin-bottom:8px">No parts required.</div>';
  } else {
    h+='<div style="margin-bottom:8px">';
    for(var pi=0;pi<allParts.length;pi++){
      var p=allParts[pi];
      var isCustom=pi>=(cause.parts||[]).length;
      var skipped=p._skip||false;
      h+='<div style="display:flex;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--border);opacity:'+(skipped?'0.4':'1')+'">';
      // Reuse toggle
      if(!isCustom&&p.reuse){
        h+='<button data-pi="'+pi+'" onclick="diagToggleReuse(this)" style="font-size:10px;font-weight:700;border-radius:5px;padding:2px 7px;cursor:pointer;font-family:inherit;border:1px solid '+(skipped?'#22c55e':'#f59e0b')+';background:'+(skipped?'#f0fdf4':'#fffbeb')+';color:'+(skipped?'#166534':'#92400e')+'">'+(skipped?'REUSE ✓':'REUSE?')+'</button>';
      }
      h+='<div style="flex:1"><div style="font-size:12px;font-weight:600'+(skipped?' text-decoration:line-through;':'')+'">'+esc(p.name)+'</div>';
      if(p.reuse_note) h+='<div style="font-size:9px;color:'+(p.reuse?'#f59e0b':'var(--muted)')+'">'+esc(p.reuse_note)+'</div>';
      h+='</div>';
      h+='<div style="font-size:11px;font-weight:700;font-family:monospace;color:var(--muted)">×'+p.qty+'</div>';
      h+='<div style="font-size:12px;font-weight:700;font-family:monospace;color:'+(skipped?'var(--muted)':'#0891b2');
      h+=';min-width:55px;text-align:right">'+(skipped?'saved':'$'+((p.cost||0)*(p.qty||1)).toFixed(2))+'</div>';
      if(isCustom) h+='<button data-cpi="'+(pi-(cause.parts||[]).length)+'" onclick="diagRemoveCustomPart(this)" style="background:#fee2e2;border:none;color:#ef4444;border-radius:5px;padding:2px 7px;cursor:pointer;font-family:inherit;font-size:11px">✕</button>';
      h+='</div>';
    }
    h+='</div>';
  }

  // Add custom part
  h+='<div style="background:var(--bg);border-radius:9px;padding:9px;margin-bottom:10px">';
  h+='<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:6px">+ Add Part</div>';
  h+='<div style="display:grid;grid-template-columns:1fr auto auto;gap:5px">';
  h+='<input id="dp-name" placeholder="Part name" style="border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit"/>';
  h+='<input id="dp-qty" type="number" value="1" min="1" style="width:48px;border:1.5px solid var(--border);border-radius:7px;padding:6px;font-size:12px;font-family:inherit"/>';
  h+='<input id="dp-cost" type="number" value="0" step="0.01" placeholder="$/ea" style="width:65px;border:1.5px solid var(--border);border-radius:7px;padding:6px;font-size:12px;font-family:inherit"/>';
  h+='</div>';
  h+='<button onclick="diagAddCustomPart()" style="margin-top:5px;width:100%;background:var(--accent);border:none;color:#fff;border-radius:7px;padding:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">+ Add</button>';
  h+='</div>';

  // Labor override
  h+='<div style="background:var(--bg);border-radius:9px;padding:9px;margin-bottom:10px">';
  h+='<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Labor Time</div>';
  h+='<div style="display:flex;align-items:center;gap:8px">';
  h+='<input id="dp-labor" type="number" value="'+laborMins+'" min="5" style="width:72px;border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;font-size:13px;font-family:inherit;font-weight:700"/>';
  h+='<span style="font-size:11px;color:var(--muted)">min @ $'+DIAG_LABOR_RATE+'/hr = <b style="color:#6366f1">$'+laborCost.toFixed(2)+'</b></span>';
  h+='<button onclick="diagUpdateLabor()" style="background:var(--accent);border:none;color:#fff;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Update</button>';
  h+='</div></div>';

  h+='<div style="height:8px"></div>';
  body.innerHTML=h;
  btns.innerHTML='<button class="mc" onclick="diagStep=2;renderDiagModal()">← Results</button>'+
    '<button onclick="diagCreateWorkOrder()" style="background:#22c55e;border:none;color:#fff;border-radius:10px;padding:10px 18px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit">Create Work Order</button>';
}

function diagToggleReuse(btn){
  var pi=parseInt(btn.dataset.pi);
  var cause=DIAG_CAUSES.filter(function(c){return c.id===diagConfirmedCause;})[0];
  if(!cause||!cause.parts[pi]) return;
  cause.parts[pi]._skip=!cause.parts[pi]._skip;
  renderDiagModal();
}





function diagUpdateLabor(){
  var v=Number(document.getElementById('dp-labor').value)||0;
  diagCustomLaborMins=v>0?v:0;
  renderDiagModal();
}



function renderDiagDone(body, btns){
  var lastWO=D.workOrders[D.workOrders.length-1];
  body.innerHTML='<div style="text-align:center;padding:16px 0">'+
    '<div style="font-size:48px;margin-bottom:10px">✅</div>'+
    '<div style="font-size:17px;font-weight:900;margin-bottom:6px">Work Order Created</div>'+
    '<div style="font-size:13px;font-family:monospace;color:var(--accent);margin-bottom:8px">'+(lastWO?lastWO.id:'')+'</div>'+
    '<div style="font-size:12px;color:var(--muted)">'+(lastWO?esc(lastWO.title):'')+'</div>'+
    '</div>';
  btns.innerHTML='<button class="ms2" onclick="closeM(\'diagModal\');renderFleet()">Done</button>';
}



var swapStep = 0;
var swapNewEngId = null;
















var editKartId=null,editKartTrack=null;





// PM status for a non-kart asset (rides, HVAC, swamp coolers, compressors), read
// straight from the recurring PM engine so the Facility card, the Rides card, the
// Recurring tab and the schedule can never disagree. Returns the most urgent PM on
// the asset, or null when the asset has no PM schedule at all.
// Mirrors kartPMTimeStatus() — this is the non-kart half of the same idea.
function assetPMStatus(assetId){
  if(!assetId) return null;
  if(!(window.LVMGP_PM && typeof LVMGP_PM.schedules==='function' && typeof LVMGP_PM._due==='function')) return null;
  var best=null;
  try{
    // Reuse the fleet render cache so a 180-asset page doesn't rebuild the whole
    // schedule list once per card.
    var sc=(typeof _pmScheds==='function')?_pmScheds():LVMGP_PM.schedules();
    for(var i=0;i<sc.length;i++){
      var s=sc[i];
      if(!s||s.kart||s.assetId!==assetId) continue;
      var st=LVMGP_PM._due(s); if(!st) continue;
      var rank=st.overdue?2:(st.due?1:0);
      var cand={rank:rank,label:s.label||'PM',sub:st.sub||'',dueDate:st.dueDate||'',
                overdue:!!st.overdue,due:!!st.due};
      if(!best) best=cand;
      else if(cand.rank>best.rank) best=cand;
      else if(cand.rank===best.rank && cand.dueDate && (!best.dueDate||cand.dueDate<best.dueDate)) best=cand;
    }
  }catch(e){return null;}
  return best;
}
// Shared PM chip used by the Facility and Rides cards.
function assetPMChip(assetId){
  var p=(typeof assetPMStatus==='function')?assetPMStatus(assetId):null;
  if(!p) return '';
  var col=p.overdue?'#ef4444':(p.due?'#b45309':'var(--muted)');
  var bg =p.overdue?'#fef2f2':(p.due?'#fffbeb':'var(--bg)');
  var head=p.overdue?'PM OVERDUE':(p.due?'PM DUE':'PM');
  return '<div style="margin-top:5px;padding:4px 8px;background:'+bg+';border-radius:6px;font-size:11px;font-weight:700;color:'+col+'">'+head+' · '+esc(p.label)+(p.sub?' · '+esc(p.sub):'')+'</div>';
}
function _facCard(a,indent){
  var sc=a.status==='operational'?'#22c55e':a.status==='needs-attention'?'#f59e0b':'#ef4444';
  var wos=D.workOrders.filter(function(w){return w.assetId===a.id&&w.status!=='completed';});
  var warranties=(typeof WARRANTY_RECORDS!=='undefined')?WARRANTY_RECORDS.filter(function(w){return w.parentName===a.name;}):[];
  var _bv=a.maintVendor!=null?a.maintVendor:a.vendorOnly,_bi=a.maintInternal!=null?a.maintInternal:(!a.vendorOnly&&!a.subAssetOnly),_bs=a.subAssetOnly;var maintBadge='';if(_bs)maintBadge+='<span style="font-size:9px;background:#f5f3ff;color:#7c3aed;border-radius:4px;padding:2px 5px;font-weight:700;margin-right:3px">SUB-ASSET</span>';if(_bv){maintBadge+='<span style="font-size:9px;background:#eff6ff;color:#3b82f6;border-radius:4px;padding:2px 5px;font-weight:700;margin-right:3px">VENDOR</span>';var _vn=vendorNameById(a.vendorId);if(_vn)maintBadge+='<span onclick="event.stopPropagation();openVendorDetail(\''+a.vendorId+'\')" style="font-size:11px;color:#0891b2;font-weight:700;margin-right:3px;cursor:pointer;text-decoration:underline">'+esc(_vn)+'</span>';}if(_bi)maintBadge+='<span style="font-size:9px;background:#f0fdf4;color:#16a34a;border-radius:4px;padding:2px 5px;font-weight:700;margin-right:3px">IN-HOUSE</span>';
  var warrantyBadge=warranties.length>0?'<span style="font-size:9px;background:#faf5ff;color:#a855f7;border-radius:4px;padding:2px 5px;font-weight:700">📋 WARRANTY</span>':'';
  var hh='<div style="background:var(--card);border-radius:10px;padding:10px 12px;'+(indent?'margin:0 0 5px 22px;border-left:3px solid #c4b5fd':'margin-bottom:5px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:3px solid '+sc)+'" data-rid="'+a.id+'" onclick="openRideDBtn(this)">';
  hh+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">';
  hh+='<div style="flex:1"><div style="font-size:13px;font-weight:800">'+(indent?'↳ ':'')+esc(a.name)+'</div>';
  if(a.manufacturer||a.model)hh+='<div style="font-size:11px;color:var(--muted)">'+esc(a.manufacturer)+(a.model?' · '+esc(a.model):'')+'</div>';
  if(a.serial)hh+='<div style="font-size:10px;font-family:monospace;color:var(--muted)">S/N: '+esc(a.serial)+'</div>';
  hh+='<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">'+maintBadge+warrantyBadge+'</div></div>';
  hh+='<div style="text-align:right;flex-shrink:0">'+pill(a.status.replace(/-/g,' '),sc);
  if(a.currentValue>0)hh+='<div style="font-size:11px;font-weight:700;color:var(--muted);margin-top:4px">'+fmtM(a.currentValue)+'</div>';
  if(wos.length>0)hh+='<div style="font-size:10px;font-weight:700;color:#f59e0b;margin-top:3px">'+wos.length+' open WO</div>';
  hh+='</div></div>';
  hh+=assetPMChip(a.id);
  for(var wi=0;wi<warranties.length;wi++){hh+='<div style="margin-top:5px;padding:4px 8px;background:#faf5ff;border-radius:6px;font-size:11px;color:#7c3aed;font-weight:600">📋 Warranty expires: '+esc(warranties[wi].expires)+'</div>';}
  hh+='</div>';
  return hh;
}
var facSearch='';
function renderFacility(){
  var el=document.getElementById('tab-facility');if(!el)return;
  var FAC_CATS=[
    {key:'facility',       label:'HVAC & Facility',                icon:'🏢'},
    {key:'plumbing',       label:'Plumbing System',                icon:'🚰'},
    {key:'electrical',     label:'Electrical System',              icon:'⚡'},
    {key:'lighting',       label:'Lighting',                       icon:'💡'},
    {key:'fire-safety',    label:'Fire & Life Safety',             icon:'🧯'},
    {key:'envelope',       label:'Building Envelope',              icon:'🧱'},
    {key:'shop-air',       label:'Compressed Air \u2013 Shop/Facility', icon:'💨'},
    {key:'mens-restroom',  label:'Men\u2019s Restroom',            icon:'🚹'},
    {key:'womens-restroom',label:'Women\u2019s Restroom',          icon:'🚺'},
    {key:'food-service',   label:'Kitchen / Concessions',          icon:'🍕'},
    {key:'parking-grounds',label:'Parking Lot & Grounds',          icon:'🅿️'},
    {key:'track-surface',  label:'Track Surface & Barriers',       icon:'🏁'},
    {key:'radio',          label:'Radios & Comms',                 icon:'📻'},
    {key:'scanner',        label:'Ticket Scanners',                icon:'📱'},
    {key:'technology',     label:'Technology (iPads, Phones)',     icon:'💻'},
    {key:'engine-spare',   label:'Spare Engines',                  icon:'⚙️'},
    {key:'transponder',    label:'MyLaps Transponders',            icon:'📡'}
  ];
  var allFA=D.assets.filter(function(a){return a.category!=='ride';});
  var oosFA=allFA.filter(function(a){return a.status==='out-of-service';}).length;
  var vendFA=allFA.filter(function(a){return a.maintVendor!=null?a.maintVendor:a.vendorOnly;}).length;
  var h='<div class="scroll"><div style="padding:10px 14px">';

  // Summary
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
  h+='<div style="background:var(--card);border-radius:10px;padding:8px 14px;text-align:center"><div style="font-size:18px;font-weight:900">'+allFA.length+'</div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Assets</div></div>';
  h+='<div style="background:var(--card);border-radius:10px;padding:8px 14px;text-align:center"><div style="font-size:18px;font-weight:900;color:'+(oosFA>0?'#ef4444':'#22c55e')+'">'+oosFA+'</div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">OOS</div></div>';
  h+='<div style="background:var(--card);border-radius:10px;padding:8px 14px;text-align:center"><div style="font-size:18px;font-weight:900;color:#3b82f6">'+vendFA+'</div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Vendor Maint.</div></div>';
  h+='</div>';
  h+='<div style="display:flex;gap:8px;margin-bottom:12px">';
  h+='<button onclick="openAddAsset()" style="flex:1;background:var(--accent);border:none;color:#fff;border-radius:10px;padding:10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">+ Add Asset</button>';
  h+='<button onclick="openPhotoAssetScanner()" style="flex:1;background:#0891b2;border:none;color:#fff;border-radius:10px;padding:10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">📷 Scan Tag</button>';
  h+='</div>';

  h+='<input id="fac-search" type="text" value="'+escA(facSearch)+'" oninput="facSearchInput(this)" placeholder="Search by name, serial, model, location…" style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;font-family:inherit;margin-bottom:12px"/>';
  var _anames={};for(var _q=0;_q<D.assets.length;_q++)_anames[D.assets[_q].name]=true;
  for(var ci=0;ci<FAC_CATS.length;ci++){
    var fc=FAC_CATS[ci];
    var list=D.assets.filter(function(a){return a.category===fc.key&&(!a.parent||!_anames[a.parent])&&_facMatch(a);});
    if(!list.length)continue;
    h+='<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding:6px 0 4px;border-top:1px solid var(--border);margin-top:6px">'+fc.icon+' '+fc.label+' ('+list.length+')</div>';
    for(var ai=0;ai<list.length;ai++){
      var a=list[ai];h+=_facCard(a,false);var _kids=D.assets.filter(function(k){return k.parent===a.name;});for(var _ki=0;_ki<_kids.length;_ki++)h+=_facCard(_kids[_ki],true);
    }
  }
  if(facSearch&&!allFA.filter(_facMatch).length)h+='<div style="padding:24px 10px;text-align:center;color:var(--muted);font-size:13px">No assets match that search.</div>';
  h+='<div style="height:30px"></div></div></div>';
  el.innerHTML=h;
}
function _facMatch(a){
  if(!facSearch) return true;
  var q=String(facSearch).toLowerCase(), fs=['name','serial','model','manufacturer','category','location','notes'];
  for(var i=0;i<fs.length;i++){ if(String(a[fs[i]]||'').toLowerCase().indexOf(q)>=0) return true; }
  return false;
}
function facSearchInput(inp){ facSearch=inp.value; renderFacility(); var n=document.getElementById('fac-search'); if(n){ n.focus(); var v=n.value; n.value=''; n.value=v; } }


var woFilter='all';var woShown=200;var woShowDone=false;var woDoneShown=200;var woSort='created';var woSortDir='desc';var woSearch='';var woType='all';var woFrom='';var woTo='';

function setWOF(f){woFilter=f;woShown=200;renderWOs();}
var pageStack=[];var pgReturnTab=null;
function pgShow(){var ps=document.querySelectorAll('.panel');for(var i=0;i<ps.length;i++)ps[i].classList.remove('on');var bs=document.querySelectorAll('.ntab');for(var i=0;i<bs.length;i++)bs[i].classList.remove('on');var p=document.getElementById('tab-page');if(p)p.classList.add('on');var f=document.getElementById('fab');if(f)f.style.display='none';closeM('detailSheet');closeM('drillSheet');var sc=document.querySelector('#tab-page .scroll');if(sc)sc.scrollTop=0;}
function pgPush(d){if(!pageStack.length)pgReturnTab=curTab;pageStack.push(d);pgRender();if(typeof _navArm==='function')_navArm();}
function pgPop(){pageStack.pop();if(pageStack.length)pgRender();else{setTab(pgReturnTab||'dashboard');}}
function pgRender(){var d=pageStack[pageStack.length-1];if(!d){return;}
  if(d.kind==='kart'){var ks=(D.karts&&D.karts[d.track])||[],k=null;for(var i=0;i<ks.length;i++)if(ks[i].id===d.kartId){k=ks[i];break;}if(!k){pgPop();return;}apKartId=d.kartId;apKartTrack=d.track;apName=kartLabel(k);renderAssetPage(apName,k,null);}
  else if(d.kind==='asset'){var a=assetById(d.id);if(!a){pgPop();return;}renderAssetPage(a.name,null,a);}
  else if(d.kind==='wo'){renderWOPage(d.id);}
  else if(d.kind==='arc'){var _am=(typeof arcById==='function')?arcById(d.id):null;if(!_am){pgPop();return;}renderArcPage(_am);}
  pgShow();}
function openWOD(id){var t=pageStack[pageStack.length-1];if(t&&t.kind==='wo'&&t.id===id){pgRender();return;}if(typeof _maybeAskEngineKartPull==='function')_maybeAskEngineKartPull(id);pgPush({kind:'wo',id:id});}
function escA(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
// Turn any <select> into a type-to-search combobox. Keeps the real <select>
// as the value holder, so .value reads and onchange handlers are unchanged.
// Idempotent: call again after repopulating options to re-sync the display.
function makeSearchable(selId){
  var sel=document.getElementById(selId); if(!sel) return;
  if(sel._si){ var oo=sel.options[sel.selectedIndex]; sel._si.value=(oo&&oo.value)?oo.text:''; return; }
  sel.style.display='none';
  var wrap=document.createElement('div'); wrap.style.cssText='position:relative';
  sel.parentNode.insertBefore(wrap,sel); wrap.appendChild(sel);
  var inp=document.createElement('input'); inp.type='text'; inp.setAttribute('autocomplete','off');
  inp.setAttribute('style', sel.getAttribute('style')||''); inp.style.display='';
  inp.placeholder='Type to search\u2026';
  var cur=sel.options[sel.selectedIndex]; inp.value=(cur&&cur.value)?cur.text:'';
  wrap.appendChild(inp); sel._si=inp;
  var dd=document.createElement('div');
  dd.style.cssText='position:absolute;left:0;right:0;top:100%;margin-top:2px;background:var(--card);border:1.5px solid var(--accent);border-radius:8px;max-height:230px;overflow:auto;z-index:9999;display:none;box-shadow:0 8px 20px rgba(0,0,0,.18)';
  wrap.appendChild(dd);
  function paint(q){
    q=(q||'').toLowerCase().trim(); var html='',n=0;
    for(var i=0;i<sel.options.length;i++){ var o=sel.options[i]; if(!o.value) continue;
      if(q && o.text.toLowerCase().indexOf(q)<0) continue;
      html+='<div data-v="'+escA(o.value)+'" style="padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px">'+esc(o.text)+'</div>';
      if(++n>=80) break; }
    dd.innerHTML = html || '<div style="padding:8px 10px;color:var(--muted);font-size:12px">No match</div>';
  }
  inp.addEventListener('focus',function(){ paint(''); dd.style.display='block'; });
  inp.addEventListener('input',function(){ paint(inp.value); dd.style.display='block'; });
  inp.addEventListener('blur',function(){ setTimeout(function(){ dd.style.display='none'; var o=sel.options[sel.selectedIndex]; inp.value=(o&&o.value)?o.text:''; },170); });
  dd.addEventListener('mousedown',function(e){
    var t=e.target; while(t && t!==dd && !(t.dataset&&t.dataset.v!=null)) t=t.parentNode;
    if(t && t.dataset && t.dataset.v!=null){ e.preventDefault(); sel.value=t.dataset.v; inp.value=t.textContent; dd.style.display='none'; if(typeof sel.onchange==='function') sel.onchange.call(sel); }
  });
}
function partIdByName(n){if(!n||!D.parts)return null;var k=ahNorm(n);for(var i=0;i<D.parts.length;i++){if(D.parts[i].movedToPartId)continue;if(ahNorm(D.parts[i].name)===k)return D.parts[i].id;var ak=D.parts[i].aka;if(ak)for(var a=0;a<ak.length;a++)if(ahNorm(ak[a])===k)return D.parts[i].id;}for(var j=0;j<D.parts.length;j++){var ak2=D.parts[j].aka;if(ak2)for(var b=0;b<ak2.length;b++)if(ahNorm(ak2[b])===k)return D.parts[j].id;}return null;}
function kartByName(n){if(!n||!D.karts)return null;var k=ahNorm(n),tr=['euro','road','sprint','kiddie'];for(var t=0;t<tr.length;t++){var ks=D.karts[tr[t]]||[];for(var i=0;i<ks.length;i++){var kk=ks[i];var pf=(typeof TRACK_PREFIX!=='undefined'&&TRACK_PREFIX[kk.track])||kk.track;var labels=[kartLabel(kk),pf+' '+kk.num];if(kk.altName)labels.push(kk.altName);for(var li=0;li<labels.length;li++)if(ahNorm(labels[li])===k)return {kartId:kk.id,track:tr[t]};}}return (typeof kartResolveLoose==='function')?kartResolveLoose(n):null;}
function assetByName(n){if(!n||!D.assets)return null;var k=ahNorm(n);for(var i=0;i<D.assets.length;i++)if(ahNorm(D.assets[i].name)===k)return D.assets[i];return null;}
function openAssetFromWO(n){var kr=kartByName(n);if(kr){openKartPage(kr.kartId,kr.track);return;}var a=assetByName(n);if(a){pgPush({kind:'asset',id:a.id});}}
function woSystem(w){var s=((w.title||'')+' '+(w.procedureName||'')+' '+(w.description||'')).toLowerCase();
var M=[['engine',/smok|carb|spark|stall|won'?t start|no[- ]start|recoil|governor|\brpm\b|idle|fuel|\bgas\b|exhaust|muffler|valve|piston|compress|\bengine\b|\boil\b|head gasket/],
['brakes',/brake|caliper|rotor|master cyl/],
['tires/wheels',/tire|wheel|\brim\b|\bhub\b|\bflat\b/],
['steering',/steer|tie ?rod|kingpin|align/],
['drivetrain',/chain|sprocket|clutch|\baxle\b|driveline|bearing/],
['electrical',/kartrol|wiring|\bground\b|\bswitch\b|battery|transponder|kill ?switch|solenoid|electric/],
['safety',/seat ?belt|harness|restraint|bumper|\bpod\b/],
['body/chassis',/weld|frame|chassis|\bbody\b|panel|\bseat\b|fairing/]];
for(var i=0;i<M.length;i++)if(M[i][1].test(s))return M[i][0];return 'general';}
function woRelRow(w,reason){var TCOL={'pre-op':'#0d9488','compliance':'#b45309','operational':'#64748b','preventive':'#3b82f6','reactive':'#8b5cf6','vendor':'#0891b2'};var col=TCOL[w.type]||'#3b82f6',dt=w.completed||w.created||'';var rc=reason?' <span style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700;color:var(--muted)">'+esc(reason)+'</span>':'';return '<div class="wo-card" style="border-left-color:'+col+'" data-wid="'+w.id+'" onclick="openWODBtn(this)"><div style="display:flex;justify-content:space-between;gap:8px"><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;margin-bottom:2px">'+esc(w.title||w.procedureName||w.type)+'</div><div style="font-size:10px;color:var(--muted)">'+esc(dt)+rc+'</div></div>'+pill(w.type,col)+'</div></div>';}
function woAssetOpts(sel){
  var o='<option value="">\u2014 pick an asset \u2014</option>',tr=['euro','road','sprint','kiddie'];
  if(D.karts){for(var t=0;t<tr.length;t++){var ks=D.karts[tr[t]]||[];for(var i=0;i<ks.length;i++){var nm=kartLabel(ks[i]);o+='<option value="'+escA(nm)+'"'+(nm===sel?' selected':'')+'>'+esc(nm)+'</option>';}}}
  for(var i=0;i<D.assets.length;i++){var nm=D.assets[i].name;o+='<option value="'+escA(nm)+'"'+(nm===sel?' selected':'')+'>'+esc(nm)+'</option>';}
  return o;
}
function assignWO(id){
  var sel=document.getElementById('wo-assign-asset');
  var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){w=D.workOrders[i];break;}
  if(!w)return;
  var nm=sel?sel.value:'';
  if(nm){w.assetId=nm;woLog(w,'Assigned to '+nm+' (from review)');}
  w.needsReview=false;woLog(w,'Reviewed & approved');
  saveWO(w);pgRender();
}
// ── Email-origin WO suppression ───────────────────────────────────────────
// Forwarded-email purchases get re-created server-side as new rows on every
// sync. Once the user moves one to Parts (or deletes it), remember its
// fingerprint so any re-ingested copy is auto-removed instead of reappearing.
function _emailWoFp(w){
  if(!w) return null;
  if(w.emailFingerprint) return 'fp:'+w.emailFingerprint;
  var s=(w.emailSubject||w.title||'').toLowerCase().replace(/^((re|fwd|fw)\s*:\s*)+/,'').trim();
  var who=(w.emailFrom||w.vendorName||'').toLowerCase().trim();
  if(!s) return null;
  return 'em:'+who+'|'+s;
}
function _isEmailWO(w){ return !!(w&&(w.emailFrom||w.emailFingerprint||w.emailSubject||w.receiptUrl||w.needsReview)); }
function dismissEmailWO(w, action){
  if(!_isEmailWO(w)) return;
  var fp=_emailWoFp(w); if(!fp) return;
  if(!D.dismissedEmailWOs) D.dismissedEmailWOs={};
  D.dismissedEmailWOs[fp]={date:(typeof today==='function'?today():''),action:action||'moved',name:(w.title||'')};
  if(typeof dbSaveSingleton==='function') dbSaveSingleton('dismissedEmailWOs');
}
function _inspDisplayName(insId){
  if(typeof getInspById!=='function') return null;
  var insp=getInspById(insId); if(!insp) return null;
  var LBL={euro:'Euro Track Pre-Op',road:'Road Track Pre-Op',sprint:'Sprint Track Pre-Op',kiddie:'Kiddie Track Pre-Op',tornado:'Tornado Inspection',dragon:'Dragon Coaster Inspection',slide:'Fun Slide Inspection'};
  return insp.title||LBL[insp.templateKey]||insp.templateKey||null;
}
function _cleanupFlagWOs(){
  if(!D.workOrders||!D.workOrders.length) return 0;
  var RIDES=['Tornado','Dragon Coaster','Fun Slide'], idx={};
  for(var r=0;r<RIDES.length;r++){
    var t=(typeof PREOP_TEMPLATES!=='undefined')?PREOP_TEMPLATES[RIDES[r]]:null; if(!t||!t.items) continue;
    for(var i=0;i<t.items.length;i++){ var lab=(t.items[i].label||'').trim().toLowerCase(); if(lab) idx[lab]=RIDES[r]; }
  }
  var PASS={pass:1,sat:1,recorded:1};
  var RN={tornado:'Tornado',dragon:'Dragon Coaster',slide:'Fun Slide'};
  // Resolve what the inspector actually recorded for the item behind a flag WO.
  function srcResp(wo){
    if(wo.flaggedResp) return wo.flaggedResp;
    var iid=wo.inspId, note=(wo.notes&&wo.notes.join)?wo.notes.join(' '):'';
    if(!iid){ var m=note.match(/INS-[A-Za-z0-9-]+/); if(m) iid=m[0]; }
    if(!iid||typeof getInspById!=='function') return null;
    var insp=getInspById(iid); if(!insp||!insp.roadState||!insp.roadState.flags) return null;
    var fl=insp.roadState.flags, itemId=wo.inspItemId;
    if(!itemId){
      var emi=(wo.title||'').indexOf('\u2014'); var lab=emi>=0?wo.title.substring(emi+1).trim().toLowerCase():'';
      if(lab){
        var items=null, tk=insp.templateKey;
        if(RN[tk] && typeof PREOP_TEMPLATES!=='undefined' && PREOP_TEMPLATES[RN[tk]]) items=PREOP_TEMPLATES[RN[tk]].items;
        else if(typeof INSP_CHECKLISTS!=='undefined' && INSP_CHECKLISTS[tk]) items=INSP_CHECKLISTS[tk];
        if(items) for(var ii=0;ii<items.length;ii++){ if((items[ii].label||'').trim().toLowerCase()===lab){ itemId=items[ii].id; break; } }
      }
    }
    if(itemId && fl[itemId] && fl[itemId][0]) return fl[itemId][0].resp;
    return null;
  }
  var all=(typeof allKarts==='function')?allKarts():[], fixed=0, kill=[];
  for(var w=0;w<D.workOrders.length;w++){
    var wo=D.workOrders[w], changed=false, title=wo.title||'';
    var noteStr=(wo.notes&&wo.notes.join)?wo.notes.join(' '):'';
    var isFlagWO=!!(wo.inspId || /^(Monitor|DEFICIENCY|SYSTEM DEFICIENCY|Replace D-Rubber):/.test(title) || noteStr.indexOf('during INS-')>=0);
    // (c) bogus WO from a PASSED item — should never have been created (only remove if still open)
    if(isFlagWO && wo.status==='open'){
      var sr=srcResp(wo);
      if(sr && PASS[sr]){ kill.push(wo.id); continue; }
    }
    // (a) orphaned ride flag "Kart #?" -> remap to the ride by its item label
    if(title.indexOf('Kart #?')>=0){
      var emi=title.indexOf('\u2014'); var lab=emi>=0?title.substring(emi+1).trim().toLowerCase():'';
      var ride=idx[lab]||(wo.inspItemLabel?idx[String(wo.inspItemLabel).trim().toLowerCase()]:null);
      if(ride){ wo.title=title.replace('Kart #?',ride); wo.assetId=ride; wo.kartId=null; changed=true; }
    }
    // (b) kart-track flag under "TRK001" -> link to the real kart
    if(wo.assetId==='TRK001' && wo.kartId){
      var k=null; for(var ki=0;ki<all.length;ki++){ if(all[ki].id===wo.kartId){ k=all[ki]; break; } }
      if(k){ wo.assetId=(typeof kartLabel==='function'?kartLabel(k):(k.name||wo.assetId)); changed=true; }
    }
    // (d) reword old activity-log notes: INS id -> inspection name + completion date
    if(wo.notes && wo.notes.length){
      for(var n=0;n<wo.notes.length;n++){
        var nt=String(wo.notes[n]||''), mm=nt.match(/during (INS-[A-Za-z0-9-]+) on (\S+)/);
        if(mm){ var nm=_inspDisplayName(mm[1]); if(nm){ wo.notes[n]=nt.replace(/during INS-[A-Za-z0-9-]+ on \S+/, 'during '+nm+' (completed '+mm[2]+')'); changed=true; } }
      }
    }
    // (d2) same reword inside the description field (e.g. manager pulled-OOS WOs)
    if(wo.description){
      var dm=String(wo.description).match(/during (INS-[A-Za-z0-9-]+) on ([0-9-]+)/);
      if(dm){ var dn=_inspDisplayName(dm[1]); if(dn){ wo.description=wo.description.replace(/during INS-[A-Za-z0-9-]+ on [0-9-]+/, 'during '+dn+' (completed '+dm[2]+')'); changed=true; } }
    }
    if(changed){ if(typeof dbSave==='function') dbSave('work_orders',wo); fixed++; }
  }
  if(kill.length){
    D.workOrders=D.workOrders.filter(function(x){return kill.indexOf(x.id)<0;});
    for(var d=0;d<kill.length;d++){ if(typeof dbRemove==='function') dbRemove('work_orders',kill[d]); }
  }
  return fixed+kill.length;
}
function suppressDismissedWOs(){
  if(!D.dismissedEmailWOs||!D.workOrders) return 0;
  var n=0;
  for(var i=D.workOrders.length-1;i>=0;i--){ var w=D.workOrders[i];
    if(w.status==='completed') continue;
    if(!_isEmailWO(w)) continue;
    var fp=_emailWoFp(w);
    if(fp && D.dismissedEmailWOs[fp]){
      var id=w.id; D.workOrders.splice(i,1);
      if(typeof dbRemove==='function') dbRemove('work_orders',id);
      n++;
    }
  }
  return n;
}
// Collapse duplicate OPEN work orders automatically (so the user never has to
// hit "merge"). Only the unambiguous cases: PM WOs (one open kart-PM per kart,
// hour-tiers share a bucket; annual stays separate) and forwarded-email WOs
// (one per fingerprint). Reactive WOs are left to the manual merge tool.
function _pmTierToken(w){
  if(w.pmKey) return /^\d+hr$/.test(w.pmKey)?'tier':w.pmKey;   // hour-tiers share one bucket; annual separate
  var t=(w.title||'').toLowerCase();
  if(w.type==='preventive'||w.recurring) return /annual/.test(t)?'annual':'tier';
  if(/\bpm\b|preventive|\d+\s*hour/.test(t)) return /annual/.test(t)?'annual':'tier';  // title-only PMs (no pmKey)
  return null;
}
function _woDedupeKey(w){
  if(!w||w.status==='completed'||w.type==='vendor') return null;
  var tier=_pmTierToken(w);
  if(tier){
    var k=(typeof kartByName==='function')?kartByName(w.assetId):null;
    var asset = (k&&k.kartId!=null) ? ('k:'+k.track+':'+k.kartId) : ((typeof ahNorm==='function')?ahNorm(w.assetId||''):String(w.assetId||'').toLowerCase());
    if(!asset) return null;
    return 'pm:'+asset+':'+tier;
  }
  if(_isEmailWO(w)){ var fp=_emailWoFp(w); return fp?('em:'+fp):null; }
  return null;
}
function autoDedupeWOs(){
  if(!D.workOrders) return 0;
  var keep={}, n=0, remap={}, touched={};
  for(var i=0;i<D.workOrders.length;i++){ var w=D.workOrders[i]; var k=_woDedupeKey(w); if(!k) continue;
    if(!keep[k]) keep[k]=w;
    else { var a=String(keep[k].created||''), b=String(w.created||''); if(b<a) keep[k]=w; } }
  for(var j=D.workOrders.length-1;j>=0;j--){ var w2=D.workOrders[j]; var k2=_woDedupeKey(w2); if(!k2) continue;
    if(keep[k2] && keep[k2].id!==w2.id){
      if(k2.indexOf('pm:')!==0 && typeof _mergeWOEvidence==='function'){ try{_mergeWOEvidence(keep[k2],w2);}catch(e){} } // PMs: don't merge (their description is the task list)
      remap[w2.id]=keep[k2].id;
      touched[keep[k2].id]=keep[k2];   // only THIS keeper changed
      var id=w2.id; D.workOrders.splice(j,1); if(typeof dbRemove==='function') dbRemove('work_orders',id); n++;
    } }
  // Save ONLY the keepers that actually absorbed a merge — not the entire kept set.
  // Re-saving every kept WO bumped updated_at on hundreds of untouched archive rows
  // each load, which re-wrote the whole archive to the server and inflated the
  // cache delta. Now a clean load with no real duplicates writes nothing.
  if(n){ for(var tid in touched){ if(typeof saveWO==='function') saveWO(touched[tid]); } _dedupeShifts(remap); }
  return n;
}
// After removing duplicate WOs, repoint their shifts to the keeper and keep
// only one scheduled block per PM work order (so the schedule shows it once).
function _dedupeShifts(remap){
  if(!D.shifts||!D.shifts.length) return;
  var changed=false;
  for(var i=0;i<D.shifts.length;i++){ var s=D.shifts[i]; if(s.woId && remap && remap[s.woId]){ s.woId=remap[s.woId]; changed=true; } }
  var firstByWO={}, rm=[];
  for(var i=0;i<D.shifts.length;i++){ var s=D.shifts[i]; if(!s.woId) continue;
    var w=(typeof woById==='function')?woById(s.woId):null; if(!(w&&(w.type==='preventive'||w.pmKey||w.recurring))) continue; // only collapse PM blocks
    if(firstByWO[s.woId]) rm.push(i); else firstByWO[s.woId]=true; }
  for(var x=rm.length-1;x>=0;x--){ var idx=rm[x], sid=D.shifts[idx].id; D.shifts.splice(idx,1); if(typeof dbRemove==='function') dbRemove('shifts',sid); changed=true; }
  if(changed){ for(var i=0;i<D.shifts.length;i++) if(typeof dbSave==='function') dbSave('shifts',D.shifts[i]); }
}
function deleteWO(id){
  var idx=-1;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){idx=i;break;}
  if(idx<0)return;
  var w=D.workOrders[idx];
  if(!confirm('Move this work order to Deleted? You can restore it later.\n\n'+(w.title||w.id)))return;
  w.deleted=true; w.deletedAt=(typeof woNow==='function'?woNow():(typeof today==='function'?today():'')); w.deletedBy=(currentUser&&currentUser.name)||'';
  saveWO(w);
  D.workOrders.splice(idx,1);
  D.deletedWorkOrders=D.deletedWorkOrders||[]; D.deletedWorkOrders.push(w);
  try{dismissEmailWO(w,'deleted');}catch(e){}
  try{var top=pageStack[pageStack.length-1];if(top&&top.kind==='wo'&&top.id===id){pgPop();}}catch(e){}
  try{if(typeof renderWOs==='function')renderWOs();}catch(e){}
  try{if(typeof updateBadges==='function')updateBadges();}catch(e){}
}
function _partitionDeletedWOs(){
  if(!D.workOrders)return;
  D.deletedWorkOrders=D.deletedWorkOrders||[];
  var keep=[];
  for(var i=0;i<D.workOrders.length;i++){var w=D.workOrders[i];
    if(w&&w.deleted){var f=false;for(var j=0;j<D.deletedWorkOrders.length;j++){if(D.deletedWorkOrders[j].id===w.id){D.deletedWorkOrders[j]=w;f=true;break;}}if(!f)D.deletedWorkOrders.push(w);}
    else keep.push(w);
  }
  D.workOrders=keep;
}
function restoreWO(id){
  D.deletedWorkOrders=D.deletedWorkOrders||[];
  var idx=-1;for(var i=0;i<D.deletedWorkOrders.length;i++)if(D.deletedWorkOrders[i].id===id){idx=i;break;}
  if(idx<0)return;
  var w=D.deletedWorkOrders[idx];
  w.deleted=false; w.restoredAt=(typeof woNow==='function'?woNow():(typeof today==='function'?today():''));
  D.deletedWorkOrders.splice(idx,1);
  D.workOrders=D.workOrders||[]; D.workOrders.push(w);
  saveWO(w);
  try{if(typeof renderDeletedWOs==='function')renderDeletedWOs();}catch(e){}
  try{if(typeof renderWOs==='function')renderWOs();}catch(e){}
  try{if(typeof updateBadges==='function')updateBadges();}catch(e){}
}
function purgeWO(id){
  if(!confirm('Permanently delete this work order? This cannot be undone.'))return;
  D.deletedWorkOrders=(D.deletedWorkOrders||[]).filter(function(x){return x.id!==id;});
  if(typeof dbRemove==='function')dbRemove('work_orders',id);
  if(typeof renderDeletedWOs==='function')renderDeletedWOs();
}
function openDeletedWOs(){renderDeletedWOs();openM('deletedWOModal');}
function renderDeletedWOs(){
  var b=document.getElementById('deletedwo-body');if(!b)return;
  var a=(D.deletedWorkOrders||[]).slice().sort(function(x,y){return String(y.deletedAt||'').localeCompare(String(x.deletedAt||''));});
  if(!a.length){b.innerHTML='<div style="text-align:center;color:var(--muted);font-size:13px;padding:24px">No deleted work orders.</div>';return;}
  var h='';
  for(var i=0;i<a.length;i++){var w=a[i];
    h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px">';
    h+='<div style="font-size:10px;font-weight:700;color:var(--muted);font-family:monospace">'+esc(w.id)+'</div>';
    h+='<div style="font-size:14px;font-weight:700;margin:1px 0 2px">'+esc(w.title||'(untitled)')+'</div>';
    h+='<div style="font-size:10px;color:var(--muted)">'+esc(w.assetId||'')+(w.deletedBy?' \u00b7 deleted by '+esc(w.deletedBy):'')+(w.deletedAt?' \u00b7 '+esc(w.deletedAt):'')+'</div>';
    h+='<div style="display:flex;gap:6px;margin-top:8px">';
    h+='<button onclick="restoreWO(\''+escA(w.id)+'\')" style="flex:1;background:#16a34a;border:none;color:#fff;border-radius:8px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Restore</button>';
    h+='<button onclick="purgeWO(\''+escA(w.id)+'\')" style="background:var(--card);border:1.5px solid #fca5a5;color:#dc2626;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Delete forever</button>';
    h+='</div></div>';
  }
  b.innerHTML=h;
}
function convertWOToPartOrder(id){
  var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){w=D.workOrders[i];break;}
  if(!w)return;
  var nm=(w.title||'').replace(/^((re|fwd|fw)\s*:\s*)+/i,'').trim()||'Part purchase';
  var pu=(w.partsUsed||[]).filter(function(it){return it&&String(it.name||'').trim();});
  var msg=(pu.length>1)
    ? ('Move this to Parts as '+pu.length+' separate line items?\n\n\u201c'+nm+'\u201d\n\nEach part lands on the Parts order list, where you can mark them received into stock.')
    : ('Move this to Parts as a purchase/order?\n\n\u201c'+nm+'\u201d\n\nIt will be removed from Work Orders and added to the Parts order list, where you can mark it received into stock.');
  if(!confirm(msg))return;
  if(!D.partOrders)D.partOrders=[];
  var vend=(w.vendorName||w.emailFrom||'');
  function _mkLine(name,qty,unitCost){
    var p=(typeof partByName==='function')?partByName(name):null;
    return {id:nid('PO'),partId:p?p.id:null,partName:name,partNumber:p?(p.partNumber||''):'',
      qty:Number(qty)||1,woId:'',woTitle:'',assetId:'',
      vendor:(vend||(p&&p.vendors)||''),
      unitCost:(Number(unitCost)||(p?Number(p.unitCost)||0:0)),
      usedOn:p?(p.usedOn||[]):[],status:'ordered',orderedDate:today(),created:today(),
      addedBy:(typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||'',
      receiptUrl:w.receiptUrl||'',receiptName:w.receiptName||'',
      note:'Moved from a forwarded-email work order'+(w.emailFrom?' (from '+w.emailFrom+')':'')};
  }
  if(pu.length){
    for(var k=0;k<pu.length;k++){var it=pu[k];var q=Number(it.qty)||1;var unit=(it.cost!=null)?(Number(it.cost)/q):0;var line=_mkLine(it.name,q,unit);if(typeof _poPushOrMerge==='function')_poPushOrMerge(line);else{D.partOrders.push(line);dbSave('part_orders',line);}}
  } else {
    var line=_mkLine(nm,1,(Number(w.cost)||0));if(typeof _poPushOrMerge==='function')_poPushOrMerge(line);else{D.partOrders.push(line);dbSave('part_orders',line);}
  }
  var idx=-1;for(var j=0;j<D.workOrders.length;j++)if(D.workOrders[j].id===id){idx=j;break;}
  if(idx>=0)D.workOrders.splice(idx,1);
  dbRemove('work_orders',id);
  dismissEmailWO(w,'moved-to-parts');
  try{var top=pageStack[pageStack.length-1];if(top&&top.kind==='wo'&&top.id===id){pgPop();}}catch(e){}
  window._partsView='orders';
  alert((pu.length>1?(pu.length+' items moved'):'Moved')+' to Parts \u2192 Order List. Open it there and tap \u201cMark received\u201d to add into stock.');
  if(typeof setTab==='function')setTab('parts');
}
// ── PM CHECKLIST ────────────────────────────────────────────────────────────
// Turns a preventive WO's task text into a saved, checkable list with fill-ins.
// Per-task how-to guidance, keyed by phrases found in the task label.
// Longest matching key wins, so "drive belt" beats a generic "belt".
var PM_HOWTO = {
 'record hours':['Read the engine-hour meter (or the kart hours shown in the app).','Write the current reading on this work order - it sets the clock for the next service.'],
 'engine oil':['Run the engine 2-3 min to warm the oil, then shut off.','Place a drain pan; remove the drain plug and the dipstick. Tip the kart slightly to drain fully.','Reinstall the drain plug with a NEW crush washer - torque about 13 ft-lb.','Refill 10W-30/10W-40 to the upper dipstick mark: GX160/200 about 0.6 L, GX270 about 1.0 L. Do NOT overfill.','Run briefly and check the drain plug for leaks.'],
 'reduction gear':['On reduction-drive karts, check the reduction-case oil level.','Top up to spec with the same engine oil. Check the case seam for leaks.'],
 'air filter':['Remove the cover and take out the element.','Foam: wash in warm soapy water, rinse, dry fully, then dip in clean engine oil and squeeze out the excess.','Paper: tap out the dust; replace if clogged, oily, or torn.','Reinstall. In dusty desert conditions, service more often than the interval.'],
 'spark plug':['Pull the plug with a plug wrench. Read the tip: tan/grey = good, black = rich/fouled, white = lean.','Clean or replace (NGK BP6ES). Set the gap to 0.7-0.8 mm.','Torque to about 13 ft-lb and push the wire on firmly.'],
 'fuel strainer':['Close the fuel valve first.','Remove the sediment cup / inline strainer and clean it (or replace an inline filter - arrow points toward the carb).','Open the valve and check for leaks.'],
 'fuel line':['Inspect the rubber fuel lines for cracks, hardening, or weeping.','Replace any suspect line - ethanol and heat harden them over time. Use proper fuel hose and clamps.'],
 'tire':['Check all four tires with a gauge. Specs: Road/Family 40-50 PSI, Euro front 23-25 / rear 25-28, Sprint 30 PSI.','Inspect tread and sidewalls for cuts or flat spots.','Inflate to spec and recheck after seating.'],
 'brake fluid':['Check the master-cylinder reservoir level and top to the line.','Karts use DOT 5 silicone - do NOT mix with DOT 3/4.','Low fluid usually means worn pads or a leak - investigate before topping off.'],
 'brake pad':['Inspect pad / lining thickness.','Replace if total thickness is below 8 mm (4 mm of lining minimum).','Check the disc/band surface for scoring while you are in there.'],
 'brake line':['Inspect brake lines and hoses for cracks, leaks, chafing, and loose fittings.','Replace any line that is cracked or weeping, then bleed the system.'],
 'valve clearance':['Engine COLD. Remove the valve cover.','Rotate to TDC on the compression stroke (both valves closed, slight rocker free-play).','Feeler gauge: GX160/200 IN 0.15 / EX 0.20 mm; GX270 IN 0.15 / EX 0.25 mm.','Adjust at the locknut and screw, recheck, then refit the cover with a new gasket.'],
 'drive belt':['Remove the belt guard and inspect for glazing, cracks, or fraying.','Check deflection - no more than about 1/2 inch of give.','Replace as a SET, never just one belt. Re-adjust the throttle linkage afterward.'],
 'drive chain':['Check chain tension - about 1/2 inch of play at mid-span.','Inspect for stretch, tight links, and hooked sprocket teeth.','Clean, lube, and align the sprockets. Replace if stretched or hooked.'],
 'spindle':['Grease the spindle / kingpin fittings.','Rock each front tire top-to-bottom - excessive play means a worn bearing or spindle.','Inspect spindles for any bend or crack. ANY crack = take the kart out of service.'],
 'front hub':['Torque the front hubs to 50 ft-lb.'],
 'lug':['Torque the wheel lug nuts to 35 ft-lb in a star/cross pattern.'],
 'axle':['Inspect the axle for bend or cracks.','Check the axle bearings for play; clean and grease them.'],
 'alignment':['Check front toe - tires should track nearly parallel (karts run a slight toe-out).','Adjust the tie rods equally on both sides.','Verify the kart tracks straight with no pulling.'],
 'nuts & bolts':['Walk the whole kart and check/torque the critical fasteners: seat, steering, pedals, engine mounts, bumpers, and wheels.','Snug anything loose to spec.'],
 'nuts and bolts':['Walk the whole kart and check/torque the critical fasteners: seat, steering, pedals, engine mounts, bumpers, and wheels.','Snug anything loose to spec.'],
 'linkage':['Lube the steering shaft, tie-rod ends, and the throttle/brake pivots with light oil or grease.','Verify everything moves freely and the throttle returns fully on its own.'],
 'starter rope':['Inspect the recoil rope for fraying or glazing.','Check that the intake/fan screen is clear of debris so the engine breathes.'],
 'combustion chamber':['Remove the head and scrape carbon from the chamber and piston crown.','Reassemble with a new head gasket and torque to spec.'],
 'bearing':['Clean and inspect the bearings.','Repack with waterproof grease; replace any that are rough or have play.'],
 'condensate':['Open the air-tank drain valve to release the water that collects in the tank.','Close it once only air escapes. Do this daily - standing water rusts the tank.'],
 'compressor oil':['Check the compressor oil level (sight glass or dipstick).','Top up or change to the specified compressor oil, and look for leaks.'],
 'relief valve':['With the tank pressurized, pull the safety/relief valve ring.','It should vent sharply and reseat cleanly. If it will not reseat or will not vent, replace it.'],
 'lap bar':['Activate the air lock - all lap bars should release together.','Inspect the hinge bolts and latches; nothing should bind or stay locked.']
};
function matchPmHowto(label){
  var L=String(label||'').toLowerCase(), best=null, bestLen=0;
  for(var k in PM_HOWTO){ if(L.indexOf(k)>=0 && k.length>bestLen){ best=PM_HOWTO[k]; bestLen=k.length; } }
  return best;
}
function pmChecklistItems(w){
  if(!w) return null;
  var isPM = w.type==='preventive' || w.pmKey || w.recurring;
  if(!isPM) return null;
  if(w.pmItems && w.pmItems.length){ _pmRepairItems(w); _pmSeedParts(w); return w.pmItems; }       // already built
  if(w.status==='completed') return null;                    // don't retro-build old completed PMs
  var src = w.description || '';
  if(!src || src.indexOf('Symptom:')===0) return null;
  var parts = src.split(/\.\s+/).map(function(s){return s.replace(/\.\s*$/,'').trim();}).filter(function(s){return s.length>1;});
  // Collapse duplicate task labels. A PM description can get concatenated/inflated
  // (e.g. a "50 Hour" block repeated many times), which would otherwise render every
  // task over and over. De-dupe here so the checklist is clean on the very first build.
  var _seen={}, _uniq=[];
  for(var _i=0;_i<parts.length;_i++){ var _k=parts[_i].toLowerCase(); if(_seen[_k]) continue; _seen[_k]=1; _uniq.push(parts[_i]); }
  parts=_uniq;
  if(parts.length<2) return null;
  w.pmItems = parts.map(function(p){return {label:p, done:false, value:''};});
  w.description = parts.join('. ')+'.';
  _pmSeedParts(w);
  saveWO(w);
  return w.pmItems;
}
// Put a PM's parts into the SAME partsUsed list every WO uses (once), and set
// the initial estimated time. Runs for existing PMs too, not just new ones.
function _pmSeedParts(w){
  if(!w || w.status==='completed' || !w.pmItems) return;
  try{
    var pc=pmComputeParts(w, w.pmItems), changed=false;
    if(w.estMins==null){ w.estMins=pc.totMins; changed=true; }
    if(!w.partsUsed || !w.partsUsed.length){
      w.partsUsed=pc.parts.map(function(p){return {name:p.name, qty:p.qty, unit:p.unit, cost:Math.round(p.qty*p.unitCost*100)/100};});
      changed=true;
    }
    if(changed && typeof saveWO==='function') saveWO(w);
  }catch(e){}
}
// Repair PMs whose checklist got duplicated (e.g. by an over-eager merge):
// collapse repeated tasks, then recompute time/parts/description from the clean list.
function _pmRepairItems(w){
  if(!w || !(w.type==='preventive'||w.pmKey||w.recurring) || !w.pmItems || !w.pmItems.length) return false;
  var seen={}, uniq=[], dup=false;
  for(var i=0;i<w.pmItems.length;i++){ var lab=(w.pmItems[i].label||'').trim().toLowerCase(); if(!lab) continue; if(seen[lab]){ dup=true; continue; } seen[lab]=1; uniq.push(w.pmItems[i]); }
  if(!dup) return false;
  w.pmItems=uniq;
  try{ var pc=pmComputeParts(w, w.pmItems); w.estMins=pc.totMins; w.partsUsed=pc.parts.map(function(p){return {name:p.name, qty:p.qty, unit:p.unit, cost:Math.round(p.qty*p.unitCost*100)/100};}); }catch(e){}
  w.description=uniq.map(function(it){return it.label;}).join('. ')+'.';
  if(typeof saveWO==='function') saveWO(w);
  return true;
}
function woPmToggle(wid, idx){
  var w=woById(wid); if(!w||!w.pmItems||!w.pmItems[idx]) return;
  w.pmItems[idx].done=!w.pmItems[idx].done; saveWO(w); pgRender();
}
function woPmFill(wid, idx, val){
  var w=woById(wid); if(!w||!w.pmItems||!w.pmItems[idx]) return;
  w.pmItems[idx].value=val; saveWO(w);
}

// ---- Guided PM walkthrough (Sprint 50hr and shared tracks) ----------------
function _woTrack(w){
  if(!w) return null;
  var id=w.kartId||w.assetId;
  var ks=(typeof allKarts==='function')?allKarts():[];
  for(var i=0;i<ks.length;i++) if(ks[i].id===id) return ks[i].track;
  var r=(typeof kartByName==='function')?kartByName(w.assetId||w.kartId):null;
  return r?r.track:null;
}
function _pmGuidedSteps(w){
  if(!w) return null;
  if(!(w.type==='preventive'||w.pmKey||w.recurring) || !w.pmKey) return null;
  if(w.status==='completed') return null;
  if(!window.LVMGP_PMT || typeof LVMGP_PMT.guided!=='function') return null;
  var tr=_woTrack(w); if(!tr) return null;
  return LVMGP_PMT.guided(tr, w.pmKey);
}
function _gpState(w){ if(!w.gp||typeof w.gp!=='object') w.gp={i:0,done:{},fix:{},hrs:''}; w.gp.done=w.gp.done||{}; w.gp.fix=w.gp.fix||{}; return w.gp; }
function _pmGuidedSummaryHtml(w, steps){
  var gp=_gpState(w), done=0; for(var k=0;k<steps.length;k++) if(gp.done[k]) done++;
  var started=((gp.i||0)>0 || done>0 || (gp.hrs!=null&&gp.hrs!==''));
  var h='<div class="ds-sec"><div class="ds-st">Guided PM</div>';
  h+='<div style="font-size:12px;color:var(--muted);margin-bottom:10px">'+done+' of '+steps.length+' steps done'+((gp.hrs!=null&&gp.hrs!=='')?(' · hours '+esc(gp.hrs)):'')+'</div>';
  h+='<button onclick="startGuidedPM(\''+escA(w.id)+'\')" style="width:100%;background:var(--accent);border:none;color:#fff;border-radius:12px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit">'+(started?'▶ Resume guided PM':'▶ Start guided PM')+'</button></div>';
  return h;
}
function startGuidedPM(woId){
  var w=woById(woId); if(!w) return; _gpState(w);
  var ov=document.getElementById('gpmOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='gpmOverlay'; ov.style.cssText='position:fixed;inset:0;z-index:10000'; document.body.appendChild(ov); }
  ov.style.display='block'; _gpmRender(woId);
}
function _gpmClose(){ var ov=document.getElementById('gpmOverlay'); if(ov){ ov.style.display='none'; ov.innerHTML=''; } if(typeof pgRender==='function') pgRender(); }
function _gpmNav(woId,d){ var w=woById(woId); if(!w)return; var gp=_gpState(w); var steps=_pmGuidedSteps(w)||[]; gp.i=Math.max(0,Math.min((gp.i||0)+d, steps.length-1)); saveWO(w); _gpmRender(woId); }
function _gpmDone(woId,idx){ var w=woById(woId); if(!w)return; var gp=_gpState(w); gp.done[idx]=!gp.done[idx]; saveWO(w); _gpmRender(woId); }
function _gpmFix(woId,idx){ var w=woById(woId); if(!w)return; var gp=_gpState(w); gp.fix[idx]=!gp.fix[idx]; saveWO(w); _gpmRender(woId); }
function _gpmFinish(woId){ var w=woById(woId); if(!w)return; saveWO(w); _gpmClose(); }
function _gpmHours(woId,val){
  var w=woById(woId); if(!w)return; var gp=_gpState(w); gp.hrs=val;
  var n=parseFloat(val);
  if(!isNaN(n)&&n>0){
    var id=w.kartId||w.assetId, ks=(typeof allKarts==='function')?allKarts():[];
    for(var i=0;i<ks.length;i++){ if(ks[i].id===id){
      ks[i].engineHrs=n; if(typeof dbSave!=='undefined') dbSave('karts',ks[i]);
      var eid=ks[i].engineId; if(eid&&D.engines){ for(var e=0;e<D.engines.length;e++) if(D.engines[e].id===eid){ D.engines[e].totalHrs=n; if(typeof dbSave!=='undefined') dbSave('engines',D.engines[e]); break; } }
      break; } }
  }
  saveWO(w);
}
function _gpmRender(woId){
  var w=woById(woId); if(!w) return;
  var steps=_pmGuidedSteps(w)||[]; if(!steps.length){ _gpmClose(); return; }
  var gp=_gpState(w);
  var i=Math.max(0,Math.min(gp.i||0, steps.length-1)); gp.i=i; var s=steps[i];
  var _st=(s.text||''), _dash=_st.indexOf(' — '), _stt=(_dash>0?_st.slice(0,_dash):''), _sbd=(_dash>0?_st.slice(_dash+3):_st);
  var ov=document.getElementById('gpmOverlay'); if(!ov) return;
  var doneN=0; for(var k=0;k<steps.length;k++) if(gp.done[k]) doneN++;
  var h='<div style="position:absolute;inset:0;background:var(--bg,#fff);display:flex;flex-direction:column;font-family:inherit">';
  h+='<div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)">';
  h+='<button onclick="_gpmClose()" style="background:transparent;border:none;font-size:22px;font-weight:800;cursor:pointer;color:var(--muted);font-family:inherit;line-height:1">×</button>';
  h+='<div style="flex:1"><div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase">Step '+(i+1)+' of '+steps.length+' · '+doneN+' done'+(s.mins?(' · ~'+s.mins+' min'):'')+'</div><div style="font-size:17px;font-weight:900">'+esc(_stt||('Step '+(i+1)))+'</div></div></div>';
  h+='<div style="height:4px;background:var(--border)"><div style="height:100%;width:'+Math.round((i+1)/steps.length*100)+'%;background:var(--accent)"></div></div>';
  h+='<div style="flex:1;overflow:auto;padding:16px">';
  if(s.image){ h+='<img src="'+escA(s.image)+'" onerror="this.style.display=\'none\'" style="width:100%;max-height:42vh;object-fit:contain;border:1px solid var(--border);border-radius:12px;background:#fff;margin-bottom:14px"/>'; }
  h+='<div style="font-size:15px;line-height:1.5;margin-bottom:16px">'+esc(_sbd)+'</div>';
  if(s.tools){ h+='<div style="font-size:12px;color:var(--muted);margin:-8px 0 16px"><b>Tools:</b> '+esc(s.tools)+'</div>'; }
  if(s.rec){
    h+='<div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Engine hours</div>';
    h+='<input type="number" inputmode="decimal" value="'+escA(gp.hrs||'')+'" oninput="_gpmHours(\''+escA(woId)+'\',this.value)" placeholder="e.g. 2410" style="width:100%;border:1.5px solid var(--border);border-radius:10px;padding:14px;font-size:20px;font-weight:800;font-family:inherit"/>';
    h+='<div style="font-size:11px;color:var(--muted);margin-top:6px">Saves to this kart and updates hours everywhere it shows.</div>';
  }else{
    var dn=!!gp.done[i];
    h+='<label style="display:flex;align-items:center;gap:12px;padding:15px;border:2px solid '+(dn?'#16a34a':'var(--border)')+';border-radius:12px;cursor:pointer;margin-bottom:10px;background:'+(dn?'rgba(22,163,74,.08)':'transparent')+'"><input type="checkbox" '+(dn?'checked':'')+' onchange="_gpmDone(\''+escA(woId)+'\','+i+')" style="width:24px;height:24px"/><span style="font-size:15px;font-weight:700">'+'Done'+'</span></label>';
    if(s.fix){ var fx=!!gp.fix[i];
      h+='<label style="display:flex;align-items:center;gap:12px;padding:15px;border:2px solid '+(fx?'#f59e0b':'var(--border)')+';border-radius:12px;cursor:pointer;background:'+(fx?'rgba(245,158,11,.10)':'transparent')+'"><input type="checkbox" '+(fx?'checked':'')+' onchange="_gpmFix(\''+escA(woId)+'\','+i+')" style="width:24px;height:24px"/><span style="font-size:15px;font-weight:700">'+esc(s.fix)+'</span></label>';
      h+='<div style="font-size:11px;color:var(--muted);margin-top:6px">Only tick if you actually did this.</div>';
    }
  }
  h+='</div>';
  h+='<div style="display:flex;gap:10px;padding:14px 16px;border-top:1px solid var(--border)">';
  h+='<button onclick="_gpmNav(\''+escA(woId)+'\',-1)" '+(i===0?'disabled':'')+' style="flex:1;background:var(--card);border:1.5px solid var(--border);color:var(--text);border-radius:10px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;opacity:'+(i===0?'.45':'1')+'">Back</button>';
  if(i<steps.length-1){ h+='<button onclick="_gpmNav(\''+escA(woId)+'\',1)" style="flex:2;background:var(--accent);border:none;color:#fff;border-radius:10px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit">Next</button>'; }
  else { h+='<button onclick="_gpmFinish(\''+escA(woId)+'\')" style="flex:2;background:#16a34a;border:none;color:#fff;border-radius:10px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit">✓ Finish</button>'; }
  h+='</div></div>';
  ov.innerHTML=h;
}
// Persisting stock adjust (adjP does not save to the DB).
function _pmAdjustStock(name, delta, bucket){
  if(!name||!delta) return;
  var pid=(typeof partIdByName==='function')?partIdByName(name):null; if(!pid) return;
  var fld=(bucket==='used')?'qtyUsed':'qty';
  for(var i=0;i<D.parts.length;i++){ if(D.parts[i].id===pid){ D.parts[i][fld]=Math.max(0,(Number(D.parts[i][fld])||0)+delta); if(typeof dbSave==='function') dbSave('parts',D.parts[i]); break; } }
}
// Adjust stock for a specific WO/part LINE, resolving the real part by number/ID first
// (so a same-named sibling part's stock is never touched). Falls back to name for legacy lines.
function _woAdjustStock(entry, delta, bucket){
  if(!entry||!delta) return;
  var p=(typeof _resolveWOPart==='function')?_resolveWOPart(entry):null;
  if(!p){ _pmAdjustStock(entry.name, delta, bucket); return; }
  var fld=(bucket==='used')?'qtyUsed':'qty';
  p[fld]=Math.max(0,(Number(p[fld])||0)+delta);
  if(typeof dbSave==='function') dbSave('parts',p);
}
// A part line can pull from New (default) or Used stock. Deduction routes to the right bucket.
function _puBucket(p){return (p&&p.bucket==='used')?'used':'new';}
// Mechanic confirms what was actually used: 'used' deducts stock once
// (reversible), 'reused' records no consumption. Tapping the same mode undoes.
function woDeductParts(w){
  if(!w||w.vendorPartsProvided)return;
  if(w.backfill)return;   // historical record: parts were consumed before this system existed
  w.partsUse=w.partsUse||{};
  var pu=w.partsUsed||[];
  for(var i=0;i<pu.length;i++){var p=pu[i];if(!p||!p.name)continue;if(w.partsUse[p.name]==='used')continue;_woAdjustStock(p,-(Number(p.qty)||1),_puBucket(p));w.partsUse[p.name]='used';}
}
function woRestoreParts(w){
  if(!w)return;
  if(w.backfill)return;   // nothing was ever deducted, so nothing to give back
  w.partsUse=w.partsUse||{};
  var pu=w.partsUsed||[];
  for(var i=0;i<pu.length;i++){var p=pu[i];if(!p||!p.name)continue;if(w.partsUse[p.name]==='used'){_woAdjustStock(p,(Number(p.qty)||1),_puBucket(p));w.partsUse[p.name]='';}}
}
function woConfirmUsage(woId, idx, mode){
  var w=woById(woId); if(!w) return; var pu=w.partsUsed||[]; if(idx<0||idx>=pu.length) return;
  var p=pu[idx], qty=Number(p.qty)||1, bk=_puBucket(p);
  w.partsUse=w.partsUse||{};
  var cur=w.partsUse[p.name]||'';
  var next=(cur===mode)?'':mode;
  if(cur==='used' && next!=='used') _woAdjustStock(p, qty, bk);   // restore stock
  if(next==='used' && cur!=='used') _woAdjustStock(p, -qty, bk);  // deduct stock
  if(next) w.partsUse[p.name]=next; else delete w.partsUse[p.name];
  saveWO(w);
  if(typeof pgRender==='function') pgRender();
}
function woSetPartBucket(woId, idx, bucket){
  var w=woById(woId); if(!w) return; var pu=w.partsUsed||[]; if(idx<0||idx>=pu.length) return;
  var p=pu[idx], nb=(bucket==='used')?'used':'new';
  if(_puBucket(p)===nb)return;
  w.partsUse=w.partsUse||{};
  if(w.partsUse[p.name]==='used'){ _woAdjustStock(p,(Number(p.qty)||1),_puBucket(p)); w.partsUse[p.name]=''; } // hand back to the old bucket first
  p.bucket=nb; saveWO(w);
  if(typeof pgRender==='function') pgRender();
}
function woRemovePart(woId, idx){
  var w=woById(woId); if(!w) return; var pu=w.partsUsed||[]; if(idx<0||idx>=pu.length) return;
  var p=pu[idx];
  if(!confirm('Remove \u201c'+p.name+'\u201d from this work order?')) return;
  if(w.partsUse && w.partsUse[p.name]==='used'){ _pmAdjustStock(p.name, (Number(p.qty)||1)); delete w.partsUse[p.name]; }
  pu.splice(idx,1); w.partsUsed=pu; saveWO(w);
  if(typeof pgRender==='function') pgRender();
}
function woAddPartPrompt(woId){
  var w=woById(woId); if(!w) return;
  var nm=prompt('Part name (matches inventory if it exists):'); if(!nm||!nm.trim()) return;
  var qy=prompt('Quantity used:', '1'); if(qy===null) return; var q=Number(qy)||1;
  var pc=(typeof partByName==='function')?partByName(nm.trim()):null;
  w.partsUsed=w.partsUsed||[];
  w.partsUsed.push({name:(pc?pc.name:nm.trim()), qty:q, unit:(pc&&pc.unit)||'', cost:Math.round(q*((pc&&Number(pc.unitCost))||0)*100)/100, pid:(pc?pc.id:undefined)});
  saveWO(w);
  if(typeof pgRender==='function') pgRender();
}
// ── Per-line PM time + parts ──────────────────────────────────────────────
// mins = minutes for that one task (single-seat basis). parts = function(ctx)
// returning part specs {kw:[catalog search terms], name, qty, unit, dcost}.
var PM_LINE_META = {
  'change engine oil':{mins:8, parts:function(c){var qt=(c.eng==='GX270'?1.16:0.63);return [
     {kw:['amsoil','engine oil','10w-40','10w'],name:'Engine Oil (AMSOIL 10W-40)',qty:qt,unit:'qt',dcost:10.17},
     {kw:['drain plug washer','drain washer','crush washer'],name:'Oil Drain Plug Washer',qty:1,unit:'ea',dcost:0.75}];}},
  'reduction gear oil':{mins:4, parts:function(c){var qt=(c.eng==='GX270'?0.32:0.53);return [
     {kw:['amsoil','engine oil','10w-40','10w'],name:'Engine Oil (AMSOIL 10W-40)',qty:qt,unit:'qt',dcost:10.17}];}},
  'replace air filter':{mins:5, parts:function(c){return [
     {kw:['air filter '+(c.eng||'').toLowerCase(),'air cleaner '+(c.eng||'').toLowerCase(),'air filter','air cleaner'],name:'Air Filter Element ('+(c.eng||'')+')',qty:1,unit:'ea',dcost:8.5}];}},
  'replace spark plug':{mins:6, parts:function(){return [{kw:['ngk bpr6es','bpr6es','spark plug'],name:'Spark Plug NGK BPR6ES',qty:1,unit:'ea',dcost:3.25}];}},
  'clean/replace spark plug':{mins:5, parts:function(){return [{kw:['ngk bpr6es','bpr6es','spark plug'],name:'Spark Plug NGK BPR6ES',qty:1,unit:'ea',dcost:3.25}];}},
  'replace fuel lines':{mins:15, parts:function(){return [{kw:['fuel line','fuel hose'],name:'Fuel Line',qty:1,unit:'ea',dcost:6.0}];}},
  'change hydraulic brake fluid':{mins:20, parts:function(){return [{kw:['brake fluid','dot 5','dot5','dot 4'],name:'Brake Fluid',qty:1,unit:'bottle',dcost:14.99}];}},
  'change brake fluid':{mins:18, parts:function(){return [{kw:['brake fluid','dot 5','dot5','dot 4'],name:'Brake Fluid',qty:1,unit:'bottle',dcost:14.99}];}},
  'full bearing service':{mins:40, parts:function(){return [{kw:['bearing grease','grease'],name:'Bearing Grease',qty:1,unit:'tube',dcost:12.0}];}},
  'clean & grease axle bearings':{mins:25, parts:function(){return [{kw:['bearing grease','grease'],name:'Bearing Grease',qty:1,unit:'tube',dcost:12.0}];}},
  'inspect & grease front spindles':{mins:12, parts:function(){return [{kw:['bearing grease','grease'],name:'Bearing Grease',qty:0.5,unit:'tube',dcost:6.0}];}},
  // time-only lines (no part consumed)
  'record hours':{mins:1},'clean air filter':{mins:3},
  'check spark plug':{mins:2},'inspect spark plug':{mins:2},'clean fuel strainer':{mins:3},
  'check tires & pressure':{mins:3},'inspect drive belt':{mins:2},'inspect drive chain':{mins:2},
  'check brake fluid level':{mins:1},'check all nuts & bolts':{mins:3},'torque all nuts & bolts':{mins:6},
  'check starter rope & intake screen':{mins:2},'inspect axle for bend':{mins:2},'check front-end alignment':{mins:5},
  'inspect brake lines/hoses':{mins:3},'torque wheel lug nuts':{mins:4},'lubricate chassis':{mins:5},
  'adjust valve clearance':{mins:20},'check brake pad wear':{mins:3},'clean combustion chamber':{mins:25},
  'full safety inspection':{mins:15}
};
function matchPmLine(label){
  var L=String(label||'').toLowerCase(), best=null, bestLen=0;
  for(var k in PM_LINE_META){ if(L.indexOf(k)>=0 && k.length>bestLen){ best=PM_LINE_META[k]; bestLen=k.length; } }
  return best || {mins:5};
}
var PM_F3000_ROAD=[1,3,6,12,13,16,21,24,25,26,27,28];
function pmClassMult(track,num){ if(track==='kiddie')return 0.85; if(track==='road'&&PM_F3000_ROAD.indexOf(+num)>=0)return 1.2; return 1.0; }
function pmKartCtx(w){
  var k=(typeof kartByName==='function')?kartByName(w.assetId):null;
  var eng=k?(k.engine||((typeof getEngineById==='function'&&k.engineId&&getEngineById(k.engineId))||{}).model||'GX200'):'GX200';
  return {eng:eng, track:k?k.track:null, num:k?k.num:null};
}
function _pmFindCatalog(kw){
  if(!window.D||!D.parts) return null;
  for(var i=0;i<D.parts.length;i++){var nm=String(D.parts[i].name||'').toLowerCase();
    for(var j=0;j<kw.length;j++){ if(kw[j]&&nm.indexOf(kw[j])>=0) return D.parts[i]; }}
  return null;
}
function _pmResolvePart(spec){
  var cat=_pmFindCatalog(spec.kw||[]);
  var uc=(cat&&cat.unitCost!=null&&cat.unitCost!=='')?Number(cat.unitCost):spec.dcost;
  return {name:cat?cat.name:spec.name, qty:spec.qty, unit:spec.unit||(cat&&cat.unit)||'', unitCost:(Number(uc)||0), inCatalog:!!cat};
}
function pmLaborRate(w){
  if(w&&w.assignee){var k=String(w.assignee).trim().toLowerCase();
    for(var i=0;i<D.teamMembers.length;i++){var m=D.teamMembers[i];
      if((m.name||'').trim().toLowerCase()===k && m.payRate!=null && m.payRate!=='') return Number(m.payRate)||0;}}
  return 25; // stand-in until a person with a pay rate is assigned
}
function _pmQty(q){ return (Math.round(q*100)/100)+''; }
function _pmMoney(n){ return '$'+(Number(n)||0).toFixed(2); }
// Aggregate a PM's per-line parts (used to seed the Parts panel + estimate).
function pmComputeParts(w, items){
  var ctx=pmKartCtx(w), totRaw=0, agg={}, order=[];
  for(var i=0;i<items.length;i++){
    var meta=matchPmLine(items[i].label), mins=meta.mins||5; totRaw+=mins;
    var lp=meta.parts?meta.parts(ctx):[];
    for(var j=0;j<lp.length;j++){ var rp=_pmResolvePart(lp[j]);
      if(agg[rp.name]) agg[rp.name].qty+=rp.qty;
      else { agg[rp.name]={name:rp.name,qty:rp.qty,unit:rp.unit,unitCost:rp.unitCost,inCatalog:rp.inCatalog}; order.push(rp.name); } }
  }
  var mult=pmClassMult(ctx.track,ctx.num);
  return {totMins:Math.round(totRaw*mult), mult:mult, ctx:ctx, parts:order.map(function(n){return agg[n];})};
}
function _pmChecklistHtml(w, items){
  var doneN=0; for(var i=0;i<items.length;i++) if(items[i].done) doneN++;
  var locked=(w.status==='completed');
  var allDone=(doneN===items.length);
  var ctx=pmKartCtx(w);
  var totRaw=0, agg={}, order=[];
  var h='<div style="background:var(--bg);border-radius:10px;padding:11px 12px;margin-bottom:8px">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase">PM Checklist</div><div style="font-size:11px;font-weight:800;color:'+(allDone?'#22c55e':'#f59e0b')+'">'+doneN+' / '+items.length+(allDone?' \u2713':'')+'</div></div>';
  for(var i=0;i<items.length;i++){
    var it=items[i], val=esc(it.value||'').replace(/"/g,'&quot;');
    var meta=matchPmLine(it.label), mins=meta.mins||5; totRaw+=mins;
    var lp=meta.parts?meta.parts(ctx):[], lpTxt='';
    for(var pj=0;pj<lp.length;pj++){ var rp=_pmResolvePart(lp[pj]);
      lpTxt+=(lpTxt?', ':'')+esc(rp.name)+' x'+_pmQty(rp.qty)+(rp.unit?' '+esc(rp.unit):'');
      if(agg[rp.name]){ agg[rp.name].qty+=rp.qty; } else { agg[rp.name]={name:rp.name,qty:rp.qty,unit:rp.unit,unitCost:rp.unitCost,inCatalog:rp.inCatalog}; order.push(rp.name); }
    }
    h+='<div style="display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid var(--border)">';
    h+='<input type="checkbox" '+(it.done?'checked':'')+(locked?' disabled':'')+' onchange="woPmToggle(\''+w.id+'\','+i+')" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent);flex-shrink:0;cursor:'+(locked?'default':'pointer')+'"/>';
    h+='<div style="flex:1;min-width:0">';
    h+='<div style="font-size:12.5px;line-height:1.4'+(it.done?';color:var(--muted);text-decoration:line-through':'')+'">'+esc(it.label)+'</div>';
    h+='<div style="font-size:10.5px;color:var(--muted);margin-top:3px">~'+mins+' min'+(lpTxt?' \u00b7 <span style="color:#7c3aed;font-weight:600">Parts: '+lpTxt+'</span>':'')+'</div>';
    if(locked){ if(it.value) h+='<div style="font-size:11px;color:var(--accent);font-weight:600;margin-top:2px">'+esc(it.value)+'</div>'; }
    else h+='<input value="'+val+'" onchange="woPmFill(\''+w.id+'\','+i+',this.value)" placeholder="reading / note (optional)" style="width:100%;box-sizing:border-box;margin-top:4px;border:1px solid var(--border);border-radius:6px;padding:4px 7px;font-size:11px;font-family:inherit"/>';
    var _ht=matchPmHowto(it.label);
    if(_ht){
      h+='<details style="margin-top:5px"><summary style="font-size:11px;font-weight:700;color:var(--accent);cursor:pointer">How to do this</summary>';
      h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:7px;padding:7px 10px;margin-top:5px"><ol style="margin:0;padding-left:16px">';
      for(var _hs=0;_hs<_ht.length;_hs++) h+='<li style="font-size:11px;line-height:1.5;padding:1px 0">'+esc(_ht[_hs])+'</li>';
      h+='</ol></div></details>';
    }
    h+='</div></div>';
  }
  if(!locked && !allDone) h+='<div style="font-size:10px;color:var(--muted);margin-top:7px">Check each task as you complete it. Fill-ins are optional \u2014 use them for readings or notes.</div>';
  h+='</div>';

  // ── totals: time, parts w/ cost, labor (time x pay rate), grand total ─────
  var mult=pmClassMult(ctx.track,ctx.num);
  var totMins=Math.round(totRaw*mult);
  // For PM work orders the tier's time estimate (guided step minutes) is authoritative,
  // so a stale baked-in estimate self-heals to the current tier total.
  var _pmLive=null;
  if((w.pmKey||w.recurring) && typeof window.pmEstMins==='function' && ctx.track){
    try{ var _l=window.pmEstMins(w.pmKey||ctx.pmKey, ctx.track, ctx.num); if(_l>0)_pmLive=_l; }catch(e){}
  }
  if(_pmLive!=null){ if(w.estMins!==_pmLive){ w.estMins=_pmLive; if(w.status!=='completed' && typeof saveWO==='function')saveWO(w); } }
  else if(w.estMins==null){ w.estMins=totMins; }
  var shownMins=(w.estMins!=null?w.estMins:totMins);
  var partsCost=0; for(var a=0;a<order.length;a++){ var pp=agg[order[a]]; partsCost+=pp.qty*pp.unitCost; }
  var rate=pmLaborRate(w), assigned=!!(w&&w.assignee), laborCost=(shownMins/60)*rate, grand=partsCost+laborCost;

  h+='<div style="background:var(--card);border:1.5px solid var(--accent);border-radius:10px;padding:11px 12px;margin-bottom:8px">';
  h+='<div style="font-size:11px;font-weight:800;color:var(--accent);text-transform:uppercase;margin-bottom:8px">PM Estimate</div>';
  h+='<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;padding:3px 0"><span>Total time</span><span>'+fmtMins(shownMins)+(mult!==1?' <span style="font-size:10px;color:var(--muted);font-weight:600">(x'+mult+' '+(ctx.track==='kiddie'?'kiddie':'double')+')</span>':'')+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;margin-top:4px"><span>Labor \u00b7 '+fmtMins(shownMins)+' @ '+_pmMoney(rate)+'/hr'+(assigned?'':' <span style="font-size:9px;color:#b45309">($25 stand-in \u2014 assign a tech)</span>')+'</span><span style="font-family:monospace">'+_pmMoney(laborCost)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;font-size:14px;font-weight:900;padding:6px 0 0;border-top:1.5px solid var(--accent);margin-top:4px;color:var(--accent)"><span>PM total</span><span style="font-family:monospace">'+_pmMoney(grand)+'</span></div>';
  h+='</div>';
  return h;
}
function renderWOPage(id){
  var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){w=D.workOrders[i];break;}if(!w)return;
  var asset=assetById(w.assetId),vendor=w.vendorId?vById(w.vendorId):null;
  var h='<div style="font-size:10px;font-weight:700;color:var(--muted);font-family:monospace;margin-bottom:4px">'+w.id+'</div>';
  if(w.rtsInspId&&typeof _rtsOpenFor==='function'){var _rin=null;for(var _ri=0;_ri<(D.inspections||[]).length;_ri++)if(D.inspections[_ri].id===w.rtsInspId){_rin=D.inspections[_ri];break;}
    if(_rin&&_rin.status!=='completed')h+='<div style="background:#fff7ed;border:2px solid #f59e0b;border-radius:10px;padding:11px 13px;margin-bottom:10px"><div style="font-size:12px;font-weight:900;color:#b45309;margin-bottom:5px">\u26a0\ufe0f RETURN-TO-SERVICE INSPECTION REQUIRED</div><div style="font-size:12px;color:#7c2d12;margin-bottom:8px">This kart stays out of service until it passes a safety inspection.</div><button onclick="openOpsSheet(\''+escA(w.rtsInspId)+'\')" style="background:#f59e0b;border:none;color:#fff;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">Open inspection</button></div>';
    else if(_rin&&_rin.rtsResult==='passed')h+='<div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:12px;font-weight:700;color:#166534">\u2713 Returned to service after passing inspection'+(_rin.completedAt?(' at '+esc(_rin.completedAt)):'')+(_rin.completedBy?(' by '+esc(_rin.completedBy)):'')+'</div>';}
  h+=_woWorksheetHead(w);
  h+=(typeof _woRepeatFlag==='function'?_woRepeatFlag(w):'');
  if(w.needsReview){
    h+='<div style="background:#fffbeb;border:1.5px solid #f59e0b;border-radius:10px;padding:12px;margin:10px 0">';
    h+='<div style="font-size:13px;font-weight:800;color:#b45309;margin-bottom:6px">\u26A0 Needs review \u2014 auto-created from a forwarded email</div>';
    h+='<div style="font-size:12px;color:#92400e;margin-bottom:8px">The system couldn\'t match this to an asset. Pick the asset it belongs to, then approve. <b>If this is a parts purchase or receipt, use \u201cMove to Parts\u201d below instead.</b></div>';
    if(w.emailFrom)h+='<div style="font-size:11px;color:#92400e">From: '+esc(w.emailFrom)+'</div>';
    if(w.emailSubject)h+='<div style="font-size:11px;color:#92400e;margin-bottom:8px">Subject: '+esc(w.emailSubject)+'</div>';
    h+='<select id="wo-assign-asset" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;margin:6px 0 8px">'+woAssetOpts(w.assetId||'')+'</select>';
    h+='<button onclick="assignWO(\''+escA(w.id)+'\')" style="background:#f59e0b;border:none;color:#fff;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Assign & approve</button></div>';
  }
  if(w.receiptUrl){
    h+='<div style="margin:10px 0"><a href="'+escA(w.receiptUrl)+'" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;text-decoration:none">📎 View receipt'+(w.receiptName?' ('+esc(w.receiptName)+')':'')+'</a></div>';
  }
  h+='<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">'+(w.inspId?'<button onclick="openInspSheet(\''+escA(w.inspId)+'\')" style="background:#0891b2;border:none;color:#fff;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">View inspection</button>':'')+'<button onclick="openWOEdit(\''+escA(w.id)+'\')" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Edit Work Order</button>'+((w.needsReview||w.emailFrom||w.receiptUrl)?'<button onclick="convertWOToPartOrder(\''+escA(w.id)+'\')" style="background:#7c3aed;border:none;color:#fff;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Move to Parts</button>':'')+'<button onclick="deleteWO(\''+escA(w.id)+'\')" style="background:#fff;border:1.5px solid #fca5a5;color:#dc2626;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Delete</button></div>';
  if((w.symptoms&&w.symptoms.length)||w.otherText){
    h+='<div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:12px;margin:10px 0">';
    h+='<div style="font-size:11px;font-weight:800;color:#1e40af;text-transform:uppercase;margin-bottom:4px">Reported symptoms</div>';
    var _sl=(w.symptoms||[]).map(symLabel); if(w.otherText)_sl.push('Other: '+w.otherText);
    h+='<div style="font-size:13px;font-weight:600;margin-bottom:'+(w.diagDone?'0':'8px')+'">'+esc(_sl.join(', '))+'</div>';
    if(!w.diagDone){
      h+='<div style="display:flex;gap:8px;flex-wrap:wrap">';
      if(w.symptoms&&w.symptoms.length)h+='<button onclick="startDiagnoseFromWO(\''+escA(w.id)+'\')" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Diagnose</button>';
      h+='<button onclick="openStdWOPicker(\''+escA(w.id)+'\')" style="background:#6366f1;border:none;color:#fff;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">I already know</button>';
      if(w.symptoms&&w.symptoms.indexOf("going-too-fast")>=0)h+='<button onclick="speedCheckFromWO(\''+escA(w.id)+'\')" style="background:#f59e0b;border:none;color:#fff;border-radius:9px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Speed Check</button>';
      h+='</div>';
    } else { h+='<div style="font-size:11px;color:#16a34a;font-weight:700">Fix: '+esc(w.diagFix||w.title)+'</div>'; }
    h+='</div>';
  }
  h+=_woCreatorLine(w);
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0">';
  var _an=w.assetId||'',_clk=((typeof kartByName==='function'&&kartByName(_an))||(typeof assetByName==='function'&&assetByName(_an)));
  h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">'+(vendor?'Vendor':'Assignee')+'</div><div style="font-size:13px;font-weight:600;color:'+(vendor?'#0891b2':'var(--text)')+'">'+esc(vendor?vendor.name:(tmMaskName(w.assignee)||'--'))+'</div></div>';
  h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Due</div><div style="font-size:13px;font-weight:600">'+fmt(w.dueDate)+'</div></div>';
  if((w.pmKey||w.recurring) && w.pmKey && typeof window.pmEstMins==='function'){
    try{ var _pc=pmKartCtx(w); if(_pc && _pc.track){ var _le=window.pmEstMins(w.pmKey,_pc.track,_pc.num); if(_le>0 && w.estMins!==_le){ w.estMins=_le; if(w.status!=='completed' && typeof saveWO==='function')saveWO(w); } } }catch(e){}
  }
  var _estM=(w.estMins!=null?w.estMins:null),_logM=(w.laborMins!=null?w.laborMins:(w.laborHours!=null?Math.round(w.laborHours*60):null));
  if(_estM!=null)h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Est. time</div><div style="font-size:13px;font-weight:600">'+fmtMins(_estM)+'</div></div>';
  if(_logM!=null&&_logM>0)h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Logged</div><div style="font-size:13px;font-weight:600">'+fmtMins(_logM)+'</div></div>';
  h+='</div>';
  var _gst=_pmGuidedSteps(w);
  var _inspHtml=(typeof _woInspectionBlock==='function')?_woInspectionBlock(w):'';
  if(_inspHtml){ h+=_inspHtml; }
  else if(_gst && _gst.length){ h+=_pmGuidedSummaryHtml(w,_gst); }
  else {
    var _pmIt=pmChecklistItems(w);
    if(_pmIt){ h+=_pmChecklistHtml(w,_pmIt); }
    else h+=_woDiag(w);
  }
  h+=(typeof _woRecentBlock==='function'?_woRecentBlock(w):'');
  var _tmrRun=(w.status==='in-progress'),_tmrDone=(w.status==='completed');
  var _tmrLog=(w.laborMins!=null?w.laborMins:(w.laborHours!=null?Math.round(w.laborHours*60):0));
  h+='<div class="ds-sec"><div class="ds-st">Labor Log</div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  if(_tmrDone){h+='<div style="flex:1;font-size:13px;font-weight:800;color:#16a34a">✓ Completed</div><button class="sbtn" data-wid="'+id+'" data-ws="open" onclick="updWOBtn(this)">Reopen</button>';}
  else{if(_tmrRun){h+='<button data-wid="'+id+'" data-ws="on-hold" onclick="updWOBtn(this)" style="background:#94a3b8;border:none;color:#fff;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">⏸ Pause</button>';}else{h+='<button data-wid="'+id+'" data-ws="in-progress" onclick="updWOBtn(this)" style="background:#16a34a;border:none;color:#fff;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">▶ Start</button>';}h+='<button data-wid="'+id+'" data-ws="completed" onclick="updWOBtn(this)" style="background:var(--accent);border:none;color:#fff;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">✓ Complete</button>';}
  h+='</div>';
  var _tmrTxt=_tmrRun?('▶ Running since '+(w.runningSince?new Date(w.runningSince).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'now')):(w.status==='on-hold'?'⏸ Paused':'');
  h+='<div style="font-size:11px;color:var(--muted);margin-top:8px">'+(_tmrTxt?_tmrTxt+' · ':'')+'Logged '+fmtMins(_tmrLog)+'</div></div>';
  h+='<div class="ds-sec"><div class="ds-st">Update Status</div><div class="sbtns">';
  var statuses=['open','in-progress','on-hold','completed'];
  for(var i=0;i<statuses.length;i++){var s=statuses[i];h+='<button class="sbtn'+(w.status===s?' on':'')+'" style="'+(w.status===s?'background:'+SC[s]+';border-color:'+SC[s]:'')+'" data-wid="'+id+'" data-ws="'+s+'" onclick="updWOBtn(this)">'+s.replace(/-/g,' ')+'</button>';}
  h+='</div></div>';
  h+='<div class="ds-sec"><div class="ds-st">Photos</div><div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start">';
  var _wph=w.photos||[];
  for(var _wpi=0;_wpi<_wph.length;_wpi++){h+='<div style="position:relative"><img src="'+_wph[_wpi]+'" onclick="openImgViewer(this.src)" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:zoom-in"/><button data-wid="'+escA(id)+'" data-idx="'+_wpi+'" onclick="woRemovePhotoBtn(this)" style="position:absolute;top:-6px;right:-6px;background:#dc2626;border:none;color:#fff;border-radius:50%;width:20px;height:20px;font-size:12px;font-weight:800;cursor:pointer;line-height:1;font-family:inherit">×</button></div>';}
  h+='<label style="display:inline-flex;align-items:center;justify-content:center;gap:4px;width:90px;height:90px;background:var(--card);border:1.5px dashed var(--accent);color:var(--accent);border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;text-align:center">📷 Add<input type="file" accept="image/*" capture="environment" data-wid="'+escA(id)+'" onchange="woAddPhotoBtn(this)" style="display:none"/></label>';
  h+='</div></div>';
  h+='<div class="ds-sec"><div class="ds-st" style="display:flex;justify-content:space-between;align-items:center">Activity Log <button data-msg="Re: '+escA(w.id)+' — '+escA(w.title)+'" data-wid="'+id+'" onclick="openMsgTo(this.dataset.msg,this.dataset.wid)" style="background:transparent;border:1px solid var(--border);color:var(--accent);border-radius:7px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">💬 Message</button></div><div>';
  var notes=w.notes||[];for(var i=0;i<notes.length;i++)h+='<div class="note-item" style="white-space:pre-wrap">'+esc(notes[i])+'</div>';
  h+='</div><div class="note-row"><textarea class="note-inp" id="ni-'+id+'" rows="1" oninput="_woGrow(this);msgAtInput(\'ni-'+id+'\',\'nisug-'+id+'\')" placeholder="Add a note… @ to ping · Enter = new line" style="resize:none;overflow:hidden;font-family:inherit"></textarea><button class="note-add" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:10px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit" data-wid="'+id+'" onclick="addNoteBtn(this)">Add</button></div><div id="nisug-'+id+'" style="display:none;border:1px solid var(--border);border-radius:9px;margin-top:6px;max-height:180px;overflow:auto"></div></div>';
  if(w.backfill){
    h+='<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:9px;padding:9px 11px;margin-top:10px">';
    h+='<div style="font-size:12px;font-weight:800;color:#b45309">Backfilled record</div>';
    h+='<div style="font-size:11px;color:#92400e;margin-top:2px">Entered after the fact for cost tracking. The date is approximate and this record is excluded from PM scheduling and reliability timing.</div></div>';
  }
  h+=(typeof procSectionHtml==='function'?procSectionHtml(w):'');
  h+=(typeof manualsSectionHtml==='function'?manualsSectionHtml(w.assetId):'');
  h+=(typeof _pnBlock==='function'?_pnBlock('wo',id):'');
  h+='<div style="height:16px"></div>';
  // Show SWO procedure steps if linked
  if(w.swoId && typeof SWO_REPAIRS!=='undefined' && SWO_REPAIRS[w.swoId]){
    var swo=SWO_REPAIRS[w.swoId];
    h+='<div class="ds-sec"><div class="ds-st">📋 Procedure Steps</div>';
    h+='<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">'+esc(swo.title)+'</div>';
    h+='<ol style="margin:0;padding-left:18px">';
    for(var si=0;si<swo.steps.length;si++){
      h+='<li style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">'+esc(swo.steps[si])+'</li>';
    }
    h+='</ol></div>';
  }
  // Show diagnostic symptom if present
  if(w.description && w.description.indexOf('Symptom:')===0){
    h+='<div class="ds-sec"><div class="ds-st">🔍 Diagnosis</div>';
    h+='<div style="font-size:12px;color:var(--text);line-height:1.5">'+esc(w.description)+'</div></div>';
  }
  var pu=w.partsUsed||[];var _wd=(w.status==='completed');
  h+='<div class="ds-sec"><div class="ds-st">Parts'+(pu.length?' ('+pu.length+')':'')+'</div>';
  if(!pu.length)h+='<div style="color:var(--muted);font-size:13px">No parts recorded.</div>';
  else{
    if(!_wd){var _unv=0;for(var pk=0;pk<pu.length;pk++){var _ps=woPartState(w,pu[pk].name);if(_ps!=='available'&&_ps!=='missing')_unv++;}if(_unv)h+='<div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:600;margin-bottom:8px">\u26a0\ufe0f Verify parts availability before starting \u2014 '+_unv+' unchecked</div>';}
    for(var pi=0;pi<pu.length;pi++){
      var _p=pu[pi];
      var _part=_resolveWOPart(_p);
      var _umPN=(!_part&&!!_p.pn);
      var _pid=_part?_part.id:(_umPN?null:partIdByName(_p.name));
      var _nm=_part?_part.name:_p.name;
      var _pnum=_part?(_part.partNumber||''):(_p.pn||_p.partNumber||'');
      var _pnDisp=_pnum?' <span style="font-size:10px;color:var(--muted);font-family:monospace">'+esc(_pnum)+'</span>':'';
      var _bkt=(_p.bucket==='used')?'used':'new';
      var _oh=_part?((_bkt==='used')?(Number(_part.qtyUsed)||0):(Number(_part.qty)||0)):(_umPN?null:_partOnHand(_nm)),_need=Number(_p.qty)||1,_st=(_umPN?'':woPartState(w,_p.name)),_oo=(_umPN?0:((_part&&typeof partOnOrderQtyPart==='function')?partOnOrderQtyPart(_part):(typeof partOnOrderQty==='function'?partOnOrderQty(_nm):0)));
      var _stk=(_oh===null?'\u2014':_oh),_stc=(_oh===null?'#94a3b8':(_oh>=_need?'#16a34a':(_oh>0?'#d97706':'#dc2626')));
      var _ordThis=(typeof _partOrderOpen==='function')?_partOrderOpen(w.id,_p.name,_p.pn):false;
      h+='<div style="padding:8px 0;border-bottom:1px solid var(--border)">';
      h+='<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">';
      h+='<div style="min-width:0">'+(_pid?'<span onclick="openEditPart(\''+_pid+'\')" style="cursor:pointer;font-size:12px;font-weight:700">'+esc(_nm)+_pnDisp+' <span style="color:var(--accent)">\u203a</span></span>':'<span style="font-size:12px;font-weight:700">'+esc(_nm)+_pnDisp+'</span>')+((_part&&typeof partCountBeacon==='function')?(' '+partCountBeacon(_part)):'')+'<div style="font-size:10px;color:var(--muted);margin-top:2px">Need '+esc(_p.qty)+' \u00b7 <span style="color:'+_stc+';font-weight:700">In stock'+(_bkt==='used'?' (used)':'')+': '+_stk+'</span>'+(_ordThis?' \u00b7 <span style="color:#16a34a;font-weight:800">\u2713 On order for this WO</span>':(_oo>0?' \u00b7 <span style="color:#7c3aed;font-weight:700">'+_oo+' on order</span> <span style="color:var(--muted);font-size:9px">(other WOs)</span>':''))+'</div></div>';
      h+=(_p.cost?'<span style="font-size:12px;font-weight:700;font-family:monospace">'+fmtM(_p.cost)+'</span>':'')+'</div>';
      if(!_wd){
        h+='<div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap">';
        if(_st==='available')h+='<span style="background:#dcfce7;color:#166534;border-radius:100px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer" onclick="woSetPartCheck(\''+w.id+'\','+pi+',\'available\')">\u2713 Confirmed \u00b7 tap to undo</span>';
        else if(_st==='missing')h+='<span style="background:#fee2e2;color:#991b1b;border-radius:100px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer" onclick="woSetPartCheck(\''+w.id+'\','+pi+',\'missing\')">\u26a0\ufe0f Can\'t find \u00b7 tap to undo</span>';
        else{h+='<button onclick="woSetPartCheck(\''+w.id+'\','+pi+',\'available\')" style="background:#16a34a;border:none;color:#fff;border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Confirm available</button>';h+='<button onclick="woSetPartCheck(\''+w.id+'\','+pi+',\'missing\')" style="background:#fff;border:1.5px solid #dc2626;color:#dc2626;border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Can\'t find</button>';}
        if(_ordThis)h+='<span style="background:#dcfce7;color:#166534;border-radius:100px;padding:4px 12px;font-size:11px;font-weight:800">\u2713 Added to order</span>';
        else h+='<button onclick="woAddPartToOrder(\''+w.id+'\','+pi+')" style="background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Add to order</button>';
        if(_st==='missing'&&_pid)h+='<button onclick="woFixCount(\''+w.id+'\','+pi+')" style="background:transparent;border:none;color:#d97706;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:underline">Count off? Fix it</button>';
        h+='</div>';
        h+='<div style="display:flex;gap:5px;margin-top:6px;align-items:center"><span style="font-size:10px;color:var(--muted);font-weight:700">Pull from:</span>';
        h+='<button onclick="woSetPartBucket(\''+w.id+'\','+pi+',\'new\')" style="background:'+(_bkt==='new'?'#0891b2':'#fff')+';color:'+(_bkt==='new'?'#fff':'var(--muted)')+';border:1.5px solid #0891b2;border-radius:7px;padding:3px 12px;font-size:10px;font-weight:800;cursor:pointer;font-family:inherit">New</button>';
        h+='<button onclick="woSetPartBucket(\''+w.id+'\','+pi+',\'used\')" style="background:'+(_bkt==='used'?'#7c3aed':'#fff')+';color:'+(_bkt==='used'?'#fff':'var(--muted)')+';border:1.5px solid #7c3aed;border-radius:7px;padding:3px 12px;font-size:10px;font-weight:800;cursor:pointer;font-family:inherit">Used</button>';
        h+='</div>';
        h+='<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center">';
        h+='<span style="background:#fef3c7;color:#92400e;border-radius:100px;padding:3px 10px;font-size:10px;font-weight:700">Reserved · deducts when completed</span>';
        h+='<button onclick="woRemovePart(\''+w.id+'\','+pi+')" style="background:transparent;border:none;color:#dc2626;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:underline">Remove</button>';
        h+='</div>';
      } else {
        h+='<div style="margin-top:6px">'+(w.vendorPartsProvided?'<span style="background:#e0f2fe;color:#0369a1;border-radius:100px;padding:3px 10px;font-size:10px;font-weight:700">Vendor-provided · no stock drawn</span>':'<span style="background:#dcfce7;color:#166534;border-radius:100px;padding:3px 10px;font-size:10px;font-weight:700">✓ Used · stock deducted</span>')+'</div>';
      }
      h+='</div>';
    }
    if(!_wd)h+='<button onclick="woAddAllShortfalls(\''+w.id+'\')" style="margin-top:10px;width:100%;background:var(--accent);border:none;color:#fff;border-radius:9px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Add all shortfalls to order</button>';
    if(!_wd&&(D.engineDiagrams||[]).length)h+='<button onclick="openDiagPickForWO(\''+w.id+'\',\'detail\')" style="margin-top:6px;width:100%;background:#fff;border:1.5px solid #4338ca;color:#4338ca;border-radius:9px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">🔧 Find part in engine diagram</button>';
  }
  if(!_wd)h+='<button onclick="openPartPickForWO(\''+w.id+'\')" style="margin-top:8px;width:100%;background:#fff;border:1.5px dashed var(--accent);color:var(--accent);border-radius:9px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">+ Add a part used</button>';
  h+='</div>';
  var _pc=woPartsCost(w),_opc=Number(w.otherPartsCost)||0,_pcT=_pc-_opc,_lh=Number(w.laborHours)||0,_lrate=personRate(w.assignee),_lc=_lh*_lrate,_vc=Number(w.cost)||0;
  var _fin=(typeof canFinancials!=='undefined'&&canFinancials()),_labc=(typeof canLaborCost!=='undefined'&&canLaborCost());
  var _vlabel=(w.type==='vendor'||w.vendorId)?'Vendor cost':'Other costs';
  h+='<div class="ds-sec"><div class="ds-st">Cost & Labor</div>';
  h+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted)">Parts</span><span style="font-size:13px;font-weight:700;font-family:monospace">'+fmtM(_pcT)+'</span></div>';
  if(_opc>0)h+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted)">Other parts cost</span><span style="font-size:13px;font-weight:700;font-family:monospace">'+fmtM(_opc)+'</span></div>';
  if(_vc>0&&_fin)h+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted)">'+_vlabel+'</span><span style="font-size:13px;font-weight:700;font-family:monospace">'+fmtM(_vc)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted)">Labor time</span><span style="font-size:13px;font-weight:700">'+(_lh?_lh+' hr'+(_lh===1?'':'s'):'\u2014')+'</span></div>';
  if(_labc)h+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted)">Labor cost ($'+_lrate+'/hr'+(w.assignee?' \u00b7 '+esc(tmMaskName(w.assignee)):'')+')</span><span style="font-size:13px;font-weight:700;font-family:monospace">'+fmtM(_lc)+'</span></div>';
  if(_fin){var _tot=_pc+_vc+(_labc?_lc:0);h+='<div style="display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid var(--border);margin-top:3px"><span style="font-size:13px;font-weight:800">Total</span><span style="font-size:14px;font-weight:800;font-family:monospace;color:#0891b2">'+fmtM(_tot)+'</span></div>';}
  h+='</div>';
  h+=_woPerfPayHtml(w);
  h+=_woAttachHtml(w);
  var _cl=(w.changeLog||[]);h+='<div class="ds-sec"><div class="ds-st">Change History ('+_cl.length+')</div>';
  if(!_cl.length)h+='<div style="color:var(--muted);font-size:13px">No changes recorded yet.</div>';
  else{for(var cli=_cl.length-1;cli>=0;cli--)h+='<div style="padding:5px 0;border-bottom:1px solid var(--border)"><div style="font-size:12px;color:var(--text)">'+esc(_cl[cli].text)+'</div><div style="font-size:10px;color:var(--muted)">'+esc(_cl[cli].ts)+' \u00b7 '+esc(_cl[cli].user)+'</div></div>';}
  h+='</div>';
  var _key=ahNorm(w.assetId||'');var _rel=[];if(_key)for(var ri=0;ri<D.workOrders.length;ri++){var _x=D.workOrders[ri];if(_x.id!==w.id&&ahNorm(_x.assetId)===_key)_rel.push(_x);}
  _rel.sort(function(a,b){return String(b.completed||b.created||'').localeCompare(String(a.completed||a.created||''));});
  var _cs=woSystem(w),_same=[],_other=[];
  for(var rk=0;rk<_rel.length;rk++){(woSystem(_rel[rk])===_cs&&_cs!=='general')?_same.push(_rel[rk]):_other.push(_rel[rk]);}
  if(_cs!=='general'){h+='<div class="ds-sec"><div class="ds-st">Related to this issue \u2014 '+esc(_cs)+' ('+_same.length+')</div>';
    if(!_same.length)h+='<div style="color:var(--muted);font-size:13px">No other '+esc(_cs)+' work on this asset.</div>';
    else for(var rj=0;rj<Math.min(_same.length,6);rj++)h+=woRelRow(_same[rj],_cs);
    h+='</div>';}
  h+='<div class="ds-sec"><div class="ds-st">Other work on '+esc(w.assetId||'this asset')+' ('+_other.length+')</div>';
  if(!_other.length)h+='<div style="color:var(--muted);font-size:13px">None.</div>';
  else{for(var ro=0;ro<Math.min(_other.length,6);ro++)h+=woRelRow(_other[ro],woSystem(_other[ro]));if(_other.length>6)h+='<button onclick="openAssetFromWO(\''+escA(w.assetId||'')+'\')" style="width:100%;padding:9px;margin-top:6px;background:var(--card);border:1.5px solid var(--accent);color:var(--accent);border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">View all on this asset \u203a</button>';}
  h+='</div>';
  if(w.procedureName){var _sim=[];for(var si2=0;si2<D.workOrders.length;si2++){var _y=D.workOrders[si2];if(_y.id!==w.id&&_y.procedureName===w.procedureName&&ahNorm(_y.assetId)!==_key)_sim.push(_y);}
   _sim.sort(function(a,b){return String(b.completed||b.created||'').localeCompare(String(a.completed||a.created||''));});
   if(_sim.length){h+='<div class="ds-sec"><div class="ds-st">Similar \u2014 same procedure ('+_sim.length+')</div>';for(var si3=0;si3<Math.min(_sim.length,5);si3++)h+=woRelRow(_sim[si3],'same procedure');h+='</div>';}}
  h+='<div style="height:50px"></div>';
  document.getElementById('apage-body').innerHTML=h;document.getElementById('apage-title').textContent=w.id;
}
/* ===== Performance Pay (owner-only) — Increment 1: points on each work order ===== */
function _woPtSkill(w){ return (w.ptSkill!=null)?Number(w.ptSkill):(w.pmKey?0.5:1.0); }
function _woPtBook(w){ return (w.ptBookMin!=null&&w.ptBookMin!=='')?Number(w.ptBookMin):(Number(w.estMins)||0); }
function _woPtComeback(w){ return (w.ptComeback!=null)?Number(w.ptComeback):1; }
function _woPtChecks(w){
  var lm=(w.laborMins!=null?w.laborMins:(w.laborHours?Math.round(w.laborHours*60):0));
  var inSvc=true; if(w.kartId&&typeof _kartFindAny==='function'){var k=_kartFindAny(w.kartId); if(k&&(k.status==='oos'||k.status==='regulatory-hold'))inSvc=false;}
  return {
    'In the system':true,
    'Diagnosis / symptom noted':!!(w.symptom||w.diagFix||w.swoId||(w.description&&String(w.description).trim())),
    'Labor time entered':(lm>0),
    'Parts entered (or none used)':!!((w.partsUsed&&w.partsUsed.length>0)||w.vendorPartsProvided),
    'Completed':(w.status==='completed'),
    'Kart back in service':inSvc
  };
}
function _woPtEligible(w){ var c=_woPtChecks(w); for(var k in c){ if(!c[k]) return false; } return true; }
function woPtPoints(w){ return Math.round(_woPtBook(w)*_woPtSkill(w)*_woPtComeback(w)*10)/10; }
function _woPtMechs(w){ if(w.ptMechs&&w.ptMechs.length) return w.ptMechs.slice(); return w.assignee?[w.assignee]:[]; }
function _woPtSplit(w){ var n=_woPtMechs(w).length; return n>0?n:1; }
function woPtPerMech(w){ return Math.round(woPtPoints(w)/_woPtSplit(w)*10)/10; }
function _woPerfPayHtml(w){
  if(!(typeof currentUser!=='undefined'&&currentUser&&currentUser.role==='owner')) return '';
  var bk=_woPtBook(w), sk=_woPtSkill(w), cb=_woPtComeback(w), pts=woPtPoints(w), elig=_woPtEligible(w), checks=_woPtChecks(w);
  var h='<div class="ds-sec" style="border:1.5px solid #c4b5fd;background:#faf5ff;border-radius:12px">';
  h+='<div class="ds-st" style="color:#6d28d9">Performance Pay \u00b7 owner only</div>';
  h+='<div style="display:flex;align-items:center;gap:8px;margin:6px 0"><span style="font-size:12px;color:var(--muted);width:84px">Book time</span><input type="number" value="'+esc(bk)+'" onchange="setWOPtBook(\''+w.id+'\',this.value)" style="width:80px;border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;font-size:13px;font-family:inherit"/><span style="font-size:12px;color:var(--muted)">min</span></div>';
  h+='<div style="margin:8px 0"><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Skill multiplier</div><div style="display:flex;gap:6px;flex-wrap:wrap">';
  var so=[[0.5,'Basic'],[1,'Mid'],[1.5,'Skilled'],[2,'Expert']];
  for(var i=0;i<so.length;i++){var on=(sk==so[i][0]);h+='<button onclick="setWOPtSkill(\''+w.id+'\','+so[i][0]+')" style="padding:6px 11px;border:1.5px solid '+(on?'#7c3aed':'var(--border)')+';border-radius:8px;background:'+(on?'#7c3aed':'var(--card)')+';color:'+(on?'#fff':'var(--muted)')+';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">'+so[i][0]+'\u00d7 '+so[i][1]+'</button>';}
  h+='</div></div>';
  h+='<div style="margin:8px 0"><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Comeback</div><div style="display:flex;gap:6px;flex-wrap:wrap">';
  var co=[[1,'Clean'],[0,'Came back'],[-1,'New failure']];
  for(var j=0;j<co.length;j++){var on2=(cb==co[j][0]);h+='<button onclick="setWOPtComeback(\''+w.id+'\','+co[j][0]+')" style="padding:6px 11px;border:1.5px solid '+(on2?'#7c3aed':'var(--border)')+';border-radius:8px;background:'+(on2?'#7c3aed':'var(--card)')+';color:'+(on2?'#fff':'var(--muted)')+';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">'+co[j][1]+'</button>';}
  h+='</div></div>';
  var _mechs=_woPtMechs(w), _n=_woPtSplit(w);
  h+='<div style="margin:8px 0"><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Mechanics on this job (points split evenly)</div><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">';
  for(var mm=0;mm<_mechs.length;mm++){ h+='<span style="display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border:1.5px solid var(--border);border-radius:999px;background:var(--card);font-size:12px;font-weight:600">'+esc(tmMaskName(_mechs[mm]))+' <button onclick="removeWOPtMech(\''+w.id+'\','+mm+')" style="background:none;border:none;color:#ef4444;font-weight:800;cursor:pointer;padding:0;font-size:14px;line-height:1">\u00d7</button></span>'; }
  var _mo=''; var _tm=(D.teamMembers||[]); for(var tt=0;tt<_tm.length;tt++){ if(_tm[tt].active===false)continue; if(typeof tmCanSee==='function'&&!tmCanSee(_tm[tt]))continue; var _nm=_tm[tt].name; if(!_nm||_mechs.indexOf(_nm)>=0)continue; _mo+='<option value="'+escA(_nm)+'">'+esc(_nm)+'</option>'; }
  h+='<select onchange="addWOPtMech(\''+w.id+'\',this.value)" style="border:1.5px solid var(--border);border-radius:8px;padding:5px 8px;font-size:12px;font-family:inherit;background:var(--card)"><option value="">+ add mechanic</option>'+_mo+'</select>';
  h+='</div></div>';
  h+='<div style="padding:8px 10px;background:'+(elig?'#f0fdf4':'#fff7ed')+';border-radius:9px;margin-top:8px"><div style="font-size:11px;color:var(--muted)">'+(elig?'Points (this job)':'Potential points \u2014 not yet eligible')+'</div><div style="font-size:20px;font-weight:800;color:'+(elig?'#16a34a':'#b45309')+'">'+pts+' <span style="font-size:13px;font-weight:700;color:var(--muted)">= '+fmtM(pts*0.1)+'</span></div>'+((_n>1)?'<div style="font-size:12px;color:#6d28d9;margin-top:4px;font-weight:700">Split '+_n+' ways \u2192 '+woPtPerMech(w)+' pts each = '+fmtM(woPtPerMech(w)*0.1)+' per mechanic</div>':'')+'</div>';
  h+='<div style="margin-top:8px">';
  for(var key in checks){ var ok=checks[key]; h+='<div style="font-size:12px;padding:2px 0;color:'+(ok?'#16a34a':'#b91c1c')+'">'+(ok?'\u2713':'\u2717')+' '+esc(key)+'</div>'; }
  h+='</div>';
  h+='<div style="font-size:10px;color:var(--muted);margin-top:6px">Points = book time \u00d7 skill \u00d7 comeback. 10 points = $1.</div>';
  h+='</div>';
  return h;
}
function setWOPtSkill(id,v){var w=woById(id);if(!w)return;w.ptSkill=Number(v);saveWO(w);renderWOPage(id);}
function setWOPtBook(id,v){var w=woById(id);if(!w)return;w.ptBookMin=(v===''?null:Number(v));saveWO(w);renderWOPage(id);}
function setWOPtComeback(id,v){var w=woById(id);if(!w)return;w.ptComeback=Number(v);saveWO(w);renderWOPage(id);}
function addWOPtMech(id,name){if(!name)return;var w=woById(id);if(!w)return;var cur=_woPtMechs(w);if(cur.indexOf(name)>=0)return;cur.push(name);w.ptMechs=cur;saveWO(w);renderWOPage(id);}
function removeWOPtMech(id,idx){var w=woById(id);if(!w)return;var cur=_woPtMechs(w);if(idx<0||idx>=cur.length)return;cur.splice(idx,1);w.ptMechs=cur;saveWO(w);renderWOPage(id);}
function woNow(){try{return new Date().toISOString().slice(0,16).replace('T',' ');}catch(e){return '';}}
function weCurUser(){return (typeof currentUser!=='undefined'&&currentUser&&(currentUser.name||currentUser.username))||'Unknown';}
function woLog(w,text){if(!w||!text)return;w.changeLog=w.changeLog||[];w.changeLog.push({ts:woNow(),user:weCurUser(),text:text});}
function _woAttachHtml(w){
  var a=w.attachments||[];
  var h='<div class="ds-sec"><div class="ds-st">Documents & Photos ('+a.length+')</div>';
  if(!a.length)h+='<div style="color:var(--muted);font-size:13px;margin-bottom:8px">No invoices, documents, or photos attached yet.</div>';
  else{for(var i=0;i<a.length;i++){var d=a[i];var isImg=/\.(jpg|jpeg|png|gif|webp|heic)$/i.test(d.name||'')||/image/i.test(d.type||'');
    h+='<div style="display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--border)">';
    h+='<a href="'+escA(d.url||'')+'" target="_blank" rel="noopener" style="flex:1;min-width:0;text-decoration:none;color:var(--text);display:flex;align-items:center;gap:8px">';
    h+='<span style="font-size:9px;font-weight:800;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex-shrink:0">'+(isImg?'IMG':'DOC')+'</span>';
    h+='<span style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(d.name||'file')+'</span></a>';
    h+='<button onclick="woRemoveAttachment(\''+w.id+'\',\''+d.id+'\')" style="background:none;border:none;color:#dc2626;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0">\u00d7</button>';
    h+='</div>';}}
  h+='<label style="display:inline-block;margin-top:9px;background:var(--card);border:1.5px solid #0891b2;color:#0891b2;border-radius:9px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">+ Add invoice, document, or photo<input type="file" accept="image/*,application/pdf" multiple style="display:none" onchange="woAttachInput(this,\''+w.id+'\')"></label>';
  h+='</div>';
  return h;
}
function woAttachInput(input,woId){
  var arr=(input&&input.files)?Array.prototype.slice.call(input.files):[];if(!arr.length)return;
  var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===woId){w=D.workOrders[i];break;}if(!w)return;
  w.attachments=w.attachments||[];
  (function next(i){
    if(i>=arr.length){input.value='';saveWO(w);if(typeof renderWOPage==='function')renderWOPage(woId);return;}
    compUploadDoc(arr[i],function(doc){if(doc){w.attachments.push(doc);if(typeof woLog==='function')woLog(w,'Attached: '+(doc.name||'file'));}next(i+1);});
  })(0);
}
function woRemoveAttachment(woId,docId){
  var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===woId){w=D.workOrders[i];break;}if(!w||!w.attachments)return;
  var d=null;for(var j=0;j<w.attachments.length;j++)if(w.attachments[j].id===docId){d=w.attachments[j];break;}if(!d)return;
  if(!confirm('Remove \u201c'+(d.name||'this file')+'\u201d?'))return;
  if(d.path&&typeof sb!=='undefined'&&sb&&sb.storage){try{sb.storage.from('compliance-docs').remove([d.path]);}catch(e){}}
  w.attachments=w.attachments.filter(function(x){return x.id!==docId;});
  if(typeof woLog==='function')woLog(w,'Removed attachment: '+(d.name||'file'));
  saveWO(w);if(typeof renderWOPage==='function')renderWOPage(woId);
}
function partById(id){if(!id||!D.parts)return null;for(var i=0;i<D.parts.length;i++)if(D.parts[i].id===id)return D.parts[i];return null;}
function _followMerge(p){var seen={};while(p&&p.movedToPartId&&!seen[p.id]){seen[p.id]=1;var nx=partById(p.movedToPartId);if(!nx)break;p=nx;}return p;}
function _resolveWOPart(_p){
  if(!_p)return null;
  if(_p.pn&&typeof partByPNPrimary==='function'){var _bx=partByPNPrimary(_p.pn);return _bx?_followMerge(_bx):null;}
  if(_p.pid){var bp=partById(_p.pid);if(bp)return _followMerge(bp);}
  var nm=String(_p.name||'').trim().toLowerCase();
  var cands=[];if(D.parts)for(var i=0;i<D.parts.length;i++){var _cp=D.parts[i];if(_cp.movedToPartId)continue;if(String(_cp.name||'').trim().toLowerCase()===nm)cands.push(_cp);}
  if(cands.length===1)return cands[0];
  if(cands.length>1){
    var unit=(_p.qty&&Number(_p.qty)>0&&_p.cost!=null&&_p.cost!=='')?(Number(_p.cost)/Number(_p.qty)):null;
    if(unit!=null){var match=null,n=0;for(var j=0;j<cands.length;j++){if(Math.abs((Number(cands[j].unitCost)||0)-unit)<0.005){match=cands[j];n++;}}if(n===1)return match;}
    return cands[0];
  }
  return _followMerge((typeof partByName==='function'?partByName(_p.name):null)||(typeof partByPN==='function'?partByPN(_p.name):null));
}
function wePartsFromDOM(){var rows=document.querySelectorAll('#we-parts .we-prow'),out=[];for(var i=0;i<rows.length;i++){var nm=(rows[i].querySelector('.wep-name').value||'').trim();if(!nm)continue;var _ent={name:nm,qty:parseFloat(rows[i].querySelector('.wep-qty').value)||0,cost:parseFloat(rows[i].querySelector('.wep-cost').value)||0};var _pid=rows[i].getAttribute('data-pid')||'';var _pn=rows[i].getAttribute('data-pn')||'';if(_pid)_ent.pid=_pid;if(_pn)_ent.pn=_pn;else if(_pid){for(var _z=0;_z<(D.parts||[]).length;_z++){if(D.parts[_z]&&D.parts[_z].id===_pid){if(D.parts[_z].partNumber)_ent.pn=D.parts[_z].partNumber;break;}}}out.push(_ent);}return out;}
function wePartsDiff(oldP,newP){var ch=[],om={},nm={};for(var i=0;i<oldP.length;i++)om[oldP[i].name]=oldP[i];for(var i=0;i<newP.length;i++)nm[newP[i].name]=newP[i];
  for(var i=0;i<newP.length;i++){var p=newP[i];if(!om[p.name])ch.push('Added part: '+p.name+' \u00d7'+p.qty);else if(Number(om[p.name].qty)!==Number(p.qty))ch.push('Part '+p.name+' qty: '+om[p.name].qty+' \u2192 '+p.qty);}
  for(var i=0;i<oldP.length;i++){if(!nm[oldP[i].name])ch.push('Removed part: '+oldP[i].name);}return ch;}
function weProw(n,q,c,pid,pn){var _u=(q!=null&&q!==''&&Number(q)>0&&c!=null&&c!=='')?(Number(c)/Number(q)):'';var _wpn=pn||'';if(!_wpn){if(pid){for(var _z=0;_z<(D.parts||[]).length;_z++){if(D.parts[_z]&&D.parts[_z].id===pid){_wpn=D.parts[_z].partNumber||'';break;}}}else if(n&&typeof partByName==='function'){var _pp=partByName(n);if(_pp)_wpn=_pp.partNumber||'';}}return '<div class="we-prow" data-unit="'+_u+'"'+(pid?' data-pid="'+escA(pid)+'"':'')+(pn?' data-pn="'+escA(pn)+'"':'')+' style="display:flex;gap:6px;margin-bottom:5px;align-items:center"><div class="wep-wrap" style="position:relative;flex:2;min-width:0"><input class="wep-name" placeholder="Type to search parts\u2026" value="'+esc(n)+'" oninput="wepSearch(this)" onblur="wepHide(this)" autocomplete="off" style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit"/><div class="wep-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--card);border:1.5px solid var(--accent);border-radius:8px;margin-top:2px;max-height:210px;overflow:auto;z-index:60;box-shadow:0 6px 16px rgba(0,0,0,.18)"></div>'+(_wpn?'<div style="font-size:10px;color:var(--muted);font-family:monospace;margin-top:2px">PN '+esc(_wpn)+'</div>':'')+'</div><input class="wep-qty" type="number" placeholder="Qty" oninput="wepQtyChg(this)" value="'+(n&&q!=null&&q!==''?q:(q===0?0:''))+'" style="width:58px;box-sizing:border-box;border:1.5px solid var(--border);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit"/><input class="wep-cost" type="number" step="0.01" placeholder="$" value="'+(c!=null&&c!==''?c:'')+'" style="width:72px;box-sizing:border-box;border:1.5px solid var(--border);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit"/><button onclick="weRemovePart(this)" style="background:#ef4444;border:none;color:#fff;border-radius:7px;width:30px;height:32px;cursor:pointer;font-weight:700;flex-shrink:0">\u00d7</button></div>';}
function _wepMatches(q){q=q.toLowerCase().trim();var out=[];if(!q||!D.parts)return out;for(var i=0;i<D.parts.length&&out.length<8;i++){var p=D.parts[i];var hay=((p.name||'')+' '+(p.partNumber||'')).toLowerCase();if(hay.indexOf(q)>=0)out.push(p);}return out;}
function wepSearch(inp){var wrap=inp.parentNode,dd=wrap&&wrap.querySelector('.wep-dd');if(!dd)return;var _r0=inp.closest&&inp.closest('.we-prow');if(_r0)_r0.removeAttribute('data-pid');var q=inp.value||'';if(q.trim().length<1){dd.style.display='none';dd.innerHTML='';return;}var ms=_wepMatches(q);if(!ms.length){dd.innerHTML='<div style="padding:7px 9px;font-size:11px;color:var(--muted)">No match \u2014 will be saved as a custom part name.</div>';dd.style.display='block';return;}var h='';for(var i=0;i<ms.length;i++){var p=ms[i],oh=Number(p.qty)||0,bc=oh>0?'#16a34a':'#dc2626';h+='<div data-pid="'+p.id+'" onmousedown="wepPick(this)" style="padding:7px 9px;border-bottom:1px solid var(--border);cursor:pointer">'+'<div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.name)+'</div>'+'<div style="font-size:10px;color:var(--muted)">'+(p.partNumber?esc(p.partNumber)+' \u00b7 ':'')+'<span style="color:'+bc+';font-weight:700">stock '+oh+'</span>'+((Number(p.qtyUsed)||0)>0?' \u00b7 <span style="color:#7c3aed;font-weight:700">used '+(Number(p.qtyUsed)||0)+'</span>':'')+((typeof partReservedQty==='function'&&partReservedQty(p)>0)?' \u00b7 '+partAvailableQty(p)+' avail':'')+(p.unitCost?' \u00b7 $'+Number(p.unitCost).toFixed(2):'')+'</div></div>';}dd.innerHTML=h;dd.style.display='block';}
function wepPick(item){var row=item.closest('.we-prow');if(!row)return;var pid=item.getAttribute('data-pid'),p=null;for(var i=0;i<D.parts.length;i++)if(D.parts[i].id===pid){p=D.parts[i];break;}if(!p)return;var nameInp=row.querySelector('.wep-name'),qtyInp=row.querySelector('.wep-qty'),costInp=row.querySelector('.wep-cost'),dd=row.querySelector('.wep-dd');nameInp.value=p.name;row.setAttribute('data-pid',p.id);if(!qtyInp.value)qtyInp.value=1;var _q=parseFloat(qtyInp.value)||1;if(p.unitCost!=null){row.setAttribute('data-unit',Number(p.unitCost));costInp.value=(Number(p.unitCost)*_q).toFixed(2);}if(dd){dd.style.display='none';dd.innerHTML='';}}
function wepHide(inp){var wrap=inp.parentNode,dd=wrap&&wrap.querySelector('.wep-dd');if(dd)setTimeout(function(){dd.style.display='none';},160);}
function _woAssetList(){var out=[];if(D.karts){var tr=['euro','road','sprint','kiddie'];for(var t=0;t<tr.length;t++){var ks=D.karts[tr[t]]||[];for(var i=0;i<ks.length;i++){var lbl=kartLabel(ks[i]);if(lbl)out.push({name:lbl,kind:'Kart'});}}}if(D.assets){for(var i=0;i<D.assets.length;i++){var a=D.assets[i];if(a&&a.name)out.push({name:a.name,kind:(a.category==='ride'?'Ride':'Asset')});}}if(D.arcadeMachines){for(var ai=0;ai<D.arcadeMachines.length;ai++){var am=D.arcadeMachines[ai];if(am&&am.name)out.push({name:am.name,kind:'Arcade'});}}if(D.engines){for(var ei=0;ei<D.engines.length;ei++){var e=D.engines[ei];if(!e||!e.id)continue;var enm=(e.model||'Engine')+(e.serial?(' #'+e.serial):'')+' ('+e.id+')';out.push({name:enm,kind:'Engine'});}}return out;}
function waSearch(inp){var dd=document.getElementById('we-asset-dd');if(!dd)return;var q=(inp.value||'').toLowerCase().trim();if(q.length<1){dd.style.display='none';dd.innerHTML='';return;}var all=_woAssetList(),ms=[];for(var i=0;i<all.length&&ms.length<10;i++)if(all[i].name.toLowerCase().indexOf(q)>=0)ms.push(all[i]);if(!ms.length){dd.style.display='none';dd.innerHTML='';return;}var h='';for(var i=0;i<ms.length;i++){h+='<div onmousedown="waPick(this)" data-name="'+esc(ms[i].name)+'" style="padding:7px 9px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center"><span style="font-size:13px;font-weight:600">'+esc(ms[i].name)+'</span><span style="font-size:9px;font-weight:700;color:var(--muted);background:var(--bg);border-radius:5px;padding:1px 6px;flex-shrink:0">'+esc(ms[i].kind)+'</span></div>';}dd.innerHTML=h;dd.style.display='block';}
function waPick(item){var inp=document.getElementById('we-asset');if(inp)inp.value=item.getAttribute('data-name');var dd=document.getElementById('we-asset-dd');if(dd){dd.style.display='none';dd.innerHTML='';}}
function waHide(inp){var dd=document.getElementById('we-asset-dd');if(dd)setTimeout(function(){dd.style.display='none';},160);}
function weRenderParts(parts){var el=document.getElementById('we-parts');if(!el)return;var h='';for(var i=0;i<parts.length;i++)h+=weProw(parts[i].name,parts[i].qty,parts[i].cost,parts[i].pid);el.innerHTML=h;}
function weAddPart(){var el=document.getElementById('we-parts');if(el)el.insertAdjacentHTML('beforeend',weProw('','',''));}
function wepQtyChg(inp){var row=inp.closest&&inp.closest('.we-prow');if(!row)return;var u=parseFloat(row.getAttribute('data-unit'));var q=parseFloat(inp.value)||0;var costInp=row.querySelector('.wep-cost');if(costInp&&isFinite(u)&&u>0){costInp.value=(u*q).toFixed(2);}}
function weRemovePart(btn){var r=btn.closest('.we-prow');if(r&&r.parentNode)r.parentNode.removeChild(r);}
var weId=null;var weNew=false;
function openWOEdit(id){var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){w=D.workOrders[i];break;}if(!w)return;weId=id;
  document.getElementById('we-title').value=w.title||'';
  document.getElementById('we-type').value=w.type||'reactive';
  document.getElementById('we-pri').value=w.priority||'medium';
  document.getElementById('we-status').value=w.status||'open';
  document.getElementById('we-asset').value=w.assetId||'';
  document.getElementById('we-assignee').value=w.assignee||'';
  document.getElementById('we-cost').value=(w.cost!=null?w.cost:'');var _opE=document.getElementById('we-otherparts');if(_opE)_opE.value=(w.otherPartsCost!=null?w.otherPartsCost:'');
  document.getElementById('we-due').value=w.dueDate||'';
  document.getElementById('we-completed').value=w.completed||'';
  document.getElementById('we-desc').value=w.description||'';
  var _lm=(w.laborMins!=null?w.laborMins:(w.laborHours!=null?Math.round(w.laborHours*60):null));
  if(_lm==null && w.estMins) _lm=w.estMins; // PM: prefill from the schedule estimate
  document.getElementById('we-labor-h').value=(_lm!=null?Math.floor(_lm/60):'');
  document.getElementById('we-labor-m').value=(_lm!=null?(_lm%60):'');
  weNew=false;var _wmt=document.getElementById('we-modal-title');if(_wmt)_wmt.textContent='Edit Work Order';
  var _wv=document.getElementById('we-vendor');if(_wv)_wv.innerHTML=weVendorOpts(w.vendorId||'');
  var _wvp=document.getElementById('we-vparts');if(_wvp)_wvp.checked=!!w.vendorPartsProvided;
  var _iv=document.getElementById('we-isvendor');if(_iv)_iv.checked=(w.type==='vendor');
  var _oe=document.getElementById('we-oos');if(_oe)_oe.checked=!!w.oosBlocking;
  if(typeof weToggleVendor==='function')weToggleVendor();
  weRenderParts(w.partsUsed||[]);
  openM('woEditModal');}
function weToggleVendor(){
  var cb=document.getElementById('we-isvendor'); if(!cb)return;
  var on=cb.checked;
  var vr=document.getElementById('we-vendor-row'); if(vr)vr.style.display=on?'':'none';
  var tr=document.getElementById('we-type-row'); if(tr)tr.style.display=on?'none':'';
}
function weVendorOpts(sel){var vs=D.vendors||[],o='<option value="">\u2014 none \u2014</option>';for(var i=0;i<vs.length;i++)o+='<option value="'+escA(vs[i].id)+'"'+(vs[i].id===sel?' selected':'')+'>'+esc(vs[i].name||vs[i].id)+'</option>';return o;}
function _resolveAssetName(x){if(!x)return '';for(var i=0;i<D.assets.length;i++){if(D.assets[i].id===x)return D.assets[i].name;}return x;}
function openWONew(prefill){weId=null;weNew=true;var t=document.getElementById('we-modal-title');if(t)t.textContent='New Work Order';
  document.getElementById('we-title').value='';document.getElementById('we-type').value='reactive';document.getElementById('we-pri').value='medium';document.getElementById('we-status').value='open';
  document.getElementById('we-asset').value=_resolveAssetName(prefill);document.getElementById('we-assignee').value='';document.getElementById('we-cost').value='';var _opR=document.getElementById('we-otherparts');if(_opR)_opR.value='';
  document.getElementById('we-due').value=today();document.getElementById('we-completed').value='';document.getElementById('we-labor-h').value='';document.getElementById('we-labor-m').value='';document.getElementById('we-desc').value='';
  var _vv=document.getElementById('we-vendor');if(_vv)_vv.innerHTML=weVendorOpts('');var _vp=document.getElementById('we-vparts');if(_vp)_vp.checked=false;var _iv=document.getElementById('we-isvendor');if(_iv)_iv.checked=false;var _oe2=document.getElementById('we-oos');if(_oe2)_oe2.checked=false;if(typeof weToggleVendor==='function')weToggleVendor();
  weRenderParts([]);openM('woEditModal');}
function saveWOEdit(){if(weNew){return saveWONew();}if(!weId)return;var w=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===weId){w=D.workOrders[i];break;}if(!w){closeM('woEditModal');return;}
  var _oldStat=w.status;
  var ch=[];function _c(lbl,ov,nv){var a=(ov==null?'':String(ov)),b=(nv==null?'':String(nv));if(a!==b)ch.push(lbl+': '+(a||'(empty)')+' \u2192 '+(b||'(empty)'));}
  var nt=document.getElementById('we-title').value.trim()||w.title;
  var ntype=((document.getElementById('we-isvendor')&&document.getElementById('we-isvendor').checked)?'vendor':document.getElementById('we-type').value),npri=document.getElementById('we-pri').value,nstat=document.getElementById('we-status').value;
  var nasset=document.getElementById('we-asset').value.trim(),nasgn=document.getElementById('we-assignee').value.trim();
  var _er=resolveAssetRef(nasset),_ekid=null;
  if(_er){ nasset=_er.canonical; if(_er.kind==='kart')_ekid=_er.kartId; }
  else if(nasset && typeof confirm==='function' && !confirm('"'+nasset+'" is not an existing kart or asset.\n\nDo you intend to create a new asset by this name?')){ return; }
  w.kartId=_ekid;
  var ncost=parseFloat(document.getElementById('we-cost').value)||0,_nopc=parseFloat((document.getElementById('we-otherparts')||{}).value)||0,ndue=document.getElementById('we-due').value,ncomp=document.getElementById('we-completed').value,ndesc=document.getElementById('we-desc').value;var nlaborMins=(parseInt(document.getElementById('we-labor-h').value,10)||0)*60+(parseInt(document.getElementById('we-labor-m').value,10)||0);
  _c('Title',w.title,nt);_c('Type',w.type,ntype);_c('Priority',w.priority,npri);_c('Status',w.status,nstat);_c('Asset',w.assetId,nasset);_c('Assignee',w.assignee,nasgn);_c('Cost',w.cost,ncost);_c('Other parts cost',w.otherPartsCost||0,_nopc);_c('Due date',w.dueDate,ndue);_c('Completed',w.completed,ncomp);_c('Labor',fmtMins(w.laborMins!=null?w.laborMins:(w.laborHours!=null?Math.round(w.laborHours*60):0)),fmtMins(nlaborMins));
  if((w.description||'')!==(ndesc||''))ch.push('Description updated');
  w.title=nt;w.type=ntype;w.priority=npri;w.status=nstat;w.assetId=nasset;w.assignee=nasgn;w.cost=ncost;w.otherPartsCost=_nopc;w.dueDate=ndue;w.completed=ncomp;w.description=ndesc;w.laborMins=nlaborMins;w.laborHours=Math.round((nlaborMins/60)*100)/100;var _nv=(document.getElementById('we-vendor')?document.getElementById('we-vendor').value:'')||null;var _nvp=!!(document.getElementById('we-vparts')&&document.getElementById('we-vparts').checked);if((w.vendorId||null)!==_nv)ch.push('Vendor changed');if(!!w.vendorPartsProvided!==_nvp)ch.push(_nvp?'Marked vendor-provided parts':'Unmarked vendor-provided parts');w.vendorId=_nv;w.vendorPartsProvided=_nvp;
  if(_oldStat!=='completed'&&w.status==='completed')woDeductParts(w);else if(_oldStat==='completed'&&w.status!=='completed')woRestoreParts(w);
  var _oeE=document.getElementById('we-oos');w.oosBlocking=!!(_oeE&&_oeE.checked);
  if(w.oosBlocking&&w.kartId&&typeof setKartStatus==='function'){var _kkE=_kartFindAny(w.kartId);if(_kkE&&_kkE.status!=='oos'&&_kkE.status!=='regulatory-hold')setKartStatus(_kkE,'oos','repair '+w.id,(currentUser&&currentUser.name));}
  if(w.status==='completed'&&typeof woReleaseKartIfDone==='function')woReleaseKartIfDone(w);
  if(w.status==='completed'&&typeof arcReleaseIfDone==='function')arcReleaseIfDone(w);if(window.LVMGP_PM){if(_oldStat!=='completed'&&w.status==='completed'&&typeof LVMGP_PM.freezeOnComplete==='function')LVMGP_PM.freezeOnComplete(w);else if(_oldStat==='completed'&&w.status!=='completed'&&w.pmTmplId){w.pmFrozen=false;w.pmFrozenAt=null;var _T2=(typeof LVMGP_PM.templateById==='function')?LVMGP_PM.templateById(w.pmTmplId):null;if(_T2&&typeof LVMGP_PM.applyToWO==='function')LVMGP_PM.applyToWO(w,_T2);}}
  for(var ci=0;ci<ch.length;ci++)woLog(w,ch[ci]);
  if(typeof saveWO!=='undefined')saveWO(w);
  closeM('woEditModal');
  if(typeof pageStack!=='undefined'&&pageStack.length&&pageStack[pageStack.length-1].kind==='wo')pgRender();
  if(curTab==='workorders'&&typeof renderWOs!=='undefined')renderWOs();
  updateBadges();}
function saveWONew(){
  var nt=document.getElementById('we-title').value.trim();if(!nt){alert('Title is required.');return;}
  var _nlm=(parseInt(document.getElementById('we-labor-h').value,10)||0)*60+(parseInt(document.getElementById('we-labor-m').value,10)||0);
  var nw={id:nid('WO'),title:nt,type:((document.getElementById('we-isvendor')&&document.getElementById('we-isvendor').checked)?'vendor':document.getElementById('we-type').value),priority:document.getElementById('we-pri').value,status:document.getElementById('we-status').value,
    assetId:document.getElementById('we-asset').value.trim(),assignee:document.getElementById('we-assignee').value.trim(),
    cost:parseFloat(document.getElementById('we-cost').value)||0,otherPartsCost:parseFloat((document.getElementById('we-otherparts')||{}).value)||0,dueDate:document.getElementById('we-due').value,completed:document.getElementById('we-completed').value,
    description:document.getElementById('we-desc').value,laborMins:_nlm,laborHours:Math.round((_nlm/60)*100)/100,
    partsUsed:[],vendorId:(document.getElementById('we-vendor')?document.getElementById('we-vendor').value:'')||null,
    vendorPartsProvided:!!(document.getElementById('we-vparts')&&document.getElementById('we-vparts').checked),
    created:today(),notes:[],partsOrdered:[],changeLog:[]};
  if(!woApplyAsset(nw, nw.assetId)) return;
  var _oeN=document.getElementById('we-oos');nw.oosBlocking=!!(_oeN&&_oeN.checked);
  woLog(nw,'Created');D.workOrders.push(nw);
  if(nw.oosBlocking&&nw.kartId&&typeof setKartStatus==='function'){var _nk=_kartFindAny(nw.kartId);if(_nk&&_nk.status!=='oos'&&_nk.status!=='regulatory-hold')setKartStatus(_nk,'oos','repair '+nw.id,(currentUser&&currentUser.name));}if(nw.status==='completed'&&typeof woDeductParts==='function')woDeductParts(nw);if(typeof saveWO!=='undefined')saveWO(nw);
  weNew=false;closeM('woEditModal');
  if(curTab==='workorders'&&typeof renderWOs!=='undefined')renderWOs();
  if(typeof openWOD!=='undefined')openWOD(nw.id);
  updateBadges();}
function _kartHadBlockingWO(kartId){
  if(!kartId)return false;
  for(var i=0;i<D.workOrders.length;i++){var w=D.workOrders[i];
    var hit=(w.kartId===kartId);
    if(!hit&&typeof resolveAssetRef==='function'){var r=resolveAssetRef(w.assetId);hit=!!(r&&r.kind==='kart'&&r.kartId===kartId);}
    if(!hit)continue;
    if((w.oosBlocking===true)||(w.major===true)||/^(deficiency|system deficiency|major)/i.test(w.title||''))return true;
  }
  return false;
}
// ── INSPECT AGAIN (re-audit) ──────────────────────────────────────────────────
// A standalone single-kart (or ride/asset) inspection using the SAME checklist as
// the daily/RTS, run on demand even if one was already done today. It is a real,
// signed record kept ALONGSIDE any existing inspection — two audits in a day is
// fine. Unlike RTS it does NOT gate service: re-auditing a running kart never pulls
// it out of service on its own. If the re-audit finds a problem, the normal flag/OOS
// flow inside the sheet handles it, exactly like any inspection.
function _reauditTrackLabel(tr){return ({euro:'Euro Track',road:'Road Track',sprint:'Sprint Track',kiddie:'Kiddie Track'})[tr]||'';}
function startKartReaudit(kartId){
  var k=(typeof _kartFindAny==='function')?_kartFindAny(kartId):null;
  if(!k){ alert('Kart not found.'); return; }
  var label=_reauditTrackLabel(k.track);
  var tmpl=(typeof PREOP_TEMPLATES!=='undefined')?PREOP_TEMPLATES[label]:null;
  if(!tmpl){ alert('No inspection checklist found for this track.'); return; }
  var items=(tmpl&&tmpl.items)?JSON.parse(JSON.stringify(tmpl.items)):[];
  var kl=(typeof kartLabel==='function')?kartLabel(k):(k.num||k.id);
  var rec={id:nid('INS'),kind:'reaudit',type:'reaudit',cat:'preop',kartId:k.id,track:k.track,
    templateKey:'reaudit-'+k.track,title:'Re-Audit — '+kl,items:items,
    date:today(),createdAt:new Date().toISOString(),status:'open',results:{},flags:{},
    completedBy:'',completedAt:'',signature:null,reaudit:true,
    notice:'Additional inspection of this kart. This is a full re-audit using the same daily safety checklist. It is saved as its own record and does not replace today\'s inspection.',
    noticeTitle:'RE-AUDIT INSPECTION',
    attestText:'I inspected this kart item by item and confirm each check is complete.'};
  D.inspections=D.inspections||[]; D.inspections.push(rec);
  if(typeof saveInspection==='function')saveInspection(rec);
  if(typeof openOpsSheet==='function'){ openOpsSheet(rec.id); }
  else if(typeof renderInspections==='function'){ renderInspections(); }
  return rec;
}
function startKartReauditBtn(el){ if(el&&el.dataset&&el.dataset.kid) startKartReaudit(el.dataset.kid); }
function _rtsOpenFor(kartId){for(var i=0;i<(D.inspections||[]).length;i++){var x=D.inspections[i];if(x&&x.kind==='rts'&&x.kartId===kartId&&x.status!=='completed')return x;}return null;}
function _rtsTrackLabel(tr){return ({euro:'Euro Track',road:'Road Track',sprint:'Sprint Track',kiddie:'Kiddie Track'})[tr]||'';}
function _woTriggerRTS(w,k){
  if(!k||!w)return null;
  var ex=_rtsOpenFor(k.id); if(ex)return ex; // already awaiting an RTS inspection
  var label=_rtsTrackLabel(k.track);
  var tmpl=(typeof PREOP_TEMPLATES!=='undefined')?PREOP_TEMPLATES[label]:null;
  var items=(tmpl&&tmpl.items)?JSON.parse(JSON.stringify(tmpl.items)):[];
  var kl=(typeof kartLabel==='function')?kartLabel(k):(k.num||k.id);
  var rec={id:nid('INS'),kind:'rts',type:'rts',cat:'rts',kartId:k.id,track:k.track,woId:w.id,
    templateKey:'rts-'+k.track,title:'Return to Service \u2014 '+kl,items:items,
    date:today(),createdAt:new Date().toISOString(),status:'open',results:{},flags:{},
    completedBy:'',completedAt:'',signature:null,
    notice:'Inspect every item below on this kart before returning it to service. This is the same pre-operation safety check the kart receives each day.',
    noticeTitle:'RETURN-TO-SERVICE INSPECTION',
    attestText:'I inspected this kart, confirmed all systems are working correctly, and returned it to service.'};
  D.inspections=D.inspections||[];D.inspections.push(rec);
  if(typeof saveInspection==='function')saveInspection(rec);
  w.rtsInspId=rec.id;if(typeof saveWO==='function')saveWO(w);
  return rec;
}
function _kartShouldReturn(k){
  if(!k||k.status!=='oos')return false;
  if(typeof kartOpenMajorDef==='function'&&kartOpenMajorDef(k.id))return false; // an open repair or deficiency still blocks it
  if(_rtsOpenFor(k.id))return false; // a return-to-service inspection is pending — must pass before it runs
  return _kartHadBlockingWO(k.id); // had a blocking WO, now all completed \u2014 a manual hold with no WO is left alone
}
function woReleaseKartIfDone(w){
  if(!w||typeof setKartStatus!=='function')return;
  var k=null;
  if(w.kartId&&typeof _kartFindAny==='function')k=_kartFindAny(w.kartId);
  if(!k&&typeof resolveAssetRef==='function'){var r=resolveAssetRef(w.assetId);if(r&&r.kind==='kart'&&typeof _kartFindAny==='function')k=_kartFindAny(r.kartId);}
  if(!k){var _eid=(typeof _woEngineId==='function')?_woEngineId(w):(w.engineId||null);if(_eid&&typeof _engineKart==='function')k=_engineKart(_eid);}
  if(!k||!_kartShouldReturn(k))return;
  // Repair is done, but the kart does NOT auto-return. It must pass a return-to-service inspection first.
  if(typeof _woTriggerRTS==='function'){_woTriggerRTS(w,k);return;}
  setKartStatus(k,'operational','repair/deficiency resolved '+w.id,((typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||''),{silent:true});
}
function reconcileKartOOS(){
  if(typeof setKartStatus!=='function'||!D.karts)return [];
  var released=[],tracks=['euro','road','sprint','kiddie'];
  for(var t=0;t<tracks.length;t++){var ks=D.karts[tracks[t]]||[];
    for(var i=0;i<ks.length;i++){var k=ks[i];
      if(!k||k.status!=='oos'||!_kartShouldReturn(k))continue;
      setKartStatus(k,'operational','auto-released \u2014 no open repair or deficiency',((typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||'system'),{silent:true});
      released.push(k.id);
    }
  }
  if(released.length)console.log('reconcileKartOOS released:',released.join(', '));
  return released;
}
function _woBankClock(w){if(!w||!w.runningSince)return;var mins=Math.round((Date.now()-w.runningSince)/60000);if(mins<0)mins=0;if(mins>720)mins=720;var base=(w.laborMins!=null?w.laborMins:(w.laborHours!=null?Math.round(w.laborHours*60):0));w.laborMins=base+mins;w.laborHours=Math.round(w.laborMins/60*100)/100;w.runningSince=null;}
function updWO(id,s){for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){var _w=D.workOrders[i];var _oldStat=_w.status;if(s==='on-hold'&&_w.status!=='on-hold'&&typeof _woMissingOrdered==='function'){var _mo=_woMissingOrdered(_w);if(!_mo){alert('A work order can only be placed On Hold when a needed part is marked “Can’t find” and has been ordered.\n\nOn the part, tap “Can’t find”, then “Add to order”.');openWOD(id);return;}_w.holdReason='parts';_w.holdPart=_mo;}if(_w.status!==s)woLog(_w,'Status: '+(_w.status||'')+' → '+s+(s==='on-hold'&&_w.holdPart?' (waiting on '+_w.holdPart+')':''));if(s!=='on-hold'&&_w.holdReason==='parts'){_w.holdReason=null;_w.holdPart=null;}if(s==='in-progress'&&_w.status!=='in-progress'){if(!_w.runningSince)_w.runningSince=Date.now();if(!_w.startedAt)_w.startedAt=today();}else if(_w.status==='in-progress'&&s!=='in-progress'){_woBankClock(_w);}if(s==='completed'){if(!_w.completed)_w.completed=today();if(_w.pmSchedId&&(_w.pmDoneDate==null||_w.pmDoneDate===''))_w.pmDoneDate=_w.completed;}else if(_w.status==='completed'){_w.completed='';}_w.status=s;if(_oldStat!=='completed'&&s==='completed'&&typeof woDeductParts==='function')woDeductParts(_w);else if(_oldStat==='completed'&&s!=='completed'&&typeof woRestoreParts==='function')woRestoreParts(_w);if(s==='completed'&&typeof woReleaseKartIfDone==='function')woReleaseKartIfDone(_w);if(s==='completed'&&typeof arcReleaseIfDone==='function')arcReleaseIfDone(_w);if(window.LVMGP_PM){if(s==='completed'&&typeof LVMGP_PM.freezeOnComplete==='function')LVMGP_PM.freezeOnComplete(_w);else if(_oldStat==='completed'&&s!=='completed'&&_w.pmTmplId){_w.pmFrozen=false;_w.pmFrozenAt=null;var _T=(typeof LVMGP_PM.templateById==='function')?LVMGP_PM.templateById(_w.pmTmplId):null;if(_T&&typeof LVMGP_PM.applyToWO==='function')LVMGP_PM.applyToWO(_w,_T);}}if(typeof saveWO!=='undefined')saveWO(_w);break;}openWOD(id);if(curTab==='workorders')renderWOs();}
/* ===================== Backfill: work done before the system ================
   Bulk entry for repairs and parts spend from before the CMMS existed. One job
   per line. These records exist to make cost totals honest, so every one is
   flagged backfill:true and dateEstimated:true — counted in spend, and excluded
   from anything that reasons about WHEN work happened (PM compliance, intervals,
   time between failures). An approximate date must never masquerade as a real
   one. */
var _bfOpen={};
var BF_MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
// Accepts: 2026-03-14 | 2026-03 | Mar 2026 | March 2026 | 3/2026 | 3/14/2026 | blank.
// Month-only inputs land on the 15th, a deliberate midpoint, and are marked coarse.
function bfParseDate(raw){
  var t=String(raw||'').trim();
  if(!t) return {date:'', coarse:true, ok:true};
  var m=t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return {date:m[1]+'-'+_p2(m[2])+'-'+_p2(m[3]), coarse:false, ok:true};
  m=t.match(/^(\d{4})-(\d{1,2})$/);
  if(m) return {date:m[1]+'-'+_p2(m[2])+'-15', coarse:true, ok:true};
  m=t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m) return {date:m[3]+'-'+_p2(m[1])+'-'+_p2(m[2]), coarse:false, ok:true};
  m=t.match(/^(\d{1,2})\/(\d{4})$/);
  if(m) return {date:m[2]+'-'+_p2(m[1])+'-15', coarse:true, ok:true};
  m=t.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if(m){ var mo=BF_MONTHS[m[1].slice(0,4).toLowerCase()]||BF_MONTHS[m[1].slice(0,3).toLowerCase()];
    if(mo) return {date:m[2]+'-'+_p2(mo)+'-15', coarse:true, ok:true}; }
  return {date:'', coarse:true, ok:false};
}
function _p2(n){ n=Number(n); return (n<10?'0':'')+n; }
function _bfNum(raw){ var v=parseFloat(String(raw||'').replace(/[^0-9.\-]/g,'')); return isFinite(v)?v:0; }
// "brake pads x2 @ 18.50" / "chain, 1, 240" / "drive belt" -> {name, qty, cost}
function bfParsePart(line){
  var t=String(line||'').trim(); if(!t) return null;
  var qty=1, cost=0, name=t;
  var m=t.match(/^(.*?)[,|]\s*([0-9.]+)\s*[,|]\s*\$?([0-9.,]+)\s*$/);
  if(m){ return {name:m[1].trim(), qty:_bfNum(m[2])||1, cost:_bfNum(m[3])}; }
  m=t.match(/@\s*\$?([0-9.,]+)\s*$/);
  if(m){ cost=_bfNum(m[1]); name=t.slice(0,m.index).trim(); }
  m=name.match(/\s*[x×]\s*([0-9.]+)\s*$/i);
  if(m){ qty=_bfNum(m[1])||1; name=name.slice(0,m.index).trim(); }
  if(!name) return null;
  return {name:name, qty:qty, cost:cost};
}
function bfParseParts(txt){
  var out=[],lines=String(txt||'').split(/\r?\n/);
  for(var i=0;i<lines.length;i++){ var p=bfParsePart(lines[i]); if(p) out.push(p); }
  return out;
}
// Historical records already on this asset.
function bfRecordsFor(assetName){
  var out=[],W=(D&&D.workOrders)||[];
  var key=(typeof ahNorm==='function')?ahNorm(assetName):assetName;
  for(var i=0;i<W.length;i++){ var w=W[i];
    if(!w||!w.backfill)continue;
    var nm=(typeof ahNorm==='function')?ahNorm(w.assetId):w.assetId;
    if(nm===key) out.push(w);
  }
  out.sort(function(a,b){return String(b.completed||'').localeCompare(String(a.completed||''));});
  return out;
}
/* Per-asset historical entry. Records work and parts spend from before the CMMS
   existed so cost totals are honest. Deliberately inert: no stock movement, no
   PM clock reset, no meter change. The date may be rough, so these are flagged
   and kept out of anything that reasons about WHEN work happened. */
function histWorkSectionHtml(assetName){
  if(!assetName) return '';
  var recs=bfRecordsFor(assetName), key='hw:'+assetName, open=!!_bfOpen[key];
  var tot=0,hrs=0;
  for(var i=0;i<recs.length;i++){ tot+=(Number(recs[i].cost)||0)+((typeof woPartsCost==='function')?woPartsCost(recs[i]):0); hrs+=Number(recs[i].laborHours)||0; }
  var h='<div style="display:flex;align-items:center;gap:8px;margin:14px 2px 8px">';
  h+='<span style="font-size:13px;font-weight:800;color:var(--text)">Historical Records <span style="color:var(--muted);font-weight:700">'+recs.length+'</span></span>';
  h+='<button data-hk="'+escA(assetName)+'" onclick="hwToggleBtn(this)" style="margin-left:auto;background:'+(open?'var(--bg)':'var(--accent)')+';border:'+(open?'1px solid var(--border)':'none')+';color:'+(open?'var(--muted)':'#fff')+';border-radius:8px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">'+(open?'Cancel':'+ Add Historical')+'</button>';
  h+='</div>';
  if(recs.length){
    h+='<div style="font-size:11px;color:var(--muted);margin:0 2px 6px">'+((typeof fmtM==='function')?fmtM(tot):tot.toFixed(2))+' recorded'+(hrs?' · '+hrs+' hrs':'')+' · dates approximate</div>';
    for(var r=0;r<Math.min(recs.length,8);r++){ var w=recs[r];
      var pc=(typeof woPartsCost==='function')?woPartsCost(w):0;
      h+='<div data-wid="'+escA(w.id)+'" onclick="openWODBtn(this)" style="background:var(--card);border:1px solid var(--border);border-left:3px solid #f59e0b;border-radius:9px;padding:9px 11px;margin-bottom:5px;cursor:pointer">';
      h+='<div style="font-size:13px;font-weight:700">'+esc(w.title||'Work')+'</div>';
      h+='<div style="font-size:11px;color:var(--muted);margin-top:2px">'+esc(w.completed||'no date')+' · approx'+
         (w.laborHours?' · '+w.laborHours+' hrs':'')+
         ((pc+(Number(w.cost)||0))?' · '+((typeof fmtM==='function')?fmtM(pc+(Number(w.cost)||0)):(pc+(Number(w.cost)||0))):'')+'</div></div>';
    }
    if(recs.length>8)h+='<div style="font-size:11px;color:var(--muted);padding:2px 2px 6px">+ '+(recs.length-8)+' more</div>';
  } else if(!open){
    h+='<div style="color:var(--muted);font-size:13px;padding:2px 2px 4px">None recorded.</div>';
  }
  if(open){
    var IN='width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;font-family:inherit;background:var(--bg);margin-bottom:7px';
    var LB='font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:3px';
    h+='<div style="background:var(--card);border:1.5px solid var(--accent);border-radius:11px;padding:12px">';
    h+='<div style="font-size:11px;color:var(--muted);margin-bottom:9px;line-height:1.6">Work done before this system. Counts toward cost only — it will not move inventory, reset a PM, or change a meter.</div>';
    h+='<label style="'+LB+'">What was done</label><input id="hw-desc" placeholder="e.g. replaced drive chain" style="'+IN+'"/>';
    h+='<label style="'+LB+'">When (rough is fine)</label><input id="hw-date" placeholder="Mar 2026" style="'+IN+'"/>';
    h+='<div style="display:flex;gap:7px"><div style="flex:1"><label style="'+LB+'">Labor hours</label><input id="hw-hrs" type="number" step="0.5" placeholder="0" style="'+IN+'"/></div>';
    h+='<div style="flex:1"><label style="'+LB+'">Other cost</label><input id="hw-cost" type="number" step="0.01" placeholder="0.00" style="'+IN+'"/></div></div>';
    h+='<label style="'+LB+'">Parts used (one per line)</label>';
    h+='<textarea id="hw-parts" placeholder="brake pads x2 @ 18.50&#10;drive chain @ 240" style="'+IN+';min-height:64px;font-family:monospace;font-size:12px"></textarea>';
    h+='<div style="font-size:10px;color:var(--muted);margin:-3px 0 9px">Recorded for cost history only. Stock levels are left alone.</div>';
    h+='<button data-hk="'+escA(assetName)+'" onclick="hwSaveBtn(this)" style="width:100%;background:#16a34a;border:none;color:#fff;border-radius:9px;padding:11px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit">Add record</button>';
    h+='</div>';
  }
  return h;
}
function hwToggleBtn(el){ var k='hw:'+el.dataset.hk; _bfOpen[k]=!_bfOpen[k]; if(typeof pgRender==='function')pgRender(); }
function hwSaveBtn(el){
  var assetName=el.dataset.hk;
  function v(id){ var e=document.getElementById(id); return e?e.value:''; }
  var desc=(v('hw-desc')||'').trim();
  if(!desc){ alert('Say what was done.'); return; }
  var d=bfParseDate(v('hw-date'));
  if(!d.ok){ alert('Could not read that date. Try "Mar 2026" or "2026-03-14", or leave it blank.'); return; }
  var parts=bfParseParts(v('hw-parts')), pu=[];
  for(var i=0;i<parts.length;i++) pu.push({name:parts[i].name, qty:parts[i].qty, cost:parts[i].cost});
  var when=d.date||today();
  var wo={ id:nid('WO'), title:desc, assetId:assetName, type:'reactive', priority:'low',
           status:'completed', created:when, completed:when,
           laborHours:_bfNum(v('hw-hrs')), cost:_bfNum(v('hw-cost')),
           assignee:'', partsUsed:pu, partsUse:{}, log:[],
           description:'Historical record entered after the fact for cost tracking. Date is approximate. No stock was moved.',
           backfill:true, dateEstimated:!!d.coarse, noStock:true };
  D.workOrders.push(wo);
  if(typeof saveWO==='function')saveWO(wo);
  _bfOpen['hw:'+assetName]=false;
  if(typeof pgRender==='function')pgRender();
}

/* ============ Procedures attached to a thing (kart / asset / arcade) ========
   A procedure can live on the thing itself, not just on a job. Karts already had
   manuals; this gives every asset type the same treatment for written how-tos.
   Stored as procIds on the entity record, so it persists in the same jsonb blob
   the entity already saves to. */
function _procEntity(kind,id){
  if(kind==='kart'){ return (typeof _kartFindAny==='function')?_kartFindAny(id):null; }
  if(kind==='arcade'){ var M=(D&&D.arcadeMachines)||[]; for(var i=0;i<M.length;i++)if(M[i].id===id)return M[i]; return null; }
  var A=(D&&D.assets)||[]; for(var j=0;j<A.length;j++)if(A[j].id===id)return A[j]; return null;
}
function _procEntitySave(kind,e){
  if(!e)return;
  if(kind==='kart'){ if(typeof saveKart==='function')saveKart(e); return; }
  if(kind==='arcade'){ if(typeof dbSave==='function')dbSave('arcade_machines',e); return; }
  if(typeof saveAsset==='function')saveAsset(e);
}
var _procEntOpen={};
// Section for an asset page. Renders nothing at all when there are no procedures
// written yet AND none attached, so it stays out of the way until it is useful.
function procEntitySectionHtml(kind,id){
  var e=_procEntity(kind,id); if(!e)return '';
  var ids=e.procIds||[], all=_procAll();
  if(!ids.length && !all.length) return '';
  var key=kind+':'+id;
  var h='<div style="display:flex;align-items:center;gap:8px;margin:14px 2px 8px">';
  h+='<span style="font-size:13px;font-weight:800;color:var(--text)">Procedures <span style="color:var(--muted);font-weight:700">'+ids.length+'</span></span>';
  if(all.length)h+='<button data-pk="'+escA(key)+'" onclick="entProcPickBtn(this)" style="margin-left:auto;background:var(--accent);border:none;color:#fff;border-radius:8px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">+ Attach</button>';
  h+='</div>';
  if(!ids.length)h+='<div style="color:var(--muted);font-size:13px;padding:2px 2px 4px">None attached.</div>';
  for(var i=0;i<ids.length;i++){
    var p=_procById(ids[i]); if(!p)continue;
    var op=!!_procEntOpen[key+':'+p.id];
    h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:5px;overflow:hidden">';
    h+='<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer" data-pk="'+escA(key)+'" data-pid="'+escA(p.id)+'" onclick="entProcToggleBtn(this)">';
    h+='<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:#4338ca">'+esc(p.title||'Procedure')+'</div>';
    h+='<div style="font-size:10px;color:var(--muted)">'+(p.cat?esc(p.cat)+' · ':'')+((p.steps||[]).length)+' step'+(((p.steps||[]).length)===1?'':'s')+'</div></div>';
    h+='<span style="color:var(--muted);font-size:15px;flex-shrink:0">'+(op?'⌃':'⌄')+'</span></div>';
    if(op){
      h+='<div style="padding:0 12px 10px">';
      var st=p.steps||[];
      for(var j=0;j<st.length;j++){
        h+='<div style="display:flex;gap:8px;padding:6px 0;border-top:1px solid var(--border)">';
        h+='<div style="flex-shrink:0;width:20px;height:20px;border-radius:50%;background:var(--bg);color:var(--muted);font-size:10px;font-weight:800;line-height:20px;text-align:center">'+(j+1)+'</div>';
        h+='<div style="flex:1;min-width:0"><div style="font-size:12px;line-height:1.5">'+esc(st[j].text||'')+'</div>';
        if(st[j].image)h+='<img src="'+st[j].image+'" onclick="openImgViewer(this.src)" style="margin-top:5px;max-width:150px;border-radius:7px;border:1px solid var(--border);cursor:zoom-in"/>';
        h+='</div></div>';
      }
      if(!st.length)h+='<div style="font-size:12px;color:var(--muted);padding:6px 0">No steps written yet.</div>';
      h+='<button data-pk="'+escA(key)+'" data-pid="'+escA(p.id)+'" onclick="entProcRemoveBtn(this)" style="margin-top:6px;background:transparent;border:1px solid #fecaca;color:#dc2626;border-radius:7px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">Remove</button>';
      h+='</div>';
    }
    h+='</div>';
  }
  if(_procEntOpen['_pick:'+key]){
    h+='<div style="border:1.5px solid var(--accent);border-radius:10px;padding:6px;margin-top:6px">';
    h+='<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;padding:2px 6px 4px">Attach a procedure</div>';
    var any=false;
    for(var k=0;k<all.length;k++){
      if(ids.indexOf(all[k].id)>=0)continue; any=true;
      h+='<div data-pk="'+escA(key)+'" data-pid="'+escA(all[k].id)+'" onclick="entProcAddBtn(this)" style="padding:7px 8px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600">'+esc(all[k].title||'Untitled')+'</div>';
    }
    if(!any)h+='<div style="padding:6px 8px;font-size:11px;color:var(--muted)">All procedures are already attached.</div>';
    h+='</div>';
  }
  return h;
}
function _procKeyParts(k){ var i=k.indexOf(':'); return {kind:k.slice(0,i), id:k.slice(i+1)}; }
function _procRepaint(){
  // pgRender() redraws whatever page is on top of the stack - kart, asset or
  // arcade - so one call covers every entity type.
  if(typeof pgRender==='function')pgRender();
}
function entProcToggleBtn(el){
  var k=el.dataset.pk,p=el.dataset.pid,kk=k+':'+p;
  _procEntOpen[kk]=!_procEntOpen[kk];
  _procRepaint();
}
function entProcPickBtn(el){
  var k=el.dataset.pk;
  _procEntOpen['_pick:'+k]=!_procEntOpen['_pick:'+k];
  _procRepaint();
}
function entProcAddBtn(el){
  var k=el.dataset.pk,pid=el.dataset.pid,q=_procKeyParts(k);
  var e=_procEntity(q.kind,q.id); if(!e)return;
  e.procIds=e.procIds||[];
  if(e.procIds.indexOf(pid)<0){ e.procIds.push(pid); _procEntitySave(q.kind,e); }
  _procEntOpen['_pick:'+k]=false;
  _procRepaint();
}
function entProcRemoveBtn(el){
  var k=el.dataset.pk,pid=el.dataset.pid,q=_procKeyParts(k);
  var e=_procEntity(q.kind,q.id); if(!e)return;
  var i=(e.procIds||[]).indexOf(pid);
  if(i>=0){ e.procIds.splice(i,1); _procEntitySave(q.kind,e); }
  _procRepaint();
}

/* ===================== Procedures on a work order =====================
   A procedure is reference material, not work. It is attached to a work order
   so the method travels with the job, and it never affects status, cost or
   scheduling. PM work orders inherit their procedures from the PM template;
   anyone can attach extra ones here. */
function _procById(id){
  if(window.LVMGP_PM&&typeof LVMGP_PM.procedureById==='function')return LVMGP_PM.procedureById(id);
  var t=(D&&D.pmTemplates)||[];
  for(var i=0;i<t.length;i++)if(t[i]&&t[i].kind==='procedure'&&t[i].id===id)return t[i];
  return null;
}
function _procAll(){
  if(window.LVMGP_PM&&typeof LVMGP_PM.procedures==='function')return LVMGP_PM.procedures();
  var t=(D&&D.pmTemplates)||[],o=[];
  for(var i=0;i<t.length;i++)if(t[i]&&t[i].kind==='procedure'&&t[i].active!==false)o.push(t[i]);
  return o;
}
var _procOpen={};
function procSectionHtml(w){
  if(!w)return '';
  var ids=w.procIds||[], all=_procAll();
  if(!ids.length && !all.length) return '';
  var locked=(w.status==='completed');
  var h='<div class="ds-sec"><div class="ds-st" style="display:flex;justify-content:space-between;align-items:center">Procedures';
  if(!locked&&all.length)h+='<button data-wid="'+escA(w.id)+'" onclick="woProcPickBtn(this)" style="background:transparent;border:1px solid var(--border);color:var(--accent);border-radius:7px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">+ Attach</button>';
  h+='</div>';
  if(!ids.length){
    h+='<div style="font-size:12px;color:var(--muted)">None attached.</div>';
  }
  for(var i=0;i<ids.length;i++){
    var p=_procById(ids[i]);
    if(!p){ continue; }
    var op=!!_procOpen[w.id+':'+p.id];
    h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:9px;margin-bottom:6px;overflow:hidden">';
    h+='<div style="display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:pointer" data-wid="'+escA(w.id)+'" data-pid="'+escA(p.id)+'" onclick="woProcToggleBtn(this)">';
    h+='<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:#4338ca">'+esc(p.title||'Procedure')+'</div>';
    h+='<div style="font-size:10px;color:var(--muted);margin-top:1px">'+(p.cat?esc(p.cat)+' · ':'')+((p.steps||[]).length)+' step'+(((p.steps||[]).length)===1?'':'s')+'</div></div>';
    h+='<span style="color:var(--muted);font-size:15px;flex-shrink:0">'+(op?'⌃':'⌄')+'</span></div>';
    if(op){
      h+='<div style="padding:0 11px 10px">';
      var st=p.steps||[];
      for(var j=0;j<st.length;j++){
        h+='<div style="display:flex;gap:8px;padding:6px 0;border-top:1px solid var(--border)">';
        h+='<div style="flex-shrink:0;width:20px;height:20px;border-radius:50%;background:var(--bg);color:var(--muted);font-size:10px;font-weight:800;line-height:20px;text-align:center">'+(j+1)+'</div>';
        h+='<div style="flex:1;min-width:0"><div style="font-size:12px;line-height:1.5">'+esc(st[j].text||'')+'</div>';
        if(st[j].image)h+='<img src="'+st[j].image+'" onclick="openImgViewer(this.src)" style="margin-top:5px;max-width:150px;border-radius:7px;border:1px solid var(--border);cursor:zoom-in"/>';
        h+='</div></div>';
      }
      if(!st.length)h+='<div style="font-size:12px;color:var(--muted);padding:6px 0">No steps written yet.</div>';
      if(!locked)h+='<button data-wid="'+escA(w.id)+'" data-pid="'+escA(p.id)+'" onclick="woProcRemoveBtn(this)" style="margin-top:6px;background:transparent;border:1px solid #fecaca;color:#dc2626;border-radius:7px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">Remove</button>';
      h+='</div>';
    }
    h+='</div>';
  }
  if(_procOpen['_pick:'+w.id]){
    h+='<div style="border:1.5px solid var(--accent);border-radius:9px;padding:6px;margin-top:6px">';
    h+='<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;padding:2px 6px 4px">Attach a procedure</div>';
    for(var k=0;k<all.length;k++){
      if(ids.indexOf(all[k].id)>=0)continue;
      h+='<div data-wid="'+escA(w.id)+'" data-pid="'+escA(all[k].id)+'" onclick="woProcAddBtn(this)" style="padding:7px 8px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600">'+esc(all[k].title||'Untitled')+'</div>';
    }
    h+='</div>';
  }
  h+='</div>';
  return h;
}
function woProcToggleBtn(el){var w=el.dataset.wid,p=el.dataset.pid;var k=w+':'+p;_procOpen[k]=!_procOpen[k];openWOD(w);}
function woProcPickBtn(el){var w=el.dataset.wid;_procOpen['_pick:'+w]=!_procOpen['_pick:'+w];openWOD(w);}
function woProcAddBtn(el){
  var wid=el.dataset.wid,pid=el.dataset.pid;
  for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===wid){
    var w=D.workOrders[i];w.procIds=w.procIds||[];
    if(w.procIds.indexOf(pid)<0){w.procIds.push(pid);
      var p=_procById(pid);woLog(w,'Procedure attached: '+((p&&p.title)||pid));
      if(typeof saveWO!=='undefined')saveWO(w);}
    break;}
  _procOpen['_pick:'+wid]=false;openWOD(wid);
}
function woProcRemoveBtn(el){
  var wid=el.dataset.wid,pid=el.dataset.pid;
  for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===wid){
    var w=D.workOrders[i];var j=(w.procIds||[]).indexOf(pid);
    if(j>=0){w.procIds.splice(j,1);
      var p=_procById(pid);woLog(w,'Procedure removed: '+((p&&p.title)||pid));
      if(typeof saveWO!=='undefined')saveWO(w);}
    break;}
  openWOD(wid);
}
function addNote(id){var inp=document.getElementById('ni-'+id);if(!inp||!inp.value.trim())return;var _t=inp.value.trim();for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){var _w=D.workOrders[i];_w.notes=_w.notes||[];var _nwho=(currentUser&&currentUser.name)||'Staff';_w.notes.push(_nwho+' \u00b7 '+woNow()+': '+_t);woLog(_w,'Note added');if(typeof saveWO!=='undefined')saveWO(_w);break;}var _to=msgParseRecipients(_t);if(_to.length){msgCreate(_t,_to,id);if(typeof updateBadges==='function')updateBadges();}openWOD(id);}

/* ===================== Messaging ===================== */
function msgMembers(){return (D.teamMembers||[]).filter(function(m){return m&&m.active!==false&&(typeof tmCanSee!=='function'||tmCanSee(m));});}
function msgMemberById(idv){var a=D.teamMembers||[];for(var i=0;i<a.length;i++)if(a[i].id===idv)return a[i];return null;}
function msgMe(){return currentUser;}
var MSG_GROUPS=[
  {key:'mechanics',label:'mechanics',roles:['mechanic','lead']},
  {key:'leadership',label:'leadership',roles:['owner','gm','agm','manager']},
  {key:'rideops',label:'RideOps',roles:['operator','area-lead','manager','agm','gm']},
  {key:'everyone',label:'everyone',all:true}
];
function msgGroupMembers(g){if(!g)return [];if(g.all)return msgMembers().slice();return msgMembers().filter(function(m){return m.role&&g.roles.indexOf(m.role)>=0;});}
function _msgEsRx(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function msgParseRecipients(body){var ids=[],a=msgMembers(),me=msgMe();for(var g=0;g<MSG_GROUPS.length;g++){var grp=MSG_GROUPS[g];var rg=new RegExp('@'+_msgEsRx(grp.label)+'(?![\\w])','i');if(rg.test(body)){var mem=msgGroupMembers(grp);for(var j=0;j<mem.length;j++){if(me&&mem[j].id===me.id)continue;if(ids.indexOf(mem[j].id)<0)ids.push(mem[j].id);}}}for(var i=0;i<a.length;i++){var m=a[i];if(!m.name)continue;if(me&&m.id===me.id)continue;var rx=new RegExp('@'+_msgEsRx(m.name)+'(?![\\w])');if(rx.test(body)&&ids.indexOf(m.id)<0)ids.push(m.id);}return ids;}
function msgVisibleToMe(m){var me=msgMe();if(!me)return false;if(m.fromId===me.id)return true;return (m.toIds||[]).indexOf(me.id)>=0;}
var _msgCtxWoId=null;
function openMsgTo(prefill, woId){
  _msgCtxWoId=woId||null;
  var me=msgMe(), recs=msgMembers().filter(function(m){return !(me&&m.id===me.id)&&m.name;});
  var h='<div style="font-size:11px;color:var(--muted);margin-bottom:4px">Send to:</div>';
  var _gh='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">';for(var gi=0;gi<MSG_GROUPS.length;gi++){var gg=MSG_GROUPS[gi],gc=0,gm=msgGroupMembers(gg);for(var gj=0;gj<gm.length;gj++)if(!(me&&gm[gj].id===me.id))gc++;_gh+='<button type="button" onclick="mcPickGroup(\''+escA(gg.key)+'\')" style="border:1.5px solid var(--accent);background:#faf5ff;color:var(--accent);border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">@'+esc(gg.label)+' ('+gc+')</button>';}_gh+='</div>';h+=_gh;
  if(!recs.length){ h='<div style="font-size:12px;color:var(--muted)">No teammates available to message.</div>'; }
  for(var i=0;i<recs.length;i++){
    h+='<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:5px 2px"><input type="checkbox" class="mc-recip" value="'+escA(recs[i].id)+'" style="width:auto;margin:0"/> '+esc(recs[i].name)+(recs[i].role?' <span style="color:var(--muted);font-size:11px">\u2014 '+esc(recs[i].role)+'</span>':'')+'</label>';
  }
  var rc=document.getElementById('mc-recips'); if(rc)rc.innerHTML=h;
  var bd=document.getElementById('mc-body'); if(bd)bd.value=prefill||'';
  openM('msgComposeModal');
}
function mcPickGroup(key){var g=null;for(var i=0;i<MSG_GROUPS.length;i++)if(MSG_GROUPS[i].key===key){g=MSG_GROUPS[i];break;}if(!g)return;var me=msgMe(),mem=msgGroupMembers(g),want={};for(var j=0;j<mem.length;j++){if(me&&mem[j].id===me.id)continue;want[mem[j].id]=1;}var boxes=document.querySelectorAll('#mc-recips .mc-recip');for(var k=0;k<boxes.length;k++)if(want[boxes[k].value])boxes[k].checked=true;}
function msgComposeSend(){
  var bd=document.getElementById('mc-body'); var body=bd?bd.value.trim():'';
  if(!body){alert('Type a message.');return;}
  var ids=[], boxes=document.querySelectorAll('#mc-recips .mc-recip');
  for(var i=0;i<boxes.length;i++)if(boxes[i].checked)ids.push(boxes[i].value);
  if(!ids.length){alert('Pick at least one teammate to send to.');return;}
  var msg=msgCreate(body, ids, _msgCtxWoId);
  if(_msgCtxWoId && typeof msgToWO!=='undefined') msgToWO(msg);
  closeM('msgComposeModal');
  if(typeof updateBadges==='function')updateBadges();
  alert('Message sent to '+(msg.toNames||[]).join(', ')+'.');
}
function msgUnreadCount(){var me=msgMe();if(!me)return 0;var n=0,a=D.messages||[];for(var i=0;i<a.length;i++){var m=a[i];if((m.toIds||[]).indexOf(me.id)>=0&&!(m.readBy&&m.readBy[me.id]))n++;}return n;}
function fmtMsgTime(ts){try{var d=new Date(ts),now=new Date();var tz={timeZone:'America/Los_Angeles'};var t=d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles'});var same=d.toLocaleDateString('en-CA',tz)===now.toLocaleDateString('en-CA',tz);return same?t:(d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/Los_Angeles'})+' '+t);}catch(e){return '';}}
function msgCreate(body,toIds,woId,threadId){var me=msgMe();var toNames=[];for(var i=0;i<toIds.length;i++){var mm=msgMemberById(toIds[i]);toNames.push(mm?mm.name:toIds[i]);}var msg={id:nid('MSG'),fromId:me?me.id:'',fromName:me?me.name:'',body:body,ts:new Date().toISOString(),toIds:toIds.slice(),toNames:toNames,woId:woId||null,readBy:{},threadId:null};msg.threadId=threadId||msg.id;if(me)msg.readBy[me.id]=true;D.messages=D.messages||[];D.messages.push(msg);if(typeof dbSave!=='undefined')dbSave('messages',msg);return msg;}
function _msgTid(m){return m.threadId||m.id;}
function msgThreads(){var me=msgMe();var vis=(D.messages||[]).filter(msgVisibleToMe);var by={};for(var i=0;i<vis.length;i++){var m=vis[i];var t=_msgTid(m);(by[t]=by[t]||[]).push(m);}var out=[];for(var t in by){var ms=by[t].slice().sort(function(a,b){return (a.ts||'').localeCompare(b.ts||'');});var parts={},woId=null,unread=false,latest='';for(var j=0;j<ms.length;j++){var m=ms[j];if(m.fromId)parts[m.fromId]=m.fromName||m.fromId;var ti=m.toIds||[],tn=m.toNames||[];for(var k=0;k<ti.length;k++)parts[ti[k]]=tn[k]||ti[k];if(m.woId&&!woId)woId=m.woId;if((m.ts||'')>latest)latest=m.ts;if(me&&ti.indexOf(me.id)>=0&&!(m.readBy&&m.readBy[me.id]))unread=true;}out.push({threadId:t,msgs:ms,participants:parts,woId:woId,latest:latest,unread:unread});}out.sort(function(a,b){return (b.latest||'').localeCompare(a.latest||'');});return out;}
function _threadOthers(th){var me=msgMe(),names=[];for(var id in th.participants)if(!(me&&id===me.id))names.push(th.participants[id]);return names;}
function _threadRecipients(th){var me=msgMe(),ids=[];for(var id in th.participants)if(!(me&&id===me.id))ids.push(id);return ids;}
function openMsgThread(tid){window._msgThread=tid;renderMessages();if(typeof _navArm==='function')_navArm();}
function closeMsgThread(){window._msgThread=null;renderMessages();}
function msgReplySend(tid){var inp=document.getElementById('msg-reply');if(!inp)return;var body=inp.value.trim();if(!body)return;var ths=msgThreads(),th=null;for(var i=0;i<ths.length;i++)if(ths[i].threadId===tid){th=ths[i];break;}if(!th){alert('Conversation not found.');return;}var to=_threadRecipients(th);if(!to.length){alert('No one to reply to.');return;}var msg=msgCreate(body,to,th.woId,tid);if(th.woId)msgToWO(msg);inp.value='';renderMessages();if(typeof updateBadges==='function')updateBadges();}
function msgToWO(msg){var id=msg.woId;if(!id)return;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===id){var w=D.workOrders[i];w.notes=w.notes||[];w.notes.push((msg.fromName||'Staff')+' \u00b7 '+(msg.ts?String(msg.ts).slice(0,16).replace('T',' '):woNow())+': '+msg.body);if(typeof saveWO!=='undefined')saveWO(w);break;}}
function msgHighlight(body){var safe=esc(body),toks=[];for(var gi=0;gi<MSG_GROUPS.length;gi++)toks.push(esc(MSG_GROUPS[gi].label));var a=msgMembers();for(var i=0;i<a.length;i++)if(a[i].name)toks.push(esc(a[i].name));toks.sort(function(x,y){return y.length-x.length;});for(var k=0;k<toks.length;k++){(function(n){if(!n)return;try{var rx=new RegExp('@'+_msgEsRx(n)+'(?![\\w])','g');safe=safe.replace(rx,function(){return '<b style="color:var(--accent)">@'+n+'</b>';});}catch(e){}})(toks[k]);}return safe;}
function msgAtInput(inputId,sugId){var inp=document.getElementById(inputId),sug=document.getElementById(sugId);if(!inp||!sug)return;var val=inp.value,pos=inp.selectionStart||val.length,upto=val.slice(0,pos),at=upto.lastIndexOf('@');if(at<0){sug.style.display='none';sug.innerHTML='';return;}var frag=upto.slice(at+1);if(/\s/.test(frag)){sug.style.display='none';return;}var f=frag.toLowerCase(),me=msgMe();var gmatch=MSG_GROUPS.filter(function(g){return g.label.toLowerCase().indexOf(f)===0;});var list=msgMembers().filter(function(m){if(me&&m.id===me.id)return false;return m.name&&(m.name.toLowerCase().indexOf(f)===0||(m.username&&String(m.username).toLowerCase().indexOf(f)===0));}).slice(0,6);if(!gmatch.length&&!list.length){sug.style.display='none';return;}var h='';for(var gi=0;gi<gmatch.length;gi++){var g=gmatch[gi],cnt=msgGroupMembers(g).length;h+='<div onclick="msgPickGroup(\''+inputId+'\',\''+sugId+'\',\''+escA(g.key)+'\')" style="padding:9px 12px;cursor:pointer;font-size:14px;border-bottom:1px solid var(--border);background:#faf5ff"><span style="color:var(--accent);font-weight:700">@'+esc(g.label)+'</span> <span style="font-size:11px;color:var(--muted)">\u00b7 '+cnt+' '+(cnt===1?'person':'people')+'</span></div>';}for(var i=0;i<list.length;i++)h+='<div onclick="msgPick(\''+inputId+'\',\''+sugId+'\',\''+escA(list[i].id)+'\')" style="padding:9px 12px;cursor:pointer;font-size:14px;border-bottom:1px solid var(--border)">@'+esc(list[i].name)+'</div>';sug.innerHTML=h;sug.style.display='block';}
function msgPickGroup(inputId,sugId,key){var inp=document.getElementById(inputId);if(!inp)return;var g=null;for(var i=0;i<MSG_GROUPS.length;i++)if(MSG_GROUPS[i].key===key){g=MSG_GROUPS[i];break;}if(!g)return;var val=inp.value,pos=inp.selectionStart||val.length,upto=val.slice(0,pos),at=upto.lastIndexOf('@');if(at<0)return;inp.value=val.slice(0,at)+'@'+g.label+' '+val.slice(pos);var sug=document.getElementById(sugId);if(sug){sug.style.display='none';sug.innerHTML='';}try{inp.focus();}catch(e){}}
function msgPick(inputId,sugId,memberId){var inp=document.getElementById(inputId),m=msgMemberById(memberId);if(!inp||!m)return;var val=inp.value,pos=inp.selectionStart||val.length,upto=val.slice(0,pos),at=upto.lastIndexOf('@');if(at<0)return;inp.value=val.slice(0,at)+'@'+m.name+' '+val.slice(pos);var sug=document.getElementById(sugId);if(sug){sug.style.display='none';sug.innerHTML='';}try{inp.focus();}catch(e){}}
function msgSend(){var inp=document.getElementById('msg-body');if(!inp)return;var body=inp.value.trim();if(!body)return;var sel=document.getElementById('msg-wo');var woId=sel&&sel.value?sel.value:null;var to=msgParseRecipients(body);if(!to.length){alert('Tag who this is for — type @ and pick a teammate from the list.');return;}var msg=msgCreate(body,to,woId);if(woId)msgToWO(msg);inp.value='';renderMessages();if(typeof updateBadges==='function')updateBadges();}
function renderMessages(){var el=document.getElementById('tab-messages');if(!el)return;var me=msgMe();
  // ===== Conversation (thread) view =====
  if(window._msgThread){
    var ths=msgThreads(),th=null;for(var i=0;i<ths.length;i++)if(ths[i].threadId===window._msgThread){th=ths[i];break;}
    if(th){
      var changed=[];for(var i=0;i<th.msgs.length;i++){var m=th.msgs[i];if(me&&(m.toIds||[]).indexOf(me.id)>=0&&!(m.readBy&&m.readBy[me.id])){m.readBy=m.readBy||{};m.readBy[me.id]=true;changed.push(m);}}for(var i=0;i<changed.length;i++)if(typeof dbSave!=='undefined')dbSave('messages',changed[i]);if(changed.length&&typeof updateBadges==='function')updateBadges();
      var others=_threadOthers(th);
      var h='<div class="scroll"><div style="padding:14px;max-width:760px;margin:0 auto">';
      h+='<button onclick="closeMsgThread()" style="background:none;border:none;color:var(--accent);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;padding:0;margin-bottom:10px">\u2190 All messages</button>';
      h+='<div style="font-size:17px;font-weight:800;margin-bottom:2px">'+esc(others.map(String).join(', ')||'Conversation')+'</div>';
      if(th.woId){var w=null;for(var j=0;j<D.workOrders.length;j++)if(D.workOrders[j].id===th.woId){w=D.workOrders[j];break;}h+='<div style="margin:2px 0 6px"><button onclick="openWOD(\''+escA(th.woId)+'\')" style="background:none;border:none;color:var(--accent);font-weight:700;font-size:12px;cursor:pointer;font-family:inherit;padding:0">\u2192 '+esc(th.woId+(w&&w.title?' \u00b7 '+w.title:''))+'</button></div>';}
      h+='<div style="margin:12px 0">';
      for(var i=0;i<th.msgs.length;i++){var m=th.msgs[i];var mineFlag=(me&&m.fromId===me.id);
        h+='<div style="display:flex;justify-content:'+(mineFlag?'flex-end':'flex-start')+';margin-bottom:8px">';
        h+='<div style="max-width:80%;background:'+(mineFlag?'var(--accent)':'var(--card)')+';color:'+(mineFlag?'#fff':'inherit')+';border:1px solid '+(mineFlag?'var(--accent)':'var(--border)')+';border-radius:13px;padding:8px 12px">';
        if(!mineFlag)h+='<div style="font-size:11px;font-weight:800;color:var(--accent);margin-bottom:2px">'+esc(m.fromName||'')+'</div>';
        h+='<div style="font-size:14px;white-space:pre-wrap">'+(mineFlag?esc(m.body):msgHighlight(m.body))+'</div>';
        h+='<div style="font-size:10px;opacity:.7;margin-top:3px;text-align:right">'+esc(fmtMsgTime(m.ts))+'</div>';
        h+='</div></div>';}
      h+='</div>';
      h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px;position:sticky;bottom:0">';
      h+='<textarea id="msg-reply" placeholder="Reply\u2026" style="width:100%;box-sizing:border-box;min-height:52px;border:1px solid var(--border);border-radius:9px;padding:9px;font-family:inherit;font-size:14px;resize:vertical"></textarea>';
      h+='<div style="display:flex;justify-content:flex-end;margin-top:7px"><button onclick="msgReplySend(\''+escA(th.threadId)+'\')" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Reply</button></div>';
      h+='</div></div></div>';el.innerHTML=h;return;
    } else { window._msgThread=null; }
  }
  // ===== Inbox: new-message composer + thread list =====
  var wos=(D.workOrders||[]).filter(function(w){return w.status!=='completed';});
  var woOpts='<option value="">(not about a work order)</option>';for(var i=0;i<wos.length;i++)woOpts+='<option value="'+esc(wos[i].id)+'">'+esc(wos[i].id+' \u2014 '+(wos[i].title||''))+'</option>';
  var threads=msgThreads();
  var h='<div class="scroll"><div style="padding:14px;max-width:760px;margin:0 auto">';
  h+='<div style="font-size:18px;font-weight:800;margin-bottom:4px">Messages</div>';
  h+='<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Start a new conversation below \u2014 type <b>@</b> to tag a teammate. Replies stay in the same thread. Private to the people in it, unless a work order is attached.</div>';
  h+='<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:16px">';
  h+='<textarea id="msg-body" oninput="msgAtInput(\'msg-body\',\'msg-sug\')" placeholder="New message\u2026 use @ to tag a teammate" style="width:100%;box-sizing:border-box;min-height:56px;border:1px solid var(--border);border-radius:9px;padding:10px;font-family:inherit;font-size:14px;resize:vertical"></textarea>';
  h+='<div id="msg-sug" style="display:none;border:1px solid var(--border);border-radius:9px;margin-top:6px;max-height:180px;overflow:auto"></div>';
  h+='<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">';
  h+='<select id="msg-wo" style="flex:1;min-width:150px;border:1px solid var(--border);border-radius:9px;padding:9px;font-family:inherit;font-size:13px">'+woOpts+'</select>';
  h+='<button onclick="msgSend()" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Send</button>';
  h+='</div></div>';
  if(!threads.length)h+='<div style="text-align:center;color:var(--muted);padding:30px 0">No messages yet.</div>';
  for(var i=0;i<threads.length;i++){var th=threads[i];var last=th.msgs[th.msgs.length-1];var others=_threadOthers(th);
    var lastMine=(me&&last.fromId===me.id);var prev=(lastMine?'You: ':'')+last.body;
    h+='<div onclick="openMsgThread(\''+escA(th.threadId)+'\')" style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:11px 13px;margin-bottom:10px;cursor:pointer">';
    h+='<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:3px">';
    h+='<span style="font-weight:800;font-size:14px;display:flex;align-items:center;gap:7px">'+(th.unread?'<span style="width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block"></span>':'')+esc(others.map(String).join(', ')||'Conversation')+'</span>';
    h+='<span style="font-size:11px;color:var(--muted);white-space:nowrap">'+esc(fmtMsgTime(th.latest))+'</span></div>';
    h+='<div style="font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(prev)+'</div>';
    if(th.msgs.length>1)h+='<div style="font-size:10px;color:var(--muted);margin-top:3px">'+th.msgs.length+' messages</div>';
    h+='</div>';}
  h+='</div></div>';el.innerHTML=h;}



var vTab='vendors';







var _compEditId=null, _compDocs=[];
function openCompM(id){
  var cfA=document.getElementById('cf-asset');
  cfA.innerHTML='<option value="">Select...</option>';
  for(var i=0;i<D.assets.length;i++)cfA.innerHTML+='<option value="'+D.assets[i].id+'">'+esc(D.assets[i].name)+'</option>';
  var rec=id?(D.compliance||[]).filter(function(x){return x.id===id;})[0]:null;
  _compEditId=rec?rec.id:null;
  _compDocs=(rec&&rec.docs)?rec.docs.slice():[];
  var g=function(fid){return document.getElementById(fid);};
  g('cf-title').value=rec?(rec.title||''):'';
  g('cf-type').value=rec?(rec.type||'state-inspection'):'state-inspection';
  g('cf-inspector').value=rec?(rec.inspector||''):'';
  g('cf-cert').value=rec?(rec.cert||''):'';
  g('cf-last').value=rec?(rec.lastCompleted||''):'';
  g('cf-next').value=rec?(rec.nextDue||''):'';
  g('cf-cost').value=rec?(rec.cost||''):'';
  cfA.value=rec?(rec.assetId||''):'';
  makeSearchable('cf-asset');
  var t=document.getElementById('cf-modal-title'); if(t)t.textContent=rec?'Edit Compliance Item':'Add Compliance Item';
  var del=document.getElementById('cf-del'); if(del)del.style.display=rec?'':'none';
  _compRenderDocs();
  openM('compModal');
}
function saveComp(){
  var title=document.getElementById('cf-title').value.trim();if(!title){alert('Give the item a title.');return;}
  var g=function(fid){return document.getElementById(fid).value;};
  var fields={title:title,assetId:g('cf-asset'),type:g('cf-type'),inspector:g('cf-inspector'),cert:g('cf-cert'),lastCompleted:g('cf-last'),nextDue:g('cf-next'),cost:Number(g('cf-cost'))||0,docs:_compDocs.slice()};
  var rec;
  if(_compEditId){ rec=(D.compliance||[]).filter(function(x){return x.id===_compEditId;})[0]; if(rec){var fk;for(fk in fields)rec[fk]=fields[fk];} }
  else { rec={id:nid('C'),notes:''}; var fk2;for(fk2 in fields)rec[fk2]=fields[fk2]; D.compliance.push(rec); }
  if(rec)dbSave('compliance',rec);
  _compEditId=null;_compDocs=[];
  closeM('compModal');renderCompliance();updateBadges();
}
function deleteComp(){
  if(!_compEditId)return;
  var rec=(D.compliance||[]).filter(function(x){return x.id===_compEditId;})[0];if(!rec)return;
  if(!confirm('Delete "'+(rec.title||'this item')+'"? This also removes its attached documents.'))return;
  (rec.docs||[]).forEach(function(d){ if(d.path&&typeof sb!=='undefined'&&sb&&sb.storage){try{sb.storage.from('compliance-docs').remove([d.path]);}catch(e){}} });
  D.compliance=(D.compliance||[]).filter(function(x){return x.id!==_compEditId;});
  if(typeof dbRemove!=='undefined')dbRemove('compliance',_compEditId);
  _compEditId=null;_compDocs=[];
  closeM('compModal');renderCompliance();updateBadges();
}
function compUploadDoc(file, cb){
  if(typeof sb==='undefined'||!sb||!sb.storage){alert('Storage is not connected yet. Run the one-time Compliance Documents setup SQL first.');cb(null);return;}
  var safe=(file.name||'document').replace(/[^a-zA-Z0-9._-]/g,'_');
  var path=(typeof nid==='function'?nid('cdoc'):('cdoc'+Date.now()))+'_'+safe;
  try{
    sb.storage.from('compliance-docs').upload(path, file, {contentType:file.type||'application/octet-stream', upsert:true}).then(function(res){
      if(res&&res.error){alert('Upload failed: '+(res.error.message||res.error));cb(null);return;}
      var pub=sb.storage.from('compliance-docs').getPublicUrl(path);
      cb({id:(typeof nid==='function'?nid('cd'):'cd'+Date.now()),path:path,url:pub&&pub.data&&pub.data.publicUrl,name:file.name||'document',size:file.size||0,uploadedAt:(typeof woNow==='function'?woNow():today()),uploadedBy:(typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||''});
    }).catch(function(e){alert('Upload error: '+((e&&e.message)||e));cb(null);});
  }catch(e){alert('Upload error: '+((e&&e.message)||e));cb(null);}
}
function compUploadDocInput(input){
  var arr=(input&&input.files)?Array.prototype.slice.call(input.files):[];
  if(!arr.length)return;
  (function next(i){
    if(i>=arr.length){input.value='';_compRenderDocs();return;}
    compUploadDoc(arr[i],function(doc){ if(doc)_compDocs.push(doc); next(i+1); });
  })(0);
}
function compRemoveDoc(docId){
  var d=_compDocs.filter(function(x){return x.id===docId;})[0];
  if(d&&d.path&&typeof sb!=='undefined'&&sb&&sb.storage){try{sb.storage.from('compliance-docs').remove([d.path]);}catch(e){}}
  _compDocs=_compDocs.filter(function(x){return x.id!==docId;});
  _compRenderDocs();
}
function _compRenderDocs(){
  var box=document.getElementById('cf-docs');if(!box)return;
  var h='';
  for(var i=0;i<_compDocs.length;i++){var d=_compDocs[i];
    h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:8px;margin-bottom:5px">';
    h+='<a href="'+escA(d.url||'#')+'" target="_blank" rel="noopener" style="flex:1;min-width:0;font-size:12px;font-weight:700;color:#0891b2;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.name||'document')+'</a>';
    h+='<button type="button" onclick="compRemoveDoc(\''+escA(d.id)+'\')" style="flex:none;background:none;border:none;color:#ef4444;font-size:16px;font-weight:800;cursor:pointer;line-height:1">\u00d7</button>';
    h+='</div>';
  }
  h+='<label style="display:inline-block;margin-top:4px;background:var(--card);border:1.5px dashed var(--border);border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;color:var(--text);cursor:pointer">+ Add document<input type="file" multiple onchange="compUploadDocInput(this)" style="display:none"/></label>';
  box.innerHTML=h;
}

var incFilter='all';

function setIF(f){incFilter=f;renderIncidents();}
function openIncD(id){
  var inc=null;for(var i=0;i<D.incidents.length;i++)if(D.incidents[i].id===id){inc=D.incidents[i];break;}if(!inc)return;
  var asset=assetById(inc.assetId);
  var h='<div style="font-size:17px;font-weight:800;margin-bottom:8px;color:'+(inc.type==='guest-injury'?'#ef4444':'var(--text)')+'">'+inc.type.replace(/-/g,' ').toUpperCase()+'</div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">';
  h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Asset</div><div style="font-size:13px;font-weight:600">'+(asset?esc(asset.name):'--')+'</div></div>';
  h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Date/Time</div><div style="font-size:13px;font-weight:600">'+new Date(inc.dt).toLocaleString()+'</div></div>';
  h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Reported By</div><div style="font-size:13px;font-weight:600">'+esc(inc.by)+'</div></div>';
  h+='<div><div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">Status</div><div style="font-size:13px;font-weight:600;color:'+(inc.resolved?'#22c55e':'#ef4444')+'">'+(inc.resolved?'Resolved':'Open')+'</div></div></div>';
  h+='<div class="ds-sec"><div class="ds-st">Description</div><div style="font-size:13px;line-height:1.5">'+esc(inc.description)+'</div></div>';
  h+='<div class="ds-sec"><div class="ds-st">Immediate Action</div><div style="font-size:13px;line-height:1.5">'+esc(inc.action||'--')+'</div></div>';
  h+='<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">';
  if(!inc.resolved)h+='<button data-incid="'+id+'" onclick="resolveIncBtn(this)" style="background:#22c55e;border:none;color:#fff;border-radius:9px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Mark Resolved</button>';
  h+='<button onclick="closeDetailOpenWO(\''+escA(inc.asset||'')+'\')" style="background:var(--accent);border:none;color:#fff;border-radius:9px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">+ Create WO</button></div><div style="height:16px"></div>';
  document.getElementById('detail-content').innerHTML=h;openM('detailSheet');
}
function resolveInc(id){for(var i=0;i<D.incidents.length;i++)if(D.incidents[i].id===id){D.incidents[i].resolved=true;break;}openIncD(id);}
function openIncM(){
  var asel=document.getElementById('inc-asset');asel.innerHTML='<option value="">Select...</option>';for(var i=0;i<D.assets.length;i++)asel.innerHTML+='<option value="'+D.assets[i].id+'">'+esc(D.assets[i].name)+'</option>';makeSearchable('inc-asset');
  var now=new Date().toISOString().slice(0,16);document.getElementById('inc-dt').value=now;document.getElementById('inc-by').value='';document.getElementById('inc-desc').value='';document.getElementById('inc-action').value='';
  openM('incidentModal');
}



function toggleArcOOS(id){for(var i=0;i<D.arcadeMachines.length;i++)if(D.arcadeMachines[i].id===id){D.arcadeMachines[i].status=D.arcadeMachines[i].status==='operational'?'oos':'operational';break;}renderArcade();updateBadges();}


var partsCat='all';

function setPC(c){partsCat=c;renderParts();}
function adjP(id,d){for(var i=0;i<D.parts.length;i++)if(D.parts[i].id===id){D.parts[i].qty=Math.max(0,D.parts[i].qty+d);dbSave('parts',D.parts[i]);break;}renderParts();}
var editPartId = null;














function addMember(){var name=(document.getElementById('new-tm-name')?document.getElementById('new-tm-name').value.trim():'');var role=(document.getElementById('new-tm-role')?document.getElementById('new-tm-role').value:'');var area=(document.getElementById('new-tm-area')?document.getElementById('new-tm-area').value:'');var username=(document.getElementById('new-tm-username')?document.getElementById('new-tm-username').value.trim():'');var password=(document.getElementById('new-tm-pass')?document.getElementById('new-tm-pass').value:'');if(!name){alert('Name is required.');return;}var m={id:nid('TM'),name:name,role:role,area:area,username:username,password:password,payRate:'',availability:{},active:true,certifications:[],hidden:!!(document.getElementById('new-tm-hidden')&&document.getElementById('new-tm-hidden').checked&&tmIsSenior((currentUser&&currentUser.role)))};D.teamMembers.push(m);dbSave('team_members',m);renderTeam();}
var editTMId=null;
var DAYS=['mon','tue','wed','thu','fri','sat','sun'];
var DAY_LABELS={mon:'Mon',tue:'Tue',wed:'Wed',thu:'Thu',fri:'Fri',sat:'Sat',sun:'Sun'};
function openMemberDetail(id){editTMId=id;var m=null;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].id===id){m=D.teamMembers[i];break;}if(!m)return;document.getElementById('etm-name').value=m.name||'';var sel=document.getElementById('etm-role');sel.innerHTML='';var ro=['owner','gm','agm','manager','area-lead','lead','mechanic','operator','restaurant','arcade-tech'];for(var i=0;i<ro.length;i++)sel.innerHTML+='<option value="'+ro[i]+'"'+(m.role===ro[i]?' selected':'')+'>'+(ROLE_LABELS[ro[i]]||ro[i])+'</option>';sel.onchange=function(){var hr=document.getElementById('etm-hours-row');if(hr)hr.style.display=(['lead','mechanic'].indexOf(this.value)>=0)?'':'none';};var _hr0=document.getElementById('etm-hours-row');if(_hr0)_hr0.style.display=(['lead','mechanic'].indexOf(m.role)>=0)?'':'none';var asel=document.getElementById('etm-area');asel.innerHTML='<option value="">\u2014</option>';for(var i=0;i<AREAS.length;i++)asel.innerHTML+='<option value="'+AREAS[i]+'"'+(m.area===AREAS[i]?' selected':'')+'>'+AREAS[i]+'</option>';document.getElementById('etm-username').value=m.username||'';document.getElementById('etm-pass').value='';var _hr2=document.getElementById('etm-hidden-row');if(_hr2)_hr2.style.display=(typeof tmIsSenior==='function'&&tmIsSenior((currentUser&&currentUser.role)))?'':'none';var _hc2=document.getElementById('etm-hidden');if(_hc2)_hc2.checked=!!m.hidden;var payRow=document.getElementById('etm-pay-row');if(payRow){payRow.style.display=canSeePay()?'':'none';var pe=document.getElementById('etm-pay');if(pe)pe.value=(m.payRate!=null&&m.payRate!==''?m.payRate:'');}var av=m.availability||{};var ah='';for(var i=0;i<DAYS.length;i++){var d=DAYS[i];ah+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="width:34px;font-size:11px;font-weight:700;color:var(--muted)">'+DAY_LABELS[d]+'</span><input id="etm-av-'+d+'" value="'+esc(av[d]||'')+'" placeholder="e.g. 7a-3p or Off" style="flex:1;border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit"/></div>';}document.getElementById('etm-avail').innerHTML=ah;var sh=[];for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].mechanic===m.name)sh.push(D.shifts[i]);sh.sort(function(a,b){return (''+a.date+a.startHour).localeCompare(''+b.date+b.startHour);});var sch=sh.length?'':'<div style="font-size:12px;color:var(--muted)">No shifts scheduled.</div>';for(var i=0;i<sh.length;i++){var s=sh[i];sch+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)"><span>'+fmt(s.date)+' \u00b7 '+fmtH(s.startHour)+'</span><span style="color:var(--muted)">'+esc(s.title||'')+' ('+s.duration+'h)</span></div>';}document.getElementById('etm-sched').innerHTML=sch;openM('teamEditModal');}
function editMember(id){openMemberDetail(id);}
function saveMemberEdit(){if(!editTMId)return;var m=null;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].id===editTMId){m=D.teamMembers[i];break;}if(!m)return;var name=document.getElementById('etm-name').value.trim();var role=document.getElementById('etm-role').value;var area=document.getElementById('etm-area').value;var username=document.getElementById('etm-username').value.trim();var password=document.getElementById('etm-pass').value;if(!name){alert('Name is required.');return;}m.name=name;m.role=role;m.area=area;if(username!=='')m.username=username;if(password!=='')m.password=password;if(canSeePay()){var pv=document.getElementById('etm-pay').value;m.payRate=(pv===''?'':Number(pv));}var av={};for(var i=0;i<DAYS.length;i++){var d=DAYS[i];var inp=document.getElementById('etm-av-'+d);if(inp)av[d]=inp.value.trim();}m.availability=av;var _hc3=document.getElementById('etm-hidden');if(_hc3&&typeof tmIsSenior==='function'&&tmIsSenior((currentUser&&currentUser.role)))m.hidden=!!_hc3.checked;dbSave('team_members',m);if(m.id===currentUser.id){updateHeader();buildNav();}closeM('teamEditModal');renderTeam();}
function removeMember(id){if(id===currentUser.id){alert('You cannot remove the account you are logged in as.');return;}var m=null;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].id===id){m=D.teamMembers[i];break;}if(!m)return;if(m.role==='owner'){var owners=0;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].role==='owner')owners++;if(owners<=1){alert('Cannot remove the last Owner.');return;}}if(!confirm('Remove '+m.name+'? They will no longer be able to log in.'))return;D.teamMembers=D.teamMembers.filter(function(x){return x.id!==id;});dbRemove('team_members',id);closeM('teamEditModal');renderTeam();}

var sv='day',sd=today(),sw=monday(today()),dragData=null;var schedWOFilter='all';var schedShowPMs=true;
// A work order is a PM if it's preventive / recurring / has a PM key.
function isPMWO(w){return !!(w&&(w.type==='preventive'||w.pmKey||w.recurring));}
// A scheduled shift counts as a PM block if its linked WO is a PM.
function shiftIsPM(s){if(!s||!s.woId)return false;var w=woById(s.woId);return isPMWO(w);}
function setSchedShowPMs(v){schedShowPMs=v;renderSched();}
function setSchedView(v){sv=v;document.getElementById('vt-day').classList.toggle('on',v==='day');document.getElementById('vt-week').classList.toggle('on',v==='week');renderSched();}
function schedNav(d){if(sv==='day')sd=addD(sd,d);else sw=addD(sw,d*7);renderSched();}
function schedToday(){sd=today();sw=monday(today());renderSched();}
function weekDays(){var days=[];for(var i=0;i<7;i++)days.push(addD(sw,i));return days;}
function checkRollovers(){for(var i=0;i<D.shifts.length;i++){var s=D.shifts[i];if(!s.flagged&&isPast(s.date)&&s.date!==today()){var wo=null;for(var j=0;j<D.workOrders.length;j++)if(D.workOrders[j].id===s.woId){wo=D.workOrders[j];break;}if(wo&&wo.status!=='completed')D.shifts[i].flagged=true;}}}
function schedVisibleTeam(){var role=(currentUser&&currentUser.role)||'';if(['owner','gm','agm','manager','lead','area-lead'].indexOf(role)>=0)return TEAM.slice();var me=(currentUser&&currentUser.name)||'';var own=TEAM.filter(function(n){return n===me;});return own.length?own:(me?[me]:TEAM.slice());}
function renderSched(){
  var el=document.getElementById('tab-schedule');if(!el)return;
  if(typeof autoDedupeWOs==='function')autoDedupeWOs();
  refreshTeam();
  // Build scaffold if not present
  if(!document.getElementById('sched-lbl')){
    el.innerHTML='<div class="sched-tb"><div class="vtoggle"><button class="vtbtn on" id="vt-day" onclick="schedDay()">Day</button><button class="vtbtn" id="vt-week" onclick="schedWeek()">Week</button></div><button class="nbtn" onclick="schedNav(-1)">&lt;</button><span id="sched-lbl" style="font-size:12px;font-weight:700;min-width:90px;text-align:center"></span><button class="nbtn" onclick="schedNav(1)">&gt;</button><button class="nbtn" onclick="schedToday()" style="font-size:11px">Today</button><select id="mechFilter" style="border:1.5px solid var(--border);border-radius:8px;padding:5px 8px;font-size:11px;font-family:inherit"><option value="all">All Mechanics</option></select><button id=\"pmToggle\" onclick=\"setSchedShowPMs(!schedShowPMs)\" style=\"border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;border:1.5px solid var(--border)\">PMs</button></div><div id="preop-sched-banner"></div><div id="flag-banner"></div><div id="vnd-banner"></div><div class="wl-row" id="wl-row"></div><div class="sched-body"><div class="wo-sidebar" ondragover="schedOverUnsched(event,this)" ondragleave="schedLeaveUnsched(this)" ondrop="dropUnsched(event,this)"><div class="wos-head">Unscheduled WOs</div><div class="wos-scroll" id="wo-sidebar"></div></div><div class="cal-wrap"><div class="cal-grid" id="cal-grid" style="display:flex;min-height:100%"></div></div></div>';
  }
  var mf=( document.getElementById('mechFilter') ? document.getElementById('mechFilter').value : 'all' )||'all';
  var days=sv==='week'?weekDays():[sd];
  document.getElementById('sched-lbl').textContent=sv==='week'?fmtS(days[0])+' - '+fmtS(days[6]):fmt(sd);
  var msel=document.getElementById('mechFilter');var _vt=schedVisibleTeam();if(mf!=='all'&&_vt.indexOf(mf)<0)mf='all';if(msel){msel.innerHTML='<option value="all">All Mechanics</option>';for(var i=0;i<_vt.length;i++){var o=document.createElement('option');o.value=_vt[i];o.textContent=_vt[i];msel.appendChild(o);}msel.value=mf;msel.style.display=(_vt.length<=1)?'none':'';}
  var wlh='';for(var i=0;i<_vt.length;i++){var m=_vt[i],hrs=0;for(var j=0;j<D.shifts.length;j++){var s=D.shifts[j];if(s.mechanic===m&&days.indexOf(s.date)>=0)hrs+=s.duration;}var cap=sv==='week'?40:8,pct=Math.min(100,(hrs/cap)*100),over=hrs>cap;wlh+='<div class="wl-item"><div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="font-size:11px;font-weight:700">'+esc(m.split(' ')[0])+'</span><span style="font-size:11px;font-weight:700;color:'+(over?'#ef4444':'var(--muted)')+';font-family:monospace">'+hrs+'h</span></div><div class="wl-bar-bg"><div class="wl-bar" style="width:'+pct+'%;background:'+(over?'#ef4444':(TC[m]||'#6366f1'))+'"></div></div>'+(sv==='day'?('<div class="wh-pill" data-mech="'+esc(m)+'" data-date="'+sd+'" onclick="openWHBtn(this)" style="margin-top:6px;font-size:10px;font-weight:700;text-align:center;cursor:pointer;border:1px dashed var(--border);border-radius:6px;padding:3px 6px;color:'+(whFor(m,sd)?'#6366f1':'var(--muted)')+'">'+(whFor(m,sd)?whLabel(whFor(m,sd)):'+ set hours')+'</div>'):'')+'</div>';}
  document.getElementById('wl-row').innerHTML=wlh;
  var fl=[];for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].flagged)fl.push(D.shifts[i]);
  var fbh=fl.length?'<div class="banner banner-r"><span>!</span><span style="flex:1;font-size:12px;font-weight:700;color:#991b1b">'+fl.length+' incomplete WO'+(fl.length>1?'s':'')+' rolled over</span>':'';
  for(var i=0;i<fl.length&&i<3;i++)fbh+='<button data-sid="'+fl[i].id+'" onclick="openSupMBtn(this)" style="background:#ef4444;border:none;color:#fff;border-radius:8px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Review: '+esc(fl[i].title.slice(0,14))+'</button>';
  if(fl.length)fbh+='</div>';
  document.getElementById('flag-banner').innerHTML=fbh;
  var vn=[];for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].status==='needs-scheduling')vn.push(D.workOrders[i]);
  document.getElementById('vnd-banner').innerHTML=vn.length?'<div class="banner banner-b"><span>V</span><span style="flex:1;font-size:12px;font-weight:700;color:#0e7490">'+vn.length+' vendor PM'+(vn.length>1?'s':'')+' need scheduling</span></div>':'';
  var pipCnt;var _pp=(typeof preopProgress==='function')?preopProgress((currentUser&&currentUser.role)||null):null;if(_pp){pipCnt=Math.max(0,_pp.total-_pp.done);}else{pipCnt=0;var pip=getMyPreops();for(var i=0;i<pip.length;i++)if(!D.preopState[pip[i]]||!D.preopState[pip[i]].completed)pipCnt++;}
  document.getElementById('preop-sched-banner').innerHTML=pipCnt?'<div class="banner banner-w"><span>!</span><span style="flex:1;font-size:12px;font-weight:700;color:#92400e">'+pipCnt+' pre-op'+(pipCnt>1?'s':'')+' not yet completed</span><button onclick="setTabPreops()" style="background:#f59e0b;border:none;color:#fff;border-radius:8px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">View Pre-Ops</button></div>':'';
  var unsch=[];for(var i=0;i<D.workOrders.length;i++){var w=D.workOrders[i];if(w.arcId)continue;if((w.status==='open'||w.status==='in-progress')&&w.type!=='vendor'){if(!schedShowPMs&&isPMWO(w))continue;var sched=false;for(var j=0;j<D.shifts.length;j++)if(D.shifts[j].woId===w.id&&days.indexOf(D.shifts[j].date)>=0){sched=true;break;}if(!sched)unsch.push(w);}}
  var _pmt=document.getElementById('pmToggle');if(_pmt){_pmt.textContent=schedShowPMs?'PMs shown':'PMs hidden';_pmt.style.background=schedShowPMs?'var(--accent)':'var(--card)';_pmt.style.color=schedShowPMs?'#fff':'var(--muted)';}
  var _pr={critical:4,high:3,medium:2,low:1};
  unsch.sort(function(a,b){return (_pr[b.priority]||0)-(_pr[a.priority]||0);});
  if(schedWOFilter!=='all')unsch=unsch.filter(function(w){return (w.priority||'')===schedWOFilter;});
  var _fopts=['all','critical','high','medium','low'],_flbl={all:'All priorities',critical:'Critical',high:'High',medium:'Medium',low:'Low'};
  var _fsel='<select onchange="setSchedWOFilter(this.value)" style="width:100%;border:1.5px solid var(--border);border-radius:7px;padding:4px 6px;font-size:11px;font-family:inherit;margin-bottom:7px">';
  for(var _fo=0;_fo<_fopts.length;_fo++)_fsel+='<option value="'+_fopts[_fo]+'"'+(schedWOFilter===_fopts[_fo]?' selected':'')+'>'+_flbl[_fopts[_fo]]+'</option>';
  _fsel+='</select>';
  var sh=_fsel+'<div class="sec-lbl">Open WOs ('+unsch.length+')</div>';for(var i=0;i<unsch.length;i++){var w=unsch[i],pushed=w.status==='awaiting-parts';sh+='<div class="drag-wo'+(pushed?' pushed':'')+'" draggable="'+(pushed?'false':'true')+'" ondragstart="dstartWO(event,\''+w.id+'\')" onclick="openWOD(\''+w.id+'\')" style="cursor:pointer"><div style="display:flex;gap:4px;margin-bottom:3px">'+pill(w.priority,PC[w.priority]||'#94a3b8')+'</div><div style="font-size:11px;font-weight:700;margin-bottom:2px">'+esc(w.title)+'</div>'+(!pushed?'<button class="push-mini" data-wid="'+w.id+'" onclick="event.stopPropagation();openPushMBtn(this)">Push</button>':'')+'</div>';}
  if(!unsch.length)sh=_fsel+'<div style="text-align:center;padding:18px 8px;font-size:11px;color:var(--muted)">'+(schedWOFilter==='all'?'All WOs scheduled!':'No '+schedWOFilter+'-priority WOs unscheduled')+'</div>';
  document.getElementById('wo-sidebar').innerHTML=sh+'<div style="margin-top:10px;padding:7px;border:1px dashed var(--border);border-radius:8px;font-size:9px;color:var(--muted);text-align:center;line-height:1.4">\u2190 Drag a scheduled block here to unschedule</div>';
  buildCal(days,mf);
}
function buildCal(days,mf){
  var HRS=schedHourRange(days,mf);
  var visMechs=sv==='day'?(mf==='all'?schedVisibleTeam():[mf]):null,cols=sv==='week'?days:visMechs;
  var h='<div class="hr-labels">';for(var i=0;i<HRS.length;i++)h+='<div class="hr-lbl">'+fmtH(HRS[i])+'</div>';h+='</div><div class="cal-cols">';
  for(var ci=0;ci<cols.length;ci++){
    var col=cols[ci],isDate=sv==='week',date=isDate?col:sd,mech=isDate?null:col;
    var cSh=[];for(var i=0;i<D.shifts.length;i++){var s=D.shifts[i];if(s.date===date&&(isDate?(mf==='all'||s.mechanic===mf):s.mechanic===mech)){if(!schedShowPMs&&shiftIsPM(s))continue;cSh.push(s);}}
    var td2=isDate&&isToday(col),dHrs=0;if(!isDate){for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].mechanic===mech&&D.shifts[i].date===date)dHrs+=D.shifts[i].duration;}
    h+='<div class="cal-col">';
    if(isDate){h+='<div class="col-head'+(td2?' td':'')+'" data-col="'+col+'" onclick="if(event.target===this){sd=this.dataset.col;schedDay()}"><div style="font-size:10px;font-weight:800;color:'+(td2?'#6366f1':'var(--muted)')+';text-transform:uppercase">'+new Date(col+'T12:00:00').toLocaleDateString('en-US',{weekday:'short'})+'</div><div style="font-size:17px;font-weight:900;color:'+(td2?'#6366f1':'var(--text)')+'">'+new Date(col+'T12:00:00').getDate()+'</div><div style="font-size:9px;color:var(--muted)">'+cSh.length+'s</div></div>';}
    else{var ini=mech.split(' ').map(function(n){return n[0];}).join('');h+='<div class="col-head" style="height:50px;background:'+(TB[mech]||'#f8fafc')+';border-bottom:1px solid var(--border)"><div style="display:flex;align-items:center;gap:8px"><div style="width:28px;height:28px;border-radius:50%;background:'+(TC[mech]||'#6366f1')+';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff">'+ini+'</div><div><div style="font-size:12px;font-weight:800">'+esc(mech.split(' ')[0])+'</div><div style="font-size:10px;color:var(--muted)">'+dHrs+'h</div></div></div></div>';}
    var shadeMech=isDate?(mf!=='all'?mf:null):mech;var whw=shadeMech?whFor(shadeMech,date):null;var shadeColor=shadeMech?hexToRgba(TC[shadeMech]||'#6366f1',0.10):null;h+='<div style="position:relative">';for(var hi=0;hi<HRS.length;hi++){var hr=HRS[hi];var onsh=(whw&&inWH(hr,whw));h+='<div class="tslot" data-date="'+date+'" data-mech="'+(mech||'')+'" data-hour="'+hr+'" ondragover="event.preventDefault();this.classList.add(\'dt\')" ondragleave="this.classList.remove(\'dt\')" ondrop="dropSlot(event,this)" data-dat="'+date+'" data-mch="'+(mech||'')+'" data-hr="'+hr+'"'+(onsh?' style="background:'+shadeColor+'"':'')+' onclick="openShiftAtBtn(this)"></div>';}
    cSh.sort(function(a,b){return (Number(a.startHour)||0)-(Number(b.startHour)||0);});var _prevBot=0,MIN_H=22;for(var si=0;si<cSh.length;si++){var s=cSh[si],stc=TC[s.mechanic]||'#6366f1',stb=TB[s.mechanic]||'#eff6ff';var _dm=(s.durationMins!=null?s.durationMins:Math.round((Number(s.duration)||0)*60));var _natTop=(s.startHour-HRS[0])*PX;var ht=Math.max(MIN_H,(_dm/60)*PX-4);var top=Math.max(_natTop,_prevBot);_prevBot=top+ht+2;var _sw=null;if(s.woId){for(var _swi=0;_swi<D.workOrders.length;_swi++)if(D.workOrders[_swi].id===s.woId){_sw=D.workOrders[_swi];break;}}var _sst=_sw?_sw.status:null,_scol=(_sst&&SC[_sst])?SC[_sst]:stc,_sdone=(_sst==='completed');h+='<div class="sblock'+(s.flagged?' fl':'')+'" draggable="true" data-sid2="'+s.id+'" ondragstart="dstartSHBtn(event,this)" style="top:'+top+'px;height:'+ht+'px;background:'+(s.flagged?'#fee2e2':stb)+';border-color:'+(s.flagged?'#ef4444':stc)+';border-left:4px solid '+(s.flagged?'#ef4444':_scol)+(_sdone?';opacity:.62':'')+'"data-sid="'+s.id+'" data-flagged="'+(s.flagged?'1':'0')+'" data-woid="'+(s.woId||'')+'" onclick="schedBlockClick(this)">'+(s.flagged?'<div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1px;color:#ef4444">ROLLED OVER</div>':'')+'<div style="display:flex;align-items:center;gap:4px;min-width:0"><span style="width:7px;height:7px;border-radius:50%;background:'+_scol+';flex:none"></span><span style="font-size:9px;font-weight:800;color:'+_scol+';flex:none">'+fmtHM(s.startHour)+'</span><span style="font-size:10px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'+(_sdone?';text-decoration:line-through':'')+'">'+(_sdone?'✓ ':'')+esc(s.title)+'</span></div><div style="font-size:9px;opacity:.7;margin-top:1px">'+fmtMins(_dm)+'</div></div>';}
    h+='</div></div>';
  }
  h+='</div>';document.getElementById('cal-grid').innerHTML=h;
}

var whCtx={mech:null,date:null,dow:null};
function dowKey(date){var d=new Date(date+'T12:00:00').getDay();return ['sun','mon','tue','wed','thu','fri','sat'][d];}
function whFor(mech,date){var m=null;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].name===mech){m=D.teamMembers[i];break;}if(!m||!m.workHours)return null;var w=m.workHours[dowKey(date)];return (w&&typeof w.s==='number'&&typeof w.e==='number')?w:null;}
function inWH(hr,w){if(!w)return false;if(w.e>w.s)return hr>=w.s&&hr<w.e;return hr>=w.s||hr<w.e;}
function hexToRgba(hex,a){hex=(hex||'#6366f1').replace('#','');var r=parseInt(hex.substr(0,2),16),g=parseInt(hex.substr(2,2),16),b=parseInt(hex.substr(4,2),16);return 'rgba('+r+','+g+','+b+','+a+')';}
function whLabel(w){if(!w)return null;return fmtH(w.s)+'-'+(w.e===24?'12am':fmtH(w.e));}
function openWHBtn(el){openWHModal(el.dataset.mech,el.dataset.date);}
function openWHModal(mech,date){whCtx={mech:mech,date:date,dow:dowKey(date)};document.getElementById('wh-title').textContent='Hours \u2014 '+mech.split(' ')[0];document.getElementById('wh-sub').textContent='Every '+(DAY_LABELS[whCtx.dow]||'')+' \u00b7 repeats weekly';var w=whFor(mech,date);var ss=document.getElementById('wh-start'),es=document.getElementById('wh-end');ss.innerHTML='';es.innerHTML='';for(var hr=0;hr<24;hr++)ss.innerHTML+='<option value="'+hr+'">'+fmtH(hr)+'</option>';for(var hr=1;hr<=24;hr++)es.innerHTML+='<option value="'+hr+'">'+(hr===24?'12am':fmtH(hr))+'</option>';ss.value=w?w.s:7;es.value=w?w.e:22;openM('whModal');}
function saveWH(){var s=Number(document.getElementById('wh-start').value),e=Number(document.getElementById('wh-end').value);var m=null;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].name===whCtx.mech){m=D.teamMembers[i];break;}if(!m){closeM('whModal');return;}m.workHours=m.workHours||{};m.workHours[whCtx.dow]={s:s,e:e};dbSave('team_members',m);closeM('whModal');renderSched();}
function clearWH(){var m=null;for(var i=0;i<D.teamMembers.length;i++)if(D.teamMembers[i].name===whCtx.mech){m=D.teamMembers[i];break;}if(!m){closeM('whModal');return;}if(m.workHours&&m.workHours[whCtx.dow])delete m.workHours[whCtx.dow];dbSave('team_members',m);closeM('whModal');renderSched();}

function setSchedWOFilter(v){schedWOFilter=v;renderSched();}
function schedBlockClick(el){var wid=el.dataset.woid;if(wid){openWOD(wid);return;}if(el.dataset.flagged==='1'){openSupM(el.dataset.sid);}else{openEditShift(el.dataset.sid);}}
function schedHourRange(days,mf){
  var lo=null,hi=null,i,d,m;
  for(i=0;i<D.shifts.length;i++){var s=D.shifts[i];if(days.indexOf(s.date)<0)continue;if(mf&&mf!=='all'&&s.mechanic!==mf)continue;var a=s.startHour,b=s.startHour+s.duration;if(lo===null||a<lo)lo=a;if(hi===null||b>hi)hi=b;}
  var mechs=(mf&&mf!=='all')?[mf]:TEAM;
  for(d=0;d<days.length;d++)for(m=0;m<mechs.length;m++){var w=whFor(mechs[m],days[d]);if(w){var a2=w.s,b2=(w.e>w.s?w.e:w.e+24);if(lo===null||a2<lo)lo=a2;if(hi===null||b2>hi)hi=b2;}}
  if(lo===null){lo=7;hi=22;}
  lo=Math.max(0,Math.floor(lo));hi=Math.min(24,Math.ceil(hi));if(hi<=lo)hi=lo+1;
  var arr=[];for(var hh=lo;hh<hi;hh++)arr.push(hh);return arr;
}
function dstartWO(e,woId){dragData={type:'wo',woId:woId};e.dataTransfer.effectAllowed='copy';}
function dstartSH(e,shId){dragData={type:'shift',shId:shId};e.dataTransfer.effectAllowed='move';}
function schedOverUnsched(e,el){ if(dragData&&dragData.type==='shift'){ e.preventDefault(); if(el){el.style.background='#eef2ff';el.style.boxShadow='inset 0 0 0 2px #6366f1';} } }
function schedLeaveUnsched(el){ if(el){el.style.background='';el.style.boxShadow='';} }
function dropUnsched(e,el){
  e.preventDefault(); if(el){el.style.background='';el.style.boxShadow='';}
  if(!dragData||dragData.type!=='shift'){dragData=null;return;}
  var shId=dragData.shId,woId=null;
  for(var i=0;i<D.shifts.length;i++){if(D.shifts[i].id===shId){woId=D.shifts[i].woId;D.shifts.splice(i,1);break;}}
  if(shId)dbRemove('shifts',shId);
  if(woId){var still=false;for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].woId===woId){still=true;break;}
    if(!still){for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===woId){var w=D.workOrders[i];if(w.status==='in-progress')w.status='open';w.assignee='';saveWO(w);break;}}}
  dragData=null;renderSched();if(typeof updateBadges==='function')updateBadges();
}

var esId=null;




var supId=null;
function openSupM(shiftId){
  supId=shiftId;var s=null;for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].id===shiftId){s=D.shifts[i];break;}if(!s)return;
  document.getElementById('sup-sub').textContent='"'+s.title+'" - '+fmtS(s.date)+' with '+s.mechanic;
  var ch='';ch+='<button style="width:100%;background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;text-align:left;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:7px" onclick="supKeep()">Keep with '+esc(s.mechanic)+' - move to today</button>';
  for(var i=0;i<TEAM.length;i++)if(TEAM[i]!==s.mechanic)ch+='<button style="width:100%;background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;text-align:left;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:7px" data-mech="'+esc(TEAM[i])+'" onclick="supReassignBtn(this)">Reassign to '+esc(TEAM[i])+' today</button>';
  ch+='<button style="width:100%;background:#fff5f5;border:1.5px solid #fca5a5;border-radius:10px;padding:12px 14px;text-align:left;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:7px;color:#991b1b" data-wid="'+(s.woId||'')+'" onclick="closeSupOpenPush(this)">Push - awaiting parts</button>';
  ch+='<button style="width:100%;background:var(--bg);border:1.5px dashed var(--border);border-radius:10px;padding:12px 14px;text-align:left;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--muted)" onclick="supRemove()">Remove \u2014 not needed (delete this)</button>';
  document.getElementById('sup-choices').innerHTML=ch;openM('supModal');
}
function supKeep(){for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].id===supId){D.shifts[i].date=today();D.shifts[i].flagged=false;break;}closeM('supModal');renderSched();updateBadges();}
function supReassign(mech){for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].id===supId){D.shifts[i].mechanic=mech;D.shifts[i].date=today();D.shifts[i].flagged=false;break;}closeM('supModal');renderSched();updateBadges();}
function supRemove(){for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].id===supId){D.shifts.splice(i,1);break;}if(typeof dbRemove!=='undefined')dbRemove('shifts',supId);closeM('supModal');renderSched();updateBadges();}
var pwId=null,ppParts=[];
function openPushM(woId){pwId=woId;ppParts=[];document.getElementById('push-date').value=addD(today(),7);document.getElementById('pp-name').value='';renderPPList();openM('pushModal');}
function renderPPList(){var wo=null;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===pwId){wo=D.workOrders[i];break;}var h='';if(wo&&wo.partsOrdered)for(var i=0;i<wo.partsOrdered.length;i++){for(var j=0;j<D.parts.length;j++)if(D.parts[j].id===wo.partsOrdered[i]){h+='<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">'+esc(D.parts[j].name)+'</div>';break;}}for(var i=0;i<ppParts.length;i++)h+='<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">'+esc(ppParts[i].name)+'</div>';document.getElementById('push-parts-list').innerHTML=h;}

function confirmPush(){var pd=document.getElementById('push-date').value;for(var i=0;i<ppParts.length;i++){var id=nid('P');D.parts.push({id:id,name:ppParts[i].name,qty:1,unit:'each',sku:'',minQty:0,cost:0,section:'',category:'general',ordered:true});for(var j=0;j<D.workOrders.length;j++)if(D.workOrders[j].id===pwId){D.workOrders[j].partsOrdered=D.workOrders[j].partsOrdered||[];D.workOrders[j].partsOrdered.push(id);break;}}for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===pwId){D.workOrders[i].status='awaiting-parts';D.workOrders[i].pushedDate=pd;break;}for(var i=0;i<D.shifts.length;i++)if(D.shifts[i].woId===pwId){D.shifts[i].date=pd;D.shifts[i].flagged=false;}ppParts=[];closeM('pushModal');renderSched();renderWOs();renderParts();updateBadges();}

var aiOn=false,aiHist=[];
function toggleAI(){aiOn=!aiOn;document.getElementById('aiPanel').style.display=aiOn?'flex':'none';document.getElementById('aiBtn').classList.toggle('on',aiOn);if(aiOn&&!aiHist.length){aiHist.push({role:'assistant',text:'Hi! I am your LVMGP maintenance AI. Ask me about pre-ops, kart service, ride compliance, scheduling, or anything maintenance-related!'});renderAI();}}
function renderAI(){var c=document.getElementById('aiMsgs'),h='';for(var i=0;i<aiHist.length;i++){var m=aiHist[i];h+='<div class="ai-msg '+(m.role==='user'?'u':'b')+'">'+esc(m.text)+'</div>';}c.innerHTML=h;c.scrollTop=c.scrollHeight;}
async function sendAI(){
  var inp=document.getElementById('aiInput'),txt=inp.value.trim();if(!txt)return;
  inp.value='';aiHist.push({role:'user',text:txt});renderAI();
  var t=document.createElement('div');t.className='ai-typing';for(var i=0;i<3;i++){var d=document.createElement('div');d.className='ai-dp';d.style.animationDelay=i*.2+'s';t.appendChild(d);}
  document.getElementById('aiMsgs').appendChild(t);document.getElementById('aiMsgs').scrollTop=9999;
  try{
    var ak=allKarts(),kDue=0;for(var i=0;i<ak.length;i++){var s=kartStatus(ak[i]);if(s.cls==='k-svc')kDue++;}
    var openWOs=0;for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].status==='open')openWOs++;
    var ctx=ak.length+' karts ('+kDue+' need service), '+openWOs+' open WOs, '+D.compliance.length+' compliance items tracked';
    var msgs=[];for(var i=0;i<aiHist.length;i++)msgs.push({role:aiHist[i].role==='user'?'user':'assistant',content:aiHist[i].text});
    var res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,system:'You are a maintenance manager AI for Las Vegas Mini Grand Prix. Help with pre-ops, kart service, ride safety, compliance, and scheduling. Be concise. Context: '+ctx,messages:msgs})});
    var data=await res.json(),reply='Sorry, no response.';
    if(data.content)for(var i=0;i<data.content.length;i++)if(data.content[i].type==='text'){reply=data.content[i].text;break;}
    if(t.parentNode)t.parentNode.removeChild(t);aiHist.push({role:'assistant',text:reply});
  }catch(e){if(t.parentNode)if(t.parentNode)t.parentNode.removeChild(t);aiHist.push({role:'assistant',text:'Connection error. Try again.'});}
  renderAI();
}

function schedDay(){setSchedView('day');}
function schedWeek(){setSchedView('week');}

// ── FIRST-RUN DATA SEED ───────────────────────────────────────────────────────

function loadSeedDataOffline(){
  // Load seed karts into D.karts from embedded data
  var seedKarts = [{"id": "EUR-K01", "num": 1, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0001", "status": "active", "engineHrs": 383, "lastOilHrs": 338, "last50hrHrs": 338, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K02", "num": 2, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0002", "status": "active", "engineHrs": 337, "lastOilHrs": 292, "last50hrHrs": 292, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K03", "num": 3, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0003", "status": "active", "engineHrs": 215, "lastOilHrs": 170, "last50hrHrs": 170, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K04", "num": 4, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0004", "status": "active", "engineHrs": 353, "lastOilHrs": 308, "last50hrHrs": 308, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K05", "num": 5, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0005", "status": "active", "engineHrs": 442, "lastOilHrs": 397, "last50hrHrs": 397, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K06", "num": 6, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0006", "status": "active", "engineHrs": 124, "lastOilHrs": 79, "last50hrHrs": 79, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K07", "num": 7, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0007", "status": "active", "engineHrs": 263, "lastOilHrs": 218, "last50hrHrs": 218, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K08", "num": 8, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0008", "status": "active", "engineHrs": 440, "lastOilHrs": 395, "last50hrHrs": 395, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K09", "num": 9, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0009", "status": "active", "engineHrs": 407, "lastOilHrs": 362, "last50hrHrs": 362, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K10", "num": 10, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0010", "status": "active", "engineHrs": 155, "lastOilHrs": 110, "last50hrHrs": 110, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K11", "num": 11, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0011", "status": "active", "engineHrs": 339, "lastOilHrs": 294, "last50hrHrs": 294, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K12", "num": 12, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0012", "status": "active", "engineHrs": 247, "lastOilHrs": 202, "last50hrHrs": 202, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K13", "num": 13, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0013", "status": "active", "engineHrs": 371, "lastOilHrs": 326, "last50hrHrs": 326, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K14", "num": 14, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0014", "status": "active", "engineHrs": 388, "lastOilHrs": 343, "last50hrHrs": 343, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K15", "num": 15, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0015", "status": "active", "engineHrs": 405, "lastOilHrs": 360, "last50hrHrs": 360, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K16", "num": 16, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0016", "status": "active", "engineHrs": 422, "lastOilHrs": 377, "last50hrHrs": 377, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K17", "num": 17, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0017", "status": "active", "engineHrs": 439, "lastOilHrs": 394, "last50hrHrs": 394, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K18", "num": 18, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0018", "status": "active", "engineHrs": 156, "lastOilHrs": 111, "last50hrHrs": 111, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K19", "num": 19, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0019", "status": "active", "engineHrs": 173, "lastOilHrs": 128, "last50hrHrs": 128, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K20", "num": 20, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0020", "status": "active", "engineHrs": 190, "lastOilHrs": 145, "last50hrHrs": 145, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K21", "num": 21, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0021", "status": "active", "engineHrs": 207, "lastOilHrs": 162, "last50hrHrs": 162, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K22", "num": 22, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0022", "status": "active", "engineHrs": 224, "lastOilHrs": 179, "last50hrHrs": 179, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K01", "num": 1, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0101", "status": "active", "engineHrs": 123, "lastOilHrs": 78, "last50hrHrs": 78, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K02", "num": 2, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0102", "status": "active", "engineHrs": 146, "lastOilHrs": 101, "last50hrHrs": 101, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K03", "num": 3, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0103", "status": "active", "engineHrs": 169, "lastOilHrs": 124, "last50hrHrs": 124, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K04", "num": 4, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0104", "status": "active", "engineHrs": 192, "lastOilHrs": 147, "last50hrHrs": 147, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K05", "num": 5, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0105", "status": "active", "engineHrs": 215, "lastOilHrs": 170, "last50hrHrs": 170, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K06", "num": 6, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0106", "status": "active", "engineHrs": 238, "lastOilHrs": 193, "last50hrHrs": 193, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K07", "num": 7, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0107", "status": "active", "engineHrs": 261, "lastOilHrs": 216, "last50hrHrs": 216, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K08", "num": 8, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0108", "status": "active", "engineHrs": 284, "lastOilHrs": 239, "last50hrHrs": 239, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K09", "num": 9, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0109", "status": "active", "engineHrs": 307, "lastOilHrs": 262, "last50hrHrs": 262, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K10", "num": 10, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0110", "status": "active", "engineHrs": 330, "lastOilHrs": 285, "last50hrHrs": 285, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K11", "num": 11, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0111", "status": "active", "engineHrs": 353, "lastOilHrs": 308, "last50hrHrs": 308, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K12", "num": 12, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0112", "status": "active", "engineHrs": 376, "lastOilHrs": 331, "last50hrHrs": 331, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K13", "num": 13, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0113", "status": "active", "engineHrs": 399, "lastOilHrs": 354, "last50hrHrs": 354, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K14", "num": 14, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0114", "status": "active", "engineHrs": 422, "lastOilHrs": 377, "last50hrHrs": 377, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K15", "num": 15, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0115", "status": "active", "engineHrs": 445, "lastOilHrs": 400, "last50hrHrs": 400, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K16", "num": 16, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0116", "status": "active", "engineHrs": 468, "lastOilHrs": 423, "last50hrHrs": 423, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K17", "num": 17, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0117", "status": "active", "engineHrs": 491, "lastOilHrs": 446, "last50hrHrs": 446, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K18", "num": 18, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0118", "status": "active", "engineHrs": 114, "lastOilHrs": 69, "last50hrHrs": 69, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K19", "num": 19, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0119", "status": "active", "engineHrs": 137, "lastOilHrs": 92, "last50hrHrs": 92, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K20", "num": 20, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0120", "status": "active", "engineHrs": 160, "lastOilHrs": 115, "last50hrHrs": 115, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K21", "num": 21, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0121", "status": "active", "engineHrs": 183, "lastOilHrs": 138, "last50hrHrs": 138, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K22", "num": 22, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0122", "status": "active", "engineHrs": 206, "lastOilHrs": 161, "last50hrHrs": 161, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K23", "num": 23, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0123", "status": "active", "engineHrs": 229, "lastOilHrs": 184, "last50hrHrs": 184, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K24", "num": 24, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0124", "status": "active", "engineHrs": 252, "lastOilHrs": 207, "last50hrHrs": 207, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K25", "num": 25, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0125", "status": "active", "engineHrs": 275, "lastOilHrs": 230, "last50hrHrs": 230, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K26", "num": 26, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0126", "status": "active", "engineHrs": 298, "lastOilHrs": 253, "last50hrHrs": 253, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K27", "num": 27, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0127", "status": "active", "engineHrs": 321, "lastOilHrs": 276, "last50hrHrs": 276, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K28", "num": 28, "track": "road", "kartType": "Formula K F3000", "engine": "GX160", "engineId": "ENG-0128", "status": "active", "engineHrs": 344, "lastOilHrs": 299, "last50hrHrs": 299, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K29", "num": 29, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0129", "status": "active", "engineHrs": 367, "lastOilHrs": 322, "last50hrHrs": 322, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K30", "num": 30, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0130", "status": "active", "engineHrs": 390, "lastOilHrs": 345, "last50hrHrs": 345, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K31", "num": 31, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0131", "status": "active", "engineHrs": 413, "lastOilHrs": 368, "last50hrHrs": 368, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K32", "num": 32, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0132", "status": "active", "engineHrs": 436, "lastOilHrs": 391, "last50hrHrs": 391, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K33", "num": 33, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0133", "status": "active", "engineHrs": 459, "lastOilHrs": 414, "last50hrHrs": 414, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K34", "num": 34, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0134", "status": "active", "engineHrs": 482, "lastOilHrs": 437, "last50hrHrs": 437, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K01", "num": 1, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0201", "status": "active", "engineHrs": 2314, "lastOilHrs": 186, "last50hrHrs": 186, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K02", "num": 2, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0202", "status": "active", "engineHrs": 2128, "lastOilHrs": 217, "last50hrHrs": 217, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K03", "num": 3, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0203", "status": "active", "engineHrs": 2706, "lastOilHrs": 248, "last50hrHrs": 248, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K04", "num": 4, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0204", "status": "active", "engineHrs": 2474, "lastOilHrs": 279, "last50hrHrs": 279, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K05", "num": 5, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0205", "status": "active", "engineHrs": 1993, "lastOilHrs": 310, "last50hrHrs": 310, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K06", "num": 6, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0206", "status": "active", "engineHrs": 2390, "lastOilHrs": 341, "last50hrHrs": 341, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K07", "num": 7, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0207", "status": "active", "engineHrs": 2706, "lastOilHrs": 372, "last50hrHrs": 372, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K08", "num": 8, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0208", "status": "active", "engineHrs": 1409, "lastOilHrs": 403, "last50hrHrs": 403, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K09", "num": 9, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0209", "status": "active", "engineHrs": 2018, "lastOilHrs": 434, "last50hrHrs": 434, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K10", "num": 10, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0210", "status": "active", "engineHrs": 1440, "lastOilHrs": 465, "last50hrHrs": 465, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K11", "num": 11, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0211", "status": "active", "engineHrs": 2476, "lastOilHrs": 496, "last50hrHrs": 496, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K12", "num": 12, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0212", "status": "active", "engineHrs": 1433, "lastOilHrs": 527, "last50hrHrs": 527, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K13", "num": 13, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0213", "status": "active", "engineHrs": 1401, "lastOilHrs": 558, "last50hrHrs": 558, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K14", "num": 14, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0214", "status": "active", "engineHrs": 2549, "lastOilHrs": 589, "last50hrHrs": 589, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K15", "num": 15, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0215", "status": "active", "engineHrs": 836, "lastOilHrs": 620, "last50hrHrs": 620, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K16", "num": 16, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0216", "status": "active", "engineHrs": 2571, "lastOilHrs": 651, "last50hrHrs": 651, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K01", "num": 1, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0301", "status": "active", "engineHrs": 99, "lastOilHrs": 54, "last50hrHrs": 54, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K02", "num": 2, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0302", "status": "active", "engineHrs": 118, "lastOilHrs": 73, "last50hrHrs": 73, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K03", "num": 3, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0303", "status": "active", "engineHrs": 137, "lastOilHrs": 92, "last50hrHrs": 92, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K04", "num": 4, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0304", "status": "active", "engineHrs": 156, "lastOilHrs": 111, "last50hrHrs": 111, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K05", "num": 5, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0305", "status": "active", "engineHrs": 175, "lastOilHrs": 130, "last50hrHrs": 130, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K06", "num": 6, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0306", "status": "active", "engineHrs": 194, "lastOilHrs": 149, "last50hrHrs": 149, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K07", "num": 7, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0307", "status": "active", "engineHrs": 213, "lastOilHrs": 168, "last50hrHrs": 168, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K08", "num": 8, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0308", "status": "active", "engineHrs": 232, "lastOilHrs": 187, "last50hrHrs": 187, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K09", "num": 9, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0309", "status": "active", "engineHrs": 251, "lastOilHrs": 206, "last50hrHrs": 206, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K10", "num": 10, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0310", "status": "active", "engineHrs": 270, "lastOilHrs": 225, "last50hrHrs": 225, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K11", "num": 11, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0311", "status": "active", "engineHrs": 89, "lastOilHrs": 44, "last50hrHrs": 44, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K12", "num": 12, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0312", "status": "active", "engineHrs": 108, "lastOilHrs": 63, "last50hrHrs": 63, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}];
  D.karts={euro:[],road:[],sprint:[],kiddie:[]};
  for(var i=0;i<seedKarts.length;i++){
    var k=seedKarts[i];
    if(D.karts[k.track])D.karts[k.track].push(k);
  }
  sortKarts();
  console.log("Offline: loaded",seedKarts.length,"karts into memory");
  // Engines come from the database; do not re-seed from code (deletions must stick).
  if(!D.engines) D.engines=[];
  if(typeof showLoadingOverlay==='function')showLoadingOverlay(false);
  updateBadges();
  window._dataReady=true;
  if(typeof curTab!=='undefined'&&curTab)setTab(curTab);
  if(window.LVMGP_PM&&typeof LVMGP_PM.check==='function'){try{LVMGP_PM.check();}catch(e){}}
}

var SWO_LIBRARY = [{"id": "k-oil", "title": "Engine Oil Change", "cat": "Engine PM", "assets": ["all"], "mins": 20, "parts": [{"n": "Engine Oil 10W-30 (qt)", "sku": "OIL-10W30", "qty": 1, "cost": 6.5}, {"n": "Drain Plug Washer", "sku": "DRAIN-WASH", "qty": 1, "cost": 0.75}]}, {"id": "k-plug", "title": "Spark Plug Replace", "cat": "Engine PM", "assets": ["all"], "mins": 10, "parts": [{"n": "NGK BP6ES Spark Plug", "sku": "NGK-BP6ES", "qty": 1, "cost": 3.25}]}, {"id": "k-air", "title": "Air Filter Service", "cat": "Engine PM", "assets": ["all"], "mins": 15, "parts": [{"n": "Air Filter Element", "sku": "AIR-GX200", "qty": 1, "cost": 8.5}]}, {"id": "k-fuel-filter", "title": "Fuel Filter Replace", "cat": "Engine PM", "assets": ["all"], "mins": 15, "parts": [{"n": "Inline Fuel Filter", "sku": "FUEL-FILTER", "qty": 1, "cost": 4.5}]}, {"id": "k-valve", "title": "Valve Clearance Adjust", "cat": "Engine PM", "assets": ["all"], "mins": 45, "parts": [{"n": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5}]}, {"id": "k-fullsvc", "title": "Full Engine Service (100hr)", "cat": "Engine PM", "assets": ["all"], "mins": 60, "parts": [{"n": "Engine Oil 10W-30", "sku": "OIL-10W30", "qty": 1, "cost": 6.5}, {"n": "NGK BP6ES Spark Plug", "sku": "NGK-BP6ES", "qty": 1, "cost": 3.25}, {"n": "Air Filter Element", "sku": "AIR-GX200", "qty": 1, "cost": 8.5}, {"n": "Drain Plug Washer", "sku": "DRAIN-WASH", "qty": 1, "cost": 0.75}]}, {"id": "k-carb-adj", "title": "Carburetor Adjustment", "cat": "Engine Repair", "assets": ["all"], "mins": 20, "parts": []}, {"id": "k-carb-rebuild", "title": "Carburetor Rebuild", "cat": "Engine Repair", "assets": ["all"], "mins": 60, "parts": [{"n": "Carb Rebuild Kit GX160/200", "sku": "CARB-KIT-GX200", "qty": 1, "cost": 18.5}]}, {"id": "k-coil", "title": "Ignition Coil Replace", "cat": "Engine Repair", "assets": ["all"], "mins": 30, "parts": [{"n": "Ignition Coil GX160/200", "sku": "COIL-GX200", "qty": 1, "cost": 22.0}]}, {"id": "k-flykey", "title": "Flywheel Key Replace", "cat": "Engine Repair", "assets": ["all"], "mins": 60, "parts": [{"n": "Flywheel Woodruff Key", "sku": "FLY-KEY", "qty": 1, "cost": 2.5}]}, {"id": "k-governor", "title": "Governor Adjustment", "cat": "Engine Repair", "assets": ["all"], "mins": 20, "parts": []}, {"id": "k-starter-rope", "title": "Starter Rope Replace", "cat": "Engine Repair", "assets": ["all"], "mins": 20, "parts": [{"n": "Starter Rope", "sku": "ROPE-GX200", "qty": 1, "cost": 6.0}]}, {"id": "k-topend", "title": "Top End Rebuild (rings/valves)", "cat": "Engine Major", "assets": ["all"], "mins": 240, "parts": [{"n": "Piston Ring Set", "sku": "RINGS-GX200", "qty": 1, "cost": 25.0}, {"n": "Head Gasket", "sku": "GASKET-HEAD", "qty": 1, "cost": 12.0}, {"n": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5}, {"n": "Engine Oil 10W-30", "sku": "OIL-10W30", "qty": 1, "cost": 6.5}]}, {"id": "k-rebuild", "title": "Full Engine Rebuild", "cat": "Engine Major", "assets": ["all"], "mins": 480, "parts": [{"n": "Piston & Ring Set", "sku": "PISTON-GX200", "qty": 1, "cost": 45.0}, {"n": "Head Gasket", "sku": "GASKET-HEAD", "qty": 1, "cost": 12.0}, {"n": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5}, {"n": "Carb Rebuild Kit", "sku": "CARB-KIT-GX200", "qty": 1, "cost": 18.5}, {"n": "NGK BP6ES Spark Plug", "sku": "NGK-BP6ES", "qty": 1, "cost": 3.25}, {"n": "Engine Oil 10W-30", "sku": "OIL-10W30", "qty": 1, "cost": 6.5}]}, {"id": "k-brake-adj", "title": "Brake Adjustment", "cat": "Brakes", "assets": ["all"], "mins": 20, "parts": []}, {"id": "k-brake-pads", "title": "Brake Pad Replace", "cat": "Brakes", "assets": ["sprint"], "mins": 45, "parts": [{"n": "Brake Pad Set", "sku": "BRAKE-PAD-SPT", "qty": 1, "cost": 32.0}, {"n": "DOT 5 Brake Fluid", "sku": "FLUID-DOT5", "qty": 0.5, "cost": 7.5}]}, {"id": "k-brake-bleed", "title": "Brake System Bleed", "cat": "Brakes", "assets": ["all"], "mins": 30, "parts": [{"n": "DOT 5 Brake Fluid", "sku": "FLUID-DOT5", "qty": 1, "cost": 14.99}]}, {"id": "k-mc-rebuild", "title": "Master Cylinder Rebuild", "cat": "Brakes", "assets": ["all"], "mins": 45, "parts": [{"n": "Master Cylinder Rebuild Kit", "sku": "MC-KIT", "qty": 1, "cost": 24.5}, {"n": "DOT 5 Brake Fluid", "sku": "FLUID-DOT5", "qty": 0.5, "cost": 7.5}]}, {"id": "k-tire-pressure", "title": "Tire Pressure Check & Inflate", "cat": "Tires", "assets": ["all"], "mins": 5, "parts": []}, {"id": "k-tire-single", "title": "Single Tire Replace", "cat": "Tires", "assets": ["all"], "mins": 25, "parts": [{"n": "Kart Tire", "sku": "TIRE-STD", "qty": 2, "cost": 38.0}, {"n": "Inner Tube", "sku": "TUBE-KART", "qty": 2, "cost": 9.5}]}, {"id": "k-tire-all", "title": "All 4 Tires Replace", "cat": "Tires", "assets": ["all"], "mins": 60, "parts": [{"n": "Kart Tire", "sku": "TIRE-STD", "qty": 4, "cost": 38.0}, {"n": "Inner Tube", "sku": "TUBE-KART", "qty": 4, "cost": 9.5}]}, {"id": "k-bearings", "title": "Wheel Bearing Repack", "cat": "Tires", "assets": ["all"], "mins": 45, "parts": [{"n": "Waterproof Bearing Grease", "sku": "GREASE-WP", "qty": 1, "cost": 12.0}]}, {"id": "k-belt", "title": "Drive Belt Replace", "cat": "Drivetrain", "assets": ["euro", "road", "kiddie"], "mins": 40, "parts": [{"n": "Drive Belt Set", "sku": "BELT-KRT", "qty": 1, "cost": 24.0}]}, {"id": "k-belt-adj", "title": "Belt Tension Adjust", "cat": "Drivetrain", "assets": ["euro", "road", "kiddie"], "mins": 15, "parts": []}, {"id": "k-chain", "title": "Chain Adjustment", "cat": "Drivetrain", "assets": ["sprint"], "mins": 20, "parts": []}, {"id": "k-chain-replace", "title": "Chain Replace", "cat": "Drivetrain", "assets": ["sprint"], "mins": 30, "parts": [{"n": "Drive Chain", "sku": "CHAIN-SPT", "qty": 1, "cost": 18.0}]}, {"id": "k-clutch", "title": "Clutch Service", "cat": "Drivetrain", "assets": ["all"], "mins": 45, "parts": [{"n": "Clutch Spring Set", "sku": "CLUTCH-SPR", "qty": 1, "cost": 12.0}]}, {"id": "k-throttle", "title": "Throttle Linkage Adjustment", "cat": "Drivetrain", "assets": ["all"], "mins": 20, "parts": []}, {"id": "k-alignment", "title": "Front Wheel Alignment", "cat": "Steering", "assets": ["all"], "mins": 30, "parts": []}, {"id": "k-spindle-lube", "title": "Spindle Lubrication", "cat": "Steering", "assets": ["all"], "mins": 10, "parts": [{"n": "Waterproof Bearing Grease", "sku": "GREASE-WP", "qty": 0.5, "cost": 6.0}]}, {"id": "k-spindle-replace", "title": "Spindle Replace", "cat": "Steering", "assets": ["all"], "mins": 60, "parts": [{"n": "Front Spindle Assembly", "sku": "SPINDLE", "qty": 1, "cost": 65.0}]}, {"id": "k-seatbelt", "title": "Seat Belt Replace", "cat": "Safety", "assets": ["all"], "mins": 20, "parts": [{"n": "Seat Belt Assembly", "sku": "BELT-ASM", "qty": 1, "cost": 28.0}]}, {"id": "k-drubber-single", "title": "D-Rubber Replace (single)", "cat": "Safety", "assets": ["all"], "mins": 15, "parts": [{"n": "D-Rubber Section", "sku": "DRUB-SINGLE", "qty": 1, "cost": 8.0}]}, {"id": "k-drubber-set", "title": "D-Rubber Replace (full set)", "cat": "Safety", "assets": ["all"], "mins": 45, "parts": [{"n": "D-Rubber Set", "sku": "DRUB-SET", "qty": 1, "cost": 65.0}]}, {"id": "k-killswitch", "title": "Kill Switch Replace", "cat": "Electrical", "assets": ["all"], "mins": 20, "parts": [{"n": "Kill Switch / On-Off Switch", "sku": "KILL-SW", "qty": 1, "cost": 8.5}]}, {"id": "k-transponder", "title": "Transponder Replace / Reseat", "cat": "Electrical", "assets": ["all"], "mins": 15, "parts": [{"n": "MyLaps Transponder", "sku": "XLAP-T", "qty": 1, "cost": 85.0}]}, {"id": "k-engine-swap", "title": "Engine Swap (full pull & install)", "cat": "Engine Major", "assets": ["all"], "mins": 120, "parts": []}, {"id": "t-lube-daily", "title": "Daily Lubrication", "cat": "Daily PM", "assets": ["Tornado"], "mins": 30, "parts": [{"n": "Grease (tube)", "sku": "GREASE-WP", "qty": 1, "cost": 12.0}, {"n": "Machine Oil", "sku": "OIL-MACHINE", "qty": 1, "cost": 5.0}]}, {"id": "t-air-check", "title": "Air Compressor Service", "cat": "Pneumatic", "assets": ["Tornado"], "mins": 20, "parts": [{"n": "Air Compressor Oil", "sku": "COMP-OIL", "qty": 1, "cost": 8.0}]}, {"id": "t-lapbar-adj", "title": "Lap Bar Adjustment", "cat": "Safety", "assets": ["Tornado"], "mins": 30, "parts": []}, {"id": "t-lapbar-replace", "title": "Lap Bar Replace", "cat": "Safety", "assets": ["Tornado"], "mins": 120, "parts": [{"n": "Lap Bar Assembly", "sku": "T-LAPBAR", "qty": 1, "cost": 0}]}, {"id": "t-brake-sol", "title": "Brake Solenoid Service", "cat": "Brake", "assets": ["Tornado"], "mins": 60, "parts": [{"n": "Parker Solenoid Repair Kit", "sku": "T-BSOL-KIT", "qty": 1, "cost": 0}]}, {"id": "t-sweep-insp", "title": "Sweep Arm Inspection", "cat": "Structural", "assets": ["Tornado"], "mins": 45, "parts": []}, {"id": "t-bearing", "title": "Main Bearing Service", "cat": "Mechanical", "assets": ["Tornado"], "mins": 120, "parts": [{"n": "Main Bearing Grease", "sku": "GREASE-WP", "qty": 1, "cost": 12.0}]}, {"id": "t-airseal", "title": "Air System Seal/Line Replace", "cat": "Pneumatic", "assets": ["Tornado"], "mins": 90, "parts": []}, {"id": "dc-lube", "title": "Daily Lubrication", "cat": "Daily PM", "assets": ["Dragon Coaster"], "mins": 20, "parts": [{"n": "Chain Lube", "sku": "CHAIN-LUBE", "qty": 1, "cost": 8.0}]}, {"id": "dc-tire-check", "title": "Drive/Brake Tire Check (35psi)", "cat": "Daily PM", "assets": ["Dragon Coaster"], "mins": 15, "parts": []}, {"id": "dc-tire-replace", "title": "Drive Tire Replace", "cat": "Mechanical", "assets": ["Dragon Coaster"], "mins": 60, "parts": [{"n": "Dragon Drive Tire", "sku": "DC-DTIRE", "qty": 1, "cost": 0}]}, {"id": "dc-lapbar", "title": "Lap Bar Service", "cat": "Safety", "assets": ["Dragon Coaster"], "mins": 45, "parts": []}, {"id": "dc-belt", "title": "Motor V-Belt Replace", "cat": "Mechanical", "assets": ["Dragon Coaster"], "mins": 60, "parts": [{"n": "Motor V-Belt", "sku": "DC-VBELT", "qty": 1, "cost": 0}]}, {"id": "dc-gearbox", "title": "Gearbox Oil Check/Change", "cat": "Mechanical", "assets": ["Dragon Coaster"], "mins": 30, "parts": [{"n": "Gear Oil", "sku": "GEAR-OIL", "qty": 1, "cost": 15.0}]}, {"id": "dc-wheel-axle", "title": "Wheel Axle Bolt Inspection", "cat": "Safety", "assets": ["Dragon Coaster"], "mins": 30, "parts": []}, {"id": "dc-coupler", "title": "Car Coupler Inspection", "cat": "Structural", "assets": ["Dragon Coaster"], "mins": 30, "parts": []}, {"id": "dc-air", "title": "Air Compressor Service", "cat": "Pneumatic", "assets": ["Dragon Coaster"], "mins": 20, "parts": [{"n": "Air Compressor Oil", "sku": "COMP-OIL", "qty": 1, "cost": 8.0}]}, {"id": "fs-speed-adj", "title": "Slide Speed Adjustment (Pledge)", "cat": "Daily PM", "assets": ["Fun Slide"], "mins": 20, "parts": [{"n": "Pledge Furniture Spray", "sku": "PLEDGE", "qty": 1, "cost": 8.0}]}, {"id": "fs-mat-insp", "title": "Slide Mat Inspection / Replace", "cat": "Equipment", "assets": ["Fun Slide"], "mins": 30, "parts": [{"n": "Slide Mat", "sku": "SLIDE-MAT", "qty": 1, "cost": 0}]}, {"id": "fs-handrail", "title": "Handrail Repair / Retighten", "cat": "Safety", "assets": ["Fun Slide"], "mins": 45, "parts": []}, {"id": "fs-surface", "title": "Slide Surface Repair", "cat": "Structural", "assets": ["Fun Slide"], "mins": 120, "parts": []}, {"id": "fs-step-weld", "title": "Step Weld Inspection", "cat": "Structural", "assets": ["Fun Slide"], "mins": 30, "parts": []}, {"id": "fs-electrical", "title": "Electrical / Breaker Service", "cat": "Electrical", "assets": ["Fun Slide"], "mins": 30, "parts": []}, {"id": "k-speed-adj", "title": "Speed Adjustment", "cat": "Drivetrain", "assets": ["all"], "mins": 20, "parts": []}];
var SYMPTOM_TREES = [{"id": "s-nostart", "label": "Won't Start / No Start", "icon": "🚫", "steps": [{"label": "Check fuel level & fuel valve position", "diag_mins": 2, "swo_if_found": "k-oil", "detail": "Open cap — is there fuel? Is valve on ON?"}, {"label": "Check for spark — test spark plug", "diag_mins": 5, "swo_if_found": "k-plug", "detail": "Remove plug, reconnect wire, ground to block, pull rope. Blue spark = good. No spark = plug or coil."}, {"label": "Check kill switch / wiring", "diag_mins": 3, "swo_if_found": "k-killswitch", "detail": "Disconnect kill switch wire from coil. Try to start. If fires = switch fault."}, {"label": "Check air filter — clogged?", "diag_mins": 5, "swo_if_found": "k-air", "detail": "Remove and inspect. Saturated/clogged = clean or replace."}, {"label": "Check fuel delivery — carb getting fuel?", "diag_mins": 10, "swo_if_found": "k-carb-rebuild", "detail": "Remove air filter. Spray carb cleaner in throat. If starts briefly = carb not delivering fuel. Rebuild carb."}, {"label": "Check compression", "diag_mins": 10, "swo_if_found": "k-topend", "detail": "Use gauge — spec 85-121 PSI. Below 70 = valve or ring issue."}]}, {"id": "s-harddstart", "label": "Hard Starting / Slow to Start", "icon": "😤", "steps": [{"label": "Check spark plug condition & gap", "diag_mins": 5, "swo_if_found": "k-plug", "detail": "Gap: 0.7-0.8mm. Fouled/worn = replace."}, {"label": "Check air filter", "diag_mins": 5, "swo_if_found": "k-air", "detail": "Dirty filter chokes starting."}, {"label": "Check fuel freshness & filter", "diag_mins": 5, "swo_if_found": "k-fuel-filter", "detail": "Stale fuel = hard start. Clogged filter = fuel starvation."}, {"label": "Check carburetor adjustment", "diag_mins": 10, "swo_if_found": "k-carb-adj", "detail": "Cold choke not closing fully? Pilot screw out of spec?"}, {"label": "Check valve clearance", "diag_mins": 15, "swo_if_found": "k-valve", "detail": "Tight valves cause hard starts. GX160/200: IN 0.15mm / EX 0.20mm."}]}, {"id": "s-losspower", "label": "Loss of Power / Slow Kart", "icon": "🐢", "steps": [{"label": "Check throttle linkage — full travel?", "diag_mins": 3, "swo_if_found": "k-throttle", "detail": "Watch carb while pressing pedal — does it open fully?"}, {"label": "Check drive belt condition", "diag_mins": 5, "swo_if_found": "k-belt", "detail": "Glazed or slipping belt = major power loss."}, {"label": "Check air filter", "diag_mins": 5, "swo_if_found": "k-air", "detail": "Dirty filter starves engine of air."}, {"label": "Check spark plug", "diag_mins": 5, "swo_if_found": "k-plug", "detail": "Worn/fouled = misfires and power loss."}, {"label": "Check governor adjustment", "diag_mins": 5, "swo_if_found": "k-governor", "detail": "Max no-load RPM should be ~3,600."}, {"label": "Check carburetor — main jet gummed?", "diag_mins": 10, "swo_if_found": "k-carb-rebuild", "detail": "Flat spot under load = partial jet blockage."}, {"label": "Check compression", "diag_mins": 10, "swo_if_found": "k-topend", "detail": "Below 70 PSI = worn rings or valves."}]}, {"id": "s-rollsidle", "label": "Rolls / Creeps Forward at Idle", "icon": "🔀", "steps": [{"label": "Check idle speed — too high?", "diag_mins": 3, "swo_if_found": "k-carb-adj", "detail": "Spec: 1,400 RPM at idle. Clockwise screw = lower RPM."}, {"label": "Check throttle cable return", "diag_mins": 5, "swo_if_found": "k-throttle", "detail": "Cable or carb slide sticking open?"}, {"label": "Check centrifugal clutch — slipping at idle?", "diag_mins": 10, "swo_if_found": "k-clutch", "detail": "Gets worse when warm? Springs worn?"}]}, {"id": "s-brakes", "label": "Brakes Not Working / Soft", "icon": "🔴", "steps": [{"label": "Check brake adjustment — pedal sloppy?", "diag_mins": 5, "swo_if_found": "k-brake-adj", "detail": "Pedal should be ~90° vertical. Adjust clevis."}, {"label": "Check brake fluid level", "diag_mins": 3, "swo_if_found": "k-brake-bleed", "detail": "DOT 5 silicone only. Low = leak or worn pads."}, {"label": "Check brake pads — worn below 8mm?", "diag_mins": 10, "swo_if_found": "k-brake-pads", "detail": "Total thickness below 8mm (4mm lining min) = replace."}, {"label": "Bleed brake system — air in lines?", "diag_mins": 15, "swo_if_found": "k-brake-bleed", "detail": "Spongy pedal = air. Full bleed procedure."}, {"label": "Check master cylinder — leaking?", "diag_mins": 10, "swo_if_found": "k-mc-rebuild", "detail": "No pressure after bleed = master cylinder."}]}, {"id": "s-vibration", "label": "Excessive Vibration", "icon": "📳", "steps": [{"label": "Check tire pressure — one flat?", "diag_mins": 2, "swo_if_found": "k-tire-pressure", "detail": "Flat = severe vibration at speed."}, {"label": "Check wheel for bent rim or loose lugs", "diag_mins": 5, "swo_if_found": "k-bearings", "detail": "Spin each wheel — wobble = bent rim."}, {"label": "Check engine mounts — loose?", "diag_mins": 5, "swo_if_found": null, "detail": "Tighten all engine mount bolts."}, {"label": "Check flywheel — sheared key?", "diag_mins": 10, "swo_if_found": "k-flykey", "detail": "Sheared key = severe vibration + timing knock."}]}, {"id": "s-smoke", "label": "Blue / Black / White Smoke", "icon": "💨", "steps": [{"label": "Check oil level — overfilled or low?", "diag_mins": 2, "swo_if_found": "k-oil", "detail": "Blue smoke + overfill = drain excess. Blue smoke + low oil = rings."}, {"label": "Check air filter — clogged (black smoke)?", "diag_mins": 5, "swo_if_found": "k-air", "detail": "Black smoke = rich running from blocked filter."}, {"label": "Check spark plug — wet or black?", "diag_mins": 5, "swo_if_found": "k-plug", "detail": "Oil-fouled plug = rings or valve seals burning oil."}, {"label": "Check compression — low?", "diag_mins": 10, "swo_if_found": "k-topend", "detail": "Low compression + blue smoke = worn rings."}]}, {"id": "s-norev", "label": "Won't Rev / Limited RPM", "icon": "📉", "steps": [{"label": "Check throttle full travel", "diag_mins": 3, "swo_if_found": "k-throttle", "detail": "Does carb open fully at full pedal?"}, {"label": "Check governor", "diag_mins": 5, "swo_if_found": "k-governor", "detail": "Max RPM ~3,600 no-load."}, {"label": "Check air filter", "diag_mins": 5, "swo_if_found": "k-air", "detail": "Severely clogged = RPM cap."}, {"label": "Check carburetor main jet", "diag_mins": 10, "swo_if_found": "k-carb-rebuild", "detail": "Partially blocked main jet = RPM wall."}]}, {"id": "s-steer", "label": "Steering Problem / Pulling", "icon": "🔄", "steps": [{"label": "Check tire pressure — fronts equal?", "diag_mins": 2, "swo_if_found": "k-tire-pressure", "detail": "Unequal pressure causes pulling."}, {"label": "Check front alignment", "diag_mins": 10, "swo_if_found": "k-alignment", "detail": "Tires pointing same direction when viewed from behind?"}, {"label": "Check spindle play", "diag_mins": 5, "swo_if_found": "k-spindle-lube", "detail": "Rock tire top/bottom — excessive play = spindle or bearing."}, {"label": "Inspect spindle for bend or crack", "diag_mins": 5, "swo_if_found": "k-spindle-replace", "detail": "ANY crack or bend = OOS immediately."}]}, {"id": "s-remote", "label": "Remote Shut-Off Not Working", "icon": "📡", "steps": [{"label": "Check transponder placement & wiring", "diag_mins": 5, "swo_if_found": "k-transponder", "detail": "Transponder loose or wire damaged?"}, {"label": "Check kill switch / ground", "diag_mins": 5, "swo_if_found": "k-killswitch", "detail": "Ground fault can masquerade as transponder fault."}, {"label": "Test Kartrol system with another kart", "diag_mins": 10, "swo_if_found": null, "detail": "If other karts respond normally — isolated to this kart."}]}, {"id": "ts-nostart", "label": "Tornado — Won't Start / Run", "icon": "🌪️", "asset": "Tornado", "steps": [{"label": "Check air pressure — compressor at 100-120psi?", "diag_mins": 3, "swo_if_found": "t-air-check", "detail": "Ride requires air to operate."}, {"label": "Check power / breaker", "diag_mins": 3, "swo_if_found": null, "detail": "Check main power switch and circuit breaker."}, {"label": "Check foot switch", "diag_mins": 5, "swo_if_found": null, "detail": "Test foot switch continuity."}]}, {"id": "ts-lapbar", "label": "Tornado — Lap Bar Issue", "icon": "🌪️", "asset": "Tornado", "steps": [{"label": "Test air lock system — all seats open?", "diag_mins": 5, "swo_if_found": "t-lapbar-adj", "detail": "Activate air lock — all should open simultaneously."}, {"label": "Check lap bar hinge bolts", "diag_mins": 10, "swo_if_found": "t-lapbar-adj", "detail": "Loose hinge bolts cause binding."}, {"label": "Full lap bar replace", "diag_mins": 15, "swo_if_found": "t-lapbar-replace", "detail": "If mechanical failure confirmed."}]}, {"id": "ts-brake", "label": "Tornado — Brake / Stop Issue", "icon": "🌪️", "asset": "Tornado", "steps": [{"label": "Check brake solenoid", "diag_mins": 10, "swo_if_found": "t-brake-sol", "detail": "Solenoid activates pneumatic brake. Parker B511KDH53C."}, {"label": "Check air pressure at brake circuit", "diag_mins": 5, "swo_if_found": "t-air-check", "detail": "Low air = insufficient brake force."}]}, {"id": "dc-nostart", "label": "Dragon Coaster — Won't Start", "icon": "🐉", "asset": "Dragon Coaster", "steps": [{"label": "Check breaker and main power", "diag_mins": 3, "swo_if_found": null, "detail": "Check circuit breaker, main power switch."}, {"label": "Check drive tires — correct pressure (35psi)?", "diag_mins": 5, "swo_if_found": "dc-tire-check", "detail": "Low tire pressure = car won't move through circuit."}, {"label": "Check motor V-belts — slipping?", "diag_mins": 10, "swo_if_found": "dc-belt", "detail": "Glazed belts = no drive."}]}, {"id": "dc-slowstop", "label": "Dragon Coaster — Slow/Stops Mid-Run", "icon": "🐉", "asset": "Dragon Coaster", "steps": [{"label": "Check drive tire pressure", "diag_mins": 5, "swo_if_found": "dc-tire-check", "detail": "35psi spec."}, {"label": "Check gearbox for leaks", "diag_mins": 10, "swo_if_found": "dc-gearbox", "detail": "Low gear oil = dragging."}, {"label": "Check all car wheel axle bolts", "diag_mins": 10, "swo_if_found": "dc-wheel-axle", "detail": "Dragging car = loose wheel."}]}, {"id": "dc-lapbar", "label": "Dragon Coaster — Lap Bar Issue", "icon": "🐉", "asset": "Dragon Coaster", "steps": [{"label": "Check lap bar air cylinder pins", "diag_mins": 5, "swo_if_found": "dc-lapbar", "detail": "Missing cotter pins = lap bar won't lock."}, {"label": "Check air supply to lap bars", "diag_mins": 5, "swo_if_found": "dc-air", "detail": "Low air = bars won't release."}]}, {"id": "fs-slow", "label": "Fun Slide — Rider Sticking / Too Slow", "icon": "🛝", "asset": "Fun Slide", "steps": [{"label": "Apply Pledge to humps (moving downward, 6\" past each hump)", "diag_mins": 10, "swo_if_found": "fs-speed-adj", "detail": "ONLY spray humps. Over-spraying is a safety hazard."}, {"label": "Check mat condition", "diag_mins": 5, "swo_if_found": "fs-mat-insp", "detail": "Worn mat surface = increased friction."}]}, {"id": "fs-struct", "label": "Fun Slide — Structural / Damage", "icon": "🛝", "asset": "Fun Slide", "steps": [{"label": "Inspect slide surface for cracks", "diag_mins": 10, "swo_if_found": "fs-surface", "detail": "Any crack = OOS until repaired."}, {"label": "Inspect step welds", "diag_mins": 10, "swo_if_found": "fs-step-weld", "detail": "Cracked weld = immediate OOS."}, {"label": "Inspect handrails", "diag_mins": 5, "swo_if_found": "fs-handrail", "detail": "Loose or damaged handrail."}]}];

var DIAG_SYMPTOMS = [{"id": "no-start", "label": "Won't Start / No Start", "icon": "🚫", "group": "Starting"}, {"id": "hard-start", "label": "Hard Starting / Slow to Start", "icon": "😤", "group": "Starting"}, {"id": "starts-dies", "label": "Starts Then Dies", "icon": "💀", "group": "Starting"}, {"id": "no-rev", "label": "Won't Rev / Can't Reach Full RPM", "icon": "📉", "group": "Performance"}, {"id": "loss-power", "label": "Loss of Power / Slow Kart", "icon": "🐢", "group": "Performance"}, {"id": "rough-idle", "label": "Rough Idle / Unstable Idle", "icon": "〰️", "group": "Performance"}, {"id": "rolls-idle", "label": "Rolls / Creeps Forward at Idle", "icon": "🔀", "group": "Performance"}, {"id": "stalls-track", "label": "Stalls on Track / Cuts Out Under Load", "icon": "⚡", "group": "Performance"}, {"id": "overheating", "label": "Overheating", "icon": "🌡️", "group": "Smoke & Heat"}, {"id": "blue-smoke", "label": "Blue Smoke (oil burning)", "icon": "🔵", "group": "Smoke & Heat"}, {"id": "black-smoke", "label": "Black Smoke / Rich Running", "icon": "⬛", "group": "Smoke & Heat"}, {"id": "white-smoke", "label": "White Smoke", "icon": "⬜", "group": "Smoke & Heat"}, {"id": "backfire", "label": "Backfiring / Popping", "icon": "💥", "group": "Smoke & Heat"}, {"id": "knocking", "label": "Knocking / Pinging", "icon": "🔨", "group": "Sounds"}, {"id": "rattling", "label": "Rattling / Clattering", "icon": "🎲", "group": "Sounds"}, {"id": "grinding", "label": "Grinding / Squealing", "icon": "⚙️", "group": "Sounds"}, {"id": "vibration", "label": "Excessive Vibration", "icon": "📳", "group": "Sounds"}, {"id": "oil-leak", "label": "Oil Leak", "icon": "🛢️", "group": "Fluids"}, {"id": "runs-rough-svc", "label": "Runs Rough After Service", "icon": "🔧", "group": "Post-Service"}, {"id": "seized", "label": "Engine Seized / Won't Turn Over", "icon": "🔒", "group": "Critical"}, {"id": "no-shutoff", "label": "Kill Switch / Shutoff Not Working", "icon": "🔌", "group": "Electrical"}, {"id": "going-too-fast", "label": "Going Too Fast / Over-Speed", "icon": "🏎", "group": "Performance"},{"id":"going-too-slow","label":"Going Too Slow / Down on Speed","icon":"🐌","group":"Performance"},{"id":"t-nostart","label":"Won't Start / Won't Run","icon":"🚫","group":"Operation","asset":"tornado"},{"id":"t-lowair","label":"Low Air / Compressor Not Cycling","icon":"💨","group":"Operation","asset":"tornado"},{"id":"t-airleak","label":"Air Leak / Hissing","icon":"🌬️","group":"Operation","asset":"tornado"},{"id":"t-lapbar-lock","label":"Lap Bar Won't Lock","icon":"🔓","group":"Safety","asset":"tornado"},{"id":"t-lapbar-release","label":"Lap Bar Won't Release","icon":"🔒","group":"Safety","asset":"tornado"},{"id":"t-brake","label":"Won't Stop / Brake Issue","icon":"🛑","group":"Safety","asset":"tornado"},{"id":"t-noise","label":"Grinding / Clunking Noise","icon":"🔊","group":"Mechanical","asset":"tornado"},{"id":"t-vibration","label":"Excessive Shaking / Vibration","icon":"📳","group":"Mechanical","asset":"tornado"},{"id":"t-loose","label":"Seat or Car Loose / Wobbling","icon":"🪑","group":"Mechanical","asset":"tornado"},{"id":"t-crack","label":"Crack, Loose Bolt, or Broken Part","icon":"⚠️","group":"Structural","asset":"tornado"},{"id":"t-leak","label":"Fluid Leak","icon":"🛢️","group":"Mechanical","asset":"tornado"},{"id":"t-speed","label":"Running Too Fast / Slow / Jerky","icon":"🌀","group":"Operation","asset":"tornado"},{"id":"t-nopower","label":"No Power / Won't Turn On","icon":"🔌","group":"Electrical","asset":"tornado"},{"id":"d-nostart","label":"Won't Start / Won't Run","icon":"🚫","group":"Operation","asset":"dragon"},{"id":"d-stops","label":"Car Stops Mid-Track / Won't Finish Loop","icon":"🛤️","group":"Operation","asset":"dragon"},{"id":"d-slow","label":"Car Slow or Dragging","icon":"🐢","group":"Operation","asset":"dragon"},{"id":"d-tireslip","label":"Drive Tires Slipping","icon":"🛞","group":"Operation","asset":"dragon"},{"id":"d-lapbar-lock","label":"Lap Bar Won't Lock","icon":"🔓","group":"Safety","asset":"dragon"},{"id":"d-lapbar-release","label":"Lap Bar Won't Release","icon":"🔒","group":"Safety","asset":"dragon"},{"id":"d-brake","label":"Won't Stop / Brake Issue","icon":"🛑","group":"Safety","asset":"dragon"},{"id":"d-noise","label":"Grinding / Squeal / Belt-Slip Noise","icon":"🔊","group":"Mechanical","asset":"dragon"},{"id":"d-air","label":"Low Air / Air Leak","icon":"💨","group":"Operation","asset":"dragon"},{"id":"d-gearbox","label":"Gearbox Leak / Oil on Ground","icon":"🛢️","group":"Mechanical","asset":"dragon"},{"id":"d-loose","label":"Car, Seat, or Coupler Loose / Wobbling","icon":"🪑","group":"Mechanical","asset":"dragon"},{"id":"d-crack","label":"Crack, Loose Bolt, or Broken Part","icon":"⚠️","group":"Structural","asset":"dragon"},{"id":"d-nopower","label":"No Power / Won't Turn On","icon":"🔌","group":"Electrical","asset":"dragon"},{"id":"fs-slow","label":"Riders Too Slow / Sticking / Pushing","icon":"🐢","group":"Operation","asset":"slide"},{"id":"fs-fast","label":"Riders Too Fast","icon":"⚡","group":"Operation","asset":"slide"},{"id":"fs-surface","label":"Crack or Damage in Slide Surface","icon":"⚠️","group":"Structural","asset":"slide"},{"id":"fs-mat","label":"Mat Damaged or Has Holes","icon":"🟫","group":"Equipment","asset":"slide"},{"id":"fs-step","label":"Step or Weld Cracked / Damaged","icon":"🪜","group":"Structural","asset":"slide"},{"id":"fs-handrail","label":"Handrail Loose / Damaged","icon":"🤚","group":"Safety","asset":"slide"},{"id":"fs-power","label":"Breaker Off / No Power","icon":"🔌","group":"Electrical","asset":"slide"}];
var DIAG_CAUSES = [{"id": "fuel-empty", "label": "Empty fuel tank or fuel valve closed", "symptoms": ["no-start", "hard-start", "starts-dies", "stalls-track"], "likelihood_base": 10, "check_cost": 0, "questions": [{"q": "Is there fuel in the tank?", "yes": "eliminate", "no": "confirm", "how": "Open the fuel cap and look inside — you should see fuel."}], "parts": [], "labor_hrs": 0.05, "fix": "Fill tank with fresh 87+ octane fuel. Open fuel valve to ON position.", "reuse_all": true}, {"id": "water-in-fuel", "label": "Water or contaminated fuel", "symptoms": ["no-start", "hard-start", "starts-dies", "rough-idle"], "likelihood_base": 5, "check_cost": 0, "questions": [{"q": "Does the fuel look cloudy or have white beads at the bottom of the tank?", "yes": "confirm", "no": "reduce", "how": "Remove fuel cap and look at fuel color. Clear/amber = good. Cloudy or beads = water."}, {"q": "Has the kart been sitting unused for more than 2 weeks?", "yes": "increase", "no": "reduce", "how": "Stale fuel degrades quickly in hot weather."}], "parts": [], "labor_hrs": 0.5, "fix": "Drain tank completely. Flush with fresh fuel. Replace fuel filter. Fill with fresh fuel.", "reuse_all": true}, {"id": "fuel-filter-clogged", "label": "Clogged fuel filter", "symptoms": ["no-start", "hard-start", "starts-dies", "loss-power", "stalls-track", "no-rev"], "likelihood_base": 7, "check_cost": 5, "questions": [{"q": "Can you see through the fuel filter? Is it dark or opaque?", "yes": "confirm", "no": "reduce", "how": "Fuel filter is usually inline on the fuel line. Should be translucent with visible fuel. Dark/black = replace."}, {"q": "When did the filter last get replaced?", "options": ["Less than 3 months", "3-6 months", "Over 6 months / unknown"], "weights": [-2, 0, 3], "how": "Replace every 6 months or if discolored."}], "parts": [{"name": "Fuel Filter (inline)", "sku": "FUEL-FILTER", "qty": 1, "cost": 4.5, "reuse": false, "reuse_note": "Always replace — never reuse"}], "labor_hrs": 0.25, "fix": "Replace inline fuel filter. Ensure arrow points toward carburetor (fuel flow direction).", "reuse_all": false}, {"id": "spark-plug-fouled", "label": "Fouled or worn spark plug", "symptoms": ["no-start", "hard-start", "starts-dies", "loss-power", "rough-idle", "backfire", "runs-rough-svc"], "likelihood_base": 8, "check_cost": 3, "questions": [{"q": "Is the spark plug black/sooty, wet with fuel, or white/chalky?", "options": ["Black/sooty (rich/fouled)", "Wet with fuel", "White/chalky (lean/overheating)", "Normal tan/grey"], "weights": [4, 4, 3, -3], "how": "Remove plug with spark plug wrench. Inspect tip — tan/grey = good. Black = fouled. White = lean."}, {"q": "When was the spark plug last replaced?", "options": ["Less than 50hr", "50-100hr", "Over 100hr / unknown"], "weights": [-2, 1, 4], "how": "Replace every 100hr. Gap spec: 0.7-0.8mm for GX160/200/270."}], "parts": [{"name": "Spark Plug NGK BP6ES", "sku": "NGK-BP6ES", "qty": 1, "cost": 3.25, "reuse": false, "reuse_note": "Always replace — $3 insurance"}], "labor_hrs": 0.17, "fix": "Replace spark plug. Set gap to 0.7-0.8mm. Torque to 18 N·m (13 ft-lb). Reconnect wire firmly.", "reuse_all": false}, {"id": "kill-switch-fault", "label": "Kill switch / ignition wiring fault", "symptoms": ["no-start", "starts-dies", "stalls-track", "no-shutoff"], "likelihood_base": 6, "check_cost": 0, "questions": [{"q": "Does the kill switch on the kart feel loose or damaged?", "yes": "increase", "no": "neutral", "how": "Check the on/off switch. It should click firmly and stay in position."}, {"q": "Does disconnecting the kill switch wire from the coil allow the engine to start?", "yes": "confirm", "no": "reduce", "how": "Locate the small wire from the kill switch to the ignition coil. Disconnect it temporarily. Try to start. If it fires, kill switch circuit is the problem."}], "parts": [{"name": "Kill Switch / On-Off Switch", "sku": "KILL-SW", "qty": 1, "cost": 8.5, "reuse": false, "reuse_note": "Replace if confirmed faulty"}], "labor_hrs": 0.33, "fix": "Test kill switch continuity with multimeter. If shorted in OFF position, replace switch. Check all wiring for bare spots or pinched wires.", "reuse_all": false}, {"id": "ignition-coil", "label": "Ignition coil faulty or air gap incorrect", "symptoms": ["no-start", "hard-start", "starts-dies", "stalls-track", "no-rev"], "likelihood_base": 5, "check_cost": 10, "questions": [{"q": "Is there a spark when you test the plug? Ground the plug body against the engine block and pull the rope.", "options": ["Strong blue spark", "Weak orange spark", "No spark at all"], "weights": [-4, 3, 5], "how": "Remove plug, reconnect wire, hold plug body against engine metal, pull rope. Look for spark at the gap."}, {"q": "Does the problem get worse after the engine warms up?", "yes": "increase", "no": "neutral", "how": "Coils that break down under heat will cause cuts at operating temperature but start fine cold."}], "parts": [{"name": "Ignition Coil GX160/200", "sku": "COIL-GX200", "qty": 1, "cost": 22.0, "reuse": false, "reuse_note": "Replace if confirmed faulty — do not reuse a failing coil"}], "labor_hrs": 0.5, "fix": "Remove old coil. Install new coil — leave bolts slightly loose. Set air gap to 0.4mm using feeler gauge between coil and flywheel. Tighten. Reconnect wire.", "reuse_all": false}, {"id": "flywheel-key", "label": "Sheared flywheel key (timing loss)", "symptoms": ["no-start", "hard-start", "knocking", "vibration", "backfire"], "likelihood_base": 4, "check_cost": 20, "questions": [{"q": "Did the kart hit something hard recently (wall, another kart) before this issue started?", "yes": "confirm", "no": "reduce", "how": "Flywheel key shears from impact loads. Common after collisions."}, {"q": "Is there a loud knock AND vibration at the same time?", "yes": "increase", "no": "reduce", "how": "Sheared key causes both timing knock AND physical vibration because flywheel is no longer in phase."}], "parts": [{"name": "Flywheel Woodruff Key", "sku": "FLY-KEY", "qty": 1, "cost": 2.5, "reuse": false, "reuse_note": "Always replace — $2.50 part, critical component"}], "labor_hrs": 1.0, "fix": "Remove flywheel using flywheel puller. Inspect keyway. Replace woodruff key. Reinstall flywheel and torque nut to spec (GX200: 65 N·m). Reset ignition coil air gap.", "reuse_all": false}, {"id": "carb-out-of-adj", "label": "Carburetor out of adjustment", "symptoms": ["hard-start", "starts-dies", "loss-power", "rough-idle", "no-rev", "backfire", "rolls-idle", "black-smoke"], "likelihood_base": 8, "check_cost": 0, "questions": [{"q": "Did the problem start suddenly or gradually?", "options": ["Suddenly (after service or incident)", "Gradually over time"], "weights": [2, 4], "how": "Sudden = likely screw was moved. Gradual = gumming/wear."}, {"q": "Does the engine run better briefly after spraying carb cleaner into the intake?", "yes": "increase", "no": "neutral", "how": "This tests if carb is delivering fuel. If spray helps, carb is the problem area."}], "parts": [], "labor_hrs": 0.33, "fix": "GX200: Set pilot screw to 2 turns out from lightly seated. Set idle to 1,400 RPM. GX270: 2.5 turns out. If adjustment alone doesn't fix — rebuild carb.", "reuse_all": true}, {"id": "carb-gummed", "label": "Carburetor gummed / jets clogged", "symptoms": ["no-start", "hard-start", "starts-dies", "loss-power", "rough-idle", "no-rev", "stalls-track"], "likelihood_base": 7, "check_cost": 15, "questions": [{"q": "Has the kart sat unused for more than 2 weeks with fuel in the carb?", "yes": "confirm", "no": "reduce", "how": "Ethanol fuel varnishes carb passages within days in hot weather."}, {"q": "Does the engine run but stumble badly under load or at high RPM?", "yes": "increase", "no": "neutral", "how": "Partial blockage of main jet causes power loss and stumble under load."}], "parts": [{"name": "Carburetor Rebuild Kit GX160/200", "sku": "CARB-KIT-GX200", "qty": 1, "cost": 18.5, "reuse": false, "reuse_note": "Always replace all kit seals, needles, jets"}], "labor_hrs": 1.0, "fix": "Remove carb. Disassemble fully. Soak in carb cleaner 30min. Blow all passages with compressed air. Install new kit. Check float height (GX200: 13.7mm). Reinstall and adjust.", "reuse_all": false}, {"id": "air-filter-clogged", "label": "Air filter clogged / restricted", "symptoms": ["hard-start", "loss-power", "rough-idle", "black-smoke", "no-rev"], "likelihood_base": 8, "check_cost": 2, "questions": [{"q": "Is the air filter visibly dirty, oily, or collapsed?", "yes": "confirm", "no": "reduce", "how": "Remove air filter cover and inspect. Foam element should be lightly oiled but not saturated. Paper element should be clean."}, {"q": "When was the air filter last cleaned or replaced?", "options": ["Less than 20hr", "20-50hr", "Over 50hr / unknown"], "weights": [-2, 1, 4], "how": "Spec: clean every 20hr, replace as needed. In dusty conditions — more often."}], "parts": [{"name": "Air Filter Element GX160/200", "sku": "AIR-GX200", "qty": 1, "cost": 8.5, "reuse": true, "reuse_note": "Wash in soapy water, dry, re-oil lightly. Replace if torn or beyond cleaning."}], "labor_hrs": 0.25, "fix": "Remove element. Wash in warm soapy water. Rinse and dry completely. Dip in clean engine oil, squeeze out excess. Reinstall.", "reuse_all": true}, {"id": "low-oil", "label": "Low oil level / oil cutoff sensor triggered", "symptoms": ["no-start", "starts-dies", "stalls-track", "overheating", "blue-smoke"], "likelihood_base": 8, "check_cost": 0, "questions": [{"q": "Is the oil level at or below the minimum mark on the dipstick?", "yes": "confirm", "no": "reduce", "how": "Remove dipstick, wipe, reinsert fully, remove and read. Must be between MIN and MAX marks."}, {"q": "Is there visible oil on the ground or kart frame under the engine?", "yes": "increase", "no": "neutral", "how": "Leak accelerates oil loss. Find and fix the leak before adding oil."}], "parts": [{"name": "Engine Oil 10W-30 (qt)", "sku": "OIL-10W30", "qty": 1, "cost": 6.5, "reuse": false, "reuse_note": "Add oil to spec — do not reuse old oil if doing change"}, {"name": "Oil Drain Plug Washer", "sku": "DRAIN-WASH", "qty": 1, "cost": 0.75, "reuse": false, "reuse_note": "Replace washer any time drain plug is removed"}], "labor_hrs": 0.17, "fix": "Add oil to upper mark. GX160/200: 0.6L / 0.63qt. GX270: 1.0L / 1.06qt. Use 10W-30. Do NOT overfill. Investigate source of oil loss before returning to service.", "reuse_all": false}, {"id": "governor-fault", "label": "Governor out of adjustment or binding", "symptoms": ["loss-power", "no-rev", "rough-idle", "rolls-idle"], "likelihood_base": 5, "check_cost": 0, "questions": [{"q": "With engine OFF, does the throttle plate open fully when you push the pedal to the floor?", "yes": "reduce", "no": "increase", "how": "Look at the carburetor butterfly or slide while someone presses the pedal. Should open fully."}, {"q": "Was the governor arm or linkage recently touched or adjusted?", "yes": "increase", "no": "neutral", "how": "Disturbing governor arm is the #1 cause of governor issues — small changes have big RPM effects."}], "parts": [], "labor_hrs": 0.33, "fix": "GX200: Loosen governor arm clamp. Engine OFF — rotate shaft fully counterclockwise. Hold throttle plate fully open. Hold governor arm toward full throttle. Tighten clamp. Verify 3,600 RPM no-load.", "reuse_all": true}, {"id": "throttle-linkage", "label": "Throttle cable / linkage not opening fully", "symptoms": ["loss-power", "no-rev", "rolls-idle"], "likelihood_base": 7, "check_cost": 0, "questions": [{"q": "Does the kart feel like it hits a power wall at mid-throttle but pedal still moves?", "yes": "confirm", "no": "reduce", "how": "Press pedal slowly. Watch the carb — does throttle plate stop moving before pedal bottoms out?"}, {"q": "Was the belt or engine recently serviced?", "yes": "increase", "no": "neutral", "how": "Throttle linkage must be re-adjusted after every belt replacement."}], "parts": [], "labor_hrs": 0.33, "fix": "Raise linkage rod so throttle lever is mid-paddle. Ensure min 1/8\" clearance between paddle and tank. Set 1/2\" pedal-to-stop gap. Verify smooth acceleration full travel.", "reuse_all": true}, {"id": "clutch-fault", "label": "Centrifugal clutch not fully disengaging", "symptoms": ["rolls-idle", "stalls-track", "grinding", "loss-power"], "likelihood_base": 6, "check_cost": 10, "questions": [{"q": "Does the creeping get worse as the engine warms up?", "yes": "confirm", "no": "reduce", "how": "Worn clutch springs lose tension faster when hot, causing engagement at lower RPM."}, {"q": "Can you hear a light grinding or dragging from the clutch area at idle?", "yes": "increase", "no": "neutral", "how": "Listen near the clutch/belt area with engine idling. Dragging = clutch partially engaged."}], "parts": [{"name": "Clutch Spring Set", "sku": "CLUTCH-SPR", "qty": 1, "cost": 12.0, "reuse": false, "reuse_note": "Replace springs if weak. Inspect shoes — reuse if thickness is acceptable."}], "labor_hrs": 0.75, "fix": "Remove clutch. Inspect shoes for wear and springs for tension. Replace springs if weak. Clean bell housing. Ensure engagement RPM is above ~1,800 RPM. Also check idle speed — should be 1,400 RPM.", "reuse_all": false}, {"id": "idle-too-high", "label": "Idle speed set too high", "symptoms": ["rolls-idle", "rough-idle"], "likelihood_base": 9, "check_cost": 0, "questions": [{"q": "Does the kart creep even with brakes fully released (not just dragging)?", "yes": "increase", "no": "reduce", "how": "True idle creep — kart moves on flat surface with no brake input."}, {"q": "Was the idle screw recently adjusted or the carb serviced?", "yes": "increase", "no": "neutral", "how": "Idle screw is often bumped during carb work."}], "parts": [], "labor_hrs": 0.17, "fix": "Locate idle speed screw on carburetor. With engine at operating temp, adjust to 1,400 RPM (±150 RPM). Clockwise = higher, counterclockwise = lower. Verify kart does not creep with brakes released.", "reuse_all": true}, {"id": "valve-clearance", "label": "Valve clearance incorrect", "symptoms": ["hard-start", "loss-power", "rough-idle", "no-rev", "rattling", "runs-rough-svc"], "likelihood_base": 5, "check_cost": 15, "questions": [{"q": "Is there a regular ticking sound at idle that speeds up with RPM?", "yes": "increase", "no": "neutral", "how": "Valve ticking is rhythmic and changes speed with engine RPM. Distinct from rod knock (lower pitch)."}, {"q": "When was valve clearance last checked?", "options": ["Less than 100hr", "100-300hr", "Over 300hr / unknown"], "weights": [-2, 1, 4], "how": "Spec: check every 100hr. GX160/200: IN 0.15mm / EX 0.20mm. GX270: IN 0.15mm / EX 0.25mm."}], "parts": [], "labor_hrs": 0.75, "fix": "Remove valve cover. Rotate engine to TDC on compression stroke. Check clearance with feeler gauge. Adjust by loosening lock nut and turning adjuster screw. Retorque cover.", "reuse_all": true}, {"id": "valve-damage", "label": "Valve or valve seat worn / damaged", "symptoms": ["hard-start", "loss-power", "no-rev", "backfire", "stalls-track"], "likelihood_base": 3, "check_cost": 30, "questions": [{"q": "Is compression low? (Spec: GX160/200 = 135 PSI, GX270 = 150 PSI. Below 70 = major issue)", "yes": "confirm", "no": "reduce", "how": "Use compression gauge. Engine at operating temp, throttle wide open, pull rope 4-5 times."}, {"q": "Does the engine have over 400 hours?", "yes": "increase", "no": "neutral", "how": "Valve wear accelerates significantly past 400hr without regular lapping."}], "parts": [{"name": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5, "reuse": false, "reuse_note": "Always replace"}, {"name": "Head Gasket", "sku": "GASKET-HEAD", "qty": 1, "cost": 12.0, "reuse": false, "reuse_note": "Always replace"}], "labor_hrs": 3.0, "fix": "Remove head. Inspect valves and seats. Lap valves if seated improperly. Replace head gasket. If valves deeply pitted — escalate to engine rebuild or replacement.", "reuse_all": false}, {"id": "rings-worn", "label": "Worn piston rings / cylinder", "symptoms": ["white-smoke", "blue-smoke", "loss-power", "hard-start", "overheating", "stalls-track"], "likelihood_base": 3, "check_cost": 30, "questions": [{"q": "Is there significant blue smoke at startup that clears after warming up?", "yes": "increase", "no": "neutral", "how": "Oil burning from rings shows as blue smoke especially on cold start or blipping throttle."}, {"q": "Is oil consumption noticeably high (adding oil more than once per 10hr)?", "yes": "confirm", "no": "reduce", "how": "Track oil level over a session. Excessive consumption = rings or valve seals."}, {"q": "What is compression? (Spec: GX160/200 = 135 PSI, GX270 = 150 PSI)", "options": ["Normal (above 100 PSI)", "Low (70-100 PSI)", "Very low (below 70 PSI)"], "weights": [-3, 3, 5], "how": "Low compression confirms internal wear. Do wet compression test — add teaspoon of oil to cylinder, retest. If compression rises = rings. If same = valves."}], "parts": [{"name": "Piston Ring Set GX160/200", "sku": "RINGS-GX200", "qty": 1, "cost": 25.0, "reuse": false, "reuse_note": "Always replace rings"}, {"name": "Head Gasket", "sku": "GASKET-HEAD", "qty": 1, "cost": 12.0, "reuse": false, "reuse_note": "Always replace"}, {"name": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5, "reuse": false, "reuse_note": "Always replace"}], "labor_hrs": 4.0, "fix": "Disassemble engine. Measure bore — if within 0.05mm oversize, replace rings only. If scored or beyond spec — replace piston and rings. Check valves while apart.", "reuse_all": false}, {"id": "belt-worn", "label": "Drive belt worn / slipping", "symptoms": ["loss-power", "grinding", "no-rev", "stalls-track"], "likelihood_base": 6, "check_cost": 5, "questions": [{"q": "Is there a burning rubber smell, especially under load?", "yes": "increase", "no": "neutral", "how": "Slipping belt generates heat and rubber smell. Most noticeable on hills or sharp acceleration."}, {"q": "Are the belts glazed (shiny surface), cracked, or frayed?", "yes": "confirm", "no": "reduce", "how": "Remove belt guard. Inspect belt surface. Glossy/shiny = glazed and slipping. Cracked/frayed = immediate replacement."}], "parts": [{"name": "Drive Belt Set", "sku": "BELT-KRT", "qty": 1, "cost": 24.0, "reuse": false, "reuse_note": "Replace as a set. Never replace just one belt."}], "labor_hrs": 0.67, "fix": "Replace belt set. Loosen axle eccentric. Remove old belts. Route new belts. Set proper tension — no more than 1/2\" deflection. Readjust throttle linkage after belt change.", "reuse_all": false}, {"id": "oil-leak-valve-cover", "label": "Oil leak — valve cover gasket", "symptoms": ["oil-leak", "blue-smoke", "overheating"], "likelihood_base": 6, "check_cost": 5, "questions": [{"q": "Is oil visible around the top of the engine on the valve cover seam?", "yes": "confirm", "no": "reduce", "how": "Look at the flat cover on top of the engine. Oil weeping from the seam = valve cover gasket."}], "parts": [{"name": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5, "reuse": false, "reuse_note": "Always replace — do not reuse gaskets"}], "labor_hrs": 0.33, "fix": "Remove valve cover bolts. Lift cover. Remove old gasket completely. Install new gasket — no sealant needed. Torque cover bolts evenly.", "reuse_all": false}, {"id": "oil-leak-drain", "label": "Oil leak — drain plug or crankcase", "symptoms": ["oil-leak", "overheating"], "likelihood_base": 5, "check_cost": 2, "questions": [{"q": "Is oil pooling directly below the bottom of the engine?", "yes": "increase", "no": "neutral", "how": "Check drain plug and lower crankcase seam."}], "parts": [{"name": "Oil Drain Plug Washer", "sku": "DRAIN-WASH", "qty": 1, "cost": 0.75, "reuse": false, "reuse_note": "Replace every time drain plug is removed"}], "labor_hrs": 0.25, "fix": "Tighten drain plug to 18 N·m (13 ft-lb). If still leaking, replace crush washer. If crankcase seam leaking — escalate to engine replacement.", "reuse_all": false}, {"id": "seized", "label": "Engine seized — catastrophic failure", "symptoms": ["seized", "knocking", "vibration"], "likelihood_base": 2, "check_cost": 0, "questions": [{"q": "Does the engine turn at all when pulling the rope?", "yes": "reduce", "no": "confirm", "how": "Try pulling starter rope. Total resistance = seized. Some movement = possibly hydrolocked."}, {"q": "Was the engine running with very low or no oil?", "yes": "confirm", "no": "neutral", "how": "Low oil is the primary cause of seizure on GX engines."}], "parts": [], "labor_hrs": 0.5, "fix": "Engine is non-serviceable in field. Tag for replacement. Document cause (low oil, overheating, impact). Do not attempt to free a seized engine — damage to crankshaft or cylinder is likely.", "reuse_all": false}, {"id": "speed-too-high", "label": "Governed top speed set too high", "symptoms": ["going-too-fast"], "likelihood_base": 9, "check_cost": 0, "questions": [{"q": "Is it just this one kart, or the whole track / several karts?", "options": ["Just this kart", "Whole track / several karts"], "weights": [0, 0], "how": "Whole track usually means the remote/Kartrol speed tier, not the engine. One kart points to the governor/throttle."}, {"q": "Does the throttle pedal return fully to idle on its own (no sticking)?", "yes": "neutral", "no": "increase", "how": "A sticking throttle holds it open — a safety issue on its own."}, {"q": "Was the governor arm, spring, or throttle stop touched recently?", "yes": "increase", "no": "neutral", "how": "Disturbing the governor is the #1 cause of a speed change."}], "parts": [], "labor_hrs": 0.33, "fix": "Use Speed Check to get the target governed RPM for this kart's gearing, then re-set the governor / throttle stop to that RPM with a tach. Confirm the throttle returns fully to idle. If the whole track is fast, check the remote/Kartrol speed tier instead of the engine.", "reuse_all": true}, {"id": "oil-overfilled", "label": "Oil overfilled (forced through breather)", "symptoms": ["white-smoke", "blue-smoke"], "likelihood_base": 10, "check_cost": 0, "questions": [{"q": "Is the oil level above the MAX/upper mark on the dipstick?", "yes": "confirm", "no": "reduce", "how": "Remove dipstick, wipe, reinsert fully, read. Above the upper mark = overfilled."}, {"q": "Is there oil in the air cleaner box, filter, or breather tube?", "yes": "increase", "no": "neutral", "how": "Remove the air filter cover. Oil-soaked foam or oil pooled in the box points to overfill/breather carryover."}, {"q": "Does the engine otherwise run normally?", "yes": "increase", "no": "reduce", "how": "Overfill smoke usually comes with otherwise-normal running."}], "parts": [{"name": "Air Filter Element GX160/200", "sku": "AIR-GX200", "qty": 1, "cost": 8.5, "reuse": true, "reuse_note": "Only replace if oil-soaked and cleaning won't recover it"}], "labor_hrs": 0.25, "fix": "Drain oil down to the correct level (GX160/200: ~0.58 L / 0.61 qt; GX270: ~1.1 L / 1.16 qt). Clean the air box and breather tube. Wash or replace the air filter if oil-soaked. Run 5-10 minutes to burn off residual oil. Never fill above the upper mark.", "reuse_all": true}, {"id": "breather-oil", "label": "Oil pulled through crankcase breather", "symptoms": ["white-smoke", "blue-smoke"], "likelihood_base": 7, "check_cost": 5, "questions": [{"q": "Is the breather tube (valve cover to air box) oily, kinked, cracked, or disconnected?", "yes": "confirm", "no": "reduce", "how": "Trace the small hose from the valve cover to the air box. Look for oil filling it, kinks, cracks, or a popped-off end."}, {"q": "Does the white smoke get worse as RPM rises?", "yes": "increase", "no": "neutral", "how": "Breather carryover increases with crankcase pressure, so smoke climbs with RPM."}, {"q": "Did this start after hard impacts, hard cornering, or tipping?", "yes": "increase", "no": "neutral", "how": "Impacts and tipping slosh oil into the breather and intake."}], "parts": [{"name": "Crankcase Breather Kit GX", "sku": "BREATHER-GX", "qty": 1, "cost": 9.0, "reuse": true, "reuse_note": "Reuse if reed/diaphragm and tube are sound; replace if torn, oil-logged, or cracked"}, {"name": "Breather Tube/Hose", "sku": "BREATHER-HOSE", "qty": 1, "cost": 3.5, "reuse": true, "reuse_note": "Replace only if kinked, cracked, or hardened"}], "labor_hrs": 0.5, "fix": "Clean oil out of the intake and air box. Inspect the breather assembly behind the valve cover; clean or replace if the reed/diaphragm is fouled. Replace a kinked or cracked breather hose and reconnect securely. Confirm oil level is correct (overfill overwhelms the breather). Run to clear residual oil.", "reuse_all": true}, {"id": "engine-tipped", "label": "Engine tipped/rolled - oil in intake", "symptoms": ["white-smoke", "blue-smoke"], "likelihood_base": 6, "check_cost": 0, "questions": [{"q": "Did the kart tip onto its side or roll recently?", "yes": "confirm", "no": "reduce", "how": "Ask the operator / check incident notes. Tipping lets oil run into the carb, intake, and cylinder."}, {"q": "Did heavy smoke start right after the incident and is it slowly clearing?", "yes": "increase", "no": "neutral", "how": "Tip-over smoke is heaviest right after and burns off over minutes of running."}, {"q": "Is the oil level still correct (not low, not over)?", "yes": "increase", "no": "neutral", "how": "Confirm the tip didn't also leave it low or overfilled. Correct level + recent tip = burn-off, not wear."}], "parts": [{"name": "Air Filter Element GX160/200", "sku": "AIR-GX200", "qty": 1, "cost": 8.5, "reuse": true, "reuse_note": "Wash and re-oil; replace only if it stays saturated"}], "labor_hrs": 0.33, "fix": "Clean oil from the intake and air box. Wash or replace the air filter. Remove and check the spark plug - clean or replace if oil-fouled. Run the engine until the residual oil burns off and the smoke clears. Verify oil level after it settles.", "reuse_all": true}, {"id": "valve-seals", "label": "Worn valve guides / valve seals", "symptoms": ["white-smoke", "blue-smoke"], "likelihood_base": 3, "check_cost": 20, "questions": [{"q": "Is there a puff of smoke on startup or right after idling that then clears?", "yes": "confirm", "no": "reduce", "how": "Oil seeps past worn guides/seals while idling and burns off as a puff when you rev - classic seal wear."}, {"q": "Is compression still within spec? (GX160/200 ~135 PSI, GX270 ~150 PSI)", "yes": "increase", "no": "reduce", "how": "Seals/guides can leak oil with compression still good - that distinguishes them from worn rings."}, {"q": "Does the engine have over 300 hours?", "yes": "increase", "no": "neutral", "how": "Guide/seal wear builds up with hours."}], "parts": [{"name": "Valve Stem Seal Set", "sku": "VALVE-SEAL-GX", "qty": 1, "cost": 6.0, "reuse": false, "reuse_note": "Always replace seals once the head is open"}, {"name": "Head Gasket", "sku": "GASKET-HEAD", "qty": 1, "cost": 12.0, "reuse": false, "reuse_note": "Always replace"}, {"name": "Valve Cover Gasket", "sku": "GASKET-VC", "qty": 1, "cost": 7.5, "reuse": false, "reuse_note": "Always replace"}], "labor_hrs": 3.0, "fix": "Remove the cylinder head. Inspect valve guides for play and replace valve stem seals. Lap valves if seating is marginal. Reassemble with new head and valve cover gaskets. If guides are badly worn, send the head out or replace it.", "reuse_all": false}, {"id": "fuel-dilution", "label": "Fuel-diluted oil (carb flooding)", "symptoms": ["white-smoke", "black-smoke", "blue-smoke"], "likelihood_base": 4, "check_cost": 0, "questions": [{"q": "Does the oil smell strongly of gas, or is the level rising on the dipstick?", "yes": "confirm", "no": "reduce", "how": "Pull the dipstick and smell it. A gas smell or rising level means fuel is washing into the crankcase."}, {"q": "Is the carburetor flooding, or is fuel dripping from the carb / air box?", "yes": "increase", "no": "neutral", "how": "A stuck float or bad inlet needle floods the engine and dilutes the oil."}, {"q": "Was there black smoke or hard starting before the white smoke?", "yes": "increase", "no": "neutral", "how": "Rich/flooding running (black smoke) precedes the fuel dilution that causes oil carryover."}], "parts": [{"name": "Carburetor Rebuild Kit GX160/200", "sku": "CARB-KIT-GX200", "qty": 1, "cost": 18.5, "reuse": false, "reuse_note": "Replace float needle/seat and gaskets to stop flooding"}, {"name": "Engine Oil 10W-30 (qt)", "sku": "OIL-10W30", "qty": 1, "cost": 6.5, "reuse": false, "reuse_note": "Diluted oil must be changed, not topped off"}], "labor_hrs": 1.0, "fix": "Fix the flooding source first - clean or rebuild the carburetor (float, inlet needle/seat, float height). Then change the fuel-diluted oil and filter. Verify the choke isn't stuck on. Run and confirm the smoke clears.", "reuse_all": false}];
var ENGINE_COSTS = {"GX160":{new_cost:550,model:"GX160"},"GX200":{new_cost:600,model:"GX200"},"GX270":{new_cost:800,model:"GX270 → GX200 swap",note:"Replace with GX200 + $200 swap labor/parts"}};
var DIAG_LABOR_RATE = 30;


var seedEngines = [{"id": "ENG-0001", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K01", "assignedTrack": "euro", "totalHrs": 383, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 218.92, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0002", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K02", "assignedTrack": "euro", "totalHrs": 337, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 243.07, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0003", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K03", "assignedTrack": "euro", "totalHrs": 215, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 307.12, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0004", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K04", "assignedTrack": "euro", "totalHrs": 353, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 234.68, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0005", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K05", "assignedTrack": "euro", "totalHrs": 442, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 187.95, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0006", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K06", "assignedTrack": "euro", "totalHrs": 124, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 354.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0007", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K07", "assignedTrack": "euro", "totalHrs": 263, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 281.93, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0008", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K08", "assignedTrack": "euro", "totalHrs": 440, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 189.0, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0009", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K09", "assignedTrack": "euro", "totalHrs": 407, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 206.32, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0010", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K10", "assignedTrack": "euro", "totalHrs": 155, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 338.62, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0011", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K11", "assignedTrack": "euro", "totalHrs": 339, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 242.03, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0012", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K12", "assignedTrack": "euro", "totalHrs": 247, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 290.32, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0013", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K13", "assignedTrack": "euro", "totalHrs": 371, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 278.85, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0014", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K14", "assignedTrack": "euro", "totalHrs": 388, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 267.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0015", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K15", "assignedTrack": "euro", "totalHrs": 405, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 256.75, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0016", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K16", "assignedTrack": "euro", "totalHrs": 422, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 245.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0017", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K17", "assignedTrack": "euro", "totalHrs": 439, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 234.65, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0018", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K18", "assignedTrack": "euro", "totalHrs": 156, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 418.6, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0019", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K19", "assignedTrack": "euro", "totalHrs": 173, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 407.55, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0020", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K20", "assignedTrack": "euro", "totalHrs": 190, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 396.5, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0021", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K21", "assignedTrack": "euro", "totalHrs": 207, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 385.45, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0022", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K22", "assignedTrack": "euro", "totalHrs": 224, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 374.4, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0101", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K01", "assignedTrack": "road", "totalHrs": 123, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 321.57, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0102", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K02", "assignedTrack": "road", "totalHrs": 146, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 310.65, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0103", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K03", "assignedTrack": "road", "totalHrs": 169, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 299.73, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0104", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K04", "assignedTrack": "road", "totalHrs": 192, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 288.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0105", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K05", "assignedTrack": "road", "totalHrs": 215, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 277.88, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0106", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K06", "assignedTrack": "road", "totalHrs": 238, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 266.95, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0107", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K07", "assignedTrack": "road", "totalHrs": 261, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 256.02, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0108", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K08", "assignedTrack": "road", "totalHrs": 284, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 245.1, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0109", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K09", "assignedTrack": "road", "totalHrs": 307, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 234.18, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0110", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K10", "assignedTrack": "road", "totalHrs": 330, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 223.25, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0111", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K11", "assignedTrack": "road", "totalHrs": 353, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 212.33, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0112", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K12", "assignedTrack": "road", "totalHrs": 376, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 201.4, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0113", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K13", "assignedTrack": "road", "totalHrs": 399, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 190.47, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0114", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K14", "assignedTrack": "road", "totalHrs": 422, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 179.55, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0115", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K15", "assignedTrack": "road", "totalHrs": 445, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 168.62, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0116", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K16", "assignedTrack": "road", "totalHrs": 468, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 157.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0117", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K17", "assignedTrack": "road", "totalHrs": 491, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 146.78, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0118", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K18", "assignedTrack": "road", "totalHrs": 114, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 325.85, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0119", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K19", "assignedTrack": "road", "totalHrs": 137, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 314.93, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0120", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K20", "assignedTrack": "road", "totalHrs": 160, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 304.0, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0121", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K21", "assignedTrack": "road", "totalHrs": 183, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 293.07, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0122", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K22", "assignedTrack": "road", "totalHrs": 206, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 282.15, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0123", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K23", "assignedTrack": "road", "totalHrs": 229, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 271.23, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0124", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K24", "assignedTrack": "road", "totalHrs": 252, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 260.3, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0125", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K25", "assignedTrack": "road", "totalHrs": 275, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 249.38, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0126", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K26", "assignedTrack": "road", "totalHrs": 298, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 238.45, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0127", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K27", "assignedTrack": "road", "totalHrs": 321, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 227.53, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0128", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K28", "assignedTrack": "road", "totalHrs": 344, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 216.6, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0129", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K29", "assignedTrack": "road", "totalHrs": 367, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 205.68, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0130", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K30", "assignedTrack": "road", "totalHrs": 390, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 194.75, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0131", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K31", "assignedTrack": "road", "totalHrs": 413, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 183.83, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0132", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K32", "assignedTrack": "road", "totalHrs": 436, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 172.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0133", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K33", "assignedTrack": "road", "totalHrs": 459, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 161.97, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0134", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K34", "assignedTrack": "road", "totalHrs": 482, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 151.05, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0201", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K01", "assignedTrack": "sprint", "totalHrs": 231, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 298.73, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0202", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K02", "assignedTrack": "sprint", "totalHrs": 262, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 282.45, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0203", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K03", "assignedTrack": "sprint", "totalHrs": 293, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 266.17, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0204", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K04", "assignedTrack": "sprint", "totalHrs": 324, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 249.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0205", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K05", "assignedTrack": "sprint", "totalHrs": 355, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 233.62, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0206", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K06", "assignedTrack": "sprint", "totalHrs": 386, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 217.35, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0207", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K07", "assignedTrack": "sprint", "totalHrs": 417, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 201.08, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0208", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K08", "assignedTrack": "sprint", "totalHrs": 448, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 184.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0209", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K09", "assignedTrack": "sprint", "totalHrs": 479, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 168.53, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0210", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K10", "assignedTrack": "sprint", "totalHrs": 510, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 152.25, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0211", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K11", "assignedTrack": "sprint", "totalHrs": 541, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 135.97, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0212", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K12", "assignedTrack": "sprint", "totalHrs": 572, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 119.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0213", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K13", "assignedTrack": "sprint", "totalHrs": 603, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 103.43, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0214", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K14", "assignedTrack": "sprint", "totalHrs": 634, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 87.15, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0215", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K15", "assignedTrack": "sprint", "totalHrs": 665, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 70.88, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0216", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K16", "assignedTrack": "sprint", "totalHrs": 696, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 54.6, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0301", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K01", "assignedTrack": "kiddie", "totalHrs": 99, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 332.98, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0302", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K02", "assignedTrack": "kiddie", "totalHrs": 118, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 323.95, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0303", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K03", "assignedTrack": "kiddie", "totalHrs": 137, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 314.93, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0304", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K04", "assignedTrack": "kiddie", "totalHrs": 156, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 305.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0305", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K05", "assignedTrack": "kiddie", "totalHrs": 175, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 296.88, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0306", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K06", "assignedTrack": "kiddie", "totalHrs": 194, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 287.85, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0307", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K07", "assignedTrack": "kiddie", "totalHrs": 213, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 278.82, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0308", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K08", "assignedTrack": "kiddie", "totalHrs": 232, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 269.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0309", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K09", "assignedTrack": "kiddie", "totalHrs": 251, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 260.77, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0310", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K10", "assignedTrack": "kiddie", "totalHrs": 270, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 251.75, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0311", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K11", "assignedTrack": "kiddie", "totalHrs": 89, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 337.73, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0312", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K12", "assignedTrack": "kiddie", "totalHrs": 108, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 328.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}];

var SPARE_ENGINES=[{"id":"ENG-SP01","serial":"GCBTT-2408081","model":"GX200","kartType":"Spare (UT2-RH2)","status":"spare","assignedKartId":null,"assignedTrack":null,"totalHrs":0,"lastOilHrs":0,"lastSvcHrs":0,"purchaseDate":"","purchaseCost":0,"currentValue":0,"rebuildCount":0,"rebuildScheduled":false,"rebuildWoId":null,"rebuildHistory":[],"serviceHistory":[],"notes":"Honda GX200 UT2-RH2 spare engine (imported)"},{"id":"ENG-SP02","serial":"GCBTT-2408091","model":"GX200","kartType":"Spare (UT2-RH2)","status":"spare","assignedKartId":null,"assignedTrack":null,"totalHrs":0,"lastOilHrs":0,"lastSvcHrs":0,"purchaseDate":"","purchaseCost":0,"currentValue":0,"rebuildCount":0,"rebuildScheduled":false,"rebuildWoId":null,"rebuildHistory":[],"serviceHistory":[],"notes":"Honda GX200 UT2-RH2 spare engine (imported)"}];

function sortKarts(){if(!D.karts)return;var _tr=['euro','road','sprint','kiddie'];for(var _t=0;_t<_tr.length;_t++){if(D.karts[_tr[_t]]&&D.karts[_tr[_t]].sort)D.karts[_tr[_t]].sort(function(a,b){return (Number(a.num)||0)-(Number(b.num)||0);});}}
async function seedDatabaseIfEmpty(){
  if(!sb) return;
  try{
    // Check if karts table is empty
    var res = await sb.from('karts').select('id',{count:'exact',head:true});
    if(res.count > 0){
      console.log("DB already has data, skipping seed");
      return;
    }
    console.log("Empty DB detected — seeding initial data...");
    showLoadingOverlay(true);
    var _olt=document.getElementById('loadingOverlay');if(_olt){var _oltd=_olt.querySelector('div:last-child');if(_oltd)_oltd.textContent="Setting up database...";}

    // Seed karts
    var _kartData = [{"id": "EUR-K01", "num": 1, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0001", "status": "active", "engineHrs": 383, "lastOilHrs": 338, "last50hrHrs": 338, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K02", "num": 2, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0002", "status": "active", "engineHrs": 337, "lastOilHrs": 292, "last50hrHrs": 292, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K03", "num": 3, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0003", "status": "active", "engineHrs": 215, "lastOilHrs": 170, "last50hrHrs": 170, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K04", "num": 4, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0004", "status": "active", "engineHrs": 353, "lastOilHrs": 308, "last50hrHrs": 308, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K05", "num": 5, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0005", "status": "active", "engineHrs": 442, "lastOilHrs": 397, "last50hrHrs": 397, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K06", "num": 6, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0006", "status": "active", "engineHrs": 124, "lastOilHrs": 79, "last50hrHrs": 79, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K07", "num": 7, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0007", "status": "active", "engineHrs": 263, "lastOilHrs": 218, "last50hrHrs": 218, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K08", "num": 8, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0008", "status": "active", "engineHrs": 440, "lastOilHrs": 395, "last50hrHrs": 395, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K09", "num": 9, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0009", "status": "active", "engineHrs": 407, "lastOilHrs": 362, "last50hrHrs": 362, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K10", "num": 10, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0010", "status": "active", "engineHrs": 155, "lastOilHrs": 110, "last50hrHrs": 110, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K11", "num": 11, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0011", "status": "active", "engineHrs": 339, "lastOilHrs": 294, "last50hrHrs": 294, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K12", "num": 12, "track": "euro", "kartType": "Sodi GT5R", "engine": "GX200", "engineId": "ENG-0012", "status": "active", "engineHrs": 247, "lastOilHrs": 202, "last50hrHrs": 202, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K13", "num": 13, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0013", "status": "active", "engineHrs": 371, "lastOilHrs": 326, "last50hrHrs": 326, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K14", "num": 14, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0014", "status": "active", "engineHrs": 388, "lastOilHrs": 343, "last50hrHrs": 343, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K15", "num": 15, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0015", "status": "active", "engineHrs": 405, "lastOilHrs": 360, "last50hrHrs": 360, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K16", "num": 16, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0016", "status": "active", "engineHrs": 422, "lastOilHrs": 377, "last50hrHrs": 377, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K17", "num": 17, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0017", "status": "active", "engineHrs": 439, "lastOilHrs": 394, "last50hrHrs": 394, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K18", "num": 18, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0018", "status": "active", "engineHrs": 156, "lastOilHrs": 111, "last50hrHrs": 111, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K19", "num": 19, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0019", "status": "active", "engineHrs": 173, "lastOilHrs": 128, "last50hrHrs": 128, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K20", "num": 20, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0020", "status": "active", "engineHrs": 190, "lastOilHrs": 145, "last50hrHrs": 145, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K21", "num": 21, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0021", "status": "active", "engineHrs": 207, "lastOilHrs": 162, "last50hrHrs": 162, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "EUR-K22", "num": 22, "track": "euro", "kartType": "Sodi SR5", "engine": "GX270", "engineId": "ENG-0022", "status": "active", "engineHrs": 224, "lastOilHrs": 179, "last50hrHrs": 179, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K01", "num": 1, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0101", "status": "active", "engineHrs": 123, "lastOilHrs": 78, "last50hrHrs": 78, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K02", "num": 2, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0102", "status": "active", "engineHrs": 146, "lastOilHrs": 101, "last50hrHrs": 101, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K03", "num": 3, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0103", "status": "active", "engineHrs": 169, "lastOilHrs": 124, "last50hrHrs": 124, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K04", "num": 4, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0104", "status": "active", "engineHrs": 192, "lastOilHrs": 147, "last50hrHrs": 147, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K05", "num": 5, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0105", "status": "active", "engineHrs": 215, "lastOilHrs": 170, "last50hrHrs": 170, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K06", "num": 6, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0106", "status": "active", "engineHrs": 238, "lastOilHrs": 193, "last50hrHrs": 193, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K07", "num": 7, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0107", "status": "active", "engineHrs": 261, "lastOilHrs": 216, "last50hrHrs": 216, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K08", "num": 8, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0108", "status": "active", "engineHrs": 284, "lastOilHrs": 239, "last50hrHrs": 239, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K09", "num": 9, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0109", "status": "active", "engineHrs": 307, "lastOilHrs": 262, "last50hrHrs": 262, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K10", "num": 10, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0110", "status": "active", "engineHrs": 330, "lastOilHrs": 285, "last50hrHrs": 285, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K11", "num": 11, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0111", "status": "active", "engineHrs": 353, "lastOilHrs": 308, "last50hrHrs": 308, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K12", "num": 12, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0112", "status": "active", "engineHrs": 376, "lastOilHrs": 331, "last50hrHrs": 331, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K13", "num": 13, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0113", "status": "active", "engineHrs": 399, "lastOilHrs": 354, "last50hrHrs": 354, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K14", "num": 14, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0114", "status": "active", "engineHrs": 422, "lastOilHrs": 377, "last50hrHrs": 377, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K15", "num": 15, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0115", "status": "active", "engineHrs": 445, "lastOilHrs": 400, "last50hrHrs": 400, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K16", "num": 16, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0116", "status": "active", "engineHrs": 468, "lastOilHrs": 423, "last50hrHrs": 423, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K17", "num": 17, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0117", "status": "active", "engineHrs": 491, "lastOilHrs": 446, "last50hrHrs": 446, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K18", "num": 18, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0118", "status": "active", "engineHrs": 114, "lastOilHrs": 69, "last50hrHrs": 69, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K19", "num": 19, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0119", "status": "active", "engineHrs": 137, "lastOilHrs": 92, "last50hrHrs": 92, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K20", "num": 20, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0120", "status": "active", "engineHrs": 160, "lastOilHrs": 115, "last50hrHrs": 115, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K21", "num": 21, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0121", "status": "active", "engineHrs": 183, "lastOilHrs": 138, "last50hrHrs": 138, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K22", "num": 22, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0122", "status": "active", "engineHrs": 206, "lastOilHrs": 161, "last50hrHrs": 161, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K23", "num": 23, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0123", "status": "active", "engineHrs": 229, "lastOilHrs": 184, "last50hrHrs": 184, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K24", "num": 24, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0124", "status": "active", "engineHrs": 252, "lastOilHrs": 207, "last50hrHrs": 207, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K25", "num": 25, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0125", "status": "active", "engineHrs": 275, "lastOilHrs": 230, "last50hrHrs": 230, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K26", "num": 26, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0126", "status": "active", "engineHrs": 298, "lastOilHrs": 253, "last50hrHrs": 253, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K27", "num": 27, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0127", "status": "active", "engineHrs": 321, "lastOilHrs": 276, "last50hrHrs": 276, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K28", "num": 28, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0128", "status": "active", "engineHrs": 344, "lastOilHrs": 299, "last50hrHrs": 299, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K29", "num": 29, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0129", "status": "active", "engineHrs": 367, "lastOilHrs": 322, "last50hrHrs": 322, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K30", "num": 30, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0130", "status": "active", "engineHrs": 390, "lastOilHrs": 345, "last50hrHrs": 345, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K31", "num": 31, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0131", "status": "active", "engineHrs": 413, "lastOilHrs": 368, "last50hrHrs": 368, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K32", "num": 32, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0132", "status": "active", "engineHrs": 436, "lastOilHrs": 391, "last50hrHrs": 391, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K33", "num": 33, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0133", "status": "active", "engineHrs": 459, "lastOilHrs": 414, "last50hrHrs": 414, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "RD-K34", "num": 34, "track": "road", "kartType": "Formula K F1000", "engine": "GX160", "engineId": "ENG-0134", "status": "active", "engineHrs": 482, "lastOilHrs": 437, "last50hrHrs": 437, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K01", "num": 1, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0201", "status": "active", "engineHrs": 231, "lastOilHrs": 186, "last50hrHrs": 186, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K02", "num": 2, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0202", "status": "active", "engineHrs": 262, "lastOilHrs": 217, "last50hrHrs": 217, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K03", "num": 3, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0203", "status": "active", "engineHrs": 293, "lastOilHrs": 248, "last50hrHrs": 248, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K04", "num": 4, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0204", "status": "active", "engineHrs": 324, "lastOilHrs": 279, "last50hrHrs": 279, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K05", "num": 5, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0205", "status": "active", "engineHrs": 355, "lastOilHrs": 310, "last50hrHrs": 310, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K06", "num": 6, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0206", "status": "active", "engineHrs": 386, "lastOilHrs": 341, "last50hrHrs": 341, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K07", "num": 7, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0207", "status": "active", "engineHrs": 417, "lastOilHrs": 372, "last50hrHrs": 372, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K08", "num": 8, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0208", "status": "active", "engineHrs": 448, "lastOilHrs": 403, "last50hrHrs": 403, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K09", "num": 9, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0209", "status": "active", "engineHrs": 479, "lastOilHrs": 434, "last50hrHrs": 434, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K10", "num": 10, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0210", "status": "active", "engineHrs": 510, "lastOilHrs": 465, "last50hrHrs": 465, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K11", "num": 11, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0211", "status": "active", "engineHrs": 541, "lastOilHrs": 496, "last50hrHrs": 496, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K12", "num": 12, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0212", "status": "active", "engineHrs": 572, "lastOilHrs": 527, "last50hrHrs": 527, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K13", "num": 13, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0213", "status": "active", "engineHrs": 603, "lastOilHrs": 558, "last50hrHrs": 558, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K14", "num": 14, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0214", "status": "active", "engineHrs": 634, "lastOilHrs": 589, "last50hrHrs": 589, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K15", "num": 15, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0215", "status": "active", "engineHrs": 665, "lastOilHrs": 620, "last50hrHrs": 620, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "SPT-K16", "num": 16, "track": "sprint", "kartType": "J&J F-8000 Sprint", "engine": "GX200", "engineId": "ENG-0216", "status": "active", "engineHrs": 696, "lastOilHrs": 651, "last50hrHrs": 651, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K01", "num": 1, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0301", "status": "active", "engineHrs": 99, "lastOilHrs": 54, "last50hrHrs": 54, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K02", "num": 2, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0302", "status": "active", "engineHrs": 118, "lastOilHrs": 73, "last50hrHrs": 73, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K03", "num": 3, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0303", "status": "active", "engineHrs": 137, "lastOilHrs": 92, "last50hrHrs": 92, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K04", "num": 4, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0304", "status": "active", "engineHrs": 156, "lastOilHrs": 111, "last50hrHrs": 111, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K05", "num": 5, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0305", "status": "active", "engineHrs": 175, "lastOilHrs": 130, "last50hrHrs": 130, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K06", "num": 6, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0306", "status": "active", "engineHrs": 194, "lastOilHrs": 149, "last50hrHrs": 149, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K07", "num": 7, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0307", "status": "active", "engineHrs": 213, "lastOilHrs": 168, "last50hrHrs": 168, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K08", "num": 8, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0308", "status": "active", "engineHrs": 232, "lastOilHrs": 187, "last50hrHrs": 187, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K09", "num": 9, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0309", "status": "active", "engineHrs": 251, "lastOilHrs": 206, "last50hrHrs": 206, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K10", "num": 10, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0310", "status": "active", "engineHrs": 270, "lastOilHrs": 225, "last50hrHrs": 225, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K11", "num": 11, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0311", "status": "active", "engineHrs": 89, "lastOilHrs": 44, "last50hrHrs": 44, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}, {"id": "KID-K12", "num": 12, "track": "kiddie", "kartType": "Formula K F5000", "engine": "GX160", "engineId": "ENG-0312", "status": "active", "engineHrs": 108, "lastOilHrs": 63, "last50hrHrs": 63, "shopWoId": null, "preOpToday": false, "transponderSerial": "", "notes": ""}];
    var engData  = [{"id": "ENG-0001", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K01", "assignedTrack": "euro", "totalHrs": 383, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 218.92, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0002", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K02", "assignedTrack": "euro", "totalHrs": 337, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 243.07, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0003", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K03", "assignedTrack": "euro", "totalHrs": 215, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 307.12, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0004", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K04", "assignedTrack": "euro", "totalHrs": 353, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 234.68, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0005", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K05", "assignedTrack": "euro", "totalHrs": 442, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 187.95, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0006", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K06", "assignedTrack": "euro", "totalHrs": 124, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 354.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0007", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K07", "assignedTrack": "euro", "totalHrs": 263, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 281.93, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0008", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K08", "assignedTrack": "euro", "totalHrs": 440, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 189.0, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0009", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K09", "assignedTrack": "euro", "totalHrs": 407, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 206.32, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0010", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K10", "assignedTrack": "euro", "totalHrs": 155, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 338.62, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0011", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K11", "assignedTrack": "euro", "totalHrs": 339, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 242.03, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0012", "serial": "", "model": "GX200", "kartType": "Sodi GT5R", "status": "installed", "assignedKartId": "EUR-K12", "assignedTrack": "euro", "totalHrs": 247, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 290.32, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0013", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K13", "assignedTrack": "euro", "totalHrs": 371, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 278.85, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0014", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K14", "assignedTrack": "euro", "totalHrs": 388, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 267.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0015", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K15", "assignedTrack": "euro", "totalHrs": 405, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 256.75, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0016", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K16", "assignedTrack": "euro", "totalHrs": 422, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 245.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0017", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K17", "assignedTrack": "euro", "totalHrs": 439, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 234.65, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0018", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K18", "assignedTrack": "euro", "totalHrs": 156, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 418.6, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0019", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K19", "assignedTrack": "euro", "totalHrs": 173, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 407.55, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0020", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K20", "assignedTrack": "euro", "totalHrs": 190, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 396.5, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0021", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K21", "assignedTrack": "euro", "totalHrs": 207, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 385.45, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0022", "serial": "", "model": "GX270", "kartType": "Sodi SR5", "status": "installed", "assignedKartId": "EUR-K22", "assignedTrack": "euro", "totalHrs": 224, "purchaseDate": "2023-01-01", "purchaseCost": 520, "currentValue": 374.4, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0101", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K01", "assignedTrack": "road", "totalHrs": 123, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 321.57, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0102", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K02", "assignedTrack": "road", "totalHrs": 146, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 310.65, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0103", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K03", "assignedTrack": "road", "totalHrs": 169, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 299.73, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0104", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K04", "assignedTrack": "road", "totalHrs": 192, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 288.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0105", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K05", "assignedTrack": "road", "totalHrs": 215, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 277.88, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0106", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K06", "assignedTrack": "road", "totalHrs": 238, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 266.95, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0107", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K07", "assignedTrack": "road", "totalHrs": 261, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 256.02, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0108", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K08", "assignedTrack": "road", "totalHrs": 284, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 245.1, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0109", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K09", "assignedTrack": "road", "totalHrs": 307, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 234.18, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0110", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K10", "assignedTrack": "road", "totalHrs": 330, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 223.25, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0111", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K11", "assignedTrack": "road", "totalHrs": 353, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 212.33, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0112", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K12", "assignedTrack": "road", "totalHrs": 376, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 201.4, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0113", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K13", "assignedTrack": "road", "totalHrs": 399, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 190.47, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0114", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K14", "assignedTrack": "road", "totalHrs": 422, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 179.55, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0115", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K15", "assignedTrack": "road", "totalHrs": 445, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 168.62, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0116", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K16", "assignedTrack": "road", "totalHrs": 468, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 157.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0117", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K17", "assignedTrack": "road", "totalHrs": 491, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 146.78, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0118", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K18", "assignedTrack": "road", "totalHrs": 114, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 325.85, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0119", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K19", "assignedTrack": "road", "totalHrs": 137, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 314.93, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0120", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K20", "assignedTrack": "road", "totalHrs": 160, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 304.0, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0121", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K21", "assignedTrack": "road", "totalHrs": 183, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 293.07, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0122", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K22", "assignedTrack": "road", "totalHrs": 206, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 282.15, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0123", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K23", "assignedTrack": "road", "totalHrs": 229, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 271.23, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0124", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K24", "assignedTrack": "road", "totalHrs": 252, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 260.3, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0125", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K25", "assignedTrack": "road", "totalHrs": 275, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 249.38, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0126", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K26", "assignedTrack": "road", "totalHrs": 298, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 238.45, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0127", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K27", "assignedTrack": "road", "totalHrs": 321, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 227.53, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0128", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K28", "assignedTrack": "road", "totalHrs": 344, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 216.6, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0129", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K29", "assignedTrack": "road", "totalHrs": 367, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 205.68, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0130", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K30", "assignedTrack": "road", "totalHrs": 390, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 194.75, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0131", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K31", "assignedTrack": "road", "totalHrs": 413, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 183.83, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0132", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K32", "assignedTrack": "road", "totalHrs": 436, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 172.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0133", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K33", "assignedTrack": "road", "totalHrs": 459, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 161.97, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0134", "serial": "", "model": "GX160", "kartType": "Formula K F1000", "status": "installed", "assignedKartId": "RD-K34", "assignedTrack": "road", "totalHrs": 482, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 151.05, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0201", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K01", "assignedTrack": "sprint", "totalHrs": 231, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 298.73, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0202", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K02", "assignedTrack": "sprint", "totalHrs": 262, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 282.45, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0203", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K03", "assignedTrack": "sprint", "totalHrs": 293, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 266.17, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0204", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K04", "assignedTrack": "sprint", "totalHrs": 324, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 249.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0205", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K05", "assignedTrack": "sprint", "totalHrs": 355, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 233.62, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0206", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K06", "assignedTrack": "sprint", "totalHrs": 386, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 217.35, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0207", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K07", "assignedTrack": "sprint", "totalHrs": 417, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 201.08, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0208", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K08", "assignedTrack": "sprint", "totalHrs": 448, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 184.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0209", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K09", "assignedTrack": "sprint", "totalHrs": 479, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 168.53, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0210", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K10", "assignedTrack": "sprint", "totalHrs": 510, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 152.25, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0211", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K11", "assignedTrack": "sprint", "totalHrs": 541, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 135.97, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0212", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K12", "assignedTrack": "sprint", "totalHrs": 572, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 119.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0213", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K13", "assignedTrack": "sprint", "totalHrs": 603, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 103.43, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0214", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K14", "assignedTrack": "sprint", "totalHrs": 634, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 87.15, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0215", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K15", "assignedTrack": "sprint", "totalHrs": 665, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 70.88, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0216", "serial": "", "model": "GX200", "kartType": "J&J F-8000 Sprint", "status": "installed", "assignedKartId": "SPT-K16", "assignedTrack": "sprint", "totalHrs": 696, "purchaseDate": "2023-01-01", "purchaseCost": 420, "currentValue": 54.6, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0301", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K01", "assignedTrack": "kiddie", "totalHrs": 99, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 332.98, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0302", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K02", "assignedTrack": "kiddie", "totalHrs": 118, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 323.95, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0303", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K03", "assignedTrack": "kiddie", "totalHrs": 137, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 314.93, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0304", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K04", "assignedTrack": "kiddie", "totalHrs": 156, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 305.9, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0305", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K05", "assignedTrack": "kiddie", "totalHrs": 175, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 296.88, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0306", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K06", "assignedTrack": "kiddie", "totalHrs": 194, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 287.85, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0307", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K07", "assignedTrack": "kiddie", "totalHrs": 213, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 278.82, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0308", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K08", "assignedTrack": "kiddie", "totalHrs": 232, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 269.8, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0309", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K09", "assignedTrack": "kiddie", "totalHrs": 251, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 260.77, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0310", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K10", "assignedTrack": "kiddie", "totalHrs": 270, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 251.75, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0311", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K11", "assignedTrack": "kiddie", "totalHrs": 89, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 337.73, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}, {"id": "ENG-0312", "serial": "", "model": "GX160", "kartType": "Formula K F5000", "status": "installed", "assignedKartId": "KID-K12", "assignedTrack": "kiddie", "totalHrs": 108, "purchaseDate": "2023-01-01", "purchaseCost": 380, "currentValue": 328.7, "rebuildCount": 0, "rebuildScheduled": false, "rebuildWoId": null, "rebuildHistory": [], "serviceHistory": [], "notes": ""}];
    var assetData= [{"id": "MX-6528874", "name": "Tornado", "category": "ride", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "", "manufacturer": "Wisdom", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-6646997", "name": "Dragon Coaster", "category": "ride", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "", "manufacturer": "Wisdom", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-6647018", "name": "Fun Slide", "category": "ride", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "", "manufacturer": "Frederiksen Industries, Inc.", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-6647078", "name": "Sprint 6", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647082", "name": "Sprint 7", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647083", "name": "Sprint 8", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647086", "name": "Sprint 10", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647087", "name": "Sprint 11", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647088", "name": "Sprint 12", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647089", "name": "Sprint 13", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647090", "name": "Sprint 14", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6647092", "name": "Sprint 16", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6698174", "name": "Lincon Pizza Oven", "category": "food-service", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "L27020", "manufacturer": "Lincoln Impinger\u00ae II", "model": "Impinger\u00ae II", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Model: 1600 000 DB (Base/Original Model)", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6698175", "name": "Manitowek Ice machines", "category": "food-service", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "1120086630", "manufacturer": "Manitowoc", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6826394", "name": "Sprint 1", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "J&J Amusements", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6826396", "name": "Sprint 3", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "J&J Amusements", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875615", "name": "Family Kart 10", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Family/Road Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875617", "name": "Family Kart 11", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Family/Road Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875620", "name": "Family Kart 12", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Family/Road Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875622", "name": "Family Kart 13", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Family/Road Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875624", "name": "Family Kart 14", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875626", "name": "Family Kart 15", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875627", "name": "Family Kart 19", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875629", "name": "Family Kart 17", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875630", "name": "Family Kart 18", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875632", "name": "Family Kart 2", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Family/Road Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875633", "name": "Family Kart 20", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875635", "name": "Family Kart 21", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875637", "name": "Family Kart 22", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875638", "name": "Family Kart 23", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Family/Road Track", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875640", "name": "Family Kart 24", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875642", "name": "Family Kart 25", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875643", "name": "Family Kart 26", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875647", "name": "Family Kart 28", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875649", "name": "Family Kart 29", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875651", "name": "Family Kart 3", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875652", "name": "Family Kart 30", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875654", "name": "Family Kart 31", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875656", "name": "Family Kart 32", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875658", "name": "Family Kart 33", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875660", "name": "Family Kart 34", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875662", "name": "Family Kart 4", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875664", "name": "Family Kart 5", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "FormulaK", "model": "F1000", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875666", "name": "Family Kart 6", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875667", "name": "Family Kart 7", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875668", "name": "Family Kart 8", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6875670", "name": "Family Kart 9", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6889714", "name": "A/C 1 - 5ton Over walkin", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "Carrier", "model": "661BE060-A", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6889720", "name": "A/C 2 - 5ton over walk in", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "Carrier", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6889725", "name": "A/C 3 - 7.5 ton over walk in", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "250514696", "manufacturer": "Daikin", "model": "DH6TE0904", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Split System; Rooftop Condenser, 7.5 Ton R-32 HP 3Phase 460V, separate air handler (see child)\n\nRequires 2 of each filter (16 x 20 x 2, 20 x 20 x 2), change monthly\n\nHVAC Unit is 11.r EER / 15 IEER; 2-stage tandem, not inverter/VFG Compressor\nWhen cooling, approximate power draw is 92k BTU per hour / 11.4 EER = 8,070 watts\nTypical cooling cost is 8-10kw, on a very hot day it could reach up to 9-11\nIn terms of cost ($0.081744/kwh as of 4/2026), that equals roughly $0.74 per hour, plus demand and facility charges of 10.08*highest demand in month, assuming this contributes, roughly $100/month, totaling roughly $230 - $290 per month.", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-6889731", "name": "RTU 4 SW Side by tornado (HVAC)", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "1803407624", "manufacturer": "Daikin", "model": "DCC 120xxx4vxxxac", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "HVAC Unit - not currently in service.  Leak and at least one bad compressor.", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-7754858", "name": "Entry Gates", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-8062577", "name": "Table", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Inside/Outside Table", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-8372680", "name": "Exit Gate at Sprint", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Sprint Track", "lastService": "", "nextService": "", "notes": "Exit gate from Sprint track", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-8501057", "name": "Track tools", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Tools used at the tracks to move karts or the tires around the track.", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-8501065", "name": "Tire Machine", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Shop Tire Machine for Karts", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-8760413", "name": "Exit Gate Kiddie Karts", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Exit Gate/ Fence", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-9781881", "name": "MyLaps transponder 12486708", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 17 (SR5)", "serial": "12486708", "manufacturer": "mylaps", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-9781882", "name": "MyLaps Transponder 12724659", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "", "serial": "12724659", "manufacturer": "mylaps", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-9781884", "name": "MyLaps Transponder 12608563", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 16 (SR5)", "serial": "12608563", "manufacturer": "mylaps", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-9781885", "name": "MyLaps Transponder 12673979", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "", "serial": "12673979", "manufacturer": "mylaps", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Transponder for MyLaps Timing System; Assign parent asset when it is installed on a sodi kart", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10029566", "name": "Hytera Radio #6", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R23O180728", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10030321", "name": "Hytera Radio #16", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R23O180726", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Manager/Sup Radio\nhas a clip", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10030338", "name": "Hytera Radio #15", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R23O180730", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "THIS RADIO IS CURRENTLY ASSIGNED TO LIZ\nhas clip", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10030348", "name": "Hytera Radio #7", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R23O180729", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10030365", "name": "Hytera Radio #12", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R20D110884", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "THIS RADIO IS CURRENTLY ASSIGNED TO MO", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031064", "name": "Hytera Radio #10", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R214071248", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031080", "name": "Hytera Radio #1", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R216242269", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031097", "name": "Hytera Radio #5", "category": "radio", "maintenanceType": "vendor", "status": "out-of-service", "parent": "", "serial": "R19N230213", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031111", "name": "Hytera Radio #8", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R214071249", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031124", "name": "Hytera Radio #4", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R214071247", "manufacturer": "Hytera", "model": "pd602i", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "temporally assigned to mo", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031136", "name": "Hytera Radio #3", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R216242270", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031157", "name": "Hytera Radio #11", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R247221065", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Placed in service August 2025, 3 year Warranty", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031163", "name": "Hytera Radio #14", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R19N230252", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Placed in service August 2025", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10031172", "name": "Hytera Radio #13", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R19N230251", "manufacturer": "Hytera", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Placed in service August 2025", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10050888", "name": "Men\u2019s sink 1", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-10150130", "name": "Cilico scanner #1", "category": "scanner", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "OE8838003164", "manufacturer": "Cilico", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10150131", "name": "Cilico scanner #2", "category": "scanner", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "OE8838003144", "manufacturer": "Cilico", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10150132", "name": "Cilico scanner #3", "category": "scanner", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "OE8838003140", "manufacturer": "Cilico", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10150135", "name": "Cilico scanner #4", "category": "scanner", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "OE8838003157", "manufacturer": "Cilico", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10150136", "name": "Cilico scanner#5", "category": "scanner", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "OE8838003849", "manufacturer": "Cilico", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10150137", "name": "Cilico scanner #6", "category": "scanner", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "OE8838003824", "manufacturer": "Cilico", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-10203708", "name": "My laps transponder 6366338", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 1", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203709", "name": "My laps transponder 6166119", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 2", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203710", "name": "My laps transponder 6321334", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 3", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203711", "name": "My laps transponder 6413607", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 4", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203712", "name": "My laps transponder 6489598", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 5", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203713", "name": "My laps transponder 6130884", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Family Kart 7", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203714", "name": "My laps transponder 6320433", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 9", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203715", "name": "My laps transponder 7403289", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 10", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203716", "name": "My laps transponder 6735069", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 11", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203719", "name": "My laps transponder 12479833", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 13 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203720", "name": "My laps transponder 12751876", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 14 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203723", "name": "My laps transponder 12536588", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 15 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203725", "name": "My laps transponder 12470103", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 18 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203727", "name": "My laps transponder 12478827", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 19 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203728", "name": "My laps transponder 12478926", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-10203729", "name": "12441277", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "Sodi 21 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-10203731", "name": "My laps transponder 12476005", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 22 (SR5)", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-11181827", "name": "Honda Engine", "category": "engine-spare", "maintenanceType": "internal", "status": "operational", "parent": "Sodi 10", "serial": "GCBTT-2408091", "manufacturer": "Honda", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Honda Engine\nPart Lookup by Serial Number: https://peparts.honda.com/engines/engines/GX/GX200/GX200UT2-RH2/illustrations", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-12338810", "name": "Make table large", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-12338817", "name": "Make Table Small", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-12474221", "name": "A/C 5 by tornado", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "Carrier", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-12474222", "name": "A/C 6  7.5 ton North", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "Daikin", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-12474375", "name": "A/C 7 - 110 ton North sign", "category": "facility", "maintenanceType": "internal", "status": "out-of-service", "parent": "", "serial": "", "manufacturer": "Daikin", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-12496123", "name": "Tornado pod 7", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Pod 7", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-13759793", "name": "Inside air filters for big a/c (cleaning)", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "", "serial": "", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Replace and wipe down grills for filter holders", "vendorOnly": false, "subAssetOnly": false}, {"id": "MX-14165578", "name": "My laps transponder", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 6", "serial": "6414848", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-14165584", "name": "My Laps Transponder", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 23", "serial": "12673979", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-14165592", "name": "My Laps Transponder", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 7", "serial": "6130884", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-14165594", "name": "My Laps Transponder", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 12", "serial": "12724659", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-14165597", "name": "My Laps Transponder", "category": "transponder", "maintenanceType": "sub-asset-only", "status": "operational", "parent": "Sodi 20 (SR5)", "serial": "12478926", "manufacturer": "", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": false, "subAssetOnly": true}, {"id": "MX-16076253", "name": "Hytera Radio #17", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R246281206", "manufacturer": "Hytera", "model": "BD502i VHF", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-16190547", "name": "Hytera Radio #18", "category": "radio", "maintenanceType": "vendor", "status": "operational", "parent": "", "serial": "R246281215", "manufacturer": "Hytera", "model": "BD502i VHF", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "", "vendorOnly": true, "subAssetOnly": false}, {"id": "MX-16713515", "name": "AC Unit 2 Air Handler", "category": "facility", "maintenanceType": "internal", "status": "operational", "parent": "A/C 3 - 7.5 ton over walk in", "serial": "250743740", "manufacturer": "Daikin", "model": "", "purchaseCost": 0, "currentValue": 0, "location": "Las Vegas Mini Grand Prix", "lastService": "", "nextService": "", "notes": "Air Handler- Daikin- Model -DAQ09034 Serial 250743740", "vendorOnly": false, "subAssetOnly": false}];
    var partData = [{"id": "P001", "name": "Engine Oil 10W-40 (qt) - GX200", "sku": "OIL-10W40", "qty": 24, "minQty": 6, "unit": "qt", "cost": 6.5, "location": "Kart Shop", "category": "consumable", "ordered": false, "appliesTo": "GX200"}, {"id": "P002", "name": "Engine Oil 10W-30 (qt) - GX160", "sku": "OIL-10W30", "qty": 18, "minQty": 6, "unit": "qt", "cost": 5.99, "location": "Kart Shop", "category": "consumable", "ordered": false, "appliesTo": "GX160"}, {"id": "P003", "name": "Spark Plug BP6ES (NGK)", "sku": "NGK-BP6ES", "qty": 48, "minQty": 12, "unit": "each", "cost": 3.25, "location": "Parts Cabinet A", "category": "kart", "ordered": false, "appliesTo": "GX160,GX200"}, {"id": "P004", "name": "Air Cleaner Element GX200", "sku": "AIR-GX200", "qty": 12, "minQty": 4, "unit": "each", "cost": 8.5, "location": "Parts Cabinet A", "category": "kart", "ordered": false, "appliesTo": "GX200"}, {"id": "P005", "name": "Air Cleaner Element GX160", "sku": "AIR-GX160", "qty": 12, "minQty": 4, "unit": "each", "cost": 7.25, "location": "Parts Cabinet A", "category": "kart", "ordered": false, "appliesTo": "GX160"}, {"id": "P006", "name": "Carburetor Rebuild Kit GX200", "sku": "CARB-KIT-GX200", "qty": 6, "minQty": 2, "unit": "each", "cost": 18.5, "location": "Parts Cabinet B", "category": "kart", "ordered": false, "appliesTo": "GX200"}, {"id": "P007", "name": "V-Belt Set (Sprint F-8000)", "sku": "BELT-SPT", "qty": 8, "minQty": 3, "unit": "set", "cost": 24.0, "location": "Parts Cabinet B", "category": "kart", "ordered": false, "appliesTo": "Sprint"}, {"id": "P008", "name": "Brake Pad Set (Sprint Caliper)", "sku": "BRAKE-PAD-SPT", "qty": 6, "minQty": 2, "unit": "set", "cost": 32.0, "location": "Parts Cabinet B", "category": "kart", "ordered": false, "appliesTo": "Sprint"}, {"id": "P009", "name": "DOT 5 Silicone Brake Fluid", "sku": "FLUID-DOT5", "qty": 4, "minQty": 2, "unit": "bottle", "cost": 14.99, "location": "Kart Shop", "category": "consumable", "ordered": false, "appliesTo": "All"}, {"id": "P010", "name": "D-Rubber (single)", "sku": "DRUB-SINGLE", "qty": 40, "minQty": 10, "unit": "each", "cost": 8.0, "location": "Parts Cabinet C", "category": "kart", "ordered": false, "appliesTo": "All"}, {"id": "P011", "name": "D-Rubber Full Set", "sku": "DRUB-SET", "qty": 8, "minQty": 3, "unit": "set", "cost": 45.0, "location": "Parts Cabinet C", "category": "kart", "ordered": false, "appliesTo": "All"}, {"id": "P012", "name": "Seat Belt Assembly (Sprint)", "sku": "SEATBELT-SPT", "qty": 4, "minQty": 2, "unit": "each", "cost": 28.0, "location": "Parts Cabinet C", "category": "safety", "ordered": false, "appliesTo": "Sprint"}, {"id": "P013", "name": "Inner Tube (kart)", "sku": "TUBE-KART", "qty": 20, "minQty": 6, "unit": "each", "cost": 9.5, "location": "Parts Cabinet C", "category": "kart", "ordered": false, "appliesTo": "All"}, {"id": "P014", "name": "Kart Tire (Sprint/Road)", "sku": "TIRE-STD", "qty": 16, "minQty": 8, "unit": "each", "cost": 38.0, "location": "Tire Storage", "category": "kart", "ordered": false, "appliesTo": "Sprint,Road"}, {"id": "P015", "name": "Ignition Coil GX200", "sku": "COIL-GX200", "qty": 3, "minQty": 1, "unit": "each", "cost": 22.0, "location": "Parts Cabinet A", "category": "engine", "ordered": false, "appliesTo": "GX200"}, {"id": "P016", "name": "Fuel Filter GX200", "sku": "FUEL-FILT-GX200", "qty": 12, "minQty": 4, "unit": "each", "cost": 4.5, "location": "Parts Cabinet A", "category": "consumable", "ordered": false, "appliesTo": "GX200"}, {"id": "P017", "name": "Oil Drain Plug Washer", "sku": "DRAIN-WASH", "qty": 50, "minQty": 20, "unit": "each", "cost": 0.75, "location": "Parts Cabinet A", "category": "consumable", "ordered": false, "appliesTo": "GX160,GX200,GX270"}, {"id": "P018", "name": "Valve Cover Gasket GX200", "sku": "GASKET-VC-GX200", "qty": 6, "minQty": 2, "unit": "each", "cost": 7.5, "location": "Parts Cabinet A", "category": "engine", "ordered": false, "appliesTo": "GX200"}, {"id": "P019", "name": "Waterproof Bearing Grease", "sku": "GREASE-WP", "qty": 4, "minQty": 1, "unit": "tube", "cost": 12.0, "location": "Kart Shop", "category": "consumable", "ordered": false, "appliesTo": "All"}, {"id": "P020", "name": "Master Cylinder Rebuild Kit", "sku": "MC-KIT", "qty": 3, "minQty": 1, "unit": "each", "cost": 24.5, "location": "Parts Cabinet B", "category": "kart", "ordered": false, "appliesTo": "Sprint"}];

    // Insert in batches of 50
    async function batchInsert(table, rows){
      for(var i=0;i<rows.length;i+=50){
        var batch = rows.slice(i, i+50);
        var r = await sb.from(table).upsert(batch,{onConflict:'id'});
        if(r.error) console.error('Seed error '+table+':', r.error);
      }
    }

    await batchInsert('karts', kartData);
    await batchInsert('engines', engData);
    await batchInsert('assets', assetData);
    await batchInsert('parts', partData);

    console.log("Seed complete");
  }catch(e){
    console.error("Seed failed:", e);
  }
  showLoadingOverlay(false);
}

// Wait for DOM to be fully ready
document.addEventListener('DOMContentLoaded', function(){
  resolveSession();
  buildNav();
  setTab('dashboard');
  updateBadges();
  var fabEl=document.getElementById('fab');
  if(fabEl)fabEl.addEventListener('click',fabAction);
  // Initialize Supabase
  if(typeof supabase!=='undefined'&&initSupabase()){
    loadFromDB();
  } else {
    console.log("Running offline — loading seed data into memory");
    loadSeedDataOffline();
  }
  setTimeout(function(){if(typeof showLoadingOverlay==='function')showLoadingOverlay(false);},45000);
});
// ── INSPECTION SYSTEM ─────────────────────────────────────────────────────────

var D_inspTemplates = {
  euro:   {name:"Euro Track Pre-Op",   track:"euro",   color:"#6366f1", who:"mechanic"},
  road:   {name:"Road Track Pre-Op",   track:"road",   color:"#0891b2", who:"mechanic"},
  sprint: {name:"Sprint Track Pre-Op", track:"sprint", color:"#f97316", who:"mechanic"},
  kiddie: {name:"Kiddie Track Pre-Op", track:"kiddie", color:"#22c55e", who:"mechanic"},
  'euro-op': {name:"Euro Track — Operator Walkthrough", track:null, color:"#8b5cf6", who:"operator", roles:["operator","area-lead","lead","owner","gm","agm","manager"]}
};
// Attach to D
if(!D.inspectionTemplates) D.inspectionTemplates = D_inspTemplates;

// ── CHECKLISTS (matching your MaintainX procedures) ────────────────────────
var INSP_CHECKLISTS = {
  // Euro Track — Operator Walkthrough (Level 2). Exception-based: flag only what's wrong.
  // Track-condition go/no-go check the operator runs from the podium before the track opens.
  'euro-op':[
    {id:"eop-surface",label:"Track Surface",detail:"Walk the track. Look for cracks, uneven spots, debris, oil or fluid spots, and standing water. Surface must be clear and dry before opening.",cat:"Track",type:"major"},
    {id:"eop-barriers",label:"Tire Barriers & Bricks",detail:"Confirm all tire barriers and bricks are in their correct position, secure, and properly aligned. No gaps or shifted sections.",cat:"Safety",type:"major"},
    {id:"eop-pit",label:"Pit Lane & Staging",detail:"Pit lane and staging area clear and unobstructed. Karts stage cleanly; no loose equipment in the lane.",cat:"Operations",type:"major"},
    {id:"eop-remote",label:"Remote & Podium",detail:"Power on the podium. Test remote slowdown and remote stop from the operator station — both must respond.",cat:"Safety",type:"major"},
    {id:"eop-pitloop",label:"Pit Loop / Transponder Slowdown",detail:"Verify the pit loop slows karts after they pass the transponder.",cat:"Safety",type:"major"},
    {id:"eop-fence",label:"Perimeter Fencing & Barriers",detail:"Fencing and barriers intact all the way around — no gaps, damage, or loose sections.",cat:"Safety",type:"major"},
    {id:"eop-signs",label:"Safety Signage",detail:"Height, Rules of the Road, and safety signage in place, visible, and undamaged.",cat:"Safety",type:"minor"},
    {id:"eop-ext",label:"Fire Extinguisher at Track",detail:"Extinguisher present at the track, properly placed, and charge indicator in the green.",cat:"Safety",type:"major"},
    {id:"eop-firstaid",label:"First Aid Kit",detail:"First aid kit present at the track and stocked.",cat:"Safety",type:"major"},
    {id:"eop-clean",label:"Line & Pit Cleanliness",detail:"Waiting line and pit area clear of trash and debris.",cat:"Operations",type:"minor"}
  ],
  // Euro Track (Procedure_2125743 — Go Kart Pre Operation Inspection)
  euro:[
    {id:"gk-drub",label:"D Rubbers & Bumper System",detail:"✅ PASS: All rubbers intact, no visible damage, no loose or hanging bolts. ⚠️ MINOR: 1-2 individual rubbers torn/missing but not consecutive — flag, notify mechanic. 🔴 MAJOR (OOS): 3 or more consecutive rubbers torn, missing, or severely damaged — kart must be removed from service.",cat:"Safety",type:"drubber"},
    {id:"gk-fuel",label:"Fuel System",detail:"✅ PASS: No fuel smell, no wet spots, cap seats evenly with full gasket imprint, no damage. 🔴 FAIL (OOS): Any sign of leakage from tank, cap, filter, vents, or fittings. Uneven or incomplete gasket imprint. Damaged cap or gasket.",cat:"Engine",type:"major"},
    {id:"gk-switch1",label:"On/Off Switch (Visual)",detail:"✅ PASS: Switch is firmly mounted, no movement when touched, wiring secure. 🔴 FAIL (OOS): Switch is loose, dangling, or wiring exposed.",cat:"Electrical",type:"major"},
    {id:"gk-belts",label:"Seat Belts",detail:"✅ PASS: Webbing clean with no fraying or cuts, stitching intact, buckle clicks and releases smoothly, strap adjusts and stays adjusted. 🔴 FAIL (OOS): Any fraying, cuts, or loose stitching on webbing. Buckle does not click/release properly. Strap will not adjust or hold adjustment.",cat:"Safety",type:"major"},
    {id:"gk-pads",label:"Pads",detail:"✅ PASS: All pads (seat, seat back, seat belt, roll bar, steering wheel, steering post) present, secure, and free from tears or exposed foam. ⚠️ MINOR: Minor cosmetic wear — flag for replacement at next service. 🔴 MAJOR: Pad missing or torn with exposed foam/metal — tag for repair before returning to service.",cat:"Safety",type:"minor"},
    {id:"gk-steer",label:"Steering (Visual)",detail:"✅ PASS: Both front tires pointing same direction when viewed from behind kart. 🔴 FAIL (OOS): One or both tires visibly misaligned (toe-in/toe-out visible to naked eye) — kart handles unpredictably.",cat:"Mechanical",type:"major"},
    {id:"gk-tires",label:"Tires & Wheels",detail:"✅ PASS: Wear lines visible on all tires, no visible sidewall damage, all lug nuts present and torque marks aligned. 🔴 FAIL (OOS): Wear line NOT visible (tire worn through), flat tire, sidewall damage, or missing lug nuts. If torque marks misaligned, check with torque wrench and remark — do not overtorque.",cat:"Mechanical",type:"major"},
    {id:"gk-tpsi",label:"Tire Pressure",detail:"Road/Family Track: 40-50 PSI. Euro Track: Front 23-25 PSI / Rear 25-28 PSI. Record actual reading. If low, inflate to spec before putting kart on track.",cat:"Mechanical",type:"info"},
    {id:"gk-covers",label:"Covers & Guards",detail:"✅ PASS: Steering cover, axle cover, pulley guard, fenders, and body all properly installed with no gaps, no broken edges. 🔴 FAIL (OOS): Any cover/guard missing, loose enough to contact moving parts, or with broken sharp edges that could injure riders.",cat:"Safety",type:"major"},
    {id:"gk-mounts",label:"Body Mounts",detail:"✅ PASS: All body mounts tight, body does not shift when pushed. ⚠️ MINOR: Slight looseness — tighten and recheck. 🔴 MAJOR: Body shifting significantly or mount hardware missing — tag for repair.",cat:"Safety",type:"minor"},
    {id:"gk-rope",label:"Starter Rope",detail:"✅ PASS: Rope smooth with no fraying, air intake screen clear of debris. ⚠️ MINOR: Slight fraying at tip — monitor, schedule replacement. 🔴 MAJOR: Rope significantly frayed or screen blocked — fire/overheating risk, tag for repair.",cat:"Engine",type:"minor"},
    {id:"gk-roll",label:"Roll Bar",detail:"✅ PASS: Roll bar solid, no movement when pushed firmly from any direction. 🔴 FAIL (OOS): Any looseness in the roll bar system — critical safety component.",cat:"Safety",type:"major"},
    {id:"gk-decal",label:"Safety & Warning Decals",detail:"✅ PASS: All safety and warning decals present, legible, and not peeling. ⚠️ MINOR: Any decal missing, illegible, or significantly peeling — kart can operate but schedule replacement promptly.",cat:"Safety",type:"minor"},
    {id:"gk-switch2",label:"On/Off Switch (Test Drive)",detail:"✅ PASS: Switch firmly secured, turns kart on and off reliably. 🔴 FAIL (OOS): Switch does not reliably kill the engine — safety system failure.",cat:"Electrical",type:"major"},
    {id:"gk-accel",label:"Accelerator",detail:"✅ PASS: Pedal moves smoothly through full travel, returns fully to rest position on release with no sticking. 🔴 FAIL (OOS): Pedal sticks, binds, or does not return fully — creates uncontrolled acceleration risk.",cat:"Mechanical",type:"major"},
    {id:"gk-brake",label:"Brakes",detail:"✅ PASS: Pedal firm with consistent resistance, kart slows progressively and stops within normal distance. 🔴 FAIL (OOS): Spongy or no pedal resistance, kart fails to stop properly, or brakes pull to one side.",cat:"Brakes",type:"major"},
    {id:"gk-tdsteer",label:"Steering (Test Drive)",detail:"✅ PASS: Smooth, precise movement from full left to full right with no binding, grinding, or play. 🔴 FAIL (OOS): Jerkiness, grinding noise, binding, or excessive play — indicates steering component failure.",cat:"Mechanical",type:"major"},
    {id:"gk-remote",label:"Remote Shut-Off System",detail:"✅ PASS: Pit loop activated → kart slows when passing transponder. Remote slowdown → kart slows. Remote stop → kart stops. ALL three must work. 🔴 FAIL (OOS for that kart): Any function that does not respond correctly. If ALL karts fail — cease track operation immediately and call supervisor. NEVER operate without functioning Kartrol.",cat:"Safety",type:"shutoff"}
  ],
  // Road Track (same procedure as Euro — Procedure_2125743)
  road:[
    {id:"gk-drub",label:"D Rubbers & Bumper System",detail:"✅ PASS: All rubbers intact, no visible damage, no loose or hanging bolts. ⚠️ MINOR: 1-2 individual rubbers torn/missing but not consecutive — flag, notify mechanic. 🔴 MAJOR (OOS): 3 or more consecutive rubbers torn, missing, or severely damaged — kart must be removed from service.",cat:"Safety",type:"drubber"},
    {id:"gk-fuel",label:"Fuel System",detail:"✅ PASS: No fuel smell, no wet spots, cap seats evenly with full gasket imprint, no damage. 🔴 FAIL (OOS): Any sign of leakage from tank, cap, filter, vents, or fittings. Uneven or incomplete gasket imprint. Damaged cap or gasket.",cat:"Engine",type:"major"},
    {id:"gk-switch1",label:"On/Off Switch (Visual)",detail:"✅ PASS: Switch is firmly mounted, no movement when touched, wiring secure. 🔴 FAIL (OOS): Switch is loose, dangling, or wiring exposed.",cat:"Electrical",type:"major"},
    {id:"gk-belts",label:"Seat Belts",detail:"✅ PASS: Webbing clean with no fraying or cuts, stitching intact, buckle clicks and releases smoothly, strap adjusts and stays adjusted. 🔴 FAIL (OOS): Any fraying, cuts, or loose stitching on webbing. Buckle does not click/release properly. Strap will not adjust or hold adjustment.",cat:"Safety",type:"major"},
    {id:"gk-pads",label:"Pads",detail:"✅ PASS: All pads (seat, seat back, seat belt, roll bar, steering wheel, steering post) present, secure, and free from tears or exposed foam. ⚠️ MINOR: Minor cosmetic wear — flag for replacement at next service. 🔴 MAJOR: Pad missing or torn with exposed foam/metal — tag for repair before returning to service.",cat:"Safety",type:"minor"},
    {id:"gk-steer",label:"Steering (Visual)",detail:"✅ PASS: Both front tires pointing same direction when viewed from behind kart. 🔴 FAIL (OOS): One or both tires visibly misaligned (toe-in/toe-out visible to naked eye) — kart handles unpredictably.",cat:"Mechanical",type:"major"},
    {id:"gk-tires",label:"Tires & Wheels",detail:"✅ PASS: Wear lines visible on all tires, no visible sidewall damage, all lug nuts present and torque marks aligned. 🔴 FAIL (OOS): Wear line NOT visible (tire worn through), flat tire, sidewall damage, or missing lug nuts. If torque marks misaligned, check with torque wrench and remark — do not overtorque.",cat:"Mechanical",type:"major"},
    {id:"gk-tpsi",label:"Tire Pressure",detail:"Road/Family Track: 40-50 PSI. Euro Track: Front 23-25 PSI / Rear 25-28 PSI. Record actual reading. If low, inflate to spec before putting kart on track.",cat:"Mechanical",type:"info"},
    {id:"gk-covers",label:"Covers & Guards",detail:"✅ PASS: Steering cover, axle cover, pulley guard, fenders, and body all properly installed with no gaps, no broken edges. 🔴 FAIL (OOS): Any cover/guard missing, loose enough to contact moving parts, or with broken sharp edges that could injure riders.",cat:"Safety",type:"major"},
    {id:"gk-mounts",label:"Body Mounts",detail:"✅ PASS: All body mounts tight, body does not shift when pushed. ⚠️ MINOR: Slight looseness — tighten and recheck. 🔴 MAJOR: Body shifting significantly or mount hardware missing — tag for repair.",cat:"Safety",type:"minor"},
    {id:"gk-rope",label:"Starter Rope",detail:"✅ PASS: Rope smooth with no fraying, air intake screen clear of debris. ⚠️ MINOR: Slight fraying at tip — monitor, schedule replacement. 🔴 MAJOR: Rope significantly frayed or screen blocked — fire/overheating risk, tag for repair.",cat:"Engine",type:"minor"},
    {id:"gk-roll",label:"Roll Bar",detail:"✅ PASS: Roll bar solid, no movement when pushed firmly from any direction. 🔴 FAIL (OOS): Any looseness in the roll bar system — critical safety component.",cat:"Safety",type:"major"},
    {id:"gk-decal",label:"Safety & Warning Decals",detail:"✅ PASS: All safety and warning decals present, legible, and not peeling. ⚠️ MINOR: Any decal missing, illegible, or significantly peeling — kart can operate but schedule replacement promptly.",cat:"Safety",type:"minor"},
    {id:"gk-switch2",label:"On/Off Switch (Test Drive)",detail:"✅ PASS: Switch firmly secured, turns kart on and off reliably. 🔴 FAIL (OOS): Switch does not reliably kill the engine — safety system failure.",cat:"Electrical",type:"major"},
    {id:"gk-accel",label:"Accelerator",detail:"✅ PASS: Pedal moves smoothly through full travel, returns fully to rest position on release with no sticking. 🔴 FAIL (OOS): Pedal sticks, binds, or does not return fully — creates uncontrolled acceleration risk.",cat:"Mechanical",type:"major"},
    {id:"gk-brake",label:"Brakes",detail:"✅ PASS: Pedal firm with consistent resistance, kart slows progressively and stops within normal distance. 🔴 FAIL (OOS): Spongy or no pedal resistance, kart fails to stop properly, or brakes pull to one side.",cat:"Brakes",type:"major"},
    {id:"gk-tdsteer",label:"Steering (Test Drive)",detail:"✅ PASS: Smooth, precise movement from full left to full right with no binding, grinding, or play. 🔴 FAIL (OOS): Jerkiness, grinding noise, binding, or excessive play — indicates steering component failure.",cat:"Mechanical",type:"major"},
    {id:"gk-remote",label:"Remote Shut-Off System",detail:"✅ PASS: Pit loop activated → kart slows when passing transponder. Remote slowdown → kart slows. Remote stop → kart stops. ALL three must work. 🔴 FAIL (OOS for that kart): Any function that does not respond correctly. If ALL karts fail — cease track operation immediately and call supervisor. NEVER operate without functioning Kartrol.",cat:"Safety",type:"shutoff"}
  ],
  // Sprint Track (Procedure_2125766 — Sprint Kart Pre Operation Checklist)
  sprint:[
    {id:"spr-fuel",label:"Fuel System",detail:"✅ PASS: No fuel smell, no wet spots, cap seats evenly with full gasket imprint, no damage. 🔴 FAIL (OOS): Any sign of leakage from tank, cap, filter, vents, or fittings. Uneven or incomplete gasket imprint.",cat:"Engine",type:"major"},
    {id:"spr-covers",label:"Covers & Guards",detail:"✅ PASS: Steering cover, axle cover, pulley guard, fenders, and body all properly installed with no gaps or sharp edges. 🔴 FAIL (OOS): Any cover/guard missing, loose, or with broken sharp edges.",cat:"Safety",type:"major"},
    {id:"spr-mounts",label:"Body Mounts",detail:"✅ PASS: All body mounts tight, body does not shift when pushed. ⚠️ MINOR: Slight looseness — tighten. 🔴 MAJOR: Body shifting significantly.",cat:"Safety",type:"minor"},
    {id:"spr-belts",label:"Seat Belts",detail:"✅ PASS: No fraying or cuts, stitching intact, buckle clicks/releases smoothly. 🔴 FAIL (OOS): Any fraying, loose stitching, or buckle failure.",cat:"Safety",type:"major"},
    {id:"spr-pads",label:"Pads",detail:"✅ PASS: Seat, seat back, seat belt, roll bar, steering wheel, and steering post pads present and intact. ⚠️ MINOR: Cosmetic wear. 🔴 MAJOR: Missing or torn with exposed material.",cat:"Safety",type:"minor"},
    {id:"spr-tires",label:"Tires & Wheels",detail:"✅ PASS: No visible wear/damage, all lug nuts present, wheels spin true. 🔴 FAIL (OOS): Flat tire, missing lug nuts, or visible tire damage.",cat:"Mechanical",type:"major"},
    {id:"spr-tpsi",label:"Tire Pressure (30 PSI)",detail:"Sprint Track spec: 30 PSI on all tires. Record actual reading. Inflate to spec if low.",cat:"Mechanical",type:"info"},
    {id:"spr-bolts",label:"All Nuts & Bolts",detail:"✅ PASS: No loose or missing hardware anywhere on kart. 🔴 FAIL: Any loose or missing bolt — tighten or tag for repair.",cat:"Mechanical",type:"major"},
    {id:"spr-steer",label:"Steering (Visual)",detail:"✅ PASS: Both front tires pointing same direction when viewed from behind. 🔴 FAIL (OOS): Visible misalignment.",cat:"Mechanical",type:"major"},
    {id:"spr-rope",label:"Starter Rope",detail:"✅ PASS: Rope smooth, no fraying. Air intake screen clear. 🔴 FAIL: Significantly frayed or screen blocked — fire/overheating risk.",cat:"Engine",type:"minor"},
    {id:"spr-roll",label:"Roll Bar",detail:"✅ PASS: No movement when pushed firmly. 🔴 FAIL (OOS): Any looseness — critical safety component.",cat:"Safety",type:"major"},
    {id:"spr-drub",label:"D Rubbers & Bumpers",detail:"✅ PASS: All rubbers intact, no loose/hanging bolts. ⚠️ MINOR: 1-2 individual rubbers damaged but not consecutive. 🔴 MAJOR (OOS): 3+ consecutive rubbers torn/missing.",cat:"Safety",type:"drubber"},
    {id:"spr-decal",label:"Safety Decals",detail:"✅ PASS: All decals present and legible. ⚠️ MINOR: Decal missing/illegible — schedule replacement.",cat:"Safety",type:"minor"},
    {id:"spr-switch",label:"On/Off Switch",detail:"✅ PASS: Firmly secured, turns kart on/off reliably. 🔴 FAIL (OOS): Loose, dangling, or fails to kill engine.",cat:"Electrical",type:"major"},
    {id:"spr-accel",label:"Accelerator",detail:"✅ PASS: Full travel, returns completely on release. 🔴 FAIL (OOS): Sticks or does not return fully.",cat:"Mechanical",type:"major"},
    {id:"spr-brake",label:"Brakes",detail:"✅ PASS: Firm pedal, kart stops properly within normal distance. 🔴 FAIL (OOS): Spongy pedal or inadequate stopping.",cat:"Brakes",type:"major"},
    {id:"spr-remote",label:"Remote Shut-Off System",detail:"✅ PASS: Pit loop slows karts. Remote slowdown slows kart. Remote stop stops kart. All three must work. 🔴 FAIL (OOS): Any function not responding. All karts fail → cease operation immediately.",cat:"Safety",type:"shutoff"}
  ],
  // Kiddie Track (same base as road procedure)
  kiddie:[
    {id:"gk-drub",label:"D Rubbers & Bumper System",detail:"✅ PASS: All rubbers intact, no visible damage, no loose or hanging bolts. ⚠️ MINOR: 1-2 individual rubbers torn/missing but not consecutive — flag, notify mechanic. 🔴 MAJOR (OOS): 3 or more consecutive rubbers torn, missing, or severely damaged — kart must be removed from service.",cat:"Safety",type:"drubber"},
    {id:"gk-fuel",label:"Fuel System",detail:"✅ PASS: No fuel smell, no wet spots, cap seats evenly with full gasket imprint, no damage. 🔴 FAIL (OOS): Any sign of leakage from tank, cap, filter, vents, or fittings. Uneven or incomplete gasket imprint. Damaged cap or gasket.",cat:"Engine",type:"major"},
    {id:"gk-switch1",label:"On/Off Switch (Visual)",detail:"✅ PASS: Switch is firmly mounted, no movement when touched, wiring secure. 🔴 FAIL (OOS): Switch is loose, dangling, or wiring exposed.",cat:"Electrical",type:"major"},
    {id:"gk-belts",label:"Seat Belts",detail:"✅ PASS: Webbing clean with no fraying or cuts, stitching intact, buckle clicks and releases smoothly, strap adjusts and stays adjusted. 🔴 FAIL (OOS): Any fraying, cuts, or loose stitching on webbing. Buckle does not click/release properly. Strap will not adjust or hold adjustment.",cat:"Safety",type:"major"},
    {id:"gk-pads",label:"Pads",detail:"✅ PASS: All pads (seat, seat back, seat belt, roll bar, steering wheel, steering post) present, secure, and free from tears or exposed foam. ⚠️ MINOR: Minor cosmetic wear — flag for replacement at next service. 🔴 MAJOR: Pad missing or torn with exposed foam/metal — tag for repair before returning to service.",cat:"Safety",type:"minor"},
    {id:"gk-steer",label:"Steering (Visual)",detail:"✅ PASS: Both front tires pointing same direction when viewed from behind kart. 🔴 FAIL (OOS): One or both tires visibly misaligned (toe-in/toe-out visible to naked eye) — kart handles unpredictably.",cat:"Mechanical",type:"major"},
    {id:"gk-tires",label:"Tires & Wheels",detail:"✅ PASS: Wear lines visible on all tires, no visible sidewall damage, all lug nuts present and torque marks aligned. 🔴 FAIL (OOS): Wear line NOT visible (tire worn through), flat tire, sidewall damage, or missing lug nuts. If torque marks misaligned, check with torque wrench and remark — do not overtorque.",cat:"Mechanical",type:"major"},
    {id:"gk-tpsi",label:"Tire Pressure",detail:"Road/Family Track: 40-50 PSI. Euro Track: Front 23-25 PSI / Rear 25-28 PSI. Record actual reading. If low, inflate to spec before putting kart on track.",cat:"Mechanical",type:"info"},
    {id:"gk-covers",label:"Covers & Guards",detail:"✅ PASS: Steering cover, axle cover, pulley guard, fenders, and body all properly installed with no gaps, no broken edges. 🔴 FAIL (OOS): Any cover/guard missing, loose enough to contact moving parts, or with broken sharp edges that could injure riders.",cat:"Safety",type:"major"},
    {id:"gk-mounts",label:"Body Mounts",detail:"✅ PASS: All body mounts tight, body does not shift when pushed. ⚠️ MINOR: Slight looseness — tighten and recheck. 🔴 MAJOR: Body shifting significantly or mount hardware missing — tag for repair.",cat:"Safety",type:"minor"},
    {id:"gk-rope",label:"Starter Rope",detail:"✅ PASS: Rope smooth with no fraying, air intake screen clear of debris. ⚠️ MINOR: Slight fraying at tip — monitor, schedule replacement. 🔴 MAJOR: Rope significantly frayed or screen blocked — fire/overheating risk, tag for repair.",cat:"Engine",type:"minor"},
    {id:"gk-roll",label:"Roll Bar",detail:"✅ PASS: Roll bar solid, no movement when pushed firmly from any direction. 🔴 FAIL (OOS): Any looseness in the roll bar system — critical safety component.",cat:"Safety",type:"major"},
    {id:"gk-decal",label:"Safety & Warning Decals",detail:"✅ PASS: All safety and warning decals present, legible, and not peeling. ⚠️ MINOR: Any decal missing, illegible, or significantly peeling — kart can operate but schedule replacement promptly.",cat:"Safety",type:"minor"},
    {id:"gk-switch2",label:"On/Off Switch (Test Drive)",detail:"✅ PASS: Switch firmly secured, turns kart on and off reliably. 🔴 FAIL (OOS): Switch does not reliably kill the engine — safety system failure.",cat:"Electrical",type:"major"},
    {id:"gk-accel",label:"Accelerator",detail:"✅ PASS: Pedal moves smoothly through full travel, returns fully to rest position on release with no sticking. 🔴 FAIL (OOS): Pedal sticks, binds, or does not return fully — creates uncontrolled acceleration risk.",cat:"Mechanical",type:"major"},
    {id:"gk-brake",label:"Brakes",detail:"✅ PASS: Pedal firm with consistent resistance, kart slows progressively and stops within normal distance. 🔴 FAIL (OOS): Spongy or no pedal resistance, kart fails to stop properly, or brakes pull to one side.",cat:"Brakes",type:"major"},
    {id:"gk-tdsteer",label:"Steering (Test Drive)",detail:"✅ PASS: Smooth, precise movement from full left to full right with no binding, grinding, or play. 🔴 FAIL (OOS): Jerkiness, grinding noise, binding, or excessive play — indicates steering component failure.",cat:"Mechanical",type:"major"},
    {id:"gk-remote",label:"Remote Shut-Off System",detail:"✅ PASS: Pit loop activated → kart slows when passing transponder. Remote slowdown → kart slows. Remote stop → kart stops. ALL three must work. 🔴 FAIL (OOS for that kart): Any function that does not respond correctly. If ALL karts fail — cease track operation immediately and call supervisor. NEVER operate without functioning Kartrol.",cat:"Safety",type:"shutoff"}
  ]
,
  // Tornado
  tornado:[
    {id:"t-pins",label:"Lock Pins",detail:"Check all lock pins are in place and secured.",cat:"Safety",type:"major"},
    {id:"t-air",label:"Air Compressor (100-120psi)",detail:"Check that air compressor turns on at 100psi and off at 120psi.",cat:"Mechanical",type:"major"},
    {id:"t-mainbrg",label:"Main Bearing Bolts",detail:"Check main bearing bolts are tight.",cat:"Mechanical",type:"major"},
    {id:"t-liftarm",label:"Main Lifting Arms",detail:"Check main lifting arms for cracks.",cat:"Structural",type:"major"},
    {id:"t-collar",label:"Lift Arm Pin Collars",detail:"Check main lift arm pin retaining collars are locked in place.",cat:"Safety",type:"major"},
    {id:"t-loweratt",label:"Lift Arm Lower Attachment",detail:"Check main lift arm lower attachment for cracks.",cat:"Structural",type:"major"},
    {id:"t-hydpivot",label:"Hydraulic Cylinder Pivots",detail:"Check hydraulic cylinder pivots for cracks.",cat:"Structural",type:"major"},
    {id:"t-drivegear",label:"Main Drive Gear",detail:"Check main drive gear for looseness.",cat:"Mechanical",type:"major"},
    {id:"t-drivetrain",label:"Drive Train",detail:"Check drive train for tightness.",cat:"Mechanical",type:"major"},
    {id:"t-motormnt",label:"Motor Mount",detail:"Check motor mount for cracks.",cat:"Structural",type:"major"},
    {id:"t-sweeps",label:"Sweeps",detail:"Check sweeps for cracks. Check all lock pins.",cat:"Structural",type:"major"},
    {id:"t-carpivot",label:"Car Pivots",detail:"Check each pivot for cracks. Check pivot bolts for lock nuts.",cat:"Structural",type:"major"},
    {id:"t-carshock",label:"Car Shock Mounts & Shocks",detail:"Check car shock mounts for cracks; check car shocks for proper operation.",cat:"Mechanical",type:"major"},
    {id:"t-seat",label:"Seats",detail:"Check seat pipe for cracks; check that seat halves are down and seated; check spin wheel is tight.",cat:"Safety",type:"major"},
    {id:"t-lapbar",label:"Seat Lap Bar",detail:"Check lap bar for proper operation; check lap bar foam is centered and in good shape.",cat:"Safety",type:"major"},
    {id:"t-lapbolt",label:"Lap Bar Hinge Bolts",detail:"Check lap bar hinge bolts and lock mechanism hinge bolts for looseness or broken bolts.",cat:"Safety",type:"major"},
    {id:"t-lappin",label:"Lap Bar Cylinder Pins",detail:"Check lap bar cylinder attachment pins for security and cotter pins.",cat:"Safety",type:"major"},
    {id:"t-laparm",label:"Lap Bar Arm",detail:"Check lap bar arm for cracks.",cat:"Structural",type:"major"},
    {id:"t-laptest",label:"Lap Bar Ratchet Test",detail:"Push lap bar open then push down — must ratchet down and lock at each detent.",cat:"Safety",type:"major"},
    {id:"t-airlock",label:"Air Locking System",detail:"Activate air locking system — all seats should open. Watch that manual release lever does not stick.",cat:"Safety",type:"major"},
    {id:"t-opctrl",label:"Operations Controls",detail:"Activate foot switch — ride should turn up to speed and come to smooth stop on release.",cat:"Safety",type:"major"},
    {id:"t-raise",label:"Raise Function",detail:"Activate foot switch, push ride raise button — ride raises, lowers automatically after 30 seconds.",cat:"Safety",type:"major"},
    {id:"t-estop",label:"Emergency Stop",detail:"With ride raising, push emergency stop — ride should smoothly lower and stop.",cat:"Safety",type:"major"},
    {id:"t-lube1",label:"Lubrication — Lifting Arms",detail:"Main center lifting arms — 1 shot of grease each, 2 zerks per arm.",cat:"Maintenance",type:"major"},
    {id:"t-lube2",label:"Lubrication — Hydraulic Pivots",detail:"Hydraulic cylinder pivot bushings — 1 shot, 4 bushings.",cat:"Maintenance",type:"major"},
    {id:"t-lube3",label:"Lubrication — Car/Sweep Pivot",detail:"Car to sweep pivot block — 1 shot each pivot, 2 zerks per pivot.",cat:"Maintenance",type:"major"},
    {id:"t-lube4",label:"Lubrication — Spinning Bushing",detail:"Nylon spinning bushing — light machine oil, 1-2 shots, wipe off excess.",cat:"Maintenance",type:"major"},
    {id:"t-compres",label:"Air Compressor Oil & Leaks",detail:"Check air compressor oil level; check for visual or audio air leaks; verify correct PSI.",cat:"Maintenance",type:"major"}
  ],
  // Dragon Coaster
  dragon:[
    {id:"dc-pins",label:"Pins, Wedges & Clips",detail:"Check for loose or missing pins, wedges, and clips.",cat:"Safety",type:"major"},
    {id:"dc-lapbar",label:"Lap Bars",detail:"Check lap bars for proper operation.",cat:"Safety",type:"major"},
    {id:"dc-jackstd",label:"Track Jackstand Bolts",detail:"Check track jackstand bolts for looseness.",cat:"Structural",type:"major"},
    {id:"dc-spread",label:"Track Joint Spreaders",detail:"Check track joint spreaders for cracks where welded to pipe track.",cat:"Structural",type:"major"},
    {id:"dc-axle",label:"Car Wheel Axle Bolts",detail:"Check car wheels for loose axle bolts.",cat:"Mechanical",type:"major"},
    {id:"dc-wear",label:"Car Wheel Wear",detail:"Check car wheels for excessive wear.",cat:"Mechanical",type:"major"},
    {id:"dc-lube",label:"Lubrication Schedule",detail:"Confirm lubrication schedule has been completed.",cat:"Maintenance",type:"major"},
    {id:"dc-frame",label:"Car Frames",detail:"Check car frames for cracks.",cat:"Structural",type:"major"},
    {id:"dc-dtires",label:"Drive & Brake Tires (35psi)",detail:"Check drive tires and brake tires for proper air pressure (35psi) and excessive wear.",cat:"Mechanical",type:"major"},
    {id:"dc-brake",label:"Brake Operation",detail:"Check brake for proper operation. Check that drive tires do not slip when operating ride.",cat:"Safety",type:"major"},
    {id:"dc-coupler",label:"Car Couplers",detail:"Check car couplers for loose mounting bolts and cracks.",cat:"Structural",type:"major"},
    {id:"dc-fbolt",label:"Fiberglass Body Bolts",detail:"Check fiberglass body attachment bolts for looseness or missing bolts.",cat:"Mechanical",type:"minor"},
    {id:"dc-grabbar",label:"Seat Grab Bars",detail:"Check seat grab bars for looseness.",cat:"Safety",type:"major"},
    {id:"dc-brframe",label:"Ride Brake Frame",detail:"Check ride brake frame for cracks.",cat:"Structural",type:"major"},
    {id:"dc-belts",label:"Motor V-Belts",detail:"Check main motor and kicker motor V-belts for tightness and wear.",cat:"Mechanical",type:"major"},
    {id:"dc-motfrm",label:"Motor Frames",detail:"Check main motor and kicker motor frame for cracks.",cat:"Structural",type:"major"},
    {id:"dc-gearbox",label:"Gear Box",detail:"Check gear boxes for leaks. Check gear box oil level if leaks are showing.",cat:"Mechanical",type:"major"},
    {id:"dc-train",label:"Train Start & Acceleration",detail:"Verify train starts smoothly and accelerates to full speed before contacting up ramp kicker motor.",cat:"Mechanical",type:"major"},
    {id:"dc-lbmnt",label:"Lap Bar Mounting",detail:"Check lap bar mounting for security. Check seat liner for security.",cat:"Safety",type:"major"},
    {id:"dc-lbbolt",label:"Lap Bar Hinge Bolts",detail:"Check lap bar hinge bolts and lock mechanism hinge bolts for looseness or broken bolts.",cat:"Safety",type:"major"},
    {id:"dc-lbpin",label:"Lap Bar Cylinder Pins",detail:"Check lap bar air cylinder attachment pins for security and cotter pins.",cat:"Safety",type:"major"},
    {id:"dc-lbarm",label:"Lap Bar Arm",detail:"Check lap bar arm for cracks.",cat:"Structural",type:"major"}
  ],
  // Fun Slide
  slide:[
    {id:"fs-speed",label:"Slide Speed Agreement",detail:"Understand: if rider gets stuck or has to push, spray Pledge on humps only (moving downward, 6 inches past each hump). Over-spraying is a safety hazard. Confirm you understand.",cat:"Safety",type:"major"},
    {id:"fs-purple",label:"Purple Slide Speed",detail:"Test speed of purple slide — spray Pledge if needed.",cat:"Safety",type:"major"},
    {id:"fs-pink",label:"Pink Slide Speed",detail:"Test speed of pink slide — spray Pledge if needed.",cat:"Safety",type:"major"},
    {id:"fs-green",label:"Green Slide Speed",detail:"Test speed of green slide — spray Pledge if needed.",cat:"Safety",type:"major"},
    {id:"fs-pins",label:"Pins & Snap Keys",detail:"Ensure all pins and snap keys are in proper placement and good condition.",cat:"Safety",type:"major"},
    {id:"fs-steps",label:"Steps & Welds",detail:"Walk the steps — check for damage or cracks in the welding.",cat:"Structural",type:"major"},
    {id:"fs-lights",label:"Ride Lights",detail:"Turn on lights, wait 15 seconds, turn back off. Verify all work.",cat:"Electrical",type:"minor"},
    {id:"fs-jbox",label:"Junction Box Panels",detail:"Ensure all panels on the junction box are properly closed.",cat:"Electrical",type:"major"},
    {id:"fs-mats",label:"Slide Mats Count",detail:"Inspect slide mats for large holes. Record number of usable mats in the mat box.",cat:"Equipment",type:"record",count:true},
    {id:"fs-hrail",label:"Handrails",detail:"Ensure handrails are properly in place and safe. If heat protection is damaged, submit WO.",cat:"Safety",type:"major"},
    {id:"fs-divider",label:"Top Divider Handrails",detail:"Ensure the three handrails dividing slides at the top are properly positioned and safe.",cat:"Safety",type:"major"},
    {id:"fs-breaker",label:"Breaker",detail:"Check slide breaker is ON. If off, do not reset — contact mechanical team.",cat:"Electrical",type:"major"},
    {id:"fs-banners",label:"Shade Banners",detail:"Ensure shade banners are free from damage and properly secured with zip ties.",cat:"Safety",type:"minor"},
    {id:"fs-purple2",label:"Purple Slide Surface",detail:"Check purple slide is free from cracks or damage.",cat:"Structural",type:"major"},
    {id:"fs-pink2",label:"Pink Slide Surface",detail:"Check pink slide is free from cracks or damage.",cat:"Structural",type:"major"},
    {id:"fs-green2",label:"Green Slide Surface",detail:"Check green slide is free from cracks or damage.",cat:"Structural",type:"major"}
  ]
};

// ── RESPONSE LABELS ───────────────────────────────────────────────────────────
var RESP_LABELS = {
  avail:   [{v:"yes",        lbl:"Yes - In Operation", cls:"ok", color:"#22c55e"}, {v:"no", lbl:"No - Out of Service", cls:"fail",color:"#ef4444"}, {v:"na", lbl:"N/A", cls:"warn",color:"#94a3b8"}],
  info:    [{v:"recorded",   lbl:"Recorded",    cls:"ok",  color:"#22c55e"}, {v:"not-done",  lbl:"Not Done",    cls:"fail",color:"#ef4444"}],
  major:   [{v:"sat",        lbl:"Satisfactory",cls:"ok",  color:"#22c55e"}, {v:"deficiency",lbl:"Deficiency Found",cls:"fail",color:"#ef4444"}],
  either:  [{v:"sat",        lbl:"Satisfactory",cls:"ok",  color:"#22c55e"}, {v:"monitor",   lbl:"Monitor",     cls:"warn",color:"#f59e0b"}, {v:"deficiency",lbl:"Deficiency Found",cls:"fail",color:"#ef4444"}],
  drubber: [{v:"sat",        lbl:"Satisfactory",cls:"ok",  color:"#22c55e"}, {v:"minor-dr",  lbl:"Minor Damage (runs — WO created)",cls:"warn",color:"#f59e0b"}, {v:"deficiency",lbl:"3+ Consec. Cut Through — OOS",cls:"fail",color:"#ef4444"}],
  shutoff: [{v:"sat",        lbl:"Satisfactory",cls:"ok",  color:"#22c55e"}, {v:"sys-def",   lbl:"System Deficiency — Whole Track OOS",cls:"fail",color:"#7c3aed"}, {v:"deficiency",lbl:"Individual Kart Deficiency",cls:"fail",color:"#ef4444"}]
};

var curInspId = null;
var rptLegalTrack = "road";

// ── HELPERS ───────────────────────────────────────────────────────────────────


function openImgViewer(src){
  if(!src) return;
  var ov=document.getElementById('imgViewerOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='imgViewerOverlay'; document.body.appendChild(ov); }
  ov.setAttribute('style','position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;padding:16px;cursor:zoom-out');
  ov.innerHTML='';
  var img=document.createElement('img'); img.src=src;
  img.setAttribute('style','max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.6)');
  ov.appendChild(img);
  var hint=document.createElement('div'); hint.textContent='Tap anywhere to close';
  hint.setAttribute('style','position:absolute;bottom:18px;left:0;right:0;text-align:center;color:rgba(255,255,255,.7);font-size:12px;pointer-events:none');
  ov.appendChild(hint);
  ov.onclick=function(){ ov.style.display='none'; ov.innerHTML=''; };
  ov.style.display='flex';
}
function getRoadState(insp){
  if(!insp.roadState) insp.roadState={kartAvail:{},hours:{},flags:{},collapsed:{s1:false,s2:false,s3:false,s4:false},signed:false,signedBy:"",signedAt:""};
  return insp.roadState;
}


// ── INSPECTIONS TAB ───────────────────────────────────────────────────────────








// ── SIGNATURE CANVAS ──────────────────────────────────────────────────────────
var sigDrawing=false, sigCtx=null, sigHasData=false;
function initSigCanvas(){
  var canvas=document.getElementById("sig-canvas");if(!canvas)return;
  var rect=canvas.getBoundingClientRect();
  canvas.width=Math.round(rect.width*2);canvas.height=Math.round(rect.height*2);
  sigCtx=canvas.getContext("2d");sigCtx.scale(2,2);
  sigCtx.strokeStyle="#1e1b4b";sigCtx.lineWidth=2.5;sigCtx.lineCap="round";sigCtx.lineJoin="round";
  sigHasData=false;
  function getPos(e){var r=canvas.getBoundingClientRect();var src=e.touches?e.touches[0]:e;return{x:src.clientX-r.left,y:src.clientY-r.top};}
  function start(e){e.preventDefault();sigDrawing=true;var p=getPos(e);sigCtx.beginPath();sigCtx.moveTo(p.x,p.y);}
  function move(e){e.preventDefault();if(!sigDrawing)return;var p=getPos(e);sigCtx.lineTo(p.x,p.y);sigCtx.stroke();sigHasData=true;}
  function end(e){e.preventDefault();sigDrawing=false;}
  canvas.addEventListener("mousedown",start);canvas.addEventListener("mousemove",move);canvas.addEventListener("mouseup",end);
  canvas.addEventListener("touchstart",start,{passive:false});canvas.addEventListener("touchmove",move,{passive:false});canvas.addEventListener("touchend",end,{passive:false});
}
function clearSigCanvas(){
  var canvas=document.getElementById("sig-canvas");if(!canvas||!sigCtx)return;
  var r=canvas.getBoundingClientRect();sigCtx.clearRect(0,0,r.width,r.height);sigHasData=false;
}
function getSigDataURL(){
  var canvas=document.getElementById("sig-canvas");if(!canvas||!sigHasData)return null;
  return canvas.toDataURL("image/png");
}

// ── RENDER INSPECTION SHEET ───────────────────────────────────────────────────


// ── INSPECTION ACTIONS ────────────────────────────────────────────────────────


function setKartUse(btn,on){
  var kid=btn.dataset.kid, inspId=btn.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;
  var rs=getRoadState(insp);
  if(!rs.inUse)rs.inUse={};
  if(on)rs.inUse[kid]=true; else delete rs.inUse[kid];
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();
}
function markUnavailBtn(btn){
  var kid=btn.dataset.kid, inspId=btn.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;
  var reasons=["In shop for maintenance","Kart not found"];
  var h='<div style="display:flex;flex-direction:column;gap:6px">';
  for(var i=0;i<reasons.length;i++){
    h+='<button data-kid="'+kid+'" data-reason="'+reasons[i]+'" data-insp="'+inspId+'" onclick="confirmMarkUnavail(this)" style="background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left">'+reasons[i]+'</button>';
  }
  h+='<button data-kid="'+kid+'" data-insp="'+inspId+'" onclick="markUnavailOther(this)" style="background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left">Other… (type a reason)</button>';
  h+='</div>';
  document.getElementById("mm-title").textContent="Mark Kart Unavailable";
  document.getElementById("mm-sub").textContent="Select reason";
  document.getElementById("mm-body").innerHTML=h;
  openM("miniModal");
}
function confirmMarkUnavail(btn){
  var kid=btn.dataset.kid, reason=btn.dataset.reason, inspId=btn.dataset.insp;
  closeM("miniModal");
  var insp=getInspById(inspId);if(!insp)return;
  var rs=getRoadState(insp);
  rs.kartAvail[kid]={avail:false,reason:reason};
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();
}
function markUnavailOther(btn){
  var kid=btn.dataset.kid, inspId=btn.dataset.insp;
  var r=prompt("Why is this kart unavailable?");
  if(r===null)return;
  r=String(r).trim();
  if(!r){alert("A reason is required for Other.");return;}
  closeM("miniModal");
  var insp=getInspById(inspId);if(!insp)return;
  var rs=getRoadState(insp);
  rs.kartAvail[kid]={avail:false,reason:"Other: "+r};
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();
}
function clearUnavail(btn){
  var kid=btn.dataset.kid, inspId=btn.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;
  var rs=getRoadState(insp);
  delete rs.kartAvail[kid];
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();
}
function logHours(inp){
  var kid=inp.dataset.kid, inspId=inp.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;
  var rs=getRoadState(insp);
  if(!rs.hours) rs.hours={};
  rs.hours[kid]={val:inp.value,na:false};
}

function updateFlagNote(ta){
  var iid=ta.dataset.iid, fi=parseInt(ta.dataset.fi), inspId=ta.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;
  var rs=getRoadState(insp);
  if(rs.flags[iid]&&rs.flags[iid][fi]) rs.flags[iid][fi].notes=ta.value;
}
// Remove or edit a flagged kart before the pre-op is submitted.
function removeInspFlag(iid, fi, inspId){
  var insp=getInspById(inspId);if(!insp)return;var rs=getRoadState(insp);
  if(!rs.flags[iid]||!rs.flags[iid][fi])return;
  var kid=rs.flags[iid][fi].kartId;
  rs.flags[iid].splice(fi,1); if(!rs.flags[iid].length) delete rs.flags[iid];
  var track=(D.inspectionTemplates[insp.templateKey]||{}).track;
  if(kid&&kid!=='__system__'&&kid!=='__ride__') _reconcileKartStatus(rs,track,kid);
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();if(typeof renderFleet==='function')renderFleet();updateBadges();
}
function editInspFlagKart(sel){
  var iid=sel.dataset.iid, fi=parseInt(sel.dataset.fi), inspId=sel.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;var rs=getRoadState(insp);
  if(!rs.flags[iid]||!rs.flags[iid][fi])return;
  var track=(D.inspectionTemplates[insp.templateKey]||{}).track;
  var oldKid=rs.flags[iid][fi].kartId, newKid=sel.value;
  rs.flags[iid][fi].kartId=newKid;
  if(oldKid&&oldKid!=='__system__'&&oldKid!=='__ride__')_reconcileKartStatus(rs,track,oldKid);
  _reconcileKartStatus(rs,track,newKid);
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();if(typeof renderFleet==='function')renderFleet();updateBadges();
}
function editInspFlagResp(sel){
  var iid=sel.dataset.iid, fi=parseInt(sel.dataset.fi), inspId=sel.dataset.insp;
  var insp=getInspById(inspId);if(!insp)return;var rs=getRoadState(insp);
  if(!rs.flags[iid]||!rs.flags[iid][fi])return;
  rs.flags[iid][fi].resp=sel.value;
  var track=(D.inspectionTemplates[insp.templateKey]||{}).track, kid=rs.flags[iid][fi].kartId;
  if(kid&&kid!=='__system__'&&kid!=='__ride__')_reconcileKartStatus(rs,track,kid);
  if(typeof saveInspection==='function')saveInspection(insp);
  renderInspSheet();if(typeof renderFleet==='function')renderFleet();updateBadges();
}
function _imgToDataURL(file, cb){
  var reader=new FileReader();
  reader.onload=function(e){
    var img=new Image();
    img.onload=function(){
      var max=1280,w=img.width,h=img.height;
      if(w>max||h>max){var s=Math.min(max/w,max/h);w=Math.round(w*s);h=Math.round(h*s);}
      try{var c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);cb(c.toDataURL('image/jpeg',0.7));}
      catch(err){cb(e.target.result);}
    };
    img.onerror=function(){cb(e.target.result);};
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
// Inspection photos -> Supabase Storage (keeps the heavy image out of the row).
// Shrinks the photo, uploads it, and returns {url, path}. If Storage isn't set
// up yet or the upload fails, it falls back to an embedded image so taking a
// photo never breaks. path is the storage file (used later to delete it).
function inspPhotoUpload(file, cb){
  function _fallback(dataUrl){ cb({url:dataUrl, path:null}); }
  var reader=new FileReader();
  reader.onload=function(e){
    var img=new Image();
    img.onload=function(){
      var max=1280,w=img.width,h=img.height;
      if(w>max||h>max){var s=Math.min(max/w,max/h);w=Math.round(w*s);h=Math.round(h*s);}
      var c;
      try{c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);}
      catch(err){ _fallback(e.target.result); return; }
      var dataUrl; try{dataUrl=c.toDataURL('image/jpeg',0.7);}catch(err){ _fallback(e.target.result); return; }
      if(typeof sb==='undefined'||!sb||!sb.storage){ _fallback(dataUrl); return; }
      try{
        c.toBlob(function(blob){
          if(!blob){ _fallback(dataUrl); return; }
          var path=(typeof nid==='function'?nid('insp'):('insp'+Date.now()))+'.jpg';
          sb.storage.from('inspection-photos').upload(path, blob, {contentType:'image/jpeg', upsert:true}).then(function(res){
            if(res&&res.error){ _fallback(dataUrl); return; }
            var pub=sb.storage.from('inspection-photos').getPublicUrl(path);
            var url=pub&&pub.data&&pub.data.publicUrl;
            if(!url){ _fallback(dataUrl); return; }
            cb({url:url, path:path});
          }).catch(function(){ _fallback(dataUrl); });
        }, 'image/jpeg', 0.7);
      }catch(err){ _fallback(dataUrl); }
    };
    img.onerror=function(){ _fallback(e.target.result); };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
function inspPhotoDelete(path){
  if(!path)return;
  if(typeof sb==='undefined'||!sb||!sb.storage)return;
  try{ sb.storage.from('inspection-photos').remove([path]); }catch(e){}
}
// ---- One-time migration: move OLD embedded inspection photos into Storage ----
// Walks records for any "photo" field holding an embedded image, shrinks it,
// uploads it, and swaps in a link + photoPath. Signatures are never touched.
// Safe to re-run; only acts on photos that are still embedded.
function _collectInspPhotoTasks(node, tasks){
  if(!node||typeof node!=='object')return;
  if(Array.isArray(node)){ for(var i=0;i<node.length;i++)_collectInspPhotoTasks(node[i],tasks); return; }
  for(var k in node){ if(!Object.prototype.hasOwnProperty.call(node,k))continue;
    var v=node[k];
    if(k==='photo'&&typeof v==='string'&&v.indexOf('data:image')===0){
      (function(obj){ tasks.push({dataUrl:obj.photo, apply:function(info){ obj.photo=info.url; obj.photoPath=info.path; }}); })(node);
    } else if(v&&typeof v==='object'){ _collectInspPhotoTasks(v,tasks); }
  }
}
function _inspEmbeddedPhotoCount(){
  var n=0,L=(typeof D!=='undefined'&&D.inspections)?D.inspections:[];
  for(var i=0;i<L.length;i++){ var t=[]; _collectInspPhotoTasks(L[i],t); n+=t.length; }
  return n;
}
function _dataUrlToShrunkBlob(dataUrl, cb){
  try{
    var img=new Image();
    img.onload=function(){
      var max=1280,w=img.width,h=img.height;
      if(w>max||h>max){var s=Math.min(max/w,max/h);w=Math.round(w*s);h=Math.round(h*s);}
      try{var c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);c.toBlob(function(b){cb(b);},'image/jpeg',0.7);}
      catch(e){cb(null);}
    };
    img.onerror=function(){cb(null);};
    img.src=dataUrl;
  }catch(e){cb(null);}
}
function _uploadInspBlob(blob, cb){
  if(!blob){cb(null);return;}
  if(typeof sb==='undefined'||!sb||!sb.storage){cb(null);return;}
  var path=(typeof nid==='function'?nid('insp'):('insp'+Date.now()))+'.jpg';
  try{
    sb.storage.from('inspection-photos').upload(path, blob, {contentType:'image/jpeg', upsert:true}).then(function(res){
      if(res&&res.error){cb(null);return;}
      var pub=sb.storage.from('inspection-photos').getPublicUrl(path);
      var url=pub&&pub.data&&pub.data.publicUrl;
      cb(url?{url:url,path:path}:null);
    }).catch(function(){cb(null);});
  }catch(e){cb(null);}
}
async function migrateInspPhotos(){
  if(typeof canApproveInspection==='function'&&!canApproveInspection()){alert('Only an owner, GM, AGM, or manager can run this.');return;}
  if(typeof sb==='undefined'||!sb||!sb.storage){alert('Storage is not connected. Run the inspection-photos bucket SQL first.');return;}
  var recs=[],L=(D.inspections||[]);
  for(var i=0;i<L.length;i++){ var t=[]; _collectInspPhotoTasks(L[i],t); if(t.length)recs.push(L[i]); }
  if(!recs.length){alert('No embedded inspection photos left to move. All done.');return;}
  var total=_inspEmbeddedPhotoCount();
  if(!confirm('Move '+total+' photo(s) from '+recs.length+' inspection record(s) into storage? Runs once, can be safely re-run.'))return;
  var done=0,moved=0,failed=0;
  function prog(){var e=document.getElementById('migInspProg');if(e)e.textContent='Moving photos\u2026 '+done+' of '+total;}
  prog();
  for(var ri=0; ri<recs.length; ri++){
    var insp=recs[ri];
    var tasks=[]; _collectInspPhotoTasks(insp,tasks);
    for(var ti=0; ti<tasks.length; ti++){
      var task=tasks[ti];
      var info=await new Promise(function(resolve){
        _dataUrlToShrunkBlob(task.dataUrl, function(blob){
          if(!blob){resolve(null);return;}
          _uploadInspBlob(blob, function(r){resolve(r);});
        });
      });
      done++;
      if(info){ task.apply(info); moved++; } else { failed++; }
      prog();
    }
    try{ if(typeof dbSave==='function') await dbSave('inspections', insp); else if(typeof saveInspection==='function') saveInspection(insp); }catch(e){}
  }
  alert('Done. Moved '+moved+' photo(s)'+(failed?(', '+failed+' could not be moved \u2014 left in place'):'')+'.');
  if(typeof renderInspections==='function')renderInspections();
}
// ---- 7-day auto-purge of ride-key photos (opening/closing "as received/returned") ----
// Deletes those photos once they're older than 7 days, UNLESS that day's closing
// checklist flagged a return problem. Flag/defect photos are never touched here.
function _daysAgoStr(n){ var d=new Date(); d.setDate(d.getDate()-n); try{return d.toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});}catch(e){return d.toISOString().slice(0,10);} }
function _inspPathFromUrl(u){ if(!u||typeof u!=='string')return null; var m=u.indexOf('/inspection-photos/'); if(m<0)return null; return u.slice(m+'/inspection-photos/'.length).split('?')[0]; }
function purgeOldRideKeyPhotos(){
  if(typeof sb==='undefined'||!sb)return;
  if(typeof canApproveInspection==='function'&&!canApproveInspection())return; // managers only
  var L=D.inspections||[], cutoff=_daysAgoStr(7);
  // which dates are protected (closing checklist flagged a return problem)
  var protect={};
  for(var i=0;i<L.length;i++){var x=L[i];if(x&&x.templateKey==='closing-outside'&&x.returnProblem===true&&x.date)protect[x.date]=true;}
  var changed=[];
  for(var i=0;i<L.length;i++){
    var insp=L[i];
    if(!insp||(insp.templateKey!=='opening-outside'&&insp.templateKey!=='closing-outside'))continue;
    if(!insp.date||insp.date>cutoff)continue;   // newer than 7 days -> keep
    if(protect[insp.date])continue;             // that day had a documented return problem -> keep
    var res=insp.results||{},touched=false;
    for(var k in res){ if(!Object.prototype.hasOwnProperty.call(res,k))continue; var r=res[k];
      if(r&&(r.photoPath||r.photo)){
        var path=r.photoPath||_inspPathFromUrl(r.photo);
        if(path)inspPhotoDelete(path);
        r.photo=null; r.photoPath=null; r.photoPurged=true; touched=true;
      }
    }
    if(touched)changed.push(insp);
  }
  for(var c=0;c<changed.length;c++){ if(typeof saveInspection==='function')saveInspection(changed[c]); }
  if(changed.length)console.log('Ride-key photo purge: cleared '+changed.length+' record(s) older than 7 days');
}
function woAddPhotoBtn(input){
  var woId=input.dataset.wid; var file=input.files&&input.files[0]; if(!file)return;
  _imgToDataURL(file, function(dataUrl){
    for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===woId){var w=D.workOrders[i];w.photos=w.photos||[];w.photos.push(dataUrl);if(typeof saveWO!=='undefined')saveWO(w);if(typeof woLog!=='undefined')woLog(w,'Photo added');break;}
    if(typeof openWOD==='function')openWOD(woId);
  });
}
function woRemovePhotoBtn(btn){
  if(!confirm('Remove this photo?'))return;
  var woId=btn.dataset.wid, idx=Number(btn.dataset.idx);
  for(var i=0;i<D.workOrders.length;i++)if(D.workOrders[i].id===woId){var w=D.workOrders[i];if(w.photos&&w.photos.length>idx){w.photos.splice(idx,1);if(typeof saveWO!=='undefined')saveWO(w);}break;}
  if(typeof openWOD==='function')openWOD(woId);
}
function inspFlagPhoto(input, iid, fi, inspId){
  var file=input.files&&input.files[0]; if(!file)return;
  inspPhotoUpload(file, function(info){
    var insp=getInspById(inspId); if(!insp)return;
    var rs=getRoadState(insp);
    if(rs.flags[iid]&&rs.flags[iid][fi]){ var prev=rs.flags[iid][fi].photoPath; if(prev)inspPhotoDelete(prev); rs.flags[iid][fi].photo=info.url; rs.flags[iid][fi].photoPath=info.path||null; saveInspection(insp); renderInspSheet(); }
  });
}
function inspRemoveFlagPhoto(iid, fi, inspId){
  if(!confirm('Remove this photo?'))return;
  var insp=getInspById(inspId); if(!insp)return;
  var rs=getRoadState(insp);
  if(rs.flags[iid]&&rs.flags[iid][fi]){ if(rs.flags[iid][fi].photoPath)inspPhotoDelete(rs.flags[iid][fi].photoPath); rs.flags[iid][fi].photo=null; rs.flags[iid][fi].photoPath=null; saveInspection(insp); renderInspSheet(); }
}
function _flagPhotoHtml(f, iid, fi, inspId){
  var h='<div style="margin-top:6px">';
  if(f&&f.photo){
    h+='<div style="display:flex;align-items:flex-start;gap:8px"><img src="'+f.photo+'" onclick="openImgViewer(this.src)" style="max-width:120px;max-height:120px;border-radius:7px;border:1px solid var(--border);cursor:zoom-in"/><button onclick="inspRemoveFlagPhoto(\''+iid+'\','+fi+',\''+inspId+'\')" style="background:#fff;border:1.5px solid #dc2626;color:#dc2626;border-radius:7px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">Remove photo</button></div>';
  } else {
    h+='<label style="display:inline-flex;align-items:center;gap:5px;background:#fff;border:1.5px solid var(--accent);color:var(--accent);border-radius:7px;padding:5px 11px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">\uD83D\uDCF7 Add photo<input type="file" accept="image/*" capture="environment" onchange="inspFlagPhoto(this,\''+iid+'\','+fi+',\''+inspId+'\')" style="display:none"/></label>';
  }
  return h+'</div>';
}



// ── WO BUILDER v2 — SWO Library + Symptom Trees ──────────────────────────────
var wobMode = 'know';
var wobAssetId = null;
var wobAccumDiagMins = 0;
var wobSymptomTree = null;
var wobStepIdx = 0;
var wobSelectedSWO = null;



function wobSetMode(btn){
  wobMode = btn.dataset.m;
  wobAccumDiagMins = 0; wobSymptomTree = null; wobStepIdx = 0; wobSelectedSWO = null;
  document.querySelectorAll('#wob-mode-btns button').forEach(function(b){
    var on = b.dataset.m===wobMode;
    b.style.background = on?'var(--accent)':'var(--card)';
    b.style.color = on?'#fff':'var(--muted)';
  });
  var cb = document.getElementById('wob-create-btn');
  if(cb) cb.style.display = wobMode==='symptom'?'none':'';
  renderWOBuilder();
}





// ── KNOW THE ISSUE: SWO Library ───────────────────────────────────────────────
function wobRenderSWOLibrary(){
  var assetTrack = wobGetAssetTrack();
  var _kind = (typeof wobAssetKind==='function')?wobAssetKind():null;
  var cats = {};
  var _q=(window._wobSWOQuery||'').toLowerCase().trim();
  for(var i=0;i<SWO_LIBRARY.length;i++){
    var swo = SWO_LIBRARY[i];
    if(assetTrack){ var _m=(_kind==='kart')?(swo.assets.indexOf('all')>=0||swo.assets.indexOf(assetTrack)>=0):(swo.assets.indexOf(assetTrack)>=0); if(!_m) continue; }
    if(wobSWOKindFilter!=='all' && swoKind(swo)!==wobSWOKindFilter) continue;
    if(_q){var _hay=((swo.title||'')+' '+(swo.cat||'')).toLowerCase(); if(_hay.indexOf(_q)<0) continue;}
    if(!cats[swo.cat]) cats[swo.cat]=[];
    cats[swo.cat].push(swo);
  }
  function _kb(k,lbl){var on=wobSWOKindFilter===k;return '<button onclick="wobSetSWOKind(\''+k+'\')" style="flex:1;padding:6px 0;border:1.5px solid '+(on?'var(--accent)':'var(--border)')+';border-radius:8px;background:'+(on?'var(--accent)':'var(--card)')+';color:'+(on?'#fff':'var(--text)')+';font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">'+lbl+'</button>';}
  var h='<div style="display:flex;gap:6px;margin-bottom:8px">'+_kb('all','All')+_kb('pm','PM')+_kb('reactive','Reactive')+'</div>';
  h+='<input id="wob-swo-search" value="'+escA(window._wobSWOQuery||'')+'" oninput="wobSWOSearch(this)" placeholder="Search repairs" style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:9px;padding:9px 11px;font-size:16px;font-family:inherit;background:var(--bg);margin-bottom:8px"/>';
  if(!Object.keys(cats).length){
    h+='<div style="font-size:12px;color:var(--muted);padding:8px 0 10px;text-align:center">No standard repairs match. Use Other below.</div>';
  } else {
    h+='<div style="font-size:11px;color:var(--muted);margin-bottom:6px">Tap to select, then Create Work Order. Tap the PM/Reactive tag to reclassify.</div>';
    for(var cat in cats){
      h+='<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;margin:8px 0 4px">'+esc(cat)+'</div>';
      h+='<div style="display:flex;flex-direction:column;gap:3px">';
      var swos=cats[cat];
      for(var i=0;i<swos.length;i++){
        var swo=swos[i];
        var sel=wobSelectedSWO&&wobSelectedSWO.id===swo.id;
        var partsCost=swo.parts.reduce(function(a,p){return a+(p.cost||0)*(p.qty||1);},0);
        var laborCost=Math.round((swo.mins/60)*DIAG_LABOR_RATE*100)/100;
        var kind=swoKind(swo); var kc=kind==='pm'?'#0891b2':'#8b5cf6';
        h+='<div style="display:flex;align-items:stretch;gap:4px">';
        h+='<button data-swoid="'+swo.id+'" onclick="wobSelectSWO(this)" style="flex:1;display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1.5px solid '+(sel?'var(--accent)':'var(--border)')+';border-radius:9px;background:'+(sel?'var(--accent)':'var(--card)')+';color:'+(sel?'#fff':'var(--text)')+';cursor:pointer;font-family:inherit;text-align:left">';
        h+='<span style="font-size:13px;font-weight:600">'+esc(swo.title)+'</span>';
        h+='<div style="text-align:right;flex-shrink:0;margin-left:10px"><div style="font-size:11px;font-family:monospace">$'+(partsCost+laborCost).toFixed(0)+'</div><div style="font-size:9px;opacity:.8">'+swo.mins+'min</div></div></button>';
        h+='<button onclick="wobToggleSWOKind(\''+swo.id+'\')" title="Switch PM / Reactive" style="flex-shrink:0;width:62px;border:1.5px solid '+kc+';border-radius:9px;background:'+kc+'18;color:'+kc+';font-size:10px;font-weight:800;cursor:pointer;font-family:inherit">'+(kind==='pm'?'PM':'Reactive')+'</button>';
        h+='</div>';
      }
      h+='</div>';
    }
  }
  h+='<button onclick="closeM(\'woBuildModal\');openBlankWO(wobAssetId)" style="display:flex;align-items:center;gap:10px;padding:11px 13px;border:1.5px dashed var(--border);border-radius:10px;background:var(--card);cursor:pointer;font-family:inherit;text-align:left;width:100%;margin-top:10px"><span style="font-size:20px">+</span><div><div style="font-size:13px;font-weight:700">Other / custom repair</div><div style="font-size:10px;color:var(--muted)">Start a blank work order instead</div></div></button>';
  return h;
}

function wobSelectSWO(btn){
  var swoId = btn.dataset.swoid;
  wobSelectedSWO = SWO_LIBRARY.filter(function(s){return s.id===swoId;})[0]||null;
  renderWOBuilder();
}
function wobSWOSearch(inp){ window._wobSWOQuery=inp.value; renderWOBuilder(); }



// ── SYMPTOM CHECKER: Sequential diagnostic steps ──────────────────────────────








// ── PM SCHEDULE ───────────────────────────────────────────────────────────────


// ── CREATE WO ─────────────────────────────────────────────────────────────────
function wobCreate(){
  if(!wobSelectedSWO&&wobMode!=='symptom'){alert('Select a work order type.');return;}
  var swo = wobSelectedSWO;
  if(!swo){ closeM('woBuildModal'); return; }

  var assetEl=document.getElementById('wob-asset');
  var assetId=assetEl?assetEl.value:(wobAssetId||'');
  var kart=null; var allK=allKarts();
  for(var i=0;i<allK.length;i++) if(allK[i].id===assetId){kart=allK[i];break;}
  var _wr=resolveAssetRef(assetId),_wkid=null; if(_wr){ assetId=_wr.canonical; if(_wr.kind==='kart')_wkid=_wr.kartId; }

  var assignEl=document.getElementById('wob-assign');
  var dueEl=document.getElementById('wob-due');
  var totalDiagMins = wobAccumDiagMins;
  var totalEstMins = totalDiagMins + swo.mins;
  var partsCost=swo.parts.reduce(function(a,p){return a+(p.cost||0)*(p.qty||1);},0);
  var laborCost=Math.round((totalEstMins/60)*DIAG_LABOR_RATE*100)/100;
  var totalCost=Math.round((partsCost+laborCost)*100)/100;

  var title=swo.title+(kart?' — '+kartLabel(kart):'');
  var desc=swo.title;
  if(totalDiagMins>0) desc+=' (after '+totalDiagMins+' min diagnostic)';
  desc+='. Parts: $'+partsCost.toFixed(2)+'. Labor est: '+totalEstMins+' min.';

  var wo={
    id:nid('WO'), title:title, status:'open',
    priority:swo.cat==='Safety'?'critical':'medium',
    type:swo.cat.indexOf('PM')>=0?'pm':'corrective',
    assetId:assetId, kartId:_wkid, engineId:null,
    assignee:assignEl?assignEl.value.trim():'',
    dueDate:dueEl?dueEl.value:today(),
    created:today(), description:desc,
    notes:['Created by '+currentUser.name+'. SWO: '+swo.id+'. Est: '+totalEstMins+' min. Total: $'+totalCost.toFixed(2)+'.'],
    // structured parts the rest of the app reads (PARTS list + Parts cost line).
    // cost (qty x unit) is the line total. Labor accrues when logged; the up-front
    // estimate stays in the description/notes, not lumped into Other cost.
    partsUsed:(swo.parts||[]).map(function(p){return {name:p.n, qty:(p.qty||1), unit:'', cost:Math.round((p.cost||0)*(p.qty||1)*100)/100};}),
    partsOrdered:(swo.parts||[]).map(function(p){return p.n+' x'+(p.qty||1);}),
    cost:0, estimatedMins:totalEstMins, swoId:swo.id,
    diagMins:totalDiagMins
  };
  D.workOrders.push(wo);
  if(typeof saveWO==='function') saveWO(wo);
  if(typeof woFinalizeKartOOS==='function') woFinalizeKartOOS(wo,{cat:(swo&&swo.cat)});
  closeM('woBuildModal'); updateBadges();
  if(curTab==='workorders') renderWOs();
  alert('WO '+wo.id+' created: '+title+'\nEst: '+totalEstMins+' min · $'+totalCost.toFixed(2));
}




function _doAddFlag(iid, kid, resp){
  var insp=getInspById(curInspId);if(!insp)return;
  var rs=getRoadState(insp);
  if(!rs.flags[iid]) rs.flags[iid]=[];
  // For ride items or pass: replace existing response for this item+kid
  if(kid==="__ride__"||resp==="pass"){
    rs.flags[iid]=rs.flags[iid].filter(function(f){return f.kartId!==kid;});
    if(resp==="pass"){rs.flags[iid].push({kartId:kid,resp:"pass",notes:"",photo:null});_reconcileKartStatus(rs,(D.inspectionTemplates[insp.templateKey]||{}).track,kid);renderInspSheet();renderFleet();updateBadges();return;}
  }
  var exists=rs.flags[iid].some(function(f){return f.kartId===kid&&f.resp===resp;});
  if(exists)return;
  rs.flags[iid].push({kartId:kid,resp:resp,notes:"",photo:null});
  // Update kart status from ALL of this kart's findings (worst wins) and persist
  var tmpl=D.inspectionTemplates[insp.templateKey];
  var track=tmpl&&tmpl.track;
  _reconcileKartStatus(rs,track,kid);
  renderInspSheet();renderFleet();updateBadges();
}
function _reconcileKartStatus(rs,track,kid){
  if(!track||kid==="__system__"||kid==="__ride__"||!D.karts[track])return;
  var _cur=null,_ks=D.karts[track];for(var _z=0;_z<_ks.length;_z++){if(_ks[_z].id===kid){_cur=_ks[_z];break;}}
  if(_cur&&_cur.status==="regulatory-hold")return;
  var hasDef=false,hasMon=false;
  for(var ii in rs.flags){var ff=rs.flags[ii]||[];for(var jj=0;jj<ff.length;jj++){if(ff[jj].kartId===kid){var r=ff[jj].resp;if(r==="deficiency"||r==="sys-def")hasDef=true;else if(r==="monitor")hasMon=true;}}}
  var blocked=(typeof kartOpenMajorDef!=="undefined")&&kartOpenMajorDef(kid);
  var newSt=hasDef?"oos":hasMon?"pending-signoff":(blocked?"oos":"active");
  var _reason=hasDef?"inspection deficiency":hasMon?"inspection monitor":blocked?("open repair "+(blocked.id||"")):"inspection pass";
  if(typeof setKartStatus==="function"){setKartStatus(kid,newSt,_reason,null,{silent:true});}
  else{D.karts[track]=D.karts[track].map(function(k){if(k.id!==kid)return k;if(k.status===newSt)return k;var nk=Object.assign({},k,{status:newSt});if(typeof saveKart!=="undefined")saveKart(nk);return nk;});}
}

// ===== Work-order worksheet (Stage 1): ruled header + inline 3-C diagnosis =====
function _woGrow(el){ if(el){ el.style.height='auto'; el.style.height=(el.scrollHeight)+'px'; } }
function woSaveC(id,field,val){ var w=woById(id); if(!w)return; val=(val==null?'':String(val)).replace(/\s+$/,''); if(w[field]===val)return; w[field]=val; if(typeof saveWO==='function')saveWO(w); }
function woCyclePriority(id){ var w=woById(id); if(!w)return; var order=(typeof PC==='object'&&PC)?Object.keys(PC):['low','medium','high','critical']; var i=order.indexOf(w.priority); w.priority=order[(i+1)%order.length]; if(typeof saveWO==='function')saveWO(w); if(typeof pgRender==='function')pgRender(); }
function woToggleWarranty(id){ var w=woById(id); if(!w)return; w.warranty=!w.warranty; if(typeof saveWO==='function')saveWO(w); if(typeof pgRender==='function')pgRender(); }

// ===== Inspection work orders =====
// A daily inspection is a work order, but rendering it with the repair worksheet
// (Complaint / Cause / Correction) tells the reader nothing. These show the
// inspection itself instead.
//
// Records imported from the old CMMS only carried summary counts — that export
// had no column for individual item answers — so those are shown as the summary
// they are, and say so, rather than as a checklist of blanks.
var _WO_RIDE_KEY={tornado:'tornado',dragon:'dragon',slide:'slide'};
function _woInspTemplateKey(w){
  var s=((w&&w.title)||'')+' '+((w&&w.assetId)||'')+' '+((w&&w.procedureName)||'');
  s=s.toLowerCase();
  for(var k in _WO_RIDE_KEY) if(s.indexOf(k)>=0) return _WO_RIDE_KEY[k];
  if(s.indexOf('euro')>=0)return 'euro';
  if(s.indexOf('sprint')>=0)return 'sprint';
  if(s.indexOf('road')>=0)return 'road';
  if(s.indexOf('kiddie')>=0)return 'kiddie';
  return '';
}
function _woIsInspection(w){
  if(!w) return false;
  if(w.inspId) return true;
  if(w.procedureName) return true;
  return /inspection|checklist|pre-?op/i.test(String(w.title||''));
}
// The live inspection record behind this work order, if there is one.
function _woLinkedInsp(w){
  if(!w) return null;
  var L=(D&&D.inspections)||[];
  if(w.inspId){ for(var i=0;i<L.length;i++) if(L[i]&&L[i].id===w.inspId) return L[i]; }
  var key=_woInspTemplateKey(w);
  var when=String(w.completed||w.created||'').slice(0,10);
  if(!key||!when) return null;
  for(var j=0;j<L.length;j++){
    var x=L[j]; if(!x) continue;
    if(x.templateKey===key && String(x.date||'').slice(0,10)===when) return x;
  }
  return null;
}
function _woNum(v){ var n=Number(v); return isFinite(n)?n:null; }
// Whatever the old system actually handed over.
function _woImportedCounts(w){
  var p=_woNum(w.procedurePasses!=null?w.procedurePasses:w.procPasses);
  var f=_woNum(w.procedureFlags!=null?w.procedureFlags:w.procFlags);
  var x=_woNum(w.procedureFailures!=null?w.procedureFailures:w.procFailures);
  var sc=_woNum(w.procedureScore!=null?w.procedureScore:w.procScore);
  if(p==null&&f==null&&x==null&&sc==null) return null;
  return {pass:p,flag:f,fail:x,score:sc};
}
function _woInspectionBlock(w){
  if(!_woIsInspection(w)) return '';
  var insp=_woLinkedInsp(w);
  var h='<div class="ds-sec"><div class="ds-st">Inspection</div>';

  if(insp && typeof _inspFullChecklist==='function'){
    var items=(typeof INSP_CHECKLISTS!=='undefined'&&INSP_CHECKLISTS[insp.templateKey])?INSP_CHECKLISTS[insp.templateKey]:(insp.items||[]);
    var rs=(typeof getRoadState==='function')?getRoadState(insp):(insp.roadState||{flags:{}});
    var karts=(typeof getTrackKarts==='function')?getTrackKarts(insp.templateKey):[];
    h+='<div style="font-size:12px;color:var(--muted);margin-bottom:8px">'+esc(insp.title||'')+' · '+esc(String(insp.date||''))
      +(insp.completedBy?(' · signed by '+esc(insp.completedBy)):'')+'</div>';
    if(typeof _inspIssuesBlock==='function') h+=_inspIssuesBlock(items,rs,karts);
    h+=_inspFullChecklist(items,rs,karts);
    h+='<button onclick="openInspSheet(\''+esc(insp.id)+'\')" style="width:100%;background:var(--accent);border:none;color:#fff;border-radius:10px;padding:11px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit">Open inspection</button>';
    h+='</div>';return h;
  }

  var c=_woImportedCounts(w);
  h+='<div style="background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:12px">';
  if(w.procedureName) h+='<div style="font-size:13px;font-weight:800;margin-bottom:2px">'+esc(w.procedureName)+'</div>';
  h+='<div style="font-size:11.5px;color:var(--muted)">'+esc(String(w.completed||w.created||'').slice(0,10))
    +(w.completedBy?(' · '+esc(w.completedBy)):'')+'</div>';
  if(c){
    var bits=[];
    if(c.pass!=null)bits.push(c.pass+' passed');
    if(c.flag!=null&&c.flag>0)bits.push(c.flag+' flagged');
    if(c.fail!=null&&c.fail>0)bits.push(c.fail+' failed');
    if(c.score!=null)bits.push(c.score+'% score');
    if(bits.length) h+='<div style="font-size:12.5px;font-weight:700;margin-top:6px">'+esc(bits.join(' · '))+'</div>';
  }
  h+='<div style="font-size:11.5px;color:var(--muted);line-height:1.5;margin-top:8px">This record came across from the old system, which exported inspections as totals only — the individual item answers were never part of that export, so there is no line-by-line detail to show. Inspections run in this app keep every item, note, and photo.</div>';
  h+='</div>';

  var key=_woInspTemplateKey(w);
  if(key && typeof INSP_CHECKLISTS!=='undefined' && INSP_CHECKLISTS[key]){
    h+='<div style="margin-top:10px"><div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Recurring inspection template · '+INSP_CHECKLISTS[key].length+' items</div>';
    for(var i=0;i<INSP_CHECKLISTS[key].length;i++){ var it=INSP_CHECKLISTS[key][i];
      h+='<div style="padding:6px 0;border-bottom:1px solid var(--border)"><div style="font-size:12px;font-weight:600">'+esc(it.label||'')+'</div>'
        +(it.detail?'<div style="font-size:11px;color:var(--muted);line-height:1.45;margin-top:2px">'+esc(it.detail)+'</div>':'')+'</div>';
    }
    h+='<div style="font-size:11px;color:var(--muted);margin-top:8px">This is the checklist every '+esc(key)+' inspection runs today. Edit it in the Templates tab.</div></div>';
  }
  h+='</div>';return h;
}
function _woWorksheetHead(w){
  var asset=w.assetId||'', vendor=(w.vendorId&&typeof vById==='function')?vById(w.vendorId):null;
  var clk=((typeof kartByName==='function'&&kartByName(asset))||(typeof assetByName==='function'&&assetByName(asset)));
  var sc=(typeof SC==='object'&&SC[w.status])||'#94a3b8', pc=(typeof PC==='object'&&PC[w.priority])||'#94a3b8';
  var warOn=!!w.warranty, warTxt=warOn?('Flagged'+(vendor?(' · '+esc(vendor.name)):'')):'—';
  var lbl='font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)';
  var val='font-size:13px;font-weight:600';
  var h='<div style="background:var(--card);border:1.5px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:12px">';
  h+='<div style="padding:10px 13px;border-bottom:2px solid var(--text);display:flex;justify-content:space-between;align-items:baseline;gap:8px">';
  h+='<div style="font-size:15px;font-weight:800;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(w.title||'Work order')+'</div>';
  h+='<div style="font-size:10px;color:var(--muted);font-family:monospace;flex:none">'+esc(w.id)+'</div></div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr">';
  h+='<div '+(clk?('onclick="openAssetFromWO(\''+escA(asset)+'\')" '):'')+'style="padding:8px 13px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);'+(clk?'cursor:pointer':'')+'"><div style="'+lbl+'">Asset</div><div style="'+val+';color:'+(clk?'var(--accent)':'var(--text)')+'">'+(esc(asset)||'—')+(clk?' ›':'')+'</div></div>';
  h+='<div style="padding:8px 13px;border-bottom:1px solid var(--border)"><div style="'+lbl+'">Status</div><div style="'+val+';color:'+sc+'">'+esc((w.status||'').replace(/-/g,' '))+'</div></div>';
  h+='<div onclick="woCyclePriority(\''+escA(w.id)+'\')" style="padding:8px 13px;border-right:1px solid var(--border);cursor:pointer"><div style="'+lbl+'">Priority <i class="ti ti-pencil" style="font-size:10px;opacity:.5"></i></div><div style="'+val+';color:'+pc+'">'+esc(w.priority||'—')+'</div></div>';
  h+='<div onclick="woToggleWarranty(\''+escA(w.id)+'\')" style="padding:8px 13px;cursor:pointer"><div style="'+lbl+'">Warranty</div><div style="'+val+';color:'+(warOn?'#0891b2':'var(--muted)')+'">'+warTxt+'</div></div>';
  h+='</div></div>';
  return h;
}

function _woDiagField(w,label,field,val,first){
  var s=String(val||''); var rows=Math.max(1,s.split('\n').length,Math.ceil(s.length/44));
  return '<div style="'+(first?'':'border-top:1px solid var(--border);padding-top:9px;')+'margin-bottom:9px">'
    +'<div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:2px">'+label+'</div>'
    +'<textarea class="wo-c" rows="'+rows+'" oninput="_woGrow(this)" onblur="woSaveC(\''+escA(w.id)+'\',\''+field+'\',this.value)" placeholder="Tap to add…" style="width:100%;box-sizing:border-box;border:none;background:transparent;font-family:inherit;font-size:13px;color:var(--text);resize:none;padding:0;line-height:1.45;overflow:hidden">'+esc(s)+'</textarea>'
    +'</div>';
}
function _woDiag(w){
  var comp=(w.complaint!=null?w.complaint:(w.description||''));
  var h='<div style="background:var(--card);border:1.5px solid var(--border);border-radius:6px;padding:10px 13px;margin-bottom:12px">';
  h+='<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--text);padding-bottom:4px;margin-bottom:9px">Diagnosis</div>';
  h+=_woDiagField(w,'Complaint','complaint',comp,true);
  h+=_woDiagField(w,'Cause','cause',w.cause||'',false);
  h+=_woDiagField(w,'Correction','correction',w.correction||'',false);
  h+='</div>';
  return h;
}

// ===== Work-order context (Stage 3): recent work + repeat-complaint flag =====
function _woDateOf(w){ return (w&&(w.completed||w.dueDate||w.created))||''; }
function _woDaysBetween(a,b){ if(!a||!b)return null; return Math.round((new Date(b+'T12:00:00')-new Date(a+'T12:00:00'))/86400000); }
function _woAssetWOs(w){
  var out=[],L=D.workOrders||[]; var aid=String(w.assetId||'').trim().toLowerCase(), kid=w.kartId||'';
  for(var i=0;i<L.length;i++){ var x=L[i]; if(!x||x.id===w.id||x.deleted)continue;
    var same=(kid&&x.kartId===kid)||(aid&&String(x.assetId||'').trim().toLowerCase()===aid);
    if(same)out.push(x);
  }
  out.sort(function(a,b){ return String(_woDateOf(b)).localeCompare(String(_woDateOf(a))); });
  return out;
}
var WO_ISSUE_TAGS=['brake','steering','chain','sprocket','engine','throttle','tire','tyre','wheel','bearing','clutch','belt','fuel','carb','oil','electrical','wiring','battery','starter','seat','bumper','pedal','governor','muffler','exhaust','weld','hub','pulley','spindle','piston','valve','gasket','spark','grind','noise','leak','vibrat','overheat','stall','smoke','pull'];
function _woIssueText(w){ return ((w.title||'')+' '+(w.complaint||w.description||'')+' '+((w.symptoms||[]).join(' '))+' '+(w.otherText||'')).toLowerCase(); }
function _woIssueTags(w){ var t=_woIssueText(w),s={}; for(var i=0;i<WO_ISSUE_TAGS.length;i++)if(t.indexOf(WO_ISSUE_TAGS[i])>=0)s[WO_ISSUE_TAGS[i]]=1; return s; }
function _woRepeat(w,list){
  var mine=_woIssueTags(w),keys=Object.keys(mine); if(!keys.length)return null;
  var td=(typeof today==='function')?today():'';
  for(var i=0;i<list.length;i++){ var x=list[i]; var xt=_woIssueTags(x),shared=null;
    for(var k=0;k<keys.length;k++)if(xt[keys[k]]){shared=keys[k];break;}
    if(shared){ var days=_woDaysBetween(_woDateOf(x),td); if(days!=null&&days>=0&&days<=60)return {wo:x,tag:shared,days:days}; }
  }
  return null;
}
function _woRepeatFlag(w){
  var rep=_woRepeat(w,_woAssetWOs(w)); if(!rep)return '';
  var when=(rep.days===0)?'earlier today':(rep.days+' day'+(rep.days===1?'':'s')+' ago');
  return '<div style="background:#fffbeb;border:1.5px solid #f59e0b;border-radius:6px;padding:8px 11px;margin:0 0 12px;display:flex;gap:7px;align-items:flex-start">'
    +'<span style="color:#b45309;font-size:14px;line-height:1.2">⚠</span>'
    +'<div style="font-size:12px;color:#92400e;font-weight:600;line-height:1.4">Repeat: same <b>'+esc(rep.tag)+'</b> issue '+when+' · '
    +'<span onclick="openWOD(\''+escA(rep.wo.id)+'\')" style="color:#b45309;text-decoration:underline;cursor:pointer;font-weight:800">'+esc(rep.wo.title||rep.wo.id)+'</span></div></div>';
}
function _woRecentBlock(w){
  var list=_woAssetWOs(w); var top=list.slice(0,4);
  if(!top.length)return '';
  var h='<div style="background:var(--card);border:1.5px solid var(--border);border-radius:6px;padding:10px 13px;margin-bottom:12px">';
  h+='<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--text);padding-bottom:4px;margin-bottom:2px">Recent work · '+(esc(w.assetId)||'this asset')+'</div>';
  for(var i=0;i<top.length;i++){ var x=top[i];
    h+='<div onclick="openWOD(\''+escA(x.id)+'\')" style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 0;'+(i<top.length-1?'border-bottom:1px solid var(--border);':'')+'cursor:pointer">';
    h+='<div style="min-width:0"><div style="font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(x.title||x.id)+'</div><div style="font-size:10px;color:var(--muted)">'+esc((x.status||'').replace(/-/g,' '))+'</div></div>';
    h+='<div style="font-size:11px;color:var(--muted);font-family:monospace;flex:none">'+esc((typeof fmt==='function'?fmt(_woDateOf(x)):_woDateOf(x))||'')+'</div></div>';
  }
  h+='</div>';
  return h;
}
