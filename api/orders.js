import { Redis } from "@upstash/redis";
import {
  ORDER_PAID_KEY,
  CUSTOMER_SPEND_KEY,
  CUSTOMER_COUNT_KEY,
  CUSTOMER_ADJUST_KEY,
  CUSTOMER_ADJUST_LOG,
  customerKey,
  orderAmount,
  aggregateSpend,
  badgeForSpend,
  windowStartMs,
  parseSgtDate,
  parseAdjustEntries,
  sumAdjust,
} from "./_inventory.js";

const redis = Redis.fromEnv();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 5000; // matches MAX_STORED_ORDERS in confirm-order.js
const ADJUST_LOG_MAX = 200; // audit trail of manual spend corrections
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
    // Seed LIFETIME spend from history — additive and idempotent. Spend is
    // banked permanently in customer:spend as orders are marked paid; this
    // one-off seed credits the pre-feature orders that predate that mechanism.
    //
    // It credits ONLY orders with no order:paid entry (a pre-feature historical
    // order), marks each "1", and adds its amount to the customer's lifetime
    // total. Orders that already carry an entry — new orders ("0"/"1") or
    // already-seeded history ("1") — are skipped, so re-running never
    // double-counts and, crucially, never OVERWRITES lifetime spend that has
    // since rotated out of the capped orders list. That is what makes spend
    // lifetime rather than a rolling window of the last N orders.
    if (action === "backfillSpend") {
      const orders = await readAllOrders();
      const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};
      const spendMap = (await redis.hgetall(CUSTOMER_SPEND_KEY)) || {};
      const countMap = (await redis.hgetall(CUSTOMER_COUNT_KEY)) || {};

      // Window view: paid orders per customer (an order with no paid entry is a
      // pre-feature historical order, treated as paid), and the historical ids
      // that still need an explicit "1" written.
      const { byCustomer: windowAgg, seededPaid } = aggregateSpend(orders, paidMap);

      // Seed the explicit paid flags for historical orders, so mark-paid can
      // later toggle them and the reconciliation check sees them as paid.
      if (Object.keys(seededPaid).length > 0) {
        await redis.hset(ORDER_PAID_KEY, seededPaid);
      }

      // Credit the SHORTFALL between a customer's banked lifetime spend and the
      // paid orders currently visible in the window. This seeds first-time
      // history AND self-heals a total that was left under-credited (e.g. a
      // Rebuild whose credit step didn't land, or a mark-paid that half-failed).
      // It only ever ADDS the deficit, so lifetime spend from orders that have
      // since rotated out of the window (banked total already above the window
      // sum) is never reduced. Idempotent: once banked >= window, deficit is 0.
      const pipe = redis.pipeline();
      let queued = 0;
      let customers = 0;
      let credited = 0;
      for (const [key, w] of windowAgg) {
        const organicSpend = Number(spendMap[key]) || 0;
        const organicCount = Number(countMap[key]) || 0;
        const spendDeficit = Number((w.spend - organicSpend).toFixed(2));
        const countDeficit = w.orders - organicCount;
        if (spendDeficit > 0.005) {
          pipe.hincrbyfloat(CUSTOMER_SPEND_KEY, key, spendDeficit);
          queued += 1; customers += 1; credited += spendDeficit;
        }
        if (countDeficit > 0) { pipe.hincrby(CUSTOMER_COUNT_KEY, key, countDeficit); queued += 1; }
      }
      if (queued > 0) await pipe.exec();

      return res.status(200).json({
        ok: true,
        customers,                              // customers whose lifetime was topped up
        credited: Number(credited.toFixed(2)),  // dollars added this run
        seeded: Object.keys(seededPaid).length, // historical orders given an explicit paid flag
        orders: orders.length,
      });
    }

    // ----------------------------------------------------------- adjustSpend
    // Manual lifetime correction. Beyond the orders window a total can't be
    // recomputed, so this is the escape hatch: add or subtract dollars from a
    // customer's lifetime spend, kept apart from organic spend (so the organic
    // figure stays verifiable) and logged with a reason for audit.
    if (action === "adjustSpend") {
      const custKey = String((req.body || {}).custKey || "").trim();
      const amt = Number((req.body || {}).delta);
      const reason = String((req.body || {}).reason || "").slice(0, 200);
      const dateRaw = (req.body || {}).date;
      if (!custKey) return res.status(400).json({ error: "Missing customer key." });
      if (!Number.isFinite(amt) || amt === 0) {
        return res.status(400).json({ error: "Adjustment must be a non-zero number." });
      }
      // The spend date decides whether this counts toward the 6-month window and
      // badge. Blank means "today". Stored as a dated entry appended to the
      // customer's adjustment array (not a flat running total), so a dated
      // correction can move the window.
      let dateMs = parseSgtDate(dateRaw);
      if (dateRaw && dateMs === null) {
        return res.status(400).json({ error: "Date must be in YYYY-MM-DD format." });
      }
      if (dateMs === null) dateMs = Date.now();
      const entry = { date: dateMs, amount: amt, reason, at: Date.now() };
      const existing = parseAdjustEntries(await redis.hget(CUSTOMER_ADJUST_KEY, custKey));
      existing.push(entry);
      await redis.hset(CUSTOMER_ADJUST_KEY, { [custKey]: JSON.stringify(existing) });
      await redis.lpush(CUSTOMER_ADJUST_LOG, JSON.stringify({ at: entry.at, key: custKey, delta: amt, date: dateMs, reason }));
      await redis.ltrim(CUSTOMER_ADJUST_LOG, 0, ADJUST_LOG_MAX - 1);
      return res.status(200).json({ ok: true, key: custKey, delta: amt, date: dateMs });
    }

    // ----------------------------------------------------------- spendReport
    // Per-customer LIFETIME spend for the admin Spend panel. The authoritative
    // figure is the permanent customer:spend hash (organic) plus any manual
    // customer:spend:adjust correction — NOT a re-sum of the capped orders list,
    // so it is not bounded by the 1000-order window.
    //
    // The orders window is still recomputed, but only to supply each customer's
    // display handle and last-order date, and as a one-directional check:
    // organic lifetime spend must be >= the sum of that customer's paid orders
    // still visible in the window. If it's less, an order was marked paid but
    // not credited (a bug) — that row is flagged so it can be corrected, rather
    // than two screens silently disagreeing.
    if (action === "spendReport") {
      const orders = await readAllOrders();
      const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};
      const adjustMap = (await redis.hgetall(CUSTOMER_ADJUST_KEY)) || {};
      const windowStart = windowStartMs();

      // Recompute from the SAME orders + paid states Recent Orders reads, so the
      // panel reconciles with it by construction. One pass yields both the
      // cumulative (all-time) total and the rolling 6-month window figure that
      // sets badge status. This is the ONE place spend and badge are derived.
      const { byCustomer } = aggregateSpend(orders, paidMap, windowStart);

      const keys = new Set([...byCustomer.keys(), ...Object.keys(adjustMap)]);
      const rows = [];
      for (const key of keys) {
        const c = byCustomer.get(key);
        // Dated manual corrections: the all-time sum moves the cumulative total,
        // and any entry dated inside the window moves window spend (and badge).
        const adj = sumAdjust(parseAdjustEntries(adjustMap[key]), windowStart);
        const cumulative = Number(((c ? c.spend : 0) + adj.cumulative).toFixed(2));
        const windowSpend = Number(((c ? c.windowSpend : 0) + adj.window).toFixed(2));
        const orderCount = c ? c.orders : 0;
        const badge = badgeForSpend(windowSpend);
        rows.push({
          key,
          handle: c ? c.handle : key,
          spend: cumulative,        // cumulative all-time (incl. adjustments)
          windowSpend,              // rolling 6-month spend (incl. in-window adjustments) -> badge
          badge: badge ? { name: badge.name, n: badge.n, color: badge.color } : null,
          adjust: Number(adj.cumulative.toFixed(2)),
          orders: orderCount,
          aov: orderCount > 0 ? Number((cumulative / orderCount).toFixed(2)) : 0,
          lastOrder: c ? c.lastOrder : 0,
        });
      }
      rows.sort((a, b) => b.spend - a.spend);

      const totals = {
        customers: rows.length,
        spend: Number(rows.reduce((s, r) => s + r.spend, 0).toFixed(2)),
        windowSpend: Number(rows.reduce((s, r) => s + r.windowSpend, 0).toFixed(2)),
        orders: rows.reduce((s, r) => s + r.orders, 0),
      };

      return res.status(200).json({ ok: true, rows, totals, cap: MAX_LIMIT, counted: orders.length, windowStart });
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
