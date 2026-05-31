/* ============================================================
   RC Car Business Manager  —  single-file front-end app
   Data is stored in your browser (localStorage).
   Use Settings → Backup to export a file you can keep safe.
   ============================================================ */

const STORE_KEY = "rcbiz_data_v1";

/* ---------- Default data ---------- */
function defaultData(){
  return {
    settings:{
      businessName:"PRC Sales App",
      currency:"₹",
      lowStockDefault:3,
      address:"", phone:"", gstin:"",
      enableGST:false, gstRate:18, gstInclusive:false,
      invoiceSeq:1,
      expenseCategories:["Rent","Salary","Transport","Marketing","Utilities","Packaging","Repairs","Misc"],
      saleChannels:["Shop / Walk-in","WhatsApp","Instagram","Amazon","Flipkart","Exhibition","Other"],
      productCategories:["RC Car","RC Truck","RC Drone","Battery","Charger","Spare Part","Tyres","Remote","Accessory"]
    },
    products:[], purchases:[], sales:[], expenses:[],
    customers:[], suppliers:[], staff:[],
    users:[{id:"u_admin",username:"admin",password:"admin",name:"Owner",role:"admin"}],
    seq:1
  };
}

/* ---------- Cloud (Supabase) setup ---------- */
/* NO_LOGIN: open straight to the dashboard, no sign-in screen.
   SYNC:     mirror data to the cloud and merge across devices (shared anon key,
             no per-user login) + daily auto-backup.
   The two are independent — here we run no-login AND synced.
   Set SYNC=false to go back to local-only on this device. */
const NO_LOGIN = true;
const SYNC = true;
const CFG = window.RC_CONFIG || {};
const BIZ_ID = CFG.BUSINESS_ID || "main";
const CLOUD = SYNC && !!(window.supabase && CFG.SUPABASE_URL && CFG.SUPABASE_KEY);
let sb = null;
if (CLOUD) { try { sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY); } catch(e){ console.warn("Supabase init failed", e); } }

/* ---------- Storage ---------- */
const COLLECTIONS = ["products","sales","purchases","expenses","customers","suppliers","staff","users"];
function normalize(d){
  // deep-merge over defaults so older/partial data never has missing arrays/sub-keys
  const def = defaultData();
  const out = Object.assign({}, def, d||{});
  out.settings = Object.assign({}, def.settings, (d&&d.settings)||{});
  COLLECTIONS.forEach(k=>{ if(!Array.isArray(out[k])) out[k]=[]; });
  out.tombstones = (d&&d.tombstones && typeof d.tombstones==="object") ? d.tombstones : {};
  // backfill cost-at-sale for inventory-linked sales so profit freezes going forward
  out.sales.forEach(s=>{
    if((s.costAtSale==null||s.costAtSale==="") && s.productId){
      const p=out.products.find(x=>x.id===s.productId);
      if(p) s.costAtSale = Number(p.cost)||0;
    }
  });
  return out;
}
let DATA = load();
function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return defaultData();
    return normalize(JSON.parse(raw));
  }catch(e){ return defaultData(); }
}
let cloudTimer = null, dirty = false, applyingRemote = false;
function save(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(DATA));
  }catch(e){
    toast("Couldn't save on this device (storage full or private mode). Use Backup.","err");
  }
  if(CLOUD && sb && !applyingRemote){
    dirty = true;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(syncCloud, 700);
  }
}

/* ---- Per-record merge (so two phones don't overwrite each other) ---- */
function mergeData(local, remote){
  const a = normalize(local), b = normalize(remote);
  const tombs = {};
  [a.tombstones, b.tombstones].forEach(t=>{
    Object.keys(t||{}).forEach(id=>{ if(!tombs[id] || t[id] > tombs[id]) tombs[id] = t[id]; });
  });
  const out = Object.assign({}, a);
  COLLECTIONS.forEach(k=>{
    const byId = {};
    (b[k]||[]).forEach(r=>{ if(r&&r.id) byId[r.id]=r; });
    (a[k]||[]).forEach(r=>{
      if(!r||!r.id) return;
      const ex = byId[r.id];
      if(!ex || (r.updatedAt||"") >= (ex.updatedAt||"")) byId[r.id]=r;
    });
    out[k] = Object.values(byId).filter(r=>{
      const t = tombs[r.id];
      return !(t && t >= (r.updatedAt||""));   // drop if deleted more recently than last edit
    });
  });
  // settings: whichever was updated last wins as a whole
  out.settings = ((b.settings&&b.settings.updatedAt||"") > (a.settings&&a.settings.updatedAt||"")) ? b.settings : a.settings;
  out.tombstones = tombs;
  out.seq = Math.max(Number(a.seq)||1, Number(b.seq)||1);
  return out;
}

async function pushCloud(){
  if(!CLOUD || !sb) return;
  try{
    const { error } = await sb.from("business_state")
      .upsert({ id: BIZ_ID, data: DATA, updated_at: nowISO() });
    if(error){ console.warn("Cloud save:", error.message); return false; }
    dirty = false; return true;
  }catch(e){ console.warn("Cloud save failed", e); return false; }
}
// fetch remote, merge with local, then push the merged result back
async function syncCloud(){
  if(!CLOUD || !sb) return;
  try{
    const { data, error } = await sb.from("business_state").select("data").eq("id", BIZ_ID).maybeSingle();
    if(error){ console.warn("Cloud load:", error.message); return; }
    const remote = (data && data.data && Object.keys(data.data).length) ? data.data : null;
    if(remote){ DATA = mergeData(DATA, remote); }
    try{ localStorage.setItem(STORE_KEY, JSON.stringify(DATA)); }catch(e){}
    await pushCloud();
  }catch(e){ console.warn("Cloud sync failed", e); }
}
// pull remote and merge into memory (used on startup/focus); returns true if changed
async function fetchCloud(){
  if(!CLOUD || !sb) return false;
  try{
    const { data, error } = await sb.from("business_state").select("data").eq("id", BIZ_ID).maybeSingle();
    if(error){ console.warn("Cloud load:", error.message); return false; }
    const before = JSON.stringify(DATA);
    if(data && data.data && Object.keys(data.data).length){
      DATA = mergeData(DATA, data.data);
    } else {
      await pushCloud(); // first run on empty cloud — seed it
      return false;
    }
    applyingRemote = true;
    try{ localStorage.setItem(STORE_KEY, JSON.stringify(DATA)); }catch(e){}
    applyingRemote = false;
    if(dirty) await pushCloud();  // don't lose a queued local edit
    return JSON.stringify(DATA) !== before;
  }catch(e){ console.warn("Cloud load failed", e); return false; }
}
// Auto-backup: once per calendar day, save a dated snapshot to the cloud so you
// have point-in-time restore even if today's live data gets messed up.
async function autoBackup(){
  if(!CLOUD || !sb) return;
  const day = today();
  if(localStorage.getItem("rcbiz_lastsnap") === day) return; // already done today
  try{
    const { error } = await sb.from("business_snapshots")
      .upsert({ snapshot_date: day, data: DATA, created_at: nowISO() }, { onConflict: "snapshot_date" });
    if(!error) localStorage.setItem("rcbiz_lastsnap", day);
    else console.warn("Auto-backup:", error.message);
  }catch(e){ console.warn("Auto-backup failed", e); }
}
function nextId(){ return "id" + (DATA.seq++) + "_" + Date.now().toString(36); }

/* ---------- Auth / session ---------- */
const SESSION_KEY = "rcbiz_session";
let currentUser = null;
function me(){ return currentUser || {}; }
function isAdmin(){ return me().role === "admin"; }
function login(username, password){
  const u = DATA.users.find(x=>x.username.toLowerCase()===String(username).toLowerCase() && x.password===password);
  if(!u) return false;
  currentUser = u;
  localStorage.setItem(SESSION_KEY, u.id);
  return true;
}
async function logout(){
  if(NO_LOGIN){ go("dashboard"); return; }
  if(CLOUD && sb){ try{ await sb.auth.signOut(); }catch(e){} }
  currentUser = null;
  localStorage.removeItem(SESSION_KEY);
  showLogin();
}
function restoreSession(){
  const id = localStorage.getItem(SESSION_KEY);
  if(id){ const u = DATA.users.find(x=>x.id===id); if(u){ currentUser = u; return true; } }
  return false;
}

/* ---------- Cloud auth ---------- */
async function cloudSignIn(email, password){
  const { data, error } = await sb.auth.signInWithPassword({ email: String(email).trim(), password });
  if(error) return { ok:false, msg: error.message };
  await afterCloudLogin(data.user);
  return { ok:true };
}
async function afterCloudLogin(user){
  await fetchCloud();
  const email = (user.email||"").toLowerCase();
  let u = DATA.users.find(x => (x.email||x.username||"").toLowerCase() === email);
  if(!u){
    const anyAdmin = DATA.users.some(x => x.role === "admin");
    u = { id: nextId(), name: (user.email||"User").split("@")[0], email, role: anyAdmin ? "staff" : "admin" };
    DATA.users.push(u);
    if(!DATA.staff.some(s => s.name === u.name)) DATA.staff.push({ id: nextId(), name: u.name });
    save();
  }
  currentUser = u;
}
async function cloudRestore(){
  if(!CLOUD || !sb) return false;
  try{
    const { data } = await sb.auth.getSession();
    if(data && data.session && data.session.user){ await afterCloudLogin(data.session.user); return true; }
  }catch(e){ console.warn(e); }
  return false;
}

/* ---------- Helpers ---------- */
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
const cur = ()=>DATA.settings.currency || "₹";
function money(n){
  n = Number(n)||0;
  return cur() + n.toLocaleString("en-IN",{maximumFractionDigits:2});
}
function num(n){ return (Number(n)||0).toLocaleString("en-IN"); }
// today in LOCAL time (so a late-night entry doesn't default to the UTC day)
function today(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function nowISO(){ return new Date().toISOString(); }
function fmtDate(d){
  if(!d) return "—";
  const dt = new Date(d+"T00:00:00");
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
}
function monthKey(d){ return (d||"").slice(0,7); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"'/]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","/":"&#47;"}[c])); }
function uid(prefix){ return prefix+Math.random().toString(36).slice(2,8); }

function toast(msg,type=""){
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + type;
  if(type==="ok" || type==="err"){ try{ if(navigator.vibrate) navigator.vibrate(type==="err"?[8,40,8]:10); }catch(e){} }
  setTimeout(()=>{ t.className="toast"; }, 2600);
}

/* ---------- Derived calculations ---------- */
function productById(id){ return DATA.products.find(p=>p.id===id); }
function stockOf(p){ return Number(p.stock)||0; }
function stockValue(){ return DATA.products.reduce((s,p)=>s+Math.max(0,stockOf(p))*(Number(p.cost)||0),0); }
function lowStockProducts(){
  return DATA.products.filter(p=>stockOf(p) <= (Number(p.reorder)|| DATA.settings.lowStockDefault));
}
function sumBy(arr,f){ return arr.reduce((s,x)=>s+(Number(f(x))||0),0); }

function saleTotal(s){ return (Number(s.qty)||0)*(Number(s.price)||0) - (Number(s.discount)||0); }
function saleCost(s){
  // Prefer the cost captured AT THE TIME OF SALE so a later restock at a
  // different price never rewrites historical profit. Fall back to the
  // product's current cost only for legacy sales that have no snapshot.
  const hasSnap = s.costAtSale!=null && s.costAtSale!=="";
  const p = productById(s.productId);
  const c = hasSnap ? (Number(s.costAtSale)||0) : (p ? Number(p.cost)||0 : 0);
  return (Number(s.qty)||0)*c;
}
function saleProfit(s){ return saleTaxable(s) - saleCost(s); }
/* amount still owed on a sale, computed from amounts (not the status label) */
function saleDue(s){ return Math.max(0, saleGrand(s) - (Number(s.paid)||0)); }
function purchaseDue(p){ return Math.max(0, purchaseTotal(p) - (Number(p.paid)||0)); }
function purchaseTotal(p){ return (Number(p.qty)||0)*(Number(p.price)||0) + (Number(p.shipping)||0); }

/* GST helpers (used for invoices). saleTotal stays the recorded sale value. */
function gstRateOf(s){
  if(!DATA.settings.enableGST) return 0;
  const r = (s && s.gstRate!=null && s.gstRate!=="") ? Number(s.gstRate) : (Number(DATA.settings.gstRate)||0);
  return isNaN(r)?0:r;
}
function saleGST(s){
  const rate=gstRateOf(s); if(!rate) return 0;
  const base=saleTotal(s);
  return DATA.settings.gstInclusive ? (base - base/(1+rate/100)) : (base*rate/100);
}
function saleTaxable(s){ return DATA.settings.gstInclusive ? (saleTotal(s)-saleGST(s)) : saleTotal(s); }
function saleGrand(s){ return DATA.settings.gstInclusive ? saleTotal(s) : (saleTotal(s)+saleGST(s)); }

function rangeFilter(arr, from, to){
  return arr.filter(x=>{
    if(from && x.date < from) return false;
    if(to && x.date > to) return false;
    return true;
  });
}

/* ============================================================
   ROUTER
   ============================================================ */
const VIEWS = {
  dashboard:{title:"Dashboard", render:renderDashboard},
  sales:{title:"Sales", render:renderSales},
  purchases:{title:"Purchases", render:renderPurchases},
  expenses:{title:"Expenses", render:renderExpenses},
  inventory:{title:"Inventory", render:renderInventory},
  customers:{title:"Customers", render:renderCustomers},
  suppliers:{title:"Suppliers", render:renderSuppliers},
  staff:{title:"Staff", render:renderStaff},
  reports:{title:"Reports", render:renderReports},
  settings:{title:"Settings", render:renderSettings}
};
let currentView = "dashboard";

const PRIMARY_TABS = ["dashboard","sales","purchases","expenses"];
function go(view){
  if(view==="settings" && !isAdmin()){ toast("Only admins can open Settings","err"); view="dashboard"; }
  currentView = view;
  $$(".nav-item").forEach(b=>b.classList.toggle("active", b.dataset.view===view));
  // bottom-nav "More" lights up for any non-primary view
  const moreBtn = $("#moreBtn");
  if(moreBtn) moreBtn.classList.toggle("active", !PRIMARY_TABS.includes(view));
  $("#viewTitle").textContent = VIEWS[view].title;
  $("#topbarActions").innerHTML = "";
  $("#content").innerHTML = "";
  VIEWS[view].render();
  $(".sidebar").classList.remove("open");
  closeSheet();
  const fab=$("#fab");
  if(fab) fab.classList.toggle("hide", ["settings","reports"].includes(view));
  window.scrollTo(0,0);
}
function buzz(ms){ try{ if(navigator.vibrate) navigator.vibrate(ms||10); }catch(e){} }

function addTopAction(label, cls, fn){
  const b = document.createElement("button");
  b.className = "btn " + (cls||"");
  b.innerHTML = label;
  b.onclick = fn;
  $("#topbarActions").appendChild(b);
  return b;
}

/* ============================================================
   MODAL + FORM ENGINE
   ============================================================ */
function openModal(title, bodyHTML){
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHTML;
  $("#modalOverlay").classList.add("open");
}
function closeModal(){ $("#modalOverlay").classList.remove("open"); }
function closeSheet(){ /* the More/quick-add sheet reuses the modal; closeModal handles it */ }

/* ---------- Mobile: More sheet + Quick-add ---------- */
const MORE_LINKS = [
  {view:"inventory", icon:"🚗", label:"Inventory", sub:"Stock & products"},
  {view:"customers", icon:"👥", label:"Customers", sub:"Who buys from you"},
  {view:"suppliers", icon:"🏭", label:"Suppliers", sub:"Who you buy from"},
  {view:"staff", icon:"🧑‍🔧", label:"Staff", sub:"Your team"},
  {view:"reports", icon:"📈", label:"Reports", sub:"Profit & loss"},
  {view:"settings", icon:"⚙️", label:"Settings", sub:"Business, GST, logins", admin:true}
];
function openMoreSheet(){
  buzz();
  const rows = MORE_LINKS.filter(l=>!l.admin || isAdmin()).map(l=>
    `<button class="sheet-row" data-go="${l.view}"><span class="sheet-ico">${l.icon}</span>
       <span>${esc(l.label)}<small>${esc(l.sub)}</small></span></button>`).join("");
  openModal("More", rows +
    `<button class="sheet-row" id="sheetBackup"><span class="sheet-ico">⬇️</span><span>Backup data<small>Download a safe copy</small></span></button>` +
    (deferredPrompt?`<button class="sheet-row" id="sheetInstall"><span class="sheet-ico">📲</span><span>Install app<small>Add to home screen</small></span></button>`:"") +
    (NO_LOGIN?"":`<button class="sheet-row" id="sheetLogout"><span class="sheet-ico">🚪</span><span>Logout<small>${esc(me().name||"")}</small></span></button>`));
  $$("#modalBody [data-go]").forEach(b=>b.onclick=()=>{ buzz(); go(b.dataset.go); });
  const bk=$("#sheetBackup"); if(bk) bk.onclick=()=>{ backup(); closeModal(); };
  const ins=$("#sheetInstall"); if(ins) ins.onclick=async()=>{ if(deferredPrompt){ deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; } closeModal(); };
  const lo=$("#sheetLogout"); if(lo) lo.onclick=()=>{ closeModal(); logout(); };
}
function openQuickAdd(){
  buzz();
  const items=[
    {fn:"sale", icon:"💰", label:"New Sale", sub:"Record a sale"},
    {fn:"purchase", icon:"📦", label:"New Purchase", sub:"Record stock bought"},
    {fn:"expense", icon:"🧾", label:"New Expense", sub:"Record money spent"},
    {fn:"product", icon:"🚗", label:"Add Product", sub:"New inventory item"}
  ];
  openModal("Quick add", items.map(i=>
    `<button class="sheet-row" data-add="${i.fn}"><span class="sheet-ico">${i.icon}</span>
      <span>${esc(i.label)}<small>${esc(i.sub)}</small></span></button>`).join(""));
  $$("#modalBody [data-add]").forEach(b=>b.onclick=()=>{
    buzz();
    const f=b.dataset.add;
    if(f==="sale") saleForm();
    else if(f==="purchase") purchaseForm();
    else if(f==="expense") expenseForm();
    else if(f==="product") productForm();
  });
}

/* fields: [{name,label,type,options,value,required,step,full,placeholder}] */
function buildForm(fields, onSubmit, submitLabel="Save"){
  const formId = uid("f");
  let html = `<form id="${formId}"><div class="form-grid">`;
  fields.forEach(f=>{
    const full = f.full ? " full" : "";
    const req = f.required ? "required" : "";
    const val = f.value==null? "" : esc(f.value);
    html += `<div class="field${full}"><label>${esc(f.label)}${f.required?" *":""}</label>`;
    if(f.type==="select"){
      html += `<select name="${f.name}" ${f.addable?`data-addable="${esc(f.addable)}"`:""} ${req}>`;
      if(f.placeholder) html += `<option value="">${esc(f.placeholder)}</option>`;
      (f.options||[]).forEach(o=>{
        const ov = typeof o==="object"? o.value : o;
        const ol = typeof o==="object"? o.label : o;
        html += `<option value="${esc(ov)}" ${String(ov)===String(f.value)?"selected":""}>${esc(ol)}</option>`;
      });
      if(f.addable) html += `<option value="__ADDNEW__">➕ Add new…</option>`;
      html += `</select>`;
      if(f.addable) html += `<span class="add-hint">Choose “Add new…” to create &amp; save an option</span>`;
    } else if(f.type==="textarea"){
      html += `<textarea name="${f.name}" placeholder="${esc(f.placeholder||"")}" ${req}>${val}</textarea>`;
    } else {
      const step = f.type==="number"? `step="${f.step||"any"}"` : "";
      html += `<input type="${f.type||"text"}" name="${f.name}" value="${val}" placeholder="${esc(f.placeholder||"")}" ${step} ${req}>`;
    }
    html += `</div>`;
  });
  html += `<div class="form-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
    </div></div></form>`;
  openModal(arguments[3]||"Form", html);
  const form = $("#"+formId);
  // inline "Add new…" handling for editable dropdowns
  $$('select[data-addable]', form).forEach(sel=>{
    let prev = sel.value;
    sel.addEventListener("change", ()=>{
      if(sel.value==="__ADDNEW__"){
        const key = sel.dataset.addable;
        const val = (prompt("Add a new option (it will be saved for next time):")||"").trim();
        if(val){ addOptionValue(key, val); rebuildSelect(sel, key, val); toast("Option added","ok"); }
        else { sel.value = prev; }
      }
      prev = sel.value;
    });
  });
  form.onsubmit = (e)=>{
    e.preventDefault();
    const fd = new FormData(form);
    const obj = {};
    fields.forEach(f=>{ obj[f.name] = fd.get(f.name); });
    onSubmit(obj);
  };
}
function optionsFor(key){
  if(key==="suppliers") return DATA.suppliers.map(s=>s.name);
  if(key==="staff") return DATA.staff.map(s=>s.name);
  if(key==="customers") return DATA.customers.map(c=>c.name);
  return DATA.settings[key] || [];
}
function addOptionValue(key, val){
  if(key==="suppliers"){ if(!DATA.suppliers.some(s=>s.name===val)) DATA.suppliers.push({id:nextId(),name:val,updatedAt:nowISO()}); }
  else if(key==="staff"){ if(!DATA.staff.some(s=>s.name===val)) DATA.staff.push({id:nextId(),name:val,updatedAt:nowISO()}); }
  else if(key==="customers"){ if(!DATA.customers.some(c=>c.name===val)) DATA.customers.push({id:nextId(),name:val,updatedAt:nowISO()}); }
  else { if(!DATA.settings[key]) DATA.settings[key]=[]; if(!DATA.settings[key].includes(val)) DATA.settings[key].push(val); DATA.settings.updatedAt=nowISO(); }
  save();
}
function rebuildSelect(sel, key, selectVal){
  const opts = optionsFor(key);
  sel.innerHTML = `<option value="">Select</option>` +
    opts.map(o=>`<option value="${esc(o)}" ${o===selectVal?"selected":""}>${esc(o)}</option>`).join("") +
    `<option value="__ADDNEW__">➕ Add new…</option>`;
  sel.value = selectVal;
}

/* generic table renderer */
function tableHTML(cols, rows){
  if(!rows.length) return `<div class="empty">Nothing here yet. Use the + button above to add your first entry.</div>`;
  let h = `<div class="table-wrap"><table><thead><tr>`;
  cols.forEach(c=> h += `<th class="${c.num?"num":""}">${esc(c.label)}</th>`);
  h += `</tr></thead><tbody>`;
  rows.forEach(r=>{
    h += `<tr>`;
    cols.forEach(c=> h += `<td class="${c.num?"num":""}">${c.render(r)}</td>`);
    h += `</tr>`;
  });
  h += `</tbody></table></div>`;
  return h;
}

function payBadge(status){
  const s=(status||"Paid").toLowerCase();
  if(s==="paid") return `<span class="badge paid">Paid</span>`;
  if(s==="partial") return `<span class="badge partial">Partial</span>`;
  return `<span class="badge due">Due</span>`;
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard(){
  const c = $("#content");
  const sales = DATA.sales, purchases = DATA.purchases, expenses = DATA.expenses;

  const totalRevenue = sumBy(sales, saleTotal);
  const totalCOGS = sumBy(sales, saleCost);
  const grossProfit = totalRevenue - totalCOGS;
  const totalExpenses = sumBy(expenses, e=>e.amount);
  const netProfit = grossProfit - totalExpenses;
  const totalPurchases = sumBy(purchases, purchaseTotal);

  // Outstanding computed from amounts, not the status label, so stale paid
  // values after a status toggle can't distort collectibles/payables.
  const salesDue = sumBy(sales, saleDue);
  const purchDue = sumBy(purchases, purchaseDue);

  const low = lowStockProducts();

  // This month
  const tm = monthKey(today());
  const mRev = sumBy(sales.filter(s=>monthKey(s.date)===tm), saleTotal);
  const mExp = sumBy(expenses.filter(e=>monthKey(e.date)===tm), e=>e.amount);

  let html = "";

  if(low.length){
    html += `<div class="alert">⚠️ <strong>${low.length}</strong> item(s) are low on stock — restock soon: ${low.slice(0,4).map(p=>esc(p.name)).join(", ")}${low.length>4?"…":""}</div>`;
  }

  html += `<div class="kpi-grid">
    <div class="kpi green"><div class="kpi-label">Total Revenue</div><div class="kpi-value">${money(totalRevenue)}</div><div class="kpi-sub">${sales.length} sale(s)</div></div>
    <div class="kpi ${netProfit>=0?"green":"red"}"><div class="kpi-label">Net Profit</div><div class="kpi-value">${money(netProfit)}</div><div class="kpi-sub">After all expenses</div></div>
    <div class="kpi cyan"><div class="kpi-label">Gross Profit</div><div class="kpi-value">${money(grossProfit)}</div><div class="kpi-sub">Revenue − cost of goods</div></div>
    <div class="kpi red"><div class="kpi-label">Total Expenses</div><div class="kpi-value">${money(totalExpenses)}</div><div class="kpi-sub">${expenses.length} entries</div></div>
    <div class="kpi amber"><div class="kpi-label">Stock Value</div><div class="kpi-value">${money(stockValue())}</div><div class="kpi-sub">${DATA.products.length} products</div></div>
    <div class="kpi"><div class="kpi-label">Money to Collect</div><div class="kpi-value">${money(salesDue)}</div><div class="kpi-sub">Unpaid by customers</div></div>
    <div class="kpi"><div class="kpi-label">Money to Pay</div><div class="kpi-value">${money(purchDue)}</div><div class="kpi-sub">Owed to suppliers</div></div>
    <div class="kpi"><div class="kpi-label">This Month</div><div class="kpi-value">${money(mRev-mExp)}</div><div class="kpi-sub">${money(mRev)} in · ${money(mExp)} out</div></div>
  </div>`;

  // Current month chart
  html += `<div class="grid-3">
    <div class="panel">
      <div class="panel-head"><h3>This Month — Revenue vs Spending</h3><span class="li-sub" id="monthLabel"></span></div>
      <div id="monthChart"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Top Selling Products</h3></div>
      <div id="topProducts"></div>
    </div>
  </div>`;

  // Recent activity + channels
  html += `<div class="grid-2">
    <div class="panel">
      <div class="panel-head"><h3>Recent Sales</h3><button class="btn btn-sm" onclick="go('sales')">View all</button></div>
      <div id="recentSales"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Sales by Channel</h3></div>
      <div id="channelChart"></div>
    </div>
  </div>`;

  c.innerHTML = html;

  // Current month chart — week-by-week revenue vs spending
  const mk = monthKey(today());
  const now = new Date();
  $("#monthLabel").textContent = now.toLocaleDateString("en-IN",{month:"long",year:"numeric"});
  const weekOf = (d)=> Math.floor((Number((d||"").slice(8,10))-1)/7); // 0..4
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const weekCount = Math.ceil(daysInMonth/7);
  const wkRev = Array(weekCount).fill(0), wkSpend = Array(weekCount).fill(0);
  sales.filter(s=>monthKey(s.date)===mk).forEach(s=>{ wkRev[weekOf(s.date)] += saleTotal(s); });
  expenses.filter(e=>monthKey(e.date)===mk).forEach(e=>{ wkSpend[weekOf(e.date)] += Number(e.amount)||0; });
  purchases.filter(p=>monthKey(p.date)===mk).forEach(p=>{ wkSpend[weekOf(p.date)] += purchaseTotal(p); });
  const maxv = Math.max(1,...wkRev,...wkSpend);
  const monthRev = wkRev.reduce((a,b)=>a+b,0), monthSpend = wkSpend.reduce((a,b)=>a+b,0);
  let mc = `<div class="bar-row"><div class="lbl" style="font-weight:700;color:var(--text)">Total ▲ in</div>
      <div class="bar-track"><div class="bar-fill green" style="width:${monthRev/Math.max(maxv,monthRev,monthSpend)*100}%"></div></div>
      <div class="val pos">${money(monthRev)}</div></div>
    <div class="bar-row"><div class="lbl" style="font-weight:700;color:var(--text)">Total ▼ out</div>
      <div class="bar-track"><div class="bar-fill red" style="width:${monthSpend/Math.max(maxv,monthRev,monthSpend)*100}%"></div></div>
      <div class="val neg">${money(monthSpend)}</div></div>
    <div style="height:1px;background:var(--line);margin:12px 0"></div>`;
  for(let w=0; w<weekCount; w++){
    mc += `<div class="bar-row"><div class="lbl">Wk ${w+1} ▲</div>
        <div class="bar-track"><div class="bar-fill green" style="width:${wkRev[w]/maxv*100}%"></div></div>
        <div class="val">${money(wkRev[w])}</div></div>
      <div class="bar-row"><div class="lbl">Wk ${w+1} ▼</div>
        <div class="bar-track"><div class="bar-fill red" style="width:${wkSpend[w]/maxv*100}%"></div></div>
        <div class="val">${money(wkSpend[w])}</div></div>`;
  }
  $("#monthChart").innerHTML = (monthRev||monthSpend)? mc : `<div class="empty">No activity yet this month</div>`;

  // Top products
  const prodSales = {};
  sales.forEach(s=>{
    const name = (productById(s.productId)||{}).name || s.itemName || "Unknown";
    prodSales[name] = (prodSales[name]||0) + (Number(s.qty)||0);
  });
  const top = Object.entries(prodSales).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxq = Math.max(1,...top.map(t=>t[1]));
  $("#topProducts").innerHTML = top.length? top.map(([n,q])=>`
    <div class="bar-row"><div class="lbl" style="width:120px">${esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${q/maxq*100}%"></div></div>
      <div class="val" style="width:50px">${q}</div></div>`).join("") : `<div class="empty">No sales yet</div>`;

  // Recent sales
  const recent = [...sales].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,6);
  $("#recentSales").innerHTML = recent.length? recent.map(s=>{
    const name = (productById(s.productId)||{}).name || s.itemName || "Item";
    return `<div class="list-item"><div><div class="li-main">${esc(name)} ×${s.qty}</div>
      <div class="li-sub">${fmtDate(s.date)} · ${esc(s.channel||"")} ${s.customer?("· "+esc(s.customer)):""}</div></div>
      <div class="li-main pos">${money(saleTotal(s))}</div></div>`;
  }).join("") : `<div class="empty">No sales yet</div>`;

  // Channel chart
  const byCh = {};
  sales.forEach(s=>{ const ch=s.channel||"Other"; byCh[ch]=(byCh[ch]||0)+saleTotal(s); });
  const chArr = Object.entries(byCh).sort((a,b)=>b[1]-a[1]);
  const maxc = Math.max(1,...chArr.map(c=>c[1]));
  $("#channelChart").innerHTML = chArr.length? chArr.map(([n,v])=>`
    <div class="bar-row"><div class="lbl" style="width:120px">${esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${v/maxc*100}%"></div></div>
      <div class="val">${money(v)}</div></div>`).join("") : `<div class="empty">No sales yet</div>`;
}

function lastNMonths(n){
  const out=[]; const d=new Date();
  for(let i=n-1;i>=0;i--){
    const dt = new Date(d.getFullYear(), d.getMonth()-i, 1);
    out.push({ key: dt.toISOString().slice(0,7), label: dt.toLocaleDateString("en-IN",{month:"short"}) });
  }
  return out;
}

/* ============================================================
   SALES
   ============================================================ */
let salesFilter = {q:"",from:"",to:"",channel:""};
function renderSales(){
  addTopAction("➕ New Sale","btn-primary", ()=>saleForm());
  addTopAction("⬇️ Export CSV","", ()=>exportCSV("sales"));
  const c = $("#content");

  c.innerHTML = `<div class="panel">
    <div class="filters">
      <div class="field search"><label>Search</label><input id="sQ" placeholder="Product / customer / staff..." value="${esc(salesFilter.q)}"></div>
      <div class="field"><label>Channel</label><select id="sCh"><option value="">All</option>${DATA.settings.saleChannels.map(ch=>`<option ${salesFilter.channel===ch?"selected":""}>${esc(ch)}</option>`).join("")}</select></div>
      <div class="field"><label>From</label><input type="date" id="sFrom" value="${salesFilter.from}"></div>
      <div class="field"><label>To</label><input type="date" id="sTo" value="${salesFilter.to}"></div>
    </div>
    <div id="salesTable"></div>
  </div>`;

  const apply = ()=>{
    salesFilter = {q:$("#sQ").value.toLowerCase(), channel:$("#sCh").value, from:$("#sFrom").value, to:$("#sTo").value};
    drawSales();
  };
  ["sQ","sCh","sFrom","sTo"].forEach(id=> $("#"+id).oninput = apply);
  drawSales();
}
function drawSales(){
  let rows = rangeFilter(DATA.sales, salesFilter.from, salesFilter.to);
  if(salesFilter.channel) rows = rows.filter(s=>s.channel===salesFilter.channel);
  if(salesFilter.q){
    const q=salesFilter.q;
    rows = rows.filter(s=>{
      const name=((productById(s.productId)||{}).name||s.itemName||"").toLowerCase();
      return name.includes(q)||(s.customer||"").toLowerCase().includes(q)||(s.staff||"").toLowerCase().includes(q);
    });
  }
  rows.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const cols=[
    {label:"Date",render:s=>fmtDate(s.date)},
    {label:"Product",render:s=>esc((productById(s.productId)||{}).name||s.itemName||"—")},
    {label:"Qty",num:true,render:s=>num(s.qty)},
    {label:"Price",num:true,render:s=>money(s.price)},
    {label:"Total",num:true,render:s=>`<strong>${money(saleTotal(s))}</strong>`},
    {label:"Profit",num:true,render:s=>`<span class="${saleProfit(s)>=0?"pos":"neg"}">${money(saleProfit(s))}</span>`},
    {label:"Channel",render:s=>esc(s.channel||"—")},
    {label:"Customer",render:s=>esc(s.customer||"—")},
    {label:"Sold by",render:s=>esc(s.staff||"—")},
    {label:"Payment",render:s=>payBadge(s.payStatus)},
    {label:"",render:s=>`<div class="row-actions">
      <button class="icon-btn" onclick="openInvoice('${s.id}')" title="Invoice / bill">🧾</button>
      <button class="icon-btn" onclick="editRow('sale','${s.id}')" title="Edit">✏️</button>
      <button class="icon-btn del" onclick="deleteRow('sale','${s.id}')" title="Delete">🗑️</button></div>`}
  ];
  $("#salesTable").innerHTML = tableHTML(cols, rows);
}
function saleForm(id){
  const s = id? DATA.sales.find(x=>x.id===id) : {date:today(),qty:1,payStatus:"Paid",discount:0,paid:0,staff:me().name};
  buildForm([
    {name:"date",label:"Date",type:"date",value:s.date,required:true},
    {name:"productId",label:"Product (from inventory)",type:"select",value:s.productId,placeholder:"— Select / or type below —",
      options:DATA.products.map(p=>({value:p.id,label:`${p.name} (stock ${stockOf(p)})`}))},
    {name:"itemName",label:"Or item name (if not in inventory)",value:s.itemName,placeholder:"e.g. Custom RC build"},
    {name:"qty",label:"Quantity",type:"number",step:"1",value:s.qty,required:true},
    {name:"price",label:"Selling price (per unit)",type:"number",value:s.price,required:true},
    {name:"cost",label:"Cost price/unit (for profit)",type:"number",value:s.costAtSale,placeholder:"Auto-filled if product picked"},
    {name:"discount",label:"Discount (total)",type:"number",value:s.discount},
    ...(DATA.settings.enableGST?[{name:"gstRate",label:`GST % ${DATA.settings.gstInclusive?"(price incl.)":"(added on top)"}`,type:"number",value:s.gstRate!=null?s.gstRate:DATA.settings.gstRate}]:[]),
    {name:"channel",label:"Sold where (channel)",type:"select",value:s.channel,options:DATA.settings.saleChannels,placeholder:"Select",addable:"saleChannels"},
    {name:"customer",label:"Customer",value:s.customer,placeholder:"Name (optional)"},
    {name:"staff",label:"Sold by (staff)",type:"select",value:s.staff,options:DATA.staff.map(x=>x.name),placeholder:"Who made the sale",addable:"staff"},
    {name:"payStatus",label:"Payment status",type:"select",value:s.payStatus,options:["Paid","Partial","Due"]},
    {name:"paid",label:"Amount received",type:"number",value:s.paid},
    {name:"notes",label:"Notes",type:"textarea",value:s.notes,full:true}
  ], (o)=>{
    if(!o.productId && !o.itemName){ toast("Pick a product or type an item name","err"); return; }
    o.qty=Number(o.qty); o.price=Number(o.price); o.discount=Number(o.discount)||0; o.paid=Number(o.paid)||0;
    if(!(o.qty>0)){ toast("Enter a quantity greater than 0","err"); return; }
    if(!(o.price>=0)){ toast("Enter a valid selling price","err"); return; }
    if(o.gstRate!=null && o.gstRate!=="") o.gstRate=Number(o.gstRate);
    // freeze cost-at-sale: product cost if picked, else the typed cost (for one-off items)
    const prod = productById(o.productId);
    o.costAtSale = prod ? (Number(prod.cost)||0) : (Number(o.cost)||0);
    delete o.cost;
    // reconcile paid against the GST-inclusive grand total based on status
    const grand = saleGrand(o);
    if(o.payStatus==="Paid") o.paid = grand;
    else if(o.payStatus==="Due") o.paid = 0;
    else o.paid = Math.min(Math.max(0,o.paid), grand); // Partial: clamp 0..grand
    o.updatedAt = nowISO();
    if(id){
      // revert OLD stock (captured before mutation) then apply NEW
      const old = DATA.sales.find(x=>x.id===id);
      const prevPid = old.productId, prevQty = Number(old.qty)||0;
      adjustStock(prevPid, +prevQty);
      Object.assign(old,o);
      adjustStock(o.productId, -(Number(o.qty)||0));
    }else{
      o.id=nextId();
      DATA.sales.push(o);
      adjustStock(o.productId, -(Number(o.qty)||0));
      maybeAddCustomer(o.customer);
    }
    save(); closeModal(); toast("Sale saved","ok");
    if(currentView==="sales") drawSales(); else go(currentView);
  }, "Save Sale", id?"Edit Sale":"New Sale");
}

/* ============================================================
   PURCHASES
   ============================================================ */
let purFilter={q:"",from:"",to:""};
function renderPurchases(){
  addTopAction("➕ New Purchase","btn-primary",()=>purchaseForm());
  addTopAction("⬇️ Export CSV","",()=>exportCSV("purchases"));
  $("#content").innerHTML = `<div class="panel">
    <div class="filters">
      <div class="field search"><label>Search</label><input id="pQ" placeholder="Product / supplier / staff..." value="${esc(purFilter.q)}"></div>
      <div class="field"><label>From</label><input type="date" id="pFrom" value="${purFilter.from}"></div>
      <div class="field"><label>To</label><input type="date" id="pTo" value="${purFilter.to}"></div>
    </div><div id="purTable"></div></div>`;
  const apply=()=>{ purFilter={q:$("#pQ").value.toLowerCase(),from:$("#pFrom").value,to:$("#pTo").value}; drawPurchases(); };
  ["pQ","pFrom","pTo"].forEach(id=>$("#"+id).oninput=apply);
  drawPurchases();
}
function drawPurchases(){
  let rows = rangeFilter(DATA.purchases, purFilter.from, purFilter.to);
  if(purFilter.q){ const q=purFilter.q; rows=rows.filter(p=>{
    const name=((productById(p.productId)||{}).name||p.itemName||"").toLowerCase();
    return name.includes(q)||(p.supplier||"").toLowerCase().includes(q)||(p.staff||"").toLowerCase().includes(q);});}
  rows.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const cols=[
    {label:"Date",render:p=>fmtDate(p.date)},
    {label:"Product",render:p=>esc((productById(p.productId)||{}).name||p.itemName||"—")},
    {label:"Qty",num:true,render:p=>num(p.qty)},
    {label:"Cost/unit",num:true,render:p=>money(p.price)},
    {label:"Shipping",num:true,render:p=>money(p.shipping)},
    {label:"Total",num:true,render:p=>`<strong>${money(purchaseTotal(p))}</strong>`},
    {label:"Supplier",render:p=>esc(p.supplier||"—")},
    {label:"Bought by",render:p=>esc(p.staff||"—")},
    {label:"Payment",render:p=>payBadge(p.payStatus)},
    {label:"",render:p=>rowActions("purchase",p.id)}
  ];
  $("#purTable").innerHTML = tableHTML(cols,rows);
}
function purchaseForm(id){
  const p = id? DATA.purchases.find(x=>x.id===id):{date:today(),qty:1,payStatus:"Paid",shipping:0,paid:0,staff:me().name};
  buildForm([
    {name:"date",label:"Date",type:"date",value:p.date,required:true},
    {name:"productId",label:"Product (from inventory)",type:"select",value:p.productId,placeholder:"— Select / or type below —",
      options:DATA.products.map(pr=>({value:pr.id,label:pr.name}))},
    {name:"itemName",label:"Or new item name",value:p.itemName,placeholder:"Creates a new product if not selected above"},
    {name:"qty",label:"Quantity",type:"number",step:"1",value:p.qty,required:true},
    {name:"price",label:"Cost price (per unit)",type:"number",value:p.price,required:true},
    {name:"shipping",label:"Shipping / other cost",type:"number",value:p.shipping},
    {name:"supplier",label:"Supplier / bought from",type:"select",value:p.supplier,options:DATA.suppliers.map(s=>s.name),placeholder:"Select",addable:"suppliers"},
    {name:"staff",label:"Bought by (spent by whom)",type:"select",value:p.staff,options:DATA.staff.map(x=>x.name),placeholder:"Who made the purchase",addable:"staff"},
    {name:"payStatus",label:"Payment status",type:"select",value:p.payStatus,options:["Paid","Partial","Due"]},
    {name:"paid",label:"Amount paid",type:"number",value:p.paid},
    {name:"notes",label:"Notes",type:"textarea",value:p.notes,full:true}
  ],(o)=>{
    if(!o.productId && !o.itemName){ toast("Pick a product or type an item name","err"); return; }
    o.qty=Number(o.qty);o.price=Number(o.price);o.shipping=Number(o.shipping)||0;o.paid=Number(o.paid)||0;
    if(!(o.qty>0)){ toast("Enter a quantity greater than 0","err"); return; }
    if(!(o.price>=0)){ toast("Enter a valid cost price","err"); return; }
    // reconcile paid against total based on status
    const ptot = purchaseTotal(o);
    if(o.payStatus==="Paid") o.paid=ptot;
    else if(o.payStatus==="Due") o.paid=0;
    else o.paid=Math.min(Math.max(0,o.paid), ptot);
    o.updatedAt = nowISO();
    // create product if typed new name
    if(!o.productId && o.itemName){
      const np={id:nextId(),name:o.itemName,category:"",cost:o.price,price:0,stock:0,reorder:DATA.settings.lowStockDefault,supplier:o.supplier||"",updatedAt:nowISO()};
      DATA.products.push(np); o.productId=np.id;
    }
    if(id){
      const old=DATA.purchases.find(x=>x.id===id);
      const prevPid=old.productId, prevQty=Number(old.qty)||0;
      adjustStock(prevPid, -prevQty);
      Object.assign(old,o);
      adjustStock(o.productId, +(Number(o.qty)||0));
      maybeUpdateProductCost(o.productId, o.date, o.price);
    }else{
      o.id=nextId(); DATA.purchases.push(o);
      adjustStock(o.productId, +(Number(o.qty)||0));
      maybeUpdateProductCost(o.productId, o.date, o.price);
      maybeAddSupplier(o.supplier);
    }
    save();closeModal();toast("Purchase saved","ok");
    if(currentView==="purchases") drawPurchases(); else go(currentView);
  },"Save Purchase", id?"Edit Purchase":"New Purchase");
}

/* ============================================================
   EXPENSES
   ============================================================ */
let expFilter={q:"",from:"",to:"",cat:""};
function renderExpenses(){
  addTopAction("➕ New Expense","btn-primary",()=>expenseForm());
  addTopAction("⬇️ Export CSV","",()=>exportCSV("expenses"));
  $("#content").innerHTML=`<div class="panel">
    <div class="filters">
      <div class="field search"><label>Search</label><input id="eQ" placeholder="Note / paid by..." value="${esc(expFilter.q)}"></div>
      <div class="field"><label>Category</label><select id="eCat"><option value="">All</option>${DATA.settings.expenseCategories.map(x=>`<option ${expFilter.cat===x?"selected":""}>${esc(x)}</option>`).join("")}</select></div>
      <div class="field"><label>From</label><input type="date" id="eFrom" value="${expFilter.from}"></div>
      <div class="field"><label>To</label><input type="date" id="eTo" value="${expFilter.to}"></div>
    </div><div id="expTable"></div></div>`;
  const apply=()=>{expFilter={q:$("#eQ").value.toLowerCase(),cat:$("#eCat").value,from:$("#eFrom").value,to:$("#eTo").value};drawExpenses();};
  ["eQ","eCat","eFrom","eTo"].forEach(id=>$("#"+id).oninput=apply);
  drawExpenses();
}
function drawExpenses(){
  let rows=rangeFilter(DATA.expenses,expFilter.from,expFilter.to);
  if(expFilter.cat) rows=rows.filter(e=>e.category===expFilter.cat);
  if(expFilter.q){const q=expFilter.q;rows=rows.filter(e=>(e.notes||"").toLowerCase().includes(q)||(e.staff||"").toLowerCase().includes(q));}
  rows.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const total=sumBy(rows,e=>e.amount);
  const cols=[
    {label:"Date",render:e=>fmtDate(e.date)},
    {label:"Category",render:e=>esc(e.category||"—")},
    {label:"Amount",num:true,render:e=>`<strong>${money(e.amount)}</strong>`},
    {label:"Paid by",render:e=>esc(e.staff||"—")},
    {label:"Payment mode",render:e=>esc(e.mode||"—")},
    {label:"Notes",render:e=>esc(e.notes||"—")},
    {label:"",render:e=>rowActions("expense",e.id)}
  ];
  $("#expTable").innerHTML = `<div style="margin-bottom:12px;color:var(--muted);font-size:13px">Showing total: <strong style="color:var(--text)">${money(total)}</strong></div>`+tableHTML(cols,rows);
}
function expenseForm(id){
  const e=id?DATA.expenses.find(x=>x.id===id):{date:today(),staff:me().name};
  buildForm([
    {name:"date",label:"Date",type:"date",value:e.date,required:true},
    {name:"category",label:"Category",type:"select",value:e.category,options:DATA.settings.expenseCategories,required:true,placeholder:"Select",addable:"expenseCategories"},
    {name:"amount",label:"Amount",type:"number",value:e.amount,required:true},
    {name:"staff",label:"Paid by (spent by whom)",type:"select",value:e.staff,options:DATA.staff.map(x=>x.name),placeholder:"Who spent it",addable:"staff"},
    {name:"mode",label:"Payment mode",type:"select",value:e.mode,options:["Cash","UPI","Card","Bank Transfer","Cheque"],placeholder:"Select"},
    {name:"notes",label:"Notes",type:"textarea",value:e.notes,full:true}
  ],(o)=>{
    o.amount=Number(o.amount);
    if(!(o.amount>0)){ toast("Enter an amount greater than 0","err"); return; }
    o.updatedAt=nowISO();
    if(id) Object.assign(DATA.expenses.find(x=>x.id===id),o);
    else { o.id=nextId(); DATA.expenses.push(o); }
    save();closeModal();toast("Expense saved","ok");
    if(currentView==="expenses") drawExpenses(); else go(currentView);
  },"Save Expense", id?"Edit Expense":"New Expense");
}

/* ============================================================
   INVENTORY
   ============================================================ */
let invFilter={q:"",cat:""};
function renderInventory(){
  addTopAction("➕ Add Product","btn-primary",()=>productForm());
  addTopAction("⬇️ Export CSV","",()=>exportCSV("products"));
  $("#content").innerHTML=`<div class="panel">
    <div class="filters">
      <div class="field search"><label>Search</label><input id="iQ" placeholder="Product name / SKU..." value="${esc(invFilter.q)}"></div>
      <div class="field"><label>Category</label><select id="iCat"><option value="">All</option>${DATA.settings.productCategories.map(x=>`<option ${invFilter.cat===x?"selected":""}>${esc(x)}</option>`).join("")}</select></div>
    </div><div id="invTable"></div></div>`;
  const apply=()=>{invFilter={q:$("#iQ").value.toLowerCase(),cat:$("#iCat").value};drawInventory();};
  ["iQ","iCat"].forEach(id=>$("#"+id).oninput=apply);
  drawInventory();
}
function drawInventory(){
  let rows=[...DATA.products];
  if(invFilter.cat) rows=rows.filter(p=>p.category===invFilter.cat);
  if(invFilter.q){const q=invFilter.q;rows=rows.filter(p=>(p.name||"").toLowerCase().includes(q)||(p.sku||"").toLowerCase().includes(q));}
  rows.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const cols=[
    {label:"Product",render:p=>`<strong>${esc(p.name)}</strong>`},
    {label:"Category",render:p=>esc(p.category||"—")},
    {label:"SKU",render:p=>esc(p.sku||"—")},
    {label:"Stock",num:true,render:p=>{
      const low=stockOf(p)<=(Number(p.reorder)||DATA.settings.lowStockDefault);
      return `<span class="badge ${low?"low":"ok"}">${num(stockOf(p))}</span>`;}},
    {label:"Cost",num:true,render:p=>money(p.cost)},
    {label:"Sell price",num:true,render:p=>money(p.price)},
    {label:"Margin",num:true,render:p=>{const m=(Number(p.price)||0)-(Number(p.cost)||0);return `<span class="${m>=0?"pos":"neg"}">${money(m)}</span>`;}},
    {label:"Stock value",num:true,render:p=>money(stockOf(p)*(Number(p.cost)||0))},
    {label:"Supplier",render:p=>esc(p.supplier||"—")},
    {label:"",render:p=>rowActions("product",p.id)}
  ];
  const totVal=stockValue();
  $("#invTable").innerHTML=`<div style="margin-bottom:12px;color:var(--muted);font-size:13px">Total stock value: <strong style="color:var(--text)">${money(totVal)}</strong></div>`+tableHTML(cols,rows);
}
function productForm(id){
  const p=id?productById(id):{stock:0,reorder:DATA.settings.lowStockDefault};
  buildForm([
    {name:"name",label:"Product name",value:p.name,required:true,full:true,placeholder:"e.g. 1:10 Off-road Buggy"},
    {name:"category",label:"Category",type:"select",value:p.category,options:DATA.settings.productCategories,placeholder:"Select",addable:"productCategories"},
    {name:"sku",label:"SKU / Code",value:p.sku,placeholder:"Optional"},
    {name:"cost",label:"Cost price (per unit)",type:"number",value:p.cost},
    {name:"price",label:"Selling price (per unit)",type:"number",value:p.price},
    {name:"stock",label:"Current stock qty",type:"number",step:"1",value:p.stock},
    {name:"reorder",label:"Low-stock alert at",type:"number",step:"1",value:p.reorder},
    {name:"supplier",label:"Default supplier",type:"select",value:p.supplier,options:DATA.suppliers.map(s=>s.name),placeholder:"Select",addable:"suppliers"}
  ],(o)=>{
    if(!o.name||!o.name.trim()){ toast("Enter a product name","err"); return; }
    o.cost=Number(o.cost)||0;o.price=Number(o.price)||0;o.stock=Number(o.stock)||0;o.reorder=Number(o.reorder)||0;
    o.updatedAt=nowISO();
    if(id) Object.assign(productById(id),o);
    else { o.id=nextId(); DATA.products.push(o); }
    save();closeModal();toast("Product saved","ok");drawInventory&&(currentView==="inventory"?drawInventory():go(currentView));
  },"Save Product", id?"Edit Product":"Add Product");
}
function adjustStock(productId, delta){
  const p=productById(productId);
  if(p){ p.stock=(Number(p.stock)||0)+delta; p.updatedAt=nowISO(); }
}
// Only let the MOST RECENT purchase set the product's current cost, so
// correcting an old purchase doesn't clobber today's inventory cost.
function maybeUpdateProductCost(productId, date, price){
  const pr=productById(productId); if(!pr) return;
  const latest=DATA.purchases
    .filter(x=>x.productId===productId)
    .reduce((acc,x)=> (!acc || (x.date||"")>=(acc.date||"")) ? x : acc, null);
  if(!latest || (date||"")>=(latest.date||"")){ pr.cost=Number(price)||0; pr.updatedAt=nowISO(); }
}

/* ---------- Invoice / bill ---------- */
window.openInvoice=(saleId)=>{
  const s=DATA.sales.find(x=>x.id===saleId); if(!s) return;
  if(!s.invoiceNo){ s.invoiceNo="INV-"+String(DATA.settings.invoiceSeq++).padStart(4,"0"); save(); if(currentView==="sales") drawSales(); }
  const st=DATA.settings;
  const item=(productById(s.productId)||{}).name||s.itemName||"Item";
  const gstOn=st.enableGST && gstRateOf(s)>0;
  const taxable=saleTaxable(s), gst=saleGST(s), grand=saleGrand(s);
  const half=gst/2, rate=gstRateOf(s);
  const C=v=>esc(money(v));
  const rows=`
    <tr><td>${esc(item)}</td><td class="r">${num(s.qty)}</td><td class="r">${C(Number(s.price)||0)}</td>
        ${s.discount?`<td class="r">-${C(s.discount)}</td>`:`<td class="r">—</td>`}<td class="r">${C(taxable)}</td></tr>`;
  const gstBlock=gstOn?`
    <tr><td colspan="4" class="r">Taxable value</td><td class="r">${C(taxable)}</td></tr>
    <tr><td colspan="4" class="r">CGST @ ${rate/2}%</td><td class="r">${C(half)}</td></tr>
    <tr><td colspan="4" class="r">SGST @ ${rate/2}%</td><td class="r">${C(half)}</td></tr>`:"";
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.invoiceNo)}</title>
  <style>
    *{font-family:Arial,Helvetica,sans-serif;box-sizing:border-box}
    body{margin:0;padding:28px;color:#111;background:#fff}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #5b6cff;padding-bottom:14px}
    .biz h1{margin:0 0 4px;font-size:22px;color:#5b6cff}
    .biz div,.meta div{font-size:12px;color:#444;line-height:1.5}
    .meta{text-align:right}
    .title{font-size:26px;font-weight:800;letter-spacing:2px;color:#222;margin:0}
    .parties{display:flex;justify-content:space-between;margin:20px 0}
    .parties h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;color:#888}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
    th,td{padding:9px 10px;border-bottom:1px solid #e3e3e3;text-align:left}
    th{background:#f3f4ff;color:#333;font-size:11px;text-transform:uppercase}
    td.r,th.r{text-align:right}
    .grand{font-size:18px;font-weight:800;color:#5b6cff}
    .foot{margin-top:26px;font-size:12px;color:#666;border-top:1px solid #eee;padding-top:12px}
    .pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#eaf7ee;color:#1a7f37}
    @media print{.noprint{display:none}}
    .noprint{margin-top:20px}
    .btn{background:#5b6cff;color:#fff;border:0;padding:10px 18px;border-radius:8px;font-weight:700;cursor:pointer}
  </style></head><body>
    <div class="head">
      <div class="biz">
        <h1>${esc(st.businessName||"PRC Sales App")}</h1>
        ${st.address?`<div>${esc(st.address)}</div>`:""}
        ${st.phone?`<div>📞 ${esc(st.phone)}</div>`:""}
        ${st.gstin?`<div>GSTIN: ${esc(st.gstin)}</div>`:""}
      </div>
      <div class="meta">
        <p class="title">INVOICE</p>
        <div><strong>${esc(s.invoiceNo)}</strong></div>
        <div>Date: ${esc(fmtDate(s.date))}</div>
      </div>
    </div>
    <div class="parties">
      <div><h4>Billed To</h4><div><strong>${esc(s.customer||"Walk-in Customer")}</strong></div></div>
      <div style="text-align:right"><h4>Sold By</h4><div>${esc(s.staff||"")}</div><div>${esc(s.channel||"")}</div></div>
    </div>
    <table>
      <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc</th><th class="r">Amount</th></tr></thead>
      <tbody>
        ${rows}
        ${gstBlock}
        <tr><td colspan="4" class="r grand">Grand Total</td><td class="r grand">${C(grand)}</td></tr>
        <tr><td colspan="4" class="r">Paid (${esc(s.payStatus||"Paid")})</td><td class="r">${C(s.paid||0)}</td></tr>
        ${(grand-(Number(s.paid)||0))>0?`<tr><td colspan="4" class="r">Balance due</td><td class="r"><strong>${C(grand-(Number(s.paid)||0))}</strong></td></tr>`:""}
      </tbody>
    </table>
    ${s.notes?`<div class="foot">Note: ${esc(s.notes)}</div>`:""}
    <div class="foot">Thank you for your business! ${gstOn?"":'<span class="pill">No GST</span>'}</div>
    <div class="noprint"><button class="btn" onclick="window.print()">🖨️ Print / Save as PDF</button></div>
  </body></html>`;
  const w=window.open("","_blank");
  if(!w){ toast("Allow pop-ups to view the invoice","err"); return; }
  w.document.open(); w.document.write(html); w.document.close();
};

/* ============================================================
   CUSTOMERS / SUPPLIERS / STAFF  (contacts)
   ============================================================ */
function renderContacts(kind, listKey, extraFields){
  const labels={customers:"Customer",suppliers:"Supplier",staff:"Staff member"};
  addTopAction("➕ Add "+labels[kind],"btn-primary",()=>contactForm(kind,listKey,extraFields));
  const c=$("#content");
  const list=DATA[listKey];
  let statCols;
  if(kind==="customers"){
    statCols=[
      {label:"Name",render:x=>`<strong>${esc(x.name)}</strong>`},
      {label:"Phone",render:x=>esc(x.phone||"—")},
      {label:"Total bought",num:true,render:x=>money(sumBy(DATA.sales.filter(s=>s.customer===x.name),saleTotal))},
      {label:"Orders",num:true,render:x=>num(DATA.sales.filter(s=>s.customer===x.name).length)},
      {label:"Due",num:true,render:x=>money(sumBy(DATA.sales.filter(s=>s.customer===x.name),saleDue))},
      {label:"Notes",render:x=>esc(x.notes||"—")},
      {label:"",render:x=>rowActions(kind,x.id)}
    ];
  }else if(kind==="suppliers"){
    statCols=[
      {label:"Name",render:x=>`<strong>${esc(x.name)}</strong>`},
      {label:"Phone",render:x=>esc(x.phone||"—")},
      {label:"Total purchased",num:true,render:x=>money(sumBy(DATA.purchases.filter(p=>p.supplier===x.name),purchaseTotal))},
      {label:"Orders",num:true,render:x=>num(DATA.purchases.filter(p=>p.supplier===x.name).length)},
      {label:"Owed",num:true,render:x=>money(sumBy(DATA.purchases.filter(p=>p.supplier===x.name),purchaseDue))},
      {label:"Notes",render:x=>esc(x.notes||"—")},
      {label:"",render:x=>rowActions(kind,x.id)}
    ];
  }else{
    statCols=[
      {label:"Name",render:x=>`<strong>${esc(x.name)}</strong>`},
      {label:"Role",render:x=>esc(x.role||"—")},
      {label:"Phone",render:x=>esc(x.phone||"—")},
      {label:"Sales made",num:true,render:x=>money(sumBy(DATA.sales.filter(s=>s.staff===x.name),saleTotal))},
      {label:"Expenses spent",num:true,render:x=>money(sumBy(DATA.expenses.filter(e=>e.staff===x.name),e=>e.amount)+sumBy(DATA.purchases.filter(p=>p.staff===x.name),purchaseTotal))},
      {label:"Notes",render:x=>esc(x.notes||"—")},
      {label:"",render:x=>rowActions(kind,x.id)}
    ];
  }
  c.innerHTML=`<div class="panel">${tableHTML(statCols, [...list].sort((a,b)=>(a.name||"").localeCompare(b.name||"")))}</div>`;
}
function renderCustomers(){ renderContacts("customers","customers"); }
function renderSuppliers(){ renderContacts("suppliers","suppliers"); }
function renderStaff(){ renderContacts("staff","staff"); }

function contactForm(kind, listKey, _x, id){
  const labels={customers:"Customer",suppliers:"Supplier",staff:"Staff member"};
  const list=DATA[listKey];
  const x=id?list.find(i=>i.id===id):{};
  const fields=[
    {name:"name",label:"Name",value:x.name,required:true,full:true},
    {name:"phone",label:"Phone",value:x.phone},
  ];
  if(kind==="staff") fields.push({name:"role",label:"Role",value:x.role,placeholder:"e.g. Sales / Mechanic"});
  else fields.push({name:"email",label:"Email / Address",value:x.email});
  fields.push({name:"notes",label:"Notes",type:"textarea",value:x.notes,full:true});
  buildForm(fields,(o)=>{
    if(!o.name||!o.name.trim()){ toast("Enter a name","err"); return; }
    o.updatedAt=nowISO();
    if(id) Object.assign(list.find(i=>i.id===id),o);
    else { o.id=nextId(); list.push(o); }
    save();closeModal();toast(labels[kind]+" saved","ok");go(currentView);
  },"Save", id?("Edit "+labels[kind]):("Add "+labels[kind]));
}
function maybeAddCustomer(name){
  if(name && !DATA.customers.some(c=>c.name===name)) DATA.customers.push({id:nextId(),name,updatedAt:nowISO()});
}
function maybeAddSupplier(name){
  if(name && !DATA.suppliers.some(s=>s.name===name)) DATA.suppliers.push({id:nextId(),name,updatedAt:nowISO()});
}

/* ============================================================
   REPORTS
   ============================================================ */
let repRange={from:"",to:""};
function renderReports(){
  addTopAction("🖨️ Print / PDF","",()=>window.print());
  const c=$("#content");
  c.innerHTML=`<div class="panel">
    <div class="filters">
      <div class="field"><label>From</label><input type="date" id="rFrom" value="${repRange.from}"></div>
      <div class="field"><label>To</label><input type="date" id="rTo" value="${repRange.to}"></div>
      <button class="btn btn-primary" id="rApply">Apply</button>
      <button class="btn" id="rThisMonth">This Month</button>
      <button class="btn" id="rThisYear">This Year</button>
      <button class="btn" id="rAll">All Time</button>
    </div>
  </div><div id="repBody"></div>`;
  $("#rApply").onclick=()=>{repRange={from:$("#rFrom").value,to:$("#rTo").value};drawReport();};
  $("#rThisMonth").onclick=()=>{const m=today().slice(0,7);repRange={from:m+"-01",to:m+"-31"};$("#rFrom").value=repRange.from;$("#rTo").value=repRange.to;drawReport();};
  $("#rThisYear").onclick=()=>{const y=today().slice(0,4);repRange={from:y+"-01-01",to:y+"-12-31"};$("#rFrom").value=repRange.from;$("#rTo").value=repRange.to;drawReport();};
  $("#rAll").onclick=()=>{repRange={from:"",to:""};$("#rFrom").value="";$("#rTo").value="";drawReport();};
  drawReport();
}
function drawReport(){
  const sales=rangeFilter(DATA.sales,repRange.from,repRange.to);
  const purchases=rangeFilter(DATA.purchases,repRange.from,repRange.to);
  const expenses=rangeFilter(DATA.expenses,repRange.from,repRange.to);

  const revenue=sumBy(sales,saleTotal);
  const cogs=sumBy(sales,saleCost);
  const gross=revenue-cogs;
  const exp=sumBy(expenses,e=>e.amount);
  const net=gross-exp;
  const purTotal=sumBy(purchases,purchaseTotal);

  // expense breakdown
  const byCat={};
  expenses.forEach(e=>{byCat[e.category||"Misc"]=(byCat[e.category||"Misc"]||0)+(Number(e.amount)||0);});
  const catArr=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const maxCat=Math.max(1,...catArr.map(c=>c[1]));

  // staff spend
  const byStaff={};
  expenses.forEach(e=>{if(e.staff)byStaff[e.staff]=(byStaff[e.staff]||0)+(Number(e.amount)||0);});
  purchases.forEach(p=>{if(p.staff)byStaff[p.staff]=(byStaff[p.staff]||0)+purchaseTotal(p);});
  const staffArr=Object.entries(byStaff).sort((a,b)=>b[1]-a[1]);
  const maxStaff=Math.max(1,...staffArr.map(c=>c[1]));

  const rangeLabel = (repRange.from||repRange.to)? `${repRange.from?fmtDate(repRange.from):"start"} → ${repRange.to?fmtDate(repRange.to):"today"}` : "All time";

  $("#repBody").innerHTML=`
  <div class="panel">
    <div class="panel-head"><h3>Profit &amp; Loss — ${rangeLabel}</h3></div>
    <div class="table-wrap"><table style="min-width:auto">
      <tbody>
        <tr><td>Revenue (sales)</td><td class="num"><strong>${money(revenue)}</strong></td></tr>
        <tr><td>− Cost of goods sold</td><td class="num neg">${money(cogs)}</td></tr>
        <tr><td><strong>= Gross profit</strong></td><td class="num"><strong>${money(gross)}</strong></td></tr>
        <tr><td>− Operating expenses</td><td class="num neg">${money(exp)}</td></tr>
        <tr style="background:var(--panel-2)"><td><strong>= Net profit</strong></td><td class="num"><strong class="${net>=0?"pos":"neg"}">${money(net)}</strong></td></tr>
      </tbody>
    </table></div>
    <div style="margin-top:12px;color:var(--muted);font-size:12px">Stock purchased in period: ${money(purTotal)} · Sales count: ${sales.length} · Profit margin: ${revenue?((net/revenue*100).toFixed(1)):0}%</div>
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel-head"><h3>Expenses by Category</h3></div>
      ${catArr.length?catArr.map(([n,v])=>`<div class="bar-row"><div class="lbl" style="width:110px">${esc(n)}</div><div class="bar-track"><div class="bar-fill red" style="width:${v/maxCat*100}%"></div></div><div class="val">${money(v)}</div></div>`).join(""):`<div class="empty">No expenses in range</div>`}
    </div>
    <div class="panel"><div class="panel-head"><h3>Spending by Person</h3></div>
      ${staffArr.length?staffArr.map(([n,v])=>`<div class="bar-row"><div class="lbl" style="width:110px">${esc(n)}</div><div class="bar-track"><div class="bar-fill" style="width:${v/maxStaff*100}%"></div></div><div class="val">${money(v)}</div></div>`).join(""):`<div class="empty">No spend recorded by person</div>`}
    </div>
  </div>`;
}

/* ============================================================
   SETTINGS
   ============================================================ */
function renderSettings(){
  const c=$("#content");
  const s=DATA.settings;
  c.innerHTML=`
  <div class="panel">
    <div class="panel-head"><h3>Appearance</h3></div>
    <div class="seg" id="themeSeg">
      <button data-t="light">☀️ Light</button>
      <button data-t="dark">🌙 Dark</button>
      <button data-t="system">💻 System</button>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h3>Business Profile</h3></div>
    <div class="form-grid">
      <div class="field"><label>Business name</label><input id="setName" value="${esc(s.businessName)}"></div>
      <div class="field"><label>Currency symbol</label><input id="setCur" value="${esc(s.currency)}"></div>
      <div class="field"><label>Phone</label><input id="setPhone" value="${esc(s.phone||"")}"></div>
      <div class="field"><label>Default low-stock alert</label><input type="number" id="setLow" value="${esc(s.lowStockDefault)}"></div>
      <div class="field full"><label>Address (shown on invoices)</label><input id="setAddr" value="${esc(s.address||"")}"></div>
    </div>
    <div class="panel-head" style="margin-top:20px"><h3 style="font-size:14px">GST &amp; Invoices</h3></div>
    <div class="form-grid">
      <div class="field"><label>Enable GST on invoices?</label><select id="setGstOn"><option value="no" ${!s.enableGST?"selected":""}>No</option><option value="yes" ${s.enableGST?"selected":""}>Yes</option></select></div>
      <div class="field"><label>GSTIN</label><input id="setGstin" value="${esc(s.gstin||"")}" placeholder="22ABCDE1234F1Z5"></div>
      <div class="field"><label>Default GST rate (%)</label><input type="number" id="setGstRate" value="${esc(s.gstRate!=null?s.gstRate:18)}"></div>
      <div class="field"><label>Are your prices GST-inclusive?</label><select id="setGstIncl"><option value="no" ${!s.gstInclusive?"selected":""}>No — add GST on top</option><option value="yes" ${s.gstInclusive?"selected":""}>Yes — price already includes GST</option></select></div>
    </div>
    <div class="form-actions" style="justify-content:flex-start"><button class="btn btn-primary" id="saveProfile">Save profile</button></div>
  </div>

  <div class="panel" id="usersPanel">
    <div class="panel-head"><h3>Login IDs / Users</h3><button class="btn btn-primary btn-sm" id="addUser">➕ Add login</button></div>
    <p style="color:var(--muted);font-size:13px;margin-bottom:14px">Create a login for each staff member. <strong>Admins</strong> can manage settings &amp; users; <strong>staff</strong> can record sales, purchases &amp; expenses.</p>
    <div id="usersTable"></div>
  </div>

  <div class="grid-2">
    <div class="panel"><div class="panel-head"><h3>Sale Channels</h3></div>
      <div id="chList"></div>
      <div class="filters" style="margin-top:10px"><input class="field" id="newCh" placeholder="Add channel..."><button class="btn" id="addCh">Add</button></div>
    </div>
    <div class="panel"><div class="panel-head"><h3>Expense Categories</h3></div>
      <div id="catList"></div>
      <div class="filters" style="margin-top:10px"><input class="field" id="newCat" placeholder="Add category..."><button class="btn" id="addCat">Add</button></div>
    </div>
  </div>

  <div class="panel"><div class="panel-head"><h3>Product Categories</h3></div>
    <div id="pcatList"></div>
    <div class="filters" style="margin-top:10px"><input class="field" id="newPcat" placeholder="Add product category..."><button class="btn" id="addPcat">Add</button></div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Backup &amp; Data</h3></div>
    <p style="color:var(--muted);font-size:13px;margin-bottom:14px">Your data lives in this browser only. Download a backup regularly and keep it safe. To move to a new computer, restore the backup file there.</p>
    <div class="row-actions" style="flex-wrap:wrap;gap:10px">
      <button class="btn btn-primary" id="btnBackup">⬇️ Download backup (JSON)</button>
      <button class="btn" id="btnRestore">⬆️ Restore from backup</button>
      <button class="btn" id="btnSeed">🧪 Load sample data</button>
      <button class="btn btn-danger" id="btnReset">🗑️ Erase everything</button>
    </div>
    <input type="file" id="restoreFile" accept="application/json" style="display:none">
  </div>`;

  // theme segmented control
  const seg=$("#themeSeg");
  const paintSeg=()=>{ const t=getTheme(); $$("#themeSeg button").forEach(b=>b.classList.toggle("on", b.dataset.t===t)); };
  paintSeg();
  $$("#themeSeg button").forEach(b=>b.onclick=()=>{ buzz(); setTheme(b.dataset.t); paintSeg(); });

  $("#saveProfile").onclick=()=>{
    s.businessName=$("#setName").value||"PRC Sales App";
    s.currency=$("#setCur").value||"₹";
    s.phone=$("#setPhone").value;
    s.address=$("#setAddr").value;
    s.lowStockDefault=Number($("#setLow").value)||3;
    s.enableGST=$("#setGstOn").value==="yes";
    s.gstin=$("#setGstin").value;
    s.gstRate=Number($("#setGstRate").value)||0;
    s.gstInclusive=$("#setGstIncl").value==="yes";
    s.updatedAt=nowISO();
    save();applyBranding();toast("Profile saved","ok");
  };

  // Users
  if(!isAdmin()){ $("#usersPanel").style.display="none"; }
  else { $("#addUser").onclick=()=>userForm(); drawUsers(); }
  renderChips("chList","saleChannels");
  renderChips("catList","expenseCategories");
  renderChips("pcatList","productCategories");
  $("#addCh").onclick=()=>addChip("saleChannels","newCh","chList");
  $("#addCat").onclick=()=>addChip("expenseCategories","newCat","catList");
  $("#addPcat").onclick=()=>addChip("productCategories","newPcat","pcatList");

  $("#btnBackup").onclick=backup;
  $("#btnRestore").onclick=()=>$("#restoreFile").click();
  $("#restoreFile").onchange=restore;
  $("#btnSeed").onclick=()=>{ if(confirm("Load sample data? This adds demo records on top of what you have.")) seed(); };
  $("#btnReset").onclick=()=>{ if(confirm("This erases ALL your data permanently. Make a backup first. Continue?")){ DATA=defaultData();DATA.settings.updatedAt=nowISO();save();applyBranding();toast("All data erased");logout(); } };
}
function renderChips(elId, key){
  const el=$("#"+elId);
  el.innerHTML=DATA.settings[key].map((x,i)=>`<span class="badge ok" style="margin:3px;padding:6px 10px;font-size:12px">${esc(x)} <a href="#" data-i="${i}" style="color:#fca5a5;text-decoration:none;margin-left:4px">✕</a></span>`).join("")||`<span style="color:var(--muted);font-size:13px">None yet</span>`;
  $$("a[data-i]",el).forEach(a=>a.onclick=(e)=>{e.preventDefault();DATA.settings[key].splice(Number(a.dataset.i),1);DATA.settings.updatedAt=nowISO();save();renderChips(elId,key);});
}
function addChip(key, inputId, elId){
  const v=$("#"+inputId).value.trim();
  if(v && !DATA.settings[key].includes(v)){ DATA.settings[key].push(v); DATA.settings.updatedAt=nowISO(); save(); $("#"+inputId).value=""; renderChips(elId,key); }
}

/* ---------- Users ---------- */
function drawUsers(){
  const cols=[
    {label:"Name",render:u=>`<strong>${esc(u.name)}</strong>${u.id===me().id?' <span class="badge ok">you</span>':""}`},
    {label:CLOUD?"Email":"Username",render:u=>esc(u.email||u.username||"—")},
    {label:"Role",render:u=>`<span class="badge ${u.role==="admin"?"partial":"ok"}">${esc(u.role)}</span>`},
    {label:"",render:u=>`<div class="row-actions">
      <button class="icon-btn" onclick="userForm('${u.id}')" title="Edit">✏️</button>
      <button class="icon-btn del" onclick="deleteUser('${u.id}')" title="Delete">🗑️</button></div>`}
  ];
  $("#usersTable").innerHTML = tableHTML(cols, DATA.users);
}
function userForm(id){
  const u = id? DATA.users.find(x=>x.id===id) : {role:"staff"};
  const fields = CLOUD ? [
    {name:"name",label:"Full name",value:u.name,required:true},
    {name:"email",label:"Login email",type:"email",value:u.email||u.username,required:true,placeholder:"staff@email.com"},
    {name:"role",label:"Role",type:"select",value:u.role,options:["admin","staff"],required:true}
  ] : [
    {name:"name",label:"Full name",value:u.name,required:true},
    {name:"username",label:"Username (for login)",value:u.username,required:true,placeholder:"e.g. ravi"},
    {name:"password",label:"Password",value:u.password,required:true},
    {name:"role",label:"Role",type:"select",value:u.role,options:["admin","staff"],required:true}
  ];
  buildForm(fields,(o)=>{
    const key = CLOUD ? "email" : "username";
    o[key]=String(o[key]||"").trim().toLowerCase();
    const clash=DATA.users.find(x=>String(x[key]||x.username||"").toLowerCase()===o[key] && x.id!==id);
    if(clash){ toast(`That ${key} already exists`,"err"); return; }
    if(id){
      Object.assign(DATA.users.find(x=>x.id===id),o);
      if(me().id===id){ currentUser=DATA.users.find(x=>x.id===id); renderUserMenu(); }
    } else {
      o.id=nextId(); DATA.users.push(o);
      if(!DATA.staff.some(s=>s.name===o.name)) DATA.staff.push({id:nextId(),name:o.name,role:o.role});
    }
    save();closeModal();
    toast(CLOUD?"Staff saved — now create their login in Supabase":"Login saved","ok");
    drawUsers();
  },"Save", id?"Edit Login":"Add Login");
}
window.deleteUser=(id)=>{
  if(id===me().id){ toast("You can't delete your own login","err"); return; }
  const admins=DATA.users.filter(u=>u.role==="admin");
  const target=DATA.users.find(u=>u.id===id);
  if(target.role==="admin" && admins.length<=1){ toast("Keep at least one admin","err"); return; }
  if(!confirm("Delete this login?")) return;
  DATA.users=DATA.users.filter(u=>u.id!==id);
  save();drawUsers();toast("Login deleted");
};

/* ============================================================
   SHARED ROW ACTIONS + DELETE
   ============================================================ */
function rowActions(type, id){
  return `<div class="row-actions">
    <button class="icon-btn" onclick="editRow('${type}','${id}')" title="Edit">✏️</button>
    <button class="icon-btn del" onclick="deleteRow('${type}','${id}')" title="Delete">🗑️</button>
  </div>`;
}
window.editRow=(type,id)=>{
  if(type==="sale") saleForm(id);
  else if(type==="purchase") purchaseForm(id);
  else if(type==="expense") expenseForm(id);
  else if(type==="product") productForm(id);
  else if(type==="customers") contactForm("customers","customers",null,id);
  else if(type==="suppliers") contactForm("suppliers","suppliers",null,id);
  else if(type==="staff") contactForm("staff","staff",null,id);
};
function tomb(id){ if(!DATA.tombstones) DATA.tombstones={}; DATA.tombstones[id]=nowISO(); }
window.deleteRow=(type,id)=>{
  if(type==="product"){
    // don't orphan history: snapshot the name onto referencing rows, block if in use is too strict,
    // so we keep records readable by copying the product name into itemName.
    const p=DATA.products.find(x=>x.id===id);
    const used=DATA.sales.filter(s=>s.productId===id).length + DATA.purchases.filter(pp=>pp.productId===id).length;
    if(used && !confirm(`This product is used in ${used} record(s). Delete it? Those records will keep the name but lose the inventory link.`)) return;
    if(!used && !confirm("Delete this product?")) return;
    if(p){
      DATA.sales.forEach(s=>{ if(s.productId===id && !s.itemName){ s.itemName=p.name; s.updatedAt=nowISO(); } });
      DATA.purchases.forEach(pp=>{ if(pp.productId===id && !pp.itemName){ pp.itemName=p.name; pp.updatedAt=nowISO(); } });
    }
    DATA.products=DATA.products.filter(x=>x.id!==id); tomb(id);
    save();toast("Deleted");go(currentView); return;
  }
  if(!confirm("Delete this entry? This cannot be undone.")) return;
  if(type==="sale"){ const s=DATA.sales.find(x=>x.id===id); if(s) adjustStock(s.productId,+Number(s.qty)||0); DATA.sales=DATA.sales.filter(x=>x.id!==id); }
  else if(type==="purchase"){ const p=DATA.purchases.find(x=>x.id===id); if(p) adjustStock(p.productId,-(Number(p.qty)||0)); DATA.purchases=DATA.purchases.filter(x=>x.id!==id); }
  else if(type==="expense"){ DATA.expenses=DATA.expenses.filter(x=>x.id!==id); }
  else if(type==="customers"){ DATA.customers=DATA.customers.filter(x=>x.id!==id); }
  else if(type==="suppliers"){ DATA.suppliers=DATA.suppliers.filter(x=>x.id!==id); }
  else if(type==="staff"){ DATA.staff=DATA.staff.filter(x=>x.id!==id); }
  tomb(id);
  save();toast("Deleted");go(currentView);
};

/* ============================================================
   IMPORT / EXPORT / BACKUP
   ============================================================ */
function download(filename, text, mime="application/json"){
  const blob=new Blob([text],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function backup(){
  const stamp=new Date().toISOString().slice(0,10);
  download(`rc-business-backup-${stamp}.json`, JSON.stringify(DATA,null,2));
  toast("Backup downloaded","ok");
}
function restore(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const d=JSON.parse(reader.result);
      // thorough validation: every expected collection must be an array
      if(!d || typeof d.settings!=="object" || d.settings===null) throw new Error("not a valid backup");
      for(const k of COLLECTIONS){ if(d[k]!==undefined && !Array.isArray(d[k])) throw new Error("corrupt "+k); }
      if(!Array.isArray(d.sales) || !Array.isArray(d.products)) throw new Error("missing sales/products");
      if(!confirm("Importing will REPLACE all current data on this device with the backup. This cannot be undone. Continue?")){ e.target.value=""; return; }
      // keep a one-step undo of what we're about to overwrite
      try{ localStorage.setItem(STORE_KEY+"_prerestore", localStorage.getItem(STORE_KEY)||""); }catch(_){ }
      DATA=normalize(d);            // deep-merge over defaults: missing settings keys survive
      DATA.settings.updatedAt=nowISO();
      save();applyBranding();
      toast("Backup restored","ok");
      go("dashboard");
    }catch(err){ toast("Couldn't import: "+(err&&err.message||"invalid backup file"),"err"); }
    finally{ e.target.value=""; }   // allow re-selecting the same file
  };
  reader.readAsText(file);
}
function exportCSV(kind){
  let rows=[],head=[];
  if(kind==="sales"){
    head=["Date","Product","Qty","Price","Discount","Total","Profit","Channel","Customer","Sold by","Payment","Received","Notes"];
    rows=DATA.sales.map(s=>[s.date,(productById(s.productId)||{}).name||s.itemName||"",s.qty,s.price,s.discount,saleTotal(s),saleProfit(s),s.channel,s.customer,s.staff,s.payStatus,s.paid,s.notes]);
  }else if(kind==="purchases"){
    head=["Date","Product","Qty","Cost/unit","Shipping","Total","Supplier","Bought by","Payment","Paid","Notes"];
    rows=DATA.purchases.map(p=>[p.date,(productById(p.productId)||{}).name||p.itemName||"",p.qty,p.price,p.shipping,purchaseTotal(p),p.supplier,p.staff,p.payStatus,p.paid,p.notes]);
  }else if(kind==="expenses"){
    head=["Date","Category","Amount","Paid by","Mode","Notes"];
    rows=DATA.expenses.map(e=>[e.date,e.category,e.amount,e.staff,e.mode,e.notes]);
  }else if(kind==="products"){
    head=["Name","Category","SKU","Cost","Sell price","Stock","Reorder","Supplier","Stock value"];
    rows=DATA.products.map(p=>[p.name,p.category,p.sku,p.cost,p.price,p.stock,p.reorder,p.supplier,stockOf(p)*(Number(p.cost)||0)]);
  }
  const csv=[head,...rows].map(r=>r.map(c=>`"${String(c==null?"":c).replace(/"/g,'""')}"`).join(",")).join("\n");
  download(`rc-${kind}-${today()}.csv`, csv, "text/csv");
  toast("CSV exported","ok");
}

/* ============================================================
   SAMPLE DATA
   ============================================================ */
function seed(){
  const mk=(o)=>Object.assign({id:nextId()},o);
  DATA.staff.push(mk({name:"Bharath",role:"Owner",phone:""}),mk({name:"Ravi",role:"Sales",phone:""}));
  const p1=mk({name:"1:10 Off-road Buggy",category:"RC Car",sku:"BUG-10",cost:3200,price:4999,stock:6,reorder:3,supplier:"SpeedHobby Imports"});
  const p2=mk({name:"2.4GHz Remote",category:"Remote",sku:"RMT-24",cost:450,price:899,stock:12,reorder:5,supplier:"SpeedHobby Imports"});
  const p3=mk({name:"LiPo Battery 2200mAh",category:"Battery",sku:"BAT-22",cost:600,price:1199,stock:2,reorder:4,supplier:"PowerCell Co"});
  DATA.products.push(p1,p2,p3);
  DATA.suppliers.push(mk({name:"SpeedHobby Imports",phone:"98xxxxxx01"}),mk({name:"PowerCell Co",phone:"98xxxxxx02"}));
  DATA.customers.push(mk({name:"Arjun",phone:"90xxxxxx10"}),mk({name:"Meena",phone:"90xxxxxx11"}));
  const dm=(off)=>{const d=new Date();d.setDate(d.getDate()-off);return d.toISOString().slice(0,10);};
  DATA.purchases.push(
    mk({date:dm(40),productId:p1.id,qty:10,price:3200,shipping:500,supplier:"SpeedHobby Imports",staff:"Bharath",payStatus:"Paid",paid:32500}),
    mk({date:dm(35),productId:p3.id,qty:8,price:600,shipping:0,supplier:"PowerCell Co",staff:"Bharath",payStatus:"Due",paid:0})
  );
  DATA.sales.push(
    mk({date:dm(20),productId:p1.id,qty:2,price:4999,discount:0,channel:"Shop / Walk-in",customer:"Arjun",staff:"Ravi",payStatus:"Paid",paid:9998,costAtSale:3200}),
    mk({date:dm(10),productId:p3.id,qty:3,price:1199,discount:100,channel:"WhatsApp",customer:"Meena",staff:"Ravi",payStatus:"Partial",paid:2000,costAtSale:600}),
    mk({date:dm(3),productId:p2.id,qty:2,price:899,discount:0,channel:"Instagram",customer:"Arjun",staff:"Bharath",payStatus:"Paid",paid:1798,costAtSale:450})
  );
  DATA.expenses.push(
    mk({date:dm(28),category:"Rent",amount:8000,staff:"Bharath",mode:"Bank Transfer",notes:"Shop rent"}),
    mk({date:dm(15),category:"Marketing",amount:1500,staff:"Ravi",mode:"UPI",notes:"Instagram ads"}),
    mk({date:dm(5),category:"Transport",amount:600,staff:"Bharath",mode:"Cash",notes:"Courier"})
  );
  save();toast("Sample data loaded","ok");go("dashboard");
}

/* ============================================================
   BRANDING + INIT
   ============================================================ */
function applyBranding(){
  $("#brandName").textContent=DATA.settings.businessName||"PRC Sales App";
  document.title=DATA.settings.businessName||"PRC Sales App";
}

/* PWA install prompt */
let deferredPrompt=null;
function setupInstall(){
  const btn=$("#installBtn");
  window.addEventListener("beforeinstallprompt",(e)=>{
    e.preventDefault(); deferredPrompt=e; btn.style.display="block";
  });
  btn.onclick=async()=>{
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt=null; btn.style.display="none";
  };
  window.addEventListener("appinstalled",()=>{ btn.style.display="none"; toast("App installed 🎉","ok"); });
}
function setupFab(){ /* FAB visibility handled in go(); listener wired in init */ }

/* ---------- Theme (light / dark / system) ---------- */
const THEME_KEY="rcbiz_theme";
function getTheme(){ return localStorage.getItem(THEME_KEY) || "system"; }
function applyTheme(t){
  const dark = t==="dark" || (t==="system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute("content", dark? "#000000" : "#000000");
}
function setTheme(t){ localStorage.setItem(THEME_KEY,t); applyTheme(t); }

function renderUserMenu(){
  if(NO_LOGIN){ $("#userMenu").innerHTML=""; return; }
  const u=me();
  const initials=(u.name||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();
  $("#userMenu").innerHTML=`
    <div class="user-chip"><div class="user-avatar">${esc(initials)}</div>
      <div style="line-height:1.2"><div class="user-name">${esc(u.name||"")}</div><div class="user-role">${esc(u.role||"")}</div></div>
    </div>
    <button class="btn btn-sm" id="logoutBtn">Logout</button>`;
  $("#logoutBtn").onclick=logout;
}
function applyRoleGating(){
  // only admins see Settings
  $$(".nav-item").forEach(b=>{ if(b.dataset.view==="settings") b.style.display=isAdmin()?"":"none"; });
}
function showLogin(){
  $("#loginScreen").classList.add("open");
  $("#loginErr").textContent="";
  $("#loginForm").reset();
  $("#loginTitle").textContent=DATA.settings.businessName||"PRC Sales App";
  const lbl = $("#loginUser").previousElementSibling;
  if(CLOUD){
    if(lbl) lbl.textContent="Email";
    $("#loginUser").type="email";
    $("#loginUser").placeholder="you@email.com";
    $("#loginHint").textContent="Use the email & password created for you in Supabase. First login becomes the admin.";
  } else {
    if(lbl) lbl.textContent="Username";
    const hasDefault=DATA.users.some(u=>u.username==="admin"&&u.password==="admin");
    $("#loginHint").textContent=hasDefault?"First time? Use  admin / admin  — then change it in Settings → Login IDs.":"";
  }
  setTimeout(()=>$("#loginUser").focus(),50);
}
function startApp(){
  $("#loginScreen").classList.remove("open");
  applyBranding();
  renderUserMenu();
  applyRoleGating();
  go("dashboard");
}
async function init(){
  // theme first (avoid flash beyond the inline head script)
  applyTheme(getTheme());
  try{ window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{ if(getTheme()==="system") applyTheme("system"); }); }catch(e){}

  $$(".nav-item").forEach(b=>b.onclick=()=>{ buzz(); go(b.dataset.view); });
  $("#modalClose").onclick=closeModal;
  $("#modalOverlay").onclick=(e)=>{ if(e.target.id==="modalOverlay") closeModal(); };
  $("#hamburger").onclick=()=>$(".sidebar").classList.toggle("open");
  $("#quickBackup").onclick=backup;
  const moreBtn=$("#moreBtn"); if(moreBtn) moreBtn.onclick=openMoreSheet;
  const fab=$("#fab"); if(fab) fab.onclick=openQuickAdd;
  setupInstall(); setupFab();
  document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeModal(); });

  $("#loginForm").onsubmit=async (e)=>{
    e.preventDefault();
    const btn=$("#loginForm button[type=submit]");
    if(CLOUD){
      btn.disabled=true; $("#loginErr").textContent="Signing in…";
      const r=await cloudSignIn($("#loginUser").value, $("#loginPass").value);
      btn.disabled=false; $("#loginErr").textContent="";
      if(r.ok) startApp(); else $("#loginErr").textContent=r.msg||"Sign in failed";
    } else {
      if(login($("#loginUser").value, $("#loginPass").value)) startApp();
      else $("#loginErr").textContent="Wrong username or password";
    }
  };

  if(CLOUD){
    window.addEventListener("focus", async ()=>{
      if(currentUser && !$("#modalOverlay").classList.contains("open")){
        await fetchCloud(); if(currentView) go(currentView);
      }
    });
  }

  applyBranding();

  // NO-LOGIN mode: open straight to the dashboard. With SYNC on, pull the latest
  // cloud data first, take a daily auto-backup, and listen for live updates.
  if(NO_LOGIN){
    currentUser = (DATA.users && DATA.users[0]) || { id:"local", name:"Owner", role:"admin" };
    currentUser.role = "admin";
    $("#loginScreen").classList.remove("open");
    if(CLOUD){
      await fetchCloud();
      autoBackup();
      setupRealtime();
    }
    startApp();
    return;
  }

  let restored=false;
  if(CLOUD) restored = await cloudRestore();
  else restored = restoreSession();
  if(restored){ startApp(); if(CLOUD){ autoBackup(); setupRealtime(); } } else showLogin();
}

// Live cross-device updates: when another phone writes, pull + re-render.
let realtimeOn=false;
function setupRealtime(){
  if(!CLOUD || !sb || realtimeOn) return;
  try{
    sb.channel("biz")
      .on("postgres_changes", { event:"*", schema:"public", table:"business_state" }, async ()=>{
        if($("#modalOverlay").classList.contains("open")) return; // don't disrupt an open form
        const changed = await fetchCloud();
        if(changed && currentView) go(currentView);
      })
      .subscribe();
    realtimeOn=true;
  }catch(e){ console.warn("Realtime setup failed", e); }
}
init();
