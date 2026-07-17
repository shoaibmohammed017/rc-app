/* Vercel Serverless Function — pulls orders from Shiprocket and stores them
 * in Supabase as a SINGLE row of the existing `business_state` table
 * (id = 'online_orders'). No dedicated table / DDL required; writable with the
 * same public key the app already uses. Kept separate from the 'main' business
 * blob so the sync never fights the app's JSON merge.
 *
 * Trigger: POST /api/sync-orders   (POST so the service worker ignores it)
 * Secrets (Vercel → Settings → Environment Variables):
 *   SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD
 * Supabase URL + public key are safe to inline (already public in config.js).
 */

const SR_BASE = "https://apiv2.shiprocket.in/v1/external";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://iiicjyjldubryjffewkf.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_gRMF7PVwea29BKCxLl103g_kVRXQsLx";
const ROW_ID = "online_orders";

const MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
const pad = (n) => String(n).padStart(2, "0");
// Parse a Shiprocket charge value ("270.90", "1,540.50", "N/A", "-", "", null) -> number (0 if not numeric).
const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Handles both Shiprocket date formats (India time) -> { iso, ymd }:
//   orders:    "16 Jul 2026, 09:02 PM"   (comma, no ordinal)
//   shipments: "3rd Jun 2026 02:00 AM"   (ordinal suffix, no comma)
function parseSRDate(s) {
  if (!s || typeof s !== "string") return { iso: null, ymd: null };
  const m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return { iso: null, ymd: null };
  let [, d, mon, y, hh, mm, ap] = m;
  d = +d; y = +y; hh = +hh; mm = +mm;
  const mo = MON[mon.toLowerCase()];
  if (mo === undefined) return { iso: null, ymd: null };
  ap = ap.toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  const ymd = `${y}-${pad(mo + 1)}-${pad(d)}`;
  const iso = `${ymd}T${pad(hh)}:${pad(mm)}:00+05:30`;
  return { iso, ymd };
}

// Map a raw Shiprocket order to the lean shape the app reads (no bulky `raw`).
function mapOrder(o) {
  const { iso, ymd } = parseSRDate(o.created_at);
  const shp = (o.shipments && o.shipments[0]) || {};
  const status = (o.status || "").toString();
  const master = (o.master_status || "").toString();
  const rem = o.expected_remittance_date || {};
  const isRto = /rto/i.test(status) || /rto/i.test(master);
  const isCancelled = /cancel/i.test(status);
  const isDelivered = /delivered/i.test(status) || /delivered/i.test(master);
  return {
    sr_id: o.id,
    channel_order_id: o.channel_order_id || null,
    order_date: iso,
    order_ymd: ymd,
    payment_method: (o.payment_method || "").toLowerCase() || null,
    payment_status: o.payment_status || null,
    total: parseFloat(o.total) || 0,
    qty: parseInt(o.product_quantity, 10) || 0,
    // product lines (for auto-reducing inventory): sku + name + quantity
    items: Array.isArray(o.products) ? o.products.map((p) => ({
      sku: (p.channel_sku || p.sku || p.master_sku || "").toString(),
      name: (p.name || "").toString(),
      qty: parseInt(p.quantity, 10) || 0,
    })).filter((it) => it.qty > 0 && (it.sku || it.name)) : [],
    status: status || null,
    status_code: Number.isFinite(+o.status_code) ? +o.status_code : null,
    master_status: master || null,
    channel_name: o.channel_name || null,
    customer_name: o.customer_name || null,
    customer_city: o.customer_city || null,
    customer_state: o.customer_state || null,
    awb: shp.awb || o.awb || null,
    courier: shp.courier || null,
    remittance_from: rem && rem.start_date ? String(rem.start_date) : null,
    remittance_to: rem && rem.end_date ? String(rem.end_date) : null,
    delivered_date: shp.delivered_date || o.delivered_date || null,
    is_rto: isRto,
    is_cancelled: isCancelled,
    is_delivered: isDelivered,
    // Shiprocket charges attributed to this order (filled in runSync from /shipments).
    freight_charge: 0,
    cod_charge: 0,
    rto_charge: 0,
    ship_charge: 0,
  };
}

async function shiprocketToken() {
  const res = await fetch(`${SR_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.token) {
    throw new Error(`Shiprocket auth failed (${res.status}): ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.token;
}

async function fetchAllOrders(token, maxPages = 40) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${SR_BASE}/orders?per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Orders fetch failed (${res.status}) page ${page}`);
    const list = j.data || j.orders || [];
    out.push(...list);
    const totalPages = j.meta && j.meta.pagination && j.meta.pagination.total_pages;
    if (!list.length || (totalPages && page >= totalPages)) break;
  }
  return out;
}

// Pull all shipments (per-AWB) — this is where Shiprocket exposes what it CHARGES
// us: freight, COD fee, and RTO (return) charges. Each row: { order_id, awb, charges }.
async function fetchAllShipments(token, maxPages = 40) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${SR_BASE}/shipments?per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Shipments fetch failed (${res.status}) page ${page}`);
    const list = j.data || [];
    out.push(...list);
    const totalPages = j.meta && j.meta.pagination && j.meta.pagination.total_pages;
    if (!list.length || (totalPages && page >= totalPages)) break;
  }
  return out;
}

// Current Shiprocket wallet balance (negative = amount we owe them). Reflects EVERY
// charge including WhatsApp/Engage, which the per-shipment data doesn't itemise.
async function fetchWalletBalance(token) {
  try {
    const res = await fetch(`${SR_BASE}/account/details/wallet-balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await res.json();
    const bal = j && j.data && j.data.balance_amount;
    return bal == null ? null : num(bal);
  } catch (e) { return null; }
}

// Turn a shipment's charges object into { freight, cod, rto }.
// RTO (return) charge = `applied_weight_amount_rto`. Shiprocket exposes two RTO
// fields (charged_weight_amount_rto + applied_weight_amount_rto) that are usually
// the SAME amount — summing them double-counts. On the forward leg freight_charges
// equals applied_weight_amount, so `applied` is the amount actually billed.
function shipmentCharge(s) {
  const c = (s && s.charges) || {};
  return {
    freight: num(c.freight_charges),
    cod: num(c.cod_charges),
    rto: num(c.applied_weight_amount_rto),
  };
}

// Read the current online_orders row's synced_at; ms since then (Infinity if none).
async function lastSyncAgoMs() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/business_state?id=eq.${ROW_ID}&select=data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return Infinity;
    const arr = await res.json();
    const at = Array.isArray(arr) && arr[0] && arr[0].data && arr[0].data.synced_at;
    if (!at) return Infinity;
    return Date.now() - new Date(at).getTime();
  } catch (e) { return Infinity; }
}

// Upsert the single online_orders row of business_state.
async function writeOnlineRow(data, nowISO) {
  const body = [{ id: ROW_ID, data: { ...data, synced_at: nowISO }, updated_at: nowISO }];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/business_state`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase write failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return (data.orders || []).length;
}

async function runSync() {
  const token = await shiprocketToken();
  // These three calls are independent — run them together to keep the function
  // well under Vercel's timeout as order volume grows.
  const [raw, rawShipments, walletBalance] = await Promise.all([
    fetchAllOrders(token),
    fetchAllShipments(token),
    fetchWalletBalance(token),
  ]);

  const orders = raw.map(mapOrder).filter((r) => r.sr_id != null);

  // order_id -> order date, so each shipment charge can be dated (for period filtering).
  const ymdByOrderId = {};
  raw.forEach((o) => { if (o.id != null) ymdByOrderId[String(o.id)] = parseSRDate(o.created_at).ymd; });

  // Build a dated per-shipment charge list + roll charges up onto each order.
  const chargeByOrderId = {};
  const charges = [];
  let sumF = 0, sumC = 0, sumR = 0, count = 0;
  for (const s of rawShipments) {
    const { freight, cod, rto } = shipmentCharge(s);
    if (!(freight || cod || rto)) continue;
    count++;
    sumF += freight; sumC += cod; sumR += rto;
    const oid = s.order_id != null ? String(s.order_id) : null;
    const ymd = (oid && ymdByOrderId[oid]) || parseSRDate(s.created_at).ymd || null;
    charges.push({
      ymd,
      awb: s.awb || null,
      order_id: s.order_id != null ? s.order_id : null,
      channel_order_id: s.channel_order_id || null,
      freight: round2(freight),
      cod: round2(cod),
      rto: round2(rto),
      total: round2(freight + cod + rto),
    });
    if (oid) {
      const e = chargeByOrderId[oid] || (chargeByOrderId[oid] = { freight: 0, cod: 0, rto: 0 });
      e.freight += freight; e.cod += cod; e.rto += rto;
    }
  }
  orders.forEach((o) => {
    const e = chargeByOrderId[String(o.sr_id)];
    if (!e) return;
    o.freight_charge = round2(e.freight);
    o.cod_charge = round2(e.cod);
    o.rto_charge = round2(e.rto);
    o.ship_charge = round2(e.freight + e.cod + e.rto);
  });

  const charges_summary = {
    freight: round2(sumF),
    cod: round2(sumC),
    rto: round2(sumR),
    total: round2(sumF + sumC + sumR),
    count,
    wallet_balance: walletBalance,
  };

  const n = await writeOnlineRow({ orders, charges, charges_summary }, new Date().toISOString());
  return { fetched: raw.length, upserted: n, shipments: rawShipments.length, charges_total: charges_summary.total };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }
  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    res.status(500).json({ ok: false, error: "Shiprocket credentials not configured (set SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD in Vercel env vars)." });
    return;
  }
  try {
    const ago = await lastSyncAgoMs();
    if (ago < 45000) {
      res.status(200).json({ ok: true, throttled: true, fetched: 0, upserted: 0, message: "Recently synced" });
      return;
    }
    const out = await runSync();
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
};

// Exposed so the webhook + a local one-off seed can reuse the exact same logic.
module.exports.mapOrder = mapOrder;
module.exports.shiprocketToken = shiprocketToken;
module.exports.fetchAllOrders = fetchAllOrders;
module.exports.fetchAllShipments = fetchAllShipments;
module.exports.fetchWalletBalance = fetchWalletBalance;
module.exports.shipmentCharge = shipmentCharge;
module.exports.writeOnlineRow = writeOnlineRow;
module.exports.runSync = runSync;
module.exports.lastSyncAgoMs = lastSyncAgoMs;
