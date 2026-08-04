import { Redis } from "@upstash/redis";
import { loadInventoryGroups } from "./_inventory.js";

const redis = Redis.fromEnv();

const MAX_RECENT_SALES = 20;
const MAX_STORED_ORDERS = 300;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { reservationId, record } = req.body || {};
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

    const items = data.items || [];

    await Promise.all(
      items.map(item => redis.incrby(`sold:${item.key}`, item.quantity))
    );
    await redis.del(`reservation:${reservationId}`);

    // AUTHORITATIVE ORDER BACKUP.
    //
    // Written in the same request that decrements stock, before anything can
    // go wrong on the buyer's device. The notification email is a convenience
    // on top of this — if FormSubmit fails, or the buyer closes the Telegram
    // webview mid-request, the full order is still here and readable from the
    // admin page. Two commands per order (never per page load).
    try {
      if (record && typeof record === "object") {
        await redis.lpush(
          "orders",
          JSON.stringify({ savedAt: Date.now(), record })
        );
        await redis.ltrim("orders", 0, MAX_STORED_ORDERS - 1);
      } else {
        console.error("confirm-order: no order record supplied for", reservationId);
      }
    } catch (orderErr) {
      // A backup failure must never void a paid order.
      console.error("order backup failed:", orderErr);
    }

    // Log each sold item to a recent-activity feed for the "recently sold"
    // banner — card name and set only, never any buyer info. Capped so the
    // list never grows unbounded.
    //
    // The set name is resolved from the CSV here, at sale time, so the banner
    // needs no lookup when rendering and the record stays accurate even if the
    // inventory file changes later.
    try {
      const groups = loadInventoryGroups();
      const now = Date.now();

      const entries = items.map(item => {
        const group = groups.get(item.key);
        return JSON.stringify({
          key: item.key,
          name: (group && group.name) || item.name || item.key,
          set: (group && group.set) || "",
          timestamp: now,
        });
      });

      // ONE lpush for the whole order rather than one per item, per the
      // command-budget rule in AGENTS.md.
      if (entries.length > 0) {
        await redis.lpush("recent_sales", ...entries);
        await redis.ltrim("recent_sales", 0, MAX_RECENT_SALES - 1);
      }
    } catch (feedErr) {
      // Never let the activity feed break a real order confirmation.
      console.error("recent_sales logging failed:", feedErr);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("confirm-order error:", err);
    res.status(500).json({ error: "Failed to confirm order." });
  }
}
