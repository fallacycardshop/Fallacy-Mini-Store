import { Redis } from "@upstash/redis";
import {
  VOUCHERS_KEY, voucherStatus,
  WELCOME_CONFIG_KEY, WELCOME_SEEN_KEY, parseWelcomeConfig,
} from "./_inventory.js";

const redis = Redis.fromEnv();

// Welcome-reward eligibility for the Mini App cart. Returns whether the perk is
// on and whether THIS Telegram id still qualifies (strictly first order — never
// placed one before). Fails CLOSED: on any doubt, not eligible, so a free card
// is never granted on an unverifiable check.
async function handleWelcome(req, res) {
  const id = String((req.body || {}).telegramUserId || "").trim();
  let cfg;
  try { cfg = parseWelcomeConfig(await redis.get(WELCOME_CONFIG_KEY)); }
  catch (e) { console.error("welcome config read failed:", e); return res.status(200).json({ enabled: false, eligible: false }); }
  if (!cfg.enabled || !/^\d+$/.test(id)) {
    return res.status(200).json({ enabled: cfg.enabled, eligible: false, minSpend: cfg.minSpend, maxOff: cfg.maxOff });
  }
  let seen;
  try { seen = await redis.sismember(WELCOME_SEEN_KEY, id); }
  catch (e) { console.error("welcome seen check failed:", e); return res.status(500).json({ enabled: true, eligible: false }); }
  return res.status(200).json({ enabled: true, eligible: !seen, minSpend: cfg.minSpend, maxOff: cfg.maxOff });
}

const MINIMUM_DISCOUNT_SPEND = 10;

// Promotions are advertised in Singapore time; expiry is interpreted in SGT.
const PROMO_TZ_OFFSET_MINUTES = 480; // UTC+8

// Codes live in the DISCOUNT_CODES environment variable (Vercel Settings →
// Environment Variables), NOT in the repo — this repo is public (needed for
// product photos to load), so anything in it can be read by anyone. Format:
//   CODE:type:value[:expiry];CODE2:type:value[:expiry]
//
// Expiry is OPTIONAL and, when present, is the last moment the code works,
// written as YYYY-MM-DD or YYYY-MM-DDTHH:MM in Singapore time. Omit it for a
// code that never expires.
//
//   MINILAUNCH10:percent:10:2026-08-15T23:59   expires 15 Aug 2026 23:59 SGT
//   WELCOME5:fixed:5                            no expiry
//
// Note the expiry uses "T" between date and time, because ":" is already the
// field separator — "2026-08-15 23:59" would split into extra fields.
function parseExpiry(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/
  );
  if (!match) {
    console.error("Ignoring unparseable discount expiry:", raw);
    return null;
  }

  const [, y, mo, d, h, mi] = match;
  // End of the given day when no time is supplied, so a date-only expiry
  // means "valid through that whole day".
  const hours = h === undefined ? 23 : Number(h);
  const minutes = mi === undefined ? 59 : Number(mi);

  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hours, minutes, 59, 999);
  return asUtc - PROMO_TZ_OFFSET_MINUTES * 60000;
}

function parseDiscountCodes(raw) {
  if (!raw) return [];
  return raw
    .split(";")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [code, type, value, ...expiryParts] = entry.split(":");
      return {
        code: (code || "").trim().toUpperCase(),
        type: (type || "").trim().toLowerCase(),
        value: Number(value || 0),
        // Rejoined because an expiry containing "T" splits no further, but a
        // stray colon shouldn't silently truncate it.
        expiresAt: parseExpiry(expiryParts.join(":")),
      };
    });
}

// A loyalty voucher (issued per earned badge, stored in the VOUCHERS_KEY hash)
// redeems here alongside the env-var promo codes. A voucher is a percent
// discount capped at a dollar amount, single-use, and dated — everything the
// env-var format can't express, which is why these live in Redis. The code is
// only VALIDATED here (status + minimum spend); it is BURNED at order placement
// in api/confirm-order.js, so the discount is applied at most once.
async function lookupVoucher(rawCode, subtotal) {
  const code = String(rawCode || "").trim().toUpperCase();
  let raw;
  try {
    raw = await redis.hget(VOUCHERS_KEY, code);
  } catch (e) {
    // Fail closed: a Redis read error must not silently reject a real voucher as
    // "unknown", but it also must not grant a discount it couldn't verify.
    console.error("voucher lookup failed:", e);
    return { error: true };
  }
  if (!raw) return null; // not a voucher

  let v;
  try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return null; }

  const status = voucherStatus(v);
  if (status === "used") return { valid: false, reason: "used" };
  if (status === "expired") return { valid: false, reason: "expired", expiredAt: Number(v.expiresAt) || null };

  if (Number(subtotal || 0) < MINIMUM_DISCOUNT_SPEND) {
    return { valid: false, reason: "minimum_not_met", minimumRequired: MINIMUM_DISCOUNT_SPEND };
  }

  return {
    valid: true,
    type: "percent",
    value: Number(v.pct) || 0,
    cap: Number(v.cap) || 0,      // max discount in dollars
    voucher: true,
    badgeName: v.badgeName || "",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, error: "Method not allowed" });
  }

  try {
    // Welcome-reward eligibility check shares this endpoint (no room for a 13th
    // function). Distinguished by action, not a code.
    if (req.body && req.body.action === "welcome") {
      return await handleWelcome(req, res);
    }

    const { code, subtotal } = req.body || {};
    if (!code || !code.trim()) {
      return res.status(200).json({ valid: false });
    }

    const codes = parseDiscountCodes(process.env.DISCOUNT_CODES);
    const match = codes.find(c => c.code === code.trim().toUpperCase());

    if (!match) {
      // Not an env-var promo code — try a loyalty voucher before giving up.
      const voucher = await lookupVoucher(code, subtotal);
      if (voucher && voucher.error) {
        return res.status(500).json({ valid: false, error: "Failed to validate code." });
      }
      if (voucher) return res.status(200).json(voucher);
      return res.status(200).json({ valid: false });
    }

    // Expired codes are refused outright, so a promotion stops working on its
    // own and can't be passed around after it ends.
    if (match.expiresAt !== null && Date.now() > match.expiresAt) {
      return res.status(200).json({
        valid: false,
        reason: "expired",
        expiredAt: match.expiresAt,
      });
    }

    if (Number(subtotal || 0) < MINIMUM_DISCOUNT_SPEND) {
      return res.status(200).json({
        valid: false,
        reason: "minimum_not_met",
        minimumRequired: MINIMUM_DISCOUNT_SPEND,
      });
    }

    res.status(200).json({
      valid: true,
      type: match.type, // "percent" or "fixed"
      value: match.value,
    });
  } catch (err) {
    console.error("validate-discount error:", err);
    res.status(500).json({ valid: false, error: "Failed to validate code." });
  }
}
