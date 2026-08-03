import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups,
  getActiveReservedMap,
  getHiddenCardIds,
  normaliseCardId,
} from "./_inventory.js";

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

    const validItems = items.filter(item => item && item.key && item.quantity > 0);

    // A card pulled for auction must not be sellable here, even if someone had
    // it sitting in their cart from before it was hidden. Selling a card that
    // then also sells at auction is the one outcome worth being strict about.
    const hiddenCardIds = await getHiddenCardIds(redis);

    // Fetch every sold counter we need in ONE MGET rather than looping with a
    // separate awaited GET per cart item. Command count stays flat no matter
    // how many lines are in the cart.
    //
    // No try/catch swallowing the failure here on purpose: if we can't read
    // the sold counts we must not treat them as 0, because that would let
    // someone reserve stock that has already been sold. A thrown error becomes
    // a 500 and the buyer is told to try again — annoying, but never oversold.
    const soldByKey = {};
    if (validItems.length > 0) {
      const soldValues = await redis.mget(...validItems.map(item => `sold:${item.key}`));
      validItems.forEach((item, i) => {
        soldByKey[item.key] = Number(soldValues[i]) || 0;
      });
    }

    const unavailable = [];

    for (const item of validItems) {
      const group = groups.get(item.key);

      if (group && hiddenCardIds.has(normaliseCardId(group.cardId))) {
        unavailable.push({
          key: item.key,
          name: group.name,
          available: 0,
        });
        continue;
      }

      const baseStock = group ? group.baseStock : 0;
      const sold = soldByKey[item.key] || 0;

      const alreadyReserved = reservedMap[item.key] || 0;
      const available = Math.max(baseStock - sold - alreadyReserved, 0);

      if (item.quantity > available) {
        unavailable.push({
          key: item.key,
          name: group ? group.name : item.key,
          available,
        });
      }
    }

    if (unavailable.length > 0) {
      return res.status(409).json({
        error: "Some items in your cart are no longer available.",
        unavailable,
      });
    }

    await redis.set(
      `reservation:${reservationId}`,
      JSON.stringify({ items, createdAt: Date.now() }),
      { ex: RESERVATION_TTL_SECONDS }
    );

    res.status(200).json({ ok: true, reservationId });
  } catch (err) {
    console.error("reserve error:", err);
    res.status(500).json({ error: "Failed to reserve stock." });
  }
}
