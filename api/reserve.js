import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups,
  getActiveReservedMap,
  getStoreState,
  isListingReleased,
  getEffectiveStock,
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

    // Fetch every sold counter in ONE MGET rather than a separate awaited GET
    // per cart item, so command count stays flat no matter how large the cart.
    //
    // Deliberately NOT wrapped in a try/catch that defaults to 0: if the sold
    // counts can't be read we must not assume nothing has sold, because that
    // would let someone reserve stock that is already gone. A thrown error
    // becomes a 500 and the buyer retries — annoying, but never oversold.
    const soldByKey = {};
    if (validItems.length > 0) {
      const soldValues = await redis.mget(...validItems.map(item => `sold:${item.key}`));
      validItems.forEach((item, i) => {
        soldByKey[item.key] = Number(soldValues[i]) || 0;
      });
    }

    // One MGET covers both guards: cards pulled for auction, and listings not
    // yet drip-released. Neither may be sold, even from a stale cart.
    const { hiddenCardIds, drip } = await getStoreState(redis);
    const now = Date.now();

    const unavailable = [];
    const enrichedItems = [];

    for (const item of validItems) {
      const group = groups.get(item.key);
      // Published stock only — an unreleased restock can't be bought early.
      const baseStock = group ? getEffectiveStock(drip, item.key, group.baseStock, now) : 0;
      const sold = soldByKey[item.key] || 0;

      const alreadyReserved = reservedMap[item.key] || 0;
      const isHidden = group && hiddenCardIds.has(normaliseCardId(group.cardId));
      const isUnreleased = group && !isListingReleased(drip, item.key, now);
      const available =
        isHidden || isUnreleased ? 0 : Math.max(baseStock - sold - alreadyReserved, 0);

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
