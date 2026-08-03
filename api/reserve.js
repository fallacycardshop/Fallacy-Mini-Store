import { Redis } from "@upstash/redis";
import { loadInventoryGroups, getActiveReservedMap } from "./_inventory.js";

const redis = Redis.fromEnv();

// Reservations expire automatically after this many seconds — a safety net
// that works even if the buyer closes the app, loses connection, or the
// page crashes, since it's enforced by Redis itself, not client-side JS.
// Kept a little longer than the 5-minute client-side countdown timer.
const RESERVATION_TTL_SECONDS = 330;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { reservationId, items } = req.body || {};

    if (!reservationId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing reservationId or items" });
    }

    const groups = loadInventoryGroups();
    const reservedMap = await getActiveReservedMap(redis);

    const unavailable = [];
    const enrichedItems = [];

    for (const item of items) {
      if (!item || !item.key || !(item.quantity > 0)) continue;

      const group = groups.get(item.key);
      const baseStock = group ? group.baseStock : 0;

      let sold = 0;
      try {
        sold = Number(await redis.get(`sold:${item.key}`)) || 0;
      } catch (e) {
        console.error("Redis read failed for", item.key, e);
      }

      const alreadyReserved = reservedMap[item.key] || 0;
      const available = Math.max(baseStock - sold - alreadyReserved, 0);

      if (item.quantity > available) {
        unavailable.push({
          key: item.key,
          name: group ? group.name : item.key,
          available,
        });
      }

      enrichedItems.push({
        key: item.key,
        quantity: item.quantity,
        name: group ? group.name : item.key, // resolved server-side, not trusted from the client
      });
    }

    if (unavailable.length > 0) {
      return res.status(409).json({
        error: "Some items in your cart are no longer available.",
        unavailable,
      });
    }

    await redis.set(
      `reservation:${reservationId}`,
      JSON.stringify({ items: enrichedItems, createdAt: Date.now() }),
      { ex: RESERVATION_TTL_SECONDS }
    );

    res.status(200).json({ ok: true, reservationId });
  } catch (err) {
    console.error("reserve error:", err);
    res.status(500).json({ error: "Failed to reserve stock." });
  }
}
