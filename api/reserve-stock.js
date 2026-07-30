import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // items: [{ key: "<CardID or Name>", quantity: <number> }]
    // incrby is atomic, so concurrent checkouts don't clobber each other's counts.
    await Promise.all(
      items
        .filter(item => item && item.key && item.quantity > 0)
        .map(item => redis.incrby(`sold:${item.key}`, item.quantity))
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("reserve-stock error:", err);
    res.status(500).json({ error: "Failed to update stock." });
  }
}
