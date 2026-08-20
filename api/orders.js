import { Redis } from "@upstash/redis";
import {
  ORDER_PAID_KEY,
  CUSTOMER_SPEND_KEY,
  CUSTOMER_COUNT_KEY,
  customerKey,
  orderAmount,
  aggregateSpend,
} from "./_inventory.js";

const redis = Redis.fromEnv();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 300; // matches MAX_STORED_ORDERS in confirm-order.js
const ORDERS_KEY = "orders";

// Reads back the server-side order backup written by /api/confirm-order, and
// (folded in here rather than as new serverless functions — the Vercel Hobby
// plan is at its 12-function ceiling) the payment-confirmation and lifetime-
// spend actions behind the admin Orders and Customer Spend panels.
//
//   (no action) -> read orders + their paid states       [existing behaviour]
//   markPaid     -> flip one order paid/unpaid, adjust that customer's spend
//   backfillSpend-> idempotently rebuild the spend cache from the orders list
//   spendReport  -> per-customer lifetime spend, recomputed from the orders list
//
// Redis cost is O(1) per request (a fixed handful of LRANGE/HGETALL/HSET
// commands), never O(catalogue) or O(orders-as-separate-keys). Admin-only.

function parseOrders(raw) {
  return (raw || [])
    .map(entry => {
      try {
        return typeof entry === "string" ? JSON.parse(entry) : entry;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

async function readAllOrders() {
  // One LRANGE for the whole capped list. Fail-closed: a Redis error throws
  // and the request 500s rather than acting on a partial or empty read.
  const raw = await redis.lrange(ORDERS_KEY, 0, MAX_LIMIT - 1);
  return parseOrders(raw);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { key, limit, action, orderId, paid } = req.body || {};
    const adminKey = process.env.ADMIN_RESET_KEY;

    if (!adminKey) {
      console.error("ADMIN_RESET_KEY is not set in Vercel env vars");
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }
    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    // -------------------------------------------------------------- markPaid
    // Flip a single order's paid state and move that customer's cached spend by
    // the same amount. The amount and customer are derived from the stored
    // order record through the shared helpers, so the credit always matches
    // what the Spend panel and backfill would compute for the same order.
    if (action === "markPaid") {
      const id = String(orderId || "");
      if (!id) return res.status(400).json({ error: "Missing orderId." });

      const orders = await readAllOrders();
      const entry = orders.find(e => String((e.record || e).Order_ID || "") === id);
      if (!entry) return res.status(404).json({ error: "Order not found in the stored list." });

      const record = entry.record || entry;
      const ckey = customerKey(record);
      const amt = orderAmount(record);
      const target = !!paid;

      // "No entry" means a pre-feature historical order, which is treated as
      // paid — same rule the aggregate uses, so the toggle and totals agree.
      const current = await redis.hget(ORDER_PAID_KEY, id);
      const currentPaid = current === null || current === undefined ? true : String(current) === "1";

      if (currentPaid === target) {
        return res.status(200).json({ ok: true, orderId: id, paid: target, changed: false });
      }

      await redis.hset(ORDER_PAID_KEY, { [id]: target ? "1" : "0" });

      // Credit on paying, reverse on un-paying. HINCRBYFLOAT keeps the running
      // total exact; count moves by one order in step. (These two hashes are a
      // cache for the future /mytier bot's O(1) lookups — the admin Spend panel
      // recomputes authoritatively from the orders list, so a cache drift can
      // never mislead the shop owner, and a backfill re-syncs it.)
      const sign = target ? 1 : -1;
      await redis.hincrbyfloat(CUSTOMER_SPEND_KEY, ckey, sign * amt);
      await redis.hincrby(CUSTOMER_COUNT_KEY, ckey, sign);

      return res.status(200).json({ ok: true, orderId: id, paid: target, changed: true });
    }

    // --------------------------------------------------------- backfillSpend
    // Rebuild the spend cache from the orders list. Idempotent: it OVERWRITES
    // the hashes with freshly-summed totals rather than adding to them, so
    // running it twice can't double anything. Every order with no paid-state
    // entry (i.e. placed before payment confirmation existed) is treated as
    // paid and gets an explicit "1" written, so subsequent runs stay stable and
    // new unpaid orders (which carry an explicit "0") are respected.
    if (action === "backfillSpend") {
      const orders = await readAllOrders();
      const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};
      const { byCustomer, seededPaid } = aggregateSpend(orders, paidMap);

      if (Object.keys(seededPaid).length > 0) {
        await redis.hset(ORDER_PAID_KEY, seededPaid);
      }

      const spendObj = {};
      const countObj = {};
      for (const c of byCustomer.values()) {
        spendObj[c.key] = Number(c.spend.toFixed(2));
        countObj[c.key] = c.orders;
      }

      // Full rebuild, so clear then set (one HSET each — never a loop of writes).
      await redis.del(CUSTOMER_SPEND_KEY, CUSTOMER_COUNT_KEY);
      if (Object.keys(spendObj).length > 0) {
        await redis.hset(CUSTOMER_SPEND_KEY, spendObj);
        await redis.hset(CUSTOMER_COUNT_KEY, countObj);
      }

      return res.status(200).json({
        ok: true,
        customers: byCustomer.size,
        seeded: Object.keys(seededPaid).length,
        orders: orders.length,
      });
    }

    // ----------------------------------------------------------- spendReport
    // Per-customer lifetime spend for the admin Spend panel. Recomputed from
    // the SAME orders list + paid states that Recent Orders reads, so the two
    // screens reconcile by construction (deriving the figure in one place is
    // the fix for this codebase's recurring "two readings disagree" bug).
    if (action === "spendReport") {
      const orders = await readAllOrders();
      const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};
      const { byCustomer } = aggregateSpend(orders, paidMap);

      const rows = [...byCustomer.values()]
        .map(c => ({
          key: c.key,
          handle: c.handle || c.key,
          spend: Number(c.spend.toFixed(2)),
          orders: c.orders,
          aov: c.orders > 0 ? Number((c.spend / c.orders).toFixed(2)) : 0,
          lastOrder: c.lastOrder,
        }))
        .sort((a, b) => b.spend - a.spend);

      const totals = {
        customers: rows.length,
        spend: Number(rows.reduce((s, r) => s + r.spend, 0).toFixed(2)),
        orders: rows.reduce((s, r) => s + r.orders, 0),
      };

      return res.status(200).json({ ok: true, rows, totals, cap: MAX_LIMIT, counted: orders.length });
    }

    // ------------------------------------------------------- default: read --
    // Existing behaviour: return the newest `limit` orders plus the paid-state
    // map (one extra HGETALL) so the Orders panel can show which are still
    // awaiting payment without a second round trip.
    const count = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const raw = await redis.lrange(ORDERS_KEY, 0, count - 1);
    const orders = parseOrders(raw);
    const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};

    return res.status(200).json({ ok: true, orders, paid: paidMap });
  } catch (err) {
    console.error("orders error:", err);
    res.status(500).json({ error: "Failed to read stored orders." });
  }
}
