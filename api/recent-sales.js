import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// ---------------------------------------------------------------------------
// This endpoint does double duty: GET returns the recent-sales ticker, POST
// records/reads sales-funnel counters.
//
// They're merged into one file purely because the Vercel Hobby plan allows a
// maximum of 12 serverless functions, and the store was already at the limit.
// Both halves are cheap: recording is one HINCRBY, the whole report is one
// HGETALL.
// ---------------------------------------------------------------------------

const FUNNEL_KEY = "funnel:counts";

// Only these names are accepted, so a stray or malicious POST can't bloat the
// hash with arbitrary fields.
const ALLOWED_EVENTS = new Set([
  "page_view",
  "add_to_cart",
  "view_cart",
  "begin_checkout",
  "payment_shown",
  "purchase",
  "checkout_failed",
  "checkout_blocked",
]);

const REPORT_DAYS = 14;
const TZ_OFFSET_MINUTES = 480; // SGT, so days line up with your trading day

function localDateKey(ts) {
  return new Date(ts + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

async function handleFunnel(req, res) {
  const { event, key, action, revenue } = req.body || {};

  // --------------------------------------------------------------- report --
  if (action === "report") {
    const adminKey = process.env.ADMIN_RESET_KEY;
    if (!adminKey) {
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }
    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    const raw = (await redis.hgetall(FUNNEL_KEY)) || {};

    const days = [];
    for (let i = 0; i < REPORT_DAYS; i++) {
      const date = localDateKey(Date.now() - i * 86400000);
      const row = { date, revenue: Number(raw[`${date}|revenue`]) || 0 };
      ALLOWED_EVENTS.forEach(name => {
        row[name] = Number(raw[`${date}|${name}`]) || 0;
      });
      days.push(row);
    }

    const totals = { revenue: 0 };
    ALLOWED_EVENTS.forEach(name => (totals[name] = 0));
    days.forEach(d => {
      totals.revenue += d.revenue;
      ALLOWED_EVENTS.forEach(name => (totals[name] += d[name]));
    });

    return res.status(200).json({ ok: true, days, totals, reportDays: REPORT_DAYS });
  }

  // --------------------------------------------------------------- record --
  // Public by necessity (shoppers fire it), but harmless: it can only increment
  // counters whose names are on the allowlist.
  if (!event || !ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ error: "Unknown event." });
  }

  const date = localDateKey(Date.now());
  await redis.hincrby(FUNNEL_KEY, `${date}|${event}`, 1);

  if (event === "purchase" && Number(revenue) > 0) {
    await redis.hincrbyfloat(FUNNEL_KEY, `${date}|revenue`, Number(revenue));
  }

  return res.status(200).json({ ok: true });
}

// Show up to 20 (matches MAX_RECENT_SALES in confirm-order.js), and never show
// anything older than 2 days.
const MAX_SHOWN = 20;
const MAX_AGE_HOURS = 48;

export default async function handler(req, res) {
  try {
    // POST = funnel tracking; GET = the recent-sales ticker.
    if (req.method === "POST") {
      return await handleFunnel(req, res);
    }

    const raw = await redis.lrange("recent_sales", 0, MAX_SHOWN - 1);

    const cutoff = Date.now() - MAX_AGE_HOURS * 3600000;

    const sales = (raw || [])
      .map(entry => {
        try {
          return typeof entry === "string" ? JSON.parse(entry) : entry;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      // Age cutoff applied at read time rather than by deleting entries, so a
      // quiet spell simply shows fewer sales instead of presenting a week-old
      // sale as "Just sold". Entries with no timestamp predate this field and
      // are dropped, since their age can't be established.
      .filter(sale => Number(sale.timestamp) > cutoff);

    res.status(200).json(sales);
  } catch (err) {
    console.error("recent-sales error:", err);
    // Fail quietly either way — a tracking or ticker failure must never be
    // visible to a shopper mid-purchase.
    if (req.method === "POST") return res.status(200).json({ ok: false });
    res.status(200).json([]);
  }
}
