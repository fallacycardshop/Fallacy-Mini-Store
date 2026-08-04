import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Show up to 20 (matches MAX_RECENT_SALES in confirm-order.js), and never show
// anything older than 2 days.
const MAX_SHOWN = 20;
const MAX_AGE_HOURS = 48;

export default async function handler(req, res) {
  try {
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
    res.status(200).json([]); // fail quietly — the banner just won't show anything
  }
}
