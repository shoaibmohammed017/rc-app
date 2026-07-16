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

// "16 Jul 2026, 09:02 PM" (India time) -> { iso, ymd }
function parseSRDate(s) {
  if (!s || typeof s !== "string") return { iso: null, ymd: null };
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
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
async function writeOnlineRow(orders, nowISO) {
  const body = [{ id: ROW_ID, data: { orders, synced_at: nowISO }, updated_at: nowISO }];
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
  return orders.length;
}

async function runSync() {
  const token = await shiprocketToken();
  const raw = await fetchAllOrders(token);
  const orders = raw.map(mapOrder).filter((r) => r.sr_id != null);
  const n = await writeOnlineRow(orders, new Date().toISOString());
  return { fetched: raw.length, upserted: n };
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
module.exports.writeOnlineRow = writeOnlineRow;
module.exports.runSync = runSync;
module.exports.lastSyncAgoMs = lastSyncAgoMs;
