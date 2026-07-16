/* Vercel Serverless Function — Shiprocket webhook receiver.
 * Shiprocket POSTs here on shipment status changes (Picked up, In transit,
 * Delivered, RTO, ...) and on COD remittance events. We respond fast and
 * refresh the online_orders row by re-pulling from Shiprocket (throttled), so
 * the app's delivery status + COD-on-the-way stay current automatically.
 *
 * Configure in Shiprocket → Settings → Webhooks:
 *   URL:  https://<your-app>.vercel.app/api/shiprocket-webhook
 *   (optional) set a token there and mirror it in env SHIPROCKET_WEBHOOK_TOKEN.
 * Needs the same SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD env vars as the sync.
 */

const sync = require("./sync-orders.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  // Optional shared-secret check (Shiprocket sends the token you configure).
  const need = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (need) {
    const got = req.headers["x-api-key"] || req.headers["x-webhook-token"] || "";
    if (got !== need) {
      res.status(401).json({ ok: false, error: "bad token" });
      return;
    }
  }

  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    // Acknowledge so Shiprocket doesn't keep retrying, but note it's not wired yet.
    res.status(200).json({ ok: true, skipped: "credentials not configured" });
    return;
  }

  try {
    // Debounce: if we synced very recently, just acknowledge — the last pull
    // already captured current state; the next change (or manual Sync) catches up.
    const ago = await sync.lastSyncAgoMs();
    if (ago < 45000) {
      res.status(200).json({ ok: true, throttled: true });
      return;
    }
    const out = await sync.runSync();
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    // Still return 200 so Shiprocket doesn't hammer retries on a transient error.
    res.status(200).json({ ok: false, error: (e && e.message) || String(e) });
  }
};
