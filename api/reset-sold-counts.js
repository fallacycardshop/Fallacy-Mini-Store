import { Redis } from "@upstash/redis";
import { scanKeys } from "./_inventory.js";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { key } = req.body || {};
    const adminKey = process.env.ADMIN_RESET_KEY;

    if (!adminKey) {
      console.error("ADMIN_RESET_KEY is not set in Vercel env vars");
      return res.status(500).json({ error: "Reset is not configured yet." });
    }

    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    // Only wipes permanent sold counters — active "reservation:*" keys
    // (people currently mid-checkout) are left alone and expire on their own.
    const soldKeys = await scanKeys(redis, "sold:*");

    if (soldKeys.length > 0) {
      await Promise.all(soldKeys.map(k => redis.del(k)));
    }

    res.status(200).json({ ok: true, deletedCount: soldKeys.length });
  } catch (err) {
    console.error("reset-sold-counts error:", err);
    res.status(500).json({ error: "Failed to reset stock counts." });
  }
}
