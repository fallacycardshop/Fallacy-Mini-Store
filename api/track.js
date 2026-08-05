import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Everything lives in ONE Redis hash. Recording an event is a single HINCRBY;
// reading the whole report is a single HGETALL. Nothing scales with catalogue
// size or traffic, per the command-budget rule in AGENTS.md.
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
]);

const REPORT_DAYS = 14;
const TZ_OFFSET_MINUTES = 480; // SGT, so days line up with your trading day

function localDateKey(ts) {
  return new Date(ts + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { event, key, action, revenue } = req.body || {};

    // ------------------------------------------------------------- report --
    // Admin-only read. Returns per-day counts for the last two weeks.
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

    // -------------------------------------------------------------- record --
    // Public, unauthenticated by necessity (shoppers fire it), but harmless:
    // it can only increment counters whose names are on the allowlist.
    if (!event || !ALLOWED_EVENTS.has(event)) {
      return res.status(400).json({ error: "Unknown event." });
    }

    const date = localDateKey(Date.now());
    await redis.hincrby(FUNNEL_KEY, `${date}|${event}`, 1);

    // Revenue is tracked alongside purchases so the report can show takings
    // without storing anything about who bought.
    if (event === "purchase" && Number(revenue) > 0) {
      await redis.hincrbyfloat(FUNNEL_KEY, `${date}|revenue`, Number(revenue));
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("track error:", err);
    // Never surface a tracking failure to a shopper mid-purchase.
    return res.status(200).json({ ok: false });
  }
}
