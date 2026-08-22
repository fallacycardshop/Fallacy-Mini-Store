import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups, ORDER_PAID_KEY, VOUCHERS_KEY, voucherStatus,
  WELCOME_SEEN_KEY, WELCOME_GRANTED_KEY,
} from "./_inventory.js";

const redis = Redis.fromEnv();

const MAX_RECENT_SALES = 20;
const MAX_STORED_ORDERS = 5000; // ~13 months at 12 orders/day — headroom for the 6-month loyalty window

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

        // A new order starts UNPAID. Payment is a manual PayNow transfer the
        // shop owner verifies by hand; only then is the buyer's lifetime spend
        // credited (see markPaid in api/orders.js). Writing an explicit "0" —
        // rather than leaving the key absent — is what lets the spend backfill
        // tell a genuinely-new unpaid order from a pre-feature historical one,
        // which it treats as already paid. Inside the same wrapped block as the
        // backup, so a Redis hiccup here can never void a paid order.
        const paidId = String(record.Order_ID || "");
        if (paidId) await redis.hset(ORDER_PAID_KEY, { [paidId]: "0" });
      } else {
        console.error("confirm-order: no order record supplied for", reservationId);
      }
    } catch (orderErr) {
      // A backup failure must never void a paid order.
      console.error("order backup failed:", orderErr);
    }

    // BURN A LOYALTY VOUCHER, if this order used one. The discount was validated
    // (status + minimum) at apply time in api/validate-discount.js; here — in the
    // same request that has claimed the reservation and can't be replayed — we
    // mark it used so it can't be spent again. Env-var promo codes aren't in this
    // hash, so a normal promo code simply isn't found and nothing happens.
    //
    // Wrapped and best-effort: a burn failure must NEVER void a placed order (the
    // stock is already decremented and the order backed up). A voucher that was
    // somehow already used is left as-is and logged, so the shop owner sees it on
    // the order before releasing it against the manual PayNow payment.
    try {
      const code = String((record && record.Discount_Code) || "").trim().toUpperCase();
      if (code && code !== "NONE") {
        const raw = await redis.hget(VOUCHERS_KEY, code);
        if (raw) {
          let v = null;
          try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { v = null; }
          if (v) {
            const orderId = String((record && record.Order_ID) || "");
            if (voucherStatus(v) === "active") {
              v.status = "used";
              v.usedAt = Date.now();
              v.usedOrderId = orderId;
              await redis.hset(VOUCHERS_KEY, { [code]: JSON.stringify(v) });
            } else {
              console.error(`voucher ${code} used on order ${orderId} but was already ${voucherStatus(v)}`);
            }
          }
        }
      }
    } catch (voucherErr) {
      console.error("voucher burn failed:", voucherErr);
    }

    // WELCOME REWARD bookkeeping. The perk is strictly first-order-only, so the
    // moment a Telegram id places ANY order it's marked "seen" and can never
    // qualify again — whether or not this order actually used the reward. If it
    // did use it, also record the grant for the admin count. Wrapped: this must
    // never fail a real order.
    try {
      const tgid = String((record && record.Telegram_User_ID) || "").trim();
      if (/^\d+$/.test(tgid)) {
        await redis.sadd(WELCOME_SEEN_KEY, tgid);
        const wr = Number(String((record && record.Welcome_Reward) || "").replace(/[^0-9.]/g, "")) || 0;
        if (wr > 0) await redis.sadd(WELCOME_GRANTED_KEY, tgid);
      }
    } catch (welcomeErr) {
      console.error("welcome bookkeeping failed:", welcomeErr);
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
