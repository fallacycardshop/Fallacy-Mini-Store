import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups,
  getActiveReservedMap,
  getStoreState,
  isListingReleased,
  isListingNew,
  normaliseCardId,
  seededShuffle,
  getTodaySeed,
} from "./_inventory.js";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const groups = loadInventoryGroups();
    const reservedMap = await getActiveReservedMap(redis);

    // ONE MGET returns both the hidden-card list (auction protection) and the
    // store settings (editable featured heading). Same command count as before
    // the heading existed.
    const { hiddenCardIds, settings, drip } = await getStoreState(redis);
    const now = Date.now();

    // Two filters, both free (no extra Redis): temporarily hidden cards, and
    // listings whose drip release time hasn't arrived yet.
    const groupEntries = Array.from(groups.entries()).filter(
      ([groupKey, group]) =>
        !hiddenCardIds.has(normaliseCardId(group.cardId)) &&
        isListingReleased(drip, groupKey, now)
    );

    // Fetch EVERY sold counter in a single MGET.
    //
    // This used to be one redis.get() per listing, which meant ~190 separate
    // Redis round trips on every single page load. That burned through the
    // Upstash request quota extremely quickly and caused intermittent
    // failures. One MGET is one request, regardless of catalogue size.
    const soldByKey = {};
    if (groupEntries.length > 0) {
      const soldKeys = groupEntries.map(([groupKey]) => `sold:${groupKey}`);
      // If this read fails we must NOT carry on with sold = 0, because that
      // would silently show every sold-out card as available and let people
      // buy stock that doesn't exist. Better to fail loudly and show the
      // "failed to load" message than to oversell.
      const soldValues = await redis.mget(...soldKeys);
      groupEntries.forEach(([groupKey], i) => {
        soldByKey[groupKey] = Number(soldValues[i]) || 0;
      });
    }

    // Build every product's data first, without a final display "id" yet —
    // the id gets assigned afterward, once we know the actual display order
    // (featured cards first, everything else daily-shuffled).
    const unordered = await Promise.all(
      groupEntries.map(async ([groupKey, group]) => {
        const sold = soldByKey[groupKey] || 0;

        const reserved = reservedMap[groupKey] || 0;
        const trueStock = Math.max(group.baseStock - sold, 0);

        // Flagged for the Newly In Stock row. Stops being true on its own once
        // the window lapses, so nothing needs to move the card afterwards.
        const isNew = isListingNew(drip, groupKey, now);

        return {
          isNew,
          name: group.name,
          price: group.price,
          photo: group.photo,
          description: group.description,
          stock: Math.max(group.baseStock - sold - reserved, 0),
          trueStock, // ignores other buyers' in-progress reservations — only reflects genuine permanent sales
          category: group.category,
          set: group.set,
          cardId: group.cardId,
          stockKey: groupKey,
          featured: !!group.featured,
        };
      })
    );

    // Featured cards are pinned to the top, in the order they appear in the
    // CSV. Everything else is shuffled with a seed based on today's date —
    // stable all day (won't reshuffle on every refresh), different tomorrow.
    //
    // Same physical card in different conditions (e.g. NM and NM-) share a
    // CardID but are separate stock-tracked listings — shuffling them
    // individually would scatter them apart. Instead we cluster same-CardID
    // listings together first, then shuffle the clusters as whole units, so
    // different conditions of the same card always stay adjacent.
    const featured = unordered.filter(p => p.featured);
    const others = unordered.filter(p => !p.featured);

    const clusterMap = new Map();
    others.forEach(p => {
      const clusterKey = p.cardId || p.name;
      if (!clusterMap.has(clusterKey)) clusterMap.set(clusterKey, []);
      clusterMap.get(clusterKey).push(p);
    });
    const clusters = Array.from(clusterMap.values());
    const shuffledClusters = seededShuffle(clusters, getTodaySeed());
    const shuffledOthers = shuffledClusters.flat();

    const products = [...featured, ...shuffledOthers].map((p, index) => ({
      id: index + 1,
      ...p,
    }));

    // Response is an object now so the editable featured heading can travel
    // with the catalogue. The storefront also accepts the old bare-array shape,
    // so an out-of-step deploy of either file won't break the shop.
    res.status(200).json({
      products,
      featuredTitle: settings.featuredTitle,
      newTitle: settings.newTitle,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
