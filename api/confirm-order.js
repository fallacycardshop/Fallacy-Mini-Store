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

    const raw = await redis.get(`reservation:${reservationId}`);
    if (!raw) {
      // Either it expired (5.5 min passed) or was already confirmed/released.
      return res.status(410).json({ error: "Your reservation has expired. Please try again." });
    }

    let data;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error("Corrupted reservation data:", e);
      return res.status(500).json({ error: "Corrupted reservation data." });
    }

    await Promise.all(
      (data.items || []).map(item => redis.incrby(`sold:${item.key}`, item.quantity))
    );
    await redis.del(`reservation:${reservationId}`);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("confirm-order error:", err);
    res.status(500).json({ error: "Failed to confirm order." });
  }
}
