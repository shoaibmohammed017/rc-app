/* Vercel Serverless Function — pulls orders from Shiprocket and upserts them
 * into the Supabase `online_orders` table.
 *
 * Trigger: POST /api/sync-orders   (POST so the service worker ignores it)
 * Secrets (Vercel → Settings → Environment Variables):
 *   SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD
 * Supabase URL + public key are safe to inline (already public in config.js);
 * override via SUPABASE_URL / SUPABASE_KEY env vars to harden later.
 */

const SR_BASE = "https://apiv2.shiprocket.in/v1/external";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://iiicjyjldubryjffewkf.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_gRMF7PVwea29BKCxLl103g_kVRXQsLx";

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
    raw: o,
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

// How long since the most recent sync (ms). Infinity if never / unknown.
async function lastSyncAgoMs() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/online_orders?select=synced_at&order=synced_at.desc&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return Infinity;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length || !arr[0].synced_at) return Infinity;
    return Date.now() - new Date(arr[0].synced_at).getTime();
  } catch (e) { return Infinity; }
}

async function upsert(rows) {
  if (!rows.length) return 0;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/online_orders`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase upsert failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return rows.length;
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
    // Throttle: don't hammer Shiprocket's login. If we synced < 45s ago, skip.
    const ago = await lastSyncAgoMs();
    if (ago < 45000) {
      res.status(200).json({ ok: true, throttled: true, fetched: 0, upserted: 0, message: "Recently synced" });
      return;
    }
    const token = await shiprocketToken();
    const orders = await fetchAllOrders(token);
    const rows = orders.map(mapOrder).filter((r) => r.sr_id != null);
    const n = await upsert(rows);
    res.status(200).json({ ok: true, fetched: orders.length, upserted: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
};
