import { Redis } from "@upstash/redis";
import { loadInventoryGroups, getActiveReservedMap, seededShuffle, getTodaySeed } from "./_inventory.js";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const groups = loadInventoryGroups();
    const reservedMap = await getActiveReservedMap(redis);

    const groupEntries = Array.from(groups.entries());

    // Build every product's data first, without a final display "id" yet —
    // the id gets assigned afterward, once we know the actual display order
    // (featured cards first, everything else daily-shuffled).
    const unordered = await Promise.all(
      groupEntries.map(async ([groupKey, group]) => {
        let sold = 0;
        try {
          sold = Number(await redis.get(`sold:${groupKey}`)) || 0;
        } catch (kvErr) {
          console.error("Redis read failed for", groupKey, kvErr);
        }

        const reserved = reservedMap[groupKey] || 0;
        const trueStock = Math.max(group.baseStock - sold, 0);

        return {
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
    const featured = unordered.filter(p => p.featured);
    const others = unordered.filter(p => !p.featured);
    const shuffledOthers = seededShuffle(others, getTodaySeed());

    const products = [...featured, ...shuffledOthers].map((p, index) => ({
      id: index + 1,
      ...p,
    }));

    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
