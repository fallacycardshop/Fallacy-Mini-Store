import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: "Missing reservationId" });
    }

    await redis.del(`reservation:${reservationId}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("release-reservation error:", err);
    res.status(500).json({ error: "Failed to release reservation." });
  }
}
