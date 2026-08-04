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

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, error: "Method not allowed" });
  }

  try {
    const { code, subtotal } = req.body || {};
    if (!code || !code.trim()) {
      return res.status(200).json({ valid: false });
    }

    const codes = parseDiscountCodes(process.env.DISCOUNT_CODES);
    const match = codes.find(c => c.code === code.trim().toUpperCase());

    if (!match) {
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
