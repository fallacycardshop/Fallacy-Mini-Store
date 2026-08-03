import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const raw = await redis.lrange("recent_sales", 0, 14);

    const sales = (raw || [])
      .map(entry => {
        try {
          return typeof entry === "string" ? JSON.parse(entry) : entry;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    res.status(200).json(sales);
  } catch (err) {
    console.error("recent-sales error:", err);
    res.status(200).json([]); // fail quietly — the banner just won't show anything
  }
}
