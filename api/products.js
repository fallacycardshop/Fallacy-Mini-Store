import { Redis } from "@upstash/redis";
import { loadInventoryGroups, getActiveReservedMap } from "./_inventory.js";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const groups = loadInventoryGroups();
    const reservedMap = await getActiveReservedMap(redis);

    const groupEntries = Array.from(groups.entries());

    const products = await Promise.all(
      groupEntries.map(async ([groupKey, group], index) => {
        let sold = 0;
        try {
          sold = Number(await redis.get(`sold:${groupKey}`)) || 0;
        } catch (kvErr) {
          console.error("Redis read failed for", groupKey, kvErr);
        }

        const reserved = reservedMap[groupKey] || 0;

        return {
          id: index + 1,
          name: group.name,
          price: group.price,
          photo: group.photo,
          description: group.description,
          stock: Math.max(group.baseStock - sold - reserved, 0),
          category: group.category,
          cardId: group.cardId,
          stockKey: groupKey,
        };
      })
    );

    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
