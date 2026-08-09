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

    // ATOMIC CLAIM. GETDEL fetches and deletes in a single operation, so only
    // ONE request can ever obtain the reservation.
    //
    // This previously used GET ... then DEL later. A buyer double-tapping the
    // confirm button sent two requests that BOTH passed the GET before either
    // reached the DEL — so the sold counters were incremented twice for a
    // single order and two order records were written. GETDEL makes the second
    // request find nothing and fail cleanly.
    let raw;
    try {
      raw = await redis.getdel(`reservation:${reservationId}`);
    } catch (e) {
      // Older Redis without GETDEL: fall back to a delete-first claim, which is
      // still atomic enough — DEL returns 1 only for the request that removed it.
      const existing = await redis.get(`reservation:${reservationId}`);
      const removed = await redis.del(`reservation:${reservationId}`);
      raw = removed ? existing : null;
    }

    if (!raw) {
      // Expired, already confirmed, or a duplicate submission.
      return res.status(410).json({ error: "This order has already been confirmed." });
    }

    let data;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error("Corrupted reservation data:", e);
      return res.status(500).json({ error: "Corrupted reservation data." });
    }

    const items = data.items || [];

    // The reservation is already claimed and removed above, so reaching this
    // point means this request is the sole owner of the order.
    await Promise.all(
      items.map(item => redis.incrby(`sold:${item.key}`, item.quantity))
    );

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

      // Adds to the hand-entered lifetime figure so the headline number keeps
      // climbing on its own between manual updates. One HINCRBY per order.
      const cardCount = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      await redis.hincrby("stats:lifetime", "cards", cardCount);
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
