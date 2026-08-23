import { Redis } from "@upstash/redis";
import {
  ORDER_PAID_KEY,
  CUSTOMER_ADJUST_KEY,
  CUSTOMER_ADJUST_LOG,
  customerKey,
  orderHandle,
  orderAmount,
  aggregateSpend,
  badgeForSpend,
  nextBadge,
  windowStartMs,
  parseSgtDate,
  parseAdjustEntries,
  sumAdjust,
  spendLogKey,
  sumSpendLog,
  earnedBadges,
  voucherCode,
  voucherStatus,
  VOUCHERS_KEY,
  VOUCHER_DAYS,
  customerVouchersKey,
  issuedBadgesKey,
  CUSTOMER_ALIAS_KEY,
  resolveCustomerKey,
  badgeEmoji,
  badgeBannerUrl,
  badgeProgressBannerUrl,
  WELCOME_CONFIG_KEY,
  WELCOME_GRANTED_KEY,
  parseWelcomeConfig,
  BADGE_SNAPSHOT_KEY,
  scanKeys,
} from "./_inventory.js";

// Loyalty launch gate — vouchers only auto-issue once live, or for the owner's
// test ID(s) beforehand (same env vars the bot uses).
function loyaltyLive() {
  return ["1", "true", "yes", "on"].includes(String(process.env.LOYALTY_BOT_LIVE || "").toLowerCase());
}
function loyaltyTestIds() {
  return new Set(String(process.env.LOYALTY_TEST_IDS || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
}

// DM a customer through the bot. Only possible for a numeric Telegram id (the
// Mini App identity) — a browser "@handle" has no chat id to message. Swallows
// its own errors so a push can never break the caller (a voucher is still
// issued even if the notification fails).
// Short SGT date like "22 Oct" for a voucher's expiry line in a DM.
function fmtVoucherDate(ms) {
  const d = new Date((Number(ms) || 0) + 8 * 3600000);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mon}`;
}

async function notifyTelegram(chatId, text, photoUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id = String(chatId || "");
  if (!token || !/^\d+$/.test(id)) return;
  const api = m => `https://api.telegram.org/bot${token}/${m}`;
  const post = (m, body) => fetch(api(m), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    if (photoUrl && text.length <= 1024) {
      // The earn banner with the full congrats as its caption (fits the 1024 cap).
      await post("sendPhoto", { chat_id: id, photo: photoUrl, caption: text, parse_mode: "HTML" });
    } else if (photoUrl) {
      await post("sendPhoto", { chat_id: id, photo: photoUrl, caption: "🎉 New reward unlocked!", parse_mode: "HTML" });
      await post("sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true });
    } else {
      await post("sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true });
    }
  } catch (e) {
    console.error("telegram notify failed:", e);
  }
}

// A customer's AUTHORITATIVE LIFETIME spend — from the durable per-customer spend
// log (maintained incrementally by markPaid, never trimmed) plus dated
// adjustments. This is unbounded, so it is NOT limited by the capped orders list:
// a voucher can never be missed, and a badge can never drop, just because old
// orders have rotated out of that list. The bot reads the same log, so all
// screens agree. (ckey is already the canonical key; a merged customer's log is
// physically moved onto the primary at merge time.)
async function customerWindowSpend(redis, ckey, now = Date.now()) {
  const log = (await redis.hgetall(spendLogKey(ckey))) || {};
  const s = sumSpendLog(log, 0); // 0 = lifetime
  const adj = sumAdjust(parseAdjustEntries(await redis.hget(CUSTOMER_ADJUST_KEY, ckey)), 0);
  return s.cumulative + adj.cumulative;
}

// A customer's still-valid (active) vouchers, ONE per badge, ordered by badge
// tier — used for the "summary of your rewards" DM.
async function activeVouchersForKey(redis, ckey, now = Date.now()) {
  const codes = (await redis.smembers(customerVouchersKey(ckey))) || [];
  if (!codes.length) return [];
  const raws = await redis.hmget(VOUCHERS_KEY, ...codes);
  const arr = Array.isArray(raws) ? raws : codes.map(c => raws && raws[c]);
  const out = [];
  arr.forEach(raw => {
    if (!raw) return;
    let v; try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (v && voucherStatus(v, now) === "active") out.push(v);
  });
  out.sort((a, b) => (Number(a.badgeN) || 0) - (Number(b.badgeN) || 0));
  const seen = new Set();
  return out.filter(v => { const k = String(v.badgeN); if (seen.has(k)) return false; seen.add(k); return true; });
}

// One voucher line for a DM, ordered/rendered consistently everywhere.
function voucherLine(v) {
  return `${badgeEmoji(v.badgeN)} <b>${v.badgeName}</b> — ${v.pct}% off${v.cap ? ` (up to $${v.cap})` : ""}, expires ${fmtVoucherDate(v.expiresAt)}\nYour code: <code>${v.code}</code>`;
}

// Issue one voucher per newly-earned badge for a customer (leapfrog + once-ever).
// Walks the badges the customer's authoritative window spend has earned and
// issues any not already in their permanent issued-badge set. Returns the new
// vouchers. Fires from any spend change that can cross a tier — a payment
// (markPaid), a manual correction (adjustSpend), or a merge. Also DMs a summary
// when a customer climbs back into a tier they'd dropped out of (no new voucher,
// but their held rewards are worth re-surfacing).
async function issueVouchersFor(redis, ckey, handle, now = Date.now(), windowSpendOverride, opts = {}) {
  if (!ckey || !(loyaltyLive() || loyaltyTestIds().has(ckey))) return [];
  const windowSpend = windowSpendOverride !== undefined
    ? windowSpendOverride
    : await customerWindowSpend(redis, ckey, now);
  const earned = earnedBadges(windowSpend);           // voucher tiers only (Cascade+)
  const statusBadge = badgeForSpend(windowSpend);     // status tier, incl. the Boulder entry
  const curTier = statusBadge ? statusBadge.n : 0;

  // Mint any newly-earned VOUCHER badges. The Boulder entry tier grants none, and
  // earnedBadges already excludes it, so this never mints for Boulder.
  const out = [];
  if (earned.length) {
    const issued = new Set((await redis.smembers(issuedBadgesKey(ckey))) || []);
    // Belt-and-suspenders against duplicates: a badge the customer ALREADY HOLDS a
    // voucher for counts as issued too, so even a desynced set can't mint a dupe.
    const heldCodes = (await redis.smembers(customerVouchersKey(ckey))) || [];
    if (heldCodes.length) {
      const raws = await redis.hmget(VOUCHERS_KEY, ...heldCodes);
      const arr = Array.isArray(raws) ? raws : heldCodes.map(c => raws && raws[c]);
      arr.forEach(raw => {
        if (!raw) return;
        let v; try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
        if (v && v.badgeN !== undefined && v.badgeN !== null) issued.add(String(v.badgeN));
      });
    }
    for (const b of earned.filter(b => !issued.has(String(b.n)))) {
      let code = voucherCode(b.name);
      for (let t = 0; t < 5 && (await redis.hexists(VOUCHERS_KEY, code)); t++) code = voucherCode(b.name);
      const rec = {
        code, customer: ckey, handle: handle || ckey,
        badgeN: b.n, badgeName: b.name, pct: b.pct, cap: b.cap,
        issuedAt: now, expiresAt: now + VOUCHER_DAYS * 86400000,
        status: "active", usedAt: null, usedOrderId: null,
      };
      await redis.hset(VOUCHERS_KEY, { [code]: JSON.stringify(rec) });
      await redis.sadd(customerVouchersKey(ckey), code);
      await redis.sadd(issuedBadgesKey(ckey), String(b.n));
      out.push(rec);
    }
  }

  // Snapshot the current STATUS tier (incl. Boulder) so we can tell an upward
  // crossing from a drop or a same-tier payment. A drop never pings; a same-tier
  // payment never pings.
  let prevTier = null;
  try {
    const prevRaw = await redis.hget(BADGE_SNAPSHOT_KEY, ckey);
    prevTier = (prevRaw === null || prevRaw === undefined) ? null : (Number(prevRaw) || 0);
    await redis.hset(BADGE_SNAPSHOT_KEY, { [ckey]: String(curTier) });
  } catch (e) { console.error("badge snapshot failed:", e); }

  if (out.length) {
    // Newly-earned voucher badge(s) — congratulate with the new codes.
    const top = out[out.length - 1];
    await notifyTelegram(ckey,
      `Congrats! You've unlocked a new reward:\n\n${out.map(voucherLine).join("\n\n")}\n\nTap a code to copy it, then enter it in the cart's promo box at checkout.`,
      badgeBannerUrl(top.badgeN));
  } else if (opts.statusDM !== false && curTier > 0 && statusBadge) {
    // No new voucher this time. DM only on an UPWARD crossing. markPaid opts out
    // of this branch (statusDM:false) because it sends its own "Badge Progressed"
    // push on every payment instead.
    const firstSight = prevTier === null;
    const crossedUp = firstSight ? true : curTier > prevTier;
    if (crossedUp) {
      const held = await activeVouchersForKey(redis, ckey, now);
      if (held.length) {
        // Re-attained a tier they hold vouchers for — re-surface them. Skip on the
        // very first sighting so existing customers aren't spammed once at rollout.
        if (!firstSight) {
          await notifyTelegram(ckey,
            `Welcome back to ${badgeEmoji(statusBadge.n)} <b>${statusBadge.name} Badge</b>! Here's a summary of your rewards:\n\n${held.map(voucherLine).join("\n\n")}\n\nTap a code to copy it, then use it in the cart's promo box at checkout.`,
            badgeBannerUrl(curTier));
        }
      } else {
        // Entry tier (Boulder) — no voucher yet. Welcome them and point to the
        // first voucher tier.
        const next = nextBadge(windowSpend);
        let text = `🎉 You've earned the ${badgeEmoji(statusBadge.n)} <b>${statusBadge.name} Badge</b> — welcome to Badge Rewards!`;
        if (next && next.badge && Number(next.badge.pct) > 0) {
          text += `\n\nSpend $${Number(next.needed).toFixed(2)} more to reach ${badgeEmoji(next.badge.n || 9)} <b>${next.badge.name}</b> and unlock your first voucher: ${Number(next.badge.pct)}% off (up to $${Number(next.badge.cap)}).`;
        }
        await notifyTelegram(ckey, text, badgeBannerUrl(curTier));
      }
    }
  }
  return out;
}

// The "Badge Progressed" push: My Badges-style banner + a caption with the
// credited amount, the current badge, lifetime spend, and the gap to the next
// tier. Sent on every markPaid that doesn't cross a new voucher tier.
function progressMessage(amt, windowSpend) {
  const badge = badgeForSpend(windowSpend);
  if (!badge) return null;
  const next = nextBadge(windowSpend);
  const m = n => "$" + (Number(n) || 0).toFixed(2);
  let pct = 0;
  if (next && next.badge) {
    const span = Number(next.badge.spend) - Number(badge.spend);
    pct = span > 0 ? Math.max(0, Math.min(100, Math.round((windowSpend - Number(badge.spend)) / span * 100))) : 100;
  }
  let text = `✅ Your purchase of <b>${m(amt)}</b> has been credited — your badge has progressed!\n\n`;
  text += `Current badge: ${badgeEmoji(badge.n)} <b>${badge.name}</b>\nTotal spend: <b>${m(windowSpend)}</b>`;
  if (next && next.badge) {
    const nc = Number(next.badge.cap) || 0;
    text += `\n\n${m(next.needed)} more to reach ${badgeEmoji(next.badge.n || 9)} <b>${next.badge.name}</b> — ${Number(next.badge.pct) || 0}% off${nc ? `, up to $${nc}` : ""}.`;
  }
  return { text, photo: badgeProgressBannerUrl(badge.n, pct) };
}

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
      // Route through any identity merge so a payment for a merged secondary key
      // credits the canonical customer's log and vouchers.
      const aliasMap = (await redis.hgetall(CUSTOMER_ALIAS_KEY)) || {};
      const ckey = resolveCustomerKey(aliasMap, customerKey(record));
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

      // Maintain the customer's dated spend log — the bot's O(1) source (see
      // /mytier). Paying adds this order (with its date), un-paying removes it.
      // The admin panel recomputes authoritatively from the orders list, so a
      // log drift can never mislead the shop owner and a backfill re-syncs it.
      const when = Number(entry.savedAt) || Number(record.Order_ID) || Date.now();
      let vouchers = [];
      if (target) {
        await redis.hset(spendLogKey(ckey), { [id]: `${when}:${amt}` });
        // Paying may cross new badge thresholds — issue their vouchers (leapfrog,
        // once-ever). statusDM:false because when NO new voucher is earned we send
        // the "Badge Progressed" push below instead of the welcome/re-attain DM.
        // Wrapped so a voucher hiccup can't fail the payment toggle.
        try { vouchers = await issueVouchersFor(redis, ckey, orderHandle(record), undefined, undefined, { statusDM: false }); }
        catch (e) { console.error("voucher issuance failed:", e); }
        // Badge Progressed push — every paid order that didn't unlock a new
        // voucher tier (those get the "New Badge Unlocked" DM from issueVouchersFor).
        if (vouchers.length === 0 && (loyaltyLive() || loyaltyTestIds().has(ckey))) {
          try {
            const ws = await customerWindowSpend(redis, ckey);
            const pm = progressMessage(amt, ws);
            if (pm) await notifyTelegram(ckey, pm.text, pm.photo);
          } catch (e) { console.error("progress DM failed:", e); }
        }
      } else {
        // Un-paying drops window spend (badge status can fall) but never revokes
        // a voucher already issued — vouchers pay out once, ever.
        await redis.hdel(spendLogKey(ckey), id);
      }

      return res.status(200).json({ ok: true, orderId: id, paid: target, changed: true, vouchers });
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
      const aliasMap = (await redis.hgetall(CUSTOMER_ALIAS_KEY)) || {};

      // Rebuild each customer's dated spend log (the bot's O(1) source) from the
      // stored orders. Idempotent — it OVERWRITES each log, so running it twice
      // can't double anything. Orders with no paid-state entry are pre-feature
      // history: treated as paid and given an explicit "1" so they stay counted.
      const seededPaid = {};
      const logs = new Map(); // custKey -> { orderId: "when:amount" }
      for (const e of orders) {
        const record = e.record || e;
        if (!record || typeof record !== "object") continue;
        const id = String(record.Order_ID || "");
        let paid;
        if (id && Object.prototype.hasOwnProperty.call(paidMap, id)) paid = String(paidMap[id]) === "1";
        else { paid = true; if (id) seededPaid[id] = "1"; }
        if (!paid) continue;
        const ckey = resolveCustomerKey(aliasMap, customerKey(record));
        const when = Number(e.savedAt) || Number(record.Order_ID) || 0;
        const amt = orderAmount(record);
        if (!logs.has(ckey)) logs.set(ckey, {});
        logs.get(ckey)[id] = `${when}:${amt}`;
      }

      if (Object.keys(seededPaid).length > 0) await redis.hset(ORDER_PAID_KEY, seededPaid);

      // Overwrite each customer's log (DEL then HSET) in a single pipeline — one
      // network round trip, not a loop of awaited writes. Admin-only, run rarely.
      const pipe = redis.pipeline();
      let orderCount = 0;
      for (const [ckey, map] of logs) {
        pipe.del(spendLogKey(ckey));
        const n = Object.keys(map).length;
        if (n > 0) { pipe.hset(spendLogKey(ckey), map); orderCount += n; }
      }
      if (logs.size > 0) await pipe.exec();

      return res.status(200).json({
        ok: true,
        customers: logs.size,
        orders: orderCount,
        seeded: Object.keys(seededPaid).length,
      });
    }

    // ----------------------------------------------------------- adjustSpend
    // Manual lifetime correction. Beyond the orders window a total can't be
    // recomputed, so this is the escape hatch: add or subtract dollars from a
    // customer's lifetime spend, kept apart from organic spend (so the organic
    // figure stays verifiable) and logged with a reason for audit.
    if (action === "adjustSpend") {
      const rawKey = String((req.body || {}).custKey || "").trim();
      // If this key was merged into another, the correction belongs on the
      // canonical customer.
      const aliasMap = (await redis.hgetall(CUSTOMER_ALIAS_KEY)) || {};
      const custKey = resolveCustomerKey(aliasMap, rawKey);
      const amt = Number((req.body || {}).delta);
      const reason = String((req.body || {}).reason || "").slice(0, 200);
      const dateRaw = (req.body || {}).date;
      if (!custKey) return res.status(400).json({ error: "Missing customer key." });
      if (!Number.isFinite(amt) || amt === 0) {
        return res.status(400).json({ error: "Adjustment must be a non-zero number." });
      }
      // Badges are lifetime, so the date is recorded for the audit trail only —
      // the amount counts toward the badge regardless of date. Blank means "today".
      // Stored as a dated entry appended to the customer's adjustment array.
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

      // A positive correction can push a customer across one or more tiers — issue
      // the leapfrog vouchers (and DM them) just as a payment would. Wrapped so a
      // voucher hiccup can't fail the adjustment write.
      let vouchers = [];
      try { vouchers = await issueVouchersFor(redis, custKey, custKey); }
      catch (e) { console.error("voucher issuance on adjust failed:", e); }

      return res.status(200).json({ ok: true, key: custKey, delta: amt, date: dateMs, vouchers });
    }

    // ----------------------------------------------------------- spendReport
    // Per-customer LIFETIME spend for the admin Spend panel. Authoritative figure
    // is the durable per-customer spend log (maintained by markPaid, never
    // trimmed) plus dated adjustments — the SAME source issuance and the bot use,
    // so all three agree, and it is NOT bounded by the capped orders list. The
    // recent orders are read only to supply a display handle.
    if (action === "spendReport") {
      const orders = await readAllOrders();
      const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};
      const adjustMap = (await redis.hgetall(CUSTOMER_ADJUST_KEY)) || {};
      const aliasMap = (await redis.hgetall(CUSTOMER_ALIAS_KEY)) || {};

      // Display handles from the recent orders (best-effort; a customer whose
      // orders have all rotated out of the capped list simply shows their key).
      const { byCustomer: recent } = aggregateSpend(orders, paidMap, 0, aliasMap);

      // Authoritative lifetime spend from the durable spend logs.
      const prefixLen = spendLogKey("").length;
      const logKeys = await scanKeys(redis, spendLogKey("*"));
      const byCustomer = new Map(); // canonKey -> { spend, orders, lastOrder }
      for (const lk of logKeys) {
        const ckey = lk.slice(prefixLen);
        const s = sumSpendLog((await redis.hgetall(lk)) || {}, 0);
        byCustomer.set(ckey, { spend: s.cumulative, orders: s.orders, lastOrder: s.lastOrder });
      }

      // Adjustments folded by canonical key.
      const adjustByCanon = new Map(); // canonKey -> cumulative $
      for (const [k, raw] of Object.entries(adjustMap)) {
        const canon = resolveCustomerKey(aliasMap, k);
        const a = sumAdjust(parseAdjustEntries(raw), 0);
        adjustByCanon.set(canon, (adjustByCanon.get(canon) || 0) + a.cumulative);
      }

      const keys = new Set([...byCustomer.keys(), ...adjustByCanon.keys()]);
      const rows = [];
      for (const key of keys) {
        const c = byCustomer.get(key);
        const adjCum = adjustByCanon.get(key) || 0;
        const spend = Number(((c ? c.spend : 0) + adjCum).toFixed(2));
        const orderCount = c ? c.orders : 0;
        const badge = badgeForSpend(spend);
        const rec = recent.get(key);
        rows.push({
          key,
          handle: rec ? rec.handle : key,
          spend,                       // lifetime total (incl. adjustments)
          windowSpend: spend,          // lifetime == "window" now (kept for the client)
          badge: badge ? { name: badge.name, n: badge.n, color: badge.color } : null,
          adjust: Number(adjCum.toFixed(2)),
          orders: orderCount,
          aov: orderCount > 0 ? Number((spend / orderCount).toFixed(2)) : 0,
          lastOrder: c ? c.lastOrder : (rec ? rec.lastOrder : 0),
        });
      }
      rows.sort((a, b) => b.spend - a.spend);

      const total = Number(rows.reduce((s, r) => s + r.spend, 0).toFixed(2));
      const totals = {
        customers: rows.length,
        spend: total,
        windowSpend: total,
        orders: rows.reduce((s, r) => s + r.orders, 0),
      };

      return res.status(200).json({ ok: true, rows, totals, cap: MAX_LIMIT, counted: orders.length, lifetime: true });
    }

    // ---------------------------------------------------------- vouchersReport
    // Every voucher for the admin Vouchers panel, with live status computed.
    if (action === "vouchersReport") {
      const raw = (await redis.hgetall(VOUCHERS_KEY)) || {};
      const now = Date.now();
      const rows = Object.values(raw)
        .map(v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return null; } })
        .filter(Boolean)
        .map(v => ({ ...v, statusNow: voucherStatus(v, now) }))
        .sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
      const counts = { active: 0, used: 0, expired: 0 };
      rows.forEach(r => { counts[r.statusNow] = (counts[r.statusNow] || 0) + 1; });
      return res.status(200).json({ ok: true, rows, counts, total: rows.length });
    }

    // ---------------------------------------------------------- reissueVoucher
    // Goodwill re-issue: a fresh 60-day code for the same badge/customer. The old
    // code stays on record; the new one is added to the customer's voucher set.
    if (action === "reissueVoucher") {
      const code = String((req.body || {}).code || "").trim();
      if (!code) return res.status(400).json({ error: "Missing voucher code." });
      const raw = await redis.hget(VOUCHERS_KEY, code);
      if (!raw) return res.status(404).json({ error: "Voucher not found." });
      let old;
      try { old = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return res.status(500).json({ error: "Corrupt voucher record." }); }
      const now = Date.now();
      let newCode = voucherCode(old.badgeName);
      for (let t = 0; t < 5 && (await redis.hexists(VOUCHERS_KEY, newCode)); t++) newCode = voucherCode(old.badgeName);
      const rec = {
        ...old, code: newCode, issuedAt: now, expiresAt: now + VOUCHER_DAYS * 86400000,
        status: "active", usedAt: null, usedOrderId: null, reissuedFrom: code,
      };
      await redis.hset(VOUCHERS_KEY, { [newCode]: JSON.stringify(rec) });
      if (old.customer) await redis.sadd(customerVouchersKey(old.customer), newCode);
      return res.status(200).json({ ok: true, code: newCode, badge: old.badgeName });
    }

    // ------------------------------------------------------------- voidVoucher
    // Undo a mistaken issue: remove the voucher and free its badge so it can be
    // earned again. (Corrections only — normal expiry is automatic.)
    if (action === "voidVoucher") {
      const code = String((req.body || {}).code || "").trim();
      if (!code) return res.status(400).json({ error: "Missing voucher code." });
      const raw = await redis.hget(VOUCHERS_KEY, code);
      if (!raw) return res.status(404).json({ error: "Voucher not found." });
      let v = null;
      try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { v = null; }
      await redis.hdel(VOUCHERS_KEY, code);
      if (v && v.customer) {
        await redis.srem(customerVouchersKey(v.customer), code);
        if (v.badgeN !== undefined && v.badgeN !== null) await redis.srem(issuedBadgesKey(v.customer), String(v.badgeN));
      }
      return res.status(200).json({ ok: true, code });
    }

    // --------------------------------------------------------- mergeCustomers
    // Combine two customer identities (the numeric Telegram id from the Mini App
    // and the "@username" from a browser are the same person). The mutable data
    // is physically moved onto the primary, and an alias folds the immutable
    // order history and routes any future orders — see resolveCustomerKey.
    //
    // Direction matters: the bot keys badges off the numeric Telegram id, so the
    // caller should pass that as `into`. Idempotent — merging an already-merged
    // pair is a no-op.
    if (action === "mergeCustomers") {
      const fromRaw = String((req.body || {}).from || "").trim();
      const intoRaw = String((req.body || {}).into || "").trim();
      if (!fromRaw || !intoRaw) return res.status(400).json({ error: "Provide both a 'from' and an 'into' customer key." });

      const aliasMap = (await redis.hgetall(CUSTOMER_ALIAS_KEY)) || {};
      const into = resolveCustomerKey(aliasMap, intoRaw); // canonical primary (kept)
      const from = resolveCustomerKey(aliasMap, fromRaw); // canonical secondary (folded in)
      if (into === from) {
        return res.status(200).json({ ok: true, merged: false, canonical: into, note: "Already the same identity." });
      }

      // 1) Spend log — Order_IDs are globally unique, so fields never collide.
      const logFrom = (await redis.hgetall(spendLogKey(from))) || {};
      if (Object.keys(logFrom).length) await redis.hset(spendLogKey(into), logFrom);
      await redis.del(spendLogKey(from));

      // 2) Adjustments — concat the two dated arrays under the primary.
      const adjFrom = parseAdjustEntries(await redis.hget(CUSTOMER_ADJUST_KEY, from));
      if (adjFrom.length) {
        const adjInto = parseAdjustEntries(await redis.hget(CUSTOMER_ADJUST_KEY, into));
        await redis.hset(CUSTOMER_ADJUST_KEY, { [into]: JSON.stringify(adjInto.concat(adjFrom)) });
      }
      await redis.hdel(CUSTOMER_ADJUST_KEY, from);

      // 3) Issued-badge set — union, so a badge earned under either key stays
      //    "already issued" and can't pay out a second voucher.
      const badgesFrom = (await redis.smembers(issuedBadgesKey(from))) || [];
      if (badgesFrom.length) await redis.sadd(issuedBadgesKey(into), ...badgesFrom);
      await redis.del(issuedBadgesKey(from));

      // 4) Vouchers — move each code to the primary's set and re-point its record.
      const vouchersFrom = (await redis.smembers(customerVouchersKey(from))) || [];
      for (const code of vouchersFrom) {
        const raw = await redis.hget(VOUCHERS_KEY, code);
        if (raw) {
          let v = null;
          try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { v = null; }
          if (v) { v.customer = into; await redis.hset(VOUCHERS_KEY, { [code]: JSON.stringify(v) }); }
        }
        await redis.sadd(customerVouchersKey(into), code);
      }
      await redis.del(customerVouchersKey(from));

      // 5) Record the alias, and re-point anything that previously aliased TO
      //    `from` so the chain stays one hop deep.
      const repoint = { [from]: into };
      for (const [k, val] of Object.entries(aliasMap)) {
        if (String(val) === from) repoint[k] = into;
      }
      await redis.hset(CUSTOMER_ALIAS_KEY, repoint);

      // The combined window spend may now cross a badge neither identity reached
      // alone — issue those vouchers (leapfrog, once-ever, gated + wrapped).
      let vouchers = [];
      try { vouchers = await issueVouchersFor(redis, into, into); }
      catch (e) { console.error("merge voucher issuance failed:", e); }

      return res.status(200).json({ ok: true, merged: true, from, into, movedVouchers: vouchersFrom.length, vouchers });
    }

    // -------------------------------------------------------- backdateVouchers
    // One-time launch step: enrol every existing customer. Anyone with a purchase
    // is at least the Boulder entry tier; those past $80 get a voucher for EVERY
    // tier they've reached (Cascade up), each once. Reuses issueVouchersFor with
    // the authoritative window spend, so it mints all un-issued earned badges and
    // DMs the customer (Mini App / numeric ids) — an earn DM if they got vouchers,
    // or a Boulder welcome otherwise. Gated exactly like normal issuance (pre-
    // launch only test ids are messaged). Idempotent: already-issued badges are
    // skipped, and existing customers aren't re-notified. Run once at launch.
    if (action === "backdateVouchers") {
      const orders = await readAllOrders();
      const paidMap = (await redis.hgetall(ORDER_PAID_KEY)) || {};
      const adjustMap = (await redis.hgetall(CUSTOMER_ADJUST_KEY)) || {};
      const aliasMap = (await redis.hgetall(CUSTOMER_ALIAS_KEY)) || {};
      const windowStart = windowStartMs();
      const now = Date.now();

      // Same window figure the Spend panel shows, folded by identity merge.
      const { byCustomer } = aggregateSpend(orders, paidMap, windowStart, aliasMap);
      const adjustByCanon = new Map();
      for (const [k, raw] of Object.entries(adjustMap)) {
        const canon = resolveCustomerKey(aliasMap, k);
        const a = sumAdjust(parseAdjustEntries(raw), windowStart);
        const cur = adjustByCanon.get(canon) || { window: 0 };
        cur.window += a.window;
        adjustByCanon.set(canon, cur);
      }

      const keys = new Set([...byCustomer.keys(), ...adjustByCanon.keys()]);
      let customers = 0, issued = 0;
      const results = [];
      for (const key of keys) {
        const c = byCustomer.get(key);
        const adj = adjustByCanon.get(key) || { window: 0 };
        const windowSpend = (c ? c.windowSpend : 0) + adj.window;
        if (!badgeForSpend(windowSpend)) continue; // no purchase — not even Boulder
        customers += 1;

        let minted = [];
        try { minted = await issueVouchersFor(redis, key, (c && c.handle) || key, now, windowSpend); }
        catch (e) { console.error("backdate issuance failed for", key, e); }

        issued += minted.length;
        if (minted.length) results.push({ key, badges: minted.map(v => v.badgeName) });
      }

      return res.status(200).json({ ok: true, customers, issued, results });
    }

    // ------------------------------------------------------- welcome reward --
    // The one-time free-card perk, open to EVERY customer. Config + the count of
    // customers who have already claimed it (received the free card).
    if (action === "welcomeGet") {
      const cfg = parseWelcomeConfig(await redis.get(WELCOME_CONFIG_KEY));
      const granted = await redis.scard(WELCOME_GRANTED_KEY);
      return res.status(200).json({ ok: true, config: cfg, granted: Number(granted) || 0 });
    }
    if (action === "welcomeSave") {
      const cfg = parseWelcomeConfig(req.body); // reads enabled/minSpend/amount, ignores the rest
      await redis.set(WELCOME_CONFIG_KEY, JSON.stringify(cfg));
      return res.status(200).json({ ok: true, config: cfg });
    }

    // --------------------------------------------------------- dedupeVouchers
    // Cleanup for historical duplicates (one badge should only ever have one
    // voucher). Groups every voucher by customer + badge and, for any group with
    // more than one, keeps a single voucher — a USED one first (a real
    // redemption), otherwise the one that stays valid longest — and removes the
    // rest. Then makes sure each kept badge is in the customer's issued-badge set
    // so the once-ever lock covers it. Idempotent.
    if (action === "dedupeVouchers") {
      const raw = (await redis.hgetall(VOUCHERS_KEY)) || {};
      const groups = new Map(); // `${customer}|${badgeN}` -> [{code, v}]
      for (const [code, val] of Object.entries(raw)) {
        let v;
        try { v = typeof val === "string" ? JSON.parse(val) : val; } catch (e) { continue; }
        if (!v || !v.customer || v.badgeN === undefined || v.badgeN === null) continue;
        const gk = v.customer + "|" + v.badgeN;
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push({ code, v });
      }
      let removed = 0;
      const keptByCustomer = new Map(); // customer -> Set(badgeN)
      for (const [gk, list] of groups) {
        const customer = gk.slice(0, gk.indexOf("|"));
        list.sort((a, b) => {
          const au = (a.v.status === "used" || a.v.usedAt) ? 1 : 0;
          const bu = (b.v.status === "used" || b.v.usedAt) ? 1 : 0;
          if (au !== bu) return bu - au;                                  // used first
          const ax = Number(a.v.expiresAt) || 0, bx = Number(b.v.expiresAt) || 0;
          if (ax !== bx) return bx - ax;                                  // longest-valid next
          return (Number(a.v.issuedAt) || 0) - (Number(b.v.issuedAt) || 0); // earliest issued
        });
        const keep = list[0];
        if (!keptByCustomer.has(customer)) keptByCustomer.set(customer, new Set());
        keptByCustomer.get(customer).add(String(keep.v.badgeN));
        for (let i = 1; i < list.length; i++) {
          await redis.hdel(VOUCHERS_KEY, list[i].code);
          await redis.srem(customerVouchersKey(customer), list[i].code);
          removed += 1;
        }
      }
      // Ensure the once-ever lock covers every kept badge (never removes entries —
      // a backdated customer may hold lock entries with no voucher on purpose).
      for (const [customer, badges] of keptByCustomer) {
        if (badges.size) await redis.sadd(issuedBadgesKey(customer), ...badges);
      }
      return res.status(200).json({ ok: true, removed, customers: keptByCustomer.size });
    }

    // ----------------------------------------------------------- resetLoyalty
    // Wipe ONLY the loyalty voucher/badge artifacts, for a clean launch after
    // testing. Deletes: the vouchers hash, every per-customer voucher set and
    // issued-badge set, the badge snapshot, and the welcome-claim set. Does NOT
    // touch orders, paid state, sold counters, spend logs, spend adjustments, or
    // identity aliases — real sales/spend data is untouched, so Backfill + Backdate
    // can rebuild loyalty state fresh under the current ladder.
    if (action === "resetLoyalty") {
      const vsets = await scanKeys(redis, customerVouchersKey("*"));
      const bsets = await scanKeys(redis, issuedBadgesKey("*"));
      const keys = [VOUCHERS_KEY, BADGE_SNAPSHOT_KEY, WELCOME_GRANTED_KEY, ...vsets, ...bsets];
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        if (chunk.length) { await redis.del(...chunk); deleted += chunk.length; }
      }
      return res.status(200).json({ ok: true, deletedKeys: deleted, voucherSets: vsets.length, badgeSets: bsets.length });
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
