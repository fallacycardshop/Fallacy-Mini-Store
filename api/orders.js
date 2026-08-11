import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 300; // matches MAX_STORED_ORDERS in confirm-order.js

// ---------------------------------------------------------------------------
// Auction-end cutoffs.
//
// Auctions end late and, because of anti-snipe, at an unpredictable time — so
// the moment is recorded rather than assumed. One JSON key holds a small map of
// SGT date -> epoch ms, and the admin Recent Orders panel splits a day's orders
// around it: everything before the auction closed (the buyers who might still
// win a lot and need mailing consolidated) versus everything after.
//
// One key, not one per day, and the storefront never reads it — this is
// admin-only data and deliberately kept out of the store:settings object that
// /api/products fetches on every page load.
// ---------------------------------------------------------------------------
const AUCTION_CUTOFFS_KEY = "auction:cutoffs";
const KEEP_CUTOFF_DAYS = 60; // trim history so the key can't grow unbounded

function parseCutoffs(raw) {
  if (!raw) return {};
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error("Corrupted auction cutoffs:", e);
    return {};
  }
  if (!data || typeof data !== "object") return {};

  const clean = {};
  Object.entries(data).forEach(([date, ts]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const n = Number(ts);
    if (Number.isFinite(n) && n > 0) clean[date] = n;
  });
  return clean;
}

// Reads back the server-side order backup written by /api/confirm-order.
//
// This exists so no order can ever be lost to a failed notification email:
// the record is saved at the moment stock is decremented, and can be retrieved
// here regardless of what happened on the buyer's device afterwards.
//
// Redis cost: one LRANGE + one GET (cutoffs) per read, one GET + one SET per
// cutoff write. Admin-only, never called by the storefront.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { key, limit, action, date, cutoff } = req.body || {};
    const adminKey = process.env.ADMIN_RESET_KEY;

    if (!adminKey) {
      console.error("ADMIN_RESET_KEY is not set in Vercel env vars");
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }
    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    // ----------------------------------------------------------- setCutoff --
    // Records (or clears) the auction-end moment for one SGT date. Passing a
    // null/blank cutoff removes the marker so the panel falls back to a single
    // undivided list for that day.
    if (action === "setCutoff") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
        return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required." });
      }

      const cutoffs = parseCutoffs(await redis.get(AUCTION_CUTOFFS_KEY));

      const ts = Number(cutoff);
      if (cutoff === null || cutoff === undefined || cutoff === "" || !Number.isFinite(ts) || ts <= 0) {
        delete cutoffs[date];
      } else {
        cutoffs[date] = ts;
      }

      // Keep only the most recent KEEP_CUTOFF_DAYS dates so the key stays small.
      const trimmed = {};
      Object.keys(cutoffs)
        .sort()
        .slice(-KEEP_CUTOFF_DAYS)
        .forEach(d => (trimmed[d] = cutoffs[d]));

      await redis.set(AUCTION_CUTOFFS_KEY, JSON.stringify(trimmed));
      return res.status(200).json({ ok: true, cutoffs: trimmed });
    }

    // --------------------------------------------------------------- read --
    const count = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    // Orders and the cutoff map come back together, so the panel can split the
    // list immediately without a second round trip.
    const [raw, cutoffsRaw] = await Promise.all([
      redis.lrange("orders", 0, count - 1),
      redis.get(AUCTION_CUTOFFS_KEY),
    ]);

    const orders = (raw || [])
      .map(entry => {
        try {
          return typeof entry === "string" ? JSON.parse(entry) : entry;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    return res.status(200).json({ ok: true, orders, cutoffs: parseCutoffs(cutoffsRaw) });
  } catch (err) {
    console.error("orders error:", err);
    return res.status(500).json({ error: "Failed to read stored orders." });
  }
}
